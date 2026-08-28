/**
 * Where the buildings are along a road — and therefore where its traffic joins it.
 *
 * One rule, in one place, used twice. The renderer lays a plot on every frontage the
 * compiler emits here, and the simulation starts and ends land-use trips on the same
 * ones. That is the whole point of it living in core rather than in the renderer: a
 * car that pulls out somewhere no house stands, or vanishes in the middle of a block,
 * is the thing that gives away that the houses are wallpaper.
 *
 * A frontage is a position along the *segment centreline*, not along the asphalt
 * edge, and that is deliberate. Equal pitch on the centreline is what real plots have
 * on a curve: the outer ones are wider at the kerb and the inner ones narrower, and
 * the boundary between two neighbours is one line rather than two that disagree. The
 * renderer projects outward to the kerb and gets that for free.
 */

import { Mulberry32 } from '../util/rng';
import type { LandUse } from './types';

/** One property's frontage on a road. */
export interface Frontage {
  /** Arc-length of the plot's centre along the segment centreline. */
  s: number;
  /** Half the plot's frontage, so its boundaries are `s ± half`. */
  half: number;
  /** Which side of the road, in the segment's own frame: +1 left, -1 right. */
  side: 1 | -1;
}

export const FRONTAGE = {
  /** Plot frontage, before the road's own shape stretches or squeezes it. */
  houseWidth: [11, 19] as const,
  shopWidth: [8, 16] as const,
  /** Gap between neighbours, which is where the fence line reads. */
  houseGap: [1.5, 4] as const,
  shopGap: [0, 1.2] as const,
  /**
   * Clear of each end of the road.
   *
   * A constant, not the junction's radius: the segment has *already* been trimmed
   * back to the junction, so its ends sit on the junction boundary and adding the
   * radius again holds the frontage back twice as far as it needs to be.
   */
  endClearance: 7,
  /** Narrower than this is not a plot, it is a gap. */
  minWidth: 7,
} as const;

/**
 * Every plot frontage along one segment, both sides, in ascending order of `s`.
 *
 * Seeded from the segment's id, so the same document always produces the same street
 * and a recompile never reshuffles the town.
 */
export function frontagesOf(
  length: number, use: LandUse, segmentId: number,
): Frontage[] {
  const out: Frontage[] = [];
  if (length < FRONTAGE.endClearance * 2 + FRONTAGE.minWidth) return out;
  const houses = use === 'residential';
  const widths = houses ? FRONTAGE.houseWidth : FRONTAGE.shopWidth;
  const gaps = houses ? FRONTAGE.houseGap : FRONTAGE.shopGap;
  const rng = new Mulberry32(Math.imul(segmentId + 7919, 2246822519) >>> 0);
  const limit = length - FRONTAGE.endClearance;

  // The two sides are drawn from the same stream but walked separately, so houses
  // opposite each other are not twins — a street of matched pairs reads as wallpaper
  // even when every other detail is right.
  for (const side of [1, -1] as const) {
    let s = FRONTAGE.endClearance;
    while (s < limit) {
      const width = Math.min(widths[0] + rng.next() * (widths[1] - widths[0]), limit - s);
      if (width < FRONTAGE.minWidth) break;
      out.push({ s: s + width / 2, half: width / 2, side });
      s += width + gaps[0] + rng.next() * (gaps[1] - gaps[0]);
    }
  }
  out.sort((a, b) => a.s - b.s || a.side - b.side);
  return out;
}
