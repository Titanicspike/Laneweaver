/**
 * A crossing is the same junction however many strokes it was drawn with.
 *
 * Two strokes crossing is the picture everybody likes. One continuous road with
 * two separate stubs ending on it from opposite sides, or four separate strokes
 * all ending at one point, is the same junction as far as a driver is concerned —
 * and it came out as a fifty-metre slab. The trim rule asked every pair of arms
 * how far each had to be set back to clear the other, and two arms facing each
 * other across the meeting fold to a crossing angle of zero, where the formula
 * clamps the sine at twenty degrees: an arterial drawn as two strokes was set back
 * 52 m where 14 would do. Arms that face each other are one road carrying on, and
 * nothing crosses it.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import type { EditModel, Network } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';

function profiles(m: EditModel) {
  const art = addProfile(m, {
    name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, shoulder: 0.6,
    median: 2.4, speedLimit: kph(70),
  });
  const st = addProfile(m, {
    name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50),
  });
  return { art, st };
}

/** Two strokes crossing. */
function twoStrokes(): EditModel {
  const m = doc(5);
  const { art, st } = profiles(m);
  addStroke(m, art, line(-500, 0, 500, 0));
  addStroke(m, st, line(0, -400, 0, 400));
  return m;
}
/** One continuous road, two stubs ending on it from opposite sides. */
function threeStrokes(): EditModel {
  const m = doc(5);
  const { art, st } = profiles(m);
  addStroke(m, art, line(-500, 0, 500, 0));
  addStroke(m, st, line(0, -400, 0, 0));
  addStroke(m, st, line(0, 400, 0, 0));
  return m;
}
/** Four strokes, all ending at the one point. */
function fourStrokes(): EditModel {
  const m = doc(5);
  const { art, st } = profiles(m);
  addStroke(m, art, line(-500, 0, 0, 0));
  addStroke(m, art, line(500, 0, 0, 0));
  addStroke(m, st, line(0, -400, 0, 0));
  addStroke(m, st, line(0, 400, 0, 0));
  return m;
}

/** How far each arm's cap sits from the meeting point, keyed by its heading. */
function setbacks(net: Network): Map<string, number> {
  const j = net.junctions.find((x) => x.kind === 'crossing')!;
  const out = new Map<string, number>();
  for (const a of j.approaches) {
    const seg = net.segments[a.segmentId];
    const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
    const d = Math.hypot((cap[0] + cap[2]) / 2 - j.x, (cap[1] + cap[3]) / 2 - j.y);
    const deg = Math.round((a.heading * 180) / Math.PI / 10) * 10;
    out.set(String(((deg % 360) + 360) % 360), d);
  }
  return out;
}

describe('a crossing drawn with several strokes', () => {
  const two = compile(twoStrokes());
  const three = compile(threeStrokes());
  const four = compile(fourStrokes());

  it('compiles clean, as one junction', () => {
    for (const net of [two, three, four]) {
      expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(net.junctions.filter((j) => j.kind === 'crossing').length).toBe(1);
      expect(net.junctions.find((j) => j.kind === 'crossing')!.approaches.length).toBe(4);
    }
  });

  it('sets its arms back the same distance as the two-stroke crossing', () => {
    const reference = setbacks(two);
    for (const [label, net] of [['three strokes', three], ['four strokes', four]] as const) {
      const got = setbacks(net);
      for (const [heading, d] of reference) {
        expect(got.has(heading), `${label}: no arm at heading ${heading}`).toBe(true);
        expect(Math.abs(got.get(heading)! - d), `${label}: arm at ${heading} set back ${got.get(heading)!.toFixed(1)} m vs ${d.toFixed(1)} m`)
          .toBeLessThan(1.5);
      }
    }
  });

  it('keeps every arm within reach of the road it actually crosses', () => {
    // An arm has to clear the widest road it meets, plus a kerb. Fifty metres is
    // what the folded-angle formula produced for the two halves of the arterial.
    for (const net of [two, three, four]) {
      const j = net.junctions.find((x) => x.kind === 'crossing')!;
      const halves = j.approaches.map((a) => {
        const seg = net.segments[a.segmentId];
        const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
        return Math.hypot(cap[0] - cap[2], cap[1] - cap[3]) / 2;
      });
      j.approaches.forEach((a, i) => {
        const seg = net.segments[a.segmentId];
        const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
        const d = Math.hypot((cap[0] + cap[2]) / 2 - j.x, (cap[1] + cap[3]) / 2 - j.y);
        const widest = Math.max(...halves.filter((_, k) => k !== i));
        expect(d, `arm ${i} set back ${d.toFixed(1)} m to clear a ${widest.toFixed(1)} m half-width`)
          .toBeLessThan(widest + 6);
      });
    }
  });

  it('still makes one crossing when the stubs stop short of the centreline', () => {
    // Drawn by hand, a stub ends a few metres short of the road it meets, and the
    // two from opposite sides never line up. Two such stubs used to compile as two
    // T-junctions back to back: their hit points were twelve metres apart even though
    // they were at the same place *along* the road, which is what a junction is.
    const m = doc(5);
    const { art, st } = profiles(m);
    addStroke(m, art, line(-500, 0, 500, 0));
    addStroke(m, st, line(-3, -400, -3, -5));
    addStroke(m, st, line(4, 400, 4, 5));
    const net = compile(m);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(net.diagnostics.some((d) => d.code === 'junctions-too-close')).toBe(false);
    const crossings = net.junctions.filter((j) => j.kind === 'crossing');
    expect(crossings.length).toBe(1);
    expect(crossings[0].approaches.length).toBe(4);
    // And four separate roads ending near one point, likewise.
    const m4 = doc(5);
    const p4 = profiles(m4);
    addStroke(m4, p4.art, line(-500, 0, -3, 0));
    addStroke(m4, p4.art, line(500, 0, 3, 0));
    addStroke(m4, p4.st, line(0, -400, 0, -5));
    addStroke(m4, p4.st, line(0, 400, 0, 5));
    const net4 = compile(m4);
    const c4 = net4.junctions.filter((j) => j.kind === 'crossing');
    expect(c4.length).toBe(1);
    expect(c4[0].approaches.length).toBe(4);
  });

  it('does not set a through road back for a slip road merely alongside it', () => {
    // A fifth arm twenty degrees off one of the arterial's arms. Two corridors at
    // that angle overlap for forty metres along both, and trimming either one past
    // the overlap is enough — the other's corridor is paved by the junction there.
    // Asked naively, both took the long trim and the arterial was set back 35 m.
    const m = doc(5);
    const { art, st } = profiles(m);
    addStroke(m, art, line(-500, 0, 500, 0));
    addStroke(m, st, line(0, -400, 0, 400));
    const t = (200 * Math.PI) / 180;
    addStroke(m, st, line(Math.cos(t) * 350, Math.sin(t) * 350, 0, 0));
    const net = compile(m);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const j = net.junctions.find((x) => x.kind === 'crossing')!;
    expect(j.approaches.length).toBe(5);
    const artSegs = net.segments.filter((sg) => sg.strokeId === m.strokes[0].id);
    for (const a of j.approaches) {
      const seg = net.segments[a.segmentId];
      if (!artSegs.includes(seg)) continue;
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const d = Math.hypot((cap[0] + cap[2]) / 2 - j.x, (cap[1] + cap[3]) / 2 - j.y);
      expect(d, `arterial arm set back ${d.toFixed(1)} m`).toBeLessThan(20);
    }
    // And the slip road's own paint stays off the arterial's asphalt.
    const slip = net.segments.find((sg) => sg.strokeId === m.strokes[2].id)!;
    const inRing = (ring: Float32Array, x: number, y: number): boolean => {
      const n = ring.length >> 1; let inside = false;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[k * 2], yj = ring[k * 2 + 1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const depth = (ring: Float32Array, x: number, y: number): number => {
      const n = ring.length >> 1; let best = Infinity;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const ax = ring[k * 2], ay = ring[k * 2 + 1], bx = ring[i * 2], by = ring[i * 2 + 1];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
      }
      return best;
    };
    for (const mk of slip.markings) {
      for (let i = 0; i < mk.points.length; i += 2) {
        for (const sg of artSegs) {
          if (!inRing(sg.surface, mk.points[i], mk.points[i + 1])) continue;
          // A point on the shared boundary rounds either way; a point a metre in
          // is paint across the arterial's lanes.
          expect(depth(sg.surface, mk.points[i], mk.points[i + 1]), 'slip-road paint inside the arterial').toBeLessThan(0.3);
        }
      }
    }
  });

  it('carries the same movements', () => {
    const turns = (net: Network) => {
      const j = net.junctions.find((x) => x.kind === 'crossing')!;
      return j.connectorIds.map((id) => net.lanes[id].turn).sort().join(',');
    };
    expect(turns(three)).toBe(turns(two));
    expect(turns(four)).toBe(turns(two));
  });
});
