/**
 * Polyline operations.
 *
 * A polyline is a flat `Float32Array` of `[x0, y0, x1, y1, ...]`. Its companion
 * arc-length table is a `Float32Array` of cumulative distances with the same
 * point count, `arc[0] === 0`. Together they are the only geometry the simulation
 * ever sees.
 */

import type { Vec2 } from './vec2';
import { EPS } from './vec2';
import { closestParamOnSegment } from './intersect';

export type Polyline = Float32Array;

export function buildArclength(poly: ArrayLike<number>): Float32Array {
  const n = poly.length >> 1;
  const arc = new Float32Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    const dx = poly[i * 2] - poly[i * 2 - 2];
    const dy = poly[i * 2 + 1] - poly[i * 2 - 1];
    acc += Math.hypot(dx, dy);
    arc[i] = acc;
  }
  return arc;
}

export function polylineLength(poly: ArrayLike<number>): number {
  const n = poly.length >> 1;
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(poly[i * 2] - poly[i * 2 - 2], poly[i * 2 + 1] - poly[i * 2 - 1]);
  }
  return acc;
}

/**
 * Index `i` with `arc[i] <= s < arc[i+1]` (and `last` when `s` is at or past the
 * end). The interval is half-open on purpose: a vertex belongs to its *outgoing*
 * segment, so the answer never depends on the hint and stays canonical.
 *
 * `hint` is the caller's previous answer; vehicles advance monotonically so the
 * hint is almost always right or off by one, making this O(1) in the sim.
 */
export function segmentIndexForS(arc: ArrayLike<number>, s: number, hint = 0): number {
  const last = arc.length - 2;
  if (last < 0) return 0;
  if (s <= 0) return 0;
  if (s >= arc[last + 1]) return last;

  let h = hint;
  if (h < 0) h = 0;
  else if (h > last) h = last;
  if (arc[h] <= s && s < arc[h + 1]) return h;
  if (h + 1 <= last && arc[h + 1] <= s && s < arc[h + 2]) return h + 1;

  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function samplePosition(
  poly: ArrayLike<number>, arc: ArrayLike<number>, s: number, out: Vec2, hint = 0,
): number {
  const n = arc.length;
  if (n === 0) {
    out.x = 0; out.y = 0;
    return 0;
  }
  if (n === 1) {
    out.x = poly[0]; out.y = poly[1];
    return 0;
  }
  const i = segmentIndexForS(arc, s, hint);
  const s0 = arc[i];
  const segLen = arc[i + 1] - s0;
  let t = segLen > EPS ? (s - s0) / segLen : 0;
  // Clamp rather than extrapolate: a vehicle a hair past a lane end must render
  // at the end, not fly off the geometry.
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ax = poly[i * 2];
  const ay = poly[i * 2 + 1];
  out.x = ax + (poly[i * 2 + 2] - ax) * t;
  out.y = ay + (poly[i * 2 + 3] - ay) * t;
  return i;
}

/** Unit tangent of the segment containing `s`. Piecewise-constant but cheap. */
export function sampleTangent(
  poly: ArrayLike<number>, arc: ArrayLike<number>, s: number, out: Vec2, hint = 0,
): number {
  const n = arc.length;
  if (n < 2) {
    out.x = 1; out.y = 0;
    return 0;
  }
  const i = segmentIndexForS(arc, s, hint);
  const dx = poly[i * 2 + 2] - poly[i * 2];
  const dy = poly[i * 2 + 3] - poly[i * 2 + 1];
  const l = Math.hypot(dx, dy);
  if (l < EPS) {
    out.x = 1; out.y = 0;
  } else {
    out.x = dx / l;
    out.y = dy / l;
  }
  return i;
}

const _ta = { x: 0, y: 0 };
const _tb = { x: 0, y: 0 };

/**
 * Tangent smoothed over a window, so rendered headings do not step at vertices.
 * Uses two position samples rather than averaging segment directions, which keeps
 * it stable across very short segments.
 */
export function sampleSmoothTangent(
  poly: ArrayLike<number>, arc: ArrayLike<number>, s: number, out: Vec2,
  window = 0.75, hint = 0,
): void {
  const total = arc.length ? arc[arc.length - 1] : 0;
  if (total < EPS) {
    sampleTangent(poly, arc, s, out, hint);
    return;
  }
  const half = Math.min(window * 0.5, total * 0.5);
  const a = Math.max(0, Math.min(total, s - half));
  const b = Math.max(0, Math.min(total, s + half));
  samplePosition(poly, arc, a, _ta, hint);
  samplePosition(poly, arc, b, _tb, hint);
  const dx = _tb.x - _ta.x;
  const dy = _tb.y - _ta.y;
  const l = Math.hypot(dx, dy);
  if (l < EPS) {
    sampleTangent(poly, arc, s, out, hint);
  } else {
    out.x = dx / l;
    out.y = dy / l;
  }
}

export interface ClosestHit {
  /** Arc-length of the closest point. */
  s: number;
  x: number;
  y: number;
  /** Euclidean distance from the query point. */
  distance: number;
  /** Index of the containing segment. */
  segment: number;
  /** Parameter within that segment, in [0,1]. */
  t: number;
}

export function makeClosestHit(): ClosestHit {
  return { s: 0, x: 0, y: 0, distance: Infinity, segment: 0, t: 0 };
}

/** Brute-force closest point. Fine for editor interactions; the compiler uses the R-tree. */
export function closestOnPolyline(
  poly: ArrayLike<number>, arc: ArrayLike<number>, px: number, py: number, out: ClosestHit,
): ClosestHit {
  const n = poly.length >> 1;
  out.distance = Infinity;
  if (n === 0) return out;
  if (n === 1) {
    out.s = 0; out.x = poly[0]; out.y = poly[1]; out.segment = 0; out.t = 0;
    out.distance = Math.hypot(px - poly[0], py - poly[1]);
    return out;
  }
  for (let i = 0; i < n - 1; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[i * 2 + 2];
    const by = poly[i * 2 + 3];
    const t = closestParamOnSegment(ax, ay, bx, by, px, py);
    const cx = ax + (bx - ax) * t;
    const cy = ay + (by - ay) * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < out.distance) {
      out.distance = d;
      out.x = cx;
      out.y = cy;
      out.segment = i;
      out.t = t;
      out.s = arc[i] + (arc[i + 1] - arc[i]) * t;
    }
  }
  return out;
}

/** Extracts the sub-polyline between two arc-lengths, with exact end points. */
export function subPolyline(
  poly: ArrayLike<number>, arc: ArrayLike<number>, s0: number, s1: number,
): Polyline {
  const total = arc.length ? arc[arc.length - 1] : 0;
  const a = Math.max(0, Math.min(total, Math.min(s0, s1)));
  const b = Math.max(0, Math.min(total, Math.max(s0, s1)));
  const out: number[] = [];
  const p = { x: 0, y: 0 };
  samplePosition(poly, arc, a, p);
  out.push(p.x, p.y);
  const i0 = segmentIndexForS(arc, a);
  const i1 = segmentIndexForS(arc, b);
  for (let i = i0 + 1; i <= i1; i++) {
    if (arc[i] <= a + EPS || arc[i] >= b - EPS) continue;
    out.push(poly[i * 2], poly[i * 2 + 1]);
  }
  samplePosition(poly, arc, b, p);
  if (Math.hypot(p.x - out[out.length - 2], p.y - out[out.length - 1]) > EPS) out.push(p.x, p.y);
  // Degenerate range: keep a well-formed two-point polyline so arc-length tables work.
  if (out.length < 4) out.push(out[0], out[1]);
  return Float32Array.from(out);
}

/** Uniform resampling by arc-length. Always keeps both end points. */
export function resamplePolyline(
  poly: ArrayLike<number>, arc: ArrayLike<number>, spacing: number,
): Polyline {
  const total = arc.length ? arc[arc.length - 1] : 0;
  if (total < EPS || spacing <= 0) return Float32Array.from(poly);
  const steps = Math.max(1, Math.round(total / spacing));
  const out = new Float32Array((steps + 1) * 2);
  const p = { x: 0, y: 0 };
  let hint = 0;
  for (let i = 0; i <= steps; i++) {
    hint = samplePosition(poly, arc, (total * i) / steps, p, hint);
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.y;
  }
  return out;
}

/**
 * Subdivides so no segment exceeds `maxSpacing`, keeping every original vertex.
 * Used before variable-width offsetting, where tapers need dense samples but
 * corners must not be smoothed away.
 */
export function densify(poly: ArrayLike<number>, maxSpacing: number): Polyline {
  const n = poly.length >> 1;
  if (n < 2 || maxSpacing <= 0) return Float32Array.from(poly);
  const out: number[] = [poly[0], poly[1]];
  for (let i = 1; i < n; i++) {
    const ax = poly[i * 2 - 2];
    const ay = poly[i * 2 - 1];
    const bx = poly[i * 2];
    const by = poly[i * 2 + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxSpacing));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return Float32Array.from(out);
}

export function reversePolyline(poly: ArrayLike<number>): Polyline {
  const n = poly.length >> 1;
  const out = new Float32Array(poly.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = poly[(n - 1 - i) * 2];
    out[i * 2 + 1] = poly[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/** Drops consecutive duplicate points. */
export function dedupePolyline(poly: ArrayLike<number>, tol = 1e-4): Polyline {
  const n = poly.length >> 1;
  if (n < 2) return Float32Array.from(poly);
  const out: number[] = [poly[0], poly[1]];
  for (let i = 1; i < n; i++) {
    const x = poly[i * 2];
    const y = poly[i * 2 + 1];
    if (Math.hypot(x - out[out.length - 2], y - out[out.length - 1]) > tol) out.push(x, y);
  }
  if (out.length < 4) out.push(poly[(n - 1) * 2], poly[(n - 1) * 2 + 1]);
  return Float32Array.from(out);
}

/** Ramer-Douglas-Peucker. Used for render LOD, never for sim geometry. */
export function simplifyPolyline(poly: ArrayLike<number>, tolerance: number): Polyline {
  const n = poly.length >> 1;
  if (n < 3) return Float32Array.from(poly);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const end = stack.pop() as number;
    const start = stack.pop() as number;
    if (end - start < 2) continue;
    const ax = poly[start * 2];
    const ay = poly[start * 2 + 1];
    const dx = poly[end * 2] - ax;
    const dy = poly[end * 2 + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let best = -1;
    let bestD2 = tol2;
    for (let i = start + 1; i < end; i++) {
      const px = poly[i * 2];
      const py = poly[i * 2 + 1];
      let d2: number;
      if (l2 < EPS) {
        d2 = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t;
        const cy = ay + dy * t;
        d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      }
      if (d2 > bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push(start, best, best, end);
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) if (keep[i]) count++;
  const out = new Float32Array(count * 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[k * 2] = poly[i * 2];
    out[k * 2 + 1] = poly[i * 2 + 1];
    k++;
  }
  return out;
}

/**
 * Discrete signed curvature at vertex `i`, in 1/metres, from the circumscribed
 * circle of three consecutive points. Sign follows the turn direction.
 */
export function curvatureAt(poly: ArrayLike<number>, i: number): number {
  const n = poly.length >> 1;
  if (i <= 0 || i >= n - 1) return 0;
  const ax = poly[i * 2 - 2], ay = poly[i * 2 - 1];
  const bx = poly[i * 2], by = poly[i * 2 + 1];
  const cx = poly[i * 2 + 2], cy = poly[i * 2 + 3];
  const abx = bx - ax, aby = by - ay;
  const bcx = cx - bx, bcy = cy - by;
  const ab = Math.hypot(abx, aby);
  const bc = Math.hypot(bcx, bcy);
  const ca = Math.hypot(cx - ax, cy - ay);
  if (ab < EPS || bc < EPS || ca < EPS) return 0;
  return (2 * (abx * bcy - aby * bcx)) / (ab * bc * ca);
}

/**
 * The largest curvature the polyline sustains over a baseline of `span` metres.
 *
 * Curvature from three *adjacent* samples measures the sampling, not the road. An
 * adaptively flattened curve puts its points centimetres apart where it bends and
 * metres apart where it does not, and the circumcircle through three nearly
 * coincident points is numerically meaningless: one imported connector reported a
 * 0.13 m radius at a single vertex out of fourteen whose median radius was 34 m.
 * Anything reading that maximum as a speed limit throttles the whole movement to
 * walking pace — 138 straight-ahead movements in one city, each of which a driver
 * then has to brake to 13 km/h for.
 *
 * A vehicle does not feel one vertex. Lateral acceleration is set by the curvature
 * held for roughly its own length, so the triple is taken at a fixed arc-length
 * baseline rather than at adjacent indices. On a true arc that is exact at any
 * baseline — three points on a circle give back that circle whatever their spacing —
 * so the span costs nothing where the geometry is real and rejects it where it is
 * not. A polyline shorter than the baseline falls back to its own ends, which is the
 * same question asked over the length available.
 */
export function maxCurvatureOver(poly: ArrayLike<number>, span: number): number {
  const n = poly.length >> 1;
  if (n < 3) return 0;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    s[i] = s[i - 1]
      + Math.hypot(poly[i * 2] - poly[i * 2 - 2], poly[i * 2 + 1] - poly[i * 2 - 1]);
  }
  const half = Math.max(EPS, span / 2);
  let worst = 0;
  let a = 0;
  let c = 0;
  for (let i = 1; i < n - 1; i++) {
    while (a + 1 < i && s[i] - s[a + 1] >= half) a++;
    if (c < i) c = i;
    while (c + 1 < n && s[c] - s[i] < half) c++;
    if (a >= i || c <= i) continue;
    const ax = poly[a * 2], ay = poly[a * 2 + 1];
    const bx = poly[i * 2], by = poly[i * 2 + 1];
    const cx = poly[c * 2], cy = poly[c * 2 + 1];
    const abx = bx - ax, aby = by - ay;
    const bcx = cx - bx, bcy = cy - by;
    const ab = Math.hypot(abx, aby);
    const bc = Math.hypot(bcx, bcy);
    const ca = Math.hypot(cx - ax, cy - ay);
    if (ab < EPS || bc < EPS || ca < EPS) continue;
    worst = Math.max(worst, Math.abs((2 * (abx * bcy - aby * bcx)) / (ab * bc * ca)));
  }
  return worst;
}

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function makeBbox(): Bbox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function bboxOfPolyline(poly: ArrayLike<number>, out: Bbox = makeBbox()): Bbox {
  out.minX = Infinity; out.minY = Infinity; out.maxX = -Infinity; out.maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i];
    const y = poly[i + 1];
    if (x < out.minX) out.minX = x;
    if (y < out.minY) out.minY = y;
    if (x > out.maxX) out.maxX = x;
    if (y > out.maxY) out.maxY = y;
  }
  return out;
}

export function expandBbox(b: Bbox, pad: number): Bbox {
  b.minX -= pad; b.minY -= pad; b.maxX += pad; b.maxY += pad;
  return b;
}

/** Concatenates polylines, dropping duplicated joint points. */
export function concatPolylines(parts: ReadonlyArray<ArrayLike<number>>): Polyline {
  const out: number[] = [];
  for (const part of parts) {
    const n = part.length >> 1;
    for (let i = 0; i < n; i++) {
      const x = part[i * 2];
      const y = part[i * 2 + 1];
      if (out.length >= 2) {
        const dx = x - out[out.length - 2];
        const dy = y - out[out.length - 1];
        if (dx * dx + dy * dy < 1e-8) continue;
      }
      out.push(x, y);
    }
  }
  return Float32Array.from(out);
}
