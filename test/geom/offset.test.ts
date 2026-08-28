import { describe, expect, it } from 'vitest';
import { offsetPolyline, offsetPolylineVariable, corridorPolygon } from '@core/geom/offset';
import { buildArclength, polylineLength, closestOnPolyline, makeClosestHit, densify } from '@core/geom/polyline';
import { polygonArea } from '@core/geom/intersect';
import { segmentIntersect, makeSegHit } from '@core/geom/intersect';

function arcOf(p: ArrayLike<number>) {
  return buildArclength(p);
}

/** Circle sampled counter-clockwise in a y-down frame (i.e. turning left). */
function arc(radius: number, sweep: number, steps = 200): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (sweep * i) / steps;
    pts.push(radius * Math.sin(a), radius - radius * Math.cos(a));
  }
  return Float32Array.from(pts);
}

function selfIntersects(poly: Float32Array): boolean {
  const n = poly.length >> 1;
  const hit = makeSegHit();
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (segmentIntersect(
        poly[i * 2], poly[i * 2 + 1], poly[i * 2 + 2], poly[i * 2 + 3],
        poly[j * 2], poly[j * 2 + 1], poly[j * 2 + 2], poly[j * 2 + 3], hit,
      )) return true;
    }
  }
  return false;
}

describe('offsetPolyline', () => {
  it('offsets a straight line to the right of travel', () => {
    const line = Float32Array.from([0, 0, 100, 0]);
    const r = offsetPolyline(line, arcOf(line), 3.5);
    // Travelling +x with y down, "right" is +y.
    expect(r.points[1]).toBeCloseTo(3.5, 5);
    expect(r.points[3]).toBeCloseTo(3.5, 5);
    expect(r.worstRatio).toBeCloseTo(0, 6);
  });

  it('offsets negative distances to the left', () => {
    const line = Float32Array.from([0, 0, 100, 0]);
    const r = offsetPolyline(line, arcOf(line), -3.5);
    expect(r.points[1]).toBeCloseTo(-3.5, 5);
  });

  it('keeps a constant gap around a gentle curve', () => {
    const c = arc(200, Math.PI / 3);
    const r = offsetPolyline(c, arcOf(c), 3.5);
    const hit = makeClosestHit();
    const src = arcOf(c);
    let worst = 0;
    for (let i = 2; i < (r.points.length >> 1) - 2; i++) {
      closestOnPolyline(c, src, r.points[i * 2], r.points[i * 2 + 1], hit);
      worst = Math.max(worst, Math.abs(hit.distance - 3.5));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('preserves the source parameter of every surviving point', () => {
    const c = arc(200, Math.PI / 3);
    const r = offsetPolyline(c, arcOf(c), 3.5);
    for (let i = 1; i < r.sourceS.length; i++) {
      expect(r.sourceS[i]).toBeGreaterThanOrEqual(r.sourceS[i - 1]);
    }
    expect(r.sourceS[0]).toBeCloseTo(0, 6);
    expect(r.sourceS[r.sourceS.length - 1]).toBeCloseTo(arcOf(c)[c.length / 2 - 1], 3);
  });

  it('flags offsets tighter than the turning radius', () => {
    const c = arc(6, Math.PI, 400);
    const inside = offsetPolyline(c, arcOf(c), -8); // toward the centre of the turn
    expect(inside.worstRatio).toBeGreaterThan(1);
  });

  it('produces no self-intersections on a tight inside offset', () => {
    const c = arc(6, Math.PI, 400);
    const inside = offsetPolyline(c, arcOf(c), -8);
    expect(selfIntersects(inside.points)).toBe(false);
  });

  it('survives a sharp corner without folding', () => {
    const l = densify(Float32Array.from([0, 0, 40, 0, 40, 40]), 1);
    const r = offsetPolyline(l, arcOf(l), -4);
    expect(selfIntersects(r.points)).toBe(false);
    expect(r.points.length).toBeGreaterThan(4);
  });
});

describe('offsetPolylineVariable', () => {
  it('tapers a lane down to zero width', () => {
    const line = densify(Float32Array.from([0, 0, 100, 0]), 1);
    const a = arcOf(line);
    const r = offsetPolylineVariable(line, a, (s) => 3.5 * (1 - s / 100));
    expect(r.points[1]).toBeCloseTo(3.5, 4);
    expect(r.points[r.points.length - 1]).toBeCloseTo(0, 4);
    // Monotone drift inward.
    for (let i = 1; i < r.points.length >> 1; i++) {
      expect(r.points[i * 2 + 1]).toBeLessThanOrEqual(r.points[i * 2 - 1] + 1e-4);
    }
  });
});

describe('corridorPolygon', () => {
  it('encloses the expected area for a straight road', () => {
    const line = Float32Array.from([0, 0, 100, 0]);
    const poly = corridorPolygon(line, arcOf(line), 7);
    expect(Math.abs(polygonArea(poly))).toBeCloseTo(100 * 14, 3);
  });

  it('closes around a curve', () => {
    const c = arc(80, Math.PI / 2);
    const poly = corridorPolygon(c, arcOf(c), 7);
    const expected = polylineLength(c) * 14;
    expect(Math.abs(polygonArea(poly))).toBeGreaterThan(expected * 0.9);
    expect(Math.abs(polygonArea(poly))).toBeLessThan(expected * 1.1);
  });
});
