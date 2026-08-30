/**
 * Fitting cubic beziers to a polyline — the inverse of `flatten.ts`.
 *
 * Everything else in this project turns curves into points. Importing a road network
 * needs the other direction: survey data is a dense chain of positions, a vertex
 * every few metres and every one of them carrying the noise of however it was
 * traced. Handed to the editor as one control point per vertex it is not a road, it
 * is a thousand-point polygon: the shape reads as faceted at any zoom, the offsetter
 * spends its time repairing cusps that only exist because two consecutive vertices
 * disagree by a degree, and nobody can edit it.
 *
 * So: drop the vertices that say nothing (Douglas–Peucker), then fit cubics to what
 * is left (Schneider's algorithm — least-squares fit, Newton reparameterisation, and
 * a split at the worst point when the fit is not close enough). What comes out is a
 * handful of control points describing the same road to within a stated tolerance.
 *
 * The two ends are never moved. Everything downstream assumes a road that meets
 * another one still meets it: junctions are found geometrically, so an endpoint that
 * drifts half a metre in the fit is a T-junction that silently stops being one.
 */

const MAX_ITERATIONS = 6;
/**
 * Longest handle the fit will accept, as a share of the chord it spans.
 *
 * A cubic approximating a half-circle needs two thirds of its chord; a road, having
 * been split wherever it turns more than a corner's worth, needs far less. Anything
 * past this is the solve running away rather than the road curving.
 */
const MAX_HANDLE_OF_CHORD = 1.5;

/**
 * Douglas–Peucker: drops every vertex that lies within `tolerance` of the chord its
 * neighbours already describe.
 *
 * Iterative rather than recursive: an imported way can carry thousands of vertices,
 * and a recursive version of this is one deep coastline away from overflowing.
 */
export function simplifyPolyline(points: ArrayLike<number>, tolerance: number): Float32Array {
  const n = points.length >> 1;
  if (n < 3) return Float32Array.from(points as ArrayLike<number>);
  const keep = new Uint8Array(n);
  markKept(points, 0, n - 1, tolerance, keep);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  }
  return Float32Array.from(out);
}

/**
 * Which points of `points[lo..hi]` Douglas–Peucker keeps, written into `keep`.
 *
 * Separate from `simplifyPolyline` because a ring is not one polyline: a road's
 * surface runs up one edge and back down the other, and simplifying across the join
 * would cut the corner off the end cap. Marking the two runs separately keeps the
 * corners exactly and leaves the split index recoverable. Callers that need the
 * *indices* — to carry a parallel array like the per-point height along with the
 * geometry — need this rather than the points.
 */
export function markKept(
  points: ArrayLike<number>, lo: number, hi: number, tolerance: number, keep: Uint8Array,
): void {
  if (hi <= lo) { if (hi >= 0) keep[hi] = 1; if (lo >= 0) keep[lo] = 1; return; }
  keep[lo] = 1;
  keep[hi] = 1;
  const stack: [number, number][] = [[lo, hi]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const ax = points[lo * 2], ay = points[lo * 2 + 1];
    const bx = points[hi * 2], by = points[hi * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol2;
    for (let i = lo + 1; i < hi; i++) {
      const px = points[i * 2], py = points[i * 2 + 1];
      let d2: number;
      if (len2 < 1e-12) {
        d2 = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const cx = ax + dx * t, cy = ay + dy * t;
        d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      }
      if (d2 > worstD) { worstD = d2; worst = i; }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([lo, worst], [worst, hi]);
  }
}

/** One fitted cubic: its two ends and the two handles between them. */
export interface FittedCubic {
  x0: number; y0: number;
  c1x: number; c1y: number;
  c2x: number; c2y: number;
  x1: number; y1: number;
}

/**
 * Fits a chain of cubics to `points`, each within `tolerance` of it.
 *
 * `corner` is the turn, in radians, above which a vertex is treated as a corner
 * rather than as curvature: a road that turns 90° at a kerb line is two roads meeting
 * at a corner, and running one smooth curve through it rounds off the very feature
 * the survey was recording.
 */
export function fitPolyline(
  points: ArrayLike<number>, tolerance: number, corner = Math.PI / 4,
): FittedCubic[] {
  const n = points.length >> 1;
  if (n < 2) return [];
  if (n === 2) return [straight(points, 0, 1)];

  const out: FittedCubic[] = [];
  let start = 0;
  for (let i = 1; i < n - 1; i++) {
    const ax = points[i * 2] - points[i * 2 - 2], ay = points[i * 2 + 1] - points[i * 2 - 1];
    const bx = points[i * 2 + 2] - points[i * 2], by = points[i * 2 + 3] - points[i * 2 + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    if (turn < corner) continue;
    fitRange(points, start, i, tolerance, out);
    start = i;
  }
  fitRange(points, start, n - 1, tolerance, out);
  return out;
}

/** A straight cubic between two vertices, handles at the thirds. */
function straight(points: ArrayLike<number>, i: number, j: number): FittedCubic {
  const x0 = points[i * 2], y0 = points[i * 2 + 1];
  const x1 = points[j * 2], y1 = points[j * 2 + 1];
  return {
    x0, y0, x1, y1,
    c1x: x0 + (x1 - x0) / 3, c1y: y0 + (y1 - y0) / 3,
    c2x: x0 + ((x1 - x0) * 2) / 3, c2y: y0 + ((y1 - y0) * 2) / 3,
  };
}

/** Unit tangent leaving `i` toward `j`, from the first vertex that differs. */
function tangent(points: ArrayLike<number>, i: number, j: number): [number, number] {
  const step = j > i ? 1 : -1;
  for (let k = i + step; k !== j + step; k += step) {
    const dx = points[k * 2] - points[i * 2];
    const dy = points[k * 2 + 1] - points[i * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) return [dx / len, dy / len];
  }
  return [0, 0];
}

/** Fits `[first, last]` and appends the cubics, splitting where it cannot. */
function fitRange(
  points: ArrayLike<number>, first: number, last: number, tolerance: number, out: FittedCubic[],
): void {
  if (last - first < 1) return;
  if (last - first === 1) { out.push(straight(points, first, last)); return; }
  const t1 = tangent(points, first, last);
  const t2 = tangent(points, last, first);
  fitCubic(points, first, last, t1, t2, tolerance, out, 0);
}

/**
 * Schneider's fit: least squares, then Newton reparameterisation, then split at the
 * worst point if it still does not meet the tolerance.
 */
function fitCubic(
  points: ArrayLike<number>, first: number, last: number,
  t1: [number, number], t2: [number, number],
  tolerance: number, out: FittedCubic[], depth: number,
): void {
  const count = last - first + 1;
  if (count === 2) { out.push(straight(points, first, last)); return; }

  let u = chordParams(points, first, last);
  let curve = generate(points, first, last, u, t1, t2);
  let { error, at } = maxError(points, first, last, curve, u);
  if (error < tolerance) { out.push(curve); return; }

  // Close enough to be worth improving rather than splitting.
  if (error < tolerance * tolerance * 4 || depth < MAX_ITERATIONS) {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      u = reparameterise(points, first, last, curve, u);
      curve = generate(points, first, last, u, t1, t2);
      const next = maxError(points, first, last, curve, u);
      if (next.error < tolerance) { out.push(curve); return; }
      if (next.error >= error) { at = next.at; break; }
      error = next.error;
      at = next.at;
    }
  }

  // Split at the worst point, with a tangent along the polyline there.
  const split = Math.min(Math.max(at, first + 1), last - 1);
  if (depth > 12) { out.push(curve); return; }
  const ax = points[split * 2] - points[split * 2 - 2];
  const ay = points[split * 2 + 1] - points[split * 2 - 1];
  const bx = points[split * 2 + 2] - points[split * 2];
  const by = points[split * 2 + 3] - points[split * 2 + 1];
  let cx = ax + bx, cy = ay + by;
  const cl = Math.hypot(cx, cy);
  if (cl < 1e-9) { cx = 1; cy = 0; } else { cx /= cl; cy /= cl; }
  fitCubic(points, first, split, t1, [-cx, -cy], tolerance, out, depth + 1);
  fitCubic(points, split, last, [cx, cy], t2, tolerance, out, depth + 1);
}

/** Chord-length parameterisation, normalised to [0, 1]. */
function chordParams(points: ArrayLike<number>, first: number, last: number): Float64Array {
  const u = new Float64Array(last - first + 1);
  for (let i = first + 1; i <= last; i++) {
    u[i - first] = u[i - first - 1] + Math.hypot(
      points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  }
  const total = u[last - first] || 1;
  for (let i = 0; i <= last - first; i++) u[i] /= total;
  return u;
}

const B0 = (t: number): number => (1 - t) ** 3;
const B1 = (t: number): number => 3 * t * (1 - t) ** 2;
const B2 = (t: number): number => 3 * t * t * (1 - t);
const B3 = (t: number): number => t ** 3;

/** Least-squares handle lengths along the two fixed end tangents. */
function generate(
  points: ArrayLike<number>, first: number, last: number,
  u: Float64Array, t1: [number, number], t2: [number, number],
): FittedCubic {
  const x0 = points[first * 2], y0 = points[first * 2 + 1];
  const x1 = points[last * 2], y1 = points[last * 2 + 1];
  let c00 = 0, c01 = 0, c11 = 0, x = 0, y = 0;
  for (let i = 0; i <= last - first; i++) {
    const t = u[i];
    const a1x = t1[0] * B1(t), a1y = t1[1] * B1(t);
    const a2x = t2[0] * B2(t), a2y = t2[1] * B2(t);
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const tmpx = points[(first + i) * 2] - (x0 * (B0(t) + B1(t)) + x1 * (B2(t) + B3(t)));
    const tmpy = points[(first + i) * 2 + 1] - (y0 * (B0(t) + B1(t)) + y1 * (B2(t) + B3(t)));
    x += a1x * tmpx + a1y * tmpy;
    y += a2x * tmpx + a2y * tmpy;
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = 0, alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x * c11 - c01 * y) / det;
    alpha2 = (c00 * y - x * c01) / det;
  }
  // A degenerate solve falls back to the chord — the "Wu/Barsky" heuristic, which is
  // what keeps a noisy stretch from folding.
  //
  // Both ends of that matter. Handles pulled inside out give a curve with a cusp in
  // it, and the least-squares optimum for nearly-collinear data with nearly-parallel
  // end tangents is *unbounded*: on an imported city it produced handles 239 km long
  // on a 40 m road, which the compiler then dutifully turned into a junction
  // connector a hundred and fifty kilometres long and spent five minutes testing for
  // conflicts. A handle longer than the chord is already a curve that doubles back —
  // fitting a road, it never happens for a real reason.
  const chord = Math.hypot(x1 - x0, y1 - y0);
  const cap = chord * MAX_HANDLE_OF_CHORD;
  if (!(alpha1 > chord * 1e-6) || !(alpha2 > chord * 1e-6) || alpha1 > cap || alpha2 > cap) {
    alpha1 = chord / 3;
    alpha2 = chord / 3;
  }
  return {
    x0, y0, x1, y1,
    c1x: x0 + t1[0] * alpha1, c1y: y0 + t1[1] * alpha1,
    c2x: x1 + t2[0] * alpha2, c2y: y1 + t2[1] * alpha2,
  };
}

function at(c: FittedCubic, t: number, out: { x: number; y: number }): void {
  const b0 = B0(t), b1 = B1(t), b2 = B2(t), b3 = B3(t);
  out.x = c.x0 * b0 + c.c1x * b1 + c.c2x * b2 + c.x1 * b3;
  out.y = c.y0 * b0 + c.c1y * b1 + c.c2y * b2 + c.y1 * b3;
}

const _p = { x: 0, y: 0 };

/** Worst distance from the polyline to the curve, and where it is. */
function maxError(
  points: ArrayLike<number>, first: number, last: number, c: FittedCubic, u: Float64Array,
): { error: number; at: number } {
  let error = 0;
  let index = first + ((last - first) >> 1);
  for (let i = 0; i <= last - first; i++) {
    at(c, u[i], _p);
    const dx = _p.x - points[(first + i) * 2];
    const dy = _p.y - points[(first + i) * 2 + 1];
    const d = dx * dx + dy * dy;
    if (d > error) { error = d; index = first + i; }
  }
  return { error: Math.sqrt(error), at: index };
}

/** One Newton step per point, pulling each parameter toward its closest point. */
function reparameterise(
  points: ArrayLike<number>, first: number, last: number, c: FittedCubic, u: Float64Array,
): Float64Array {
  const out = new Float64Array(u.length);
  for (let i = 0; i <= last - first; i++) {
    const t = u[i];
    at(c, t, _p);
    const px = points[(first + i) * 2], py = points[(first + i) * 2 + 1];
    // First and second derivatives of the cubic at t.
    const d1x = 3 * ((c.c1x - c.x0) * (1 - t) ** 2 + 2 * (c.c2x - c.c1x) * t * (1 - t) + (c.x1 - c.c2x) * t * t);
    const d1y = 3 * ((c.c1y - c.y0) * (1 - t) ** 2 + 2 * (c.c2y - c.c1y) * t * (1 - t) + (c.y1 - c.c2y) * t * t);
    const d2x = 6 * ((c.c2x - 2 * c.c1x + c.x0) * (1 - t) + (c.x1 - 2 * c.c2x + c.c1x) * t);
    const d2y = 6 * ((c.c2y - 2 * c.c1y + c.y0) * (1 - t) + (c.y1 - 2 * c.c2y + c.c1y) * t);
    const num = (_p.x - px) * d1x + (_p.y - py) * d1y;
    const den = d1x * d1x + d1y * d1y + (_p.x - px) * d2x + (_p.y - py) * d2y;
    out[i] = Math.abs(den) < 1e-12 ? t : Math.max(0, Math.min(1, t - num / den));
  }
  out[0] = 0;
  out[last - first] = 1;
  return out;
}
