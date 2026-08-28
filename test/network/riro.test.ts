/**
 * Right-in / right-out.
 *
 * A minor road meeting a divided major one at a T, where the minor road may only
 * turn onto the near carriageway and only the near carriageway may turn into it.
 * Nothing crosses the median, so it stays unbroken; the far carriageway never
 * knows the stem is there — no conflict point, no signal, no stop line.
 *
 * It is a junction choice rather than a road type, keyed by position like the
 * control and the turn bays, because it is a fact about one T and not about either
 * road: the same street meeting the same arterial a block further on may well be
 * allowed every turn.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import { LaneKind, TurnKind } from '@core/network/types';
import type { EditModel, Network } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { deserialize, serialize } from '@core/util/serialization';
import { Simulation } from '@core/sim/sim';

/** A divided arterial running east–west with a street ending on it from the north. */
function tee(on: boolean, control: 'priority' | 'signal' | 'allway-stop' = 'priority'): EditModel {
  const m = doc(5);
  const art = addProfile(m, {
    name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, shoulder: 0.6,
    median: 2.4, speedLimit: kph(70),
  });
  const st = addProfile(m, {
    name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50),
  });
  addStroke(m, art, line(-600, 0, 600, 0));
  addStroke(m, st, line(0, 400, 0, 0));
  m.junctions.push({ x: 0, y: 0, control, ...(on ? { rightInRightOut: true } : {}) });
  return m;
}

const crossing = (net: Network) => net.junctions.find((j) => j.kind === 'crossing')!;

/** Movements at the crossing as (from segment, turn, to segment) triples. */
function movements(net: Network) {
  const j = crossing(net);
  return j.connectorIds.map((id) => {
    const c = net.lanes[id];
    return {
      turn: c.turn,
      from: net.lanes[c.predecessors[0]],
      to: net.lanes[c.successors[0]],
      conflicts: c.conflicts.length,
    };
  });
}

describe('right-in / right-out', () => {
  const plain = compile(tee(false));
  const riro = compile(tee(true));

  it('compiles clean and says so on the junction', () => {
    expect(riro.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(riro.diagnostics.some((d) => d.code === 'right-in-right-out-shape')).toBe(false);
    expect(crossing(riro).rightInRightOut).toBe(true);
    expect(crossing(plain).rightInRightOut).not.toBe(true);
  });

  it('allows only the kerb-side turns', () => {
    const moves = movements(riro);
    expect(moves.length).toBeGreaterThan(0);
    // No left turn anywhere — that is the median staying unbroken.
    expect(moves.filter((m) => m.turn === TurnKind.Left)).toEqual([]);
    expect(moves.filter((m) => m.turn === TurnKind.UTurn)).toEqual([]);
    // The stem does exactly one thing.
    const stemSeg = riro.segments.find((s) => s.strokeId === riro.segments[0].strokeId + 1)
      ?? riro.segments.find((s) => s.frontages.length === 0 && s.laneIds.length === 2)!;
    const fromStem = moves.filter((m) => m.from.segmentId === stemSeg.id);
    expect(fromStem.length).toBeGreaterThan(0);
    for (const m of fromStem) expect(m.turn).toBe(TurnKind.Right);
    // And the plain T had lefts, so the difference is the option and not the shape.
    expect(movements(plain).some((m) => m.turn === TurnKind.Left)).toBe(true);
  });

  it('never touches the far carriageway', () => {
    const moves = movements(riro);
    const rights = moves.filter((m) => m.turn === TurnKind.Right && m.from.segmentId >= 0);
    // The right turn into the stem comes from one carriageway only.
    const intoStem = rights.filter((m) => m.to.segmentId !== m.from.segmentId
      && riro.segments[m.to.segmentId].laneIds.length === 2);
    expect(intoStem.length).toBeGreaterThan(0);
    const nearSide = intoStem[0].from.side;
    // Every through movement on the far carriageway has no conflict at all: nothing
    // crosses it, nothing merges into it.
    const far = moves.filter((m) => m.turn === TurnKind.Straight && m.from.side !== nearSide);
    expect(far.length).toBe(2);
    for (const m of far) expect(m.conflicts, 'a far-carriageway through movement in conflict').toBe(0);
  });

  it('runs on priority, whatever the document asked for', () => {
    expect(crossing(riro).control).toBe('priority');
    expect(crossing(compile(tee(true, 'signal'))).control).toBe('priority');
    expect(crossing(compile(tee(true, 'allway-stop'))).control).toBe('priority');
    // And a plain T obeys the choice, so the override is specific to this option.
    expect(crossing(compile(tee(false, 'signal'))).control).toBe('signal');
  });

  it('builds no left-turn bay, since there is no left turn', () => {
    const bays = (net: Network) => net.lanes.filter((l) => l.aux && l.kind === LaneKind.Road && l.startsAt > 0);
    expect(bays(plain).length).toBeGreaterThan(0);
    expect(bays(riro).length).toBe(0);
  });

  it('carries the through road\'s paint across the junction, except the near kerb', () => {
    const j = crossing(riro);
    const styles = j.markings.map((m) => m.style);
    // Both carriageways' median edges, the lane line between each pair of lanes...
    expect(styles.filter((s) => s === 'median').length).toBe(2);
    expect(styles.filter((s) => s === 'dashed').length).toBe(2);
    // ...and the far kerb's edge line — but not the near one's, which opens for the stem.
    expect(styles.filter((s) => s === 'edge').length).toBe(1);
    // Each piece spans the gap between the two caps rather than stopping short.
    const gap = j.radius * 2 * 0.8;
    for (const m of j.markings) {
      const p = m.points;
      const span = Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]);
      expect(span, `${m.style} spans ${span.toFixed(1)} m of a ${gap.toFixed(1)} m gap`).toBeGreaterThan(gap);
    }
    // A plain T paints nothing of the kind.
    expect(crossing(plain).markings.filter((m) => m.style !== 'zebra')).toEqual([]);
  });

  it('refuses a shape that is not a T', () => {
    const m = doc(5);
    const art = addProfile(m, {
      name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2.4, speedLimit: kph(70),
    });
    addStroke(m, art, line(-600, 0, 600, 0));
    addStroke(m, art, line(0, -600, 0, 600));
    m.junctions.push({ x: 0, y: 0, control: 'priority', rightInRightOut: true });
    const net = compile(m);
    expect(net.diagnostics.some((d) => d.code === 'right-in-right-out-shape')).toBe(true);
    expect(crossing(net).rightInRightOut).not.toBe(true);
    expect(movements(net).some((x) => x.turn === TurnKind.Left)).toBe(true);
  });

  it('survives a save and load', () => {
    const back = deserialize(serialize(tee(true)));
    expect(back.junctions[0].rightInRightOut).toBe(true);
    expect(crossing(compile(back)).rightInRightOut).toBe(true);
    const off = deserialize(serialize(tee(false)));
    expect(off.junctions[0].rightInRightOut).toBeUndefined();
  });

  it('leaves the far carriageway at speed under load, and nobody collides', () => {
    const sim = new Simulation(riro, { seed: 7, demandScale: 1.2 });
    sim.run(120);
    const j = crossing(riro);
    const moves = movements(riro);
    const nearSide = moves.find((m) => m.turn === TurnKind.Right && m.from.segmentId >= 0
      && riro.segments[m.to.segmentId].laneIds.length === 2)!.from.side;
    const farLanes = new Set<number>();
    for (const a of j.approaches) {
      for (const id of a.incomingLanes) if (riro.lanes[id].side !== nearSide) farLanes.add(id);
    }
    expect(farLanes.size).toBe(2);
    const limit = Math.max(...[...farLanes].map((id) => riro.lanes[id].speedLimit));
    let sum = 0, n = 0, slow = 0;
    const S = sim.store;
    for (let t = 0; t < 4800; t++) {
      sim.tick();
      if (t % 10) continue;
      for (let i = 0; i < S.count; i++) {
        if (!farLanes.has(S.lane[i])) continue;
        // Past the first hundred metres, so a vehicle still getting up to speed from
        // its portal is not counted against the junction.
        if (S.s[i] < 100) continue;
        sum += S.v[i]; n++;
        if (S.v[i] < limit * 0.5) slow++;
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(sum / n, 'mean speed on the far carriageway').toBeGreaterThan(limit * 0.85);
    expect(slow / n, 'share of far-carriageway samples below half the limit').toBeLessThan(0.02);
    expect(sim.metrics.collisions).toBe(0);
    expect(sim.metrics.lost).toBe(0);
    expect(sim.metrics.arrived).toBeGreaterThan(100);
  });
});
