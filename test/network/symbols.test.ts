/**
 * Paint that is a picture: lane-use arrows and the word STOP.
 *
 * The arrows have to say what the junction actually does, which means they are
 * derived from the compiled movements rather than from the profile — rewire the
 * junction and the paint follows.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { laneKeyOf } from '@core/network/compiler/junctions';
import { TurnKind, type EditModel, type Network, type RoadSymbol } from '@core/network/types';
import { addProfile, addStroke, doc, line, setJunctionControl } from '../helpers/build';

function crossing(build?: (m: EditModel) => void): Network {
  const model = doc();
  const arterial = addProfile(model, {
    name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    shoulder: 0.8, median: 2.4, speedLimit: 20,
  });
  addStroke(model, arterial, line(-400, 0, 400, 0));
  addStroke(model, arterial, line(0, -400, 0, 400));
  build?.(model);
  return compile(model);
}

function streets(control?: 'allway-stop' | 'signal'): Network {
  const model = doc();
  const street = addProfile(model, {
    name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
    shoulder: 0.4, speedLimit: 11,
  });
  addStroke(model, street, line(-300, 0, 300, 0));
  addStroke(model, street, line(0, -300, 0, 300));
  if (control) setJunctionControl(model, 0, 0, control);
  return compile(model);
}

function symbols(net: Network): RoadSymbol[] {
  return net.segments.flatMap((s) => s.symbols);
}

describe('road symbols', () => {
  it('paints an arrow for every movement an approach lane can make', () => {
    const net = crossing();
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    let checked = 0;
    for (const approach of junction.approaches) {
      for (const id of approach.incomingLanes) {
        const lane = net.lanes[id]!;
        const expected = new Set(lane.successors.map((c) => net.lanes[c]!.turn));
        if (!expected.size) continue;
        // Every arrow on this lane, found by the point it was painted at.
        const mine = symbols(net).filter((s) => s.kind === 'arrow' && s.width === lane.width
          && nearLane(lane, s));
        expect(mine.length).toBeGreaterThan(0);
        for (const arrow of mine) expect(new Set(arrow.turns)).toEqual(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('gives the left-turn bay a left arrow and nothing else', () => {
    const net = crossing();
    const bay = net.lanes.find((l) => l.aux && l.successors.length)!;
    const arrows = symbols(net).filter((s) => s.kind === 'arrow' && nearLane(bay, s));
    expect(arrows.length).toBeGreaterThan(0);
    for (const a of arrows) expect(a.turns).toEqual([TurnKind.Left]);
  });

  it('writes STOP only where traffic has to stop', () => {
    expect(symbols(streets('allway-stop')).some((s) => s.kind === 'stop')).toBe(true);
    expect(symbols(streets('signal')).some((s) => s.kind === 'stop')).toBe(false);
  });

  it('follows the junction when its movements are rewired', () => {
    const before = crossing();
    const junction = before.junctions.find((j) => j.kind === 'crossing')!;
    const source = junction.approaches.find((a) => a.incomingLanes.length >= 2)!;
    const target = junction.approaches.find((a) => a !== source && a.outgoingLanes.length)!;
    const from = laneKeyOf(before.lanes[source.incomingLanes[0]!]!, before.segments);
    const to = laneKeyOf(before.lanes[target.outgoingLanes[0]!]!, before.segments);

    const after = crossing((m) => {
      m.laneLinks.push({ x: junction.x, y: junction.y, links: [{ from, to }] });
    });
    // Exactly one movement survives, so exactly one lane still carries arrows...
    const arrows = symbols(after).filter((s) => s.kind === 'arrow');
    expect(arrows.length).toBeGreaterThan(0);
    const kinds = new Set(arrows.flatMap((a) => a.turns));
    expect(kinds.size).toBe(1);
    // ...and it is not the same set of arrows the compiler drew on its own.
    const beforeKinds = new Set(symbols(before).flatMap((a) => a.turns));
    expect(beforeKinds.size).toBeGreaterThan(kinds.size);
  });

  it('keeps every symbol on the road it belongs to', () => {
    for (const net of [crossing(), streets('allway-stop')]) {
      for (const seg of net.segments) {
        for (const symbol of seg.symbols) {
          expect(distanceToPolyline(seg.centerline, symbol.x, symbol.y))
            .toBeLessThan(seg.maxHalfWidth);
          expect(Number.isFinite(symbol.heading)).toBe(true);
          expect(symbol.width).toBeGreaterThan(1);
        }
      }
    }
  });
});

function distanceToPolyline(poly: Float32Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const ax = poly[i], ay = poly[i + 1], bx = poly[i + 2], by = poly[i + 3];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

/** True when the symbol was painted on this lane. */
function nearLane(lane: { centerline: Float32Array }, s: RoadSymbol): boolean {
  return distanceToPolyline(lane.centerline, s.x, s.y) < 0.6;
}
