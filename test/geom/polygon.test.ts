import { describe, expect, it } from 'vitest';
import { unionPolygons, convexHull, rectPolygon, segmentQuad, smoothClosed, toRing, fromRing } from '@core/geom/polygon';
import { polygonArea, pointInPolygon, segmentIntersect, makeSegHit, pointSegmentDistance, closestParamOnSegment, lineIntersect } from '@core/geom/intersect';

describe('unionPolygons', () => {
  it('merges two overlapping squares', () => {
    const a = rectPolygon(0, 0, 10, 10);
    const b = rectPolygon(5, 0, 10, 10);
    const u = unionPolygons([a, b]);
    expect(Math.abs(polygonArea(u))).toBeCloseTo(150, 3);
  });

  it('returns the input for a single polygon', () => {
    const a = rectPolygon(0, 0, 10, 10);
    expect(Math.abs(polygonArea(unionPolygons([a])))).toBeCloseTo(100, 6);
  });

  it('keeps the largest blob when inputs are disjoint', () => {
    const a = rectPolygon(0, 0, 10, 10);
    const b = rectPolygon(100, 100, 4, 4);
    const u = unionPolygons([a, b]);
    expect(Math.abs(polygonArea(u))).toBeCloseTo(100, 3);
  });

  it('unions a four-way crossing into one blob', () => {
    const arms = [
      rectPolygon(-30, -7, 60, 14),
      rectPolygon(-7, -30, 14, 60),
    ];
    const u = unionPolygons(arms);
    expect(Math.abs(polygonArea(u))).toBeCloseTo(60 * 14 * 2 - 14 * 14, 2);
    expect(pointInPolygon(u, 0, 0)).toBe(true);
    expect(pointInPolygon(u, 25, 25)).toBe(false);
  });

  it('ignores degenerate inputs', () => {
    expect(unionPolygons([]).length).toBe(0);
    expect(unionPolygons([new Float32Array([0, 0, 1, 1])]).length).toBe(0);
  });
});

describe('ring conversion', () => {
  it('round-trips', () => {
    const p = rectPolygon(1, 2, 3, 4);
    expect(Array.from(fromRing(toRing(p)))).toEqual(Array.from(p));
  });
});

describe('convexHull', () => {
  it('drops interior points', () => {
    const pts = Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 2, 3]);
    const h = convexHull(pts);
    expect(h.length >> 1).toBe(4);
    expect(Math.abs(polygonArea(h))).toBeCloseTo(100, 6);
  });
});

describe('segmentQuad', () => {
  it('builds an oriented band', () => {
    const q = segmentQuad(0, 0, 10, 0, 3);
    expect(Math.abs(polygonArea(q))).toBeCloseTo(60, 6);
  });
  it('returns empty for zero-length input', () => {
    expect(segmentQuad(1, 1, 1, 1, 3).length).toBe(0);
  });
});

describe('smoothClosed', () => {
  it('rounds corners while staying inside the original', () => {
    const sq = rectPolygon(0, 0, 10, 10);
    const s = smoothClosed(sq, 2);
    expect(s.length).toBeGreaterThan(sq.length);
    for (let i = 0; i < s.length; i += 2) {
      expect(s[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(s[i]).toBeLessThanOrEqual(10 + 1e-6);
      expect(s[i + 1]).toBeGreaterThanOrEqual(-1e-6);
      expect(s[i + 1]).toBeLessThanOrEqual(10 + 1e-6);
    }
    // Chaikin always shrinks; callers that need coverage pad before smoothing.
    expect(Math.abs(polygonArea(s))).toBeCloseTo(84.375, 3);
  });
});

describe('segment predicates', () => {
  const hit = makeSegHit();

  it('detects a proper crossing', () => {
    expect(segmentIntersect(0, 0, 10, 0, 5, -5, 5, 5, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(5);
    expect(hit.y).toBeCloseTo(0);
    expect(hit.t).toBeCloseTo(0.5);
    expect(hit.u).toBeCloseTo(0.5);
  });

  it('rejects parallel and collinear pairs', () => {
    expect(segmentIntersect(0, 0, 10, 0, 0, 1, 10, 1, hit)).toBe(false);
    expect(segmentIntersect(0, 0, 10, 0, 5, 0, 15, 0, hit)).toBe(false);
  });

  it('rejects misses beyond the endpoints', () => {
    expect(segmentIntersect(0, 0, 10, 0, 20, -5, 20, 5, hit)).toBe(false);
  });

  it('accepts touching endpoints (T-junctions)', () => {
    expect(segmentIntersect(0, 0, 10, 0, 10, 0, 10, 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(1);
    expect(hit.u).toBeCloseTo(0);
  });

  it('measures point-segment distance', () => {
    expect(pointSegmentDistance(0, 0, 10, 0, 5, 4)).toBeCloseTo(4);
    expect(pointSegmentDistance(0, 0, 10, 0, -3, 4)).toBeCloseTo(5);
    expect(closestParamOnSegment(0, 0, 10, 0, 25, 0)).toBe(1);
  });

  it('intersects infinite lines', () => {
    const out = { x: 0, y: 0 };
    expect(lineIntersect(0, 0, 1, 0, 4, -3, 0, 1, out)).toBe(true);
    expect(out.x).toBeCloseTo(4);
    expect(out.y).toBeCloseTo(0);
    expect(lineIntersect(0, 0, 1, 0, 0, 1, 1, 0, out)).toBe(false);
  });
});

describe('pointInPolygon', () => {
  it('classifies inside and outside', () => {
    const sq = rectPolygon(0, 0, 10, 10);
    expect(pointInPolygon(sq, 5, 5)).toBe(true);
    expect(pointInPolygon(sq, 15, 5)).toBe(false);
  });
});
