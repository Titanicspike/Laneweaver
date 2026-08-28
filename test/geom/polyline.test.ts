import { describe, expect, it } from 'vitest';
import {
  buildArclength, polylineLength, segmentIndexForS, samplePosition, sampleTangent,
  sampleSmoothTangent, closestOnPolyline, makeClosestHit, subPolyline, resamplePolyline,
  densify, reversePolyline, simplifyPolyline, curvatureAt, concatPolylines, bboxOfPolyline,
} from '@core/geom/polyline';

const line = Float32Array.from([0, 0, 10, 0, 10, 10]);

describe('arc length', () => {
  it('accumulates segment lengths', () => {
    const arc = buildArclength(line);
    expect(Array.from(arc)).toEqual([0, 10, 20]);
    expect(polylineLength(line)).toBeCloseTo(20, 6);
  });

  it('handles degenerate polylines', () => {
    expect(polylineLength(Float32Array.from([1, 1]))).toBe(0);
    expect(buildArclength(new Float32Array(0)).length).toBe(0);
  });
});

describe('segmentIndexForS', () => {
  const arc = buildArclength(line);
  it('finds the containing segment', () => {
    expect(segmentIndexForS(arc, 0)).toBe(0);
    expect(segmentIndexForS(arc, 5)).toBe(0);
    // A vertex belongs to its outgoing segment.
    expect(segmentIndexForS(arc, 10)).toBe(1);
    expect(segmentIndexForS(arc, 15)).toBe(1);
    expect(segmentIndexForS(arc, 20)).toBe(1);
  });
  it('clamps out-of-range queries', () => {
    expect(segmentIndexForS(arc, -5)).toBe(0);
    expect(segmentIndexForS(arc, 999)).toBe(1);
  });
  it('is unaffected by a wrong hint', () => {
    for (let s = 0; s <= 20; s += 0.5) {
      for (const hint of [-3, 0, 1, 7]) {
        expect(segmentIndexForS(arc, s, hint)).toBe(segmentIndexForS(arc, s));
      }
    }
  });
});

describe('sampling', () => {
  const arc = buildArclength(line);
  const p = { x: 0, y: 0 };

  it('interpolates positions', () => {
    samplePosition(line, arc, 5, p);
    expect(p).toEqual({ x: 5, y: 0 });
    samplePosition(line, arc, 15, p);
    expect(p).toEqual({ x: 10, y: 5 });
  });

  it('clamps beyond the ends', () => {
    samplePosition(line, arc, -1, p);
    expect(p).toEqual({ x: 0, y: 0 });
    samplePosition(line, arc, 100, p);
    expect(p).toEqual({ x: 10, y: 10 });
  });

  it('returns unit tangents', () => {
    sampleTangent(line, arc, 5, p);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(0);
    sampleTangent(line, arc, 15, p);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });

  it('blends the tangent across a corner', () => {
    sampleSmoothTangent(line, arc, 10, p, 4);
    expect(p.x).toBeCloseTo(Math.SQRT1_2, 3);
    expect(p.y).toBeCloseTo(Math.SQRT1_2, 3);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 6);
  });
});

describe('closestOnPolyline', () => {
  const arc = buildArclength(line);
  it('projects onto the nearest segment', () => {
    const hit = closestOnPolyline(line, arc, 5, 3, makeClosestHit());
    expect(hit.s).toBeCloseTo(5);
    expect(hit.distance).toBeCloseTo(3);
    expect(hit.segment).toBe(0);
  });
  it('clamps to end points', () => {
    const hit = closestOnPolyline(line, arc, -5, -5, makeClosestHit());
    expect(hit.s).toBeCloseTo(0);
    expect(hit.x).toBeCloseTo(0);
  });
});

describe('range and resampling helpers', () => {
  const arc = buildArclength(line);

  it('subPolyline keeps exact endpoints', () => {
    const sub = subPolyline(line, arc, 5, 15);
    expect(sub[0]).toBeCloseTo(5);
    expect(sub[1]).toBeCloseTo(0);
    expect(sub[sub.length - 2]).toBeCloseTo(10);
    expect(sub[sub.length - 1]).toBeCloseTo(5);
    expect(polylineLength(sub)).toBeCloseTo(10, 4);
  });

  it('subPolyline survives a zero-length range', () => {
    const sub = subPolyline(line, arc, 7, 7);
    expect(sub.length).toBeGreaterThanOrEqual(4);
    expect(polylineLength(sub)).toBeCloseTo(0, 6);
  });

  it('resamplePolyline preserves total length and endpoints', () => {
    const rs = resamplePolyline(line, arc, 1);
    expect(rs.length >> 1).toBe(21);
    expect(rs[0]).toBeCloseTo(0);
    expect(rs[rs.length - 1]).toBeCloseTo(10);
    expect(polylineLength(rs)).toBeCloseTo(20, 3);
  });

  it('densify keeps original vertices', () => {
    const d = densify(line, 2.5);
    expect(polylineLength(d)).toBeCloseTo(20, 4);
    let hasCorner = false;
    for (let i = 0; i < d.length; i += 2) if (d[i] === 10 && d[i + 1] === 0) hasCorner = true;
    expect(hasCorner).toBe(true);
  });

  it('reverse round-trips', () => {
    expect(Array.from(reversePolyline(reversePolyline(line)))).toEqual(Array.from(line));
  });

  it('simplify drops collinear points', () => {
    const dense = densify(Float32Array.from([0, 0, 100, 0]), 1);
    expect(dense.length >> 1).toBe(101);
    expect(simplifyPolyline(dense, 0.01).length >> 1).toBe(2);
  });

  it('concat drops duplicated joints', () => {
    const joined = concatPolylines([Float32Array.from([0, 0, 5, 0]), Float32Array.from([5, 0, 9, 0])]);
    expect(joined.length >> 1).toBe(3);
  });
});

describe('curvature', () => {
  it('is zero on a straight line', () => {
    expect(curvatureAt(Float32Array.from([0, 0, 1, 0, 2, 0]), 1)).toBeCloseTo(0, 9);
  });
  it('matches 1/r on a circle', () => {
    const r = 25;
    const pts: number[] = [];
    for (let i = -1; i <= 1; i++) {
      const a = (i * 2 * Math.PI) / 180;
      pts.push(r * Math.cos(a), r * Math.sin(a));
    }
    expect(Math.abs(curvatureAt(Float32Array.from(pts), 1))).toBeCloseTo(1 / r, 4);
  });
});

describe('bbox', () => {
  it('covers all points', () => {
    const b = bboxOfPolyline(line);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });
});
