import { describe, expect, it } from 'vitest';
import {
  buildArclength, polylineLength, segmentIndexForS, samplePosition, sampleTangent,
  sampleSmoothTangent, closestOnPolyline, makeClosestHit, subPolyline, resamplePolyline,
  densify, reversePolyline, simplifyPolyline, curvatureAt, concatPolylines, bboxOfPolyline, maxCurvatureOver } from '@core/geom/polyline';

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

/**
 * Curvature over a baseline, which is what sets a connector's speed limit.
 *
 * Three adjacent samples of a flattened curve measure the *sampling*, not the road:
 * the flattener puts points centimetres apart where it bends and metres apart where
 * it does not, and a circumcircle through three nearly coincident points is
 * numerically meaningless. One imported connector reported a 0.13 m radius at a
 * single vertex out of fourteen whose median radius was 34 m, and the whole 27 m
 * straight-ahead movement was limited to 13 km/h because of it.
 */
describe('curvature over a baseline', () => {
  /** An arc of a circle sampled unevenly, the way adaptive flattening leaves one. */
  function arc(radius: number, sweep: number, spacings: number[]): Float32Array {
    const out: number[] = [];
    let a = 0;
    let k = 0;
    while (a <= sweep) {
      out.push(Math.cos(a) * radius, Math.sin(a) * radius);
      a += spacings[k++ % spacings.length] / radius;
    }
    return Float32Array.from(out);
  }

  it('reads a true arc exactly, whatever the baseline', () => {
    // Three points on a circle give back that circle however far apart they are, so
    // the baseline may be chosen for noise rejection without biasing real geometry.
    const pts = arc(40, Math.PI / 2, [0.2, 3, 0.5, 2]);
    for (const span of [0, 2, 5, 10]) {
      expect(maxCurvatureOver(pts, span), `span ${span}`).toBeCloseTo(1 / 40, 3);
    }
  });

  it('ignores a single vertex that is only noise', () => {
    // A straight run, sampled the way the flattener actually leaves one: metres
    // apart along the easy part and a cluster of near-coincident points where it
    // once had to subdivide. A centimetre of float wobble inside that cluster is a
    // 1 m radius vertex to vertex and nothing at all over five metres.
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) pts.push(i * 1.4, 0);
    pts.push(11.35, 0, 11.5, 0.01, 11.65, 0);
    for (let i = 0; i < 8; i++) pts.push(13 + i * 1.4, 0);
    const poly = Float32Array.from(pts);
    expect(maxCurvatureOver(poly, 0)).toBeGreaterThan(0.5);  // vertex to vertex: a hairpin
    expect(maxCurvatureOver(poly, 5)).toBeLessThan(0.005);   // over 5 m: a straight road
  });

  it('still finds a bend that is genuinely there', () => {
    // The whole point is not to smooth away a real turn: a 9 m radius quarter circle
    // is a tight junction connector and must still read as one.
    expect(1 / maxCurvatureOver(arc(9, Math.PI / 2, [0.6]), 5)).toBeLessThan(10.5);
  });

  it('falls back to its own ends when it is shorter than the baseline', () => {
    const pts = arc(12, Math.PI / 2, [0.5]);
    expect(maxCurvatureOver(pts, 500)).toBeGreaterThan(0);
    expect(maxCurvatureOver(Float32Array.from([0, 0, 1, 0]), 5)).toBe(0);
    expect(maxCurvatureOver(Float32Array.from([]), 5)).toBe(0);
  });
});
