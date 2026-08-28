import { describe, expect, it } from 'vitest';
import { flattenCubicInto, evalCubic, splitCubic, cubicDerivative } from '@core/geom/flatten';
import { polylineLength, buildArclength, closestOnPolyline, makeClosestHit } from '@core/geom/polyline';

function flatten(cp: number[], tol = 0.15, maxSeg = 1e9): Float32Array {
  const out: number[] = [cp[0], cp[1]];
  flattenCubicInto(out, cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], tol, maxSeg);
  return Float32Array.from(out);
}

describe('flattenCubic', () => {
  it('reduces a straight curve to its chord', () => {
    const poly = flatten([0, 0, 33, 0, 66, 0, 100, 0]);
    expect(poly.length >> 1).toBe(2);
    expect(polylineLength(poly)).toBeCloseTo(100, 6);
  });

  it('honours maxSegment on long straights', () => {
    const poly = flatten([0, 0, 33, 0, 66, 0, 100, 0], 0.15, 20);
    expect(poly.length >> 1).toBeGreaterThanOrEqual(6);
    expect(polylineLength(poly)).toBeCloseTo(100, 4);
  });

  it('stays within tolerance of the true curve', () => {
    const cp = [0, 0, 0, 120, 200, 120, 200, 0];
    const tol = 0.15;
    const poly = flatten(cp, tol);
    const arc = buildArclength(poly);
    const hit = makeClosestHit();
    const p = { x: 0, y: 0 };
    let worst = 0;
    for (let i = 0; i <= 2000; i++) {
      evalCubic(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], i / 2000, p);
      closestOnPolyline(poly, arc, p.x, p.y, hit);
      worst = Math.max(worst, hit.distance);
    }
    expect(worst).toBeLessThanOrEqual(tol);
  });

  it('spends fewer points at a looser tolerance', () => {
    const cp = [0, 0, 0, 120, 200, 120, 200, 0];
    expect(flatten(cp, 1.5).length).toBeLessThan(flatten(cp, 0.05).length);
  });

  it('handles a degenerate curve without hanging', () => {
    const poly = flatten([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(poly.length >> 1).toBe(2);
  });
});

describe('splitCubic', () => {
  it('reproduces the original curve', () => {
    const cp = [0, 0, 10, 40, 90, 40, 100, 0];
    const { left, right } = splitCubic(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], 0.37);
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      evalCubic(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], t * 0.37, a);
      evalCubic(left[0], left[1], left[2], left[3], left[4], left[5], left[6], left[7], t, b);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);

      evalCubic(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], 0.37 + t * 0.63, a);
      evalCubic(right[0], right[1], right[2], right[3], right[4], right[5], right[6], right[7], t, b);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
    }
  });
});

describe('cubicDerivative', () => {
  it('matches a finite difference', () => {
    const cp = [0, 0, 10, 40, 90, 40, 100, 0];
    const d = { x: 0, y: 0 };
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    const h = 1e-5;
    cubicDerivative(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], 0.4, d);
    evalCubic(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], 0.4 - h, a);
    evalCubic(cp[0], cp[1], cp[2], cp[3], cp[4], cp[5], cp[6], cp[7], 0.4 + h, b);
    expect(d.x).toBeCloseTo((b.x - a.x) / (2 * h), 2);
    expect(d.y).toBeCloseTo((b.y - a.y) / (2 * h), 2);
  });
});
