/**
 * Hand-wired junction movements.
 *
 * The compiler lays a junction out itself, but an override replaces that layout
 * wholesale: any incoming lane to any outgoing lane, one lane feeding several and
 * several feeding one. Lanes are named `strokeId:side:index` because lane ids are
 * derived data and change on every recompile.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { laneKeyOf } from '@core/network/compiler/junctions';
import { addProfile, addStroke, doc, line, pts } from '../helpers/build';
import type { EditModel, Network } from '@core/network/types';

function crossing(): { model: EditModel; net: Network } {
  const model = doc();
  const arterial = addProfile(model, {
    name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    shoulder: 0.8, median: 2.4, speedLimit: 20,
  });
  addStroke(model, arterial, line(-400, 0, 400, 0));
  addStroke(model, arterial, line(0, -400, 0, 400));
  return { model, net: compile(model) };
}

describe('hand-wired junction movements', () => {
  it('names lanes by something the document owns', () => {
    const { net } = crossing();
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const lane = net.lanes[junction.approaches[0]!.incomingLanes[0]!]!;
    const key = laneKeyOf(lane, net.segments);
    expect(key).toMatch(/^\d+:-?1:\d+$/);
    // Recompiling reassigns lane ids; the name must survive it.
    const again = compile(crossing().model);
    const twin = again.junctions.find((j) => j.kind === 'crossing')!;
    const keys = twin.approaches.flatMap((a) =>
      a.incomingLanes.map((id) => laneKeyOf(again.lanes[id]!, again.segments)));
    expect(keys).toContain(key);
  });

  it('replaces the compiler’s layout with exactly what was asked for', () => {
    const { model, net } = crossing();
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const west = junction.approaches.find((a) => a.incomingLanes.length)!;
    const other = junction.approaches.find((a) => a !== west && a.outgoingLanes.length)!;
    const from = laneKeyOf(net.lanes[west.incomingLanes[0]!]!, net.segments);
    const to = laneKeyOf(net.lanes[other.outgoingLanes[0]!]!, net.segments);

    model.laneLinks.push({ x: junction.x, y: junction.y, links: [{ from, to }] });
    const wired = compile(model);
    const after = wired.junctions.find((j) => j.kind === 'crossing')!;
    expect(after.connectorIds.length).toBe(1);
    const connector = wired.lanes[after.connectorIds[0]!]!;
    expect(laneKeyOf(wired.lanes[connector.predecessors[0]!]!, wired.segments)).toBe(from);
    expect(laneKeyOf(wired.lanes[connector.successors[0]!]!, wired.segments)).toBe(to);
  });

  it('lets one lane branch, and several lanes converge', () => {
    const { model, net } = crossing();
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const source = junction.approaches.find((a) => a.incomingLanes.length >= 2)!;
    const targets = junction.approaches.filter((a) => a !== source && a.outgoingLanes.length);
    const key = (id: number): string => laneKeyOf(net.lanes[id]!, net.segments);

    const branchFrom = key(source.incomingLanes[0]!);
    const links = [
      // One lane in, two ways out.
      { from: branchFrom, to: key(targets[0]!.outgoingLanes[0]!) },
      { from: branchFrom, to: key(targets[1]!.outgoingLanes[0]!) },
      // Two lanes in, the same way out.
      { from: key(source.incomingLanes[1]!), to: key(targets[0]!.outgoingLanes[0]!) },
    ];
    model.laneLinks.push({ x: junction.x, y: junction.y, links });
    const wired = compile(model);
    const after = wired.junctions.find((j) => j.kind === 'crossing')!;
    expect(after.connectorIds.length).toBe(3);

    const branch = wired.lanes.filter(
      (l) => l.junctionId === after.id
        && laneKeyOf(wired.lanes[l.predecessors[0]!]!, wired.segments) === branchFrom,
    );
    expect(branch.length).toBe(2);
    // Still a strict total order, however the movements were wired.
    const ranks = after.connectorIds.map((id) => wired.lanes[id]!.priorityRank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('warns rather than throws when a wired lane has gone', () => {
    const { model, net } = crossing();
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    model.laneLinks.push({
      x: junction.x, y: junction.y,
      links: [{ from: '999:1:0', to: '999:1:1' }],
    });
    const wired = compile(model);
    expect(wired.diagnostics.some((d) => d.code === 'lane-link-stale')).toBe(true);
  });
});

/**
 * Gores can be wired by hand too.
 *
 * Which lane of a two-lane ramp joins which auxiliary lane is a real choice, and
 * the compiler's lane-for-lane pairing is only the sensible default. A merge runs
 * ramp to road and a diverge road to ramp, so naming the pair the other way round
 * has to be refused rather than build a connector nobody can drive.
 */
describe('hand-wired ramp movements', () => {
  function rampDoc(kind: 'on' | 'off'): EditModel {
    const model = doc();
    const freeway = addProfile(model, {
      name: 'freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const ramp = addProfile(model, {
      name: 'ramp', lanesForward: 2, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
      isRamp: true,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    addStroke(model, freeway, line(-1200, 0, 1200, 0));
    addStroke(model, ramp, kind === 'on'
      ? pts(-500, 200, -200, 90, 0, 0)
      : pts(0, 0, 200, 90, 500, 200));
    return model;
  }

  const pairsOf = (net: Network, kind: 'merge' | 'diverge'): { from: string; to: string }[] => {
    const junction = net.junctions.find((j) => j.kind === kind)!;
    return junction.connectorIds.map((id) => {
      const c = net.lanes[id]!;
      return {
        from: laneKeyOf(net.lanes[c.predecessors[0]!]!, net.segments),
        to: laneKeyOf(net.lanes[c.successors[0]!]!, net.segments),
      };
    });
  };

  for (const [kind, junctionKind] of [['on', 'merge'], ['off', 'diverge']] as const) {
    it(`crosses over which ramp lane joins which auxiliary lane (${kind}-ramp)`, () => {
      const model = rampDoc(kind);
      const before = pairsOf(compile(model), junctionKind);
      expect(before.length).toBe(2);
      expect(before[0].to).not.toBe(before[1].to);

      const junction = compile(model).junctions.find((j) => j.kind === junctionKind)!;
      model.laneLinks.push({
        x: junction.x, y: junction.y,
        links: [
          { from: before[0].from, to: before[1].to },
          { from: before[1].from, to: before[0].to },
        ],
      });
      const after = compile(model);
      expect(after.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const now = pairsOf(after, junctionKind);
      expect(now.length).toBe(2);
      expect(now.find((p) => p.from === before[0].from)!.to).toBe(before[1].to);
      expect(now.find((p) => p.from === before[1].from)!.to).toBe(before[0].to);
    });
  }

  /**
   * A pair named backwards is refused — and the gore is still a gore.
   *
   * Refusing it is right: a merge runs ramp to road, and building the reverse would
   * make a connector nobody can drive. But refusing every pair and stopping there
   * left the entrance with *no movements at all*, which is not a junction wired
   * differently, it is a hole in the middle of a motorway that traffic vanishes into.
   * An override that resolves nothing is a broken edit rather than a choice, so it is
   * handed back to the compiler and said out loud — the same treatment a signal plan
   * with no usable phase gets, rather than being left sitting on all-red.
   *
   * The message matters too. At a gore the two halves live on different roads and
   * there is nothing on screen to say which end is which, so getting the order wrong
   * is the likeliest mistake there is; telling somebody their lane "is no longer
   * there" sends them looking for a road they never deleted.
   */
  it('refuses a pair named the wrong way round without losing the gore', () => {
    const model = rampDoc('on');
    const first = pairsOf(compile(model), 'merge')[0];
    const junction = compile(model).junctions.find((j) => j.kind === 'merge')!;
    const automatic = junction.connectorIds.length;
    // Ramp and road the wrong way about: a merge never runs road to ramp.
    model.laneLinks.push({
      x: junction.x, y: junction.y,
      links: [{ from: first.to, to: first.from }],
    });
    const after = compile(model);
    expect(after.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // The reversed pair is not built...
    expect(after.diagnostics.some((d) => d.code === 'lane-link-reversed')).toBe(true);
    // ...and because nothing else was, the compiler takes the gore back.
    expect(after.diagnostics.some((d) => d.code === 'lane-links-unusable')).toBe(true);
    const gore = after.junctions.find((j) => j.kind === 'merge')!;
    expect(gore.connectorIds.length).toBe(automatic);
    expect(pairsOf(after, 'merge')).toEqual(pairsOf(compile(rampDoc('on')), 'merge'));
  });

  it('keeps the good half of a partly broken override', () => {
    // One usable pair is a wiring the user meant. Only when *none* of them resolve is
    // the whole thing treated as a mistake.
    const model = rampDoc('on');
    const pairs = pairsOf(compile(model), 'merge');
    const junction = compile(model).junctions.find((j) => j.kind === 'merge')!;
    model.laneLinks.push({
      x: junction.x, y: junction.y,
      links: [pairs[0], { from: pairs[1].to, to: pairs[1].from }],
    });
    const after = compile(model);
    expect(after.diagnostics.some((d) => d.code === 'lane-links-unusable')).toBe(false);
    expect(pairsOf(after, 'merge')).toEqual([pairs[0]]);
  });
});
