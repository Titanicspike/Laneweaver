/**
 * Adding and removing control points on a stroke.
 *
 * There are two different things a person means by "add a point", and the difference
 * is where they clicked.
 *
 * On the road, it means "give me another handle here": insertion uses de Casteljau so
 * the shape does not change at all — the new point lands exactly on the existing
 * curve and its neighbours' handles are rewritten to match. Anything else would move
 * the road while you were only trying to get hold of it.
 *
 * Off the road, it means "go through here as well", and the road has to move, because
 * the point was not on it before. Past an end that is an extension; beside the middle
 * it is a bend in the nearest span. Both are `addControlPointAt` below.
 */

import { evalCubic, splitCubic } from '../core/geom/flatten';
import { cloneControlPoint, makeControlPoint } from '../core/network/model';
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


/**
 * Where a point clicked off the road would join it.
 *
 * Past an end means past it *along the road*, not merely nearest to it: standing off
 * to one side of the last few metres of a road is a bend in that span, while the same
 * distance further on is the road carrying on. The end's own tangent is what tells
 * the two apart.
 */
export function addPlacement(
  points: ReadonlyArray<ControlPoint>, x: number, y: number,
): { kind: 'extend'; atStart: boolean } | { kind: 'bend'; segment: number } | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  // Outward direction at each end: away from the neighbour it leads to. Taken from
  // the handle where there is one, so a curved end keeps curving the way it was.
  const outward = (end: ControlPoint, hx: number, hy: number, inner: ControlPoint): [number, number] => {
    let dx = hx - end.x;
    let dy = hy - end.y;
    if (Math.hypot(dx, dy) < 1e-3) { dx = end.x - inner.x; dy = end.y - inner.y; }
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const [sx, sy] = outward(first, first.hix, first.hiy, points[1]);
  const [ex, ey] = outward(last, last.hox, last.hoy, points[points.length - 2]);
  if ((x - first.x) * sx + (y - first.y) * sy > 0) return { kind: 'extend', atStart: true };
  if ((x - last.x) * ex + (y - last.y) * ey > 0) return { kind: 'extend', atStart: false };

  const hit = nearestOnStroke(points, x, y);
  if (!hit) return null;
  return { kind: 'bend', segment: hit.segment };
}

/**
 * Adds a control point at a place the road does not go, and makes it go there.
 *
 * The new point's handles are smoothed against its neighbours, and so are theirs —
 * but only for the two points either side of it, so shaping the rest of the road by
 * hand is not undone by adding a point somewhere else on it.
 */
export function addControlPointAt(
  points: ReadonlyArray<ControlPoint>, x: number, y: number,
): ControlPoint[] | null {
  const where = addPlacement(points, x, y);
  if (!where) return null;
  const out = points.map(cloneControlPoint);
  const at = where.kind === 'extend'
    ? (where.atStart ? 0 : out.length)
    : where.segment + 1;
  const near = out[where.kind === 'extend' && !where.atStart ? at - 1 : Math.max(0, at - 1)];
  const far = out[Math.min(out.length - 1, at)];
  // A point added part way along a ramp sits at the level the road has there; one
  // added past the end carries on at the level the end was at.
  const grade = where.kind === 'extend'
    ? (where.atStart ? out[0] : out[out.length - 1]).grade
    : (near.grade + far.grade) * 0.5;
  out.splice(at, 0, makeControlPoint(x, y, grade));
  smoothAround(out, at);
  return out;
}

/** Re-smooths a point and its immediate neighbours, leaving the rest alone. */
function smoothAround(points: ControlPoint[], index: number): void {
  for (let i = index - 1; i <= index + 1; i++) {
    const p = points[i];
    if (!p) continue;
    const prev = points[i - 1] ?? p;
    const next = points[i + 1] ?? p;
    const dx = (next.x - prev.x) / 3;
    const dy = (next.y - prev.y) / 3;
    p.hox = p.x + dx;
    p.hoy = p.y + dy;
    p.hix = p.x - dx;
    p.hiy = p.y - dy;
  }
}
