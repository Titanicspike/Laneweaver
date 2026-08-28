/**
 * Adaptive bezier flattening.
 *
 * "Sample, don't solve": every downstream stage (crossings, offsets, arc-length,
 * lane geometry) works on polylines produced here. The tolerance is the single
 * knob that trades point count for fidelity; the compiler uses ~0.15 m.
 */

export const DEFAULT_FLATTEN_TOLERANCE = 0.15; // metres
/** Long straights get subdivided anyway so R-tree boxes stay tight. */
export const DEFAULT_MAX_SEGMENT = 20; // metres

const MAX_DEPTH = 18;

/**
 * Geometric flatness test.
 *
 * We care about how far the *image* of the curve strays from the chord, not about
 * parameterisation — a straight stroke drawn with degenerate handles
 * (P1 = P0, P2 = P3) is perfectly flat and must not subdivide. So: perpendicular
 * distance of the two control points from the chord line, scaled by the standard
 * 3/4 bound on cubic deviation, plus an overhang guard so a curve whose control
 * points project outside the chord still gets split.
 */
function isFlat(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  tol: number,
): boolean {
  const tol2 = tol * tol;
  const dx = x3 - x0;
  const dy = y3 - y0;
  const chord2 = dx * dx + dy * dy;

  if (chord2 < 1e-12) {
    // Closed loop: flat only if the whole control hull collapses to a point.
    const a = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
    const b = (x2 - x0) * (x2 - x0) + (y2 - y0) * (y2 - y0);
    return a <= tol2 && b <= tol2;
  }

  // Squared perpendicular distances from the chord line.
  const c1 = (x1 - x0) * dy - (y1 - y0) * dx;
  const c2 = (x2 - x0) * dy - (y2 - y0) * dx;
  const worst2 = Math.max(c1 * c1, c2 * c2) / chord2;
  if (0.5625 * worst2 > tol2) return false; // (3/4)^2

  // Overhang guard: control points must project onto (roughly) the chord span.
  const margin = tol / Math.sqrt(chord2);
  const t1 = ((x1 - x0) * dx + (y1 - y0) * dy) / chord2;
  if (t1 < -margin || t1 > 1 + margin) return false;
  const t2 = ((x2 - x0) * dx + (y2 - y0) * dy) / chord2;
  return t2 >= -margin && t2 <= 1 + margin;
}

function emitSplit(
  out: number[],
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  tol: number, maxSeg: number, depth: number,
): void {
  const chord2 = (x3 - x0) * (x3 - x0) + (y3 - y0) * (y3 - y0);
  if (depth >= MAX_DEPTH || (isFlat(x0, y0, x1, y1, x2, y2, x3, y3, tol) && chord2 <= maxSeg * maxSeg)) {
    out.push(x3, y3);
    return;
  }
  // de Casteljau at t = 0.5
  const x01 = (x0 + x1) * 0.5, y01 = (y0 + y1) * 0.5;
  const x12 = (x1 + x2) * 0.5, y12 = (y1 + y2) * 0.5;
  const x23 = (x2 + x3) * 0.5, y23 = (y2 + y3) * 0.5;
  const x012 = (x01 + x12) * 0.5, y012 = (y01 + y12) * 0.5;
  const x123 = (x12 + x23) * 0.5, y123 = (y12 + y23) * 0.5;
  const xm = (x012 + x123) * 0.5, ym = (y012 + y123) * 0.5;
  emitSplit(out, x0, y0, x01, y01, x012, y012, xm, ym, tol, maxSeg, depth + 1);
  emitSplit(out, xm, ym, x123, y123, x23, y23, x3, y3, tol, maxSeg, depth + 1);
}

/**
 * Appends the flattened cubic to `out` as flat [x,y,...] pairs.
 * The start point is *not* emitted (callers chain curves), the end point is.
 */
export function flattenCubicInto(
  out: number[],
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  tol = DEFAULT_FLATTEN_TOLERANCE,
  maxSeg = DEFAULT_MAX_SEGMENT,
): void {
  emitSplit(out, x0, y0, x1, y1, x2, y2, x3, y3, tol, maxSeg, 0);
}

export function evalCubic(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  t: number,
  out: { x: number; y: number },
): void {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  out.x = a * x0 + b * x1 + c * x2 + d * x3;
  out.y = a * y0 + b * y1 + c * y2 + d * y3;
}

export function cubicDerivative(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  t: number,
  out: { x: number; y: number },
): void {
  const mt = 1 - t;
  const a = 3 * mt * mt;
  const b = 6 * mt * t;
  const c = 3 * t * t;
  out.x = a * (x1 - x0) + b * (x2 - x1) + c * (x3 - x2);
  out.y = a * (y1 - y0) + b * (y2 - y1) + c * (y3 - y2);
}

export interface CubicSplit {
  /** Control points of the [0, t] half: p0, c0, c1, p1. */
  left: [number, number, number, number, number, number, number, number];
  /** Control points of the [t, 1] half. */
  right: [number, number, number, number, number, number, number, number];
}

/** de Casteljau split — used when the editor inserts a control point mid-stroke. */
export function splitCubic(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  t: number,
): CubicSplit {
  const x01 = x0 + (x1 - x0) * t, y01 = y0 + (y1 - y0) * t;
  const x12 = x1 + (x2 - x1) * t, y12 = y1 + (y2 - y1) * t;
  const x23 = x2 + (x3 - x2) * t, y23 = y2 + (y3 - y2) * t;
  const x012 = x01 + (x12 - x01) * t, y012 = y01 + (y12 - y01) * t;
  const x123 = x12 + (x23 - x12) * t, y123 = y12 + (y23 - y12) * t;
  const xm = x012 + (x123 - x012) * t, ym = y012 + (y123 - y012) * t;
  return {
    left: [x0, y0, x01, y01, x012, y012, xm, ym],
    right: [xm, ym, x123, y123, x23, y23, x3, y3],
  };
}
