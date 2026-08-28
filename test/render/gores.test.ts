/**
 * Regressions for how a gore is drawn.
 *
 * A merge or diverge has no junction box, but the blend connector between the ramp
 * and its auxiliary lane covers real road. Three separate bugs lived here: the
 * corridor was not painted at all (the ramp read as a detached stub), the polygon
 * came back from the union wound the other way and punched a hole through the
 * asphalt under Canvas's nonzero fill rule, and a stop line was painted straight
 * across the middle of the carriageway.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubPath2D } from '../helpers/canvasStub';
installCanvasGlobals();

import { NetworkPaths } from '@render/networkPaths';
import { compile } from '@core/network/compiler';
import { createDemoDocument } from '@app/demo';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import type { Network } from '@core/network/types';
import { samplePosition, sampleTangent } from '@core/geom/polyline';

const WORLD = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };

function net(): Network {
  return compile(createDemoDocument());
}

/** Every closed subpath of a recorded stub path, as flat coordinate arrays. */
function subpaths(path: unknown): number[][] {
  const ops = (path as StubPath2D).ops;
  const out: number[][] = [];
  let current: number[] | null = null;
  for (const op of ops) {
    if (op.op === 'moveTo') {
      current = [op.args[0] as number, op.args[1] as number];
      out.push(current);
    } else if (op.op === 'lineTo' && current) {
      current.push(op.args[0] as number, op.args[1] as number);
    }
  }
  return out.filter((p) => p.length >= 6);
}

function signedArea(p: ArrayLike<number>): number {
  const n = p.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  }
  return a / 2;
}

function pointInPolygon(p: ArrayLike<number>, x: number, y: number): boolean {
  const n = p.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1];
    const xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe('crossing footprints', () => {
  it('meets every approach with no gap', () => {
    const compiled = net();
    const crossings = compiled.junctions.filter((j) => j.kind === 'crossing');
    expect(crossings.length).toBeGreaterThan(0);
    for (const j of crossings) {
      for (const approach of j.approaches) {
        const seg = compiled.segments[approach.segmentId]!;
        const cap = approach.atSegmentEnd ? seg.capEnd : seg.capStart;
        const mx = (cap[0]! + cap[2]!) / 2, my = (cap[1]! + cap[3]!) / 2;
        // Both asphalt corners of the road's end, pulled a hand's width inward so
        // the test is about coverage rather than boundary tolerance.
        for (const k of [0, 2]) {
          const x = cap[k]! + (mx - cap[k]!) * 0.05;
          const y = cap[k + 1]! + (my - cap[k + 1]!) * 0.05;
          expect(pointInPolygon(j.footprint, x, y)).toBe(true);
        }
      }
    }
  });

  it('does not reach down a road nothing crosses', () => {
    // A wide arterial crossed by a narrow street. The box only has to span the
    // street; the arm opposite is the same arterial continuing, and treating that
    // as something to cross stretches the box — and the marking cover with it —
    // far down a road nobody crosses.
    const model = doc();
    const arterial = addProfile(model, {
      name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      shoulder: 0.8, median: 2.4, speedLimit: 20,
    });
    const street = addProfile(model, {
      name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
      shoulder: 0.4, median: 0, speedLimit: 11,
    });
    addStroke(model, arterial, line(-400, 0, 400, 0));
    addStroke(model, street, line(0, -400, 0, 400));
    const compiled = compile(model);
    const junction = compiled.junctions.find((j) => j.kind === 'crossing')!;
    expect(junction).toBeDefined();

    const halfOf = (approach: (typeof junction.approaches)[number]): number => {
      const seg = compiled.segments[approach.segmentId]!;
      const cap = approach.atSegmentEnd ? seg.capEnd : seg.capStart;
      return Math.hypot(cap[0]! - cap[2]!, cap[1]! - cap[3]!) / 2;
    };

    const gapOf = (approach: (typeof junction.approaches)[number]): number => {
      const seg = compiled.segments[approach.segmentId]!;
      const cap = approach.atSegmentEnd ? seg.capEnd : seg.capStart;
      return Math.hypot((cap[0]! + cap[2]!) / 2 - junction.x, (cap[1]! + cap[3]!) / 2 - junction.y);
    };
    const maxGap = Math.max(...junction.approaches.map(gapOf));

    for (const approach of junction.approaches) {
      const dx = Math.cos(approach.heading), dy = Math.sin(approach.heading);
      // The widest road that genuinely crosses this one.
      let crossing = 0;
      for (const other of junction.approaches) {
        if (other === approach) continue;
        const ox = Math.cos(other.heading), oy = Math.sin(other.heading);
        if (Math.abs(dx * oy - dy * ox) < 0.3) continue;
        crossing = Math.max(crossing, halfOf(other));
      }
      let reach = 0;
      for (let i = 0; i < junction.footprint.length; i += 2) {
        const along = (junction.footprint[i]! - junction.x) * dx
          + (junction.footprint[i + 1]! - junction.y) * dy;
        reach = Math.max(reach, along);
      }
      // Forward, only far enough to clear the road it crosses; backward, only the
      // opposite approach's own trim plus its kerb radius. Anything more is cover
      // laid over a road nothing crosses.
      expect(reach).toBeLessThan(Math.max(crossing, maxGap + 8) + 1.5);
    }
  });

  it('is flush with the roads, not a collar around them', () => {
    // A plain perpendicular crossing, where "as wide as the road" is unambiguous.
    const model = doc();
    const profile = addProfile(model, {
      name: 'plain', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
      shoulder: 0.5, median: 0, speedLimit: 14,
    });
    addStroke(model, profile, line(-300, 0, 300, 0));
    addStroke(model, profile, line(0, -300, 0, 300));
    const compiled = compile(model);
    const junction = compiled.junctions.find((j) => j.kind === 'crossing');
    expect(junction).toBeDefined();
    expect(junction!.approaches.length).toBe(4);

    for (const approach of junction!.approaches) {
      const seg = compiled.segments[approach.segmentId]!;
      const cap = approach.atSegmentEnd ? seg.capEnd : seg.capStart;
      const half = Math.hypot(cap[0]! - cap[2]!, cap[1]! - cap[3]!) / 2;
      const mx = (cap[0]! + cap[2]!) / 2, my = (cap[1]! + cap[3]!) / 2;
      const nx = (cap[0]! - cap[2]!) / (half * 2), ny = (cap[1]! - cap[3]!) / (half * 2);
      const dx = -ny, dy = nx;
      const sign = (junction!.x - mx) * dx + (junction!.y - my) * dy >= 0 ? 1 : -1;
      // A metre back from the cap: still inside the corridor's overlap, well clear
      // of the crossing road. The carriageway must be covered — a kerb radius that
      // reaches past the joint leaves a notch here — and nothing beyond it, which
      // is where an inflated quad shows up as a collar.
      const bx = mx - dx * sign, by = my - dy * sign;
      for (const s of [1, -1]) {
        expect(pointInPolygon(junction!.footprint, bx + nx * s * (half - 0.3), by + ny * s * (half - 0.3)))
          .toBe(true);
        expect(pointInPolygon(junction!.footprint, bx + nx * s * (half + 0.25), by + ny * s * (half + 0.25)))
          .toBe(false);
      }
    }
  });
});

describe('gore geometry', () => {
  it('paves the corridor between a ramp and its auxiliary lane', () => {
    const compiled = net();
    const gores = compiled.junctions.filter((j) => j.kind === 'merge' || j.kind === 'diverge');
    expect(gores.length).toBeGreaterThan(0);
    for (const j of gores) {
      expect(j.footprint.length).toBeGreaterThanOrEqual(6);
      expect(Math.abs(signedArea(j.footprint))).toBeGreaterThan(100);

      // Both ends of every connector must sit on the painted surface, or the ramp
      // is drawn floating beside the road it joins.
      for (const cid of j.connectorIds) {
        const c = compiled.lanes[cid]!;
        const n = c.centerline.length >> 1;
        expect(pointInPolygon(j.footprint, c.centerline[0]!, c.centerline[1]!)).toBe(true);
        expect(
          pointInPolygon(j.footprint, c.centerline[(n - 1) * 2]!, c.centerline[(n - 1) * 2 + 1]!),
        ).toBe(true);
      }
    }
  });

  it('carries the ramp edge lines across to the carriageway', () => {
    const compiled = net();
    const gores = compiled.junctions.filter((j) => j.kind === 'merge' || j.kind === 'diverge');
    expect(gores.length).toBeGreaterThan(0);
    for (const j of gores) {
      // Two edge lines: the gore's outer edge and the nose.
      expect(j.markings.length).toBe(2);
      expect(j.markings.every((m) => m.style === 'edge')).toBe(true);

      // Every end of every gore line has to land on the end of some segment's own
      // marking, or the paint stops dead a connector's length short of the road.
      const ends: Array<{ x: number; y: number }> = [];
      for (const seg of compiled.segments) {
        for (const m of seg.markings) {
          const n = m.points.length >> 1;
          if (n < 2) continue;
          ends.push({ x: m.points[0]!, y: m.points[1]! });
          ends.push({ x: m.points[(n - 1) * 2]!, y: m.points[(n - 1) * 2 + 1]! });
        }
      }
      for (const m of j.markings) {
        const n = m.points.length >> 1;
        for (const i of [0, n - 1]) {
          const x = m.points[i * 2]!, y = m.points[i * 2 + 1]!;
          const nearest = Math.min(...ends.map((e) => Math.hypot(e.x - x, e.y - y)));
          expect(nearest).toBeLessThan(1.5);
        }
      }
    }
  });

  it('keeps the edge line off the auxiliary lane before it exists', () => {
    const compiled = net();
    for (const j of compiled.junctions) {
      if (j.kind !== 'merge') continue;
      const connector = compiled.lanes[j.connectorIds[0]!]!;
      const aux = compiled.lanes[connector.successors[0]!]!;
      expect(aux.aux).toBe(true);
      const road = compiled.segments[aux.segmentId]!;

      // Two metres upstream of the gore there is no acceleration lane yet, so
      // nothing should be painted out at its outer edge. The road surface noses out
      // ahead of the gore; the paint must not follow it, or the edge line is drawn
      // diagonally across the gore the ramp is arriving on.
      const s = aux.parentS[0]! - 2;
      const outward = Math.sign(aux.offset) || 1;
      const off = aux.offset + outward * aux.width * 0.5;
      const p = { x: 0, y: 0 }, t = { x: 0, y: 0 };
      samplePosition(road.centerline, road.arclength, s, p);
      sampleTangent(road.centerline, road.arclength, s, t);
      const x = p.x - t.y * off, y = p.y + t.x * off;

      let nearest = Infinity;
      for (const m of road.markings) {
        if (m.style !== 'edge') continue;
        const n = m.points.length >> 1;
        for (let i = 0; i < n; i++) {
          nearest = Math.min(nearest, Math.hypot(m.points[i * 2]! - x, m.points[i * 2 + 1]! - y));
        }
      }
      expect(nearest).toBeGreaterThan(1);
    }
  });

  it('winds every filled polygon the same way', () => {
    const compiled = net();
    const paths = new NetworkPaths(compiled);
    let checked = 0;
    for (const grade of paths.grades) {
      for (const tile of paths.query(grade, WORLD)) {
        // The asphalt layer is the union of road surfaces and junction footprints,
        // which is where the winding actually matters: `polygon-clipping` returns
        // footprints with its winding, not ours, and an opposite ring punches a
        // hole straight through to the background under the nonzero fill rule.
        for (const path of [tile.asphalt]) {
          for (const ring of subpaths(path)) {
            expect(signedArea(ring)).toBeGreaterThanOrEqual(0);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('paints stop bars only where traffic has to stop', () => {
    const compiled = net();
    const paths = new NetworkPaths(compiled);
    const bars: Array<{ x: number; y: number }> = [];
    for (const grade of paths.grades) {
      for (const tile of paths.query(grade, WORLD)) {
        for (const op of (tile.stopBars as unknown as StubPath2D).ops) {
          if (op.op !== 'moveTo') continue;
          bars.push({ x: op.args[0] as number, y: op.args[1] as number });
        }
      }
    }
    expect(bars.length).toBeGreaterThan(0);
    for (const j of compiled.junctions) {
      if (j.kind === 'crossing') continue;
      for (const bar of bars) {
        expect(Math.hypot(bar.x - j.x, bar.y - j.y)).toBeGreaterThan(30);
      }
    }
  });
});
