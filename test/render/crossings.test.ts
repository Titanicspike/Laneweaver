/**
 * What a junction looks like: paint that reaches it, and crossings on it.
 *
 * Two things this pins, and the first is a deletion.
 *
 * **The junction cover is gone.** It used to paint the junction's whole footprint
 * over the markings, to hide overlaps inside the box. But a footprint reaches its own
 * trim *plus the width of the road it crosses* up every approach — eight metres on a
 * town arterial — so what it actually hid was the last eight metres of every road's
 * lane lines, median and edge lines. Paint stopping a car's length short of the stop
 * bar is what made every junction in the network look unfinished. It was also hiding
 * nothing: segments are trimmed back to the junction radius, so their markings cannot
 * reach the box. That is the invariant, and it is checked here and in the audit
 * rather than assumed.
 *
 * **Pedestrian crossings**, and only where traffic is stopped by something other than
 * a gap. At a priority junction the major road never stops, so a crossing painted
 * across it would be a promise the junction does not keep.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { autoSmoothHandles, createDocument, kph, makeControlPoint } from '@core/network/model';
import type {
  ControlPoint, EditModel, JunctionControl, Network, RoadProfile,
} from '@core/network/types';
import { buildArclength, closestOnPolyline, makeClosestHit } from '@core/geom/polyline';

function pts(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i]!, coords[i + 1]!));
  autoSmoothHandles(out);
  return out;
}

function inPoly(p: ArrayLike<number>, x: number, y: number): boolean {
  const n = p.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!, yi = p[i * 2 + 1]!, xj = p[j * 2]!, yj = p[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Two arterials crossing, under whichever control is asked for. */
function crossroads(control?: JunctionControl): Network {
  const m: EditModel = createDocument(88);
  const arterial: RoadProfile = {
    id: m.nextId++, name: 'Arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    speedLimit: kph(60), median: 2.4, shoulder: 0.8, isRamp: false,
  };
  const street: RoadProfile = {
    id: m.nextId++, name: 'Street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
    speedLimit: kph(40), median: 0, shoulder: 0.5, isRamp: false,
  };
  m.profiles.push(arterial, street);
  m.strokes.push({ id: m.nextId++, profileId: arterial.id, points: pts(-400, 0, 400, 0) });
  m.strokes.push({ id: m.nextId++, profileId: street.id, points: pts(0, -400, 0, 400) });
  if (control) m.junctions.push({ x: 0, y: 0, control });
  return compile(m);
}

describe('paint reaches the junction', () => {
  const net = crossroads('signal');

  it('runs every marking the full length of its segment', () => {
    // The shortfall is measured *along* the road, not as a straight-line distance:
    // a marking is offset laterally by up to half the carriageway, and measuring the
    // distance from the segment's end point calls that a gap when it is not.
    const hit = makeClosestHit();
    for (const seg of net.segments) {
      const arc = buildArclength(seg.centerline);
      const len = arc[arc.length - 1]!;
      for (const m of seg.markings) {
        const n = m.points.length >> 1;
        closestOnPolyline(seg.centerline, arc, m.points[0]!, m.points[1]!, hit);
        const a = hit.s;
        closestOnPolyline(seg.centerline, arc, m.points[(n - 1) * 2]!, m.points[(n - 1) * 2 + 1]!, hit);
        const b = hit.s;
        // Bay boundaries legitimately cover only part of the road; the through
        // markings must cover all of it.
        if (m.style !== 'edge' && m.style !== 'median' && m.style !== 'double') continue;
        expect(Math.min(a, b), `${m.style} starts ${Math.min(a, b).toFixed(1)} m in`)
          .toBeLessThan(0.6);
        expect(len - Math.max(a, b), `${m.style} stops ${(len - Math.max(a, b)).toFixed(1)} m short`)
          .toBeLessThan(0.6);
      }
    }
  });

  it('puts no road marking inside a junction box', () => {
    // The reason no cover is needed. If this ever fails, the answer is to trim the
    // segment further, not to paint over the evidence.
    for (const j of net.junctions) {
      if (j.kind !== 'crossing') continue;
      for (const seg of net.segments) {
        for (const m of seg.markings) {
          for (let i = 0; i < m.points.length; i += 2) {
            const x = m.points[i]!, y = m.points[i + 1]!;
            if (Math.hypot(x - j.x, y - j.y) > j.radius) continue;
            if (!inPoly(j.footprint, x, y)) continue;
            expect(inPoly(seg.surface, x, y), `${m.style} paint inside junction ${j.id}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('pedestrian crossings', () => {
  const zebras = (net: Network): number =>
    net.junctions.reduce(
      (acc, j) => acc + j.markings.filter((m) => m.style === 'zebra').length, 0,
    );

  it('paints one across every arm of a signalised junction', () => {
    const net = crossroads('signal');
    const j = net.junctions.find((x) => x.kind === 'crossing')!;
    expect(j.approaches.length).toBe(4);
    const bars = j.markings.filter((m) => m.style === 'zebra');
    // Several bars per arm, four arms.
    expect(bars.length).toBeGreaterThan(4 * 3);
    // Each bar is a short two-point line, not a polyline round a corner.
    for (const b of bars) expect(b.points.length).toBe(4);
  });

  it('paints them at an all-way stop too', () => {
    expect(zebras(crossroads('allway-stop'))).toBeGreaterThan(12);
  });

  it('paints none at a priority junction', () => {
    // The major road never stops there, so a crossing would be a promise the
    // junction does not keep.
    expect(zebras(crossroads('priority'))).toBe(0);
  });

  it('follows the control when it changes', () => {
    expect(zebras(crossroads('priority'))).toBe(0);
    expect(zebras(crossroads('signal'))).toBeGreaterThan(0);
  });

  it('lays the bars along the traffic, not across it', () => {
    // A zebra read the wrong way round is a ladder lying flat, and it is the one
    // thing about a crossing that is obvious to everybody the moment it is wrong.
    const net = crossroads('signal');
    const j = net.junctions.find((x) => x.kind === 'crossing')!;
    for (const bar of j.markings.filter((m) => m.style === 'zebra')) {
      const dx = bar.points[2]! - bar.points[0]!;
      const dy = bar.points[3]! - bar.points[1]!;
      // Every arm here runs due N/S or due E/W, so each bar must too.
      const alongX = Math.abs(dx) > Math.abs(dy);
      expect(alongX ? Math.abs(dy) : Math.abs(dx)).toBeLessThan(0.2);
      expect(Math.hypot(dx, dy), 'bar length').toBeGreaterThan(1.5);
    }
  });

  it('keeps them on the carriageway', () => {
    const net = crossroads('signal');
    const j = net.junctions.find((x) => x.kind === 'crossing')!;
    for (const bar of j.markings.filter((m) => m.style === 'zebra')) {
      for (let i = 0; i < bar.points.length; i += 2) {
        expect(
          inPoly(j.footprint, bar.points[i]!, bar.points[i + 1]!),
          `a crossing bar at (${bar.points[i]!.toFixed(1)},${bar.points[i + 1]!.toFixed(1)}) is off the junction`,
        ).toBe(true);
      }
    }
  });
});
