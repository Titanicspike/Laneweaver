/**
 * Cul-de-sacs: the turning head at the closed end of a street.
 *
 * A dead end is not automatically one of these, and that is deliberate. Every road
 * that stops is a *portal* — where trips begin and end — and quietly turning every
 * dead end into a turning head would take the traffic out of half the scenarios in
 * the suite and out of whatever the user had already drawn. So it is asked for, on
 * the same position-keyed override that already says what each end of the network
 * lets traffic do, and it answers the same question: what happens here.
 *
 * What it builds is a bulb at the end of the road and a U-turn from the lane coming
 * in to the lane going out. The U-turn is what makes it a cul-de-sac rather than a
 * blocked road: a driver can reach a house at the head and get out again. It also
 * makes the end stop being a portal without anything having to say so — the portal
 * rule is "a lane with somewhere to go is not an exit", and now it has somewhere.
 *
 * The road is trimmed back by the bulb's radius so the whole thing fits inside the
 * stroke the user drew: draw a hundred metres of street, get ninety metres of street
 * with a turning head on the end, rather than a hundred and ten metres of road.
 */

import type { Diagnostic, GatewayOverride, Junction, Lane, Segment } from '../types';
import { buildConnector } from './junctions';
import { TurnKind } from '../types';
import type { PreparedStroke } from './prepare';
import type { SegmentRange } from './segments';
import { samplePosition, sampleTangent } from '../../geom/polyline';
import type { TurningHead } from '../frontage';

export const CULDESAC = {
  /**
   * Turning-circle radius, from the road's own width but never below what a car can
   * actually turn in. Real residential heads are built at 9–12 m to the kerb.
   */
  minRadius: 9,
  maxRadius: 16,
  widthFactor: 2.4,
  /** Road left over after the trim, or the head is the whole street. */
  minStreet: 20,
  /**
   * Tarmac left between the outside of the U-turn and the kerb it sweeps round.
   *
   * The loop is sized from this rather than from a multiple of the radius, because
   * what it has to clear does not scale with the bulb: a car's width and a little.
   * Taken as a ratio instead it is either a hairpin down the middle of a circle
   * three times wider than it needs — which nothing longer than a car could use —
   * or, half a step further, a path two metres outside the asphalt.
   */
  kerbMargin: 0.6,
  /**
   * Where a cubic's apex sits along its handle. Both control points are pushed the
   * same distance in along the road, so the curve runs 3h·u(1−u) up that axis and
   * peaks at exactly three quarters of h. Not a tuning knob: it is the arithmetic.
   */
  apexOfHandle: 0.75,
} as const;

/** One end of one stroke, marked as a turning head. */
export interface CulDeSacPlan {
  strokeIdx: number;
  /** True when the head is at the stroke's high-arc-length end. */
  atEnd: boolean;
  /** Arc-length on the stroke where the road now stops. */
  cutS: number;
  radius: number;
  /** Half the road's asphalt, which the head's kerb returns flare out of. */
  halfWidth: number;
  /** The road's shoulder, so the edge line lands one shoulder inside the kerb. */
  shoulder: number;
  /** Centre of the bulb: the point the user drew the road's end at. */
  x: number;
  y: number;
  /** Direction from the bulb centre back down the road, radians. */
  mouth: number;
}

/**
 * Which stroke ends the document asks to be turning heads.
 *
 * Keyed by the position of the stroke's own end point, which is the one thing here
 * that does not move: the segment's end is pulled back by the radius as soon as the
 * head exists, so keying on that would lose the override the moment it took effect.
 */
export function planCulDeSacs(
  strokes: PreparedStroke[], gateways: ReadonlyArray<GatewayOverride>,
): { plans: CulDeSacPlan[]; diagnostics: Diagnostic[] } {
  const plans: CulDeSacPlan[] = [];
  const diagnostics: Diagnostic[] = [];
  if (!gateways.some((g) => g.role === 'culdesac')) return { plans, diagnostics };

  for (const stroke of strokes) {
    for (const atEnd of [false, true]) {
      const s = atEnd ? stroke.length : 0;
      samplePosition(stroke.points, stroke.arclength, s, _p);
      if (!marked(gateways, _p.x, _p.y)) continue;

      const profile = stroke.profile;
      // A U-turn needs somewhere to turn into. A one-way street closed at the end is
      // a road nobody can leave, and building a head there would hide that rather
      // than say it.
      if (profile.lanesForward < 1 || profile.lanesBackward < 1) {
        diagnostics.push({
          severity: 'warning', code: 'culdesac-one-way',
          message: 'A turning head needs a road with both directions to turn into.',
          strokeId: stroke.stroke.id, x: _p.x, y: _p.y,
        });
        continue;
      }
      const radius = Math.min(
        CULDESAC.maxRadius,
        Math.max(CULDESAC.minRadius, stroke.halfWidth * CULDESAC.widthFactor),
      );
      if (stroke.length - radius < CULDESAC.minStreet) {
        diagnostics.push({
          severity: 'warning', code: 'culdesac-too-short',
          message: 'This road is too short to hold a turning head as well as a street.',
          strokeId: stroke.stroke.id, x: _p.x, y: _p.y,
        });
        continue;
      }
      sampleTangent(stroke.points, stroke.arclength, atEnd ? Math.max(0, s - 0.01) : 0.01, _t);
      // The mouth faces back down the road from the bulb centre.
      const mouth = atEnd ? Math.atan2(-_t.y, -_t.x) : Math.atan2(_t.y, _t.x);
      plans.push({
        strokeIdx: stroke.index,
        atEnd,
        cutS: atEnd ? stroke.length - radius : radius,
        radius,
        // `PreparedStroke.halfWidth` is the asphalt, shoulder included — which is
        // what the kerb returns flare out of, and one shoulder outside the edge line
        // they have to meet.
        halfWidth: stroke.halfWidth,
        shoulder: profile.shoulder,
        x: _p.x,
        y: _p.y,
        mouth,
      });
    }
  }
  return { plans, diagnostics };
}

function marked(gateways: ReadonlyArray<GatewayOverride>, x: number, y: number): boolean {
  for (const g of gateways) {
    if (g.role !== 'culdesac') continue;
    if (Math.hypot(g.x - x, g.y - y) <= GATEWAY_SNAP) return true;
  }
  return false;
}

/** How near the drawn end an override has to be to mean it. Matches the editor's. */
const GATEWAY_SNAP = 6;

/** The plan that owns a given segment end, if any. */
export function headAt(
  plans: ReadonlyArray<CulDeSacPlan>, range: SegmentRange, atEnd: boolean,
): CulDeSacPlan | undefined {
  return plans.find((plan) => plan.strokeIdx === range.strokeIdx
    && plan.atEnd === atEnd
    && Math.abs((atEnd ? range.s1 : range.s0) - plan.cutS) < 0.5);
}

/** What the frontage walk needs to lay a ring of plots around the bulb. */
export function headFrontageOf(plan: CulDeSacPlan, roadHalfWidth: number): TurningHead {
  return {
    atEnd: plan.atEnd,
    cx: plan.x,
    cy: plan.y,
    radius: plan.radius,
    mouth: plan.mouth,
    // Lanes flowing *to* the head are the ones that reach this end; the way out is
    // the other direction, and that is the lane a driver is on once round the bulb.
    outSide: plan.atEnd ? -1 : 1,
    // The road's own mouth, plus a little for the kerb returns either side of it.
    mouthHalf: Math.min(Math.PI / 2, Math.asin(
      Math.min(0.95, (roadHalfWidth + 1.5) / plan.radius)) ),
  };
}

/**
 * The outline of the turning head: the circle, flared into the road's own edges.
 *
 * A plain circle at the end of a street is a lollipop. Worse, it does not even meet
 * the road: at the kerb the circle has already begun to curve away, so between the
 * road's end and the circle's flank there is a wedge of bare ground either side of
 * the mouth, and the head reads as a disc parked next to a street rather than the
 * end of it. Real ones are built with kerb returns, and so is this: an arc tangent to
 * the road's edge at one end and to the bulb at the other, so the kerb line runs
 * from the street round the head and back without a corner anywhere in it.
 *
 * Returned open, from one side of the mouth round to the other, because it is used
 * twice: filled as the head's surface (the fill closes it across the mouth, over
 * road the carriageway already covers) and stroked as the edge line that carries the
 * road's own paint round the bulb. `inset` is what separates those two — the edge
 * line is one shoulder inside the kerb, here as everywhere else.
 */
export function bulbOutline(
  plan: CulDeSacPlan, halfWidth: number, inset = 0, onRoad?: OnRoad,
): Float32Array {
  const R = plan.radius - inset;
  const w = halfWidth - inset;
  const ux = Math.cos(plan.mouth), uy = Math.sin(plan.mouth);
  const nx = -uy, ny = ux;
  // Straight out of the mouth is only true for a straight road. The returns run
  // twenty metres back up it, and over that distance a residential bend moves the
  // kerb a metre and a half sideways — which is a metre and a half of daylight
  // between the head's paint and the road's, exactly where the two have to meet.
  const at = (along: number, across: number): [number, number] =>
    (onRoad && along > R ? onRoad(along, across) : null)
    ?? [plan.x + ux * along + nx * across, plan.y + uy * along + ny * across];

  const pts: number[] = [];
  const push = (along: number, across: number): void => {
    const [x, y] = at(along, across);
    pts.push(x, y);
  };
  // A road nearly as wide as its own turning head has no room for a return; give it
  // the plain circle rather than a fillet that doubles back on itself.
  const fillet = R * FILLET_OF_RADIUS;
  const feasible = w < R * 0.9 && fillet > (w * w) / (2 * (R - w));
  if (!feasible) {
    for (let i = 0; i <= BULB_STEPS; i++) {
      const a = (i / BULB_STEPS) * Math.PI * 2;
      push(Math.cos(a) * R, Math.sin(a) * R);
    }
    return Float32Array.from(pts);
  }

  // Where the return's centre sits: one fillet outside the road's edge, and one
  // fillet outside the bulb — which is what makes it tangent to both.
  const cx = Math.sqrt((R + fillet) * (R + fillet) - (w + fillet) * (w + fillet));
  const theta = Math.atan2(w + fillet, cx);
  const arc = Math.PI / 2 - theta;

  // The left return, from the road's edge round to the bulb.
  const steps = Math.max(3, Math.round((arc / (Math.PI * 2)) * BULB_STEPS));
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 - (i / steps) * arc;
    push(cx + Math.cos(a) * fillet, (w + fillet) + Math.sin(a) * fillet);
  }
  // Round the head the long way, from one return to the other.
  const sweep = Math.PI * 2 - 2 * theta;
  const round = Math.max(8, Math.round((sweep / (Math.PI * 2)) * BULB_STEPS));
  for (let i = 0; i <= round; i++) {
    const a = theta + (i / round) * sweep;
    push(Math.cos(a) * R, Math.sin(a) * R);
  }
  // ...and the right return, which is the left one mirrored and walked backwards.
  for (let i = steps; i >= 0; i--) {
    const a = -Math.PI / 2 - (i / steps) * arc;
    push(cx + Math.cos(a) * fillet, -((w + fillet) + Math.sin(a) * fillet));
  }
  return Float32Array.from(pts);
}

/**
 * Puts a point of the straight mouth frame back on the road it came from.
 *
 * `along` is measured from the bulb centre back down the road and `across` to the
 * left of that; returns null where the road no longer reaches.
 */
export type OnRoad = (along: number, across: number) => [number, number] | null;

/** Kerb return, as a share of the bulb it flares into. */
const FILLET_OF_RADIUS = 0.55;
/** Points round a whole circle; the arcs take their share of it. */
const BULB_STEPS = 64;

/**
 * The lanes a U-turn runs between: innermost in to innermost out.
 *
 * One movement, not every pairing. A driver in an outer lane reaches it the way they
 * reach any other lane they need — the routing field counts a lane change as an edge
 * — and wiring every inbound lane to every outbound one would put a sheaf of
 * crossing connectors inside a circle ten metres across.
 */
export function uTurnPair(
  lanes: Lane[], seg: Segment, atEnd: boolean,
): { from: Lane; to: Lane } | null {
  let from: Lane | null = null;
  let to: Lane | null = null;
  for (const id of seg.laneIds) {
    const lane = lanes[id];
    if (lane.aux) continue;
    const flowsToEnd = lane.side === 1;
    if (flowsToEnd === atEnd) {
      if (!from || lane.index > from.index) from = lane;
    } else if (!to || lane.index > to.index) {
      to = lane;
    }
  }
  return from && to ? { from, to } : null;
}


const _p = { x: 0, y: 0 };
const _t = { x: 0, y: 0 };

/**
 * Turns each planned head into a junction: the bulb, and the U-turn inside it.
 *
 * It is a junction rather than a decoration on the segment because everything a
 * junction already does is what a head needs — a footprint the renderer fills, a
 * connector the traffic drives, and an end that is no longer the end of the network.
 */
export function buildCulDeSacs(
  plans: ReadonlyArray<CulDeSacPlan>,
  segments: Segment[],
  ranges: ReadonlyArray<SegmentRange>,
  lanes: Lane[],
  firstId: number,
): Junction[] {
  const out: Junction[] = [];
  for (const plan of plans) {
    // The segment whose end the head closes: the one whose range stops at the cut.
    let segId = -1;
    for (let i = 0; i < ranges.length; i++) {
      if (headAt(plans, ranges[i], plan.atEnd) !== plan) continue;
      if (ranges[i].strokeIdx !== plan.strokeIdx) continue;
      segId = i;
      break;
    }
    if (segId < 0 || !segments[segId]) continue;
    const seg = segments[segId];

    const pair = uTurnPair(lanes, seg, plan.atEnd);
    if (!pair) continue;
    const junctionId = firstId + out.length;
    // Reach the far side of the bulb and stop a car's width short of the kerb. The
    // apex is three quarters of the handle from the mouth, and the mouth is one
    // radius from the centre, so there are two radii of depth to spend.
    const laneHalf = Math.min(pair.from.width, pair.to.width) / 2;
    const handle = Math.max(
      plan.radius,
      (2 * plan.radius - laneHalf - CULDESAC.kerbMargin) / CULDESAC.apexOfHandle,
    );
    const connector = buildConnector(
      lanes, junctionId, pair.from, pair.to, TurnKind.UTurn, handle,
    );

    // The kerb returns follow the road rather than a straight line out of the mouth.
    // `along` is measured from the bulb centre, and the road's end is one radius
    // back from it, so anything beyond that is this many metres inside the segment.
    const onRoad: OnRoad = (along, across) => {
      const s = plan.atEnd
        ? seg.length - (along - plan.radius)
        : along - plan.radius;
      if (s < 0 || s > seg.length) return null;
      samplePosition(seg.centerline, seg.arclength, s, _p);
      sampleTangent(seg.centerline, seg.arclength, s, _t);
      // The mouth frame faces back down the road, so its left is the segment's right
      // at the end it closes, and its own right at the other.
      const side = plan.atEnd ? -1 : 1;
      return [
        _p.x + -_t.y * across * side,
        _p.y + _t.x * across * side,
      ];
    };
    // The end now belongs to a junction, which is what stops it being read as a
    // portal — an end of the network where traffic appears and disappears.
    if (plan.atEnd) seg.endJunction = junctionId;
    else seg.startJunction = junctionId;

    out.push({
      id: junctionId,
      kind: 'culdesac',
      x: plan.x,
      y: plan.y,
      radius: plan.radius,
      grade: seg.grade,
      markings: [{
        // The road's edge line, carried round the head. Without it the paint stops
        // dead across the carriageway and the bulb reads as a separate thing that
        // happens to be adjacent — which is exactly what it looked like.
        style: 'edge',
        points: bulbOutline(plan, plan.halfWidth, plan.shoulder, onRoad),
      }],
      footprint: bulbOutline(plan, plan.halfWidth, 0, onRoad),
      connectorIds: [connector.id],
      approaches: [{
        segmentId: seg.id,
        atSegmentEnd: plan.atEnd,
        heading: plan.mouth + Math.PI,
        incomingLanes: [pair.from.id],
        outgoingLanes: [pair.to.id],
        weight: pair.from.speedLimit,
      }],
      // Nothing to give way to: one movement, and it is the only one here.
      control: 'priority',
      turnOnRed: true,
    });
  }
  return out;
}
