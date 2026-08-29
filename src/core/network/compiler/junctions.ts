/**
 * Compile steps 5 and 8: junction footprints, connectors, conflicts and priority.
 *
 * Crossing junctions get a footprint polygon (union of the approach corridors),
 * a connector for every legal movement, conflict points where connectors cross,
 * and a strict total priority order. Merges and diverges get a short blend
 * connector into or out of the auxiliary lane and nothing else — the mainline is
 * never interrupted. Links wire lane successors directly with no connector at all.
 */

import {
  buildArclength, closestOnPolyline, curvatureAt, makeClosestHit, polylineLength,
  samplePosition, sampleTangent, subPolyline,
} from '../../geom/polyline';
import { flattenCubicInto } from '../../geom/flatten';
import { segmentIntersect, makeSegHit } from '../../geom/intersect';
import { unionPolygons, roundCorners } from '../../geom/polygon';
import { corridorPolygon, offsetPolyline, offsetPolylineVariable } from '../../geom/offset';
import { wrapAngle } from '../../geom/vec2';
import type {
  Approach, Diagnostic, Junction, Lane, LaneLinkOverride, Marking, Segment,
} from '../types';
import { LaneKind, TurnKind } from '../types';
import { buildSignalPlan } from './signals';
import type { Meeting } from './crossings';
import { classifyTurn } from './crossings';
import type { SegmentRange } from './segments';
import { makeLane } from './segments';
import type { LinkPlan } from './links';
import type { AuxLanePlan, RampPlan } from './ramps';
import type { PreparedStroke } from './prepare';

/** Comfortable lateral acceleration used to derive a connector's speed limit. */
const LATERAL_ACCEL = 2.6;
const MIN_TURN_SPEED = 3.5;

const _p0 = { x: 0, y: 0 };
const _hitM = makeClosestHit();
const _p1 = { x: 0, y: 0 };
const _t0 = { x: 0, y: 0 };
const _t1 = { x: 0, y: 0 };
const _hit = makeSegHit();

export interface JunctionInputs {
  laneLinks?: ReadonlyArray<LaneLinkOverride>;
  /** Whether the document asks for right-in / right-out at this meeting. */
  rightInRightOutAt?: (x: number, y: number, radius: number) => boolean;
  strokes: PreparedStroke[];
  meetings: Meeting[];
  segments: Segment[];
  ranges: SegmentRange[];
  lanes: Lane[];
  links: LinkPlan[];
  rampPlans: RampPlan[];
  auxPlans: AuxLanePlan[];
  auxLaneByPlan: Map<number, number>;
  driveOnRight: boolean;
}

/** Heading of travel *into* the junction from a segment end. */
function approachHeading(seg: Segment, atEnd: boolean): number {
  const s = atEnd ? Math.max(0, seg.length - 0.01) : 0.01;
  sampleTangent(seg.centerline, seg.arclength, s, _t0);
  return atEnd ? Math.atan2(_t0.y, _t0.x) : Math.atan2(-_t0.y, -_t0.x);
}

/** Whether a part-length lane actually reaches the given end of its segment. */
function reachesEnd(lane: Lane, seg: Segment, atEnd: boolean): boolean {
  if (!lane.aux) return true;
  const n = lane.parentS.length;
  if (n < 2) return false;
  const lo = Math.min(lane.parentS[0], lane.parentS[n - 1]);
  const hi = Math.max(lane.parentS[0], lane.parentS[n - 1]);
  return atEnd ? hi > seg.length - 1 : lo < 1;
}

function lanesAt(lanes: Lane[], seg: Segment, atEnd: boolean): { incoming: Lane[]; outgoing: Lane[] } {
  const incoming: Lane[] = [];
  const outgoing: Lane[] = [];
  for (const id of seg.laneIds) {
    const lane = lanes[id];
    // An auxiliary lane covers part of its segment: a turn pocket at one end is not
    // an approach lane at the other, and wiring one up there connects traffic to a
    // lane that does not exist where it is standing.
    if (!reachesEnd(lane, seg, atEnd)) continue;
    // Forward lanes run toward the segment end; backward lanes toward its start.
    const flowsToEnd = lane.side === 1;
    if (flowsToEnd === atEnd) incoming.push(lane);
    else outgoing.push(lane);
  }
  const byIndex = (a: Lane, b: Lane): number => a.index - b.index || a.id - b.id;
  incoming.sort(byIndex);
  outgoing.sort(byIndex);
  return { incoming, outgoing };
}

/** Builds a smooth connector lane between two lane ends. */
export function buildConnector(
  lanes: Lane[], junctionId: number, from: Lane, to: Lane, turn: TurnKind,
  handle?: number,
): Lane {
  samplePosition(from.centerline, from.arclength, from.length, _p0);
  sampleTangent(from.centerline, from.arclength, Math.max(0, from.length - 0.01), _t0);
  samplePosition(to.centerline, to.arclength, 0, _p1);
  sampleTangent(to.centerline, to.arclength, 0.01, _t1);

  const d = Math.hypot(_p1.x - _p0.x, _p1.y - _p0.y);
  // Straight-line distance is the right handle for a movement that goes *across* a
  // junction. A U-turn's two ends are a lane apart and its tangents are opposed, so
  // that rule gives a two-metre hairpin pivoting on the stop line; a turning head
  // passes its own radius in instead.
  const h = handle ?? Math.min(60, Math.max(0.75, d * 0.42));
  const pts: number[] = [_p0.x, _p0.y];
  flattenCubicInto(
    pts,
    _p0.x, _p0.y,
    _p0.x + _t0.x * h, _p0.y + _t0.y * h,
    _p1.x - _t1.x * h, _p1.y - _t1.y * h,
    _p1.x, _p1.y,
    0.08, 4,
  );
  const centerline = Float32Array.from(pts);

  const lane = makeLane(lanes.length, LaneKind.Connector);
  lane.junctionId = junctionId;
  lane.turn = turn;
  lane.centerline = centerline;
  lane.arclength = buildArclength(centerline);
  lane.length = polylineLength(centerline);
  lane.width = Math.min(from.width, to.width);
  lane.side = 1;
  lane.parentS = lane.arclength;

  let maxCurv = 0;
  for (let i = 1; i < (centerline.length >> 1) - 1; i++) {
    maxCurv = Math.max(maxCurv, Math.abs(curvatureAt(centerline, i)));
  }
  const geometricLimit = maxCurv > 1e-4 ? Math.sqrt(LATERAL_ACCEL / maxCurv) : Infinity;
  lane.speedLimit = Math.max(
    MIN_TURN_SPEED,
    Math.min(from.speedLimit, to.speedLimit, geometricLimit),
  );

  from.successors.push(lane.id);
  lane.predecessors.push(from.id);
  lane.successors.push(to.id);
  to.predecessors.push(lane.id);
  lanes.push(lane);
  return lane;
}

interface Touch {
  segId: number;
  atEnd: boolean;
}

/**
 * Distributes an approach's lanes across its movements the way real lane markings
 * do: right turns hug the kerb lane, left turns the median lane, and through
 * traffic gets everything in between *plus* whatever it can share. Blocks overlap
 * on purpose - a two-lane approach signed "right/through" and "through/left" has
 * twice the through capacity of one where each lane is exclusive.
 */
function allocateBlocks(laneCount: number, turns: TurnKind[]): { lo: number; hi: number }[] {
  const m = turns.length;
  if (m === 0 || laneCount === 0) return [];
  if (m === 1) return [{ lo: 0, hi: laneCount }];

  const rights = turns.filter((t) => t === TurnKind.Right).length;
  const lefts = turns.filter((t) => t === TurnKind.Left || t === TurnKind.UTurn).length;
  const hasStraight = turns.some((t) => t === TurnKind.Straight);

  // Dedicated kerb-side and median-side lanes, never more than half the approach.
  const half = Math.max(1, Math.floor(laneCount / 2));
  const rLanes = rights ? Math.min(rights, half) : 0;
  const lLanes = lefts ? Math.min(lefts, half) : 0;

  const blocks: { lo: number; hi: number }[] = [];
  let rSeen = 0;
  let lSeen = 0;
  for (const turn of turns) {
    if (turn === TurnKind.Right) {
      const lo = Math.min(rSeen, Math.max(0, rLanes - 1));
      rSeen++;
      blocks.push({ lo, hi: Math.min(laneCount, lo + 1) });
    } else if (turn === TurnKind.Left || turn === TurnKind.UTurn) {
      const hi = laneCount - Math.min(lSeen, Math.max(0, lLanes - 1));
      lSeen++;
      blocks.push({ lo: Math.max(0, hi - 1), hi });
    } else {
      // Through traffic: everything except lanes reserved for turns, but never
      // fewer than one lane, and on a narrow approach it shares with the turns.
      const lo = laneCount > 2 ? Math.min(rLanes ? 0 : 0, laneCount - 1) : 0;
      const hi = laneCount > 2 ? Math.max(lo + 1, laneCount - lLanes) : laneCount;
      blocks.push({ lo, hi });
    }
  }
  if (!hasStraight && blocks.length) {
    // No through movement: spread the turns over the whole approach.
    const firstRight = blocks.findIndex((_, k) => turns[k] === TurnKind.Right);
    if (firstRight >= 0 && rights === 1) blocks[firstRight] = { lo: 0, hi: Math.max(1, laneCount - lLanes) };
    const firstLeft = blocks.findIndex((_, k) => turns[k] === TurnKind.Left);
    if (firstLeft >= 0 && lefts === 1) blocks[firstLeft] = { lo: Math.min(rLanes, laneCount - 1), hi: laneCount };
  }
  return blocks;
}

/**
 * Sine of the shallowest angle at which two arms count as crossing each other —
 * 30 degrees, the same threshold the classifier uses to tell a crossing from a merge.
 */
const CROSSING_SIN = 0.5;

/** How nearly opposite two arms must be to count as one road passing through. */
const OPPOSITE_COS = 0.866;

function junctionFootprint(
  meeting: Meeting, segments: Segment[], touches: Touch[],
  ranges: SegmentRange[], strokes: PreparedStroke[], connectors: Lane[],
): Float32Array {
  interface Arm {
    rx: number; ry: number; lx: number; ly: number;
    dx: number; dy: number; gap: number; half: number;
    /**
     * Where the middle of the cap sits across the centreline. A left-turn bay
     * flares one kerb and not the other, so the road's end is no longer centred on
     * the line it was offset from, and a corridor grown symmetrically about that
     * line falls short of the flared corner by half the widening.
     */
    lat: number;
    /** Parent stroke and the arc-length on it where this arm's road stops. */
    stroke: PreparedStroke | undefined; capS: number; along: 1 | -1;
  }
  const arms: Arm[] = [];
  for (const touch of touches) {
    const seg = segments[touch.segId];
    const cap = touch.atEnd ? seg.capEnd : seg.capStart;
    if (cap.length < 4) continue;
    const s = touch.atEnd ? seg.length : 0;
    samplePosition(seg.centerline, seg.arclength, s, _p0);
    sampleTangent(seg.centerline, seg.arclength, touch.atEnd ? Math.max(0, seg.length - 0.01) : 0.01, _t0);
    const range = ranges[touch.segId];
    arms.push({
      rx: cap[0], ry: cap[1], lx: cap[2], ly: cap[3],
      dx: touch.atEnd ? _t0.x : -_t0.x,
      dy: touch.atEnd ? _t0.y : -_t0.y,
      gap: Math.hypot(meeting.x - _p0.x, meeting.y - _p0.y),
      half: Math.hypot(cap[0] - cap[2], cap[1] - cap[3]) * 0.5,
      lat: ((cap[0] + cap[2]) * 0.5 - _p0.x) * -_t0.y + ((cap[1] + cap[3]) * 0.5 - _p0.y) * _t0.x,
      stroke: range ? strokes[range.strokeIdx] : undefined,
      capS: range ? (touch.atEnd ? range.s1 : range.s0) : 0,
      along: touch.atEnd ? 1 : -1,
    });
  }

  // Kerb radius: what turns a plus-shaped blob into something that reads as a
  // junction. Scaled to the narrowest road so a residential corner does not get a
  // motorway-sized flare.
  let narrowest = Infinity;
  for (const a of arms) narrowest = Math.min(narrowest, a.half);
  const radius = Math.min(6, Math.max(1.5, narrowest * 0.9));

  // Grow each corridor from the road's own end cap: exactly as wide as the road it
  // continues and flush with both its edges, so the two surfaces union without a
  // step. An inflated straight quad does not match a road that is still curving.
  // The tail reaches past the kerb radius so filleting cannot nibble the joint.
  const BACK = radius + 2;

  // Which arms belong to a road that carries on out the other side, rather than
  // stopping here. Within 30 degrees of straight opposite, so a road that curves
  // through the junction still counts as one road.
  const continuesThrough = arms.map((b, j) =>
    arms.some((k, kj) => kj !== j && b.dx * k.dx + b.dy * k.dy < -OPPOSITE_COS));

  const quads: Float32Array[] = [];
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    // Reach across the junction, not past it. An approach only has to span the
    // widest road it *crosses* — measured perpendicular to itself, so a skew
    // crossing gets the longer span it needs. Overshooting instead leaves a
    // rectangular bump of asphalt sticking out the far side of every T-junction.
    //
    // The arm opposite is the same road continuing, not a road to cross: its sine is
    // about zero, and dividing by a clamped one turned it into the widest thing in
    // the junction. That is what stretched the box — and the marking cover with it —
    // far down a road nothing crosses. A real crossing is never this shallow;
    // anything under 30 degrees compiles as a merge or a diverge instead.
    let across = 0;
    for (let j = 0; j < arms.length; j++) {
      if (j === i) continue;
      const b = arms[j];
      // Only a road that *continues through* the junction has to be crossed. An arm
      // with nothing opposite it is a road that ends here: traffic turns onto it, it
      // does not drive over it, so this corridor has no reason to span its width.
      //
      // Without that, a Y junction — three roads that all stop at one point, none of
      // them opposite another — had every arm reaching across every other. The narrow
      // arm of one measured shape was told to reach 21.5 m past the junction on a
      // four-metre-wide road, which put a spur of asphalt into a sector with no road
      // in it at all. A crossing gets the same answer as before, because the arm you
      // are crossing is precisely the one that has a partner opposite it.
      if (!continuesThrough[j]) continue;
      // Shallower than the angle at which two roads count as crossing at all, and
      // they are not crossing: they are leaving the same point alongside each other,
      // and neither has to reach across the other's width to get anywhere.
      //
      // The threshold has to be the classifier's own, not a looser one. Where a
      // stroke *ends* on another road anything under 30 degrees compiles as a merge
      // or a diverge, so the assumption that a genuine crossing arm never has a small
      // sine holds — but three strokes that all *start* at one point make a crossing
      // whatever their angles, and there a pair 31 degrees apart slipped through.
      // Dividing a 14.5 m half-width by sin(31 degrees) told a four-metre-wide arm to
      // reach 21.5 m past the junction, into a sector with no road in it at all.
      const sin = Math.abs(a.dx * b.dy - a.dy * b.dx);
      if (sin < CROSSING_SIN) continue;
      // Far enough that this arm's leading *corner* lands on the far kerb, not its
      // centreline. The corridor is cut square across, so at a skew its outer corner
      // runs ahead of its centre by half a width times the cosine — and that is the
      // little rectangular hump you see poking out of the far side of the box. The
      // wedge this leaves short on the other corner is covered by the crossing
      // road's own arms, which span its full width either side of the meeting.
      const cos = Math.abs(a.dx * b.dx + a.dy * b.dy);
      across = Math.max(across, Math.max(0, b.half - a.half * cos) / sin);
    }
    // Exactly to the far kerb. Any margin on top of that is asphalt sticking out
    // into the grass on the far side, and the sliver it adds is a short edge that
    // collapses the kerb radius on the corner beside it.
    //
    // An arm that stops here reaches only to its own cap. It used to run on to the
    // meeting point with a square end the full width of the road, and on a Y the
    // corners of that end are the two spikes either side of a V, sticking fourteen
    // metres into the sector with no road in it. The middle of the box is filled by
    // the fan below instead, which tapers to the meeting point the way a kerb does.
    const reach = continuesThrough[i] ? Math.max(a.gap + across, a.gap + 0.5) : 0.5;
    // Follow the road's own curve rather than shooting a straight quad off the end
    // of it. Over the tens of metres a shallow crossing needs, a straight corridor
    // wanders right off a curving road, and the union of four of them comes out as
    // a lumpy blob with asphalt where no road goes.
    const curved = a.stroke
      ? corridorAlong(a.stroke, a.capS - a.along * BACK, a.capS + a.along * reach, a.half, a.lat)
      : null;
    quads.push(curved ?? Float32Array.from([
      a.rx - a.dx * BACK, a.ry - a.dy * BACK,
      a.rx + a.dx * reach, a.ry + a.dy * reach,
      a.lx + a.dx * reach, a.ly + a.dy * reach,
      a.lx - a.dx * BACK, a.ly - a.dy * BACK,
    ]));
  }
  if (!quads.length) return new Float32Array(0);

  // The middle of the box: a fan of triangles from the meeting point.
  //
  // Each arm gets the wedge from its cap to the centre, and each pair of arms that
  // are neighbours round the junction gets the triangle between their facing cap
  // corners — the paved corner a real junction has, cut straight between the two
  // kerbs and filleted below.
  //
  // *Every* neighbouring pair, including the two either side of a Y's empty sector.
  // Leaving that one out looked like the obvious economy — a hundred square metres
  // of asphalt with no road on it — and the audit refused it at once: the turning
  // movement between those two arms swings straight through the corner, and a
  // connector over bare ground is a car driving on grass. The asphalt goes where the
  // cars go. A real Y of this shape paves that corner too, or puts an island in it.
  const corners: { x: number; y: number; ang: number }[] = [];
  for (const a of arms) {
    corners.push({ x: a.rx, y: a.ry, ang: Math.atan2(a.ry - meeting.y, a.rx - meeting.x) });
    corners.push({ x: a.lx, y: a.ly, ang: Math.atan2(a.ly - meeting.y, a.lx - meeting.x) });
  }
  corners.sort((p, q) => p.ang - q.ang);
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % corners.length];
    quads.push(Float32Array.from([meeting.x, meeting.y, p.x, p.y, q.x, q.y]));
  }

  let merged = unionPolygons(quads);
  if (merged.length < 6) return merged;

  // Wherever a movement leaves the box, the box follows it.
  //
  // The fan is the box a junction's *roads* make, and it is right whenever the
  // turns stay inside it — every crossing and every T. It is wrong at a Y whose
  // arms all leave within a half-plane: the two cap corners either side of the
  // empty sector are nearly opposite each other, so the chord between them passes
  // almost through the meeting point and paves nothing, while the turn from one of
  // those arms to the other swings round the empty side of the centre at ten or
  // fifteen metres out. Measured: nine of seventeen points of that connector on
  // bare ground. So each connector is checked against the box, and one that strays
  // gets a corridor of its own width added — a channelised corner, which is what a
  // real junction of this shape builds too. Almost no junction pays for it: the
  // check is a few point tests, and the extra union only runs when something is
  // actually outside.
  const strays: Float32Array[] = [];
  for (const c of connectors) {
    let outside = false;
    for (let i = 0; i < c.centerline.length && !outside; i += 2) {
      outside = !pointInRing(merged, c.centerline[i], c.centerline[i + 1]);
    }
    if (!outside) continue;
    const ring = corridorPolygon(c.centerline, c.arclength, c.width * 0.5 + CONNECTOR_VERGE);
    if (ring.length >= 6) strays.push(ring);
  }
  if (strays.length) merged = unionPolygons([merged, ...strays]);

  return roundCorners(merged, radius);
}

/** Half the width of the segment's cap nearer to (x, y). */
function capHalfWidth(seg: Segment, x: number, y: number): number {
  const half = (cap: Float32Array): number => Math.hypot(cap[0] - cap[2], cap[1] - cap[3]) / 2;
  const at = (cap: Float32Array): number => Math.hypot((cap[0] + cap[2]) / 2 - x, (cap[1] + cap[3]) / 2 - y);
  if (seg.capStart.length < 4) return seg.capEnd.length >= 4 ? half(seg.capEnd) : seg.maxHalfWidth;
  if (seg.capEnd.length < 4) return half(seg.capStart);
  return at(seg.capStart) <= at(seg.capEnd) ? half(seg.capStart) : half(seg.capEnd);
}

/** Paved margin outside a connector that has to be given its own corridor. */
const CONNECTOR_VERGE = 0.6;

function pointInRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  const n = ring.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}


/**
 * A constant-width corridor down a stroke between two arc-lengths, either way
 * round. Past the end of the stroke it carries straight on, because a junction arm
 * still has to reach across the box even when the road it continues stops there.
 */
function corridorAlong(
  stroke: PreparedStroke, sA: number, sB: number, half: number, lat = 0,
): Float32Array | null {
  const lo = Math.min(sA, sB);
  const hi = Math.max(sA, sB);
  const clampedLo = Math.max(0, lo);
  const clampedHi = Math.min(stroke.length, hi);
  if (clampedHi - clampedLo < 0.5) return null;
  const inside = subPolyline(stroke.points, stroke.arclength, clampedLo, clampedHi);
  const pts = [...inside];
  if (lo < clampedLo - 1e-3) {
    sampleTangent(stroke.points, stroke.arclength, 0.01, _t0);
    pts.unshift(pts[0] - _t0.x * (clampedLo - lo), pts[1] - _t0.y * (clampedLo - lo));
  }
  if (hi > clampedHi + 1e-3) {
    sampleTangent(stroke.points, stroke.arclength, Math.max(0, stroke.length - 0.01), _t0);
    pts.push(
      pts[pts.length - 2] + _t0.x * (hi - clampedHi),
      pts[pts.length - 1] + _t0.y * (hi - clampedHi),
    );
  }
  let poly = Float32Array.from(pts);
  let arc = buildArclength(poly);
  // Follow the middle of the road's end rather than the line it was offset from,
  // so a corridor is flush with both cap corners even where one kerb is flared.
  if (Math.abs(lat) > 0.05) {
    const shifted = offsetPolyline(poly, arc, lat);
    if (shifted.points.length >= 4) {
      poly = Float32Array.from(shifted.points);
      arc = buildArclength(poly);
    }
  }
  const ring = corridorPolygon(poly, arc, half);
  return ring.length >= 6 ? ring : null;
}

/**
 * Asphalt under a gore. A merge or diverge has no junction box, but the blend
 * connector between the ramp and the auxiliary lane still covers real road: it is
 * ~40 m long here, and with nothing painted under it the ramp reads as a detached
 * stub floating beside the freeway. The corridor is extended a little into both
 * neighbours so the union leaves no hairline seam.
 */
function goreFootprint(
  connectors: Lane[], rampHalf: number, roadHalf: number, rampAtStart: boolean,
): Float32Array {
  const usable = connectors.filter((c) => c.centerline.length >= 4);
  if (!usable.length) return new Float32Array(0);

  // One corridor around the average of the movements, not a union of one per lane.
  // A two-lane ramp has two connectors that converge as they reach the carriageway,
  // and unioning a corridor around each pinches where they cross — which shows up as
  // a rectangular bite taken out of the edge of the ramp.
  const SAMPLES = 48;
  const mid = new Float32Array(SAMPLES * 2);
  for (const c of usable) {
    const total = c.length || 1;
    for (let i = 0; i < SAMPLES; i++) {
      samplePosition(c.centerline, c.arclength, (total * i) / (SAMPLES - 1), _p0);
      mid[i * 2] += _p0.x / usable.length;
      mid[i * 2 + 1] += _p0.y / usable.length;
    }
  }

  // Reach a little into both neighbours so no hairline seam is left at either end.
  const OVERLAP = 4;
  const pts: number[] = [];
  const hx = mid[0] - mid[2], hy = mid[1] - mid[3];
  const hl = Math.hypot(hx, hy) || 1;
  pts.push(mid[0] + (hx / hl) * OVERLAP, mid[1] + (hy / hl) * OVERLAP);
  for (let i = 0; i < SAMPLES; i++) pts.push(mid[i * 2], mid[i * 2 + 1]);
  const tx = mid[(SAMPLES - 1) * 2] - mid[(SAMPLES - 2) * 2];
  const ty = mid[(SAMPLES - 1) * 2 + 1] - mid[(SAMPLES - 2) * 2 + 1];
  const tl = Math.hypot(tx, ty) || 1;
  pts.push(
    mid[(SAMPLES - 1) * 2] + (tx / tl) * OVERLAP,
    mid[(SAMPLES - 1) * 2 + 1] + (ty / tl) * OVERLAP,
  );
  const ext = Float32Array.from(pts);
  const arc = buildArclength(ext);

  // The corridor *is* the carriageway over the stretch where the two converge, so it
  // carries the ramp's full width at the ramp end — anything narrower leaves the
  // wedge between the two edges, the gore itself, unpaved. At the other end it
  // matches the road's outer extent beside its auxiliary lane, so the two edges meet
  // flush instead of stepping.
  const total = arc[arc.length - 1] || 1;
  const a = Math.max(rampHalf, usable[0].width * 0.5 + 0.4);
  // Never wider than the road is at that end: the corridor's outer edge has to land
  // on the carriageway edge, and a corridor sized to the ramp instead leaves a
  // rectangular bump of asphalt hanging off the side of the freeway.
  const b = Math.max(1, roadHalf);
  const halfAt = (sAt: number): number => {
    let u = sAt / total;
    if (rampAtStart) u = 1 - u;
    const t = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    return a + (b - a) * (1 - t);
  };
  const right = offsetPolylineVariable(ext, arc, halfAt).points;
  const left = offsetPolylineVariable(ext, arc, (sAt) => -halfAt(sAt)).points;
  const rn = right.length >> 1, ln = left.length >> 1;
  const ring = new Float32Array((rn + ln) * 2);
  ring.set(right, 0);
  for (let i = 0; i < ln; i++) {
    ring[(rn + i) * 2] = left[(ln - 1 - i) * 2];
    ring[(rn + i) * 2 + 1] = left[(ln - 1 - i) * 2 + 1];
  }
  return ring;
}


/**
 * How far a gore line's end may be nudged to meet the marking it continues.
 *
 * Deliberately small. The nudge exists to close a jog of a few centimetres, caused
 * by measuring a distance in one direction and applying it in another; it is not a
 * search for the right line to aim at. Let it grow to a lane's width and the end
 * snaps to whichever of a ramp's several markings happens to be nearest, which is a
 * much worse picture than the small jog it was fixing.
 */
const HAND_OVER = 2.2;

/**
 * How far out this end of a gore line sits, along the direction it is offset in, so
 * that it lands on the road marking it continues.
 *
 * The answer is found by asking where the end *would* land with the naive offset
 * and taking the marking nearest to that, which is the one it is the continuation
 * of. Falling back to the naive offset when nothing is close enough matters: a
 * gore beside a segment with no markings at all — below the marking LOD, or a
 * profile with none — must still paint something sensible.
 */
function handOver(
  seg: Segment | undefined, c: Lane, endIndex: number,
  ux: number, uy: number, naive: number, tolerance: number,
): { w: number } {
  const ex = c.centerline[endIndex * 2];
  const ey = c.centerline[endIndex * 2 + 1];
  const result = { w: naive };
  if (!seg) return result;
  const gx = ex + ux * naive;
  const gy = ey + uy * naive;
  let best = Infinity;
  for (const m of seg.markings) {
    if (m.points.length < 4) continue;
    if (m.style !== 'edge') continue;
    closestOnPolyline(m.points, buildArclength(m.points), gx, gy, _hitM);
    if (_hitM.distance >= best) continue;
    const proj = (_hitM.x - ex) * ux + (_hitM.y - ey) * uy;
    // Only markings on this side of the connector: on a narrow road the far kerb
    // can easily be the nearer of the two.
    if (proj < 0) continue;
    best = _hitM.distance;
    result.w = proj;
  }
  if (best > tolerance) result.w = naive;
  return result;
}

/**
 * The two edge lines across a gore.
 *
 * A ramp's own edge markings stop where its segment stops, which is a connector's
 * length short of the carriageway it is joining — so the paint simply gives out and
 * picks up again on the far side. These carry it across: from the ramp's carriageway
 * edges at one end to the auxiliary lane's at the other, where the road's own edge
 * line and the auxiliary lane's dashed boundary take over. The nose forms itself,
 * because the connector converges on the auxiliary lane as it goes.
 */
function goreMarkings(
  connectors: Lane[], aux: Lane, roadSeg: Segment, rampAtStart: boolean, lanes: Lane[],
): Marking[] {
  // Only the movements that leave an auxiliary lane. A gore's paint marks the
  // exit-only corridor; an option lane is a through lane that happens to be able to
  // exit, and painting a solid line down its inner edge would say the opposite of
  // what an option lane means. Its own boundaries are painted by the segment.
  const all = connectors.filter((c) => c.centerline.length >= 4);
  const fromAux = all.filter((c) => {
    const road = lanes[rampAtStart ? c.successors[0] : c.predecessors[0]];
    return road?.aux === true;
  });
  const usable = fromAux.length ? fromAux : all;
  if (!usable.length) return [];

  // The gore point, and which way is away from the carriageway there.
  const first = usable[0];
  const roadEnd = rampAtStart ? (first.centerline.length >> 1) - 1 : 0;
  const px = first.centerline[roadEnd * 2], py = first.centerline[roadEnd * 2 + 1];
  const auxIdx = rampAtStart ? 0 : (aux.parentS.length - 1);
  samplePosition(roadSeg.centerline, roadSeg.arclength, aux.parentS[auxIdx], _p0);
  let ox = px - _p0.x, oy = py - _p0.y;
  const ol = Math.hypot(ox, oy);
  if (ol < 1e-6) return [];
  ox /= ol; oy /= ol;

  // Outermost and innermost ramp lane, by how far out their ramp end sits.
  let outer = usable[0], inner = usable[0];
  let outMost = -Infinity, inMost = Infinity;
  for (const c of usable) {
    const n = c.centerline.length >> 1;
    const i = rampAtStart ? 0 : n - 1;
    const d = (c.centerline[i * 2] - px) * ox + (c.centerline[i * 2 + 1] - py) * oy;
    if (d > outMost) { outMost = d; outer = c; }
    if (d < inMost) { inMost = d; inner = c; }
  }

  const wRoad = aux.width * 0.5;

  // Anything inboard of the exit-only corridor is another movement onto the same
  // ramp — an option lane's — so the line between them divides two lanes rather than
  // marking the edge of the carriageway, and is dashed like any other lane divider.
  let innerDivides = false;
  for (const c of all) {
    if (usable.includes(c)) continue;
    const n = c.centerline.length >> 1;
    const i = rampAtStart ? 0 : n - 1;
    const d = (c.centerline[i * 2] - px) * ox + (c.centerline[i * 2 + 1] - py) * oy;
    if (d < inMost - 1) innerDivides = true;
  }

  const out: Marking[] = [];
  for (const [c, side] of [[outer, 1], [inner, -1]] as const) {
    const n = c.centerline.length >> 1;
    const e = rampAtStart ? n - 1 : 0;
    const b = rampAtStart ? n - 2 : 1;
    // Direction as the centreline is *stored*, which is what offsetting is relative
    // to. Reading it backwards mirrors both lines about the connector — invisible
    // when a one-lane ramp puts them symmetrically either side of one movement, and
    // a swap that lands them both down the middle as soon as there are two.
    const i0 = rampAtStart ? b : e;
    const i1 = rampAtStart ? e : b;
    const dx = c.centerline[i1 * 2] - c.centerline[i0 * 2];
    const dy = c.centerline[i1 * 2 + 1] - c.centerline[i0 * 2 + 1];
    const dl = Math.hypot(dx, dy) || 1;
    // Right-hand normal of the connector's direction, pointed away from the road.
    const sign = (-dy / dl) * ox + (dx / dl) * oy >= 0 ? 1 : -1;
    // Half the *ramp lane*, not half the connector. A connector is as wide as the
    // auxiliary lane it blends into, and a ramp is usually built wider than a
    // freeway lane — so sizing the gore paint off the connector leaves the ramp's
    // own edge line starting a few centimetres beside where the gore one stopped,
    // and both lines carry a visible jog at the hand-over.
    const rampLane = lanes[rampAtStart ? c.predecessors[0] : c.successors[0]];
    const wRamp = (rampLane?.width ?? c.width) * 0.5;
    const total = c.length || 1;

    // Hand the road end over to what the road actually paints there, rather than
    // assuming half an auxiliary lane. A stack of auxiliary lanes puts the outermost
    // movement a lane or more further out than the innermost, and half a lane is
    // then plainly wrong; and the offset is applied along the *connector's* normal,
    // which at a gore runs at an angle to the road, so a distance measured
    // straight-line and applied along the normal lands beside the line rather than
    // on it. Projecting onto the direction the offset is actually applied in fixes
    // both at once.
    //
    // The *style* is left alone. One marking carries one style, and the two ends of
    // a gore line legitimately continue different ones: the inner line is the ramp's
    // carriageway edge where it leaves the ramp and the boundary between two
    // auxiliary lanes where it meets the road. Solid is the honest choice — it is
    // what marks the inside of an exit-only corridor — and it is what the option
    // lane rule below already overrides when the corridor has something inboard of
    // it.
    const ux = side * sign * (-dy / dl);
    const uy = side * sign * (dx / dl);
    // Only the road end. The ramp end is already exact by construction — half the
    // ramp lane from that lane's centreline *is* the ramp's carriageway edge — and
    // a nudge there only ever found a different one of the ramp's own markings.
    const road = handOver(roadSeg, c, e, ux, uy, wRoad, HAND_OVER);

    out.push({
      // The road end is the one that has to be right: it is where the gore's paint
      // meets the carriageway's, and where a mismatch reads as one line jogging
      // sideways rather than as two lines that do not meet.
      style: side < 0 && innerDivides ? 'dashed' : 'edge',
      points: offsetPolylineVariable(c.centerline, c.arclength, (t) => {
        let u = t / total;
        if (rampAtStart) u = 1 - u;
        const k = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
        return side * sign * (road.w + (wRamp - road.w) * k);
      }).points,
    });
  }
  return out;
}

/**
 * The through road's paint, carried across a right-in / right-out junction.
 *
 * The whole point of the arrangement is that the major road is not interrupted:
 * its median is unbroken and the far carriageway never knows the stem is there.
 * The segments are still trimmed back to the junction like any crossing's, so their
 * paint stops at the caps — and a box with no lines across it reads as a crossing
 * where every turn is possible, which is exactly what this is not. So every
 * boundary of every through lane is continued along its own through connector: the
 * dashed line between lanes, the median line on the inner edge, and the edge line on
 * the outer one — except on the near carriageway, whose kerb opens for the stem.
 *
 * The connector is the lane's own continuation, so offsetting it by half a lane
 * lands exactly on the marking it meets at each cap; which side of it the median
 * lies on is read from the road's centreline rather than assumed.
 */
function rightInRightOutMarkings(
  lanes: Lane[], segments: Segment[], junction: Junction, nearSide: 1 | -1,
): Marking[] {
  const out: Marking[] = [];
  for (const id of junction.connectorIds) {
    const c = lanes[id];
    if (c.turn !== TurnKind.Straight || c.centerline.length < 4) continue;
    const from = lanes[c.predecessors[0]];
    const seg = from ? segments[from.segmentId] : undefined;
    if (!from || !seg || from.aux) continue;
    const w = from.width;
    // Which way is the road's centre from where this lane ends: that is where the
    // median is, whichever side of the road the lane is on.
    const n = from.centerline.length;
    const ex = from.centerline[n - 2];
    const ey = from.centerline[n - 1];
    samplePosition(seg.centerline, seg.arclength, from.parentS[(n >> 1) - 1], _p0);
    const tx = c.centerline[2] - c.centerline[0];
    const ty = c.centerline[3] - c.centerline[1];
    // `offsetPolylineVariable` offsets a positive distance toward (-ty, tx).
    const toMedian = (-ty) * (_p0.x - ex) + tx * (_p0.y - ey) >= 0 ? 1 : -1;
    const along = (d: number): Float32Array =>
      offsetPolylineVariable(c.centerline, c.arclength, () => d).points;

    // Inner boundary: between lanes, or the median edge, or an undivided centre line
    // — the last emitted once rather than from both directions.
    if (from.left >= 0) {
      out.push({ style: 'dashed', points: along(toMedian * w * 0.5) });
    } else {
      const divided = seg.markings.some((m) => m.style === 'median');
      if (divided) out.push({ style: 'median', points: along(toMedian * w * 0.5) });
      else if (from.side === 1) out.push({ style: 'double', points: along(toMedian * w * 0.5) });
    }
    // Outer boundary: the carriageway edge, except where the stem opens onto it.
    if (from.right < 0 && from.side !== nearSide) {
      out.push({ style: 'edge', points: along(-toMedian * w * 0.5) });
    }
  }
  return out;
}

/** Bars of a pedestrian crossing, and how they sit relative to the road. */
const ZEBRA = {
  /** Depth of the crossing, along the traffic direction. */
  depth: 2.6,
  /** Centre-to-centre spacing of the bars, across the road. */
  pitch: 1.35,
  /** Clear of the stop bar, so the two do not touch. */
  standoff: 1.1,
} as const;

/**
 * A pedestrian crossing across each arm of a controlled junction.
 *
 * Only where the traffic is stopped by something other than a gap — a signal or an
 * all-way stop. At a priority junction the major road never stops, so a crossing
 * painted across it would be a promise the junction does not keep; those get a
 * refuge or a signal in reality, and nothing here.
 *
 * The bars run *along* the traffic direction and repeat across the carriageway,
 * which is what makes a zebra read as a zebra from above rather than as a ladder
 * lying the wrong way. They are emitted on the junction rather than the segment
 * because they sit past the segment's trimmed end, on the junction's own asphalt —
 * and because the control they depend on is only decided once the overrides have
 * been applied.
 */
function paintCrossings(segments: Segment[], junction: Junction): void {
  if (junction.control !== 'signal' && junction.control !== 'allway-stop') return;
  for (const approach of junction.approaches) {
    const seg = segments[approach.segmentId];
    if (!seg) continue;
    // Which end of this segment meets the junction, and the two asphalt corners
    // there. The cap is exactly as wide as the road and flush with both its edges,
    // which is what makes the crossing span the carriageway and no more.
    const atEnd = seg.endJunction === junction.id;
    const cap = atEnd ? seg.capEnd : seg.capStart;
    if (!cap || cap.length < 4) continue;
    const rx = cap[0], ry = cap[1], lx = cap[2], ly = cap[3];
    const width = Math.hypot(lx - rx, ly - ry);
    if (width < 3) continue;
    // Across the road, and into the junction.
    const ax = (lx - rx) / width;
    const ay = (ly - ry) / width;
    let ix = -ay;
    let iy = ax;
    const midX = (rx + lx) / 2;
    const midY = (ry + ly) / 2;
    if ((junction.x - midX) * ix + (junction.y - midY) * iy < 0) {
      ix = -ix;
      iy = -iy;
    }
    const from = ZEBRA.standoff;
    const to = from + ZEBRA.depth;
    const count = Math.max(2, Math.floor(width / ZEBRA.pitch));
    // Centred on the carriageway, so the gap either side is even rather than
    // whatever the division happened to leave at one end.
    const span = (count - 1) * ZEBRA.pitch;
    const start = (width - span) / 2;
    for (let i = 0; i < count; i++) {
      const d = start + i * ZEBRA.pitch;
      const bx = rx + ax * d;
      const by = ry + ay * d;
      junction.markings.push({
        style: 'zebra',
        points: new Float32Array([
          bx + ix * from, by + iy * from,
          bx + ix * to, by + iy * to,
        ]),
      });
    }
  }
}

/**
 * Paints each approach lane with the movements it can actually make, and the word
 * STOP where every approach has to come to rest.
 *
 * Read off the connectors rather than off the profile, so re-wiring a junction by
 * hand re-paints its approaches with no further ceremony.
 */
export function paintApproaches(
  lanes: Lane[], segments: Segment[], junction: Junction,
): void {
  if (junction.kind !== 'crossing') return;
  paintCrossings(segments, junction);
  // Far enough back to be read before the stop line, close enough to belong to it.
  const ARROW_AT = [11, 30];
  const STOP_AT = 19;
  for (const approach of junction.approaches) {
    const seg = segments[approach.segmentId];
    if (!seg) continue;
    for (const id of approach.incomingLanes) {
      const lane = lanes[id];
      const turns: TurnKind[] = [];
      for (const cid of lane.successors) {
        const turn = lanes[cid]?.turn;
        if (turn !== undefined && !turns.includes(turn)) turns.push(turn);
      }
      if (!turns.length) continue;
      turns.sort((a, b) => a - b);

      const place = (back: number, kind: 'arrow' | 'stop'): void => {
        const at = lane.length - back;
        // Never so far back that the arrow lands before the lane exists, nor so
        // close that it sits under the stop bar.
        if (at < Math.max(lane.startsAt, 0) + 4 || at > lane.length - 4) return;
        samplePosition(lane.centerline, lane.arclength, at, _p0);
        sampleTangent(lane.centerline, lane.arclength, at, _t0);
        seg.symbols.push({
          kind,
          x: _p0.x,
          y: _p0.y,
          heading: Math.atan2(_t0.y, _t0.x),
          turns: kind === 'arrow' ? turns : [],
          width: lane.width,
        });
      };
      for (const back of ARROW_AT) place(back, 'arrow');
      if (junction.control === 'allway-stop') place(STOP_AT, 'stop');
    }
  }
}

/** The override authored for this junction, matched the way control choices are. */
/**
 * Whether a gore's hand-wiring names a *through* lane of the road it meets.
 *
 * Auxiliary lanes already begin or end at the gore, so wiring one needs nothing
 * special. A through lane runs straight past — the mainline is deliberately not
 * split at a merge or a diverge — so to branch off it, or to be joined by a ramp,
 * it first has to have an end there. That is the same split an option lane asks
 * for, and it is only made where the document actually wires one.
 */
export function goreWiresThroughLane(
  all: ReadonlyArray<LaneLinkOverride>, plan: RampPlan, roadStrokeId: number,
): boolean {
  const override = findLaneLinks(all, plan.meeting.x, plan.meeting.y, 0);
  if (!override) return false;
  for (const link of override.links) {
    for (const key of [link.from, link.to]) {
      const parts = key.split(':');
      if (parts.length < 3) continue;
      if (Number(parts[0]) !== roadStrokeId) continue;
      // Through lanes take slot 0 upward; auxiliary lanes take the negative ones.
      if (Number(parts[2]) >= 0) return true;
    }
  }
  return false;
}

function findLaneLinks(
  all: ReadonlyArray<LaneLinkOverride>, x: number, y: number, radius: number,
): LaneLinkOverride | null {
  const tolerance = Math.max(8, radius * 1.5);
  let best: LaneLinkOverride | null = null;
  let bestD = Infinity;
  for (const candidate of all) {
    const d = Math.hypot(candidate.x - x, candidate.y - y);
    if (d < bestD && d <= tolerance) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * Name of a lane as an override refers to it: `strokeId:side:index`.
 *
 * Lane ids are derived data and change on every recompile, so a saved override has
 * to name lanes by something the edit model owns.
 */
export function laneKeyOf(lane: Lane, segments: Segment[]): string {
  const seg = segments[lane.segmentId];
  if (!seg) return '';
  return `${seg.strokeId}:${lane.side}:${lane.index}`;
}

/** Every crossing point between two connectors, recorded on both. */
/**
 * A connector's bounding box, and one per polyline segment of it.
 *
 * Built once per connector and reused for every pair, because the pairs are the
 * expensive part: a junction's connectors mostly do *not* cross each other — parallel
 * movements, movements to opposite arms — and `addConflicts` returns as soon as it
 * finds a crossing, so the pairs that cost the most are exactly the ones with nothing
 * to find. On an imported city that was 304 seconds of a 306-second compile.
 */
interface ConnectorBounds {
  minX: number; minY: number; maxX: number; maxY: number;
  segMinX: Float32Array; segMinY: Float32Array;
  segMaxX: Float32Array; segMaxY: Float32Array;
}

function boundsOfConnector(lane: Lane): ConnectorBounds {
  const n = Math.max(0, (lane.centerline.length >> 1) - 1);
  const segMinX = new Float32Array(n), segMinY = new Float32Array(n);
  const segMaxX = new Float32Array(n), segMaxY = new Float32Array(n);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const ax = lane.centerline[i * 2], ay = lane.centerline[i * 2 + 1];
    const bx = lane.centerline[i * 2 + 2], by = lane.centerline[i * 2 + 3];
    segMinX[i] = Math.min(ax, bx); segMaxX[i] = Math.max(ax, bx);
    segMinY[i] = Math.min(ay, by); segMaxY[i] = Math.max(ay, by);
    minX = Math.min(minX, segMinX[i]); maxX = Math.max(maxX, segMaxX[i]);
    minY = Math.min(minY, segMinY[i]); maxY = Math.max(maxY, segMaxY[i]);
  }
  return { minX, minY, maxX, maxY, segMinX, segMinY, segMaxX, segMaxY };
}

function addConflicts(a: Lane, b: Lane, ba: ConnectorBounds, bb: ConnectorBounds): void {
  // Nowhere near each other: nothing to test, and this is the common case.
  if (ba.minX > bb.maxX || bb.minX > ba.maxX || ba.minY > bb.maxY || bb.minY > ba.maxY) return;
  const an = a.centerline.length >> 1;
  const bn = b.centerline.length >> 1;
  for (let i = 0; i < an - 1; i++) {
    if (ba.segMinX[i] > bb.maxX || ba.segMaxX[i] < bb.minX
      || ba.segMinY[i] > bb.maxY || ba.segMaxY[i] < bb.minY) continue;
    const ax = a.centerline[i * 2], ay = a.centerline[i * 2 + 1];
    const bx = a.centerline[i * 2 + 2], by = a.centerline[i * 2 + 3];
    for (let j = 0; j < bn - 1; j++) {
      if (ba.segMinX[i] > bb.segMaxX[j] || ba.segMaxX[i] < bb.segMinX[j]
        || ba.segMinY[i] > bb.segMaxY[j] || ba.segMaxY[i] < bb.segMinY[j]) continue;
      if (!segmentIntersect(
        ax, ay, bx, by,
        b.centerline[j * 2], b.centerline[j * 2 + 1],
        b.centerline[j * 2 + 2], b.centerline[j * 2 + 3], _hit,
      )) continue;
      const sSelf = a.arclength[i] + (a.arclength[i + 1] - a.arclength[i]) * _hit.t;
      const sOther = b.arclength[j] + (b.arclength[j + 1] - b.arclength[j]) * _hit.u;
      const adx = bx - ax, ady = by - ay;
      const bdx = b.centerline[j * 2 + 2] - b.centerline[j * 2];
      const bdy = b.centerline[j * 2 + 3] - b.centerline[j * 2 + 1];
      const la = Math.hypot(adx, ady) || 1;
      const lb = Math.hypot(bdx, bdy) || 1;
      const angle = Math.acos(Math.max(-1, Math.min(1, (adx * bdx + ady * bdy) / (la * lb))));
      a.conflicts.push({ other: b.id, sSelf, sOther, angle });
      b.conflicts.push({ other: a.id, sSelf: sOther, sOther: sSelf, angle });
      return; // one crossing per pair is enough for gap acceptance
    }
  }
}

const TURN_ORDER: Record<number, number> = {
  [TurnKind.Straight]: 0,
  [TurnKind.Merge]: 0,
  [TurnKind.Diverge]: 0,
  [TurnKind.Right]: 1,
  [TurnKind.Left]: 2,
  [TurnKind.UTurn]: 3,
};

/**
 * A strict total order over a junction's connectors. Sorting with a unique final
 * tie-break makes priority cycles structurally impossible, which is what keeps
 * all-yield deadlocks off the table.
 */
function assignPriority(lanes: Lane[], connectorIds: number[], weightOf: Map<number, number>): void {
  const ordered = [...connectorIds].sort((x, y) => {
    const a = lanes[x];
    const b = lanes[y];
    const wa = weightOf.get(a.id) ?? 0;
    const wb = weightOf.get(b.id) ?? 0;
    if (wa !== wb) return wb - wa;
    const ta = TURN_ORDER[a.turn] ?? 3;
    const tb = TURN_ORDER[b.turn] ?? 3;
    if (ta !== tb) return ta - tb;
    const ia = lanes[a.predecessors[0]]?.index ?? 0;
    const ib = lanes[b.predecessors[0]]?.index ?? 0;
    if (ia !== ib) return ia - ib;
    return a.id - b.id;
  });
  for (let i = 0; i < ordered.length; i++) lanes[ordered[i]].priorityRank = i;
  for (const id of connectorIds) {
    const lane = lanes[id];
    lane.yields = lane.conflicts.some((c) => lanes[c.other].priorityRank < lane.priorityRank);
  }
}


/**
 * Wires through lanes across a joint, aligning from the median outward so a road
 * that loses a lane loses its kerb-side one. Auxiliary lanes never cross a joint:
 * they belong to their own segment, and counting them would shift the whole
 * cross-section mapping and connect the wrong lanes.
 */
function wireLink(fromAll: Lane[], toAll: Lane[]): void {
  const from = fromAll.filter((l) => !l.aux);
  const to = toAll.filter((l) => !l.aux);
  const shift = from.length - to.length;
  for (const lane of from) {
    const dst = to.find((l) => l.index === lane.index - shift);
    if (!dst) continue;
    lane.successors.push(dst.id);
    dst.predecessors.push(lane.id);
  }
}

/**
 * Same, for a plain split where the cross-section is unchanged.
 *
 * `handWired` is the carriageway a gore's own wiring has taken over, if any. Its
 * through movements are named in the override along with the ramp's, because "this
 * lane carries on" and "this lane exits" are the same choice made twice — and wiring
 * them here as well would put the through movement back whatever the document said,
 * which is the one arrangement a driver in an exit-only lane cannot use.
 */
function joinBySlot(from: Lane[], to: Lane[], handWired: 1 | -1 | 0 = 0): void {
  for (const lane of from) {
    if (lane.aux || lane.side === handWired) continue;
    const dst = to.find((l) => !l.aux && l.index === lane.index);
    if (!dst) continue;
    lane.successors.push(dst.id);
    dst.predecessors.push(lane.id);
  }
}

function findSegmentAtStrokeEnd(
  ranges: SegmentRange[], strokeIdx: number, atEnd: 1 | -1,
): number {
  let best = -1;
  let bestS = atEnd === 1 ? -Infinity : Infinity;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.strokeIdx !== strokeIdx) continue;
    if (atEnd === 1 ? r.s1 > bestS : r.s0 < bestS) {
      bestS = atEnd === 1 ? r.s1 : r.s0;
      best = i;
    }
  }
  return best;
}

function makeApproach(lanes: Lane[], segments: Segment[], segId: number, atEnd: boolean): Approach {
  const seg = segments[segId];
  const { incoming, outgoing } = lanesAt(lanes, seg, atEnd);
  const speed = incoming.length
    ? Math.max(...incoming.map((l) => l.speedLimit))
    : outgoing.length ? Math.max(...outgoing.map((l) => l.speedLimit)) : 10;
  return {
    segmentId: segId,
    atSegmentEnd: atEnd,
    heading: approachHeading(seg, atEnd),
    incomingLanes: incoming.map((l) => l.id),
    outgoingLanes: outgoing.map((l) => l.id),
    // Traffic already going round a roundabout has priority over everything trying
    // to get on. Weight is what the compiler ranks approaches by, so saying it here
    // says it once: the circulating arm outranks the entries, the entries yield to
    // it, and — because the arms are then nothing like comparable — the junction
    // keeps priority control rather than being handed signals or an all-way stop.
    // A roundabout whose every entry is an all-way stop is not a roundabout, and
    // one where the circulating traffic gives way deadlocks the moment it fills.
    weight: Math.max(incoming.length, outgoing.length) * speed
      * (seg.roundabout ? ROUNDABOUT_PRIORITY : 1),
  };
}

/**
 * How much an approach outranks the others for being the circulating carriageway.
 *
 * Big enough that no combination of lanes and speed on an entering arm can outweigh
 * it: an entry is always the one that gives way.
 */
const ROUNDABOUT_PRIORITY = 1000;

export function buildJunctions(inputs: JunctionInputs): {
  junctions: Junction[];
  diagnostics: Diagnostic[];
} {
  const {
    meetings, segments, ranges, lanes, links, rampPlans, auxPlans, auxLaneByPlan, strokes,
  } = inputs;
  const laneLinks = inputs.laneLinks ?? [];
  const diagnostics: Diagnostic[] = [];
  const junctions: Junction[] = [];

  const touches = new Map<number, Touch[]>();
  const addTouch = (mi: number, t: Touch): void => {
    const list = touches.get(mi);
    if (list) {
      if (!list.some((x) => x.segId === t.segId && x.atEnd === t.atEnd)) list.push(t);
    } else {
      touches.set(mi, [t]);
    }
  };
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].startMeeting >= 0) addTouch(ranges[i].startMeeting, { segId: i, atEnd: false });
    if (ranges[i].endMeeting >= 0) addTouch(ranges[i].endMeeting, { segId: i, atEnd: true });
  }

  // --- crossing junctions -------------------------------------------------------
  for (let mi = 0; mi < meetings.length; mi++) {
    const meeting = meetings[mi];
    if (meeting.kind !== 'crossing') continue;
    const list = touches.get(mi) ?? [];
    if (list.length < 2) {
      if (list.length === 1) {
        diagnostics.push({
          severity: 'warning', code: 'orphan-junction',
          message: 'A junction lost all but one of its roads and was dropped.',
          x: meeting.x, y: meeting.y,
        });
      }
      continue;
    }
    list.sort((a, b) => a.segId - b.segId || Number(a.atEnd) - Number(b.atEnd));

    const junctionId = junctions.length;
    const approaches = list.map((t) => makeApproach(lanes, segments, t.segId, t.atEnd));
    const connectorIds: number[] = [];
    const weightOf = new Map<number, number>();

    // Hand-wired movements replace the whole allocation for this junction: half a
    // set would be worse than either, since the compiler's layout assumes it owns
    // every lane.
    let override = findLaneLinks(laneLinks, meeting.x, meeting.y, meeting.radius);
    if (override) {
      const incoming = new Map<string, { id: number; approach: Approach }>();
      const outgoing = new Map<string, { id: number; approach: Approach }>();
      for (const approach of approaches) {
        for (const id of approach.incomingLanes) incoming.set(laneKeyOf(lanes[id], segments), { id, approach });
        for (const id of approach.outgoingLanes) outgoing.set(laneKeyOf(lanes[id], segments), { id, approach });
      }
      for (const link of override.links) {
        const src = incoming.get(link.from);
        const dst = outgoing.get(link.to);
        if (!src || !dst || src.approach === dst.approach) {
          diagnostics.push({
            severity: 'warning', code: 'lane-link-stale',
            message: 'A hand-made junction movement refers to a lane that is no longer there.',
            x: meeting.x, y: meeting.y,
          });
          continue;
        }
        const turn = classifyTurn(src.approach.heading, dst.approach.heading + Math.PI);
        const conn = buildConnector(lanes, junctionId, lanes[src.id], lanes[dst.id], turn);
        connectorIds.push(conn.id);
        weightOf.set(conn.id, src.approach.weight);
      }
      // An override where *nothing* resolved is not a junction wired differently, it
      // is a broken edit — and honouring it leaves a crossing with no movements at
      // all, which is a hole in the network rather than a choice anybody made. Hand
      // it back to the compiler and say so, exactly as a signal plan with no usable
      // phase is dropped rather than left sitting on all-red.
      if (!connectorIds.length) {
        diagnostics.push({
          severity: 'warning', code: 'lane-links-unusable',
          message: 'None of the hand-made movements at this junction could be built, '
            + 'so the automatic ones were used instead.',
          x: meeting.x, y: meeting.y,
        });
        override = null;
      }
    }

    // Right-in / right-out: only the kerb-side turns, so nothing crosses the median.
    //
    // It needs a T — three arms, exactly one with nothing opposite it (the stem) —
    // and the stem needs somewhere to turn: a near carriageway with lanes running
    // *away* from the junction. Anything else gets the ordinary allocation and a
    // diagnostic saying why, rather than a junction with a stem nobody can leave.
    const kerbTurn = inputs.driveOnRight ? TurnKind.Right : TurnKind.Left;
    let riro = !override && (inputs.rightInRightOutAt?.(meeting.x, meeting.y, meeting.radius) ?? false);
    let stem: Approach | null = null;
    let nearSide: 1 | -1 = 1;
    if (riro) {
      const live = approaches.filter((a) => a.incomingLanes.length || a.outgoingLanes.length);
      const opposite = (a: Approach, b: Approach): boolean => Math.cos(a.heading - b.heading) < -0.866;
      const stems = live.filter((a) => !live.some((b) => b !== a && opposite(a, b)));
      stem = live.length === 3 && stems.length === 1 ? stems[0] : null;
      const near = stem
        ? live.find((to) => to !== stem && to.outgoingLanes.length > 0
          && classifyTurn(stem!.heading, to.heading + Math.PI) === kerbTurn)
        : undefined;
      if (!stem || !stem.incomingLanes.length || !near) {
        diagnostics.push({
          severity: 'warning', code: 'right-in-right-out-shape',
          message: !stem
            ? 'Right-in / right-out needs a T: three arms, one of them a stem. Every turn was allowed here instead.'
            : 'Right-in / right-out needs a carriageway the stem can turn onto. Every turn was allowed here instead.',
          x: meeting.x, y: meeting.y,
        });
        riro = false;
        stem = null;
      } else {
        nearSide = lanes[near.outgoingLanes[0]].side;
      }
    }

    for (const from of approaches) {
      if (!from.incomingLanes.length) continue;
      const candidates = approaches
        .filter((to) => to.outgoingLanes.length > 0)
        .map((to) => ({
          to,
          turn: classifyTurn(from.heading, to.heading + Math.PI),
          delta: wrapAngle(to.heading + Math.PI - from.heading),
        }))
        .filter((c) => c.to !== from);
      let moves = candidates.filter((c) => c.turn !== TurnKind.UTurn);
      if (!moves.length) {
        moves = approaches
          .filter((to) => to.outgoingLanes.length > 0)
          .map((to) => ({
            to,
            turn: TurnKind.UTurn,
            delta: wrapAngle(to.heading + Math.PI - from.heading),
          }));
      }
      if (!moves.length) continue;
      moves.sort((a, b) => b.delta - a.delta || a.to.segmentId - b.to.segmentId);

      if (override) continue;
      if (riro) {
        // The stem keeps its kerb-side turn and nothing else; a carriageway keeps
        // straight on, plus the kerb-side turn into the stem — which only the near
        // one has, because from the far one the stem is a left across the median.
        moves = moves.filter((m) => m.turn === TurnKind.Straight
          || (m.turn === kerbTurn && (from === stem || m.to === stem)));
        if (!moves.length) continue;
      }
      const blocks = allocateBlocks(from.incomingLanes.length, moves.map((m) => m.turn));
      for (let k = 0; k < moves.length; k++) {
        const move = moves[k];
        const block = blocks[k];
        if (!block) continue;
        const dsts = move.to.outgoingLanes;
        const size = block.hi - block.lo;
        for (let i = 0; i < size; i++) {
          const src = lanes[from.incomingLanes[block.lo + i]];
          const dst = move.turn === TurnKind.Left
            ? lanes[dsts[Math.max(0, dsts.length - 1 - (size - 1 - i))]]
            : lanes[dsts[Math.min(i, dsts.length - 1)]];
          if (!src || !dst) continue;
          const conn = buildConnector(lanes, junctionId, src, dst, move.turn);
          connectorIds.push(conn.id);
          weightOf.set(conn.id, from.weight);
        }
      }
    }

    // Nothing may dead-end inside a junction — unless the movements were written out
    // by hand, in which case filling the gaps back in would quietly undo the edit.
    // Say so instead, so a lane with no way out is a warning rather than a surprise.
    for (const approach of approaches) {
      for (const id of approach.incomingLanes) {
        const lane = lanes[id];
        if (lane.successors.length) continue;
        if (override) {
          diagnostics.push({
            severity: 'warning', code: 'lane-link-dead-end',
            message: 'A lane runs into this junction with no way out of it.',
            x: meeting.x, y: meeting.y,
          });
          continue;
        }
        const target = approaches.find((a) => a !== approach && a.outgoingLanes.length);
        if (!target) continue;
        const dst = lanes[target.outgoingLanes[Math.min(lane.index < 0 ? 0 : lane.index, target.outgoingLanes.length - 1)]];
        const conn = buildConnector(lanes, junctionId, lane, dst,
          classifyTurn(approach.heading, target.heading + Math.PI));
        connectorIds.push(conn.id);
        weightOf.set(conn.id, approach.weight);
      }
    }

    const bounds = connectorIds.map((id) => boundsOfConnector(lanes[id]));
    for (let i = 0; i < connectorIds.length; i++) {
      for (let j = i + 1; j < connectorIds.length; j++) {
        const a = lanes[connectorIds[i]];
        const b = lanes[connectorIds[j]];
        if (a.predecessors[0] === b.predecessors[0]) continue;
        if (a.successors[0] === b.successors[0]) {
          a.conflicts.push({ other: b.id, sSelf: a.length, sOther: b.length, angle: 0 });
          b.conflicts.push({ other: a.id, sSelf: b.length, sOther: a.length, angle: 0 });
          continue;
        }
        addConflicts(a, b, bounds[i], bounds[j]);
      }
    }
    assignPriority(lanes, connectorIds, weightOf);

    // Priority control only works when there is a clear pecking order: the strict
    // total order the compiler assigns means the lowest-ranked approach yields to
    // everyone, which starves it if the roads are actually comparable. So roads of
    // similar importance meeting at a crossing get signals, and a minor road
    // joining a major one keeps priority - which is how real networks are built.
    const live = approaches.filter((a) => a.incomingLanes.length > 0);
    const weights = live.map((a) => a.weight);
    const comparable = weights.length > 0 && Math.min(...weights) >= 0.6 * Math.max(...weights);
    // Signals are also a question of scale: two residential streets crossing get
    // priority control, because signalising them would meter traffic that was never
    // going to conflict much in the first place.
    const arterialScale = live.some((a) => a.incomingLanes.length >= 2);
    // Nothing on a roundabout is signalised or made an all-way stop by the compiler.
    // The document can still ask for signals — some big ones are metered — but that
    // has to be a choice somebody made rather than the default.
    const circulating = approaches.some((a) => segments[a.segmentId]?.roundabout);
    const useSignal = !riro && !circulating && approaches.length >= 3 && comparable && arterialScale;
    // Comparable roads that are too small for signals get an all-way stop, which is
    // what these junctions have in the real world and the only control that shares
    // a small four-way fairly: a fixed priority order simply starves the last road.
    const useAllWayStop = !riro && !circulating && !useSignal && approaches.length >= 3 && comparable;

    const junction: Junction = {
      id: junctionId,
      kind: 'crossing',
      x: meeting.x,
      y: meeting.y,
      radius: meeting.radius,
      grade: meeting.grade,
      markings: [],
      footprint: junctionFootprint(
        meeting, segments, list, ranges, strokes, connectorIds.map((id) => lanes[id])),
      connectorIds,
      approaches,
      control: useSignal ? 'signal' : useAllWayStop ? 'allway-stop' : 'priority',
      turnOnRed: true,
    };
    if (riro && stem) {
      junction.rightInRightOut = true;
      junction.markings.push(...rightInRightOutMarkings(lanes, segments, junction, nearSide));
    }
    if (useSignal) junction.signal = buildSignalPlan(lanes, segments, approaches, connectorIds);
    junctions.push(junction);
    for (const t of list) {
      if (t.atEnd) segments[t.segId].endJunction = junctionId;
      else segments[t.segId].startJunction = junctionId;
    }
  }

  // --- links: lanes continue straight through, no connector ---------------------
  for (const link of links) {
    const segA = findSegmentAtStrokeEnd(ranges, link.a.strokeIdx, link.a.atEnd);
    const segB = findSegmentAtStrokeEnd(ranges, link.b.strokeIdx, link.b.atEnd);
    if (segA < 0 || segB < 0) continue;
    const atEndA = link.a.atEnd === 1;
    const atEndB = link.b.atEnd === 1;
    const a = lanesAt(lanes, segments[segA], atEndA);
    const b = lanesAt(lanes, segments[segB], atEndB);

    // Only through lanes cross a link. Auxiliary lanes belong to their own segment
    // and end (or begin) inside it, and counting them here would shift the whole
    // cross-section mapping and wire the wrong lanes together.
    wireLink(a.incoming, b.outgoing);
    wireLink(b.incoming, a.outgoing);

    const junctionId = junctions.length;
    junctions.push({
      id: junctionId,
      kind: 'link',
      markings: [],
      x: link.x,
      y: link.y,
      radius: 0,
      grade: segments[segA].grade,
      footprint: new Float32Array(0),
      connectorIds: [],
      approaches: [
        makeApproach(lanes, segments, segA, atEndA),
        makeApproach(lanes, segments, segB, atEndB),
      ],
      control: 'priority',
      turnOnRed: true,
    });
    if (atEndA) segments[segA].endJunction = junctionId; else segments[segA].startJunction = junctionId;
    if (atEndB) segments[segB].endJunction = junctionId; else segments[segB].startJunction = junctionId;
  }

  // --- plain splits: same stroke, no junction, lanes wire straight across --------
  // Except where a gore's hand-wiring owns that carriageway: see `joinBySlot`.
  const wiredSplits: { strokeIdx: number; s: number; side: 1 | -1 }[] = [];
  for (const plan of rampPlans) {
    const roadStrokeId = strokes[plan.roadStrokeIdx]?.stroke.id;
    if (roadStrokeId === undefined) continue;
    if (!goreWiresThroughLane(laneLinks, plan, roadStrokeId)) continue;
    wiredSplits.push({ strokeIdx: plan.roadStrokeIdx, s: plan.sGoreRoad, side: plan.roadSide });
  }
  const takenOver = (strokeIdx: number, s: number): 1 | -1 | 0 => {
    for (const w of wiredSplits) {
      if (w.strokeIdx === strokeIdx && Math.abs(w.s - s) < 1) return w.side;
    }
    return 0;
  };
  for (let a = 0; a < ranges.length; a++) {
    for (let b = 0; b < ranges.length; b++) {
      if (a === b) continue;
      const ra = ranges[a];
      const rb = ranges[b];
      if (ra.strokeIdx !== rb.strokeIdx) continue;
      if (ra.endMeeting >= 0 || rb.startMeeting >= 0) continue;
      if (Math.abs(ra.s1 - rb.s0) > 0.01) continue;
      const first = lanesAt(lanes, segments[a], true);
      const second = lanesAt(lanes, segments[b], false);
      const owned = takenOver(ra.strokeIdx, ra.s1);
      joinBySlot(first.incoming, second.outgoing, owned);
      joinBySlot(second.incoming, first.outgoing, owned);
    }
  }

  // --- merges and diverges: blend the ramp into its auxiliary lane ---------------
  // A ramp's auxiliary lanes, innermost first: a multi-lane ramp gets one each and
  // they pair off lane for lane rather than all funnelling through one.
  const auxLanesForRamp = new Map<RampPlan, { depth: number; laneId: number }[]>();
  const remember = (ramp: RampPlan | null, depth: number, laneId: number): void => {
    if (!ramp) return;
    const list = auxLanesForRamp.get(ramp);
    if (list) list.push({ depth, laneId });
    else auxLanesForRamp.set(ramp, [{ depth, laneId }]);
  };
  for (const plan of auxPlans) {
    const laneId = auxLaneByPlan.get(plan.id);
    if (laneId === undefined) continue;
    remember(plan.mergeFrom, plan.depth, laneId);
    remember(plan.divergeTo, plan.depth, laneId);
  }
  for (const list of auxLanesForRamp.values()) list.sort((a, b) => a.depth - b.depth);

  for (const plan of rampPlans) {
    const auxStack = auxLanesForRamp.get(plan) ?? [];
    const segId = findSegmentAtStrokeEnd(ranges, plan.rampStrokeIdx, plan.rampEnd);
    if (segId < 0) continue;
    const atEnd = plan.rampEnd === 1;
    const rampLanes = lanesAt(lanes, segments[segId], atEnd);
    // The through lane that may take the exit as well as carrying on. With an option
    // lane the ramp gets one auxiliary lane fewer, so on a one-lane exit there is no
    // auxiliary lane at all and this is the gore's only road-side reference.
    const option = plan.optionLane ? optionLaneAt(lanes, segments, ranges, plan) : null;
    if (!auxStack.length && !option) {
      diagnostics.push({
        severity: 'error', code: 'ramp-no-aux-lane',
        message: 'A ramp could not be connected: its auxiliary lane was not built.',
        x: plan.meeting.x, y: plan.meeting.y,
      });
      continue;
    }
    if (plan.optionLane && !option) {
      diagnostics.push({
        severity: 'warning', code: 'option-lane-impossible',
        message: 'There is not enough road either side of this exit for an option lane.',
        x: plan.meeting.x, y: plan.meeting.y,
      });
    }
    const aux = auxStack.length ? lanes[auxStack[0].laneId] : option!;
    // The ramp lane nearest the carriageway takes the innermost auxiliary lane. Which
    // of the ramp's lanes that is depends on the side the ramp came in from.
    const outward = plan.auxDir > 0;
    const rampCount = Math.max(1, plan.rampLanes);
    const auxFor = (index: number): Lane => {
      const wanted = outward ? rampCount - 1 - index : index;
      const pick = auxStack[Math.min(Math.max(wanted, 0), auxStack.length - 1)];
      return lanes[pick.laneId];
    };

    const junctionId = junctions.length;
    const connectorIds: number[] = [];
    const weightOf = new Map<number, number>();

    const isMerge = plan.kind === 'merge';
    // A gore can be wired by hand too: which lane of a two-lane ramp joins which
    // auxiliary lane is a real choice, and the compiler's lane-for-lane pairing is
    // only the sensible default. As at a crossing, an override replaces the whole
    // set — half of one would leave the rest of the gore assuming it owns every lane.
    const goreOverride = findLaneLinks(laneLinks, plan.meeting.x, plan.meeting.y, 0);
    let wired = false;
    if (goreOverride) {
      const rampSide = new Map<string, Lane>();
      for (const lane of isMerge ? rampLanes.incoming : rampLanes.outgoing) {
        rampSide.set(laneKeyOf(lane, segments), lane);
      }
      // The road side is every mainline lane with an end at the gore, not just the
      // auxiliary ones. A through lane only has an end here when the document wired
      // one — the split is made for exactly that — and once it does, the choices a
      // real gore offers all become expressible: a lane that carries on *and* exits,
      // a lane that may only exit, two lanes feeding one ramp lane.
      const roadIn = new Map<string, Lane>();
      const roadOut = new Map<string, Lane>();
      for (const entry of auxStack) {
        const lane = lanes[entry.laneId];
        (isMerge ? roadOut : roadIn).set(laneKeyOf(lane, segments), lane);
      }
      for (const { lane, incoming } of roadLanesAtGore(lanes, segments, ranges, plan)) {
        (incoming ? roadIn : roadOut).set(laneKeyOf(lane, segments), lane);
      }
      const roadSide = isMerge ? roadOut : roadIn;
      const resolved: { from: Lane; to: Lane; through: boolean }[] = [];
      for (const link of goreOverride.links) {
        // A through movement: one mainline lane carrying on into the next. Written
        // road to road, and at a split the two sides share a name, so the ends are
        // told apart by which map they are looked up in rather than by the key.
        const carryFrom = roadIn.get(link.from);
        const carryTo = roadOut.get(link.to);
        if (carryFrom && carryTo) {
          resolved.push({ from: carryFrom, to: carryTo, through: true });
          continue;
        }
        // A merge runs ramp to road and a diverge road to ramp; naming them the
        // other way round would build a connector nobody can drive.
        const from = isMerge ? rampSide.get(link.from) : roadSide.get(link.from);
        const to = isMerge ? roadSide.get(link.to) : rampSide.get(link.to);
        if (from && to) {
          resolved.push({ from, to, through: false });
          continue;
        }
        // Say which of the two it is. "That lane is gone" sends somebody looking for
        // a road they did not delete; a pair named the wrong way round is the far
        // likelier mistake, because at a gore the two halves live on different roads
        // and there is nothing on screen to say which end is which.
        const swapped = (isMerge ? roadSide.get(link.from) : rampSide.get(link.from))
          && (isMerge ? rampSide.get(link.to) : roadSide.get(link.to));
        diagnostics.push(swapped
          ? {
            severity: 'warning', code: 'lane-link-reversed',
            message: isMerge
              ? 'A hand-made entrance movement runs from the road to the ramp. An '
                + 'entrance runs the other way.'
              : 'A hand-made exit movement runs from the ramp to the road. An exit '
                + 'runs the other way.',
            x: plan.meeting.x, y: plan.meeting.y,
          }
          : {
            severity: 'warning', code: 'lane-link-stale',
            message: 'A hand-made ramp movement refers to a lane that is no longer there.',
            x: plan.meeting.x, y: plan.meeting.y,
          });
      }
      if (resolved.length) {
        wired = true;
        for (const { from, to, through } of resolved) {
          if (through) {
            // A plain joint, geometrically continuous: the lanes abut, so wiring
            // them is a successor rather than a connector to drive round.
            from.successors.push(to.id);
            to.predecessors.push(from.id);
            continue;
          }
          const conn = buildConnector(lanes, junctionId, from, to,
            isMerge ? TurnKind.Merge : TurnKind.Diverge);
          connectorIds.push(conn.id);
          weightOf.set(conn.id, from.speedLimit);
        }
        // Hand-wiring replaces the whole set, through movements included, so it can
        // leave a lane with no way out — which on a mainline is a hole in the road
        // rather than a lane that merely ends. Say so; filling it back in would
        // quietly undo the edit, the way it would at a crossing.
        for (const lane of roadIn.values()) {
          if (lane.successors.length || lane.mergeTarget >= 0) continue;
          diagnostics.push({
            severity: 'warning', code: 'lane-link-dead-end',
            message: 'A lane runs into this gore with no way out of it.',
            x: plan.meeting.x, y: plan.meeting.y,
          });
        }
      } else {
        // Nothing usable: fall back rather than leaving a gore with no movements,
        // which is a place traffic vanishes in the middle of a motorway.
        diagnostics.push({
          severity: 'warning', code: 'lane-links-unusable',
          message: 'None of the hand-made movements at this gore could be built, '
            + 'so the automatic ones were used instead.',
          x: plan.meeting.x, y: plan.meeting.y,
        });
      }
    }
    if (wired) {
      // Already built above.
    } else if (isMerge) {
      const sources = rampLanes.incoming;
      for (const src of sources) {
        const conn = buildConnector(lanes, junctionId, src, auxFor(src.index), TurnKind.Merge);
        connectorIds.push(conn.id);
        weightOf.set(conn.id, src.speedLimit * (sources.length - src.index));
      }
    } else {
      // Road-side feeders, innermost first: the option lane is a through lane and so
      // sits inboard of every auxiliary lane, which stack outward from there. Ramp
      // lanes ordered the same way pair up nose to tail; where there are more
      // feeders than ramp lanes the extras converge on the outermost one, which is
      // what a one-lane exit fed by both a deceleration lane and an option lane is.
      const feeders: Lane[] = option ? [option] : [];
      for (const entry of auxStack) feeders.push(lanes[entry.laneId]);
      const dsts = outward ? [...rampLanes.outgoing].reverse() : [...rampLanes.outgoing];
      for (let i = 0; i < feeders.length && dsts.length; i++) {
        const dst = dsts[Math.min(i, dsts.length - 1)];
        const conn = buildConnector(lanes, junctionId, feeders[i], dst, TurnKind.Diverge);
        connectorIds.push(conn.id);
        weightOf.set(conn.id, feeders[i].speedLimit);
      }
    }

    for (let i = 0; i < connectorIds.length; i++) {
      for (let j = i + 1; j < connectorIds.length; j++) {
        const ca = lanes[connectorIds[i]];
        const cb = lanes[connectorIds[j]];
        if (ca.predecessors[0] === cb.predecessors[0]) continue;
        if (ca.successors[0] === cb.successors[0]) {
          ca.conflicts.push({ other: cb.id, sSelf: ca.length, sOther: cb.length, angle: 0 });
          cb.conflicts.push({ other: ca.id, sSelf: cb.length, sOther: ca.length, angle: 0 });
        }
      }
    }
    assignPriority(lanes, connectorIds, weightOf);

    junctions.push({
      id: junctionId,
      kind: plan.kind,
      x: plan.meeting.x,
      y: plan.meeting.y,
      radius: 0,
      grade: plan.meeting.grade,
      footprint: goreFootprint(
        connectorIds.map((id) => lanes[id]),
        // The ramp's width *at the gore*, from the cap that touches it. Its
        // widest point is the wrong number: a collector-distributor road grows
        // auxiliary lanes of its own further along, and the corridor built to
        // that width stood nearly four metres proud of the ramp at the hand-over.
        capHalfWidth(segments[segId], plan.meeting.x, plan.meeting.y),
        // How far the road's asphalt reaches beyond the innermost lane the blend
        // actually leaves from, which is where its corridor is centred. The mean of
        // the auxiliary lanes is that number only while those are the lanes in play:
        // hand-wire a *through* lane to the ramp and the corridor starts several
        // metres further in, so measuring from the mean leaves a couple of metres of
        // the road's outer edge unpaved at the gore — a notch in the tarmac exactly
        // where the eye follows the traffic off the carriageway.
        segments[aux.segmentId].maxHalfWidth - Math.min(
          ...connectorIds.map((id) => {
            const road = lanes[isMerge ? lanes[id].successors[0] : lanes[id].predecessors[0]];
            return road && road.segmentId === aux.segmentId
              ? Math.abs(road.offset) : Math.abs(aux.offset);
          }),
          Math.abs(aux.offset)),
        plan.kind === 'merge',
      ),
      markings: goreMarkings(
        connectorIds.map((id) => lanes[id]),
        aux,
        segments[aux.segmentId],
        plan.kind === 'merge',
        lanes,
      ),
      connectorIds,
      approaches: [makeApproach(lanes, segments, segId, atEnd)],
      control: 'priority',
      turnOnRed: true,
    });
    if (atEnd) segments[segId].endJunction = junctionId;
    else segments[segId].startJunction = junctionId;
  }

  return { junctions, diagnostics };
}

/**
 * The through lane that may take an exit as well as carrying on.
 *
 * It is the kerb-side lane of the mainline segment that *ends* at the gore — which
 * exists only because the road was split there. Auxiliary lanes are excluded: the
 * deceleration lane already has its own movement, and it is not the lane that
 * continues.
 */
/**
 * The mainline's own lanes with an end at a gore, and which way they run.
 *
 * There are only any when the road has been split there — which is what an option
 * lane asks for, and what hand-wiring a through lane asks for. Only the carriageway
 * the ramp meets: the other one runs past the gore untouched and is none of its
 * business.
 */
function roadLanesAtGore(
  lanes: Lane[], segments: Segment[], ranges: SegmentRange[], plan: RampPlan,
): { lane: Lane; incoming: boolean }[] {
  const out: { lane: Lane; incoming: boolean }[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range.strokeIdx !== plan.roadStrokeIdx) continue;
    const endsHere = Math.abs(range.s1 - plan.sGoreRoad) < 1;
    const startsHere = Math.abs(range.s0 - plan.sGoreRoad) < 1;
    if (!endsHere && !startsHere) continue;
    const { incoming, outgoing } = lanesAt(lanes, segments[i], endsHere);
    for (const lane of endsHere ? incoming : outgoing) {
      if (lane.aux || lane.side !== plan.roadSide) continue;
      out.push({ lane, incoming: endsHere });
    }
  }
  return out;
}

function optionLaneAt(
  lanes: Lane[], segments: Segment[], ranges: SegmentRange[], plan: RampPlan,
): Lane | null {
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range.strokeIdx !== plan.roadStrokeIdx) continue;
    if (Math.abs(range.s1 - plan.sGoreRoad) > 1) continue;
    const { incoming } = lanesAt(lanes, segments[i], true);
    let best: Lane | null = null;
    for (const lane of incoming) {
      if (lane.aux || lane.side !== plan.roadSide) continue;
      if (!best || lane.index < best.index) best = lane;
    }
    return best;
  }
  return null;
}
