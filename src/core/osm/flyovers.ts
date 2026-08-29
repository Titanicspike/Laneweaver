/**
 * Crossings that OpenStreetMap says are not crossings.
 *
 * This is the one piece of topology the survey gives us that a hand-drawn document
 * never has, and ignoring it is the largest single source of wrong network in an
 * import. Two ways that cross geometrically **without sharing a node do not
 * connect** — that is the data model, not a convention. Every road that flies over
 * another is mapped exactly that way, and where the bridge is tagged (`bridge=yes`,
 * `layer=1`) `layerOf` already reads it. Plenty are not tagged, and then the
 * compiler, which can only see geometry, builds a junction: a motorway wired into
 * the street beneath it. Measured across twenty imported squares, **752 junctions**
 * that OSM does not have, 229 of them with a motorway or trunk road as one arm.
 *
 * What that costs is not subtle. The freeway gets a set of traffic lights, drivers
 * leave it in the middle of a span, and the crossing arms are 105 km/h against 40 —
 * the shape that produced most of the collisions left in the worst city.
 *
 * The fix is the one the compiler already understands: grade lives on control
 * points, so the road that goes over is raised for a span either side of the
 * crossing and ramps back down. It is a bridge, because that is what it is.
 */

import type { Tags } from './tags';

/** A way as this module needs it: world-space geometry plus its node ids. */
export interface FlyoverWay {
  id: number;
  /** Flat [x, y, ...] in metres. */
  raw: number[];
  nodes: number[];
  tags: Tags;
}

/**
 * How much of the over-road is at full height either side of the crossing, and how
 * long the ramp to it is. Twelve metres clears a wide carriageway; twenty-five
 * metres of ramp is about what an overbridge approach looks like from above.
 */
const BRIDGE_HALF = 12;
const BRIDGE_RAMP = 25;

/** Cell size for the segment index, in metres. */
const CELL = 60;

/**
 * How far from either end of a way a crossing has to be to count, in metres.
 *
 * A way that *ends* on another is a T-junction — a road meeting a road — and no
 * amount of raising makes that anything else: its end is the junction, so a bridge
 * there would simply disconnect it. Only a way that carries on past the crossing is
 * flying over anything.
 */
const END_MARGIN = 1.5;

/**
 * Which road goes over which. Class first — a motorway crosses above a street and
 * never the other way round — then the longer way, then the lower id, so that two
 * runs of the same data agree.
 */
const RANK: Record<string, number> = {
  motorway: 6, motorway_link: 5, trunk: 5, trunk_link: 4, primary: 4,
  primary_link: 3, secondary: 3, secondary_link: 2, tertiary: 2, tertiary_link: 1,
  unclassified: 1, residential: 1, road: 1, busway: 1, living_street: 0, service: 0,
};

function rankOf(tags: Tags): number {
  return RANK[tags.highway ?? ''] ?? 1;
}

function lengthOf(raw: number[]): number {
  let total = 0;
  for (let i = 2; i < raw.length; i += 2) {
    total += Math.hypot(raw[i] - raw[i - 2], raw[i + 1] - raw[i - 1]);
  }
  return total;
}

/** Where two segments cross, as the parameter along each, or null. */
function crossAt(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): { t: number; u: number } | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  // Inclusive of the segment ends, because a survey often puts a vertex exactly at
  // the crossing and a strict test then misses the very flyovers it is looking for.
  // What must still be excluded — a way that *ends* on another, which is a T and not
  // a bridge — is excluded further out, where the position along the whole way is
  // known: see `END_MARGIN`.
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u };
}

/**
 * Arc positions along each way where it passes **over** another it shares no node
 * with. Keyed by way id; ways with nothing to fly over do not appear.
 */
export function findFlyovers(ways: FlyoverWay[]): Map<number, number[]> {
  const arcs = new Map<number, Float64Array>();
  const nodeSets = new Map<number, Set<number>>();
  for (const w of ways) {
    const n = w.raw.length >> 1;
    const a = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      a[i] = a[i - 1]
        + Math.hypot(w.raw[i * 2] - w.raw[i * 2 - 2], w.raw[i * 2 + 1] - w.raw[i * 2 - 1]);
    }
    arcs.set(w.id, a);
    nodeSets.set(w.id, new Set(w.nodes));
  }

  // A uniform grid of segments: cheaper than a tree at this size and it needs no
  // dependency, since core carries none it does not have to.
  const cells = new Map<number, { w: number; i: number }[]>();
  for (let k = 0; k < ways.length; k++) {
    const w = ways[k];
    for (let i = 0; i + 3 < w.raw.length; i += 2) {
      const x0 = w.raw[i];
      const y0 = w.raw[i + 1];
      const x1 = w.raw[i + 2];
      const y1 = w.raw[i + 3];
      const cx0 = Math.floor(Math.min(x0, x1) / CELL);
      const cx1 = Math.floor(Math.max(x0, x1) / CELL);
      const cy0 = Math.floor(Math.min(y0, y1) / CELL);
      const cy1 = Math.floor(Math.max(y0, y1) / CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const id = cx * 100003 + cy;
          const list = cells.get(id);
          if (list) list.push({ w: k, i });
          else cells.set(id, [{ w: k, i }]);
        }
      }
    }
  }

  const rank = ways.map((w) => rankOf(w.tags));
  const len = ways.map((w) => lengthOf(w.raw));
  const out = new Map<number, number[]>();
  const seen = new Set<string>();

  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        if (A.w === B.w) continue;
        const wa = ways[A.w];
        const wb = ways[B.w];
        // A shared node is a junction, whatever the geometry does nearby.
        const na = nodeSets.get(wa.id) as Set<number>;
        let shares = false;
        for (const n of nodeSets.get(wb.id) as Set<number>) {
          if (na.has(n)) { shares = true; break; }
        }
        if (shares) continue;

        const hit = crossAt(
          wa.raw[A.i], wa.raw[A.i + 1], wa.raw[A.i + 2], wa.raw[A.i + 3],
          wb.raw[B.i], wb.raw[B.i + 1], wb.raw[B.i + 2], wb.raw[B.i + 3]);
        if (!hit) continue;
        // One crossing can land in two cells; count it once.
        const tag = A.w + ':' + A.i + ':' + B.w + ':' + B.i;
        if (seen.has(tag)) continue;
        seen.add(tag);

        // Where along each whole way the crossing is. Both have to be carrying on
        // past it: a way that ends there meets the other one, and that is a
        // junction whichever way round it is read.
        const posOn = (side: { w: number; i: number }, param: number): number => {
          const arc = arcs.get(ways[side.w].id) as Float64Array;
          const seg = side.i >> 1;
          return arc[seg] + param * (arc[seg + 1] - arc[seg]);
        };
        const sa = posOn(A, hit.t);
        const sb = posOn(B, hit.u);
        if (sa < END_MARGIN || sa > len[A.w] - END_MARGIN) continue;
        if (sb < END_MARGIN || sb > len[B.w] - END_MARGIN) continue;

        const aOver = rank[A.w] !== rank[B.w] ? rank[A.w] > rank[B.w]
          : len[A.w] !== len[B.w] ? len[A.w] > len[B.w] : wa.id < wb.id;
        const w = ways[aOver ? A.w : B.w];
        const s = aOver ? sa : sb;
        const at = out.get(w.id);
        if (at) at.push(s);
        else out.set(w.id, [s]);
      }
    }
  }
  return out;
}

/** A stretch of one way that is raised, in arc length, with its ramps outside it. */
export interface BridgeSpan {
  /** Full height between these. */
  from: number;
  to: number;
  /** Ground level at or beyond these. */
  rampFrom: number;
  rampTo: number;
}

/**
 * The raised stretches for one way, merged where they overlap.
 *
 * A span is refused where the way has no room for it. A bridge that is all ramp is
 * a hump in the road, and — the reason that matters — a way raised at the point it
 * meets another is a way that no longer meets it: the ends are where the junctions
 * are, so a span that reaches an end would disconnect the road it was carrying.
 */
export function bridgeSpans(crossings: number[], length: number): BridgeSpan[] {
  const sorted = [...crossings].sort((a, b) => a - b);
  const spans: BridgeSpan[] = [];
  for (const s of sorted) {
    // Fit the span to the road there is. Ways between junctions are often eighty
    // metres and a fixed span needs seventy-four, so insisting on the full one
    // refused most of the bridges that most needed building — and a refused bridge
    // is not a missing bridge, it is a motorway wired into a street. What cannot
    // shrink is the clearance: below a few metres either side the raised part does
    // not span the road it is crossing, and below a few metres of ramp the road
    // climbs faster than a road can.
    const room = Math.min(s, length - s) - 1;
    const half = Math.min(BRIDGE_HALF, room * 0.35);
    const ramp = Math.min(BRIDGE_RAMP, room - half);
    if (half < 3.5 || ramp < 6) continue;
    const from = s - half;
    const to = s + half;
    const last = spans[spans.length - 1];
    if (last && from <= last.rampTo) {
      last.to = Math.max(last.to, to);
      last.rampTo = Math.min(length - 1, last.to + ramp);
      continue;
    }
    spans.push({ from, to, rampFrom: from - ramp, rampTo: to + ramp });
  }
  return spans;
}
