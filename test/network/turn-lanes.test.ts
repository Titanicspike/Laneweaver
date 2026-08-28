/**
 * Left-turn pockets.
 *
 * A left turn made from a through lane stops the whole lane behind it, so any
 * junction worth the name has a bay. What matters here is that the bay exists where
 * it should, that it is the *only* lane the left turn leaves from, and that adding
 * it moves nothing it should not: the median and the opposing carriageway stay
 * exactly where they were.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { TurnKind } from '@core/network/types';
import type { Lane, Network } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { kph } from '@core/network/model';
import { LaneKind } from '@core/network/types';
import type { TurnLaneChoice } from '@core/network/types';
import { deserialize, serialize } from '@core/util/serialization';
import {
  buildArclength, closestOnPolyline, makeClosestHit, samplePosition, sampleTangent,
} from '@core/geom/polyline';

function arterialCross(): Network {
  const model = doc();
  const arterial = addProfile(model, {
    name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    shoulder: 0.8, median: 2.4, speedLimit: 20,
  });
  addStroke(model, arterial, line(-400, 0, 400, 0));
  addStroke(model, arterial, line(0, -400, 0, 400));
  return compile(model);
}

/** Lanes that are a turn pocket: part-length, and inside the through lanes. */
function pockets(net: Network): Lane[] {
  return net.lanes.filter((l) => l.aux && l.index > 0);
}

describe('left-turn pockets', () => {
  it('gives every approach of a four-way arterial crossing a bay', () => {
    const net = arterialCross();
    expect(net.junctions.filter((j) => j.kind === 'crossing').length).toBe(1);
    expect(pockets(net).length).toBe(4);
    for (const p of pockets(net)) {
      expect(p.length).toBeGreaterThan(40);
      // Unusable until the bay has opened up.
      expect(p.startsAt).toBeGreaterThan(5);
    }
  });

  it('makes the bay the only lane a left turn leaves from', () => {
    const net = arterialCross();
    const ids = new Set(pockets(net).map((l) => l.id));
    let lefts = 0;
    for (const junction of net.junctions) {
      for (const cid of junction.connectorIds) {
        const connector = net.lanes[cid]!;
        const from = connector.predecessors[0]!;
        if (connector.turn === TurnKind.Left) {
          lefts++;
          expect(ids.has(from)).toBe(true);
        } else {
          // ...and nothing else leaves from it.
          expect(ids.has(from)).toBe(false);
        }
      }
    }
    expect(lefts).toBe(4);
  });

  it('runs the bay down the median and only widens by the rest', () => {
    const net = arterialCross();
    const pocket = pockets(net)[0]!;
    const seg = net.segments[pocket.segmentId]!;
    const through = net.lanes[pocket.right]!;
    expect(through.aux).toBe(false);

    // At the stop line the through lane sits exactly one lane further out than its
    // nominal offset, and the bay occupies the slot it left behind.
    const s = pocket.parentS[pocket.parentS.length - 1]!;
    const p = { x: 0, y: 0 }, t = { x: 0, y: 0 };
    samplePosition(seg.centerline, seg.arclength, s, p);
    sampleTangent(seg.centerline, seg.arclength, s, t);
    const lateral = (x: number, y: number): number => (x - p.x) * -t.y + (y - p.y) * t.x;

    const at = (lane: Lane): number => {
      let best = Infinity;
      let off = 0;
      const n = lane.centerline.length >> 1;
      for (let i = 0; i < n; i++) {
        const dx = lane.centerline[i * 2]! - p.x, dy = lane.centerline[i * 2 + 1]! - p.y;
        const along = Math.abs(dx * t.x + dy * t.y);
        if (along < best) { best = along; off = lateral(lane.centerline[i * 2]!, lane.centerline[i * 2 + 1]!); }
      }
      return off;
    };

    // A median is there to be used: all but a 0.45 m sliver of the 2.4 m median goes
    // into the 3.5 m bay, so the through lanes move over by the remainder rather
    // than by a whole lane. The sliver is what carries the double yellow between the
    // bay and opposing traffic.
    const median = 2.4;
    const sliver = 0.45;
    const widen = pocket.width - (median - sliver);
    expect(Math.abs(at(through) - (through.offset + Math.sign(through.offset) * widen)))
      .toBeLessThan(0.3);
    expect(Math.abs(at(pocket) - pocket.offset)).toBeLessThan(0.3);
    // ...and the road grows by that much, not by a lane.
    expect(seg.maxHalfWidth - seg.halfWidth).toBeCloseTo(widen, 1);
    // The bay sits where the median was: its inner edge reaches the surviving sliver.
    expect(Math.abs(at(pocket)) + pocket.width / 2).toBeLessThan(median / 2 + widen + 0.3);
    // ...and stops exactly one sliver short of the opposing carriageway.
    expect(Math.abs(at(pocket)) - pocket.width / 2 + median / 2).toBeCloseTo(sliver, 1);
  });

  it('flares its own kerb and leaves the opposing carriageway where it was', () => {
    // Only the turning group's lanes move: the bay opens against the median and
    // pushes that group's through lanes toward its own kerb. The asphalt used to
    // grow on *both* sides by the same amount, on the argument that the departing
    // side is a receiving flare — which laid a bay's width of road down the side
    // where nothing had moved, for the whole 85 m length of the bay. That ledge is
    // most of what "the roads are set back oddly and there is extra road" looks
    // like, and it made every arm crossing the road ask for a trim it did not need.
    const net = arterialCross();
    const pocket = pockets(net)[0]!;
    const seg = net.segments[pocket.segmentId]!;
    const s = pocket.parentS[pocket.parentS.length - 1]!;
    const p = { x: 0, y: 0 }, t = { x: 0, y: 0 };
    samplePosition(seg.centerline, seg.arclength, s, p);
    sampleTangent(seg.centerline, seg.arclength, s, t);
    const lateral = (x: number, y: number): number => (x - p.x) * -t.y + (y - p.y) * t.x;

    // Asphalt either side of the centreline, at the stop line and well clear of it.
    const edges = (at: { x: number; y: number }): { pos: number; neg: number } => {
      let pos = 0, neg = 0;
      for (let i = 0; i < seg.surface.length; i += 2) {
        const dx = seg.surface[i]! - at.x, dy = seg.surface[i + 1]! - at.y;
        if (Math.abs(dx * t.x + dy * t.y) > 4) continue;
        const off = lateral(seg.surface[i]!, seg.surface[i + 1]!);
        pos = Math.max(pos, off); neg = Math.min(neg, off);
      }
      return { pos, neg };
    };
    const far = { x: 0, y: 0 };
    samplePosition(seg.centerline, seg.arclength, Math.max(0, s - 200), far);
    const here = edges(p), there = edges(far);

    // The bay's own side grew by the widening; the other side did not move at all.
    const widen = pocket.width - (2.4 - 0.45);
    const bayIsPositive = pocket.offset * Math.sign(here.pos) >= 0;
    const grewBay = bayIsPositive ? here.pos - there.pos : there.neg - here.neg;
    const grewOther = bayIsPositive ? there.neg - here.neg : here.pos - there.pos;
    expect(grewBay, 'the kerb of the turning group').toBeCloseTo(widen, 1);
    expect(grewOther, 'the opposing carriageway').toBeCloseTo(0, 1);
  });

  // Two junctions close together give the same block a bay at each end, reaching
  // into the same median from opposite directions. If both take all of it their
  // median edge lines swap sides and paint a yellow X down the middle of the road.
  it('splits the median when both directions want the same stretch of it', () => {
    const model = doc();
    const arterial = addProfile(model, {
      name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      shoulder: 0.8, median: 2.4, speedLimit: 20,
    });
    const street = addProfile(model, {
      name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
      shoulder: 0.4, speedLimit: 11,
    });
    addStroke(model, arterial, line(-500, 0, 500, 0));
    addStroke(model, street, line(-30, -300, -30, 300));
    addStroke(model, street, line(70, -300, 70, 300));
    const net = compile(model);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const middle = net.segments.find((s2) => s2.laneIds.length > 4 && s2.length < 200);
    expect(middle).toBeDefined();
    const medians = middle!.markings.filter((m) => m.style === 'median');
    expect(medians.length).toBe(2);

    // Walk both lines and check they never change places.
    const p = { x: 0, y: 0 };
    const t = { x: 1, y: 0 };
    const hit = makeClosestHit();
    const arcs = medians.map((m) => buildArclength(m.points));
    let sign = 0;
    for (let s2 = 2; s2 < middle!.length - 2; s2 += 2) {
      samplePosition(middle!.centerline, middle!.arclength, s2, p);
      sampleTangent(middle!.centerline, middle!.arclength, s2, t);
      const lat = medians.map((m, i) => {
        closestOnPolyline(m.points, arcs[i]!, p.x, p.y, hit);
        return (hit.x - p.x) * -t.y + (hit.y - p.y) * t.x;
      });
      const d = lat[0]! - lat[1]!;
      if (Math.abs(d) < 0.05) continue;
      if (sign === 0) sign = Math.sign(d);
      expect(Math.sign(d), `at s=${s2}`).toBe(sign);
    }
  });

  it('leaves small streets alone', () => {
    const model = doc();
    const street = addProfile(model, {
      name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
      shoulder: 0.4, median: 0, speedLimit: 11,
    });
    addStroke(model, street, line(-300, 0, 300, 0));
    addStroke(model, street, line(0, -300, 0, 300));
    const net = compile(model);
    expect(net.junctions.some((j) => j.kind === 'crossing')).toBe(true);
    // A single-lane approach has nothing to overtake the turner in, so a bay there
    // would just be a wider road.
    expect(pockets(net).length).toBe(0);
  });

  it('skips an approach with nowhere to turn left', () => {
    // A T where the stem leaves to the right of the eastbound approach: that
    // approach can only go straight or right.
    const model = doc();
    const arterial = addProfile(model, {
      name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      shoulder: 0.8, median: 2.4, speedLimit: 20,
    });
    const oneWayOut = addProfile(model, {
      name: 'exit', lanesForward: 1, lanesBackward: 0, laneWidth: 3.5,
      shoulder: 0.5, median: 0, speedLimit: 14,
    });
    addStroke(model, arterial, line(-400, 0, 400, 0));
    // Runs south from the junction, and only carries traffic away from it.
    addStroke(model, oneWayOut, line(0, 0, 0, 400));
    const net = compile(model);
    const found = pockets(net);
    // Only the westbound approach has a left turn onto the stem.
    expect(found.length).toBe(1);
    expect(found[0]!.side).toBe(-1);
  });
});


/**
 * Turn bays are a choice, not a verdict.
 *
 * The compiler's own rule — a left bay where the group has two lanes or more, there
 * is somewhere to turn left to, and the block is long enough — is a good default and
 * a bad master. Every one of those is a judgement about a typical junction, and the
 * whole point of drawing your own network is that some of yours are not typical. So
 * each approach can be told what to have, including a kerb-side bay, which the
 * compiler never builds on its own.
 */
describe('turn bays chosen by hand', () => {
  /** A crossing whose east-west road can be given bays on its eastbound approach. */
  function crossing(choice: TurnLaneChoice | null, lanes = 2, median = 2.4): Network {
    const m = doc(5);
    const art = addProfile(m, {
      name: 'art', lanesForward: lanes, lanesBackward: lanes, laneWidth: 3.5,
      shoulder: 0.6, median, speedLimit: kph(60),
    });
    const st = addProfile(m, {
      name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
    });
    const main = addStroke(m, art, line(-400, 0, 400, 0));
    addStroke(m, st, line(0, -400, 0, 400));
    if (choice) {
      m.junctions.push({
        x: 0, y: 0, control: 'priority',
        turnLanes: [{ approach: `${main.id}:1`, choice }],
      });
    }
    return compile(m);
  }

  /** Bays on the approach under test: auxiliary road lanes with a taper in front. */
  const baysOnApproach = (net: Network): Lane[] =>
    net.lanes.filter((l) => l.aux && l.kind === LaneKind.Road && l.side === 1 && l.startsAt > 0);

  /** Lane indices a given turn leaves from, on the segment the bays are on. */
  function leavesFrom(net: Network, turn: TurnKind, segmentId: number): number[] {
    const out = new Set<number>();
    for (const lane of net.lanes) {
      if (lane.kind !== LaneKind.Connector || lane.turn !== turn) continue;
      const src = net.lanes[lane.predecessors[0]];
      if (src && src.segmentId === segmentId) out.add(src.index);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Where each lane of a group actually is, across the road at the stop line. */
  function crossSectionAt(net: Network, segmentId: number, side: 1 | -1): number[] {
    const seg = net.segments[segmentId];
    const out: number[] = [];
    for (const id of seg.laneIds) {
      const lane = net.lanes[id];
      if (lane.side !== side) continue;
      // The last point of the centreline — the stop line, where every bay is open.
      // The road under test runs along x, so its cross-section is simply y.
      out.push(lane.centerline[lane.centerline.length - 1]);
    }
    return out.sort((a, b) => a - b);
  }

  it('takes the bay away when asked', () => {
    expect(baysOnApproach(crossing(null)).length).toBe(1);
    expect(baysOnApproach(crossing('none')).length).toBe(0);
  });

  it('builds one where the compiler would not', () => {
    // One lane each way and no median: the automatic rule declines, because a
    // single-lane approach has nothing to overtake the turner in. That is a
    // judgement, and on a real junction it is often the wrong one.
    expect(baysOnApproach(crossing(null, 1, 0)).length).toBe(0);
    const forced = crossing('left', 1, 0);
    expect(baysOnApproach(forced).length).toBe(1);
    // And it is still the only lane the left turn leaves from.
    const bay = baysOnApproach(forced)[0];
    expect(leavesFrom(forced, TurnKind.Left, bay.segmentId)).toEqual([bay.index]);
  });

  it('builds a kerb-side bay, which it never does on its own', () => {
    const net = crossing('right');
    const bays = baysOnApproach(net);
    expect(bays.length).toBe(1);
    // Outboard of every through lane, so it sorts to a negative slot and the right
    // turn is the only movement that can reach it.
    expect(bays[0].index).toBeLessThan(0);
    expect(leavesFrom(net, TurnKind.Right, bays[0].segmentId)).toEqual([bays[0].index]);
  });

  it('stacks both without putting one on top of the other', () => {
    // The kerb edge a right bay opens from is where the through lanes have been
    // pushed *to*, not where they started. Reading the unshifted edge lands the two
    // bays and the outermost through lane in the same place — which on a
    // single-lane approach is the entire carriageway.
    const net = crossing('both', 1, 0);
    const bays = baysOnApproach(net);
    expect(bays.length).toBe(2);
    // Measured where the lanes actually run rather than from their nominal offsets:
    // a through lane beside a median bay is stored at the offset it would have had,
    // and runs a lane further out. Three lanes at the stop line, none on top of
    // another: the kerb bay, the through lane, the median bay.
    const across = crossSectionAt(net, bays[0].segmentId, 1);
    expect(across.length).toBe(3);
    for (let i = 1; i < across.length; i++) {
      expect(across[i] - across[i - 1], `lanes at ${across.map((v) => v.toFixed(1)).join(', ')}`)
        .toBeGreaterThan(bays[0].width * 0.9);
    }
    const seg = bays[0].segmentId;
    expect(leavesFrom(net, TurnKind.Left, seg)).toEqual([Math.max(...bays.map((b) => b.index))]);
    expect(leavesFrom(net, TurnKind.Right, seg)).toEqual([Math.min(...bays.map((b) => b.index))]);
  });

  it('never builds a bay pointing at nothing', () => {
    // Somewhere to turn is physical rather than policy, so forcing does not override
    // it: a bay with no connector is paint nobody can legally use.
    const m = doc(5);
    const art = addProfile(m, {
      name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2.4,
      shoulder: 0.6, speedLimit: kph(60),
    });
    const oneWay = addProfile(m, {
      name: 'ow', lanesForward: 1, lanesBackward: 0, laneWidth: 3.2, speedLimit: kph(40),
    });
    const main = addStroke(m, art, line(-400, 0, 400, 0));
    // A one-way stub leaving northward: nothing arrives from it, and an eastbound
    // driver has no left turn to make into it.
    addStroke(m, oneWay, line(0, 0, 0, 400));
    m.junctions.push({
      x: 0, y: 0, control: 'priority',
      turnLanes: [{ approach: `${main.id}:1`, choice: 'left' }],
    });
    const net = compile(m);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(baysOnApproach(net).length).toBe(0);
  });

  it('survives a save and load', () => {
    const m = doc(5);
    const art = addProfile(m, {
      name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2.4,
      shoulder: 0.6, speedLimit: kph(60),
    });
    const st = addProfile(m, {
      name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
    });
    const main = addStroke(m, art, line(-400, 0, 400, 0));
    addStroke(m, st, line(0, -400, 0, 400));
    m.junctions.push({
      x: 0, y: 0, control: 'priority',
      turnLanes: [{ approach: `${main.id}:1`, choice: 'both' }],
    });
    const back = deserialize(serialize(m));
    expect(back.junctions[0].turnLanes).toEqual([{ approach: `${main.id}:1`, choice: 'both' }]);
    // And it still compiles to the same thing.
    expect(baysOnApproach(compile(back)).length).toBe(2);
  });
});
