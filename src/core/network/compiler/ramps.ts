/**
 * Compile step 7: ramp synthesis.
 *
 * This is where the flagship merge behaviour gets its geometry. A ramp meeting a
 * road at a shallow angle does not split that road; instead the road grows an
 * auxiliary lane — an acceleration lane downstream of an on-ramp gore, or a
 * deceleration lane upstream of an off-ramp gore — and the ramp connects into it.
 * The gore itself is found by intersecting the ramp centreline with the auxiliary
 * lane centreline, which is exactly where the two carriageways become one.
 *
 * Overlapping on-ramp and off-ramp auxiliary lanes fuse into a single weaving lane.
 */

import { offsetPolyline } from '../../geom/offset';
import { samplePosition, sampleTangent } from '../../geom/polyline';
import { segmentIntersect, makeSegHit } from '../../geom/intersect';
import { rampSpecOf } from '../model';
import { auxAttachment, auxCenterOffset } from './layout';
import type { Diagnostic } from '../types';
import type { Meeting } from './crossings';
import type { PreparedStroke } from './prepare';

export interface RampPlan {
  kind: 'merge' | 'diverge';
  meeting: Meeting;
  roadStrokeIdx: number;
  rampStrokeIdx: number;
  /** Direction group of the road that this ramp serves. */
  roadSide: 1 | -1;
  /** Direction group of the ramp that carries the flow. */
  rampSide: 1 | -1;
  /** +1 when the ramp's end touches the road, -1 when its start does. */
  rampEnd: 1 | -1;
  /** Stroke arc-length on the road where the ramp centreline meets the aux lane. */
  sGoreRoad: number;
  /** Stroke arc-length on the ramp where the ramp segment must stop. */
  rampCutS: number;
  auxOffset: number;
  /** Unit direction in offset space pointing away from the carriageway. */
  auxDir: number;
  auxWidth: number;
  /** Lanes the ramp carries in its flow direction: one auxiliary lane each. */
  rampLanes: number;
  /**
   * Diverge only: the kerb-side through lane is one of the lanes feeding the exit,
   * so the ramp needs one auxiliary lane fewer — down to a floor of one, which is
   * what keeps a one-lane exit's deceleration lane.
   */
  optionLane: boolean;
  /**
   * Merge only: the innermost lane the ramp brings in stays on the highway as a new
   * through lane instead of tapering away, so the road simply gets wider after the
   * entrance and keeps that width to the end of the road.
   */
  /** How many of this ramp's lanes stay on the highway. */
  addedLanes: number;
  bodyLength: number;
  taperLength: number;
  /** Angle between ramp and road at the gore, radians. */
  angle: number;
}

export interface AuxLanePlan {
  id: number;
  roadStrokeIdx: number;
  side: 1 | -1;
  depth: number;
  offset: number;
  /** Unit direction in offset space pointing away from the carriageway. */
  dir: number;
  width: number;
  /** Stroke arc-length bounds, lo <= hi. */
  lo: number;
  hi: number;
  /** +1 when traffic on this lane travels toward increasing stroke arc-length. */
  flowSign: 1 | -1;
  /** Taper length at the flow-entry end (0 = starts at full width). */
  taperIn: number;
  /** Taper length at the flow-exit end (0 = ends at full width). */
  taperOut: number;
  /** Vehicles must merge out of this lane before it ends. */
  endsWithMerge: boolean;
  /**
   * This lane is now part of the highway and never ends, so there is nothing to
   * merge into — unlike a deceleration lane, which also does not end with a merge
   * but does want somewhere to go for a driver who changes their mind.
   */
  permanent: boolean;
  mergeFrom: RampPlan | null;
  divergeTo: RampPlan | null;
}

const _p = { x: 0, y: 0 };
const _t = { x: 0, y: 0 };
const _hit = makeSegHit();

/** Length of the blend curve between a ramp end and its auxiliary lane. */
function blendLength(angle: number): number {
  return Math.min(45, Math.max(8, 8 + 70 * Math.sin(angle)));
}

/**
 * Finds where the ramp centreline crosses the auxiliary lane centreline.
 * Returns null when they never meet (a ramp that stops short of the carriageway);
 * callers then fall back to the raw meeting point.
 */
function findGore(
  road: PreparedStroke, ramp: PreparedStroke, auxOffset: number, rampEnd: 1 | -1,
): { roadS: number; rampS: number } | null {
  const off = offsetPolyline(road.points, road.arclength, auxOffset);
  const on = off.points;
  const rampPts = ramp.points;
  const rn = rampPts.length >> 1;
  const on2 = on.length >> 1;

  let best: { roadS: number; rampS: number; key: number } | null = null;
  for (let i = 0; i < rn - 1; i++) {
    const ax = rampPts[i * 2], ay = rampPts[i * 2 + 1];
    const bx = rampPts[i * 2 + 2], by = rampPts[i * 2 + 3];
    for (let j = 0; j < on2 - 1; j++) {
      if (!segmentIntersect(ax, ay, bx, by, on[j * 2], on[j * 2 + 1], on[j * 2 + 2], on[j * 2 + 3], _hit)) {
        continue;
      }
      const rampS = ramp.arclength[i] + (ramp.arclength[i + 1] - ramp.arclength[i]) * _hit.t;
      const roadS = off.sourceS[j] + (off.sourceS[j + 1] - off.sourceS[j]) * _hit.u;
      // Prefer the crossing nearest the ramp end that touches the road.
      const key = rampEnd === 1 ? -rampS : rampS;
      if (!best || key < best.key) best = { roadS, rampS, key };
    }
  }
  return best ? { roadS: best.roadS, rampS: best.rampS } : null;
}

/** Signed lateral offset (positive = right of the stroke) of `pt` from stroke point at `s`. */
function lateralOf(road: PreparedStroke, s: number, px: number, py: number): number {
  samplePosition(road.points, road.arclength, s, _p);
  sampleTangent(road.points, road.arclength, s, _t);
  return _t.x * (py - _p.y) - _t.y * (px - _p.x);
}

export function planRamps(
  strokes: PreparedStroke[], meetings: Meeting[], driveOnRight: boolean,
): { plans: RampPlan[]; diagnostics: Diagnostic[] } {
  const plans: RampPlan[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const meeting of meetings) {
    if (meeting.kind !== 'merge' && meeting.kind !== 'diverge') continue;
    const roadPart = meeting.participants[meeting.roadIdx];
    const rampPart = meeting.participants[meeting.rampIdx];
    const road = strokes[roadPart.strokeIdx];
    const ramp = strokes[rampPart.strokeIdx];
    const rampEnd: 1 | -1 = rampPart.end === 1 ? 1 : -1;
    const isMerge = meeting.kind === 'merge';

    // Direction the ramp traffic travels at the junction.
    const flowDirSign = isMerge ? (rampEnd === 1 ? 1 : -1) : (rampEnd === -1 ? 1 : -1);
    const dx = rampPart.tx * flowDirSign;
    const dy = rampPart.ty * flowDirSign;
    const roadSide: 1 | -1 = dx * roadPart.tx + dy * roadPart.ty >= 0 ? 1 : -1;
    const rampSide: 1 | -1 = flowDirSign === 1 ? 1 : -1;

    if ((rampSide === 1 ? ramp.profile.lanesForward : ramp.profile.lanesBackward) === 0) continue;
    if ((roadSide === 1 ? road.profile.lanesForward : road.profile.lanesBackward) === 0) {
      diagnostics.push({
        severity: 'error', code: 'ramp-wrong-direction',
        message: 'Ramp joins a road that carries no traffic in that direction.',
        x: meeting.x, y: meeting.y, strokeId: ramp.stroke.id,
      });
      continue;
    }

    // Which side of the road does the ramp approach from?
    const probeDist = Math.min(ramp.length * 0.5, 45);
    const probeS = rampEnd === 1 ? ramp.length - probeDist : probeDist;
    samplePosition(ramp.points, ramp.arclength, probeS, _p);
    const preferSign = Math.sign(lateralOf(road, roadPart.s, _p.x, _p.y));

    const att = auxAttachment(road.profile, roadSide, driveOnRight, preferSign);
    if (!att.onPreferredSide) {
      diagnostics.push({
        severity: 'warning', code: 'ramp-median-side',
        message: 'Ramp approaches from the median side; the auxiliary lane was placed kerb-side instead.',
        x: meeting.x, y: meeting.y, strokeId: ramp.stroke.id,
      });
    }
    const auxWidth = road.profile.laneWidth;
    const auxOffset = auxCenterOffset(att, auxWidth, 0);

    const gore = findGore(road, ramp, auxOffset, rampEnd);
    const sGoreRoad = gore ? gore.roadS : roadPart.s;
    const angle = Math.acos(Math.min(1, Math.abs(dx * roadPart.tx + dy * roadPart.ty)));
    const blend = blendLength(angle);
    const rampMeetS = gore ? gore.rampS : rampPart.s;
    // The ramp's own surface has to stop where its near edge clears the road's
    // outer edge — auxiliary lanes and shoulder included — or its paint runs across
    // the road's. The blend length alone is a heuristic in metres that knows the
    // angle and nothing about widths, and a two-lane ramp joining at ten degrees
    // was cut with its edge line still three and a half metres inside the freeway.
    // Never shorter than the blend, so a one-lane ramp at an ordinary angle is
    // exactly as it was.
    const rampLanesHere = Math.max(1, rampSide === 1 ? ramp.profile.lanesForward : ramp.profile.lanesBackward);
    const auxReach = auxWidth * (rampLanesHere - 0.5) + road.profile.shoulder;
    const clearance = (ramp.halfWidth + auxReach) / Math.max(Math.sin(angle), 0.2) + 1;
    const cut = Math.max(blend, clearance);
    const rampCutS = rampEnd === 1
      ? Math.max(0, rampMeetS - cut)
      : Math.min(ramp.length, rampMeetS + cut);

    const spec = rampSpecOf(ramp.profile.isRamp ? ramp.profile : road.profile);
    plans.push({
      kind: meeting.kind,
      meeting,
      roadStrokeIdx: roadPart.strokeIdx,
      rampStrokeIdx: rampPart.strokeIdx,
      roadSide,
      rampSide,
      rampEnd,
      sGoreRoad,
      rampCutS,
      auxOffset,
      auxDir: att.dir,
      auxWidth,
      rampLanes: Math.max(1, rampSide === 1
        ? ramp.profile.lanesForward : ramp.profile.lanesBackward),
      optionLane: false,
      addedLanes: 0,
      bodyLength: isMerge ? spec.accelLaneLength : spec.decelLaneLength,
      taperLength: spec.taperLength,
      angle,
    });
  }

  plans.sort((a, b) =>
    a.roadStrokeIdx - b.roadStrokeIdx || a.sGoreRoad - b.sGoreRoad || a.rampStrokeIdx - b.rampStrokeIdx);
  return { plans, diagnostics };
}

/**
 * Turns ramp plans into the auxiliary lanes the road actually grows.
 *
 * Two rules matter here:
 *  - an on-ramp lane and a following off-ramp lane that overlap fuse into a single
 *    weaving lane, which still ends at the off-ramp gore so through traffic must
 *    either exit or merge left;
 *  - otherwise overlapping auxiliary lanes stack outward (depth 1, 2, ...).
 */
/**
 * Where the road stops being a plain continuation, downstream of this ramp's gore,
 * or null if it runs clear to the end.
 *
 * An added lane can only stay on the highway for as long as the highway is one
 * uninterrupted stretch. A junction ends the segment, and an option lane splits it;
 * either way an auxiliary lane cannot cross, because the cross-section is mapped by
 * lane index and the far side has no lane at that index to map onto. Left to run
 * into one anyway it simply stops, and because it stops with nowhere to go it turns
 * into an exit portal — a hole in the middle of the road that traffic vanishes into.
 */
function nextInterruption(
  plans: RampPlan[], meetings: Meeting[], self: RampPlan, flowSign: 1 | -1,
): number | null {
  let best: number | null = null;
  const consider = (s: number): void => {
    const ahead = (s - self.sGoreRoad) * flowSign;
    if (ahead <= 0) return;
    if (best === null || ahead < (best - self.sGoreRoad) * flowSign) best = s;
  };
  for (const other of plans) {
    if (other === self || !other.optionLane) continue;
    if (other.roadStrokeIdx === self.roadStrokeIdx) consider(other.sGoreRoad);
  }
  for (const meeting of meetings) {
    if (meeting.kind === 'merge' || meeting.kind === 'diverge') continue;
    for (const p of meeting.participants) {
      if (p.strokeIdx !== self.roadStrokeIdx) continue;
      // A crossing eats the road either side of it; a link sits on the very end.
      consider(p.s - flowSign * (meeting.kind === 'crossing' ? p.trim : 0));
    }
  }
  return best;
}

export function planAuxLanes(
  plans: RampPlan[], strokes: PreparedStroke[], meetings: Meeting[], driveOnRight: boolean,
): { aux: AuxLanePlan[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const aux: AuxLanePlan[] = [];
  let nextId = 0;

  for (const plan of plans) {
    const road = strokes[plan.roadStrokeIdx];
    const flowSign: 1 | -1 = plan.roadSide;
    const span = plan.bodyLength + plan.taperLength;
    let lo: number;
    let hi: number;
    if (plan.kind === 'merge') {
      lo = flowSign === 1 ? plan.sGoreRoad : plan.sGoreRoad - span;
      hi = flowSign === 1 ? plan.sGoreRoad + span : plan.sGoreRoad;
    } else {
      lo = flowSign === 1 ? plan.sGoreRoad - span : plan.sGoreRoad;
      hi = flowSign === 1 ? plan.sGoreRoad : plan.sGoreRoad + span;
    }
    const clampedLo = Math.max(0, lo);
    const clampedHi = Math.min(road.length, hi);
    if (clampedHi - clampedLo < plan.taperLength + 10) {
      diagnostics.push({
        severity: 'warning', code: 'aux-lane-too-short',
        message: `Not enough road for a full ${plan.kind === 'merge' ? 'acceleration' : 'deceleration'} lane; it was shortened.`,
        x: plan.meeting.x, y: plan.meeting.y, strokeId: road.stroke.id,
      });
    }
    if (clampedHi - clampedLo < 5) {
      diagnostics.push({
        severity: 'error', code: 'aux-lane-impossible',
        message: 'Ramp is too close to the end of the road to build an auxiliary lane.',
        x: plan.meeting.x, y: plan.meeting.y, strokeId: road.stroke.id,
      });
      continue;
    }

    // A ramp gets one auxiliary lane per lane it carries, stacked outward. The
    // outer ones are staggered a taper's worth toward the gore, so the road grows
    // a lane at a time instead of jumping two lanes wide at one taper — which is
    // both what a two-lane exit looks like and the only way the lane that has not
    // appeared yet cannot be driven in.
    const att = auxAttachment(road.profile, plan.roadSide, driveOnRight, plan.auxDir);
    const goreAtLo = plan.kind === 'merge' ? flowSign === 1 : flowSign === -1;
    // With an option lane the through lane is one of the exit's feeders, so the ramp
    // needs one auxiliary lane fewer — but never none: a one-lane exit keeps its
    // deceleration lane, so a driver who commits early can still slow down out of
    // the way, and the option is a second way in rather than the only one.
    const wanted = plan.optionLane
      ? Math.max(1, plan.rampLanes - 1)
      : plan.rampLanes;
    for (let depth = 0; depth < wanted; depth++) {
      const inset = depth * plan.taperLength;
      // Only the innermost lane is added: on a two-lane entrance the outer lane
      // still merges into it, which is what a real two-lane entrance does. Making
      // both permanent would widen the freeway by the whole ramp.
      let permanent = depth < plan.addedLanes;
      let dLo = goreAtLo ? clampedLo : clampedLo + inset;
      let dHi = goreAtLo ? clampedHi - inset : clampedHi;
      // An added lane does not taper away: it runs to the end of the road, where a
      // link junction drops it if the next road is narrower. That is the difference
      // between "merge into the traffic" and "the freeway just got wider".
      //
      // It stops short of anything that splits the road, though — an option lane
      // further along does — because an auxiliary lane cannot cross a joint: the
      // cross-section mapping there is by lane index, and the two sides would have
      // to agree about a lane that only one of them has. So it merges away just
      // before the split instead, which is as far as it can honestly run.
      if (permanent) {
        const stop = nextInterruption(plans, meetings, plan, flowSign);
        const roadEnd = flowSign === 1 ? road.length : 0;
        const far = stop === null ? roadEnd : stop - flowSign * plan.taperLength;
        if (goreAtLo) dHi = Math.max(clampedLo + 5, Math.min(road.length, far));
        else dLo = Math.min(clampedHi - 5, Math.max(0, far));
        if (stop !== null) permanent = false;
      }
      if (dHi - dLo < 5) break;
      aux.push({
        id: nextId++,
        roadStrokeIdx: plan.roadStrokeIdx,
        side: plan.roadSide,
        depth,
        offset: auxCenterOffset(att, plan.auxWidth, depth),
        dir: plan.auxDir,
        width: plan.auxWidth,
        lo: dLo,
        hi: dHi,
        flowSign,
        taperIn: plan.kind === 'merge' ? 0 : plan.taperLength,
        taperOut: plan.kind === 'merge' && !permanent ? plan.taperLength : 0,
        endsWithMerge: plan.kind === 'merge' && !permanent,
        permanent,
        mergeFrom: plan.kind === 'merge' ? plan : null,
        divergeTo: plan.kind === 'diverge' ? plan : null,
      });
    }
  }

  // --- weaving fusion ---------------------------------------------------------
  // Whether to fuse is a decision about the whole *stack*, not about one lane in it.
  //
  // A two-lane ramp brings in a stack of auxiliary lanes, and they are deliberately
  // staggered so the road grows a lane at a time rather than two at once. That
  // stagger means a merge stack and a following diverge stack can overlap at one
  // depth and fall short at the next — and fusing only the depth that happens to
  // overlap leaves the cross-section incoherent: one continuous weaving lane
  // alongside two separate ones, which then asks the road to be split straight
  // through the fused lane. Measured on two-lane ramps 400 m apart, that wired the
  // on-ramp's outer lane to the off-ramp's deceleration lane 282 metres downstream
  // — one 282 m "blend" where every other one is 36 — and the traffic never
  // recovered: mean speed 9 m/s and vehicles stopped for five minutes at a time.
  //
  // So: if any depth of a pair of stacks overlaps, every matching depth fuses.
  const fusePairs = new Map<RampPlan, Set<RampPlan>>();
  for (const a of aux) {
    if (!a.mergeFrom || a.divergeTo) continue;
    for (const b of aux) {
      if (!b.divergeTo || b.mergeFrom) continue;
      if (a.roadStrokeIdx !== b.roadStrokeIdx || a.side !== b.side) continue;
      if (Math.sign(a.offset) !== Math.sign(b.offset)) continue;
      if (a.hi <= b.lo || b.hi <= a.lo) continue; // this depth does not overlap
      // The on-ramp must come first in the direction of travel.
      const entry = a.flowSign === 1 ? a.lo : a.hi;
      const exit = b.flowSign === 1 ? b.hi : b.lo;
      if ((exit - entry) * a.flowSign <= 0) continue;
      let set = fusePairs.get(a.mergeFrom);
      if (!set) fusePairs.set(a.mergeFrom, (set = new Set()));
      set.add(b.divergeTo);
    }
  }

  for (let i = 0; i < aux.length; i++) {
    const a = aux[i];
    if (!a.mergeFrom || a.divergeTo) continue;
    for (let j = 0; j < aux.length; j++) {
      const b = aux[j];
      if (i === j || !b.divergeTo || b.mergeFrom) continue;
      if (a.roadStrokeIdx !== b.roadStrokeIdx || a.side !== b.side) continue;
      if (Math.sign(a.offset) !== Math.sign(b.offset)) continue;
      if (a.depth !== b.depth) continue; // a stack fuses lane for lane
      if (!fusePairs.get(a.mergeFrom)?.has(b.divergeTo)) continue;
      const mergeEntry = a.flowSign === 1 ? a.lo : a.hi;
      const divergeExit = b.flowSign === 1 ? b.hi : b.lo;

      // A weaving lane is exactly the section between the two gores: it begins where
      // the entrance joins and ends where the exit leaves, and that is true however
      // close together they are.
      //
      // Taking the union of the two lanes' extents instead is the same answer
      // whenever there is room between the ramps — the acceleration lane has run out
      // before the exit's deceleration lane starts, so the union *is* gore to gore.
      // It stops being the same answer when they are close, and then it is wrong at
      // both ends. Connectors run lane-end to lane-start, so a fused lane reaching
      // past the exit makes the diverge connector swing back upstream to find the
      // ramp, and one starting before the entrance makes the merge connector reach
      // forward to find the lane. Measured on two-lane ramps 80 m apart: connectors
      // of 186 m and 113 m where the same pair 600 m apart gives 36 m, and 10% of
      // all drivers missing the exit because reaching it meant first driving two
      // hundred metres past it.
      a.lo = Math.min(mergeEntry, divergeExit);
      a.hi = Math.max(mergeEntry, divergeExit);
      a.taperOut = 0;
      a.divergeTo = b.divergeTo;
      a.endsWithMerge = true; // exit, or merge left before the gore
      aux.splice(j, 1);
      if (j < i) i--;
      j--;
    }
  }

  // --- stack any remaining overlaps outward -----------------------------------
  for (let i = 0; i < aux.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = aux[i];
      const b = aux[j];
      if (a.roadStrokeIdx !== b.roadStrokeIdx || a.side !== b.side) continue;
      if (Math.sign(a.offset - 0) !== Math.sign(b.offset - 0)) continue;
      if (a.depth !== b.depth) continue;
      if (a.hi <= b.lo || b.hi <= a.lo) continue;
      const road = strokes[a.roadStrokeIdx];
      const att = auxAttachment(road.profile, a.side, driveOnRight, a.dir);
      a.depth = b.depth + 1;
      a.offset = auxCenterOffset(att, a.width, a.depth);
      diagnostics.push({
        severity: 'info', code: 'stacked-aux-lane',
        message: 'Two ramps overlap on the same side; a second auxiliary lane was stacked outside the first.',
        x: a.mergeFrom?.meeting.x ?? a.divergeTo?.meeting.x,
        y: a.mergeFrom?.meeting.y ?? a.divergeTo?.meeting.y,
        strokeId: road.stroke.id,
      });
      j = -1; // re-check against everything at the new depth
    }
  }

  aux.sort((a, b) => a.roadStrokeIdx - b.roadStrokeIdx || a.lo - b.lo || a.depth - b.depth);
  return { aux, diagnostics };
}

/**
 * Where a road must be split because it carries two separate auxiliary lanes on the
 * same side.
 *
 * A lane has one lateral neighbour each way, so two auxiliary lanes sharing a slot
 * would have to share those links — and then the acceleration lane's merge target
 * ends up being the deceleration lane 500 m away, which nobody can reach. Splitting
 * the road in the gap between them gives each its own cross-section. The split is a
 * plain joint: the through lanes wire straight across it.
 */
export function auxSplitPoints(aux: ReadonlyArray<AuxLanePlan>): { strokeIdx: number; s: number }[] {
  const groups = new Map<string, AuxLanePlan[]>();
  for (const plan of aux) {
    const key = `${plan.roadStrokeIdx}|${plan.side}|${Math.sign(plan.dir)}|${plan.depth}`;
    const list = groups.get(key);
    if (list) list.push(plan);
    else groups.set(key, [plan]);
  }
  const out: { strokeIdx: number; s: number }[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.lo - b.lo);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].lo - sorted[i - 1].hi;
      if (gap <= 0) continue; // overlapping pairs are stacked or fused instead
      out.push({ strokeIdx: sorted[i].roadStrokeIdx, s: sorted[i - 1].hi + gap / 2 });
    }
  }
  out.sort((a, b) => a.strokeIdx - b.strokeIdx || a.s - b.s);
  return out;
}
