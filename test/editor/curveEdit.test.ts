import { describe, expect, it } from 'vitest';
import { insertControlPoint, nearestOnStroke, removeControlPoint } from '@editor/curveEdit';
import { autoSmoothHandles, makeControlPoint } from '@core/network/model';
import { flattenCubicInto } from '@core/geom/flatten';
import { closestOnPolyline, buildArclength, makeClosestHit } from '@core/geom/polyline';
import type { ControlPoint } from '@core/network/types';

function curve(): ControlPoint[] {
  const points = [makeControlPoint(0, 0), makeControlPoint(200, 120), makeControlPoint(400, 0)];
  autoSmoothHandles(points);
  return points;
}

function flatten(points: ControlPoint[]): Float32Array {
  const out: number[] = [points[0].x, points[0].y];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    flattenCubicInto(out, a.x, a.y, a.hox, a.hoy, b.hix, b.hiy, b.x, b.y, 0.05);
  }
  return Float32Array.from(out);
}

/** Largest distance from any point of `a` to the curve `b`. */
function deviation(a: Float32Array, b: Float32Array): number {
  const arc = buildArclength(b);
  const hit = makeClosestHit();
  let worst = 0;
  for (let i = 0; i < a.length; i += 2) {
    closestOnPolyline(b, arc, a[i], a[i + 1], hit);
    worst = Math.max(worst, hit.distance);
  }
  return worst;
}

describe('nearestOnStroke', () => {
  it('finds the segment and parameter under a point', () => {
    const points = curve();
    const hit = nearestOnStroke(points, 0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.segment).toBe(0);
    expect(hit!.t).toBeCloseTo(0, 2);
    expect(hit!.distance).toBeCloseTo(0, 6);
  });

  it('returns null for a degenerate stroke', () => {
    expect(nearestOnStroke([makeControlPoint(0, 0)], 0, 0)).toBeNull();
  });
});

describe('insertControlPoint', () => {
  it('adds a point without changing the shape of the road', () => {
    const before = curve();
    const flatBefore = flatten(before);
    const after = insertControlPoint(before, 100, 45, 40);
    expect(after).not.toBeNull();
    expect(after!.length).toBe(before.length + 1);
    expect(deviation(flatten(after!), flatBefore)).toBeLessThan(0.05);
    expect(deviation(flatBefore, flatten(after!))).toBeLessThan(0.05);
  });

  it('puts the new point on the curve', () => {
    const before = curve();
    const after = insertControlPoint(before, 100, 45, 40)!;
    const hit = nearestOnStroke(before, after[1].x, after[1].y);
    expect(hit!.distance).toBeLessThan(0.05);
  });

  it('ignores clicks too far from the road', () => {
    expect(insertControlPoint(curve(), 100, 400, 20)).toBeNull();
  });

  it('refuses to split right on top of an existing point', () => {
    const points = curve();
    expect(insertControlPoint(points, points[0].x, points[0].y, 40)).toBeNull();
    expect(insertControlPoint(points, points[2].x, points[2].y, 40)).toBeNull();
  });
});

describe('removeControlPoint', () => {
  it('removes a middle point', () => {
    const points = curve();
    const after = removeControlPoint(points, 1);
    expect(after!.length).toBe(2);
  });

  it('keeps at least two points', () => {
    const points = [makeControlPoint(0, 0), makeControlPoint(100, 0)];
    expect(removeControlPoint(points, 0)).toBeNull();
  });

  it('ignores an index that does not exist', () => {
    expect(removeControlPoint(curve(), 9)).toBeNull();
  });
});
