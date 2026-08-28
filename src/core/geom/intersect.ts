import { EPS, cross3 } from './vec2';

/** Filled by `segmentIntersect` to avoid allocating a result object per test. */
export interface SegHit {
  /** Parameter along AB, in [0,1]. */
  t: number;
  /** Parameter along CD, in [0,1]. */
  u: number;
  x: number;
  y: number;
}

export function makeSegHit(): SegHit {
  return { t: 0, u: 0, x: 0, y: 0 };
}

/**
 * Proper segment-segment intersection.
 *
 * Returns `false` for parallel/collinear pairs: collinear overlap is not a
 * crossing in our model, it is a near-parallel overlap that the compiler rejects
 * at classify time (see the sliver-junction tarpit note in CLAUDE.md).
 */
export function segmentIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
  out: SegHit,
): boolean {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return false;

  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / denom;
  if (t < 0 || t > 1) return false;
  const u = (qpx * ry - qpy * rx) / denom;
  if (u < 0 || u > 1) return false;

  out.t = t;
  out.u = u;
  out.x = ax + rx * t;
  out.y = ay + ry * t;
  return true;
}

/** Infinite-line intersection; `false` when the lines are parallel. */
export function lineIntersect(
  ax: number, ay: number, adx: number, ady: number,
  bx: number, by: number, bdx: number, bdy: number,
  out: { x: number; y: number },
): boolean {
  const denom = adx * bdy - ady * bdx;
  if (Math.abs(denom) < 1e-12) return false;
  const t = ((bx - ax) * bdy - (by - ay) * bdx) / denom;
  out.x = ax + adx * t;
  out.y = ay + ady * t;
  return true;
}

/** Parameter of the closest point on segment AB to P, clamped to [0,1]. */
export function closestParamOnSegment(
  ax: number, ay: number, bx: number, by: number,
  px: number, py: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < EPS) return 0;
  const t = ((px - ax) * dx + (py - ay) * dy) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function pointSegmentDistance(
  ax: number, ay: number, bx: number, by: number,
  px: number, py: number,
): number {
  const t = closestParamOnSegment(ax, ay, bx, by, px, py);
  const cx = ax + (bx - ax) * t;
  const cy = ay + (by - ay) * t;
  return Math.hypot(px - cx, py - cy);
}

/** Signed area (>0 counter-clockwise in a y-up frame). */
export function polygonArea(points: ArrayLike<number>): number {
  const n = points.length >> 1;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += points[j * 2] * points[i * 2 + 1] - points[i * 2] * points[j * 2 + 1];
  }
  return a * 0.5;
}

export function pointInPolygon(points: ArrayLike<number>, px: number, py: number): boolean {
  const n = points.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Orientation test, exposed for junction/turn classification. */
export { cross3 };
