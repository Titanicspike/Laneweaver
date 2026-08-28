/**
 * Cross-section layout: where each lane sits relative to the segment centreline.
 *
 * Offsets are signed, positive to the **right** of the stroke direction (in a
 * y-down frame that is `perpRight = (-ty, tx)`). The whole cross-section is
 * centred on the stroke, so a one-way road straddles its centreline rather than
 * hanging off one side. Under right-hand traffic the forward group takes the
 * positive half; left-hand traffic mirrors everything.
 */

import type { RoadProfile } from '../types';

export interface LaneSlot {
  /** Lateral offset of the lane centre from the segment centreline. */
  offset: number;
  /** +1 travels along the stroke, -1 against it. */
  side: 1 | -1;
  /** 0 = rightmost through lane of this direction group; larger = further left. */
  index: number;
  width: number;
}

export function medianOf(p: RoadProfile): number {
  return p.lanesForward > 0 && p.lanesBackward > 0 ? p.median : 0;
}

/** Half the paved carriageway width, excluding shoulders. */
export function halfCarriageway(p: RoadProfile): number {
  return ((p.lanesForward + p.lanesBackward) * p.laneWidth + medianOf(p)) * 0.5;
}

/** +1 when this direction group occupies the positive-offset half. */
export function groupSign(side: 1 | -1, driveOnRight: boolean): number {
  return (side === 1 ? 1 : -1) * (driveOnRight ? 1 : -1);
}

export function lanesOnSide(p: RoadProfile, side: 1 | -1): number {
  return side === 1 ? p.lanesForward : p.lanesBackward;
}

/** Outer kerb-side edge of a direction group, where auxiliary lanes attach. */
export function groupOuterEdge(p: RoadProfile, side: 1 | -1, driveOnRight: boolean): number {
  return groupSign(side, driveOnRight) * halfCarriageway(p);
}

/** Median-side edge of a direction group. */
export function groupInnerEdge(p: RoadProfile, side: 1 | -1, driveOnRight: boolean): number {
  const g = groupSign(side, driveOnRight);
  return g * (halfCarriageway(p) - lanesOnSide(p, side) * p.laneWidth);
}

export function layoutProfile(p: RoadProfile, driveOnRight: boolean): LaneSlot[] {
  const slots: LaneSlot[] = [];
  const half = halfCarriageway(p);
  const sign = driveOnRight ? 1 : -1;

  for (let i = 0; i < p.lanesForward; i++) {
    slots.push({
      offset: sign * (half - (i + 0.5) * p.laneWidth),
      side: 1,
      index: i,
      width: p.laneWidth,
    });
  }
  for (let j = 0; j < p.lanesBackward; j++) {
    slots.push({
      offset: -sign * (half - (j + 0.5) * p.laneWidth),
      side: -1,
      index: j,
      width: p.laneWidth,
    });
  }
  return slots;
}

export interface AuxAttachment {
  /** Offset of the edge the auxiliary lane attaches to. */
  edge: number;
  /** Unit direction, in offset space, pointing away from the carriageway. */
  dir: number;
  /** False when the requested side faced the median and had to be overridden. */
  onPreferredSide: boolean;
}

/**
 * Picks the edge an auxiliary lane hangs off.
 *
 * `preferSign` is which side of the stroke the ramp actually approaches from.
 * Kerb-side is the normal answer; the median side is only allowed when there is
 * no opposing carriageway there to collide with.
 */
export function auxAttachment(
  p: RoadProfile, side: 1 | -1, driveOnRight: boolean, preferSign: number,
): AuxAttachment {
  const outer = groupOuterEdge(p, side, driveOnRight);
  const outerDir = Math.sign(outer) || groupSign(side, driveOnRight);
  if (preferSign === 0 || Math.sign(preferSign) === outerDir) {
    return { edge: outer, dir: outerDir, onPreferredSide: true };
  }
  const opposing = lanesOnSide(p, side === 1 ? -1 : 1);
  if (opposing === 0) {
    // One-way road: the "inner" edge is a free kerb, so attaching there is fine.
    const inner = groupInnerEdge(p, side, driveOnRight);
    return { edge: inner, dir: -outerDir, onPreferredSide: true };
  }
  return { edge: outer, dir: outerDir, onPreferredSide: false };
}

/** Centre offset of an auxiliary lane, `depth` 0 being the first one out. */
export function auxCenterOffset(a: AuxAttachment, width: number, depth: number): number {
  return a.edge + a.dir * (depth * width + width * 0.5);
}
