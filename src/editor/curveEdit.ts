/**
 * Adding and removing control points on a stroke.
 *
 * Insertion uses de Casteljau so the road's shape does not change at all — the new
 * point lands exactly on the existing curve and its neighbours' handles are
 * rewritten to match. Anything else would move the road while you were only trying
 * to give yourself another handle.
 */

import { evalCubic, splitCubic } from '../core/geom/flatten';
import { cloneControlPoint } from '../core/network/model';
import type { ControlPoint } from '../core/network/types';

const SAMPLES = 48;
const _p = { x: 0, y: 0 };

interface Nearest {
  segment: number;
  t: number;
  distance: number;
}

/** Closest point on the stroke, as a (segment, t) pair. */
export function nearestOnStroke(points: ReadonlyArray<ControlPoint>, x: number, y: number): Nearest | null {
  if (points.length < 2) return null;
  let best: Nearest | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let k = 0; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      evalCubic(a.x, a.y, a.hox, a.hoy, b.hix, b.hiy, b.x, b.y, t, _p);
      const d = Math.hypot(_p.x - x, _p.y - y);
      if (!best || d < best.distance) best = { segment: i, t, distance: d };
    }
  }
  return best;
}

/**
 * Inserts a control point at the closest place on the stroke, or returns null when
 * the click is further than `tolerance` from it.
 */
export function insertControlPoint(
  points: ReadonlyArray<ControlPoint>, x: number, y: number, tolerance: number,
): ControlPoint[] | null {
  const hit = nearestOnStroke(points, x, y);
  if (!hit || hit.distance > tolerance) return null;
  // Splitting right on top of an existing point would make a zero-length segment.
  if (hit.t < 0.03 || hit.t > 0.97) return null;

  const a = points[hit.segment];
  const b = points[hit.segment + 1];
  const { left, right } = splitCubic(a.x, a.y, a.hox, a.hoy, b.hix, b.hiy, b.x, b.y, hit.t);

  const out = points.map(cloneControlPoint);
  const before = out[hit.segment];
  const after = out[hit.segment + 1];
  before.hox = left[2];
  before.hoy = left[3];
  after.hix = right[4];
  after.hiy = right[5];
  out.splice(hit.segment + 1, 0, {
    x: left[6], y: left[7],
    hix: left[4], hiy: left[5],
    hox: right[2], hoy: right[3],
    // A point added part way along a ramp sits at the level the ramp has there.
    grade: before.grade + (after.grade - before.grade) * 0.5,
  });
  return out;
}

/** Removes a control point, keeping at least two. */
export function removeControlPoint(
  points: ReadonlyArray<ControlPoint>, index: number,
): ControlPoint[] | null {
  if (points.length <= 2 || index < 0 || index >= points.length) return null;
  const out = points.map(cloneControlPoint);
  out.splice(index, 1);
  return out;
}
