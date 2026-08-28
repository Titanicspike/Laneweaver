/**
 * Polygon boolean operations, used for junction footprints and covers.
 *
 * `polygon-clipping` is the one place we do "solve" rather than "sample" —
 * unioning corridor ends by hand is genuinely hard and this library is robust.
 * Coordinates are snapped to a millimetre grid first, which keeps its
 * intersection arithmetic well conditioned on real-world-scale inputs.
 */

import * as pc from 'polygon-clipping';
import { polygonArea } from './intersect';

export type Ring = [number, number][];
export type PolygonGeom = Ring[];
export type MultiPolygonGeom = PolygonGeom[];

const SNAP = 1e3; // 1 mm

function snap(v: number): number {
  return Math.round(v * SNAP) / SNAP;
}

/** Flat `[x,y,...]` to a closed ring. */
export function toRing(points: ArrayLike<number>): Ring {
  const n = points.length >> 1;
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const x = snap(points[i * 2]);
    const y = snap(points[i * 2 + 1]);
    const prev = ring[ring.length - 1];
    if (prev && prev[0] === x && prev[1] === y) continue;
    ring.push([x, y]);
  }
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push([ring[0][0], ring[0][1]]);
  }
  return ring;
}

export function fromRing(ring: Ring): Float32Array {
  // Drop the repeated closing vertex.
  let n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = ring[i][0];
    out[i * 2 + 1] = ring[i][1];
  }
  return out;
}

/**
 * Unions a set of simple polygons and returns the largest resulting outer ring.
 * Junction footprints are single connected blobs by construction, so keeping the
 * biggest ring is the right answer and degrades gracefully if the union splits.
 */
export function unionPolygons(polys: ReadonlyArray<ArrayLike<number>>): Float32Array {
  const usable = polys.filter((p) => p.length >= 6);
  if (usable.length === 0) return new Float32Array(0);
  if (usable.length === 1) return Float32Array.from(usable[0]);

  let result: MultiPolygonGeom;
  try {
    const geoms = usable.map((p) => [toRing(p)] as PolygonGeom);
    result = pc.union(geoms[0], ...geoms.slice(1)) as MultiPolygonGeom;
  } catch {
    // Numerically pathological input: fall back to the convex hull of everything.
    return convexHull(concatPoints(usable));
  }
  if (!result || result.length === 0) return convexHull(concatPoints(usable));

  let best: Ring | null = null;
  let bestArea = -Infinity;
  for (const poly of result) {
    if (!poly.length) continue;
    const flat = fromRing(poly[0]);
    const area = Math.abs(polygonArea(flat));
    if (area > bestArea) {
      bestArea = area;
      best = poly[0];
    }
  }
  return best ? fromRing(best) : new Float32Array(0);
}

function concatPoints(polys: ReadonlyArray<ArrayLike<number>>): Float32Array {
  let total = 0;
  for (const p of polys) total += p.length;
  const out = new Float32Array(total);
  let k = 0;
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) out[k++] = p[i];
  }
  return out;
}

/** Andrew's monotone chain. */
export function convexHull(points: ArrayLike<number>): Float32Array {
  const n = points.length >> 1;
  if (n < 3) return Float32Array.from(points);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort((a, b) => {
    const dx = points[a * 2] - points[b * 2];
    if (dx !== 0) return dx;
    return points[a * 2 + 1] - points[b * 2 + 1];
  });

  const cross = (o: number, a: number, b: number): number =>
    (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) -
    (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);

  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  const out = new Float32Array(hull.length * 2);
  for (let i = 0; i < hull.length; i++) {
    out[i * 2] = points[hull[i] * 2];
    out[i * 2 + 1] = points[hull[i] * 2 + 1];
  }
  return out;
}

/** Axis-aligned quad, handy for tests and simple covers. */
export function rectPolygon(x: number, y: number, w: number, h: number): Float32Array {
  return Float32Array.from([x, y, x + w, y, x + w, y + h, x, y + h]);
}

/** Oriented quad around a segment, used to build corridor ends. */
export function segmentQuad(
  ax: number, ay: number, bx: number, by: number, half: number,
): Float32Array {
  let dx = bx - ax;
  let dy = by - ay;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return new Float32Array(0);
  dx /= l;
  dy /= l;
  const nx = -dy * half;
  const ny = dx * half;
  return Float32Array.from([
    ax + nx, ay + ny,
    bx + nx, by + ny,
    bx - nx, by - ny,
    ax - nx, ay - ny,
  ]);
}

/**
 * Rounds a closed polygon's corners with a quadratic fillet of the given radius,
 * clamped so a corner never eats more than 45% of either edge it sits on.
 *
 * Corner *cutting* (Chaikin) is the wrong tool for a junction footprint: it shortens
 * every straight run, so the approach corridors stop matching the roads they
 * continue and the joint shows up as a step. A fillet leaves the straights exactly
 * where they were and only replaces the corner itself.
 */
export function roundCorners(
  points: ArrayLike<number>, radius: number, steps = 4,
): Float32Array {
  const n = points.length >> 1;
  if (n < 3 || radius <= 0) return Float32Array.from(points);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = ((i + n - 1) % n) * 2;
    const v = i * 2;
    const q = ((i + 1) % n) * 2;
    let ax = points[p] - points[v], ay = points[p + 1] - points[v + 1];
    let bx = points[q] - points[v], by = points[q + 1] - points[v + 1];
    const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
    if (al < 1e-6 || bl < 1e-6) continue;
    ax /= al; ay /= al; bx /= bl; by /= bl;
    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by));
    // Collinear runs and hairline spikes are left alone.
    if (dot < -0.999 || dot > 0.999) { out.push(points[v], points[v + 1]); continue; }
    const r = Math.min(radius, al * 0.45, bl * 0.45);
    const sx = points[v] + ax * r, sy = points[v + 1] + ay * r;
    const ex = points[v] + bx * r, ey = points[v + 1] + by * r;
    out.push(sx, sy);
    for (let k = 1; k < steps; k++) {
      const t = k / steps, mt = 1 - t;
      out.push(
        mt * mt * sx + 2 * mt * t * points[v] + t * t * ex,
        mt * mt * sy + 2 * mt * t * points[v + 1] + t * t * ey,
      );
    }
    out.push(ex, ey);
  }
  return Float32Array.from(out);
}

/** Chaikin corner cutting. Kept for covers, where shortening the straights is fine. */
export function smoothClosed(points: ArrayLike<number>, iterations = 1, ratio = 0.25): Float32Array {
  let cur = Float32Array.from(points);
  for (let it = 0; it < iterations; it++) {
    const n = cur.length >> 1;
    if (n < 4) break;
    const next = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = cur[i * 2], ay = cur[i * 2 + 1];
      const bx = cur[j * 2], by = cur[j * 2 + 1];
      next[i * 4] = ax + (bx - ax) * ratio;
      next[i * 4 + 1] = ay + (by - ay) * ratio;
      next[i * 4 + 2] = ax + (bx - ax) * (1 - ratio);
      next[i * 4 + 3] = ay + (by - ay) * (1 - ratio);
    }
    cur = next;
  }
  return cur;
}
