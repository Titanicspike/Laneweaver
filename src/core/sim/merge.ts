/**
 * The merge model.
 *
 * Four things make merges work here, and all four have to be present:
 *
 *  1. Real geometry. The compiler always gives a merge an acceleration lane plus a
 *     taper, so vehicles have runway instead of a point to squeeze into.
 *  2. Anticipation. A lane that ends presents a soft wall, but it only engages
 *     inside ~1.5x stopping distance, and it eases off further once the driver has
 *     a gap lined up - so the ramp is used to accelerate, not to creep.
 *  3. Gap *seeking*, not gap waiting. A merger scores candidate gaps in the target
 *     lane and regulates its speed against the chosen gap's leader projected into
 *     its own coordinates. Cars match speed and slot in.
 *  4. Cooperation. The chosen gap's follower adopts the merger as a virtual leader
 *     and opens up, and mainline traffic is nudged out of the kerb lane near a gore.
 *
 * On top of that, urgency rises as the deadline approaches: accepted gaps shrink
 * toward the physical minimum, politeness goes to zero, courtesy becomes mandatory,
 * and creeping is allowed at the very end. The collision floor is the one thing
 * urgency never touches. Together these make "stuck at a lane end" unreachable.
 *
 * Longitudinal positions here are measured as *distance remaining to the merge
 * cross-section*, which is directly comparable between a car on a ramp and a car on
 * the mainline even though they are on completely different geometry.
 */

import { clamp01 } from '../geom/vec2';
import { laneSToParent, mapS } from '../network/laneGraph';
import { desiredGap, idmAccel, stoppingDistance } from './idm';
import { IDM, MERGE, MOBIL } from './params';
import type { Simulation } from './sim';
import type { Lane } from '../network/types';

const _pSelf = { s0: IDM.s0, T: IDM.T, aMax: IDM.aMax, b: IDM.b };
const _pOther = { s0: IDM.s0, T: IDM.T, aMax: IDM.aMax, b: IDM.b };

/** How far past a lane boundary the gap search looks, metres. */
const BOUNDARY_LOOK = 90;
/** No lane change may ever leave less than this bumper to bumper. */
const MIN_PHYSICAL_GAP = 0.6;
/** Clearance kept in the kinematic safety test. */
const SAFETY_CLEARANCE = 0.5;

function lerpToward(from: number, to: number, t: number): number {
  const v = from + (to - from) * clamp01(t);
  return v < to ? to : v;
}

/**
 * The collision floor: can the follower still avoid hitting the leader?
 *
 * This is deliberately *not* IDM's acceleration. IDM's spacing term reports a huge
 * deceleration for a stopped car sitting a metre behind another stopped car, which
 * is a comfort complaint, not a hazard - and treating it as one is exactly what
 * makes zipper merging impossible in a jam. Here we ask the physical question: at
 * the current closing speed, is `bSafe` enough to stop in the gap available?
 */
export function safeToInsert(vFollower: number, vLead: number, gap: number, bSafe: number): boolean {
  if (gap < MIN_PHYSICAL_GAP) return false;
  const closing = vFollower - vLead;
  if (closing <= 0) return true;
  // The follower keeps closing for a moment before its braking bites, so that
  // distance is spent before any of the gap is available for stopping in.
  const room = gap - SAFETY_CLEARANCE - closing * MERGE.insertReaction;
  if (room <= 0) return false;
  return (closing * closing) / (2 * room) <= bSafe;
}

const _plan = { changes: 0, deadline: Infinity, target: -1 };

/**
 * Follows the lateral gradient from `laneId` and reports how many changes the route
 * needs and the tightest deadline any of them imposes, expressed on `laneId`.
 */
export function lateralPlan(sim: Simulation, laneId: number, dest: number): typeof _plan {
  const net = sim.net;
  const origin = net.lanes[laneId];
  _plan.changes = 0;
  _plan.deadline = origin.endsAt === Infinity ? origin.length : origin.endsAt;
  _plan.target = -1;

  let cur = laneId;
  for (let hop = 0; hop < 5; hop++) {
    const advice = sim.advise(cur, dest);
    if (advice.lateral === 0) break;
    const lane = net.lanes[cur];
    const next = advice.lateral > 0 ? lane.left : lane.right;
    if (next < 0) break;
    if (_plan.changes === 0) _plan.target = next;
    _plan.changes++;
    const t = net.lanes[next];
    if (t.segmentId >= 0 && t.segmentId === origin.segmentId) {
      const tEnd = t.endsAt === Infinity ? t.length : t.endsAt;
      const mapped = mapS(t, tEnd, origin);
      if (mapped < _plan.deadline) _plan.deadline = mapped;
    }
    cur = next;
  }
  return _plan;
}

/**
 * Works out whether this vehicle has a merge ahead of it, how far away the deadline
 * is, and how urgent it has become. Looks through the route, so a car still on the
 * ramp already knows about the taper 300 m away.
 */
export function planMerge(sim: Simulation, i: number): void {
  const store = sim.store;
  const net = sim.net;
  const dest = store.dest[i];
  let laneId = store.lane[i];
  let dist = -store.s[i];

  for (let hop = 0; hop < 6 && laneId >= 0; hop++) {
    const lane = net.lanes[laneId];
    const plan = lateralPlan(sim, laneId, dest);
    if (plan.changes > 0) {
      // A different lane to leave from is a different wait.
      if (store.mergeLane[i] !== laneId) store.mergeWait[i] = 0;
      const raw = dist + plan.deadline;
      const remaining = Math.max(0, raw);
      store.mergeLane[i] = laneId;
      store.mergeRemaining[i] = remaining;
      store.mergePast[i] = Math.max(0, -raw);
      store.mergeDeadline[i] = plan.deadline;
      store.urgency[i] = clamp01(1 - remaining / (MERGE.urgencyRange * Math.min(plan.changes, 3)));
      return;
    }
    dist += lane.length;
    if (dist > MERGE.horizon) break;
    const advice = sim.advise(laneId, dest);
    if (advice.successor < 0) break;
    laneId = advice.successor;
  }

  store.mergeLane[i] = -1;
  store.mergeRemaining[i] = Infinity;
  store.mergePast[i] = 0;
  store.mergeWait[i] = 0;
  store.urgency[i] = 0;
  store.gapLead[i] = -1;
  store.gapLag[i] = -1;
  store.gapOk[i] = 0;
}

/** The lane this vehicle must move into next, or -1. */
export function mergeTargetOf(sim: Simulation, i: number): number {
  const store = sim.store;
  const mergeLane = store.mergeLane[i];
  if (mergeLane < 0) return -1;
  const lane = sim.net.lanes[mergeLane];
  const plan = lateralPlan(sim, mergeLane, store.dest[i]);
  if (plan.target >= 0) return plan.target;
  return lane.mergeTarget;
}

/**
 * Reference coordinate for a merge: the cross-section the change must be complete
 * by, in the parent segment's frame. Everything else - gap scoring, cooperation,
 * the zipper - measures distance to this one point, which is what lets a car on a
 * ramp compare itself against traffic on the mainline.
 */
export function referenceU(sim: Simulation, laneId: number, deadline: number): number {
  const lane = sim.net.lanes[laneId];
  return laneSToParent(lane, deadline) * lane.side;
}

/** Distance from a vehicle on the *target* lane to the merge cross-section. */
function targetDistance(sim: Simulation, j: number, refU: number): number {
  return refU - sim.uOf(j);
}

/**
 * Scores the candidate gaps around the merger's projected position and picks one.
 * Re-run every `MERGE.reevaluate` seconds, or immediately if the current choice
 * has become invalid.
 */
export function selectGap(sim: Simulation, i: number, targetLaneId: number, refU: number): void {
  const store = sim.store;
  const dMe = store.mergeRemaining[i];
  const myLen = store.len[i];
  const v = store.v[i];
  const urgency = store.urgency[i];
  const params = sim.paramsOf(i, _pSelf);

  // Walk the target lane from the front until we bracket our own position.
  let lead = -1;
  let lag = store.laneFirst[targetLaneId];
  while (lag >= 0 && targetDistance(sim, lag, refU) < dMe) {
    lead = lag;
    lag = store.behind[lag];
  }

  // Step back a couple of gaps so we can also consider slotting in further ahead.
  for (let k = 0; k < MERGE.candidates - 1 && lead >= 0; k++) {
    lag = lead;
    lead = store.ahead[lead];
  }

  let bestLead = -1;
  let bestLag = -1;
  let bestScore = Infinity;
  let bestFeasible = false;
  const giveUpBack = noProgress(store, i) > MERGE.alignGiveUp * 0.5;

  // Has this driver run out of both road and speed?
  //
  // It matters because the two rules below — don't drop back, and don't want a gap
  // you cannot reach — are both written for a driver who is still moving, and both
  // are exactly inverted for one who is not. A driver at a standstill on the last
  // metre of an acceleration lane cannot drive to a gap at all: the gaps come to
  // *them*. So the only reachable gap is one that is still upstream, and the one
  // alongside — the only one the moving-driver rules permit — is the single worst
  // choice available, because by the time anybody has opened it, it has gone.
  //
  // Measured on `onramp-heavy`: the chosen gap advanced by exactly one vehicle
  // every two seconds, forever, each re-selection handing the cooperation job to
  // whichever mainline driver happened to be alongside. Nobody ever held it long
  // enough to open anything, and the driver sat at the lane end for 76 seconds
  // with the mainline flowing past at 10 m/s.
  const stranded = v <= MERGE.creepSpeed && dMe <= MERGE.strandedZone;

  for (let k = 0; k < MERGE.candidates * 2 + 1; k++) {
    const dLead = lead >= 0 ? targetDistance(sim, lead, refU) : -Infinity;
    const dLag = lag >= 0 ? targetDistance(sim, lag, refU) : Infinity;
    const leadLen = lead >= 0 ? store.len[lead] : 0;
    const vLead = lead >= 0 ? store.v[lead] : v;
    const vLag = lag >= 0 ? store.v[lag] : v;
    const gapSize = dLag - dLead - leadLen;

    if (gapSize > 0) {
      // Accepted gaps shrink from the comfortable IDM value toward the physical
      // minimum as urgency rises. `s0` is the floor; it never goes below it.
      const wantFront = lerpToward(desiredGap(v, v - vLead, params), IDM.s0, urgency);
      const lagParams = lag >= 0 ? sim.paramsOf(lag, _pOther) : params;
      const wantBack = lerpToward(desiredGap(vLag, vLag - v, lagParams), IDM.s0, urgency);
      const need = myLen + wantFront + wantBack;
      const feasible = gapSize >= need;

      // Where in the gap we would sit: the nearest point that satisfies both the
      // front and back requirements, which is usually where we already are.
      const low = lead >= 0 ? dLead + leadLen + wantFront : -Infinity;
      const high = Number.isFinite(dLag) ? dLag - myLen - wantBack : Infinity;
      const dTarget = dMe < low ? low : dMe > high ? high : dMe;
      const align = Math.abs(dMe - dTarget);

      const aSelf = lead >= 0
        ? idmAccel(v, sim.desiredSpeedOf(i), Math.max(0.2, dMe - dLead - leadLen), v - vLead, params)
        : params.aMax;
      const aLag = lag >= 0
        ? idmAccel(vLag, sim.desiredSpeedOf(lag), Math.max(0.2, dLag - dMe - myLen), vLag - v, lagParams)
        : 0;

      // The lag term is weighted heavily on purpose: taking a gap whose follower
      // would have to brake for us is the single worst thing a merger can do, and
      // the alternative - easing off and slotting in behind them - is nearly free.
      let score = align * 0.06
        + Math.max(0, -aSelf) * 1.0
        + Math.max(0, -aLag) * 3.0
        - Math.min(gapSize, 45) * 0.05;
      if (!feasible) score += 25;
      // Prefer gaps we do not have to reverse into.
      if (dTarget > dMe + 60) score += 8;
      // And stop preferring them at all once dropping back has stopped working.
      // Falling into a gap behind you needs you to be slower than the traffic
      // beside you; when that traffic is trying to fall back too — two drivers
      // side by side, each easing off for the other — neither ever gets there and
      // both crawl. A gap in front can be reached on your own, so a driver who
      // has been getting nowhere takes that instead. It is also what breaks the
      // symmetry: accelerating is unilateral, easing off is not.
      //
      // None of which applies to a driver who has already stopped: easing off is
      // not a thing they can still do, and the traffic beside them is faster by
      // definition. For them dropping back is not a choice at all — it is what
      // happens while they wait.
      if (giveUpBack && !stranded && dTarget > dMe + 1) score += 40;
      if (lead === store.gapLead[i] && lag === store.gapLag[i]) score -= MERGE.gapHysteresis;
      if (stranded) {
        // Gaps arrive rather than being driven to. One still upstream will come to
        // us; one already downstream never will, however close alongside it looks.
        if (dTarget < dMe - 1) score += 30;
      } else if (align > dMe * 0.8 + 20) {
        // Rule out gaps we could not reach with the runway left: at the taper end
        // the only gap worth wanting is the one we are already beside.
        score += 30;
      }
      // Stay with the gap we picked last time. Re-choosing costs the cooperation
      // that was being built for us — the mainline driver opening up is holding a
      // commitment to *this* vehicle, and a different one inherits the job the
      // moment we look elsewhere. Half a metre per second squared of preference is
      // enough to stop the churn without locking anybody onto a gap that has
      // stopped making sense.
      

      if (score < bestScore) {
        bestScore = score;
        bestLead = lead;
        bestLag = lag;
        bestFeasible = feasible;
      }
    }

    if (lag < 0) break;
    lead = lag;
    lag = store.behind[lag];
  }

  store.gapLead[i] = bestLead;
  store.gapLag[i] = bestLag;
  store.gapOk[i] = bestFeasible ? 1 : 0;
  store.gapTimer[i] = MERGE.reevaluate;
}

/**
 * How long this driver has been getting nowhere.
 *
 * Either stopped, or crawling with a clear road — the second is what a driver held
 * by the merge model's own anti-freeze floors looks like, and reading only the
 * first is why every escape hatch here was unreachable: gap alignment holds at
 * 0.8 m/s and creeping at 2, so a deadlocked driver never registers as stopped and
 * the last resort that guarantees nobody is permanently stuck never fires.
 */
function noProgress(store: Simulation['store'], i: number): number {
  return Math.max(store.stoppedTime[i], store.crawlTime[i]);
}

/**
 * Speed regulation toward the chosen gap.
 *
 * Ahead of the gap's leader we run IDM against it, projected into our own frame -
 * this is what produces the "match speed and slot in" behaviour. If we have somehow
 * got in front of the gap we ease off instead, which is the only way to fall back
 * into a gap without reversing.
 */
export function applyGapFollowing(sim: Simulation, i: number): void {
  const store = sim.store;
  const lead = store.gapLead[i];
  if (lead < 0 || !store.alive[lead]) return;
  // Anti-freeze: a vehicle that has crawled this long with a clear road is not
  // aligning with anything, it is deadlocked against a neighbour doing the same —
  // two drivers side by side, each easing off to fall in behind the other, each
  // held at the floor that was supposed to stop them freezing. Drop the gap
  // constraint; the real leader on its own lane still holds it back if there is
  // genuinely something in the way, and the two drivers' own desired speeds then
  // differ enough to break the tie.
  if (store.crawlTime[i] > MERGE.alignGiveUp) return;
  // Out of patience: regulating speed against a gap you have been refused for this
  // long is not aligning with anything, it is queueing politely behind a decision
  // that is not going to change. Drop the constraint and take what is there.
  if (store.mergeWait[i] > MERGE.patience) return;

  const refU = sim.mergeRefU[i];
  if (!Number.isFinite(refU)) return;
  const dMe = store.mergeRemaining[i];
  const dLead = refU - sim.uOf(lead);
  const v = store.v[i];
  const vLead = store.v[lead];
  const params = sim.paramsOf(i, _pSelf);
  const gap = dMe - dLead - store.len[lead];

  if (gap > 0.3) {
    sim.constrain(i, idmAccel(v, sim.desiredSpeedOf(i), gap, v - vLead, params));
  } else {
    // Alongside or past the leader: ease off and drop back rather than force our
    // way in. This is the only way to fall into a gap without reversing.
    // The floor matters: two vehicles side by side, each easing off for the other,
    // would hold each other at a dead stop forever. A crawl breaks the symmetry.
    const wanted = Math.max(MERGE.alignFloor, vLead - 2);
    sim.constrain(i, Math.max(-params.b, Math.min(params.aMax, (wanted - v) / 1.2)));
  }
}

/**
 * A lane that ends presents a standing obstacle, but only once it is close enough
 * to matter. Outside 1.5x stopping distance the vehicle ignores it entirely and
 * keeps accelerating, which is exactly what an acceleration lane is for.
 */
export function applySoftWall(sim: Simulation, i: number): void {
  const store = sim.store;
  const mergeLane = store.mergeLane[i];
  // Only a lane that physically ends is a wall. A route that needs a lane change
  // has a deadline, not an obstacle: missing an exit costs you a detour, it must
  // never stop you dead in a live traffic lane.
  if (mergeLane < 0 || sim.net.lanes[mergeLane].endsAt === Infinity) return;
  const remaining = store.mergeRemaining[i];
  if (!Number.isFinite(remaining)) return;

  const v = store.v[i];
  const params = sim.paramsOf(i, _pSelf);
  const engage = MERGE.wallEngage * stoppingDistance(v, params.b) + IDM.s0 * 2;
  if (remaining > engage) return;

  // A driver with a gap lined up does not brake for the lane end - they accelerate
  // into it. So while a gap is selected and there is still room for a hard stop,
  // the wall is ignored outright; inside that distance it applies in full.
  if (store.gapOk[i] && remaining > stoppingDistance(v, IDM.bMax) + IDM.s0 * 2) return;

  const distance = Math.max(0.1, remaining - IDM.s0 * 0.5);
  let accel = idmAccel(v, sim.desiredSpeedOf(i), distance, v, params);
  // Ease off toward the lane end, do not panic-stop at it: outside the creep zone
  // the wall may only ask for comfortable braking. A merger that slams to a halt
  // then forces its way in is exactly the behaviour this whole model exists to
  // avoid, and it shows up downstream as a shockwave in the mainline.
  if (remaining > MERGE.creepZone) accel = Math.max(accel, -params.b);
  sim.constrain(i, accel);
}

/** Decides which mainline vehicles open a gap, and records it for the accel pass. */
export function assignCooperation(sim: Simulation, i: number): void {
  const store = sim.store;
  const lag = store.gapLag[i];
  if (lag < 0 || !store.alive[lag]) return;
  const urgency = store.urgency[i];
  // Courtesy becomes compulsory only for a driver whose lane runs out of tarmac.
  // Somebody on an acceleration lane has nowhere else to be, so the traffic beside
  // them has to make room; somebody trying to reach an exit is asking a favour, and
  // a favour can be refused. That difference is the whole reason a driver can miss
  // an exit at all — with compulsory courtesy everywhere, the mainline always opens
  // up and nobody ever misses one, however solid the traffic.
  const laneEnds = store.mergeLane[i] >= 0 && sim.net.lanes[store.mergeLane[i]].endsAt < Infinity;
  const mandatory = laneEnds && urgency >= MERGE.mandatoryCourtesy;
  const willing = mandatory || store.courtesy[lag] < DRIVER_COURTESY_BASE + 0.3 * urgency;
  if (!willing) return;

  const current = store.cooperateWith[lag];
  if (current >= 0 && store.alive[current] && store.urgency[current] > urgency) return;
  store.cooperateWith[lag] = i;
}

const DRIVER_COURTESY_BASE = 0.7;


/** The yielding half of cooperation: open up for the merger we agreed to let in. */
export function applyCooperation(sim: Simulation, j: number): void {
  const store = sim.store;
  const m = store.cooperateWith[j];
  if (m < 0 || !store.alive[m]) return;
  // Courtesy has limits: a driver who has been crawling this long to let somebody
  // in has done their share.
  if (store.crawlTime[j] > MERGE.alignGiveUp) return;
  // Note: it is tempting to release the commitment once the merger has run out of
  // patience — they are about to take any hole anyway — and it makes things much
  // worse. They lose the gap that was being opened *and* the alignment that was
  // getting them to it, and end up stuck beside a space they can no longer reach.
  const refU = sim.mergeRefU[m];
  if (!Number.isFinite(refU)) return;

  const dMe = refU - sim.uOf(j);
  const dMerger = store.mergeRemaining[m];
  const gap = dMe - dMerger - store.len[m];
  if (gap <= 0) return; // the merger is already behind us

  const params = sim.paramsOf(j, _pSelf);
  // Hold back with a shorter headway than normal following: the point is to leave
  // a merger-sized hole, not to open half a block.
  params.T *= MERGE.courtesyHeadway;
  const accel = idmAccel(store.v[j], sim.desiredSpeedOf(j), gap, store.v[j] - store.v[m], params);
  // Courtesy is a favour, not an emergency. Even when yielding becomes mandatory it
  // stays a firm-but-comfortable brake, because a wall of hard braking on the
  // mainline costs more capacity than the merge gains.
  const floor = store.urgency[m] >= MERGE.mandatoryCourtesy
    ? -MERGE.courtesyDecelMandatory : -MERGE.courtesyDecel;
  sim.constrain(j, Math.max(accel, floor));
}

export interface ChangeCheck {
  allowed: boolean;
  /** Vehicle to splice in behind on the target lane, -1 to become its leader. */
  aheadId: number;
  targetS: number;
  /** Set when only the creep or stuck fallback let this through. */
  forced: boolean;
  /** Vehicle approaching from the lane upstream, when one constrains the gap. */
  lagAcross: number;
  /** Vehicle just past the lane downstream, when one constrains the gap. */
  leadAcross: number;
  /** Space in front of and behind the insertion point, as actually measured. */
  gapFront: number;
  gapBack: number;
}

/**
 * Scratch for the two boundary walks below. `at` is a position in the target
 * lane's own coordinate — negative for something upstream of its start, positive
 * for something beyond a point downstream — so "nearest" is the *largest* value
 * going up and the *smallest* going down.
 */
const _up = { id: -1, at: 0 };
const BOUNDARY_HOPS = 3;

/**
 * The nearest vehicle upstream of the start of `lane`, however many lanes back
 * that is.
 *
 * One hop used to be enough, and is not. A junction connector can be twenty metres
 * long, which at motorway speed is two thirds of a second: the lane immediately
 * upstream is empty, the driver closing at 28 m/s is one lane further back still,
 * and a cut-in at the head of the lane lands in front of somebody who then cannot
 * physically stop — they brake at the emergency cap for the whole connector and
 * still arrive inside the gap. So the walk carries on through *empty* predecessors
 * until it has covered `reach` metres of road, which is the distance that actually
 * matters rather than a count of lanes that happens to be one.
 *
 * `offset` is how far the start of `lane` is upstream of the target lane's start.
 * A vehicle's routed next edge has to lead back down the chain we came up, or it
 * is somebody who will turn off before reaching us.
 */
function lookUpstream(sim: Simulation, lane: Lane, offset: number, reach: number, depth: number): void {
  if (reach <= 0 || depth > BOUNDARY_HOPS) return;
  const store = sim.store;
  for (const p of lane.predecessors) {
    const pl = sim.net.lanes[p];
    const head = store.laneFirst[p];
    if (head >= 0) {
      if (sim.nextEdge[head] !== lane.id) continue;
      // Negative: how far behind the target lane's start this vehicle's nose is.
      const behind = store.s[head] - pl.length - offset;
      if (behind < _up.at) continue; // nearest is the least negative
      _up.at = behind;
      _up.id = head;
      continue;
    }
    // Empty: keep going back, if there is any road left worth looking at.
    lookUpstream(sim, pl, offset + pl.length, reach - pl.length, depth + 1);
  }
}

/** The mirror image: the nearest vehicle downstream of the end of `lane`. */
function lookDownstream(sim: Simulation, lane: Lane, offset: number, reach: number, depth: number): void {
  if (reach <= 0 || depth > BOUNDARY_HOPS) return;
  const store = sim.store;
  for (const sId of lane.successors) {
    const sl = sim.net.lanes[sId];
    const tail = store.laneLast[sId];
    if (tail >= 0) {
      const ahead = offset + store.s[tail] - store.len[tail];
      if (ahead > _up.at) continue;
      _up.at = ahead;
      _up.id = tail;
      continue;
    }
    lookDownstream(sim, sl, offset + sl.length, reach - sl.length, depth + 1);
  }
}

const _check: ChangeCheck = {
  allowed: false, aheadId: -1, targetS: 0, forced: false, lagAcross: -1, leadAcross: -1,
  gapFront: 0, gapBack: 0,
};

/**
 * Whether this vehicle may move into `targetLaneId` right now.
 *
 * The collision floor is checked in every branch and never relaxed. Urgency, the
 * creep zone and the stuck fallback only change how *large* a gap is demanded, not
 * whether the move would cause a crash.
 */
export function checkChange(
  sim: Simulation, i: number, targetLaneId: number, mandatory: boolean,
): ChangeCheck {
  const store = sim.store;
  const net = sim.net;
  _check.allowed = false;
  _check.aheadId = -1;
  _check.forced = false;
  _check.lagAcross = -1;
  _check.leadAcross = -1;
  _check.gapFront = 0;
  _check.gapBack = 0;

  const from = net.lanes[store.lane[i]];
  const target = net.lanes[targetLaneId];
  if (from.segmentId < 0 || from.segmentId !== target.segmentId) return _check;

  const targetS = mapS(from, store.s[i], target);
  _check.targetS = targetS;
  const targetEnd = target.endsAt === Infinity ? target.length : target.endsAt;
  if (targetS < target.startsAt - 0.5 || targetS > targetEnd + 0.5) return _check;

  const hint = target.id === from.left ? store.leftLead[i] : store.rightLead[i];
  const lead = store.findAhead(targetLaneId, targetS, hint);
  // With no vehicle ahead we would become the lane's leader, so the vehicle behind
  // us is its current *head*, not its tail.
  const lag = lead >= 0 ? store.behind[lead] : store.laneFirst[targetLaneId];
  _check.aheadId = lead;

  const myLen = store.len[i];
  let gapFront = lead >= 0 ? store.s[lead] - store.len[lead] - targetS : Infinity;
  let gapBack = lag >= 0 ? targetS - myLen - store.s[lag] : Infinity;

  // Traffic about to cross in from upstream is invisible to the lane's own list,
  // and dropping in front of it is exactly how a merge causes a collision.
  if (lag < 0 && targetS < BOUNDARY_LOOK) {
    _up.id = -1;
    _up.at = -Infinity;
    lookUpstream(sim, target, 0, BOUNDARY_LOOK - targetS, 0);
    if (_up.id >= 0) {
      const g = targetS - myLen - _up.at;
      if (g < gapBack) {
        gapBack = g;
        _check.lagAcross = _up.id;
      }
    }
  }
  if (lead < 0 && targetEnd - targetS < BOUNDARY_LOOK) {
    _up.id = -1;
    _up.at = Infinity;
    lookDownstream(sim, target, target.length, BOUNDARY_LOOK, 0);
    if (_up.id >= 0) {
      const g = _up.at - targetS;
      if (g < gapFront) {
        gapFront = g;
        _check.leadAcross = _up.id;
      }
    }
  }
  _check.gapFront = gapFront;
  _check.gapBack = gapBack;
  if (gapFront < MIN_PHYSICAL_GAP || gapBack < MIN_PHYSICAL_GAP) return _check;

  const v = store.v[i];
  const params = sim.paramsOf(i, _pSelf);
  const lagVehicle = lag >= 0 ? lag : _check.lagAcross;
  const leadVehicle = lead >= 0 ? lead : _check.leadAcross;
  const vLead = leadVehicle >= 0 ? store.v[leadVehicle] : v;
  const vLag = lagVehicle >= 0 ? store.v[lagVehicle] : v;

  // Collision floor. Normally the follower must be able to cope using comfortable
  // braking; for a driver who has been stuck at a lane end this long, the standard
  // drops to what the follower can *physically* do. That is the line this model
  // draws: nobody is ever permanently stuck, and nobody is ever asked to do the
  // impossible.
  // The last resort — accepting a gap the follower can only *physically* stop for —
  // belongs to a lane that runs out of tarmac, where there is no alternative to
  // getting in. A driver who is late for an exit has one: carry on and come back.
  // Letting them force their way across anyway is how a missed exit becomes a
  // shockwave, and it is also why nobody in this model ever missed one.
  const mergeLane = store.mergeLane[i];
  const laneEnds = mergeLane >= 0 && net.lanes[mergeLane].endsAt < Infinity;
  const desperate = mandatory && laneEnds && noProgress(store, i) >= MERGE.stuckTimeout;
  const collisionFloor = desperate ? IDM.bMax * 0.9 : MOBIL.bSafe;
  if (lagVehicle >= 0 && !safeToInsert(vLag, v, gapBack, collisionFloor)) return _check;
  if (leadVehicle >= 0 && !safeToInsert(v, vLead, gapFront, collisionFloor)) return _check;

  // Comfort criterion: nobody chooses to dive into a gap that would make the driver
  // behind brake hard. It gates discretionary changes outright, and is one of the
  // ways a mandatory change can be accepted.
  let comfortable = true;
  if (lagVehicle >= 0) {
    const lagParams = sim.paramsOf(lagVehicle, _pOther);
    if (idmAccel(vLag, sim.desiredSpeedOf(lagVehicle), gapBack, vLag - v, lagParams) < -MOBIL.bCourteous) {
      comfortable = false;
    }
  }
  if (comfortable && leadVehicle >= 0 &&
      idmAccel(v, sim.desiredSpeedOf(i), gapFront, v - vLead, params) < -MOBIL.bCourteous) {
    comfortable = false;
  }

  if (!mandatory) {
    _check.allowed = comfortable;
    return _check;
  }

  const urgency = store.urgency[i];

  // Speed synchronisation. With road left, keep accelerating rather than slotting
  // in well below the speed of the lane we are joining. Urgency relaxes it, and it
  // never gates the fallbacks below - a driver who cannot match speed must still be
  // able to get in, or "stuck at a lane end" becomes reachable again.
  const nearLead = leadVehicle >= 0 && gapFront < 100;
  const nearLag = lagVehicle >= 0 && gapBack < 100;
  const tolerance = MERGE.speedMatchTolerance + urgency * MERGE.speedMatchRelief;
  const speedMatched = !(nearLead || nearLag) ||
    Math.abs(v - (nearLead ? vLead : vLag)) <= tolerance;

  // Accepted gaps start from the comfortable IDM value and shrink toward - but
  // never past - the physical minimum as urgency rises. A mandatory change is also
  // never *harder* to make than a discretionary one, hence the comfort branch.
  const wantFront = lerpToward(desiredGap(v, v - vLead, params), IDM.s0, urgency);
  const wantBack = lerpToward(
    desiredGap(vLag, vLag - v, lagVehicle >= 0 ? sim.paramsOf(lagVehicle, _pOther) : params),
    IDM.s0, urgency,
  );
  if (speedMatched && (comfortable || (gapFront >= wantFront && gapBack >= wantBack))) {
    _check.allowed = true;
    return _check;
  }

  // Fallbacks. Two ways to take a small gap: creep in at the very end of the lane,
  // or - in stop-and-go traffic - take any hole at walking pace anywhere along it,
  // which is what drivers do and what stops the whole auxiliary lane going to waste.
  const remaining = store.mergeRemaining[i];
  const crawling = v <= MERGE.creepSpeed && vLag <= MERGE.creepSpeed * 2;
  const creeping = crawling || (remaining <= MERGE.creepZone && v <= MERGE.creepSpeed);
  // Out of patience: either getting nowhere, or simply refused for long enough.
  const stuck = laneEnds
    && (noProgress(store, i) >= MERGE.stuckTimeout || store.mergeWait[i] >= MERGE.patience);
  if (creeping || stuck) {
    const margin = stuck ? 1.0 : 0.8;
    // Even here, do not nose in front of traffic that would have to brake hard for
    // it. `stuck` is the anti-deadlock last resort and gets the full allowance.
    const brakeLimit = stuck ? collisionFloor : MERGE.creepBrake;
    const politeEnough = lagVehicle < 0 || safeToInsert(vLag, v, gapBack, brakeLimit);
    if (gapFront >= margin && gapBack >= margin && politeEnough) {
      _check.allowed = true;
      _check.forced = true;
    }
  }
  return _check;
}

// --- zipper -------------------------------------------------------------------
//
// In free flow, alternating admission emerges on its own from gap seeking. In a jam
// it has to be enforced, or whichever stream happens to be moving takes everything.
// Each ending lane keeps a turn flag: the mainline gets one vehicle through, then
// the merging lane does.

export const ZipperTurn = { Ending: 0, Through: 1 } as const;

/** Measures congestion at each taper and refreshes the turn flags. */
export function updateZipper(sim: Simulation): void {
  const store = sim.store;
  for (let k = 0; k < sim.endingLanes.length; k++) {
    const laneId = sim.endingLanes[k];
    const lane = sim.net.lanes[laneId];
    const target = lane.mergeTarget;
    if (target < 0) continue;

    let sum = 0;
    let n = 0;
    const end = lane.endsAt === Infinity ? lane.length : lane.endsAt;
    for (let a = store.laneFirst[laneId]; a >= 0; a = store.behind[a]) {
      if (end - store.s[a] > MERGE.zipperWindow) break;
      sum += store.v[a];
      n++;
    }
    const refS = sim.mergeRefOnTarget[laneId];
    for (let a = store.laneFirst[target]; a >= 0; a = store.behind[a]) {
      const d = refS - store.s[a];
      if (d < 0) continue;               // already through the merge
      if (d > MERGE.zipperWindow) break; // too far upstream to matter
      sum += store.v[a];
      n++;
    }
    const threshold = Math.min(
      MERGE.zipperSpeedMax,
      MERGE.zipperSpeedFraction * sim.net.lanes[target].speedLimit,
    );
    sim.zipperCongested[laneId] = n >= 3 && sum / n < threshold ? 1 : 0;
  }
}

/** True when it is the merging lane's turn (or the taper is not congested). */
export function zipperAllows(sim: Simulation, endingLaneId: number): boolean {
  if (!sim.zipperCongested[endingLaneId]) return true;
  return sim.zipperTurn[endingLaneId] === ZipperTurn.Ending;
}

export function noteZipperAdmission(sim: Simulation, endingLaneId: number): void {
  sim.zipperTurn[endingLaneId] = ZipperTurn.Through;
}

export function noteThroughPassed(sim: Simulation, endingLaneId: number): void {
  sim.zipperTurn[endingLaneId] = ZipperTurn.Ending;
}

/**
 * Extra MOBIL incentive for mainline traffic to leave the lane an on-ramp feeds
 * into. Cheap for them, and it is what turns a wall of kerb-lane traffic into a
 * lane with holes in it before the mergers even arrive.
 */
export function keepClearBias(sim: Simulation, j: number, toLeft: boolean): number {
  const laneId = sim.store.lane[j];
  const pressure = sim.mergePressure[laneId];
  if (pressure <= 0) return 0;
  const lane = sim.net.lanes[laneId];
  // Only helps if moving away from the side the ramp is on.
  const auxIsRight = lane.right >= 0 && sim.net.lanes[lane.right].aux;
  if (auxIsRight !== toLeft) return 0;
  // Inside a queue, shuffling lanes helps nobody and costs discharge rate.
  if (sim.store.v[j] < MERGE.keepClearMinSpeedFraction * sim.desiredSpeedOf(j)) return 0;
  return MERGE.keepClearBias * Math.min(1, pressure / MERGE.keepClearSaturation);
}
