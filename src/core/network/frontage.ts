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
  /**
   * A plot around a turning head, which faces the bulb from outside and so has no
   * position along the centreline to be described by. `s` still says where the
   * driveway meets the road — just inside the end — so the traffic model finds it
   * with the same lookup as every other address; only the geometry differs.
   */
  head?: HeadPlot;
}

/** Where a turning head's plot sits on the bulb, in the bulb's own frame. */
export interface HeadPlot {
  cx: number;
  cy: number;
  radius: number;
  /** Angle of the plot's centre around the bulb, radians. */
  angle: number;
  /**
   * The lane side that serves this door — the one *leaving* the head.
   *
   * The bulb's driveways open onto the turning circle, so a driver goes round it to
   * reach one, and is therefore on the way out by the time they stop. Stated as a
   * lane side rather than a kerb so the traffic model can check it without knowing
   * which side of the road the world drives on.
   */
  fromSide: 1 | -1;
}

/**
 * A turning head at one end of a segment, as the frontage walk needs to see it.
 */
export interface TurningHead {
  /** True when the head is at the segment's high-arc-length end. */
  atEnd: boolean;
  cx: number;
  cy: number;
  radius: number;
  /** Direction from the bulb centre back down the road, radians. */
  mouth: number;
  /** Half the angle the road's own mouth takes out of the circle. */
  mouthHalf: number;
  /** Lane side leaving the head: the one a driver is on once they have gone round. */
  outSide: 1 | -1;
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
  length: number, use: LandUse, segmentId: number, heads: ReadonlyArray<TurningHead> = [],
): Frontage[] {
  const out: Frontage[] = [];
  for (const head of heads) out.push(...headFrontages(length, use, head));
  if (length < FRONTAGE.endClearance * 2 + FRONTAGE.minWidth) return out.sort(bySeq);
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
  out.sort(bySeq);
  return out;
}

const bySeq = (a: Frontage, b: Frontage): number => a.s - b.s || a.side - b.side;

/**
 * The ring of plots around a turning head.
 *
 * A cul-de-sac's houses stand round the bulb rather than along a street, which is
 * the whole visual point of one — and they are wedges, wider at the back than at the
 * kerb, because that is what a plot on the outside of a circle is. Everything but
 * the mouth the road comes in through is available; each plot takes an equal share
 * of what is left, so the ring closes rather than leaving one ragged gap.
 *
 * The driveway meets the road just inside the end, so a driver heading for one of
 * these houses drives to the head — which is also the only place they can turn round.
 */
function headFrontages(length: number, use: LandUse, head: TurningHead): Frontage[] {
  const houses = use === 'residential';
  const widths = houses ? FRONTAGE.houseWidth : FRONTAGE.shopWidth;
  const span = Math.PI * 2 - 2 * head.mouthHalf - HEAD_MOUTH_GAP * 2;
  if (span <= 0) return [];
  // Sized where the houses stand, not at the kerb. A plot on the outside of a circle
  // is a wedge, so counting by its kerb width gives a ring of three vast gardens on a
  // bulb that in reality holds five or six houses.
  const count = Math.max(0, Math.round(
    (span * (head.radius + HEAD_PLOT_DEPTH / 2)) / ((widths[0] + widths[1]) / 2)));
  if (count < 2) return [];
  const step = span / count;
  if (step * head.radius < FRONTAGE.minWidth) return [];
  const out: Frontage[] = [];
  for (let i = 0; i < count; i++) {
    // Walk from one side of the mouth round to the other.
    const angle = head.mouth + head.mouthHalf + HEAD_MOUTH_GAP + step * (i + 0.5);
    // A share of the ring, less a fence line — proportional rather than a fixed gap,
    // so a tight bulb does not spend most of its circumference on gaps.
    const half = step * head.radius * HEAD_PLOT_SHARE / 2;
    out.push({
      // Far enough back down the road that a driver who has just come round the head
      // has somewhere to stop: an address in the first few metres of a lane is one
      // the arrival rule cannot use, and the driver would sail past it and out.
      s: head.atEnd ? Math.max(0, length - HEAD_DRIVEWAY) : Math.min(length, HEAD_DRIVEWAY),
      half,
      side: 1,
      head: {
        cx: head.cx, cy: head.cy, radius: head.radius, angle, fromSide: head.outSide,
      },
    });
  }
  return out;
}

/** Clear of the road's own mouth, so no plot is laid across the carriageway. */
const HEAD_MOUTH_GAP = 0.12;
/** How far inside the road's end the head's driveways meet it. */
const HEAD_DRIVEWAY = 16;
/** Roughly where a house on the head stands, for sizing the ring. */
const HEAD_PLOT_DEPTH = 14;
/** How much of each share is plot rather than the gap between neighbours. */
const HEAD_PLOT_SHARE = 0.86;
