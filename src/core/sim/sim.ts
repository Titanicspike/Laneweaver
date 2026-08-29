/**
 * The simulation.
 *
 * Fixed 20 Hz timestep, seeded RNG, stable iteration order (lanes by id, vehicles
 * front to back within a lane). Same seed plus same network always produces the
 * same run; `test/sim/determinism.test.ts` holds us to it.
 *
 * Per-tick order, which the rest of the code assumes:
 *   signals -> spawn -> route and lateral indices -> merge planning -> lane changes
 *   -> accelerations -> integrate -> lane advance and despawn -> metrics
 */

import { clamp } from '../geom/vec2';
import { laneSToParent, mapS, parentToLaneS } from '../network/laneGraph';
import { samplePosition, sampleSmoothTangent } from '../geom/polyline';
import {
  LaneKind, type EditModel, type Frontage, type Lane, type Network, type SpawnMode,
} from '../network/types';
import { Mulberry32, jitter, mixSeed, expUnit } from '../util/rng';
import { idmAccel, type IdmParams } from './idm';
import {
  DT, DRIVER_SPREAD, Hold, IDM, MERGE, MOBIL, SIGNAL, SIM_LIMITS, VEHICLE_CLASSES,
} from './params';
import { Router, makeAdvice, type RouteAdvice } from './router';
import { SignalController } from './signals';
import { VehicleStore } from './state';
import { buildDemand, pickClass, primeTimers, type DemandPair } from './spawner';
import { flowAt, homeToWorkAt } from './clock';
import {
  applyCooperation, applyGapFollowing, applySoftWall, assignCooperation, checkChange,
  keepClearBias, lateralPlan, mergeTargetOf, noteThroughPassed, noteZipperAdmission, planMerge,
  referenceU, selectGap, updateZipper, zipperAllows,
} from './merge';
import { applyJunctionRules } from './junction';
import { evaluateMobil, makeMobilInput, makeMobilResult } from './mobil';

/**
 * Optional hooks for measurement. Called only on events (spawn, change, retire),
 * never per vehicle per tick, so instrumenting a run costs nothing measurable.
 */
export interface SimObserver {
  onSpawn?(sim: Simulation, i: number, laneId: number): void;
  onLaneChange?(sim: Simulation, i: number, from: number, to: number, forced: boolean): void;
  onRetire?(sim: Simulation, i: number, laneId: number, reason: 'arrived' | 'merge-failed' | 'lost'): void;
}

export interface SimMetrics {
  vehicles: number;
  spawned: number;
  arrived: number;
  queued: number;
  /** Vehicles that reached a lane end without merging. Should stay at zero. */
  mergeFailures: number;
  /** Vehicles removed at a dead end that was not their destination. */
  lost: number;
  /** Vehicles that had to be sent elsewhere because their destination fell out of reach. */
  missedExits: number;
  /** Times a vehicle had to stop at a lane boundary for lack of room. */
  boundaryHolds: number;
  collisions: number;
  meanSpeed: number;
  /** Vehicles stationary for longer than 60 s. */
  stalled: number;
  totalWait: number;
  totalTravel: number;
  laneChanges: number;
  forcedChanges: number;
  simTimeMs: number;
}

export interface SimOptions {
  seed?: number;
  maxVehicles?: number;
  demandScale?: number;
  /** Explicit origin-destination demand; defaults to a uniform matrix. */
  demand?: EditModel['demand'];
  /** Where traffic comes from and goes to. Defaults to `portals`. */
  spawnMode?: SpawnMode;
  /**
   * Simulated seconds in a day. Zero switches the clock off and generates flat
   * demand, which is what every scenario test wants: a measurement against a moving
   * target measures the target.
   */
  dayLength?: number;
  /** Hour the clock reads at t = 0. */
  startHour?: number;
}

const _advice: RouteAdvice = makeAdvice();
const _mobilIn = makeMobilInput();
const _mobilOut = makeMobilResult();
const _pA: IdmParams = { s0: IDM.s0, T: IDM.T, aMax: IDM.aMax, b: IDM.b };
const _pB: IdmParams = { s0: IDM.s0, T: IDM.T, aMax: IDM.aMax, b: IDM.b };
const _pC: IdmParams = { s0: IDM.s0, T: IDM.T, aMax: IDM.aMax, b: IDM.b };
const _gapOut = { dv: 0 };

/**
 * How far into a street a driver gets before any house counts as theirs.
 *
 * Not zero: everybody stopping at the first address past the corner puts every
 * arrival on the same two houses, which is the same picture the old fixed distance
 * gave and just as obviously wrong.
 */
const ARRIVE_MIN = 12;

/**
 * Most lanes the leader search will cross before giving up.
 *
 * Only a backstop against a cycle of very short lanes: the real bound is the 260 m
 * it is looking within, which is what a driver can see and what they need to stop.
 */
const LEADER_HOPS = 16;

/** How many lanes an entry-speed walk may look at, and how far ahead it may see. */
const ENTRY_NODES = 64;
const ENTRY_RANGE = 260;

/**
 * Whether traffic on `lane` can use this address.
 *
 * Every ordinary frontage is served by both directions: you park at your own house
 * whichever way you came down the street. A house on a turning head is not — its
 * driveway opens onto the circle, so a driver reaches it by going round, which puts
 * them on the lane leaving the head by the time they stop. That is what makes a
 * cul-de-sac's traffic turn round in it rather than stopping short of the bulb and
 * leaving the turning head as scenery.
 */
function servedBy(f: Frontage, lane: Lane): boolean {
  return !f.head || f.head.fromSide === lane.side;
}

/**
 * How much room a driver wants before starting to slow for a lower limit ahead, as a
 * multiple of the distance a comfortable deceleration actually needs. A little over
 * one, so the braking is comfortable rather than exactly at the limit of comfort.
 */
const SPEED_DROP_LOOKAHEAD = 1.5;

/** Longest a trip may sit undeparted before it is given up on, in seconds. */
const SPAWN_DEFER = 120;

/** Multiplier for packing two vehicle serials into one collision-pair key. */
const SERIAL_SPACE = 1 << 26;



export class Simulation {
  readonly net: Network;
  readonly store: VehicleStore;
  readonly router: Router;
  readonly signals: SignalController;
  readonly rng: Mulberry32;
  readonly seed: number;
  readonly dt = DT;

  time = 0;
  ticks = 0;

  /** Per-tick minimum-accumulated acceleration target. */
  private readonly accel: Float32Array;
  /** Longitudinal coordinate in the parent segment frame, cached per tick. */
  private readonly uCache: Float32Array;
  private readonly uValid: Uint8Array;
  /** Next edge each vehicle will take, cached per tick. */
  readonly nextEdge: Int32Array;
  /** Merge reference cross-section for each vehicle, in parent-segment space. */
  readonly mergeRefU: Float32Array;

  /** Per-lane count of mergers currently aiming at it. */
  readonly mergePressure: Float32Array;
  /** Lanes that end and need a merge, listed once at construction. */
  readonly endingLanes: Int32Array;
  readonly zipperCongested: Uint8Array;
  readonly zipperTurn: Uint8Array;
  /** For each ending lane, the merge cross-section expressed on its target lane. */
  readonly mergeRefOnTarget: Float32Array;
  /** For each target lane, the ending lane feeding it (or -1). */
  private readonly endingForTarget: Int32Array;
  /** Simulated seconds in a day; 0 means no clock and flat demand. */
  dayLength: number;
  /** Hour the clock reads at t = 0. */
  startHour: number;
  /** Vehicles already moved this tick, so a lane change is not processed twice. */
  private readonly moved: Uint8Array;
  /** Scratch list of entry lanes worth spawning into, reused every spawn. */
  private readonly spawnChoices = new Int32Array(16);
  /**
   * Destination id -> lane id -> is this lane part of that zone.
   *
   * A membership test per vehicle per tick has to be a lookup, not a search: the
   * town grid's residential zone has two hundred lanes in it and the arrival check
   * runs for every vehicle on every lane. Sparse on purpose — only zone ids have an
   * entry, so a portal destination costs one undefined lookup.
   */
  private readonly zoneLane: (Uint8Array | undefined)[] = [];
  /** Every conflict point once, for the cross-lane collision check. */
  private readonly conflictPairs: { a: number; sa: number; b: number; sb: number }[] = [];
  /** Vehicle pairs overlapping right now, and last tick, so only new ones count. */
  private overlapping = new Set<number>();
  private overlapNext = new Set<number>();

  private readonly demand: DemandPair[];
  readonly metrics: SimMetrics = {
    vehicles: 0, spawned: 0, arrived: 0, queued: 0, mergeFailures: 0, lost: 0,
    missedExits: 0, boundaryHolds: 0, collisions: 0, meanSpeed: 0, stalled: 0,
    totalWait: 0, totalTravel: 0, laneChanges: 0, forcedChanges: 0, simTimeMs: 0,
  };

  observer: SimObserver | null = null;

  /**
   * Per-pass timings in milliseconds, refreshed every tick. Eight clock reads a
   * tick is nothing next to the work being measured, and having the breakdown to
   * hand is what makes a performance regression obvious instead of mysterious.
   */
  readonly timings = {
    signals: 0, spawn: 0, routes: 0, lateral: 0, merge: 0,
    laneChange: 0, accel: 0, integrate: 0, advance: 0, metrics: 0,
  };
  /** Test hook: reports any lane change that lands a vehicle overlapping. */
  onBadChange: ((i: number, from: number, to: number, gapFront: number, gapBack: number) => void) | null = null;

  constructor(net: Network, options: SimOptions = {}) {
    this.net = net;
    this.seed = options.seed ?? 1337;
    this.rng = new Mulberry32(this.seed);
    this.router = new Router(net);
    this.signals = new SignalController(net);
    const capacity = options.maxVehicles ?? SIM_LIMITS.maxVehicles;
    this.store = new VehicleStore(capacity, net.lanes.length);

    this.moved = new Uint8Array(capacity);
    this.accel = new Float32Array(capacity);
    this.uCache = new Float32Array(capacity);
    this.uValid = new Uint8Array(capacity);
    this.nextEdge = new Int32Array(capacity).fill(-1);
    this.mergeRefU = new Float32Array(capacity).fill(NaN);

    this.mergePressure = new Float32Array(net.lanes.length);
    this.zipperCongested = new Uint8Array(net.lanes.length);
    this.zipperTurn = new Uint8Array(net.lanes.length);
    this.mergeRefOnTarget = new Float32Array(net.lanes.length).fill(NaN);
    this.endingForTarget = new Int32Array(net.lanes.length).fill(-1);

    const ending: number[] = [];
    for (const lane of net.lanes) {
      if (lane.kind !== LaneKind.Road) continue;
      if (lane.endsAt === Infinity || lane.mergeTarget < 0) continue;
      const target = net.lanes[lane.mergeTarget];
      if (target.segmentId !== lane.segmentId) continue;
      ending.push(lane.id);
      this.mergeRefOnTarget[lane.id] = mapS(lane, lane.endsAt, target);
      this.endingForTarget[target.id] = lane.id;
    }
    this.endingLanes = Int32Array.from(ending);

    // Listed once: connectors are stable for the life of a network, and the
    // collision check walks this every tick.
    for (const lane of net.lanes) {
      if (lane.kind !== LaneKind.Connector) continue;
      for (const conflict of lane.conflicts) {
        if (conflict.other <= lane.id) continue;
        this.conflictPairs.push({
          a: lane.id, sa: conflict.sSelf, b: conflict.other, sb: conflict.sOther,
        });
      }
    }

    // Zone membership as a lookup table, built once. The arrival test runs for
    // every vehicle on every tick and a zone can have hundreds of lanes.
    for (const zone of net.zones) {
      const member = new Uint8Array(net.lanes.length);
      for (const id of zone.lanes) member[id] = 1;
      this.zoneLane[zone.id] = member;
    }
    this.dayLength = Math.max(0, options.dayLength ?? 0);
    this.startHour = options.startHour ?? 0;
    this.demand = buildDemand(
      net,
      options.demand ?? [],
      options.demandScale ?? 1,
      (from, to) => this.originReaches(from, to),
      options.spawnMode ?? 'portals',
    );
    primeTimers(this.demand, this.rng);
  }

  /**
   * Can a trip from this origin actually get to this destination?
   *
   * An origin is a portal or a zone, and the difference is only which lanes it
   * starts on. Asking the question at all matters: an unreachable pair generates
   * traffic that can never arrive, which shows up as a steadily growing queue at an
   * entry nobody can leave from.
   */
  private originReaches(from: number, to: number): boolean {
    const portal = this.net.portals[from];
    const lanes = portal
      ? portal.entryLanes
      : (this.net.zones[from - this.net.portals.length]?.lanes ?? []);
    const cost = this.router.costTo(to);
    for (const lane of lanes) if (Number.isFinite(cost[lane])) return true;
    return false;
  }

  // --- helpers used by the subsystems ------------------------------------------

  paramsOf(i: number, out: IdmParams): IdmParams {
    out.s0 = IDM.s0;
    out.T = this.store.headway[i];
    out.aMax = this.store.aMax[i];
    out.b = this.store.bComf[i];
    return out;
  }

  desiredSpeedOf(i: number): number {
    const laneId = this.store.lane[i];
    const lane = this.net.lanes[laneId];
    let v0 = lane.speedLimit * this.store.v0Factor[i];
    // A driver on an acceleration lane is trying to reach mainline speed, not to
    // cruise. Without the boost, IDM's free term tapers so gently that matching
    // speed swallows most of the runway.
    if (this.store.mergeLane[i] === laneId && lane.endsAt < Infinity) v0 *= MERGE.speedBoost;
    return Math.max(1, v0);
  }

  /**
   * The constraint the next `constrain` call will be attributed to. Set by the
   * accel pass around each source; see `VehicleStore.hold`.
   */
  holdTag: Hold = Hold.Free;

  constrain(i: number, a: number): void {
    if (a < this.accel[i]) {
      this.accel[i] = a;
      this.store.hold[i] = this.holdTag;
    }
  }

  advise(laneId: number, dest: number): RouteAdvice {
    return this.router.advise(laneId, dest, _advice);
  }

  /**
   * The connector this driver will actually leave `laneId` by.
   *
   * Usually that is whatever the routing field advises. When the destination is not
   * reachable from here at all the field has nothing to say, and the driver still
   * has to leave the lane somehow — so pick the way the lane goes, deterministically
   * and **now**, rather than at the boundary. Deciding it at the boundary means the
   * leader look-ahead never looked down that connector, and a driver arrives at
   * full speed into whatever is queued on it with no room left to stop.
   */
  edgeFor(laneId: number, dest: number): number {
    const advised = this.advise(laneId, dest).successor;
    if (advised >= 0) return advised;
    let fallback = -1;
    for (const s of this.net.lanes[laneId].successors) if (fallback < 0 || s < fallback) fallback = s;
    return fallback;
  }

  /**
   * Mean speed of the traffic ahead of `start` within `horizon`, or `fallback` when
   * the road ahead is clear. Positions compare in the shared segment coordinate, so
   * this works across neighbouring lanes.
   */
  speedAhead(start: number, fromU: number, fallback: number, horizon: number): number {
    const store = this.store;
    let sum = 0;
    let n = 0;
    for (let j = start; j >= 0 && n < 8; j = store.ahead[j]) {
      if (this.uOf(j) - fromU > horizon) break;
      sum += store.v[j];
      n++;
    }
    return n ? sum / n : fallback;
  }

  /** Longitudinal coordinate along travel, in the parent segment's frame. */
  uOf(i: number): number {
    if (this.uValid[i]) return this.uCache[i];
    const lane = this.net.lanes[this.store.lane[i]];
    const u = laneSToParent(lane, this.store.s[i]) * lane.side;
    this.uCache[i] = u;
    this.uValid[i] = 1;
    return u;
  }

  // --- tick ---------------------------------------------------------------------

  tick(): void {
    const clock = typeof performance !== 'undefined' ? () => performance.now() : () => 0;
    const started = clock();
    this.time += this.dt;
    this.ticks++;
    let mark = started;
    const lap = (key: keyof Simulation['timings']): void => {
      const now = clock();
      this.timings[key] = now - mark;
      mark = now;
    };

    this.signals.update(this.dt, this.signalDemand);
    lap('signals');
    this.spawnPass();
    lap('spawn');
    this.uValid.fill(0);
    this.refreshNextEdges();
    lap('routes');
    this.refreshLateral();
    lap('lateral');
    updateZipper(this);
    this.mergePass();
    lap('merge');
    this.laneChangePass();
    lap('laneChange');
    this.accelPass();
    lap('accel');
    this.integratePass();
    lap('integrate');
    this.advancePass();
    lap('advance');
    this.metricsPass();
    lap('metrics');
    this.metrics.simTimeMs = clock() - started;
  }

  /** Runs `seconds` of simulated time. */
  run(seconds: number): void {
    const steps = Math.round(seconds / this.dt);
    for (let i = 0; i < steps; i++) this.tick();
  }

  // --- spawning -------------------------------------------------------------------

  private spawnPass(): void {
    let queued = 0;
    for (const pair of this.demand) {
      let guard = 0;
      const rate = this.rateOf(pair);
      // Spend this pair's Poisson quota at the rate that applies *now*, rather than
      // counting down an interval computed from whatever rate applied when the last
      // vehicle left. See `expUnit`: under a clock the two are not the same thing,
      // and the difference is most of a day's traffic.
      pair.timer -= rate * this.dt;
      // A trip that cannot start waits, but it does not wait forever.
      //
      // The backlog used to be a flat sixty per pair with no ageing, which on a
      // busy network meant demand generated at ten in the morning could still be
      // released at eight in the evening. The histogram of departures then had
      // nothing to do with the curve that produced it: on the arterial the busiest
      // hour of the day was 20:00, at half the peak flow, because that was when the
      // roads finally cleared enough to flush what had piled up. A clock whose
      // waves arrive whenever the traffic happens to allow is not a clock.
      //
      // So the queue is bounded by *time* rather than by count: at most a couple of
      // minutes of this pair's own current demand, and never more than half an hour
      // of the simulated day, so a backlog can never carry one period of the day
      // into the next. As the evening quietens the bound falls with the rate and
      // the surplus is discarded rather than dumped — which is what happens to a
      // trip nobody could start: it does not get made.
      const window = this.dayLength > 0
        ? Math.min(SPAWN_DEFER, this.dayLength / 48)
        : SPAWN_DEFER;
      const cap = Math.max(1, Math.ceil(rate * window));
      while (pair.timer <= 0 && guard++ < 64) {
        if (pair.queued < cap) pair.queued++;
        pair.timer += expUnit(this.rng);
      }
      if (pair.queued > cap) pair.queued = cap;
      if (pair.queued > 0 && this.trySpawn(pair)) pair.queued--;
      queued += pair.queued;
    }
    this.metrics.queued = queued;
  }

  /**
   * Where on this lane vehicle `i` is going to park.
   *
   * At a *building*, not at a fixed distance. It used to be `min(30 m, half the
   * lane)`, which put every arrival in the first thirty metres of whatever street
   * the driver turned into — so a town's traffic appeared to vanish at the mouth of
   * every road, and the houses further down were scenery nobody ever drove to.
   *
   * The frontages come from the compiler, so this is the same list of addresses the
   * renderer puts plots on: the car really does stop at a driveway. Which one is
   * seeded per driver *and per lane*, so two cars entering the same street go to
   * different houses and the same car re-entering does not pick the same one twice.
   *
   * Returns `Infinity` when there is nowhere on this lane to stop, which sends the
   * driver on to the next one rather than retiring them at the kerb.
   */
  private arriveAt(laneId: number, i: number): number {
    const lane = this.net.lanes[laneId];
    const seg = this.net.segments[lane.segmentId];
    const list = seg?.frontages;
    if (!list || !list.length) {
      // No addresses — a zoned road too short to hold a plot. Anywhere sensible.
      return Math.min(30, lane.length * 0.5);
    }
    // Which house, chosen uniformly among those far enough in — rather than "the
    // first one past a random distance", which loads the near end of every street
    // because the far addresses are only reachable by the few drivers who happened
    // to draw a long offset.
    const seed = mixSeed(this.store.seed[i], laneId);
    let usable = 0;
    for (const f of list) {
      if (!servedBy(f, lane)) continue;
      const at = parentToLaneS(lane, f.s);
      if (at >= ARRIVE_MIN && at <= lane.length - 1) usable++;
    }
    if (usable > 0) {
      let wanted = seed % usable;
      for (const f of list) {
        if (!servedBy(f, lane)) continue;
        const at = parentToLaneS(lane, f.s);
        if (at < ARRIVE_MIN || at > lane.length - 1) continue;
        if (wanted-- === 0) return at;
      }
    }
    // Nothing far enough in: take the last address on the lane rather than none, so
    // a short street still receives traffic.
    let last = -Infinity;
    for (const f of list) {
      const at = parentToLaneS(lane, f.s);
      if (at > last && at <= lane.length - 1) last = at;
    }
    return last > 0 ? last : Infinity;
  }

  /**
   * Is anybody still using this green?
   *
   * Yes if a vehicle is on one of the phase's connectors — it is *in* the junction
   * and cutting the green now would strand it — or if one is within
   * `SIGNAL.detector` metres of the stop line on a lane feeding one, and routed
   * onto it. The routing test is what makes this a detector rather than a
   * presence sensor: a car queued in the through lane says nothing about whether
   * the left-turn phase still has anybody to serve, and treating it as demand is
   * how an actuated junction ends up running every phase to its maximum.
   *
   * Bound rather than a method so it can be handed to the controller, which knows
   * about the network and deliberately nothing about vehicles.
   */
  private readonly signalDemand = (_junctionId: number, greenLanes: readonly number[]): boolean => {
    const store = this.store;
    for (const id of greenLanes) {
      if (store.laneFirst[id] >= 0) return true;
      for (const pred of this.net.lanes[id].predecessors) {
        const lane = this.net.lanes[pred];
        if (!lane) continue;
        // Front to back: the first vehicle close enough to the line settles it, and
        // anything behind it is further away still.
        for (let v = store.laneFirst[pred]; v >= 0; v = store.behind[v]) {
          if (lane.length - store.s[v] > SIGNAL.detector) break;
          if (this.nextEdge[v] === id) return true;
        }
      }
    }
    return false;
  };

  /**
   * What time it is, in hours. `-1` when the document has no clock.
   *
   * Derived from `time` rather than accumulated, so it cannot drift and so seeking
   * the clock is just a change of `startHour`.
   */
  /** Moves the clock without disturbing the traffic already on the road. */
  setClock(dayLength: number, startHour: number): void {
    this.dayLength = Math.max(0, dayLength);
    this.startHour = startHour;
  }

  get timeOfDay(): number {
    if (this.dayLength <= 0) return -1;
    return ((this.startHour + (this.time / this.dayLength) * 24) % 24 + 24) % 24;
  }

  /**
   * What this pair's rate is *right now*.
   *
   * Two multipliers: how busy the hour is, and — for the land-use mode — which way
   * round the commute is running. A pair whose direction is out of season is damped
   * rather than switched off, because somebody always goes the other way and because
   * a rate of exactly zero draws an infinite interval from the exponential and the
   * pair never wakes up again.
   */
  private rateOf(pair: DemandPair): number {
    const hour = this.timeOfDay;
    if (hour < 0) return pair.rate;
    let scale = flowAt(hour);
    if (pair.when !== 'any') {
      const out = homeToWorkAt(hour);
      scale *= 2 * (pair.when === 'out' ? out : 1 - out);
    }
    return pair.rate * Math.max(0.02, scale);
  }

  private trySpawn(pair: DemandPair): boolean {
    const portal = this.net.portals[pair.from];
    if (!portal) return this.trySpawnInZone(pair);
    const cost = this.router.costTo(pair.to);
    const klass = pickClass(this.rng);
    const spec = VEHICLE_CLASSES[klass];

    // Which lane to arrive in: any that leads where this driver is going and has
    // room, chosen between fairly.
    //
    // This used to be "whichever has the most room". Room is `Infinity` for an
    // empty lane and `Infinity > Infinity` is false, so every tie went to whichever
    // lane came first in the list — on a quiet three-lane freeway **82% of all
    // traffic entered in the kerb lane** and then spread out, which is a wave of
    // pointless lane changes at every portal and a road whose lanes look unused for
    // the first few hundred metres.
    //
    // Deliberately *not* route-aware. Letting drivers start in whichever lane the
    // router calls cheapest sounds better and measured worse: lane costs differ by
    // whole `LANE_CHANGE_COST` steps, so it stops being a bias and becomes a rule
    // that puts every exit-bound driver in one lane from the moment they appear and
    // leaves the rest to queue. Positioning for a turn is what the routing gradient
    // already does *en route*, where it can see the traffic.
    // Room enough to stand, which is all this decides. Whether the gap is big
    // enough to *travel* at the speed of the traffic is a question about speed, and
    // it is answered by lowering the speed rather than by refusing the trip — see
    // `entrySpeedCap`. Refusing was tried: a speed-aware requirement here turns a
    // busy lane away, which changes when every later vehicle arrives, and the
    // scenarios felt it as bunching (a 92 s wait at a four-way, a lost turn-on-red
    // throughput win, a collision through a peak). Demand that cannot be delivered
    // on time is a real cost; a driver joining slowly and accelerating is not.
    const need = spec.length + IDM.s0 + 4;
    let choices = 0;
    for (const laneId of portal.entryLanes) {
      if (!Number.isFinite(cost[laneId])) continue;
      const tail = this.store.laneLast[laneId];
      const room = tail >= 0 ? this.store.s[tail] - this.store.len[tail] : Infinity;
      if (room < need) continue;
      this.spawnChoices[choices++] = laneId;
      if (choices >= this.spawnChoices.length) break;
    }
    if (choices === 0) return false;
    const bestLane = this.spawnChoices[Math.min(choices - 1, Math.floor(this.rng.next() * choices))]!;

    return this.place(pair, bestLane, 0, klass, spec, this.store.laneLast[bestLane]);
  }

  /**
   * A trip that starts on a street rather than at the edge of the map.
   *
   * The land-use mode's whole point is that traffic appears *along* a residential
   * road, the way it does when everybody on it leaves for work — not funnelled in
   * through a handful of entry points. So a lane is drawn in proportion to its
   * length (long streets have more houses on them), and a position uniformly along
   * it.
   *
   * It has to fit in both directions, which a portal spawn never does: at a portal
   * there is by definition nothing behind you. Dropping a car into the middle of a
   * moving stream without checking what is behind is the same defect as a lane
   * change that ignores its lag, and it shows up the same way.
   */
  private trySpawnInZone(pair: DemandPair): boolean {
    const zone = this.net.zones[pair.from - this.net.portals.length];
    if (!zone || zone.frontage <= 0) return false;
    const cost = this.router.costTo(pair.to);
    const klass = pickClass(this.rng);
    const spec = VEHICLE_CLASSES[klass];
    const store = this.store;

    // Weighted by length, walked in lane-id order, so the same seed always draws
    // the same street — among the lanes that can actually get there. A street at
    // the edge of the map has one direction that leads only off it, and a driver
    // pulling out of a driveway takes the other one; drawing a lane first and
    // giving up when it cannot reach the shops threw away the trip instead. On a
    // real network 12% of residential frontage faced the wrong way, and every trip
    // that happened to draw it was lost.
    let usable = 0;
    for (const id of zone.lanes) {
      if (Number.isFinite(cost[id])) usable += this.net.lanes[id].length;
    }
    if (usable <= 0) return false;
    let target = this.rng.next() * usable;
    let laneId = -1;
    for (const id of zone.lanes) {
      if (!Number.isFinite(cost[id])) continue;
      target -= this.net.lanes[id].length;
      laneId = id;
      if (target <= 0) break;
    }
    if (laneId < 0) return false;

    const lane = this.net.lanes[laneId];
    // Clear of both ends: a car materialising in a junction mouth is the same
    // problem as one materialising on top of another.
    const margin = spec.length + IDM.s0 + 6;
    if (lane.length < margin * 2.5) return false;
    // Pull out of a driveway, not out of the tarmac. The frontages are the compiler's
    // and the renderer draws a plot on every one of them, so the car appears where a
    // house is rather than at a uniformly random point that happens to be beside one.
    const at = this.addressOn(lane, margin, this.rng.next());
    if (at < 0) return false;

    const ahead = store.findAhead(laneId, at, -1);
    const behind = ahead >= 0 ? store.behind[ahead] : store.laneFirst[laneId];
    // Speed-aware for the same reason as the portal path above, in both directions:
    // pulling out ten metres in front of somebody doing 13 m/s makes *them* brake
    // at the cap, which is the same defect seen from the other car.
    const roomAhead = spec.length + IDM.s0
      + (ahead >= 0 ? Math.max(2, store.v[ahead] * IDM.T) : 4);
    const roomBehind = spec.length + IDM.s0
      + (behind >= 0 ? Math.max(2, store.v[behind] * IDM.T) : 4);
    if (ahead >= 0 && store.s[ahead] - store.len[ahead] - at < roomAhead) return false;
    if (behind >= 0 && at - spec.length - store.s[behind] < roomBehind) return false;

    return this.place(pair, laneId, at, klass, spec, ahead);
  }

  /**
   * A position on `lane` where a building fronts it, at least `margin` from each end.
   *
   * Falls back to a plain uniform position when the road carries no frontages — a
   * zoned street too short to hold a plot still generates trips, it just has nowhere
   *particular for them to come from.
   */
  private addressOn(lane: Lane, margin: number, pick: number): number {
    const seg = this.net.segments[lane.segmentId];
    const list = seg?.frontages;
    if (list && list.length) {
      // Collect the usable ones, then take the one `pick` selects. Walking the list
      // twice costs nothing next to a spawn and keeps the choice uniform over
      // addresses rather than over arc-length.
      let usable = 0;
      for (const f of list) {
        if (!servedBy(f, lane)) continue;
        const at = parentToLaneS(lane, f.s);
        if (at >= margin && at <= lane.length - margin) usable++;
      }
      if (usable > 0) {
        let wanted = Math.min(usable - 1, Math.floor(pick * usable));
        for (const f of list) {
          if (!servedBy(f, lane)) continue;
          const at = parentToLaneS(lane, f.s);
          if (at < margin || at > lane.length - margin) continue;
          if (wanted-- === 0) return at;
        }
      }
    }
    if (lane.length < margin * 2.5) return -1;
    return margin + pick * (lane.length - margin * 2);
  }

  /** Creates one vehicle on `laneId` at `s`, behind `ahead`. */
  /**
   * The first vehicle downstream of a point, across lane boundaries.
   *
   * Used when placing a new one: `findAhead` only sees the lane it is asked about,
   * and in a city that lane is often a few metres of road with the whole queue on
   * the far side of the junction.
   */
  /**
   * The fastest a driver may be *put* on the road here.
   *
   * Two things downstream can make a speed impossible rather than merely
   * uncomfortable, and both are invisible from the spawn lane alone: something
   * queued past the end of it, and road that is simply slower. A driver who has
   * been travelling arrives at either with the whole approach behind them to slow
   * down in. One who is created here does not, and no following model can undo a
   * car that was placed somewhere it could never have reached at that speed.
   *
   * Every way out, not the first one. Which way this driver goes is not decided
   * until the routing pass, and a five-metre entry lane onto a five-arm junction
   * offers a 60 km/h movement beside a 13 km/h one — so following one successor
   * spawns drivers at the limit in front of the turn they are about to take. The
   * walk is breadth-first and budgeted; a queue found on a branch ends it, because
   * nothing past a stationary car constrains the speed you may arrive at.
   *
   * Comfortable braking on purpose: needing the emergency cap to survive your own
   * spawn is the definition of being put somewhere you should not have been. And
   * *this driver's* comfortable braking, not the global one — a truck stops at
   * 1.5 m/s² where a car manages 2.0, so a cap worked out for the car puts the
   * truck somewhere it can only leave by braking hard.
   */
  private entrySpeedCap(laneId: number, at: number, desired: number, b: number): number {
    const store = this.store;
    const lanes = this.net.lanes;
    const queue = this.entryQueue;
    const dists = this.entryDist;
    let cap = desired;
    let head = 0;
    let tail = 0;
    queue[tail] = laneId;
    dists[tail] = lanes[laneId].length - at;
    tail++;
    while (head < tail) {
      const lane = queue[head];
      const dist = dists[head];
      head++;
      if (dist > ENTRY_RANGE) continue;
      const succ = lanes[lane].successors;
      for (let k = 0; k < succ.length; k++) {
        const next = succ[k];
        const l = lanes[next];
        const room = Math.max(0, dist);
        cap = Math.min(cap, Math.sqrt(l.speedLimit * l.speedLimit + 2 * b * room));
        const last = store.laneLast[next];
        if (last >= 0) {
          const behind = Math.max(0, dist + store.s[last] - store.len[last] - IDM.s0);
          cap = Math.min(cap, Math.sqrt(store.v[last] * store.v[last] + 2 * b * behind));
          continue;
        }
        if (tail < ENTRY_NODES) {
          queue[tail] = next;
          dists[tail] = dist + l.length;
          tail++;
        }
      }
    }
    return cap;
  }

  private place(
    pair: DemandPair, laneId: number, at: number, klass: number,
    spec: (typeof VEHICLE_CLASSES)[number], ahead: number,
  ): boolean {
    const i = this.store.allocate();
    if (i < 0) return false;
    const store = this.store;
    const lane = this.net.lanes[laneId];

    store.klass[i] = klass;
    store.len[i] = spec.length;
    store.width[i] = spec.width;
    store.seed[i] = mixSeed(this.seed, store.serial[i]);
    store.v0Factor[i] = spec.speedFactor * jitter(this.rng, DRIVER_SPREAD.desiredSpeed);
    store.headway[i] = IDM.T * jitter(this.rng, DRIVER_SPREAD.headway);
    store.aMax[i] = spec.aMax * jitter(this.rng, DRIVER_SPREAD.acceleration);
    store.bComf[i] = spec.b;
    store.politeness[i] = Math.max(0, MOBIL.politeness * jitter(this.rng, DRIVER_SPREAD.politeness));
    store.courtesy[i] = this.rng.next();
    store.critGap[i] = DRIVER_SPREAD.criticalGap * jitter(this.rng, DRIVER_SPREAD.criticalGapSpread);
    store.dest[i] = pair.to;
    store.origin[i] = pair.from;

    const desired = lane.speedLimit * store.v0Factor[i];
    // Matching the car in front matters more than starting at the limit: arriving
    // at speed behind a stationary queue is a collision the first tick has to undo.
    //
    // And what has to be matched is not always on this lane, nor is it always a
    // car — see `entrySpeedCap`. On an imported freeway interchange those two
    // between them were almost every rear-end collision.
    let cap = this.entrySpeedCap(laneId, at, desired, store.bComf[i]);
    if (ahead >= 0) {
      // Matching the leader's speed is not enough on its own: what IDM asks for is
      // a *headway*, and ten metres behind traffic doing 18 m/s is four seconds
      // short of it however well the speeds agree. The driver is then at the
      // emergency cap on their first tick and sends a shockwave up a road they
      // have only just joined. Enter at the speed the gap supports and accelerate
      // out of it, which is what a slip road does.
      const gap = store.s[ahead] - store.len[ahead] - at;
      cap = Math.min(cap, store.v[ahead], Math.max(0, (gap - IDM.s0) / store.headway[i]));
    }
    store.v[i] = Math.max(0, cap);
    // Stagger the first evaluation so the whole fleet does not think at once.
    store.lcTimer[i] = (store.serial[i] % 9) * this.dt;
    store.a[i] = 0;
    store.insertIntoLane(i, laneId, at, ahead);
    store.sPrev[i] = at;
    store.lanePrev[i] = laneId;
    this.uValid[i] = 0;
    this.metrics.spawned++;
    this.observer?.onSpawn?.(this, i, laneId);
    return true;
  }

  /**
   * Sends a vehicle somewhere it can still get to. This happens when a driver
   * misses an exit: rather than stopping in a live lane or vanishing, it takes the
   * next reachable destination, the way a real driver would carry on to the next
   * junction.
   *
   * The destination it just failed to reach is excluded, and that is the whole
   * trick. Route costs are per *lane*, and a diverge deliberately does not split
   * the road it leaves — the mainline is one continuous lane through the gore — so
   * from the router's point of view the ramp is reachable from that lane whether
   * you are a kilometre short of it or a kilometre past it. Asking for the cheapest
   * exit therefore hands back the one just missed, the driver keeps aiming at
   * something behind them, and nobody ever reroutes. This function is only ever
   * called because the current destination has stopped being achievable, so ruling
   * it out is exactly right.
   */
  private retarget(i: number, laneId: number): void {
    let best = -1;
    let bestCost = Infinity;
    for (const portal of this.net.portals) {
      if (!portal.exitLanes.length || portal.id === this.store.dest[i]) continue;
      const c = this.router.costTo(portal.id)[laneId];
      if (c < bestCost) {
        bestCost = c;
        best = portal.id;
      }
    }
    if (best >= 0 && best !== this.store.dest[i]) {
      this.store.dest[i] = best;
      this.metrics.missedExits++;
      // The cached next edge was chosen for the old destination; refresh it now or
      // the vehicle drives off the end of its lane before the next tick fixes it.
      this.nextEdge[i] = this.edgeFor(laneId, best);
    }
  }

  // --- per-tick indices -------------------------------------------------------

  private refreshNextEdges(): void {
    const store = this.store;
    for (let laneId = 0; laneId < this.net.lanes.length; laneId++) {
      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) {
        if (!Number.isFinite(this.router.costTo(store.dest[i])[laneId])) this.retarget(i, laneId);
        this.nextEdge[i] = this.edgeFor(laneId, store.dest[i]);
      }
    }
  }

  /**
   * Fills each vehicle's lead and lag in the lanes either side of it.
   *
   * Both lane lists are already sorted by descending position, so one merged walk
   * per adjacent pair answers it for every vehicle at once — linear, no searching.
   */
  private refreshLateral(): void {
    const store = this.store;
    const lanes = this.net.lanes;
    for (let laneId = 0; laneId < lanes.length; laneId++) {
      if (store.laneCount[laneId] === 0) continue;
      const lane = lanes[laneId];
      this.walkNeighbour(laneId, lane.left, store.leftLead, store.leftLag);
      this.walkNeighbour(laneId, lane.right, store.rightLead, store.rightLag);
    }
  }

  private walkNeighbour(laneId: number, other: number, lead: Int32Array, lag: Int32Array): void {
    const store = this.store;
    if (other < 0) {
      for (let m = store.laneFirst[laneId]; m >= 0; m = store.behind[m]) {
        lead[m] = -1;
        lag[m] = -1;
      }
      return;
    }
    let n = store.laneFirst[other];
    let ahead = -1;
    for (let m = store.laneFirst[laneId]; m >= 0; m = store.behind[m]) {
      const u = this.uOf(m);
      while (n >= 0 && this.uOf(n) > u) {
        ahead = n;
        n = store.behind[n];
      }
      lead[m] = ahead;
      lag[m] = n;
    }
  }

  // --- merge planning ---------------------------------------------------------

  private mergePass(): void {
    const store = this.store;
    this.releaseStaleCooperation();
    this.mergePressure.fill(0);

    for (let laneId = 0; laneId < this.net.lanes.length; laneId++) {
      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) {
        planMerge(this, i);
        const mergeLane = store.mergeLane[i];
        if (mergeLane < 0) {
          this.mergeRefU[i] = NaN;
          continue;
        }
        const target = mergeTargetOf(this, i);
        const ending = this.net.lanes[mergeLane];
        if (target < 0 || ending.segmentId < 0 || ending.segmentId !== this.net.lanes[target].segmentId) {
          this.mergeRefU[i] = NaN;
          store.gapLead[i] = -1;
          store.gapLag[i] = -1;
          continue;
        }
        const refU = referenceU(this, mergeLane, store.mergeDeadline[i]);
        this.mergeRefU[i] = refU;

        store.gapTimer[i] -= this.dt;
        const lead = store.gapLead[i];
        const lag = store.gapLag[i];
        const stale =
          (lead >= 0 && (!store.alive[lead] || store.lane[lead] !== target)) ||
          (lag >= 0 && (!store.alive[lag] || store.lane[lag] !== target));
        if (store.gapTimer[i] <= 0 || stale) selectGap(this, i, target, refU);
        // Properly past the deadline on a lane that does not physically end: the
        // exit was missed, so send this driver somewhere it can still reach.
        if (store.mergePast[i] > MERGE.missedBy && ending.endsAt === Infinity) {
          this.retarget(i, laneId);
          planMerge(this, i);
        }
        assignCooperation(this, i);
        if (store.mergeRemaining[i] < MERGE.keepClearRange) this.mergePressure[target] += 1;
      }
    }
  }

  /**
   * Cooperation is sticky. A driver who has agreed to let a merger in keeps that
   * commitment until the merger is in, gone, or already past them — re-deciding it
   * from scratch every tick means the gap never actually opens, because a different
   * driver inherits the job each time the queue shuffles forward.
   */
  private releaseStaleCooperation(): void {
    const store = this.store;
    for (let laneId = 0; laneId < this.net.lanes.length; laneId++) {
      for (let j = store.laneFirst[laneId]; j >= 0; j = store.behind[j]) {
        const m = store.cooperateWith[j];
        if (m < 0) continue;
        if (!store.alive[m] || store.mergeLane[m] < 0) {
          store.cooperateWith[j] = -1;
          continue;
        }
        const refU = this.mergeRefU[m];
        if (!Number.isFinite(refU)) {
          store.cooperateWith[j] = -1;
          continue;
        }
        // The merger is behind us now: nothing left to hold open.
        if (refU - this.uOf(j) - store.mergeRemaining[m] - store.len[m] <= 0) {
          store.cooperateWith[j] = -1;
        }
      }
    }
  }

  // --- lane changes -----------------------------------------------------------

  private laneChangePass(): void {
    const store = this.store;
    const lanes = this.net.lanes;
    this.moved.fill(0);

    for (let laneId = 0; laneId < lanes.length; laneId++) {
      let i = store.laneFirst[laneId];
      while (i >= 0) {
        const next = store.behind[i];
        if (!this.moved[i]) this.considerChange(i, laneId);
        i = next;
      }
    }
  }

  private considerChange(i: number, laneId: number): void {
    const store = this.store;
    const lanes = this.net.lanes;
    const lane = lanes[laneId];

    if (store.lcCooldown[i] > 0) store.lcCooldown[i] -= this.dt;
    if (store.lcFrom[i] >= 0) {
      store.lcProgress[i] += this.dt / MOBIL.lateralTime;
      if (store.lcProgress[i] >= 1) store.lcFrom[i] = -1;
    }
    if (lane.kind === LaneKind.Connector) return;

    // Mandatory: the route (or a lane that ends) says we must be somewhere else.
    // A driver in this position is not also shopping for a nicer lane, so this
    // branch always returns - otherwise the discretionary path below would happily
    // wave through a merge the mandatory rules just refused.
    if (store.mergeLane[i] === laneId) {
      const target = mergeTargetOf(this, i);
      // A deadline a kilometre away is a plan, not an emergency, and running it as
      // one is what made half of all lane changes on a multi-segment network a pair
      // that undid itself inside a single second. The mandatory path ignores the
      // cooldown and takes the first safe gap, by design — it has to, for a lane
      // that runs out of tarmac. Applied to a driver who is merely in the wrong
      // lane for a junction 1.4 km ahead, it throws them back the tick after they
      // drifted out, and the moment the cooldown expires they drift out again.
      //
      // `urgency` is already exactly the "am I pressed" signal, and it is zero
      // until the deadline is inside `MERGE.urgencyRange`. Below that the change
      // goes through the ordinary discretionary path instead, where the route bias
      // already wants it and the hysteresis stops it thrashing. A lane that
      // physically ends stays mandatory whatever the distance, because there the
      // alternative is running out of road.
      const pressed = store.urgency[i] > 0 || lane.endsAt < Infinity ||
        this.net.lanes[Math.max(0, target)].endsAt < Infinity;
      if (target >= 0 && pressed) {
        // The zipper may make a driver wait its turn, but it may never be the
        // reason someone is stuck: high urgency or a long wait lifts the gate.
        const gated = lane.endsAt < Infinity && !zipperAllows(this, laneId) &&
          store.urgency[i] < 0.95 &&
          Math.max(store.stoppedTime[i], store.crawlTime[i]) < MERGE.stuckTimeout;
        if (!gated) {
          const check = checkChange(this, i, target, true);
          if (check.allowed) {
            this.performChange(i, laneId, target, check.aheadId, check.targetS, check.forced);
            return;
          }
        }
        // Asked for the change, crawling, and did not get it — which together are
        // what "everybody is trying to feed into one lane and none of it is moving"
        // looks like from inside a car. Neither half is enough on its own: a driver
        // half a kilometre out is waiting for a decent gap rather than being
        // refused one, and a driver moving freely who has not changed yet is simply
        // being choosy. Requiring both means the clock never runs in free flow, so
        // impatience cannot cost anybody an exit they would have made.
        if (store.v[i] < MERGE.crawlSpeed) store.mergeWait[i] += this.dt;
        else store.mergeWait[i] = 0;
        // Long enough, and on a lane that does not physically end, the driver stops
        // trying. Carrying on and coming back is a real option and holding up the
        // road behind them for half a minute is not — which is what everybody in a
        // queue trying to feed into one lane actually does.
        if (lane.endsAt === Infinity && store.mergeWait[i] >= MERGE.giveUpOnRoute) {
          this.retarget(i, laneId);
          planMerge(this, i);
          store.mergeWait[i] = 0;
        }
        return;
      }
    }

    if (store.lcCooldown[i] > 0) return;
    // Discretionary changes are reconsidered a few times a second, not every tick.
    store.lcTimer[i] -= this.dt;
    if (store.lcTimer[i] > 0) return;
    store.lcTimer[i] = MOBIL.evaluate;

    const dest = store.dest[i];
    const advice = this.advise(laneId, dest);
    const routeLateral = advice.lateral;
    const routeBenefit = advice.benefit;
    const cost = this.router.costTo(dest);

    let bestDir = 0;
    let bestIncentive = 0;
    let bestAhead = -1;
    let bestS = 0;

    for (const dir of [1, -1] as const) {
      const target = dir > 0 ? lane.left : lane.right;
      if (target < 0) continue;
      const targetLane = lanes[target];
      if (!Number.isFinite(cost[target])) continue;
      // Never drift into a lane that ends, or into an exit-only lane we would
      // then have to fight our way back out of, unless the route wants it.
      if (routeLateral !== dir) {
        if (targetLane.endsAt < Infinity) continue;
        if (!this.router.canContinue(target, dest)) continue;
      }

      const check = checkChange(this, i, target, false);
      if (!check.allowed) continue;

      let bias = 0;
      if (routeLateral === dir) bias += Math.min(routeBenefit * 0.25, 1.5);
      else if (routeLateral === -dir) bias -= 1.2;

      // ...and moving *off* the route is not free merely because the router had
      // nothing to say about the lane we are on. `routeLateral` is 0 for a lane
      // that is already on the route, so neither branch above fires and a drift
      // into a lane the route does not want used to cost nothing at all. The
      // mandatory rules then pulled the driver back on the very next tick, because
      // those are checked every tick and do not wait out the cooldown.
      //
      // The target lane's own lateral plan says both how much it owes and how soon.
      // Past the point where that becomes urgent the answer is not a price at all:
      // urgency is exactly what makes a change mandatory rather than advisable, so
      // a lane already inside its urgency range is one the next tick will order the
      // driver out of, and going there voluntarily is choosing to be thrown back.
      // On a 166 m town block, where the deadline is the end of the block, that was
      // most of the lane changes in the network. Below that it is a real choice —
      // drifting left with a kilometre in hand is how a driver overtakes — so it
      // costs rather than being refused.
      //
      // The cost table answers it for free most of the time: the mandatory branch
      // above has already established that *this* lane owes nothing, so a target
      // that is no dearer cannot owe anything either — its own cost would have to
      // be both at most ours and strictly more than ours. That short-circuit is
      // what keeps this off the tick budget on a freeway, where every lane reaches
      // the destination and the costs are equal.
      if (cost[target] > cost[laneId] + 1e-6) {
        const plan = lateralPlan(this, target, dest);
        const owed = plan.changes;
        if (owed > 0) {
          const room = plan.deadline - check.targetS;
          if (room < MERGE.urgencyRange * Math.min(owed, 3)) continue;
          bias -= (MOBIL.offRoutePenalty * owed) / (1 + Math.max(0, room) / MOBIL.offRouteRelief);
        }
      }

      // Read how fast each lane is running downstream, not just what is directly
      // in front. This is what makes traffic spread across lanes before a queue.
      const u = this.uOf(i);
      const free = this.desiredSpeedOf(i);
      const here = this.speedAhead(store.ahead[i], u, free, MOBIL.lookAhead);
      const tLead = dir > 0 ? store.leftLead[i] : store.rightLead[i];
      const there = this.speedAhead(tLead, u, Math.max(1, targetLane.speedLimit * store.v0Factor[i]),
        MOBIL.lookAhead);
      bias += clamp((there - here) * MOBIL.laneSpeedGain, -MOBIL.laneSpeedCap, MOBIL.laneSpeedCap);
      if (dir === (this.net.driveOnRight ? -1 : 1) && routeLateral === 0) {
        bias += MOBIL.keepRightBias;
      }
      bias += keepClearBias(this, i, dir > 0);

      const incentive = this.mobilIncentive(i, dir, bias);
      if (incentive > bestIncentive) {
        bestIncentive = incentive;
        bestDir = dir;
        bestAhead = check.aheadId;
        bestS = check.targetS;
      }
    }

    if (bestDir !== 0) {
      const target = bestDir > 0 ? lane.left : lane.right;
      this.performChange(i, laneId, target, bestAhead, bestS, false);
    }
  }

  /**
   * MOBIL incentive for moving `dir` (+1 left, -1 right). Cross-lane gaps are
   * measured in the shared parent-segment coordinate, so they stay meaningful even
   * where neighbouring lanes have slightly different lengths around a curve.
   */
  private mobilIncentive(i: number, dir: 1 | -1, bias: number): number {
    const store = this.store;
    const u = this.uOf(i);
    const v = store.v[i];
    const myLen = store.len[i];
    const lead = store.ahead[i];
    const fol = store.behind[i];
    const tLead = dir > 0 ? store.leftLead[i] : store.rightLead[i];
    const tLag = dir > 0 ? store.leftLag[i] : store.rightLag[i];

    _mobilIn.v = v;
    _mobilIn.v0 = this.desiredSpeedOf(i);
    _mobilIn.params = this.paramsOf(i, _pA);
    _mobilIn.gapCurrent = lead >= 0 ? store.s[lead] - store.len[lead] - store.s[i] : Infinity;
    _mobilIn.dvCurrent = lead >= 0 ? v - store.v[lead] : 0;
    _mobilIn.gapTarget = tLead >= 0 ? this.uOf(tLead) - u - store.len[tLead] : Infinity;
    _mobilIn.dvTarget = tLead >= 0 ? v - store.v[tLead] : 0;

    if (fol >= 0) {
      _mobilIn.oldFollowerParams = this.paramsOf(fol, _pB);
      _mobilIn.oldFollowerV = store.v[fol];
      _mobilIn.oldFollowerV0 = this.desiredSpeedOf(fol);
      _mobilIn.oldFollowerGap = store.s[i] - myLen - store.s[fol];
      _mobilIn.oldFollowerGapAfter = lead >= 0
        ? store.s[lead] - store.len[lead] - store.s[fol] : Infinity;
      _mobilIn.oldFollowerDvAfter = lead >= 0 ? store.v[fol] - store.v[lead] : 0;
    } else {
      _mobilIn.oldFollowerParams = null;
    }

    if (tLag >= 0) {
      _mobilIn.newFollowerParams = this.paramsOf(tLag, _pC);
      _mobilIn.newFollowerV = store.v[tLag];
      _mobilIn.newFollowerV0 = this.desiredSpeedOf(tLag);
      const uLag = this.uOf(tLag);
      _mobilIn.newFollowerGapBefore = tLead >= 0
        ? this.uOf(tLead) - uLag - store.len[tLead] : Infinity;
      _mobilIn.newFollowerDvBefore = tLead >= 0 ? store.v[tLag] - store.v[tLead] : 0;
      _mobilIn.newFollowerGapAfter = u - uLag - myLen;
      _mobilIn.newFollowerDvAfter = store.v[tLag] - v;
    } else {
      _mobilIn.newFollowerParams = null;
    }

    // Urgency dissolves politeness: a driver out of road stops being considerate.
    _mobilIn.politeness = store.politeness[i] * (1 - store.urgency[i]);
    _mobilIn.bias = bias;
    _mobilIn.threshold = MOBIL.threshold;
    _mobilIn.bSafe = MOBIL.bSafe;
    evaluateMobil(_mobilIn, _mobilOut);
    return _mobilOut.safe ? _mobilOut.incentive : -Infinity;
  }

  private performChange(
    i: number, from: number, target: number, aheadId: number, targetS: number, forced: boolean,
  ): void {
    const store = this.store;
    store.removeFromLane(i);
    // Changing straight back again: the driver is already part of the way across, so
    // carry that over instead of restarting from nothing. Restarting re-anchors the
    // lateral blend on a lane the car never reached and teleports it a full lane
    // width sideways — and smoothstep is symmetric, so the mirrored progress puts it
    // exactly where it already was.
    const reversing = store.lcFrom[i] === target && store.lcProgress[i] < 1;
    store.lcProgress[i] = reversing ? 1 - store.lcProgress[i] : 0;
    store.lcFrom[i] = from;
    store.lcFromS[i] = store.s[i];
    store.s[i] = targetS;
    store.insertAfter(i, target, aheadId);
    store.lcCooldown[i] = MOBIL.cooldown;
    store.gapLead[i] = -1;
    store.gapLag[i] = -1;
    store.gapOk[i] = 0;
    store.gapTimer[i] = 0;
    store.stoppedTime[i] = 0;
    // Clear the merge plan: it was measured from the old lane, and leaving it in
    // place makes a car that has just merged brake for a lane end it is no longer on.
    store.mergeLane[i] = -1;
    store.mergeRemaining[i] = Infinity;
    store.urgency[i] = 0;
    this.mergeRefU[i] = NaN;
    store.mergeWait[i] = 0;
    // The cached next edge belonged to the lane we just left.
    this.nextEdge[i] = this.edgeFor(target, store.dest[i]);
    this.uValid[i] = 0;
    this.moved[i] = 1;
    if (this.onBadChange) {
      const lead = store.ahead[i];
      const lag = store.behind[i];
      const gapFront = lead >= 0 ? store.s[lead] - store.len[lead] - store.s[i] : Infinity;
      const gapBack = lag >= 0 ? store.s[i] - store.len[i] - store.s[lag] : Infinity;
      if (gapFront < 0 || gapBack < 0) this.onBadChange(i, from, target, gapFront, gapBack);
    }
    this.metrics.laneChanges++;
    if (forced) this.metrics.forcedChanges++;
    if (this.net.lanes[from].endsAt < Infinity) noteZipperAdmission(this, from);
    this.observer?.onLaneChange?.(this, i, from, target, forced);
  }

  /**
   * Distance to whatever this vehicle is actually following, looking through the
   * lanes ahead.
   *
   * Without the look-through, vehicles queued just past a lane boundary are
   * invisible and everybody accelerates into the back of the queue. It is also the
   * only honest answer to "is the road in front of this driver clear", which
   * matters to anything measuring whether a driver is held up — a car two metres
   * into a twenty-five metre connector has an empty lane in front of it and a
   * stationary queue ten metres beyond.
   */
  gapAhead(i: number, out: { dv: number }): number {
    const store = this.store;
    const lanes = this.net.lanes;
    const lead = store.ahead[i];
    if (lead >= 0) {
      out.dv = store.v[i] - store.v[lead];
      return store.s[lead] - store.len[lead] - store.s[i];
    }
    out.dv = 0;
    let dist = lanes[store.lane[i]].length - store.s[i];
    let edge = this.nextEdge[i];
    // Look until the *distance* runs out, not until a fixed number of lanes has.
    // How many lanes 260 m is depends entirely on the network: on a drawn document
    // it is one or two, and on an imported city — where a road is cut at every one
    // of its junctions — it is a dozen 17 m segments and 21 m connectors. Stopping
    // after four of those is a look-ahead of seventy-five metres on a road where
    // stopping takes two hundred, and the queue at the end of it is invisible until
    // the driver is in it. That was most of the collisions in an imported freeway
    // interchange, all of them rear-end, all of them braking at the cap.
    for (let hop = 0; hop < LEADER_HOPS && edge >= 0 && dist < 260; hop++) {
      const tail = store.laneLast[edge];
      if (tail >= 0) {
        out.dv = store.v[i] - store.v[tail];
        return dist + store.s[tail] - store.len[tail];
      }
      dist += lanes[edge].length;
      edge = this.edgeFor(edge, store.dest[i]);
    }
    return Infinity;
  }

  // --- accelerations ------------------------------------------------------------

  private accelPass(): void {
    const store = this.store;
    const lanes = this.net.lanes;
    this.accel.fill(Infinity);
    this.store.hold.fill(Hold.Free);

    for (let laneId = 0; laneId < lanes.length; laneId++) {
      const lane = lanes[laneId];
      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) {
        const v = store.v[i];
        const v0 = this.desiredSpeedOf(i);
        const params = this.paramsOf(i, _pA);

        const gap = this.gapAhead(i, _gapOut);
        this.holdTag = Hold.Leader;
        this.constrain(i, idmAccel(v, v0, gap, _gapOut.dv, params));

        // Slow down for a tighter speed limit on the lane we are about to enter —
        // but only once it is close enough to need slowing for.
        //
        // This used to spread the speed loss over the *whole* remaining lane, which
        // is arithmetically tidy and behaviourally nothing like a driver. On a
        // 700 m approach to a junction it works out at a quarter of a metre per
        // second squared, sustained the entire way, so a driver routed onto a turn
        // crawled the length of the road: measured on a three-lane arterial, over
        // half of all traffic on the approach was held by this rule at 10 m/s on a
        // 22 m/s road, hundreds of metres out. Faster traffic then wove around them,
        // which is where "they change lanes constantly for no reason" came from.
        //
        // A real driver holds the limit and brakes for the turn when the turn is
        // close. So: work out the distance a comfortable deceleration would need,
        // and stay out of it until then.
        const next = this.nextEdge[i];
        if (next >= 0) {
          const limit = Math.max(1, lanes[next].speedLimit * store.v0Factor[i]);
          if (v > limit) {
            const d = Math.max(0.5, lane.length - store.s[i]);
            const need = (v * v - limit * limit) / (2 * params.b);
            if (d < need * SPEED_DROP_LOOKAHEAD) {
              this.holdTag = Hold.SpeedLimit;
              this.constrain(i, -(v * v - limit * limit) / (2 * d));
            }
          }
        }

        this.holdTag = Hold.SoftWall; applySoftWall(this, i);
        this.holdTag = Hold.GapFollow; applyGapFollowing(this, i);
        this.holdTag = Hold.Cooperate; applyCooperation(this, i);
        this.holdTag = Hold.Junction; applyJunctionRules(this, i);

        store.a[i] = clamp(this.accel[i], -IDM.bMax, params.aMax);
      }
    }
  }

  // --- integration ----------------------------------------------------------------

  private integratePass(): void {
    const store = this.store;
    const lanes = this.net.lanes;
    const dt = this.dt;

    for (let laneId = 0; laneId < lanes.length; laneId++) {
      const lane = lanes[laneId];
      const endingForThis = this.endingForTarget[laneId];
      const zipRef = endingForThis >= 0 ? this.mergeRefOnTarget[endingForThis] : NaN;

      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) {
        const v = store.v[i];
        store.sPrev[i] = store.s[i];
        store.lanePrev[i] = laneId;
        const vNew = Math.max(0, v + store.a[i] * dt);
        const ds = 0.5 * (v + vNew) * dt;
        store.v[i] = vNew;
        store.s[i] += ds;
        store.distance[i] += ds;
        store.age[i] += dt;
        store.stoppedTime[i] = vNew < 0.3 ? store.stoppedTime[i] + dt : 0;
        // Crawling although there is room to go faster: the mark of a driver held
        // by the merge machinery rather than by the queue in front of them.
        const lead = store.ahead[i];
        const room = lead >= 0 ? store.s[lead] - store.len[lead] - store.s[i] : Infinity;
        store.crawlTime[i] = vNew < MERGE.crawlSpeed && room > Math.max(10, vNew * 2 + IDM.s0)
          ? store.crawlTime[i] + dt : 0;
        this.uValid[i] = 0;

        // A lane that ends with nowhere to go must not be driven off the end.
        if (lane.endsAt < Infinity && this.nextEdge[i] < 0 && store.s[i] > lane.endsAt) {
          store.s[i] = lane.endsAt;
          store.v[i] = 0;
          store.a[i] = 0;
        }

        if (endingForThis >= 0 && store.sPrev[i] < zipRef && store.s[i] >= zipRef) {
          noteThroughPassed(this, endingForThis);
        }
      }
    }
  }

  // --- lane advance and despawn ---------------------------------------------------

  /** Scratch for `entrySpeedCap`: preallocated, because spawning happens every tick. */
  private readonly entryQueue = new Int32Array(ENTRY_NODES);

  private readonly entryDist = new Float64Array(ENTRY_NODES);

  private advancePass(): void {
    const store = this.store;
    const lanes = this.net.lanes;

    for (let laneId = 0; laneId < lanes.length; laneId++) {
      const lane = lanes[laneId];
      let i = store.laneFirst[laneId];
      while (i >= 0) {
        const next = store.behind[i];
        // Arriving at a zone is not driving off the end of the network, the way
        // arriving at a portal is — it is reaching one of the zone's own streets
        // and going a little way down it, which is a driver pulling onto their own
        // road and parking. The distance keeps them from vanishing on the spot at
        // the junction mouth, which is both wrong to look at and a way to make a
        // whole street's worth of traffic evaporate before it has entered the
        // street.
        if (this.zoneLane[store.dest[i]]?.[laneId] === 1 && store.s[i] >= this.arriveAt(laneId, i)) {
          this.retire(i, laneId);
          i = next;
          continue;
        }
        if (store.s[i] > lane.length) {
          let edge = this.nextEdge[i];
          if (edge < 0 && lane.successors.length) {
            // Reachable from this lane only by changing out of it, and the driver
            // ran out of road first. Carry on the way the lane goes and re-target,
            // which is what a driver who misses their turn does — deleting them
            // instead loses a vehicle at a junction it could have driven through.
            edge = lane.successors[0];
            this.retarget(i, laneId);
            if (this.nextEdge[i] >= 0) edge = this.nextEdge[i];
          }
          if (edge >= 0) {
            const overshoot = Math.max(0, store.s[i] - lane.length);
            const tail = store.laneLast[edge];
            if (tail >= 0 && store.s[tail] - store.len[tail] < overshoot) {
              // No room across the boundary yet: hold at the end of this lane.
              // Rare with the cross-boundary look-ahead in place, but it is the
              // last line of defence against driving into the back of a queue.
              store.s[i] = lane.length;
              store.v[i] = 0;
              this.metrics.boundaryHolds++;
            } else {
              store.removeFromLane(i);
              store.lcFrom[i] = -1;
              store.cameFrom[i] = laneId;
              store.insertIntoLane(i, edge, overshoot, tail);
              this.uValid[i] = 0;
            }
          } else {
            this.retire(i, laneId);
          }
        } else if (store.age[i] > SIM_LIMITS.maxLifetime) {
          this.retire(i, laneId);
        }
        i = next;
      }
    }
  }

  private retire(i: number, laneId: number): void {
    const store = this.store;
    const lane = this.net.lanes[laneId];
    const portal = this.net.portals[store.dest[i]];
    const arrived = portal
      ? portal.exitLanes.includes(laneId)
      : this.zoneLane[store.dest[i]]?.[laneId] === 1;
    // Leaving at the wrong exit is still leaving: the vehicle reached the edge of
    // the network, it just did not get where it wanted. Only a genuine dead end
    // counts as lost.
    // Reaching *a* zone when you wanted another one is not leaving the network, so
    // it is not an arrival — the driver is still on a live street and has simply
    // not got there yet. Only a portal exit is somewhere anybody can leave from.
    const leftNetwork = arrived || this.net.portals.some((p) => p.exitLanes.includes(laneId));
    let reason: 'arrived' | 'merge-failed' | 'lost';
    if (leftNetwork) {
      reason = 'arrived';
      if (!arrived) this.metrics.missedExits++;
      this.metrics.arrived++;
      this.metrics.totalTravel += store.age[i];
      this.metrics.totalWait += store.waitTime[i];
    } else if (lane.endsAt < Infinity) {
      reason = 'merge-failed';
      this.metrics.mergeFailures++;
    } else {
      reason = 'lost';
      this.metrics.lost++;
    }
    this.observer?.onRetire?.(this, i, laneId, reason);
    store.release(i);
  }

  // --- metrics --------------------------------------------------------------------

  private metricsPass(): void {
    const store = this.store;
    const lanes = this.net.lanes;
    let speedSum = 0;
    let count = 0;
    let stalled = 0;
    const seen = this.overlapNext;
    seen.clear();

    for (let laneId = 0; laneId < lanes.length; laneId++) {
      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) {
        speedSum += store.v[i];
        count++;
        if (store.stoppedTime[i] > 60) stalled++;
        const lead = store.ahead[i];
        if (lead >= 0 && store.s[lead] - store.len[lead] - store.s[i] < -0.05) {
          this.noteOverlap(store.serial[i], store.serial[lead], seen);
        }
      }
    }
    this.crossingCollisions(seen);

    // Carry the current set forward, so the next tick can tell a collision that is
    // still happening from a new one.
    this.overlapNext = this.overlapping;
    this.overlapping = seen;

    this.metrics.vehicles = count;
    this.metrics.meanSpeed = count ? speedSum / count : 0;
    this.metrics.stalled = stalled;
  }

  /**
   * Records one pair of vehicles as overlapping, counting it if it is new.
   *
   * `collisions` counts *events* over the run rather than pairs overlapping right
   * now. A snapshot only reports what happens to be true on the tick somebody
   * looks, so a run could finish clean and say nothing about the twenty collisions
   * in the middle of it — and every scenario suite reads this number once, at the
   * end.
   */
  private noteOverlap(a: number, b: number, seen: Set<number>): void {
    const key = a < b ? a * SERIAL_SPACE + b : b * SERIAL_SPACE + a;
    seen.add(key);
    if (!this.overlapping.has(key)) this.metrics.collisions++;
  }

  /**
   * Two vehicles on *different* lanes with their bodies over the same point.
   *
   * Following a leader too closely is the collision the per-lane check finds, and
   * for a long time it was the only one counted — so "zero collisions" meant zero
   * rear-end overlaps and said nothing at all about a junction, which is where
   * vehicles most obviously drive through each other. The conflict points the
   * compiler already emits are exactly where two paths share ground, so the test is
   * simply: is somebody's body over both ends of a conflict at once.
   */
  private crossingCollisions(seen: Set<number>): void {
    const store = this.store;
    for (const pair of this.conflictPairs) {
      if (store.laneFirst[pair.a] < 0 || store.laneFirst[pair.b] < 0) continue;
      const a = this.bodyOver(pair.a, pair.sa);
      if (a < 0) continue;
      const b = this.bodyOver(pair.b, pair.sb);
      if (b < 0) continue;
      this.noteOverlap(store.serial[a], store.serial[b], seen);
    }
  }

  /** The vehicle on `laneId` straddling arc-length `s`, or -1. */
  private bodyOver(laneId: number, s: number): number {
    const store = this.store;
    for (let v = store.laneFirst[laneId]; v >= 0; v = store.behind[v]) {
      // Front to back, so once a vehicle's tail is past the point nothing behind
      // it can be over the point either.
      if (store.s[v] - store.len[v] > s) return -1;
      if (store.s[v] >= s) return v;
    }
    return -1;
  }

  // --- introspection --------------------------------------------------------------

  /**
   * Checks the per-lane linked lists are well formed and sorted. Test-only; the
   * lists are the one piece of state that would corrupt silently.
   */
  validateLists(): string[] {
    const store = this.store;
    const problems: string[] = [];
    const seen = new Uint8Array(store.capacity);
    for (let laneId = 0; laneId < this.net.lanes.length; laneId++) {
      let prev = -1;
      let n = 0;
      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) {
        if (!store.alive[i]) problems.push(`lane ${laneId}: dead vehicle ${i}`);
        if (seen[i]) {
          problems.push(`vehicle ${i} appears twice`);
          break;
        }
        seen[i] = 1;
        if (store.lane[i] !== laneId) problems.push(`vehicle ${i} lists lane ${store.lane[i]} but sits in ${laneId}`);
        if (store.ahead[i] !== prev) problems.push(`vehicle ${i} ahead link broken in lane ${laneId}`);
        if (prev >= 0 && store.s[prev] < store.s[i] - 1e-4) {
          problems.push(`lane ${laneId} out of order: ${prev}@${store.s[prev]} before ${i}@${store.s[i]}`);
        }
        prev = i;
        if (++n > store.capacity) {
          problems.push(`lane ${laneId} list is cyclic`);
          break;
        }
      }
      if (store.laneLast[laneId] !== prev) problems.push(`lane ${laneId} tail pointer wrong`);
      if (store.laneCount[laneId] !== n) problems.push(`lane ${laneId} count ${store.laneCount[laneId]} but walked ${n}`);
    }
    let alive = 0;
    for (let i = 0; i < store.capacity; i++) if (store.alive[i]) alive++;
    let listed = 0;
    for (let i = 0; i < store.capacity; i++) if (seen[i]) listed++;
    if (alive !== listed) problems.push(`${alive} alive but ${listed} in lane lists`);
    return problems;
  }

  /** Vehicle ids in a stable order: by lane, then front to back. */
  forEachVehicle(fn: (i: number, laneId: number) => void): void {
    const store = this.store;
    for (let laneId = 0; laneId < this.net.lanes.length; laneId++) {
      for (let i = store.laneFirst[laneId]; i >= 0; i = store.behind[i]) fn(i, laneId);
    }
  }

  /**
   * Renderable pose of a vehicle, interpolated between ticks and across a change.
   *
   * A car is a rigid body, so its heading is the direction from its rear to its
   * front, not the tangent of the lane under its nose. Taking the tangent instead
   * swings the tail out of the lane on anything that curves — a car on a junction
   * connector points where the road is *going* rather than where the car is — and
   * makes a lane change a pure sideways slide, because two parallel lanes have the
   * same tangent and nothing ever yaws.
   *
   * Both ends are placed on the path the car is actually on, including its share of
   * the lateral blend. The rear's share is the one the front had a car's length ago,
   * which is what tilts the body into a lane change and straightens it out again.
   */
  sampleVehicle(i: number, alpha: number, out: { x: number; y: number; heading: number }): void {
    const store = this.store;
    const laneId = store.lane[i];
    const prevId = store.lanePrev[i];
    let lane = this.net.lanes[laneId];
    let s: number;
    if (prevId === laneId || prevId < 0) {
      s = store.sPrev[i] + (store.s[i] - store.sPrev[i]) * alpha;
    } else {
      // The vehicle crossed onto the next lane this tick, so the distance it
      // travelled spans two of them. Falling back to the end-of-tick position here
      // instead makes it jump forward and then stall for the rest of the tick —
      // a visible snap at the mouth of every junction, which is exactly where the
      // eye is already following it round a turn.
      const prev = this.net.lanes[prevId];
      const travelled = prev.length - store.sPrev[i] + store.s[i];
      const d = store.sPrev[i] + alpha * travelled;
      if (travelled <= 0) {
        s = store.s[i];
      } else if (d < prev.length) {
        lane = prev;
        s = d;
      } else {
        s = d - prev.length;
      }
    }
    const len = Math.max(1.5, store.len[i]);

    const from = store.lcFrom[i];
    // Lateral progress advances at a fixed rate, so the between-tick value is exact
    // rather than a guess: without it the slide steps once per tick and judders.
    const progress = from >= 0
      ? Math.min(1, store.lcProgress[i] + (alpha * this.dt) / MOBIL.lateralTime)
      : 1;
    const changing = from >= 0 && progress < 1;

    // The lane behind, so a long vehicle's rear end follows the road rather than a
    // straight line off the end of it. Only needed while the vehicle is shorter than
    // the distance it has come along this lane, and only trustworthy where it really
    // does feed this lane: after a sideways move it names the lane behind the one
    // just left, which would put the rear a lane's width out and flick the heading
    // round the moment the tail clears the boundary.
    const cameFrom = store.cameFrom[i];
    const behind = s < len && cameFrom >= 0 && lane.predecessors.includes(cameFrom)
      ? this.net.lanes[cameFrom]
      : null;

    // Front and rear on the lane being joined.
    backFrom(lane, s, 0, null, out);
    backFrom(lane, s, len, behind, _p3);
    let baseRearX = _p3.x;
    let baseRearY = _p3.y;
    let rearX = _p3.x;
    let rearY = _p3.y;

    if (changing) {
      const fromLane = this.net.lanes[from];
      const fs = parentToLaneS(fromLane, laneSToParent(lane, s));
      backFrom(fromLane, fs, 0, null, _p2);
      const t = smoothLateral(progress);
      out.x = _p2.x + (out.x - _p2.x) * t;
      out.y = _p2.y + (out.y - _p2.y) * t;

      const fromBehind = fs < len && cameFrom >= 0 && fromLane.predecessors.includes(cameFrom)
        ? this.net.lanes[cameFrom]
        : null;
      backFrom(fromLane, fs, len, fromBehind, _p4);
      // The rear is where the front was a car's length ago, so it is that much
      // further back through the change. That lag is the whole yaw — but it is
      // squeezed into the manoeuvre rather than trailing off the end of it, so the
      // body is straight when the change starts, angled in the middle, and straight
      // again when it finishes. Letting the rear lag past the end instead leaves the
      // vehicle still angled at the moment the change is declared over, and the yaw
      // then vanishes in a single frame.
      const lag = Math.min(0.6, len / (Math.max(store.v[i], YAW_REF_SPEED) * MOBIL.lateralTime));
      const tRear = smoothLateral((progress - lag) / (1 - lag));
      baseRearX = _p4.x + (_p3.x - _p4.x) * t;
      baseRearY = _p4.y + (_p3.y - _p4.y) * t;
      rearX = _p4.x + (_p3.x - _p4.x) * tRear;
      rearY = _p4.y + (_p3.y - _p4.y) * tRear;
    }

    const dx = out.x - rearX;
    const dy = out.y - rearY;
    if (dx * dx + dy * dy < 1e-6) {
      samplePose(lane, s, _pose);
      out.heading = _pose.heading;
      return;
    }
    out.heading = Math.atan2(dy, dx);
    if (!changing) return;

    // A car crawling across a lane line would otherwise crab almost sideways: the
    // model moves it over in a fixed time whatever its speed. Cap the angle against
    // the heading the body would have had anyway, so a curve still reads correctly.
    const base = Math.atan2(out.y - baseRearY, out.x - baseRearX);
    let yaw = out.heading - base;
    while (yaw <= -Math.PI) yaw += 2 * Math.PI;
    while (yaw > Math.PI) yaw -= 2 * Math.PI;
    if (yaw > MAX_YAW) out.heading = base + MAX_YAW;
    else if (yaw < -MAX_YAW) out.heading = base - MAX_YAW;
  }

  reset(): void {
    this.store.reset();
    this.signals.reset();
    this.time = 0;
    this.ticks = 0;
    for (const pair of this.demand) {
      pair.queued = 0;
      pair.timer = 0;
    }
    primeTimers(this.demand, this.rng);
    Object.assign(this.metrics, {
      vehicles: 0, spawned: 0, arrived: 0, queued: 0, mergeFailures: 0, lost: 0,
      missedExits: 0, boundaryHolds: 0, collisions: 0, meanSpeed: 0, stalled: 0,
      totalWait: 0, totalTravel: 0, laneChanges: 0, forcedChanges: 0, simTimeMs: 0,
    });
  }
}

const _pose = { x: 0, y: 0, heading: 0 };
const _p1 = { x: 0, y: 0 };
const _p2 = { x: 0, y: 0 };
const _p3 = { x: 0, y: 0 };
const _p4 = { x: 0, y: 0 };

/** Steepest angle a body is drawn at relative to the path it is on. */
const MAX_YAW = (22 * Math.PI) / 180;
/**
 * Speed the crab angle of a lane change is worked out at, when the driver is going
 * slower than this. The lag behind the front goes as 1/speed, so down in a queue a
 * tick's worth of braking swings it several degrees a frame — the angle is jittering
 * on the speed rather than on anything the vehicle is doing. Holding a reference
 * speed also says something true: a lane change takes a distance, not a time.
 */
const YAW_REF_SPEED = 8;
const _t1 = { x: 0, y: 0 };

/**
 * A point `back` metres behind `s`, following `behind` off the start of the lane
 * when the vehicle is longer than the distance it has travelled along it.
 *
 * A vehicle straddling a lane boundary still has to have a rear end somewhere, and
 * clamping it to the lane start would collapse the body to nothing and take the
 * heading with it. Running straight back along the entry tangent instead is fine for
 * a car leaving a gentle curve, but a bus coming off a junction connector has its
 * back end several metres from where that line puts it — and the error vanishes the
 * moment the whole vehicle is on one lane, which is what makes it read as a snap.
 */
function backFrom(
  lane: { centerline: Float32Array; arclength: Float32Array }, s: number, back: number,
  behind: { centerline: Float32Array; arclength: Float32Array; length: number } | null,
  out: { x: number; y: number },
): void {
  const at = s - back;
  if (at >= 0) {
    samplePosition(lane.centerline, lane.arclength, at, out);
    return;
  }
  if (behind) {
    const ps = behind.length + at;
    if (ps >= 0) {
      samplePosition(behind.centerline, behind.arclength, ps, out);
      return;
    }
    // Longer than the lane behind as well: carry on straight from its start.
    samplePosition(behind.centerline, behind.arclength, 0, out);
    sampleSmoothTangent(behind.centerline, behind.arclength, 0, _t1, 1.5);
    out.x += _t1.x * ps;
    out.y += _t1.y * ps;
    return;
  }
  samplePosition(lane.centerline, lane.arclength, 0, out);
  sampleSmoothTangent(lane.centerline, lane.arclength, 0, _t1, 1.5);
  out.x += _t1.x * at;
  out.y += _t1.y * at;
}

function samplePose(lane: { centerline: Float32Array; arclength: Float32Array }, s: number,
  out: { x: number; y: number; heading: number }): void {
  samplePosition(lane.centerline, lane.arclength, s, _p1);
  sampleSmoothTangent(lane.centerline, lane.arclength, s, _t1, 1.5);
  out.x = _p1.x;
  out.y = _p1.y;
  out.heading = Math.atan2(_t1.y, _t1.x);
}

function smoothLateral(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}


