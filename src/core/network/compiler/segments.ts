/**
 * Compile steps 4, 6 and 7b: split strokes into segments and build lane geometry.
 *
 * Crossing junctions consume a slice of each stroke that passes through them;
 * merges and diverges consume nothing from the road they join (that is the whole
 * point — the mainline stays continuous) but do truncate the ramp at its gore.
 */

import { buildArclength, densify, polylineLength, sampleTangent, subPolyline } from '../../geom/polyline';
import { offsetPolyline, offsetPolylineVariable } from '../../geom/offset';
import { frontagesOf } from '../frontage';
import { profileHalfWidth } from '../model';
import { groupSign, halfCarriageway, layoutProfile, lanesOnSide } from './layout';
import type { Diagnostic, Lane, Marking, Segment } from '../types';
import { LaneKind, TurnKind } from '../types';
import type { Meeting } from './crossings';
import type { AuxLanePlan } from './ramps';
import type { EndTransition, TransitionPlan } from './links';
import type { TurnLanePlan } from './turnLanes';
import { transitionKey } from './links';
import type { PreparedStroke } from './prepare';

/** Shortest segment the compiler will emit between two junctions. */
export const MIN_SEGMENT_LENGTH = 4;

export interface SegmentRange {
  strokeIdx: number;
  s0: number;
  s1: number;
  /** Index into `meetings` bounding each end, or -1 for a free end. */
  startMeeting: number;
  endMeeting: number;
}

interface Blocked {
  lo: number;
  hi: number;
  meeting: number;
}

/**
 * Arc-lengths where a stroke changes level, so each segment sits on one layer.
 *
 * A road that ramps from ground to bridge is drawn in two stacks with the join
 * where it passes the halfway mark — which is where the abutment would be.
 */
export function gradeSplitPoints(
  strokes: PreparedStroke[],
): { strokeIdx: number; s: number }[] {
  const out: { strokeIdx: number; s: number }[] = [];
  for (const stroke of strokes) {
    const cps = stroke.stroke.points;
    for (let i = 0; i + 1 < cps.length && i + 1 < stroke.cpArc.length; i++) {
      const from = cps[i].grade;
      const to = cps[i + 1].grade;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      // Every half-level the ramp passes through is a join between two layers.
      for (let k = Math.ceil(lo - 0.5); k <= Math.floor(hi + 0.5); k++) {
        const level = k + 0.5;
        if (level <= lo || level >= hi) continue;
        const t = (level - from) / (to - from);
        const s = stroke.cpArc[i] + (stroke.cpArc[i + 1] - stroke.cpArc[i]) * t;
        out.push({ strokeIdx: stroke.index, s });
      }
    }
  }
  return out;
}

/**
 * Works out which stretches of each stroke survive as road, and which junction
 * bounds each surviving end.
 */
export function planSegmentRanges(
  strokes: PreparedStroke[],
  meetings: Meeting[],
  rampCuts: ReadonlyArray<{ strokeIdx: number; s: number; keepBelow: boolean }>,
  splitPoints: ReadonlyArray<{ strokeIdx: number; s: number }> = [],
): { ranges: SegmentRange[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const ranges: SegmentRange[] = [];

  for (const stroke of strokes) {
    const blocked: Blocked[] = [];
    let lo = 0;
    let hi = stroke.length;

    for (let mi = 0; mi < meetings.length; mi++) {
      const meeting = meetings[mi];
      if (meeting.kind !== 'crossing') continue;
      for (const p of meeting.participants) {
        if (p.strokeIdx !== stroke.index) continue;
        blocked.push({
          lo: Math.max(0, p.s - p.trim),
          hi: Math.min(stroke.length, p.s + p.trim),
          meeting: mi,
        });
      }
    }

    for (const cut of rampCuts) {
      if (cut.strokeIdx !== stroke.index) continue;
      if (cut.keepBelow) hi = Math.min(hi, cut.s);
      else lo = Math.max(lo, cut.s);
    }

    blocked.sort((a, b) => a.lo - b.lo || a.hi - b.hi);

    // Push overlapping junction footprints apart so a real segment always fits.
    for (let i = 1; i < blocked.length; i++) {
      const prev = blocked[i - 1];
      const cur = blocked[i];
      if (prev.hi + MIN_SEGMENT_LENGTH <= cur.lo) continue;
      const mid = (prev.hi + cur.lo) * 0.5;
      prev.hi = mid - MIN_SEGMENT_LENGTH * 0.5;
      cur.lo = mid + MIN_SEGMENT_LENGTH * 0.5;
      diagnostics.push({
        severity: 'warning', code: 'junctions-too-close',
        message: 'Two junctions nearly overlap; their footprints were pulled apart.',
        x: meetings[cur.meeting].x, y: meetings[cur.meeting].y, strokeId: stroke.stroke.id,
      });
    }

    let cursor = lo;
    let prevMeeting = -1;
    for (const b of blocked) {
      if (b.hi <= lo || b.lo >= hi) continue;
      const end = Math.min(b.lo, hi);
      if (end - cursor >= MIN_SEGMENT_LENGTH) {
        ranges.push({ strokeIdx: stroke.index, s0: cursor, s1: end, startMeeting: prevMeeting, endMeeting: b.meeting });
      } else if (end - cursor > 0.05) {
        diagnostics.push({
          severity: 'warning', code: 'segment-too-short',
          message: 'A stretch of road between junctions was too short to keep and was dropped.',
          x: meetings[b.meeting].x, y: meetings[b.meeting].y, strokeId: stroke.stroke.id,
        });
      }
      cursor = Math.max(cursor, Math.min(b.hi, hi));
      prevMeeting = b.meeting;
    }
    if (hi - cursor >= MIN_SEGMENT_LENGTH) {
      ranges.push({ strokeIdx: stroke.index, s0: cursor, s1: hi, startMeeting: prevMeeting, endMeeting: -1 });
    } else if (hi - cursor > 0.05 && ranges.length && prevMeeting >= 0) {
      diagnostics.push({
        severity: 'warning', code: 'segment-too-short',
        message: 'The stretch of road after the last junction was too short to keep.',
        strokeId: stroke.stroke.id,
      });
    }
  }

  // Plain splits: no junction, no gap, the through lanes just wire across.
  for (const point of [...splitPoints].sort((a, b) => a.strokeIdx - b.strokeIdx || a.s - b.s)) {
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r.strokeIdx !== point.strokeIdx) continue;
      if (point.s <= r.s0 + MIN_SEGMENT_LENGTH || point.s >= r.s1 - MIN_SEGMENT_LENGTH) continue;
      ranges.splice(i + 1, 0, {
        strokeIdx: r.strokeIdx, s0: point.s, s1: r.s1,
        startMeeting: -1, endMeeting: r.endMeeting,
      });
      r.s1 = point.s;
      r.endMeeting = -1;
      break;
    }
  }

  ranges.sort((a, b) => a.strokeIdx - b.strokeIdx || a.s0 - b.s0);
  return { ranges, diagnostics };
}

export function makeLane(id: number, kind: LaneKind): Lane {
  return {
    id,
    kind,
    segmentId: -1,
    junctionId: -1,
    index: -1,
    side: 1,
    centerline: new Float32Array(0),
    arclength: new Float32Array(0),
    parentS: new Float32Array(0),
    length: 0,
    width: 3.5,
    offset: 0,
    speedLimit: 10,
    successors: [],
    predecessors: [],
    left: -1,
    right: -1,
    aux: false,
    startsAt: 0,
    endsAt: Infinity,
    mergeTarget: -1,
    conflicts: [],
    priorityRank: 0,
    turn: TurnKind.Straight,
    signalGroup: -1,
    yields: false,
  };
}

/**
 * Length of the painted nose at a gore: the short wedge where the carriageway
 * widens into (or narrows out of) an auxiliary lane that otherwise begins at full
 * width. Without it the asphalt steps out by a whole lane in one vertex, which is
 * both wrong and very obvious on screen.
 */
const _t = { x: 0, y: 0 };

/** Width of an auxiliary lane at segment arc-length `s`, honouring both tapers. */
function auxWidthAt(
  s: number, entryS: number, exitS: number, flowSign: number,
  width: number, taperIn: number, taperOut: number,
): number {
  let w = width;
  if (taperIn > 0) {
    const u = (s - entryS) * flowSign;
    if (u < taperIn) w = Math.min(w, width * Math.max(0, u / taperIn));
  }
  if (taperOut > 0) {
    const v = (exitS - s) * flowSign;
    if (v < taperOut) w = Math.min(w, width * Math.max(0, v / taperOut));
  }
  return w;
}

interface ActiveTransition {
  t: EndTransition;
  dir: 1 | -1;
  atS: number;
  taper: number;
}

interface AuxOnSegment {
  plan: AuxLanePlan;
  lo: number;
  hi: number;
  entryS: number;
  exitS: number;
}

/**
 * How far past the carriageway edge the auxiliary lanes are *painted* at `s`.
 *
 * Unlike the surface, the paint has no nose: at a gore the edge line runs straight
 * to the gore point and the ramp's own edge line takes over from there. Noseing the
 * line out over the surface's blend instead draws it diagonally across the gore,
 * cutting the corner the ramp is arriving on.
 */
function auxMarkExtentAt(list: AuxOnSegment[], dirSign: number, s: number): number {
  let ext = 0;
  for (const a of list) {
    if (Math.sign(a.plan.dir) !== dirSign) continue;
    if (s < a.lo || s > a.hi) continue;
    const w = auxWidthAt(
      s, a.entryS, a.exitS, a.plan.flowSign, a.plan.width, a.plan.taperIn, a.plan.taperOut,
    );
    if (w <= 0) continue;
    ext = Math.max(ext, a.plan.depth * a.plan.width + w);
  }
  return ext;
}

/** How far past the carriageway edge the auxiliary lanes reach at `s`, per side. */
function auxExtentAt(list: AuxOnSegment[], dirSign: number, s: number): number {
  let ext = 0;
  for (const a of list) {
    if (Math.sign(a.plan.dir) !== dirSign) continue;
    if (s < a.lo || s > a.hi) continue;
    const w = auxWidthAt(
      s, a.entryS, a.exitS, a.plan.flowSign, a.plan.width, a.plan.taperIn, a.plan.taperOut,
    );
    if (w <= 0) continue;
    ext = Math.max(ext, a.plan.depth * a.plan.width + w);
  }
  return ext;
}

function finishLane(
  lane: Lane, points: Float32Array, sourceS: Float32Array, side: 1 | -1,
): void {
  let pts = points;
  let par = sourceS;
  if (side === -1) {
    const n = points.length >> 1;
    const rp = new Float32Array(points.length);
    const rs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      rp[i * 2] = points[(n - 1 - i) * 2];
      rp[i * 2 + 1] = points[(n - 1 - i) * 2 + 1];
      rs[i] = sourceS[n - 1 - i];
    }
    pts = rp;
    par = rs;
  }
  lane.centerline = pts;
  lane.arclength = buildArclength(pts);
  lane.parentS = par;
  lane.length = lane.arclength.length ? lane.arclength[lane.arclength.length - 1] : 0;
  lane.side = side;
}

export interface BuiltSegments {
  segments: Segment[];
  /** Parallel to `segments`: the stroke range each one came from. */
  ranges: SegmentRange[];
  /** AuxLanePlan.id -> lane id. */
  auxLaneByPlan: Map<number, number>;
  diagnostics: Diagnostic[];
}

/**
 * Metres an auxiliary lane may run past its segment before that is worth saying.
 * Junction trims move by a few metres as bays are planned, and a taper that ends a
 * few metres inside the trim looks exactly like one that ends just outside it.
 */
const AUX_CLIP_TOLERANCE = 10;

export function buildSegments(
  strokes: PreparedStroke[],
  ranges: SegmentRange[],
  auxPlans: AuxLanePlan[],
  transitions: TransitionPlan[],
  turnLanes: TurnLanePlan[],
  driveOnRight: boolean,
  lanes: Lane[],
): BuiltSegments {
  const diagnostics: Diagnostic[] = [];
  const segments: Segment[] = [];
  const built: SegmentRange[] = [];
  const auxLaneByPlan = new Map<number, number>();

  for (let rangeIdx = 0; rangeIdx < ranges.length; rangeIdx++) {
    const range = ranges[rangeIdx];
    const stroke = strokes[range.strokeIdx];
    const profile = stroke.profile;
    const centerline = subPolyline(stroke.points, stroke.arclength, range.s0, range.s1);
    const arclength = buildArclength(centerline);
    const length = arclength[arclength.length - 1] ?? 0;
    if (length < MIN_SEGMENT_LENGTH * 0.5) continue;

    const segId = segments.length;
    const half = halfCarriageway(profile);

    // Auxiliary lanes that reach into this segment.
    const auxHere: AuxOnSegment[] = [];
    for (const plan of auxPlans) {
      if (plan.roadStrokeIdx !== range.strokeIdx) continue;
      const lo = Math.max(0, plan.lo - range.s0);
      const hi = Math.min(length, plan.hi - range.s0);
      if (hi - lo < 5) continue;
      const entryS = (plan.flowSign === 1 ? plan.lo : plan.hi) - range.s0;
      const exitS = (plan.flowSign === 1 ? plan.hi : plan.lo) - range.s0;
      // How far past this segment the lane wanted to go. A few metres is the end
      // of a taper landing inside the junction's trim, which changes nothing the
      // eye can see and is not worth a warning; tens of metres is a ramp drawn too
      // close to a crossing, which is.
      const overrun = Math.max(0, range.s0 - plan.lo, plan.hi - range.s1);
      if (overrun > AUX_CLIP_TOLERANCE) {
        diagnostics.push({
          severity: 'warning', code: 'aux-lane-clipped',
          message: `An auxiliary lane ran into a junction and was clipped short by ${overrun.toFixed(0)} m.`,
          strokeId: stroke.stroke.id,
        });
      }
      auxHere.push({ plan, lo, hi, entryS, exitS });
    }

    // --- cross-section transitions at link junctions ---------------------------
    const active: ActiveTransition[] = [];
    for (const tp of transitions) {
      if (tp.strokeIdx !== range.strokeIdx) continue;
      if (tp.atEnd === 1 && range.s1 < stroke.length - 0.5) continue;
      if (tp.atEnd === -1 && range.s0 > 0.5) continue;
      const taper = Math.min(tp.transition.taper, length * 0.8);
      if (taper < 1) continue;
      active.push({ t: tp.transition, dir: tp.atEnd, atS: tp.atEnd === 1 ? length : 0, taper });
    }
    const blend = (a: ActiveTransition, s: number): number => {
      const u = a.dir === 1 ? (s - (a.atS - a.taper)) / a.taper : (a.atS + a.taper - s) / a.taper;
      return u < 0 ? 0 : u > 1 ? 1 : u;
    };
    const laneOffsetAt = (baseOffset: number, key: string, s: number): number => {
      let off = baseOffset;
      for (const a of active) {
        const target = a.t.targets.get(key);
        if (target === undefined) continue;
        off += (target - baseOffset) * blend(a, s);
      }
      return off;
    };
    // --- left-turn pockets ------------------------------------------------------
    const pockets = turnLanes.filter((p) => p.rangeIdx === rangeIdx);
    /** How far the bay has opened at `s`, 0 upstream of the taper, full at the stop line. */
    const pocketWidthAt = (p: TurnLanePlan, s: number): number => {
      const d = p.atEnd ? length - s : s;
      if (d <= p.storage) return p.width;
      const u = (p.taper + p.storage - d) / p.taper;
      return u <= 0 ? 0 : u >= 1 ? p.width : p.width * u;
    };
    /**
     * How far a turning group's through lanes slide outward. Only the part of the
     * bay that could not come out of the median: run it down the median and the
     * carriageway barely moves.
     */
    const pocketShiftAt = (side: 1 | -1, s: number): number => {
      let shift = 0;
      for (const p of pockets) {
        // A kerb-side bay opens *outside* the through lanes, so they stay where they
        // are and only the asphalt grows. Sliding them for it would push the whole
        // carriageway into the median for no reason.
        if (p.kind !== 'left' || p.side !== side || p.width <= 0) continue;
        shift = Math.max(shift, (pocketWidthAt(p, s) * p.widen) / p.width);
      }
      return shift;
    };
    /** Inner edge of a bay at `s`: the median edge, retreating as the bay eats it. */
    const innerOfPocket = (p: TurnLanePlan, s: number): number => {
      const inShare = p.width > 0 ? p.fromMedian / p.width : 0;
      return pocketEdge(p, s) - groupSign(p.side, driveOnRight) * pocketWidthAt(p, s) * inShare;
    };
    /**
     * The edge a bay opens from: the group's median edge for a left bay, its kerb
     * edge for a right one. Everything else about the two is the same, which is why
     * a kerb-side bay is a parameter here rather than a second piece of machinery.
     *
     * The kerb edge is where the through lanes have been pushed *to*, not where they
     * started. An approach with both bays widens twice — the median bay slides the
     * through lanes out and the kerb bay opens beyond them — and reading the
     * unshifted kerb edge lands the kerb bay exactly on top of the outermost through
     * lane, which on a single-lane approach is the whole carriageway.
     */
    const pocketEdge = (p: TurnLanePlan, s: number): number => {
      const g = groupSign(p.side, driveOnRight);
      return p.kind === 'left'
        ? g * (half - lanesOnSide(profile, p.side) * profile.laneWidth)
        : g * (half + pocketShiftAt(p.side, s));
    };
    /**
     * How far the *asphalt* flares on one side, at `s`.
     *
     * A bay widens the road on its own group's kerb side, and on that side only:
     * the median does not move and neither does the opposing carriageway, whose
     * lanes are exactly where they were. Flaring both sides — on the argument that
     * the departing side is a receiving flare — lays a bay's width of asphalt down
     * the side of the road where nothing moved, for the whole length of the bay:
     * a two-metre ledge 85 m long at every approach that has one, which is most of
     * the "extra road" a junction appears to be made of. The two approaches of a
     * through road flare opposite kerbs, so the kerb line steps as it passes the
     * junction, which is what a real one does; the corner radius takes the step.
     *
     * Bays on the *same* group stack outward and their widenings add.
     */
    const pocketFlareAt = (dirSign: number, s: number): number => {
      let sum = 0;
      for (const p of pockets) {
        if (p.width <= 0 || groupSign(p.side, driveOnRight) !== dirSign) continue;
        sum += (pocketWidthAt(p, s) * p.widen) / p.width;
      }
      return sum;
    };

    const shoulderAt = (s: number): number => {
      let sh = profile.shoulder;
      for (const a of active) sh += (a.t.shoulder - profile.shoulder) * blend(a, s);
      return sh;
    };
    const halfExtentAt = (dirSign: number, s: number): number => {
      let ext = half + profile.shoulder;
      for (const a of active) ext += (a.t.halfPos - (half + profile.shoulder)) * blend(a, s);
      // A pocket widens the road on its own group's kerb side only; the median and
      // the opposing carriageway do not move.
      ext += pocketFlareAt(dirSign, s);
      return ext;
    };

    const segLaneIds: number[] = [];
    const vanishingLanes: { laneId: number; key: string; side: 1 | -1 }[] = [];

    // --- through lanes ---------------------------------------------------------
    for (const slot of layoutProfile(profile, driveOnRight)) {
      const key = transitionKey(slot.side, slot.index);
      const slotG = groupSign(slot.side, driveOnRight);
      const slotOffsetAt = (s: number): number =>
        laneOffsetAt(slot.offset, key, s) + slotG * pocketShiftAt(slot.side, s);
      const off = active.length || pockets.length
        ? offsetPolylineVariable(centerline, arclength, slotOffsetAt)
        : offsetPolyline(centerline, arclength, slot.offset);
      if (off.points.length < 4) continue;
      if (off.worstRatio > 1) {
        diagnostics.push({
          severity: 'warning', code: 'tight-curvature',
          message: 'A curve is tighter than the road is wide; lane geometry was clamped there.',
          strokeId: stroke.stroke.id,
        });
      }
      const lane = makeLane(lanes.length, LaneKind.Road);
      lane.segmentId = segId;
      lane.index = slot.index;
      lane.width = slot.width;
      lane.offset = slot.offset;
      lane.speedLimit = profile.speedLimit;
      finishLane(lane, off.points, off.sourceS, slot.side);
      lanes.push(lane);
      segLaneIds.push(lane.id);

      for (const a of active) {
        if (!a.t.vanishing.has(key)) continue;
        const towardLink = (a.dir === 1 && slot.side === 1) || (a.dir === -1 && slot.side === -1);
        if (towardLink) lane.endsAt = lane.length;
        else lane.startsAt = Math.max(lane.startsAt, Math.min(a.taper, lane.length * 0.9));
        vanishingLanes.push({ laneId: lane.id, key, side: slot.side });
      }
    }

    // --- auxiliary lanes -------------------------------------------------------
    for (const a of auxHere) {
      const base = densify(subPolyline(centerline, arclength, a.lo, a.hi), 4);
      const baseArc = buildArclength(base);
      const { plan } = a;
      const off = offsetPolylineVariable(base, baseArc, (s) => {
        const segS = a.lo + s;
        const w = auxWidthAt(segS, a.entryS, a.exitS, plan.flowSign, plan.width, plan.taperIn, plan.taperOut);
        // The lane keeps its inner edge and its outer edge tapers, so the centre
        // drifts toward the carriageway as the lane narrows.
        return plan.offset - plan.dir * (plan.width - w) * 0.5;
      });
      if (off.points.length < 4) continue;
      const sourceSeg = new Float32Array(off.sourceS.length);
      for (let i = 0; i < sourceSeg.length; i++) sourceSeg[i] = a.lo + off.sourceS[i];

      const lane = makeLane(lanes.length, LaneKind.Road);
      lane.segmentId = segId;
      lane.aux = true;
      lane.width = plan.width;
      lane.offset = plan.offset;
      lane.speedLimit = profile.speedLimit;
      finishLane(lane, off.points, sourceSeg, plan.side);
      if (plan.taperIn > 0) lane.startsAt = Math.min(plan.taperIn, lane.length * 0.9);
      lanes.push(lane);
      segLaneIds.push(lane.id);
      auxLaneByPlan.set(plan.id, lane.id);
    }

    // --- left-turn pockets ------------------------------------------------------
    // The bay opens against the group's median edge, which does not move: the
    // through lanes slide outward instead, so the median and the opposing
    // carriageway stay exactly where they were.
    const pocketLaneIds: { plan: TurnLanePlan; laneId: number }[] = [];
    const pocketMarkings: Marking[] = [];
    for (const p of pockets) {
      const g = groupSign(p.side, driveOnRight);
      const edgeAt = (s: number): number => pocketEdge(p, s);
      // The bay opens from that edge: inward by whatever it can take out of the
      // median, outward by the rest, which is what the through lanes make room for.
      // A kerb-side bay takes nothing inward and grows entirely outward.
      const inShare = p.width > 0 ? p.fromMedian / p.width : 0;
      const centreAt = (s: number): number =>
        edgeAt(s) + g * pocketWidthAt(p, s) * (0.5 - inShare);
      const span = Math.min(length, p.taper + p.storage);
      const lo = p.atEnd ? length - span : 0;
      const hi = p.atEnd ? length : span;
      const strip = densify(subPolyline(centerline, arclength, lo, hi), 4);
      const stripArc = buildArclength(strip);
      const off = offsetPolylineVariable(strip, stripArc, (t) => centreAt(lo + t));
      if (off.points.length < 4) continue;
      const sourceSeg = new Float32Array(off.sourceS.length);
      for (let i = 0; i < sourceSeg.length; i++) sourceSeg[i] = lo + off.sourceS[i];

      const lane = makeLane(lanes.length, LaneKind.Road);
      lane.segmentId = segId;
      lane.aux = true;
      lane.width = p.width;
      lane.offset = pocketEdge(p, p.atEnd ? length : 0) + g * p.width * (0.5 - inShare);
      lane.speedLimit = profile.speedLimit;
      finishLane(lane, off.points, sourceSeg, p.side);
      // Unusable until the bay is wide enough to sit in.
      lane.startsAt = Math.min(p.taper, lane.length * 0.9);
      lanes.push(lane);
      segLaneIds.push(lane.id);
      pocketLaneIds.push({ plan: p, laneId: lane.id });

      // The bay's outer boundary: dashed where it opens, solid alongside the
      // storage, which is where crossing into it stops being allowed.
      const taperEnd = p.atEnd ? length - p.storage : p.storage;
      const boundary = (a: number, b: number, style: 'dashed' | 'solid'): void => {
        if (b - a < 1) return;
        const sub = subPolyline(centerline, arclength, a, b);
        const subArc = buildArclength(sub);
        pocketMarkings.push({
          style,
          points: offsetPolylineVariable(sub, subArc, (t) =>
            centreAt(a + t) + g * pocketWidthAt(p, a + t) * 0.5).points,
        });
      };
      if (p.atEnd) {
        boundary(lo, taperEnd, 'dashed');
        boundary(taperEnd, hi, 'solid');
      } else {
        boundary(lo, taperEnd, 'solid');
        boundary(taperEnd, hi, 'dashed');
      }
    }

    // --- neighbours, slot indices, merge targets --------------------------------
    // Lateral order is by offset, but a through lane's stored offset is its nominal
    // one: beside a pocket it actually runs a lane further out. Compare against the
    // shifted position or the bay ties with the lane it sits inside of.
    const sortOffset = new Map<number, number>();
    for (const id of segLaneIds) {
      const lane = lanes[id];
      let off = lane.offset;
      if (!lane.aux) {
        for (const p of pockets) {
          // Only a median-side bay moves the through lanes; a kerb-side one opens
          // outside them, so comparing against a shifted position would sort it
          // inside the lane it actually sits outboard of.
          if (p.kind !== 'left' || p.side !== lane.side) continue;
          off += groupSign(p.side, driveOnRight) * p.widen;
        }
      }
      sortOffset.set(id, off);
    }
    const gSign = { 1: groupSign(1, driveOnRight), '-1': groupSign(-1, driveOnRight) };
    for (const side of [1, -1] as const) {
      const group = segLaneIds
        .map((id) => lanes[id])
        .filter((l) => l.side === side)
        .sort((a, b) => {
          const g = side === 1 ? gSign[1] : gSign['-1'];
          return g * sortOffset.get(b.id)! - g * sortOffset.get(a.id)! || a.id - b.id;
        });
      if (!group.length) continue;
      let p0 = group.findIndex((l) => !l.aux);
      if (p0 < 0) p0 = 0;
      for (let i = 0; i < group.length; i++) {
        group[i].index = i - p0;
        group[i].right = i > 0 ? group[i - 1].id : -1;
        group[i].left = i < group.length - 1 ? group[i + 1].id : -1;
      }
    }

    for (const v of vanishingLanes) {
      const lane = lanes[v.laneId];
      lane.mergeTarget = lane.left;
      if (lane.mergeTarget < 0) lane.mergeTarget = lane.right;
    }

    for (const a of auxHere) {
      const laneId = auxLaneByPlan.get(a.plan.id);
      if (laneId === undefined) continue;
      const lane = lanes[laneId];
      const inwardIsLeft = a.plan.dir * groupSign(a.plan.side, driveOnRight) > 0;
      // A lane that is now part of the highway has nowhere it must merge to.
      if (!a.plan.permanent) lane.mergeTarget = inwardIsLeft ? lane.left : lane.right;
      if (a.plan.endsWithMerge) lane.endsAt = lane.length;
    }

    for (const { laneId } of pocketLaneIds) {
      // The bay runs into the junction rather than ending, so no `endsAt` — but a
      // driver who finds themselves in it and does not want to turn merges back to
      // the through lane beside them.
      lanes[laneId].mergeTarget = lanes[laneId].right;
    }

    // --- surface and markings ---------------------------------------------------
    const base = densify(centerline, 3);
    const baseArc = buildArclength(base);
    const shoulder = profile.shoulder;
    const extAt = (dirSign: number, s: number): number =>
      halfExtentAt(dirSign, s) + auxExtentAt(auxHere, dirSign, s);

    const rightEdge = offsetPolylineVariable(base, baseArc, (s) => extAt(1, s));
    const leftEdge = offsetPolylineVariable(base, baseArc, (s) => -extAt(-1, s));
    const rn = rightEdge.points.length >> 1;
    const ln = leftEdge.points.length >> 1;
    const capStart = Float32Array.from([
      rightEdge.points[0], rightEdge.points[1], leftEdge.points[0], leftEdge.points[1],
    ]);
    const capEnd = Float32Array.from([
      rightEdge.points[(rn - 1) * 2], rightEdge.points[(rn - 1) * 2 + 1],
      leftEdge.points[(ln - 1) * 2], leftEdge.points[(ln - 1) * 2 + 1],
    ]);
    const surface = new Float32Array((rn + ln) * 2);
    // The real height at each point, not the layer it draws on: a bridge's ends are
    // ramps, and the renderer needs to know that to stop the shadow appearing all at
    // once across the road at the abutment.
    const surfaceHeight = new Float32Array(rn + ln);
    for (let i = 0; i < rn; i++) {
      surface[i * 2] = rightEdge.points[i * 2];
      surface[i * 2 + 1] = rightEdge.points[i * 2 + 1];
      surfaceHeight[i] = stroke.gradeAt(range.s0 + rightEdge.sourceS[i]);
    }
    for (let i = 0; i < ln; i++) {
      const src = ln - 1 - i;
      surface[(rn + i) * 2] = leftEdge.points[src * 2];
      surface[(rn + i) * 2 + 1] = leftEdge.points[src * 2 + 1];
      surfaceHeight[rn + i] = stroke.gradeAt(range.s0 + leftEdge.sourceS[src]);
    }

    // Push each end cap a hair past the joint. Two surfaces that abut exactly share
    // an antialiased edge, and two half-covered pixels do not add up to one covered
    // pixel — the dark casing underneath shows through as a hairline across the road
    // at every link and every split.
    const SEAM = 0.1;
    sampleTangent(centerline, arclength, 0.01, _t);
    for (const i of [0, (rn + ln - 1)]) {
      surface[i * 2] -= _t.x * SEAM;
      surface[i * 2 + 1] -= _t.y * SEAM;
    }
    sampleTangent(centerline, arclength, Math.max(0, length - 0.01), _t);
    for (const i of [rn - 1, rn]) {
      surface[i * 2] += _t.x * SEAM;
      surface[i * 2 + 1] += _t.y * SEAM;
    }

    let maxHalfWidth = half + shoulder;
    for (let i = 0; i < baseArc.length; i++) {
      maxHalfWidth = Math.max(maxHalfWidth, extAt(1, baseArc[i]), extAt(-1, baseArc[i]));
    }

    // The edge line marks the edge of the *carriageway*; the shoulder is asphalt
    // outside it. Painting it on the asphalt boundary instead makes the kerbside
    // lane read a shoulder-width wider than every lane inside it.
    const plainCrossSection = !active.length && !auxHere.length && !pockets.length;
    const markings: Marking[] = [...pocketMarkings];
    for (const dirSign of [1, -1] as const) {
      if (plainCrossSection) {
        markings.push({ style: 'edge', points: offsetPolyline(base, baseArc, dirSign * half).points });
        continue;
      }
      const at = (s: number): number =>
        dirSign * (halfExtentAt(dirSign, s) + auxMarkExtentAt(auxHere, dirSign, s) - shoulderAt(s));
      // An auxiliary lane that begins or ends without a taper steps the edge line by
      // a whole lane. Draw the line in pieces either side of the step: one polyline
      // through it would be a straight bar across the carriageway.
      const cuts = [0];
      for (const a of auxHere) {
        if (Math.sign(a.plan.dir) !== dirSign) continue;
        if (a.plan.taperIn <= 0) cuts.push(a.entryS);
        if (a.plan.taperOut <= 0) cuts.push(a.exitS);
      }
      cuts.push(length);
      cuts.sort((x, y) => x - y);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const s0 = Math.max(0, cuts[i]);
        const s1 = Math.min(length, cuts[i + 1]);
        if (s1 - s0 < 1) continue;
        const sub = subPolyline(base, baseArc, s0, s1);
        const subArc = buildArclength(sub);
        // Sample strictly inside the piece so the step never leaks across the cut.
        const lo = s0 + 1e-3, hi = s1 - 1e-3;
        markings.push({
          style: 'edge',
          points: offsetPolylineVariable(sub, subArc, (t) =>
            at(Math.min(Math.max(s0 + t, lo), hi))).points,
        });
      }
    }
    for (const side of [1, -1] as const) {
      const count = lanesOnSide(profile, side);
      const g = groupSign(side, driveOnRight);
      for (let k = 1; k < count; k++) {
        const baseOff = g * (half - k * profile.laneWidth);
        const outerKey = transitionKey(side, k - 1);
        const innerKey = transitionKey(side, k);
        const pts = active.length || pockets.length
          ? offsetPolylineVariable(centerline, arclength, (s) =>
              (laneOffsetAt(g * (half - (k - 1 + 0.5) * profile.laneWidth), outerKey, s) +
                laneOffsetAt(g * (half - (k + 0.5) * profile.laneWidth), innerKey, s)) * 0.5
              + g * pocketShiftAt(side, s)).points
          : offsetPolyline(centerline, arclength, baseOff).points;
        markings.push({ style: 'dashed', points: pts });
      }
    }
    if (profile.lanesForward > 0 && profile.lanesBackward > 0) {
      if (profile.median > 0) {
        for (const sgn of [1, -1] as const) {
          const base = (sgn * profile.median) / 2;
          // Where a bay is running down the median, the line marking it is the bay's
          // own inner edge: there is no median left to mark.
          const eaten = pockets.filter((p) => groupSign(p.side, driveOnRight) === sgn);
          markings.push({
            style: 'median',
            points: eaten.length
              ? offsetPolylineVariable(centerline, arclength, (s) => {
                let off = base;
                for (const p of eaten) {
                  if (p.width <= 0) continue;
                  off = sgn > 0
                    ? Math.min(off, innerOfPocket(p, s))
                    : Math.max(off, innerOfPocket(p, s));
                }
                return off;
              }).points
              : offsetPolyline(centerline, arclength, base).points,
          });
        }
      } else {
        markings.push({ style: 'double', points: Float32Array.from(centerline) });
      }
    }
    for (const a of auxHere) {
      const inner = a.plan.offset - a.plan.dir * a.plan.width * 0.5;
      const strip = subPolyline(centerline, arclength, a.lo, a.hi);
      markings.push({
        style: 'dashed',
        points: offsetPolyline(strip, buildArclength(strip), inner).points,
      });
    }

    // The road's own zoning wins over its road type's, and `'none'` is a real
    // answer rather than a missing one — it is how a single stretch of an otherwise
    // residential street gets left bare.
    const segLandUse = stroke.stroke.landUse === 'none'
      ? undefined
      : (stroke.stroke.landUse ?? profile.landUse);
    segments.push({
      id: segId,
      strokeId: stroke.stroke.id,
      profileId: profile.id,
      grade: stroke.levelAt((range.s0 + range.s1) * 0.5),
      strokeS0: range.s0,
      strokeS1: range.s1,
      centerline,
      arclength,
      length,
      laneIds: segLaneIds,
      isRamp: profile.isRamp,
      verge: Math.max(0, profile.verge ?? 0),
      landUse: segLandUse,
      frontages: segLandUse ? frontagesOf(length, segLandUse, segId) : [],
      capStart,
      capEnd,
      symbols: [],
      startJunction: -1,
      endJunction: -1,
      halfWidth: profileHalfWidth(profile),
      maxHalfWidth,
      surface,
      surfaceHeight,
      surfaceSplit: rn,
      markings,
    });
    built.push(range);
  }

  return { segments, ranges: built, auxLaneByPlan, diagnostics };
}

/** Total lane length, for stats. */
export function totalLaneLength(lanes: ReadonlyArray<Lane>): number {
  let sum = 0;
  for (const l of lanes) sum += l.length;
  return sum;
}

export { polylineLength };
