/**
 * The cross-section a driver actually sees.
 *
 * Lane offsets being evenly spaced is not enough: what reads as a lane on screen is
 * the gap between two painted lines, and the edge line used to be painted on the
 * asphalt boundary rather than the carriageway edge. On a freeway with a 2.5 m
 * shoulder that made the kerbside lane look 6.15 m wide against 3.65 m for every
 * lane inside it.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import type { Segment } from '@core/network/types';

/** Signed lateral offset of a marking from the segment centreline, at mid-length. */
function lateralOffsets(segment: Segment): number[] {
  const n = segment.centerline.length >> 1;
  const mid = Math.floor(n / 2);
  const cx = segment.centerline[mid * 2]!;
  const cy = segment.centerline[mid * 2 + 1]!;
  const tx = segment.centerline[(mid + 1) * 2]! - cx;
  const ty = segment.centerline[(mid + 1) * 2 + 1]! - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const nx = -ty / tl, ny = tx / tl;

  const out: number[] = [];
  for (const marking of segment.markings) {
    // Nearest point of this marking to the sample cross-section.
    let best = Infinity;
    let bestOff = 0;
    const mn = marking.points.length >> 1;
    for (let i = 0; i < mn; i++) {
      const dx = marking.points[i * 2]! - cx;
      const dy = marking.points[i * 2 + 1]! - cy;
      const along = Math.abs(dx * (tx / tl) + dy * (ty / tl));
      if (along < best) {
        best = along;
        bestOff = dx * nx + dy * ny;
      }
    }
    if (best < 3) out.push(bestOff);
  }
  return out.sort((a, b) => a - b);
}

describe('painted cross-section', () => {
  for (const spec of [
    { name: 'freeway 3-lane one-way', lanesForward: 3, lanesBackward: 0, shoulder: 2.5, laneWidth: 3.65 },
    { name: 'arterial 2+2 no median', lanesForward: 2, lanesBackward: 2, shoulder: 0.8, laneWidth: 3.5 },
    { name: 'residential 1+1 wide shoulder', lanesForward: 1, lanesBackward: 1, shoulder: 2, laneWidth: 3.2 },
  ]) {
    it(`spaces every painted lane equally: ${spec.name}`, () => {
      const model = doc();
      const profile = addProfile(model, {
        name: spec.name,
        lanesForward: spec.lanesForward,
        lanesBackward: spec.lanesBackward,
        laneWidth: spec.laneWidth,
        shoulder: spec.shoulder,
        median: 0,
        speedLimit: 25,
      });
      addStroke(model, profile, line(0, 0, 900, 0));
      const net = compile(model);
      const segment = net.segments[0]!;
      const offsets = lateralOffsets(segment);

      const lanes = spec.lanesForward + spec.lanesBackward;
      expect(offsets.length).toBe(lanes + 1);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]! - offsets[i - 1]!).toBeCloseTo(spec.laneWidth, 2);
      }
      // ...and the shoulder is asphalt *outside* the outermost line.
      expect(segment.maxHalfWidth - Math.abs(offsets[0]!)).toBeCloseTo(spec.shoulder, 2);
    });
  }

  it('overlaps abutting surfaces so the joint leaves no hairline', () => {
    // Two segments of one road meeting at a link. Their surfaces must overlap, not
    // abut: two antialiased edges sharing a line each cover half a pixel, and two
    // halves do not make a whole — the dark casing shows through as a thin line
    // across the road.
    const model = doc();
    const wide = addProfile(model, {
      name: 'wide', lanesForward: 3, lanesBackward: 0, laneWidth: 3.5,
      shoulder: 1, median: 0, speedLimit: 30,
    });
    const narrow = addProfile(model, {
      name: 'narrow', lanesForward: 2, lanesBackward: 0, laneWidth: 3.5,
      shoulder: 1, median: 0, speedLimit: 30,
    });
    addStroke(model, wide, line(0, 0, 500, 0));
    addStroke(model, narrow, line(500, 0, 1000, 0));
    const compiled = compile(model);
    expect(compiled.junctions.some((j) => j.kind === 'link')).toBe(true);
    expect(compiled.segments.length).toBe(2);

    // Each surface must reach past the cap it shares with its neighbour.
    for (const segment of compiled.segments) {
      let maxX = -Infinity;
      let minX = Infinity;
      for (let i = 0; i < segment.surface.length; i += 2) {
        maxX = Math.max(maxX, segment.surface[i]!);
        minX = Math.min(minX, segment.surface[i]!);
      }
      expect(maxX - Math.max(segment.capStart[0]!, segment.capEnd[0]!)).toBeGreaterThan(0.05);
      expect(Math.min(segment.capStart[0]!, segment.capEnd[0]!) - minX).toBeGreaterThan(0.05);
    }
  });

  it('keeps the end caps on the asphalt boundary', () => {
    const model = doc();
    const profile = addProfile(model, {
      name: 'capped', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      shoulder: 1.5, median: 0, speedLimit: 20,
    });
    addStroke(model, profile, line(0, 0, 600, 0));
    const segment = compile(model).segments[0]!;
    for (const cap of [segment.capStart, segment.capEnd]) {
      expect(cap.length).toBe(4);
      const width = Math.hypot(cap[0]! - cap[2]!, cap[1]! - cap[3]!);
      expect(width).toBeCloseTo(segment.maxHalfWidth * 2, 2);
    }
  });
});
