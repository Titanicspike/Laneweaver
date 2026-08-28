/**
 * Left-turn pockets.
 *
 * A left turn made from a through lane stops the whole lane behind it, which is why
 * every arterial junction of any size has a dedicated bay. The pocket is planned
 * before any lane geometry exists, because it changes the cross-section: over a
 * taper the turning group's through lanes slide outward by the pocket's width and
 * the bay opens up against the median, which stays exactly where it was.
 *
 * Only approaches that would actually use one get a pocket — the group must have at
 * least two lanes (a single-lane approach has nothing to overtake the turner in),
 * there has to be somewhere to turn left to, and the segment has to be long enough
 * to hold the taper and some storage without swallowing the road.
 */

import { sampleTangent } from '../../geom/polyline';
import { classifyTurn } from './crossings';
import { lanesOnSide } from './layout';
import { TurnKind } from '../types';
import type { Diagnostic, TurnLaneChoice } from '../types';
import type { Meeting } from './crossings';
import type { PreparedStroke } from './prepare';
import type { SegmentRange } from './segments';

export interface TurnLanePlan {
  /**
   * Which side of the group the bay opens from.
   *
   * A left bay opens against the median and pushes the through lanes outward, so the
   * opposing carriageway never moves. A right bay opens against the kerb and widens
   * the road outward, taking nothing from the median and moving nothing — which is
   * why it is available on a one-way street and on an undivided road, where a left
   * bay has no median to use.
   */
  kind: 'left' | 'right';
  /** Index into the segment ranges this pocket belongs to. */
  rangeIdx: number;
  /** True when the junction is at the range's high-arc-length end. */
  atEnd: boolean;
  /** Direction group flowing into the junction; implied by `atEnd`. */
  side: 1 | -1;
  width: number;
  /**
   * How much of the bay comes out of the median, and how much widens the road.
   * A median is there to be used: real junctions run the bay down it and only widen
   * the carriageway by whatever is left over.
   */
  fromMedian: number;
  widen: number;
  /** The profile's median here, for deciding how much of it this bay may claim. */
  median: number;
  /** Length over which the through lanes slide out and the bay opens. */
  taper: number;
  /** Full-width length of the bay, from the end of the taper to the stop line. */
  storage: number;
}

/** Fewer lanes than this in the turning group and a pocket is not worth building. */
const MIN_GROUP_LANES = 2;
const TAPER = 30;
const STORAGE = 55;
/** Leave at least this much plain road so a pocket never eats a whole block. */
const MIN_REMAINDER = 20;
/** Median left unclaimed, so a double yellow still separates the two directions. */
const MEDIAN_SLIVER = 0.45;

const _t = { x: 0, y: 0 };

/** Heading of travel into the junction at one end of a range. */
function headingInto(stroke: PreparedStroke, range: SegmentRange, atEnd: boolean): number {
  const s = atEnd ? Math.max(0, range.s1 - 0.01) : Math.min(stroke.length, range.s0 + 0.01);
  sampleTangent(stroke.points, stroke.arclength, s, _t);
  return atEnd ? Math.atan2(_t.y, _t.x) : Math.atan2(-_t.y, -_t.x);
}

export function planTurnLanes(
  strokes: PreparedStroke[], meetings: Meeting[], ranges: SegmentRange[],
  chosen: (meeting: Meeting, approach: string) => TurnLaneChoice = () => 'auto',
  rightInRightOutAt: (meeting: Meeting) => boolean = () => false,
): { plans: TurnLanePlan[]; diagnostics: Diagnostic[] } {
  const plans: TurnLanePlan[] = [];
  const diagnostics: Diagnostic[] = [];

  // Every range end that touches each meeting, so an approach can ask what it can
  // reach from there.
  const arms = new Map<number, { rangeIdx: number; atEnd: boolean }[]>();
  for (let i = 0; i < ranges.length; i++) {
    for (const atEnd of [false, true]) {
      const mi = atEnd ? ranges[i].endMeeting : ranges[i].startMeeting;
      if (mi < 0) continue;
      const list = arms.get(mi);
      if (list) list.push({ rangeIdx: i, atEnd });
      else arms.set(mi, [{ rangeIdx: i, atEnd }]);
    }
  }

  for (const [mi, list] of arms) {
    const meeting = meetings[mi];
    if (!meeting || meeting.kind !== 'crossing' || list.length < 3) continue;

    for (const arm of list) {
      const range = ranges[arm.rangeIdx];
      const stroke = strokes[range.strokeIdx];
      const side: 1 | -1 = arm.atEnd ? 1 : -1;
      if (lanesOnSide(stroke.profile, side) < 1) continue;

      const choice = chosen(meeting, `${stroke.stroke.id}:${side}`);
      if (choice === 'none') continue;

      const inHeading = headingInto(stroke, range, arm.atEnd);
      // Is there anywhere to turn that way? A bay pointing at nothing is a lane the
      // movement allocation will never give a connector, so it would be a strip of
      // paint nobody can legally use — physical fact rather than policy, which is why
      // forcing a bay on does not override it.
      const canTurn = (want: TurnKind): boolean => list.some((other) => {
        if (other === arm) return false;
        const otherRange = ranges[other.rangeIdx];
        if (lanesOnSide(strokes[otherRange.strokeIdx].profile, other.atEnd ? -1 : 1) < 1) return false;
        const out = headingInto(strokes[otherRange.strokeIdx], otherRange, other.atEnd) + Math.PI;
        return classifyTurn(inHeading, out) === want;
      });

      // What the compiler would choose on its own: a left bay where the group has
      // lanes to spare and there is a left turn to make. Everything else is the
      // user's call, and `auto` is only a default.
      // At a right-in / right-out there is no left turn to build a bay for, whatever
      // the geometry would allow: the movement does not exist.
      const noLeft = rightInRightOutAt(meeting);
      const autoLeft = !noLeft && lanesOnSide(stroke.profile, side) >= MIN_GROUP_LANES && canTurn(TurnKind.Left);
      const wantLeft = !noLeft && (choice === 'auto' ? autoLeft : choice === 'left' || choice === 'both');
      const wantRight = choice === 'right' || choice === 'both';
      const kinds: ('left' | 'right')[] = [];
      if (wantLeft && canTurn(TurnKind.Left)) kinds.push('left');
      if (wantRight && canTurn(TurnKind.Right)) kinds.push('right');
      if (!kinds.length) continue;

      const length = range.s1 - range.s0;
      const width = stroke.profile.laneWidth;
      // Only a real median counts: a one-way road has none to give.
      const median = stroke.profile.lanesForward > 0 && stroke.profile.lanesBackward > 0
        ? stroke.profile.median : 0;
      // Never eat the last of the median: the strip that survives is what carries
      // the double yellow between the bay and opposing traffic, which is how a real
      // bay that has taken the median still reads as separated from the other
      // direction.
      const spare = Math.max(0, median - MEDIAN_SLIVER);
      let taper = TAPER;
      let storage = STORAGE;
      if (length < taper + storage + MIN_REMAINDER) {
        // Squeeze the bay before giving up on it; a short block still benefits.
        const usable = length - MIN_REMAINDER;
        if (usable < 25) {
          diagnostics.push({
            severity: 'info', code: 'turn-lane-too-short',
            message: 'This approach is too short for a left-turn lane.',
            x: meeting.x, y: meeting.y, strokeId: stroke.stroke.id,
          });
          continue;
        }
        taper = Math.max(12, usable * 0.4);
        storage = usable - taper;
      }

      for (const kind of kinds) {
        plans.push({
          kind,
          rangeIdx: arm.rangeIdx, atEnd: arm.atEnd, side, width,
          // Provisional for a left bay: how much of the median it may take depends on
          // whether the other direction wants the same stretch of it, which is not
          // known until every arm has been planned. A right bay opens against the
          // kerb and has no median to take, so it widens the road by its full width.
          fromMedian: kind === 'left' ? spare : 0,
          widen: kind === 'left' ? width - spare : width,
          taper, storage,
          median: kind === 'left' ? median : 0,
        });
      }
    }
  }

  shareTheMedian(plans, ranges);
  plans.sort((a, b) => a.rangeIdx - b.rangeIdx || Number(a.atEnd) - Number(b.atEnd));
  return { plans, diagnostics };
}

/**
 * A short block with a bay at each end has two bays reaching for the same median
 * from opposite directions. Let both take all of it and their median edge lines
 * swap sides and cross in the middle — an X of yellow paint down the road. When the
 * two overlap they get half each instead, and the road widens by the rest.
 */
function shareTheMedian(plans: TurnLanePlan[], ranges: SegmentRange[]): void {
  for (const plan of plans) {
    if (plan.kind !== 'left') continue; // a kerb-side bay takes no median
    const range = ranges[plan.rangeIdx];
    const span = plan.taper + plan.storage;
    const lo = plan.atEnd ? range.s1 - span : range.s0;
    const hi = plan.atEnd ? range.s1 : range.s0 + span;
    const shared = plans.some((other) => {
      if (other === plan || other.kind !== 'left') return false;
      if (other.rangeIdx !== plan.rangeIdx || other.side === plan.side) return false;
      const otherSpan = other.taper + other.storage;
      const oLo = other.atEnd ? range.s1 - otherSpan : range.s0;
      const oHi = other.atEnd ? range.s1 : range.s0 + otherSpan;
      return oLo < hi && lo < oHi;
    });
    if (!shared) continue;
    plan.fromMedian = Math.min(Math.max(0, (plan.median - MEDIAN_SLIVER) / 2), plan.width);
    plan.widen = plan.width - plan.fromMedian;
  }
}
