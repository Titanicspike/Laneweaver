import { Simulation, type SimObserver } from '@core/sim/sim';
import { checkChange } from '@core/sim/merge';
import { mapS } from '@core/network/laneGraph';
import type { Network } from '@core/network/types';
import type { ScenarioNet } from './scenarios';

export interface MergeReport {
  seed: number;
  /** Vehicles that entered from the ramp (or started in the lane that drops). */
  merging: number;
  /** Of those, how many completed the change in the first 60% of the auxiliary lane. */
  mergedEarly: number;
  earlyFraction: number;
  /** Speed difference against nearby traffic at the moment of a merge, m/s. */
  maxDeltaV: number;
  medianDeltaV: number;
  p90DeltaV: number;
  deltaVOver3: number;
  /** Mainline decelerations harder than -3.5 m/s^2 near the merge. */
  hardBrakes: number;
  collisions: number;
  /** Vehicles stationary for more than 60 s. */
  stalled: number;
  maxStopTime: number;
  mergeFailures: number;
  lost: number;
  missedExits: number;
  /** Mergers stopped over 60 s while their target lane had room. */
  stuckMergers: number;
  /** Vehicles per hour arriving downstream, measured after warm-up. */
  throughputVph: number;
  /**
   * Share of taper admissions that came from the auxiliary lane, counted only while
   * the taper is congested. Alternation is only meaningful when both streams are
   * queued; in free flow the ratio just reflects demand.
   */
  admissionRatio: number;
  admissionsAux: number;
  admissionsThrough: number;
  /** Seconds the taper spent congested enough for the zipper to be enforcing. */
  zipperSeconds: number;
  /** Mainline vehicles that stopped (under 1 m/s for over 5 s) to reach an exit. */
  stoppedToExit: number;
  meanSpeed: number;
  forcedChanges: number;
  spawned: number;
  arrived: number;
  queued: number;
}

export interface MeasureOptions {
  seed?: number;
  /** Seconds discarded before measurement starts. */
  warmup?: number;
  /** Seconds measured. */
  duration?: number;
  maxVehicles?: number;
}

function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * True when the lane a merger is aiming at genuinely has room beside it. Uses the
 * simulation's own gap measurement, so it sees traffic across lane boundaries the
 * same way the merge logic does - otherwise the metric reports phantom deadlocks
 * for vehicles that are simply waiting behind a full lane.
 */
function targetHasRoom(sim: Simulation, auxLane: number, i: number): boolean {
  if (auxLane < 0) return false;
  const target = sim.net.lanes[auxLane].mergeTarget;
  if (target < 0) return false;
  const check = checkChange(sim, i, target, true);
  return check.gapFront > sim.store.len[i] * 0.5 + 1 && check.gapBack > 1;
}

/** Lanes of the mainline near the merge, used for the braking check. */
function influenceZone(net: Network, auxLane: number): { lanes: Set<number>; refS: number } {
  const lanes = new Set<number>();
  let refS = 0;
  if (auxLane >= 0) {
    const aux = net.lanes[auxLane];
    const target = net.lanes[aux.mergeTarget];
    if (target) {
      refS = mapS(aux, aux.endsAt === Infinity ? aux.length : aux.endsAt, target);
      for (const id of net.segments[target.segmentId].laneIds) {
        if (!net.lanes[id].aux) lanes.add(id);
      }
    }
  }
  return { lanes, refS };
}

export function runMergeScenario(scenario: ScenarioNet, options: MeasureOptions = {}): MergeReport {
  const { net } = scenario;
  const seed = options.seed ?? 1;
  const warmup = options.warmup ?? 120;
  const duration = options.duration ?? 600;
  const sim = new Simulation(net, {
    seed,
    demand: scenario.model.demand,
    maxVehicles: options.maxVehicles ?? 6000,
  });

  const aux = scenario.auxLane;
  const zone = influenceZone(net, aux);
  const auxEnd = aux >= 0 ? (net.lanes[aux].endsAt === Infinity ? net.lanes[aux].length : net.lanes[aux].endsAt) : 1;

  let merging = 0;
  let mergedEarly = 0;
  let maxDeltaV = 0;
  let deltaVOver3 = 0;
  const deltaVs: number[] = [];
  let hardBrakes = 0;
  let collisions = 0;
  let stalled = 0;
  let maxStopTime = 0;
  let admissionsAux = 0;
  let stuckMergers = 0;
  let zipperSeconds = 0;
  let stoppedToExit = 0;
  let congestedNow = false;
  const slowSince = new Map<number, number>();
  const brakingNow = new Set<number>();
  let admissionsThrough = 0;
  let arrivedAtStart = 0;
  let measuring = false;
  let speedSum = 0;
  let speedTicks = 0;

  const observer: SimObserver = {
    onLaneChange(s, i, from, to, _forced) {
      void to;
      if (from !== aux || aux < 0) return;
      if (!measuring) return;
      merging++;
      if (s.store.lcFromS[i] <= auxEnd * 0.6) mergedEarly++;
      if (congestedNow) admissionsAux++;
      // Only compare against traffic that is actually nearby: an empty target lane
      // makes the speed-difference criterion meaningless, not satisfied.
      const lead = s.store.ahead[i];
      const lag = s.store.behind[i];
      let reference = -1;
      if (lead >= 0 && s.store.s[lead] - s.store.s[i] < 80) reference = lead;
      else if (lag >= 0 && s.store.s[i] - s.store.s[lag] < 80) reference = lag;
      if (reference >= 0) {
        const dv = Math.abs(s.store.v[i] - s.store.v[reference]);
        deltaVs.push(dv);
        if (dv > maxDeltaV) maxDeltaV = dv;
        if (dv > 3) deltaVOver3++;
      }
    },
  };
  sim.observer = observer;

  const totalSeconds = warmup + duration;
  const steps = Math.round(totalSeconds / sim.dt);
  for (let step = 0; step < steps; step++) {
    if (!measuring && sim.time >= warmup) {
      measuring = true;
      arrivedAtStart = sim.metrics.arrived;
    }
    const prevS = new Map<number, number>();
    if (measuring && zone.refS > 0) {
      const target = net.lanes[aux].mergeTarget;
      for (let v = sim.store.laneFirst[target]; v >= 0; v = sim.store.behind[v]) {
        prevS.set(v, sim.store.s[v]);
      }
    }

    sim.tick();

    if (!measuring) continue;
    // `sim.metrics.collisions` counts events over the run, so it is read at the
    // end rather than summed each tick — summing a running total once turned a
    // single collision into seven thousand.
    collisions = sim.metrics.collisions;
    if (sim.metrics.stalled > stalled) stalled = sim.metrics.stalled;
    speedSum += sim.metrics.meanSpeed;
    speedTicks++;

    congestedNow = aux >= 0 && sim.zipperCongested[aux] === 1;
    if (congestedNow) zipperSeconds += sim.dt;
    if (zone.refS > 0 && congestedNow) {
      const target = net.lanes[aux].mergeTarget;
      for (let v = sim.store.laneFirst[target]; v >= 0; v = sim.store.behind[v]) {
        const before = prevS.get(v);
        if (before !== undefined && before < zone.refS && sim.store.s[v] >= zone.refS) {
          admissionsThrough++;
        }
      }
    }

    sim.forEachVehicle((i, laneId) => {
      if (sim.store.stoppedTime[i] > maxStopTime) maxStopTime = sim.store.stoppedTime[i];
      // The invariant that matters: the vehicle at the head of the merging queue
      // must never be stuck while there is room beside it.
      if (laneId === aux && sim.store.ahead[i] < 0 &&
          sim.store.stoppedTime[i] > 60 && targetHasRoom(sim, aux, i)) {
        stuckMergers++;
      }
      if (!zone.lanes.has(laneId)) return;
      // Stopping in a live mainline lane in order to reach an exit.
      if (sim.store.v[i] < 1) {
        const since = slowSince.get(i);
        if (since === undefined) slowSince.set(i, sim.time);
        else if (sim.time - since > 5) {
          stoppedToExit++;
          slowSince.set(i, sim.time);
        }
      } else {
        slowSince.delete(i);
      }
      // Count braking *events*, not the ticks they last.
      const braking = sim.store.a[i] < -3.5;
      const nearMerge = Math.abs(sim.store.s[i] - zone.refS) < 400;
      if (braking && nearMerge && !brakingNow.has(i)) {
        hardBrakes++;
        brakingNow.add(i);
      } else if (!braking) {
        brakingNow.delete(i);
      }
    });
  }

  const arrived = sim.metrics.arrived - arrivedAtStart;
  return {
    seed,
    merging,
    mergedEarly,
    earlyFraction: merging ? mergedEarly / merging : 1,
    maxDeltaV,
    medianDeltaV: quantile(deltaVs, 0.5),
    p90DeltaV: quantile(deltaVs, 0.9),
    deltaVOver3,
    hardBrakes,
    collisions,
    stalled,
    maxStopTime,
    mergeFailures: sim.metrics.mergeFailures,
    lost: sim.metrics.lost,
    missedExits: sim.metrics.missedExits,
    stuckMergers,
    throughputVph: (arrived / duration) * 3600,
    admissionRatio: admissionsAux + admissionsThrough > 0
      ? admissionsAux / (admissionsAux + admissionsThrough) : 0,
    admissionsAux,
    admissionsThrough,
    zipperSeconds,
    stoppedToExit,
    meanSpeed: speedTicks ? speedSum / speedTicks : 0,
    forcedChanges: sim.metrics.forcedChanges,
    spawned: sim.metrics.spawned,
    arrived: sim.metrics.arrived,
    queued: sim.metrics.queued,
  };
}

/** Runs the scenario across several seeds and returns every report. */
export function runSeeds(
  build: () => ScenarioNet, seeds: number[], options: MeasureOptions = {},
): MergeReport[] {
  return seeds.map((seed) => runMergeScenario(build(), { ...options, seed }));
}

export function summarise(reports: MergeReport[]): Record<string, number> {
  const avg = (fn: (r: MergeReport) => number): number =>
    reports.reduce((acc, r) => acc + fn(r), 0) / reports.length;
  const worst = (fn: (r: MergeReport) => number): number =>
    reports.reduce((acc, r) => Math.max(acc, fn(r)), -Infinity);
  return {
    earlyFraction: avg((r) => r.earlyFraction),
    minEarlyFraction: -worst((r) => -r.earlyFraction),
    maxDeltaV: worst((r) => r.maxDeltaV),
    medianDeltaV: avg((r) => r.medianDeltaV),
    p90DeltaV: avg((r) => r.p90DeltaV),
    deltaVOver3: worst((r) => r.deltaVOver3),
    hardBrakes: worst((r) => r.hardBrakes),
    collisions: worst((r) => r.collisions),
    stalled: worst((r) => r.stalled),
    maxStopTime: worst((r) => r.maxStopTime),
    mergeFailures: worst((r) => r.mergeFailures),
    lost: worst((r) => r.lost),
    missedExits: worst((r) => r.missedExits),
    stuckMergers: worst((r) => r.stuckMergers),
    throughputVph: avg((r) => r.throughputVph),
    minThroughput: -worst((r) => -r.throughputVph),
    admissionRatio: avg((r) => r.admissionRatio),
    zipperSeconds: avg((r) => r.zipperSeconds),
    stoppedToExit: worst((r) => r.stoppedToExit),
    meanSpeed: avg((r) => r.meanSpeed),
    merging: avg((r) => r.merging),
    spawned: avg((r) => r.spawned),
    queued: avg((r) => r.queued),
  };
}
