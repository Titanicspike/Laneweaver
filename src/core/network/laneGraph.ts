/**
 * Runtime helpers over the compiled lane graph.
 *
 * The important one is `mapS`: lanes of a segment share their parent centreline's
 * arc-length parameterisation, so a position on one lane maps exactly onto the
 * equivalent cross-section of a neighbouring lane. The merge model leans on this
 * constantly — it is what lets a merging car compare itself against traffic in the
 * lane it wants without any geometric projection at run time.
 */

import type { Lane, Network } from './types';
import { LaneKind } from './types';
import { BoxIndex } from '../geom/spatial';
import { bboxOfPolyline, expandBbox, segmentIndexForS } from '../geom/polyline';

/** Parent-segment arc-length at position `s` along the lane. */
export function laneSToParent(lane: Lane, s: number): number {
  const n = lane.parentS.length;
  if (n === 0) return 0;
  if (n === 1) return lane.parentS[0];
  const i = segmentIndexForS(lane.arclength, s);
  const s0 = lane.arclength[i];
  const span = lane.arclength[i + 1] - s0;
  let t = span > 1e-9 ? (s - s0) / span : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return lane.parentS[i] + (lane.parentS[i + 1] - lane.parentS[i]) * t;
}

/**
 * Inverse of `laneSToParent`. `parentS` is monotone but decreasing for lanes that
 * run against their stroke, so the search handles both directions.
 */
export function parentToLaneS(lane: Lane, parent: number): number {
  const p = lane.parentS;
  const n = p.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  const ascending = p[n - 1] >= p[0];
  const lo = ascending ? p[0] : p[n - 1];
  const hi = ascending ? p[n - 1] : p[0];
  if (parent <= lo) return ascending ? 0 : lane.length;
  if (parent >= hi) return ascending ? lane.length : 0;

  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    const inLower = ascending ? p[mid] <= parent : p[mid] >= parent;
    if (inLower) a = mid;
    else b = mid;
  }
  const span = p[b] - p[a];
  const t = Math.abs(span) > 1e-9 ? (parent - p[a]) / span : 0;
  return lane.arclength[a] + (lane.arclength[b] - lane.arclength[a]) * t;
}

/** Position on `to` matching position `s` on `from`. Both must share a segment. */
export function mapS(from: Lane, s: number, to: Lane): number {
  return parentToLaneS(to, laneSToParent(from, s));
}

export interface LaneHit {
  laneId: number;
  s: number;
  distance: number;
}

/** Spatial index over lane centrelines, for picking and render culling. */
export class LaneIndex {
  private readonly index = new BoxIndex<number>();
  private readonly scratch: number[] = [];

  constructor(private readonly net: Network) {
    for (const lane of net.lanes) {
      if (lane.centerline.length < 4) continue;
      const box = bboxOfPolyline(lane.centerline);
      expandBbox(box, lane.width);
      this.index.add(box, lane.id);
    }
    this.index.build();
  }

  /** Lane ids whose bounding box overlaps the query rect. */
  query(minX: number, minY: number, maxX: number, maxY: number): number[] {
    return this.index.searchBox(minX, minY, maxX, maxY, this.scratch);
  }

  /** Closest lane centreline to a world point within `radius`, or null. */
  pick(x: number, y: number, radius: number, roadOnly = false): LaneHit | null {
    let best: LaneHit | null = null;
    for (const id of this.index.searchBox(x - radius, y - radius, x + radius, y + radius)) {
      const lane = this.net.lanes[id];
      if (roadOnly && lane.kind !== LaneKind.Road) continue;
      const n = lane.centerline.length >> 1;
      for (let i = 0; i < n - 1; i++) {
        const ax = lane.centerline[i * 2];
        const ay = lane.centerline[i * 2 + 1];
        const bx = lane.centerline[i * 2 + 2];
        const by = lane.centerline[i * 2 + 3];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 1e-9 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t;
        const cy = ay + dy * t;
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius || (best && d >= best.distance)) continue;
        best = {
          laneId: id,
          s: lane.arclength[i] + (lane.arclength[i + 1] - lane.arclength[i]) * t,
          distance: d,
        };
      }
    }
    return best;
  }
}
