/**
 * Wiring a gore by hand, driven the way a user drives it.
 *
 * The tool used to offer only the auxiliary lanes at a gore, so the single choice it
 * could express was which ramp lane fed which — and the arrangements a real exit is
 * built from could not be described at all: a lane that carries on *and* exits, a
 * lane that may only exit, two lanes funnelling into one.
 *
 * The mainline's own lanes are now on offer, which drags in the rest of it. A through
 * lane runs straight past a gore, so it has no end to branch from until the road is
 * split there; the split is made when the document wires one. And because an override
 * replaces the whole set, the through movements have to be *in* that set — otherwise
 * the first movement anybody adds takes them away with it, and one shift-click ends
 * the motorway. That is what the first case here is really about.
 */

import { describe, expect, it } from 'vitest';
import { InspectTool } from '@editor/tools/inspectTool';

import { kph } from '@core/network/model';
import { LaneKind, TurnKind } from '@core/network/types';
import type { EditModel, Lane, Network } from '@core/network/types';
import { addProfile, addStroke, doc, line, pts } from '../helpers/build';
import { harness } from '../helpers/editor';

/** A three-lane freeway with a two-lane exit. */
function withExit(): EditModel {
  const m = doc(11);
  const fw = addProfile(m, {
    name: 'fw', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
    speedLimit: kph(110),
  });
  const ramp = addProfile(m, {
    name: 'ramp', lanesForward: 2, lanesBackward: 0, laneWidth: 3.8, shoulder: 1.2,
    speedLimit: kph(80), isRamp: true,
  });
  addStroke(m, fw, line(-1200, 0, 1200, 0, 3));
  addStroke(m, ramp, pts(0, 0, 200, 90, 500, 200));
  return m;
}

const goreOf = (net: Network) => net.junctions.find((j) => j.kind === 'diverge')!;

/** A point on a lane, a little way back from its end, to click. */
function on(lane: Lane, frac: number): { x: number; y: number } {
  const n = lane.centerline.length >> 1;
  const i = Math.min(n - 1, Math.max(0, Math.round((n - 1) * frac)));
  return { x: lane.centerline[i * 2], y: lane.centerline[i * 2 + 1] };
}

/** The mainline through lanes running past the gore, kerb-side first. */
function throughLanes(net: Network, gore: { x: number; y: number }): Lane[] {
  const out: Lane[] = [];
  for (const lane of net.lanes) {
    if (lane.kind !== LaneKind.Road || lane.aux) continue;
    let near = Infinity;
    for (let i = 0; i < lane.centerline.length; i += 2) {
      near = Math.min(near, Math.hypot(lane.centerline[i] - gore.x, lane.centerline[i + 1] - gore.y));
    }
    if (near < 30) out.push(lane);
  }
  return out.sort((a, b) => a.index - b.index);
}

describe('wiring a gore by hand', () => {
  it('offers the mainline lanes, not only the auxiliary ones', () => {
    const h = harness(withExit());
    h.settle();
    const net = h.store.network;
    const gore = goreOf(net);
    const tool = new InspectTool();
    const sides = (tool as unknown as {
      sides(n: Network, j: typeof gore): { incoming: Lane[]; outgoing: Lane[] };
    }).sides(net, gore);

    // Every through lane of the carriageway the ramp leaves, on the way in...
    const through = throughLanes(net, gore);
    expect(through.length).toBeGreaterThanOrEqual(3);
    for (const lane of through) {
      expect(sides.incoming.some((l) => l.id === lane.id), `lane ${lane.index} offered`).toBe(true);
      // ...and on the way out, because until something is wired it is one lane that
      // both arrives and leaves.
      expect(sides.outgoing.some((l) => l.id === lane.id), `lane ${lane.index} as a target`).toBe(true);
    }
    // The ramp is still there to send them to.
    expect(sides.outgoing.some((l) => l.segmentId !== through[0].segmentId)).toBe(true);
  });

  it('does not end the motorway with the first click', () => {
    // The seed is the compiler's own answer, through movements included. Add one
    // exit movement to a through lane and everything that carried on still does.
    const h = harness(withExit());
    h.settle();
    const before = h.store.network;
    const gore = goreOf(before);
    const kerb = throughLanes(before, gore)[0];
    const rampLane = before.lanes[before.lanes[gore.connectorIds[0]].successors[0]];

    const tool = new InspectTool();
    h.click(tool, on(kerb, 0.5).x, on(kerb, 0.5).y, { shift: true });
    h.click(tool, on(rampLane, 0.4).x, on(rampLane, 0.4).y, { shift: true });
    h.settle();

    const after = h.store.network;
    expect(after.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(h.store.model.laneLinks.length, 'the gore is now wired by hand').toBe(1);
    // Three lanes in, three lanes out: the road still goes somewhere.
    const gore2 = goreOf(after);
    const carriesOn = throughLanes(after, gore2)
      .filter((l) => l.successors.length > 0 || l.endsAt < Infinity);
    expect(carriesOn.length, 'through lanes that still lead somewhere').toBeGreaterThanOrEqual(3);
    expect(after.diagnostics.some((d) => d.code === 'lane-link-dead-end')).toBe(false);
  });

  it('makes the kerb lane both carry on and exit', () => {
    const h = harness(withExit());
    h.settle();
    const gore = goreOf(h.store.network);
    const kerb = throughLanes(h.store.network, gore)[0];
    const rampLane = h.store.network.lanes[
      h.store.network.lanes[gore.connectorIds[0]].successors[0]];

    const tool = new InspectTool();
    h.click(tool, on(kerb, 0.5).x, on(kerb, 0.5).y, { shift: true });
    h.click(tool, on(rampLane, 0.4).x, on(rampLane, 0.4).y, { shift: true });
    h.settle();

    const net = h.store.network;
    const lane = throughLanes(net, goreOf(net))
      .find((l) => l.index === kerb.index && l.successors.length > 1);
    expect(lane, 'a lane that both carries on and turns off').toBeDefined();
    // One of its ways on is a diverge connector; the other is the road carrying on.
    const kinds = lane!.successors.map((id) => net.lanes[id]);
    expect(kinds.some((l) => l.kind === LaneKind.Connector && l.turn === TurnKind.Diverge)).toBe(true);
    expect(kinds.some((l) => l.kind === LaneKind.Road)).toBe(true);
  });
});
