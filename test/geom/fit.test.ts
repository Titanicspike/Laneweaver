/**
 * Fitting cubics to a polyline — the inverse of flattening, and what makes an
 * imported road a road rather than a thousand-point polygon.
 *
 * Two things here are not "close enough is fine". The **ends never move**, because
 * junctions are found geometrically and an endpoint that drifts is a T-junction that
 * silently stops being one. And the **handles are bounded**: the least-squares
 * optimum for nearly-collinear data with nearly-parallel end tangents is unbounded,
 * and on a real import it produced a handle 239 km long on a 40 m road — which the
 * compiler turned into a junction connector a hundred and fifty kilometres long and
 * spent five minutes testing for conflicts. One bad handle cost 137x on the compile.
 */

import { describe, expect, it } from 'vitest';
import { fitPolyline, simplifyPolyline } from '@core/geom/fit';
import { flattenCubicInto } from '@core/geom/flatten';

/** Worst distance from each source point to the fitted chain. */
function worstError(points: number[], curves: ReturnType<typeof fitPolyline>): number {
  const flat: number[] = [];
  for (const c of curves) {
    flat.push(c.x0, c.y0);
    flattenCubicInto(flat, c.x0, c.y0, c.c1x, c.c1y, c.c2x, c.c2y, c.x1, c.y1, 0.02, 1);
  }
  let worst = 0;
  for (let i = 0; i < points.length; i += 2) {
    let best = Infinity;
    for (let k = 0; k + 3 < flat.length; k += 2) {
      const ax = flat[k], ay = flat[k + 1], bx = flat[k + 2], by = flat[k + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((points[i] - ax) * dx + (points[i + 1] - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(points[i] - (ax + dx * t), points[i + 1] - (ay + dy * t)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** An arc of a circle, sampled every few metres the way a survey would. */
function arc(radius: number, sweep: number, step: number, jitter = 0): number[] {
  const out: number[] = [];
  let seed = 12345;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const n = Math.max(2, Math.round((radius * sweep) / step));
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * sweep;
    out.push(Math.cos(a) * radius + rand() * jitter, Math.sin(a) * radius + rand() * jitter);
  }
  return out;
}

describe('simplifying a polyline', () => {
  it('drops the points that say nothing and keeps the ends', () => {
    const straight: number[] = [];
    for (let i = 0; i <= 50; i++) straight.push(i * 4, 0);
    const out = simplifyPolyline(Float32Array.from(straight), 0.5);
    expect(out.length / 2).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[out.length - 2]).toBe(200);
  });

  it('keeps the shape of a bend within the tolerance', () => {
    const curve = arc(80, Math.PI / 2, 3);
    const out = simplifyPolyline(Float32Array.from(curve), 0.5);
    expect(out.length).toBeLessThan(curve.length);
    // Every dropped point is still within tolerance of what is left.
    for (let i = 0; i < curve.length; i += 2) {
      let best = Infinity;
      for (let k = 0; k + 3 < out.length; k += 2) {
        const ax = out[k], ay = out[k + 1], bx = out[k + 2], by = out[k + 3];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((curve[i] - ax) * dx + (curve[i + 1] - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(curve[i] - (ax + dx * t), curve[i + 1] - (ay + dy * t)));
      }
      expect(best).toBeLessThan(0.51);
    }
  });
});

describe('fitting cubics', () => {
  it('never moves the two ends', () => {
    const curve = arc(120, Math.PI * 0.8, 4, 0.3);
    const simple = simplifyPolyline(Float32Array.from(curve), 0.4);
    const fitted = fitPolyline(simple, 1);
    expect(fitted.length).toBeGreaterThan(0);
    // Exactly what it was handed — the ends are copied, not solved for.
    expect(fitted[0].x0).toBe(simple[0]);
    expect(fitted[0].y0).toBe(simple[1]);
    const last = fitted[fitted.length - 1];
    expect(last.x1).toBe(simple[simple.length - 2]);
    expect(last.y1).toBe(simple[simple.length - 1]);
    // And to within a millimetre of the survey, which is all float32 can carry at
    // city coordinates and far inside anything the compiler measures.
    expect(Math.hypot(fitted[0].x0 - curve[0], fitted[0].y0 - curve[1])).toBeLessThan(1e-3);
    expect(Math.hypot(last.x1 - curve[curve.length - 2], last.y1 - curve[curve.length - 1]))
      .toBeLessThan(1e-3);
  });

  it('stays within the tolerance it was given', () => {
    for (const [radius, sweep, jitter] of [[80, 1.2, 0], [300, 0.4, 0.2], [40, 2.5, 0.1]] as const) {
      const curve = arc(radius, sweep, 4, jitter);
      const fitted = fitPolyline(simplifyPolyline(Float32Array.from(curve), 0.4), 1.2);
      expect(worstError(curve, fitted), `r=${radius} sweep=${sweep}`).toBeLessThan(1.4);
    }
  });

  it('compresses a surveyed road to a handful of points', () => {
    const curve = arc(200, Math.PI / 3, 3);
    const fitted = fitPolyline(simplifyPolyline(Float32Array.from(curve), 0.4), 1);
    // Roughly seventy vertices in; anything like that many cubics out would mean the
    // fit had achieved nothing.
    expect(curve.length / 2).toBeGreaterThan(60);
    expect(fitted.length).toBeLessThan(8);
  });

  it('splits at a corner instead of rounding it off', () => {
    // Two straights meeting at a right angle: a kerb line, not a curve.
    const pts: number[] = [];
    for (let i = 0; i <= 10; i++) pts.push(i * 5, 0);
    for (let i = 1; i <= 10; i++) pts.push(50, i * 5);
    const fitted = fitPolyline(Float32Array.from(pts), 0.5);
    expect(fitted.length).toBeGreaterThanOrEqual(2);
    // The corner survives: some cubic ends exactly on it.
    const onCorner = fitted.some((c) => Math.hypot(c.x1 - 50, c.y1) < 0.01);
    expect(onCorner).toBe(true);
  });

  it('never returns a handle longer than its chord allows', () => {
    // The case that cost 137x on a city compile: nearly-collinear, noisy, with end
    // tangents almost parallel to the chord, which is where the solve runs away.
    const evil: number[] = [];
    for (let i = 0; i <= 60; i++) {
      evil.push(i * 3, Math.sin(i * 0.7) * 0.02 + (i % 7 === 0 ? 0.05 : 0));
    }
    for (const tolerance of [0.5, 1, 2, 4]) {
      const fitted = fitPolyline(Float32Array.from(evil), tolerance);
      for (const c of fitted) {
        const chord = Math.hypot(c.x1 - c.x0, c.y1 - c.y0);
        const h1 = Math.hypot(c.c1x - c.x0, c.c1y - c.y0);
        const h2 = Math.hypot(c.c2x - c.x1, c.c2y - c.y1);
        expect(h1, `handle ${h1.toFixed(0)} m on a ${chord.toFixed(0)} m chord`)
          .toBeLessThan(chord * 2 + 1);
        expect(h2).toBeLessThan(chord * 2 + 1);
      }
    }
  });

  it('copes with degenerate input rather than throwing', () => {
    expect(fitPolyline(Float32Array.from([]), 1)).toEqual([]);
    expect(fitPolyline(Float32Array.from([1, 2]), 1)).toEqual([]);
    expect(fitPolyline(Float32Array.from([0, 0, 0, 0, 0, 0]), 1).length).toBeGreaterThan(0);
    const repeated = Float32Array.from([0, 0, 5, 0, 5, 0, 5, 0, 10, 0]);
    for (const c of fitPolyline(repeated, 1)) {
      expect(Number.isFinite(c.c1x) && Number.isFinite(c.c2y)).toBe(true);
    }
  });
});
