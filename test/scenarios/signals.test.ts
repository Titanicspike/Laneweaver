/**
 * Signal plans, stress-tested across every intersection shape that breaks a
 * different assumption.
 *
 * The zoo lives in `scratch/signalCases.ts` next to the visual one, and
 * `npx tsx scratch/signalcheck.ts` prints the same numbers these assertions are
 * built from. Each shape is here because it defeats a generator that only knows
 * about four-arm crossroads: a T has an arm with nothing opposite it, a five-way
 * cannot be split into two axes at all, a skew crossing has no compass directions
 * worth the name, a one-way arm has no opposing through to be protected from, and
 * a narrow crossing has no left-turn bays to hold turners in.
 *
 * What is asserted, and why it is that rather than a throughput number: protected
 * phasing *costs* capacity — it is chosen when a left turn cannot safely be made on
 * a gap, and the price is a longer cycle. So the invariants are the ones that must
 * hold whatever plan is running (nobody crashes, nobody is lost, nobody is starved,
 * the junction keeps discharging), plus the one thing "protected" actually claims:
 * a protected left never has to stop inside the junction.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { hashHex } from '@core/sim/hash';
import {
  corridor, movementGroups, presetPhases, protectionOf, hasLeftBay,
} from '@core/network/compiler/signals';
import type { SignalPreset } from '@core/network/compiler/signals';
import { LaneKind, TurnKind } from '@core/network/types';
import type { EditModel, Network } from '@core/network/types';
import { signalCases, planFor } from '../../scratch/signalCases';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { kph } from '@core/network/model';

const PRESETS: SignalPreset[] = ['permissive', 'protected', 'split'];
/** Below saturation, so a growing queue means something is wrong rather than busy. */
const EASY = 0.6;
/** Over capacity for most of these plans: the junction must degrade, not lock. */
const HEAVY = 1.3;
const MINUTES = 8;

interface RunResult {
  net: Network;
  sim: Simulation;
  /** Movement groups that carried at least one vehicle. */
  servedGroups: Set<string>;
  /** Vehicles that arrived during the final minute. */
  lateArrivals: number;
  worstWait: number;
}

function drive(model: EditModel, demandScale: number, seed: number, seconds = MINUTES * 60): RunResult {
  const net = compile(model);
  const sim = new Simulation(net, { seed, demandScale });
  const groupOf = new Map<number, string>();
  for (const junction of net.junctions) {
    if (junction.control !== 'signal') continue;
    for (const g of movementGroups(net.lanes, net.segments, junction.approaches, junction.connectorIds)) {
      for (const id of g.connectorIds) groupOf.set(id, g.key);
    }
  }
  const servedGroups = new Set<string>();
  const connectors = [...groupOf.keys()];
  let beforeLastMinute = 0;
  for (let t = 0; t < seconds; t += 0.5) {
    sim.run(0.5);
    if (Math.abs(t - (seconds - 60)) < 0.26) beforeLastMinute = sim.metrics.arrived;
    for (const id of connectors) {
      if (sim.store.laneFirst[id] >= 0) servedGroups.add(groupOf.get(id)!);
    }
  }
  let worstWait = 0;
  for (let i = 0; i < sim.store.capacity; i++) {
    if (sim.store.alive[i]) worstWait = Math.max(worstWait, sim.store.waitTime[i]);
  }
  return { net, sim, servedGroups, lateArrivals: sim.metrics.arrived - beforeLastMinute, worstWait };
}

function longestCycle(net: Network): number {
  let cycle = 0;
  for (const j of net.junctions) if (j.signal) cycle = Math.max(cycle, j.signal.cycle);
  return cycle;
}

describe('generated signal plans', () => {
  for (const shape of signalCases()) {
    for (const preset of PRESETS) {
      describe(`${shape.name} · ${preset}`, () => {
        it('compiles into a plan that greens every movement', () => {
          const net = compile(planFor(shape.build(), preset));
          expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
          for (const junction of net.junctions) {
            if (junction.control !== 'signal') continue;
            const plan = junction.signal!;
            expect(plan.phases.length).toBeGreaterThan(0);
            // A cycle nobody would sit through is a plan nobody would use, however
            // many arms the junction has.
            expect(plan.cycle).toBeLessThanOrEqual(130);

            const groups = movementGroups(
              net.lanes, net.segments, junction.approaches, junction.connectorIds,
            );
            const green = new Set<number>();
            for (const phase of plan.phases) for (const id of phase.greenLanes) green.add(id);
            for (const group of groups) {
              expect(group.connectorIds.some((id) => green.has(id)), group.label).toBe(true);
            }
          }
        });

        it('carries traffic without losing anybody', () => {
          const { sim, net, lateArrivals, worstWait } =
            drive(planFor(shape.build(), preset), EASY, 7);
          const m = sim.metrics;
          expect(m.collisions).toBe(0);
          expect(m.lost).toBe(0);
          expect(m.mergeFailures).toBe(0);
          expect(m.arrived).toBeGreaterThan(20);
          // Still discharging at the end: a junction that has locked up stops
          // delivering anybody, whatever its average looked like.
          expect(lateArrivals).toBeGreaterThan(0);

          // A wait is measured against the cycle that caused it, because a
          // four-phase plan makes everybody wait longer and that is the deal.
          expect(worstWait).toBeLessThan(longestCycle(net) * 3);
        });

        it('degrades rather than locking when it is given too much traffic', () => {
          const { sim, net, servedGroups, lateArrivals } =
            drive(planFor(shape.build(), preset), HEAVY, 3);
          expect(sim.metrics.collisions).toBe(0);
          expect(sim.metrics.lost).toBe(0);
          expect(lateArrivals).toBeGreaterThan(0);

          // Nobody is starved. This is the run to ask it on: with demand over
          // capacity every movement has somebody waiting to make it, so a group
          // that carried nothing in eight minutes was never given a chance rather
          // than never wanted. On a quiet junction the same check only measures
          // which turns the random demand happened to ask for.
          for (const junction of net.junctions) {
            if (junction.control !== 'signal') continue;
            const groups = movementGroups(
              net.lanes, net.segments, junction.approaches, junction.connectorIds,
            );
            for (const group of groups) expect(servedGroups.has(group.key), group.label).toBe(true);
          }
        });
      });
    }
  }
});

describe('protected left turns', () => {
  /** Ticks a left-turner spent stopped *inside* the junction, per vehicle that entered. */
  function stallsOnLeftTurns(model: EditModel, seconds = 480): { entries: number; stalls: number } {
    const net = compile(model);
    const sim = new Simulation(net, { seed: 7, demandScale: 0.6 });
    const lefts = net.lanes
      .filter((l) => l.kind === LaneKind.Connector && l.turn === TurnKind.Left)
      .map((l) => l.id);
    const seen = new Set<string>();
    let stalls = 0;
    for (let t = 0; t < seconds / 0.05; t++) {
      sim.tick();
      for (const id of lefts) {
        for (let v = sim.store.laneFirst[id]; v >= 0; v = sim.store.behind[v]) {
          if (sim.store.v[v] < 0.5) stalls++;
          seen.add(`${id}:${sim.store.serial[v]}`);
        }
      }
    }
    return { entries: seen.size, stalls };
  }

  for (const name of ['cross-4way', 'cross-4way-wide']) {
    it(`never stops a protected turn inside the junction on ${name}`, () => {
      const shape = signalCases().find((c) => c.name === name)!;
      const permissive = stallsOnLeftTurns(planFor(shape.build(), 'permissive'));
      const guarded = stallsOnLeftTurns(planFor(shape.build(), 'protected'));

      expect(permissive.entries).toBeGreaterThan(20);
      expect(guarded.entries).toBeGreaterThan(20);
      // Permissive is the control: a left turn taken on a gap does sometimes have
      // to wait in the middle of the box, which is exactly the thing a protected
      // phase exists to avoid.
      expect(permissive.stalls).toBeGreaterThan(0);
      expect(guarded.stalls).toBe(0);
    });
  }

  it('reports a protected turn as protected and a permissive one as permissive', () => {
    const shape = signalCases().find((c) => c.name === 'cross-4way')!;
    const guarded = compile(planFor(shape.build(), 'protected'));
    for (const junction of guarded.junctions) {
      if (junction.control !== 'signal') continue;
      for (const phase of junction.signal!.phases) {
        for (const id of phase.greenLanes) {
          expect(protectionOf(guarded.lanes, phase, id)).toBe('protected');
        }
      }
    }

    const open = compile(planFor(shape.build(), 'permissive'));
    const junction = open.junctions.find((j) => j.control === 'signal')!;
    const lefts = junction.signal!.phases.flatMap((phase) =>
      phase.greenLanes
        .filter((id) => open.lanes[id]!.turn === TurnKind.Left)
        .map((id) => protectionOf(open.lanes, phase, id)));
    expect(lefts.length).toBeGreaterThan(0);
    expect(lefts.every((p) => p === 'permissive')).toBe(true);
  });

  it('only gives a left its own phase where there is a bay to hold it', () => {
    const narrow = signalCases().find((c) => c.name === 'cross-narrow')!;
    const net = compile(planFor(narrow.build(), 'protected'));
    const junction = net.junctions.find((j) => j.control === 'signal')!;
    // A single-lane approach has nowhere to put the turners, so a left-only phase
    // would be stopped by the first driver who wanted to go straight. The plan
    // comes out as the permissive one instead.
    for (const approach of junction.approaches) {
      expect(hasLeftBay(net.lanes, approach)).toBe(false);
    }
    const permissive = compile(planFor(narrow.build(), 'permissive'));
    expect(junction.signal!.phases.length)
      .toBe(permissive.junctions.find((j) => j.control === 'signal')!.signal!.phases.length);
  });

  it('leaves a left alone when nothing green would cross it', () => {
    // A T's stem is opposed by nothing: its left conflicts only with the movements
    // on the other axis, which are red while the stem runs. Splitting it out would
    // buy nothing and cost a phase.
    const tee = signalCases().find((c) => c.name === 'tee')!;
    const net = compile(planFor(tee.build(), 'protected'));
    const junction = net.junctions.find((j) => j.control === 'signal')!;
    const axes = 2; // the through road, and the stem
    expect(junction.signal!.phases.length).toBeLessThan(axes * 2);
  });
});

/**
 * Two vehicles on different lanes with their bodies over the same point — driving
 * through each other, which is what a user sees rather than any metric.
 *
 * It went unmeasured for a long time because `collisions` only counted a vehicle
 * overlapping its *leader*, so "zero collisions" meant zero rear-end overlaps and
 * said nothing about a junction. Long vehicles show it up first: a bus needs three
 * times as long to clear the point it is standing on.
 */
describe('vehicles never drive through each other', () => {
  function overlaps(model: EditModel, seconds: number, seed: number): number {
    const net = compile(model);
    const sim = new Simulation(net, { seed, demandScale: 1 });
    const pairs: { a: number; sa: number; b: number; sb: number }[] = [];
    for (const lane of net.lanes) {
      if (lane.kind !== LaneKind.Connector) continue;
      for (const c of lane.conflicts) {
        if (c.other <= lane.id) continue;
        pairs.push({ a: lane.id, sa: c.sSelf, b: c.other, sb: c.sOther });
      }
    }
    const covering = (laneId: number, point: number): boolean => {
      for (let v = sim.store.laneFirst[laneId]; v >= 0; v = sim.store.behind[v]) {
        if (sim.store.s[v] - sim.store.len[v] > point) return false;
        if (sim.store.s[v] >= point) return true;
      }
      return false;
    };
    let hits = 0;
    for (let t = 0; t < seconds / 0.05; t++) {
      sim.tick();
      for (const p of pairs) {
        if (!covering(p.a, p.sa)) continue;
        if (covering(p.b, p.sb)) hits++;
      }
    }
    return hits;
  }

  // The permissive plans are the ones that used to fail: a left turn taken on a
  // gap is the only movement that crosses something else which is also green.
  for (const name of ['cross-4way-wide', 'cross-skew', 'cross-curved', 'five-way']) {
    it(`holds on ${name} with permissive lefts`, () => {
      const shape = signalCases().find((c) => c.name === name)!;
      expect(overlaps(planFor(shape.build(), 'permissive'), 300, 5)).toBe(0);
    });
  }

  it('counts a crossing overlap as a collision, not just a rear-end one', () => {
    // The metric has to see it too, or the scenario suites keep reporting zero
    // while the junction is full of vehicles passing through each other.
    const shape = signalCases().find((c) => c.name === 'cross-4way-wide')!;
    const sim = new Simulation(compile(planFor(shape.build(), 'permissive')), { seed: 5, demandScale: 1 });
    sim.run(300);
    expect(sim.metrics.collisions).toBe(0);
  });
});

/**
 * The kerb-side turn against a red: right where traffic drives on the right.
 *
 * On by default, because that is how the rule works where it exists — permitted
 * everywhere, forbidden by a sign at the junctions that need one. It is the only
 * movement at a signalised junction that is *not* metered by the plan, which is
 * both why it is worth having and why it has to give way to absolutely everything.
 */
describe('turning on red', () => {
  function drive(model: EditModel, on: boolean, seconds = 360) {
    for (const j of model.junctions) j.turnOnRed = on;
    const net = compile(model);
    const sim = new Simulation(net, { seed: 5, demandScale: 1 });
    const rights = net.lanes
      .filter((l) => l.kind === LaneKind.Connector && l.turn === TurnKind.Right)
      .map((l) => l.id);
    const seen = new Set<string>();
    let movedOnRed = 0;
    for (let t = 0; t < seconds / 0.05; t++) {
      sim.tick();
      for (const id of rights) {
        for (let v = sim.store.laneFirst[id]; v >= 0; v = sim.store.behind[v]) {
          const key = `${id}:${sim.store.serial[v]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // *Joining* the connector against a red is the only thing a turn on red
          // can produce. Merely being on one while it goes red is a driver who
          // entered on green and is still clearing — which is what the intergreen
          // is for, and which a slow vehicle does legitimately: one crossed a 10 m
          // connector at 3.4 m/s, taking 3 s against a 1.7 s clearance.
          if (sim.signals.stateOf(id) === 0) movedOnRed++;
        }
      }
    }
    return { sim, turns: seen.size, movedOnRed };
  }

  it('is on unless the document says otherwise', () => {
    const model = signalCases().find((c) => c.name === 'cross-4way')!.build();
    const net = compile(model);
    expect(net.junctions.every((j) => j.turnOnRed)).toBe(true);

    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    model.junctions.push({ x: junction.x, y: junction.y, control: 'signal', turnOnRed: false });
    expect(compile(model).junctions.find((j) => j.kind === 'crossing')!.turnOnRed).toBe(false);
  });

  it('actually moves vehicles through a red, and only kerb-side ones', () => {
    const shape = signalCases().find((c) => c.name === 'cross-4way-wide')!;
    const off = drive(planFor(shape.build(), 'protected'), false);
    const on = drive(planFor(shape.build(), 'protected'), true);
    expect(off.movedOnRed).toBe(0);
    expect(on.movedOnRed).toBeGreaterThan(0);
    expect(on.turns).toBeGreaterThan(off.turns);
  });

  it('buys throughput rather than costing it', () => {
    // A right turn stops being metered by the plan, so the junction gets more out
    // of the same cycle. Measured across the shapes, not asserted on one.
    let better = 0;
    for (const shape of signalCases()) {
      const off = drive(planFor(shape.build(), 'protected'), false, 300);
      const on = drive(planFor(shape.build(), 'protected'), true, 300);
      expect(on.sim.metrics.collisions, shape.name).toBe(0);
      expect(on.sim.metrics.lost, shape.name).toBe(0);
      if (on.sim.metrics.arrived >= off.sim.metrics.arrived) better++;
    }
    expect(better).toBe(signalCases().length);
  });

  it('stays clean where a turn on red outranks what it crosses', () => {
    // The pecking order among movements decides who goes on a *green*; a driver
    // turning against a red has no claim at all, so the rule refuses it the rank
    // shortcut. This is an outcome test rather than a proof of that branch — it
    // first checks such a pair exists on these shapes, or a clean run would only
    // mean the situation never came up.
    for (const name of ['cross-4way-wide', 'five-way', 'tee']) {
      const shape = signalCases().find((c) => c.name === name)!;
      const net = compile(planFor(shape.build(), 'permissive'));
      const outranking = net.lanes.some((lane) =>
        lane.kind === LaneKind.Connector && lane.turn === TurnKind.Right
        && lane.conflicts.some((c) => net.lanes[c.other]!.priorityRank >= lane.priorityRank));
      expect(outranking, `${name} has a right turn that outranks something`).toBe(true);

      const { sim } = drive(planFor(shape.build(), 'permissive'), true, 300);
      expect(sim.metrics.collisions, name).toBe(0);
    }
  });

  it('is only ever taken by a movement that crosses nothing', () => {
    // What makes a turn on red safe is not that it points right but that it *cuts
    // across nobody*: it hugs the kerb and joins the near lane. On an irregular
    // junction a movement classified as a right turn can sweep the whole box — the
    // five-way has one that conflicts with eleven others — and letting that go on
    // red parks it across everybody's green, which is precisely what a driver
    // watching the map complains about.
    for (const name of ['five-way', 'cross-4way-wide', 'cross-skew', 'tee']) {
      const shape = signalCases().find((c) => c.name === name)!;
      const net = compile(planFor(shape.build(), 'permissive'));
      for (const j of net.junctions) j.turnOnRed = true;
      const sim = new Simulation(net, { seed: 5, demandScale: 1 });
      const inside = new Set<number>();
      let crossingTurnsOnRed = 0;
      const conns = net.lanes.filter((l) => l.kind === LaneKind.Connector);
      for (let t = 0; t < 300 / 0.05; t++) {
        sim.tick();
        for (const lane of conns) {
          for (let v = sim.store.laneFirst[lane.id]; v >= 0; v = sim.store.behind[v]) {
            if (inside.has(sim.store.serial[v])) continue;
            inside.add(sim.store.serial[v]);
            if (sim.signals.stateOf(lane.id) !== 0) continue; // entered on green
            // Entered against a red: the movement must cut across nothing.
            const crosses = lane.conflicts.some((c) => c.angle > (20 * Math.PI) / 180);
            if (crosses) crossingTurnsOnRed++;
          }
        }
      }
      expect(crossingTurnsOnRed, `${name}: movements taken on red that cross traffic`).toBe(0);
    }
  });

  it('never leaves a turner parked across a movement that has a green', () => {
    // The permission covers getting *out* as well as in. A driver who takes the
    // turn and then stops halfway across, because the road they turned into was
    // full, is blocking traffic with the right of way — and by then they are
    // committed and cannot give way.
    const shape = signalCases().find((c) => c.name === 'five-way')!;
    const held = (on: boolean): number => {
      const net = compile(planFor(shape.build(), 'permissive'));
      for (const j of net.junctions) j.turnOnRed = on;
      const sim = new Simulation(net, { seed: 5, demandScale: 1 });
      const conns = net.lanes.filter((l) => l.kind === LaneKind.Connector);
      let blocked = 0;
      for (let t = 0; t < 300 / 0.05; t++) {
        sim.tick();
        for (const lane of conns) {
          if (sim.signals.stateOf(lane.id) !== 1) continue; // only green movements
          for (let v = sim.store.laneFirst[lane.id]; v >= 0; v = sim.store.behind[v]) {
            if (sim.store.v[v] > 1.5) continue;
            // Is a vehicle on a *red* conflicting movement sitting over our point?
            for (const c of lane.conflicts) {
              if (sim.signals.stateOf(c.other) !== 0) continue;
              for (let r = sim.store.laneFirst[c.other]; r >= 0; r = sim.store.behind[r]) {
                if (sim.store.s[r] - sim.store.len[r] > c.sOther) break;
                if (sim.store.s[r] >= c.sOther) { blocked++; break; }
              }
            }
          }
        }
      }
      return blocked * 0.05;
    };
    // With the rules right, turning on red adds no blocking at all on the shape
    // that used to be worst: eighteen vehicle-seconds of it in five minutes.
    expect(held(true)).toBeLessThanOrEqual(held(false) + 1);
  });

  it('makes a driver come to a stop first', () => {
    // Not a rolling turn: the vehicle has to be stationary at the line before it
    // may go, which is the whole difference between turning on red and running it.
    const shape = signalCases().find((c) => c.name === 'cross-4way')!;
    const net = compile(planFor(shape.build(), 'protected'));
    const sim = new Simulation(net, { seed: 9, demandScale: 1 });
    const rights = new Set(net.lanes
      .filter((l) => l.kind === LaneKind.Connector && l.turn === TurnKind.Right)
      .map((l) => l.id));
    // Fastest anybody was doing at the moment they entered a red kerb-side turn.
    let fastestEntry = 0;
    let entries = 0;
    const inside = new Set<number>();
    for (let t = 0; t < 300 / 0.05; t++) {
      sim.tick();
      for (const id of rights) {
        for (let v = sim.store.laneFirst[id]; v >= 0; v = sim.store.behind[v]) {
          if (inside.has(sim.store.serial[v])) continue;
          inside.add(sim.store.serial[v]);
          if (sim.signals.stateOf(id) !== 0) continue;
          entries++;
          fastestEntry = Math.max(fastestEntry, sim.store.v[v]);
        }
      }
    }
    expect(entries).toBeGreaterThan(0);
    // Pulling away from a standstill over one connector length, not driving through.
    expect(fastestEntry).toBeLessThan(4);
  });
});

describe('a hand-authored plan', () => {
  function fourWay(): EditModel {
    return signalCases().find((c) => c.name === 'cross-4way')!.build();
  }

  it('is what the compiler runs, even where it would have signalised anyway', () => {
    const model = planFor(fourWay(), 'split');
    const net = compile(model);
    const junction = net.junctions.find((j) => j.control === 'signal')!;
    expect(junction.signal!.source).toBe('custom');
    expect(junction.signal!.phases.length).toBe(junction.approaches.length);
  });

  it('survives a recompile, because movements are named and not numbered', () => {
    const model = planFor(fourWay(), 'protected');
    const before = compile(model).junctions.find((j) => j.control === 'signal')!.signal!;
    // Widen one of the roads: every lane id and connector id changes.
    model.profiles.find((p) => p.name === 'art2')!.lanesForward = 3;
    const after = compile(model).junctions.find((j) => j.control === 'signal')!.signal!;
    expect(after.source).toBe('custom');
    expect(after.phases.map((p) => p.groups)).toEqual(before.phases.map((p) => p.groups));
    for (const phase of after.phases) expect(phase.greenLanes.length).toBeGreaterThan(0);
  });

  it('says so when a phase greens two streams that cross head-on', () => {
    const model = fourWay();
    const net = compile(model);
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const groups = movementGroups(net.lanes, net.segments, junction.approaches, junction.connectorIds);
    const through = groups.filter((g) => g.letter === 'S').map((g) => g.key);
    model.junctions.push({
      x: junction.x, y: junction.y, control: 'signal',
      signal: { offset: 0, phases: [{ groups: through, green: 30, amber: 3.5, allRed: 1.5 }] },
    });
    const broken = compile(model);
    expect(broken.diagnostics.some((d) => d.code === 'signal-phase-conflict')).toBe(true);
  });

  it('says so when a movement never gets a green', () => {
    const model = fourWay();
    const net = compile(model);
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const groups = movementGroups(net.lanes, net.segments, junction.approaches, junction.connectorIds);
    model.junctions.push({
      x: junction.x, y: junction.y, control: 'signal',
      signal: { offset: 0, phases: [{ groups: [groups[0]!.key], green: 30, amber: 3.5, allRed: 1.5 }] },
    });
    const starved = compile(model);
    expect(starved.diagnostics.filter((d) => d.code === 'signal-movement-never-green').length)
      .toBe(groups.length - 1);
  });

  it('runs the same way twice', () => {
    const model = planFor(fourWay(), 'protected');
    const hash = (): string => {
      const sim = new Simulation(compile(model), { seed: 21, demandScale: 0.8 });
      sim.run(240);
      return hashHex(sim);
    };
    expect(hash()).toBe(hash());
  });

  it('gives different plans different traffic', () => {
    const shape = signalCases().find((c) => c.name === 'cross-4way')!;
    const runFor = (preset: SignalPreset): string => {
      const sim = new Simulation(compile(planFor(shape.build(), preset)), { seed: 21, demandScale: 0.8 });
      sim.run(240);
      return hashHex(sim);
    };
    expect(runFor('permissive')).not.toBe(runFor('protected'));
  });
});

/**
 * The offset, and the one thing it is for.
 *
 * It was persisted, exposed and completely ignored — `SignalController.reset` set
 * every junction to the start of phase one whatever the plan said. A green wave is
 * the only reason to have the number at all, so a test that does not drive a
 * platoon down a corridor is not testing it.
 */
describe('signal offsets', () => {
  /** Three signals in a row on one arterial, 400 m apart. */
  function corridorDoc(): EditModel {
    const model = doc();
    const arterial = addProfile(model, {
      name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      median: 2.4, shoulder: 0.8, speedLimit: kph(50),
    });
    const cross = addProfile(model, {
      name: 'cross', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      median: 2.4, shoulder: 0.8, speedLimit: kph(50),
    });
    addStroke(model, arterial, line(-400, 0, 1600, 0));
    for (const x of [0, 400, 800]) addStroke(model, cross, line(x, -320, x, 320));
    return model;
  }

  it('starts a junction where its offset says, not at phase one', () => {
    const model = corridorDoc();
    const net = compile(model);
    const junctions = net.junctions.filter((j) => j.control === 'signal');
    expect(junctions.length).toBeGreaterThanOrEqual(2);
    const target = junctions[1]!;
    const groups = movementGroups(net.lanes, net.segments, target.approaches, target.connectorIds);
    const phases = presetPhases('permissive', groups, target.approaches, net.lanes);

    const stateAt = (offset: number): number[] => {
      const m = corridorDoc();
      const at = compile(m).junctions.find((j) => j.control === 'signal'
        && Math.hypot(j.x - target.x, j.y - target.y) < 1)!;
      m.junctions.push({ x: at.x, y: at.y, control: 'signal', signal: { offset, phases } });
      const built = compile(m);
      const sim = new Simulation(built, { seed: 1, demandScale: 0 });
      const j = built.junctions.find((x) => Math.hypot(x.x - at.x, x.y - at.y) < 1)!;
      return [sim.signals.currentPhase(j.id), Math.round(sim.signals.remaining(j.id))];
    };

    const first = phases[0]!;
    const cycle = phases.reduce((a, p) => a + p.green + p.amber + p.allRed, 0);
    // Unwound, a junction starts at the top of its first green.
    expect(stateAt(0)).toEqual([0, Math.round(first.green)]);
    // Part way into that green, it starts part way in.
    expect(stateAt(first.green / 2)).toEqual([0, Math.round(first.green / 2)]);
    // Past the whole of phase one — green, amber and the clearance — it is in the
    // second phase, five seconds deep.
    expect(stateAt(first.green + first.amber + first.allRed + 5))
      .toEqual([1, Math.round(phases[1]!.green - 5)]);
    // And a whole cycle round is exactly where it started.
    expect(stateAt(cycle)).toEqual(stateAt(0));
  });

  it('offsets a corridor by the time it takes to drive it', () => {
    const net = compile(corridorDoc());
    const first = net.junctions.filter((j) => j.control === 'signal')
      .sort((a, b) => a.x - b.x)[0]!;
    const stops = corridor(net, first, 13.9);
    expect(stops.length).toBe(3);
    expect(stops[0]!.offset).toBe(0);
    // 400 m at 13.9 m/s is about 29 s, and each stop is one more of them.
    expect(stops[1]!.offset).toBeCloseTo(400 / 13.9, 0);
    expect(stops[2]!.offset).toBeCloseTo(800 / 13.9, 0);
    expect(stops[1]!.distance).toBeCloseTo(400, 0);
  });

  it('gets a platoon further down the road than no offsets at all', () => {
    // The measurement that matters: drive traffic along the arterial and count how
    // much of it gets through all three junctions. A wave should beat signals that
    // all change together.
    const run = (wave: boolean): number => {
      const model = corridorDoc();
      const net0 = compile(model);
      const stops = corridor(net0, net0.junctions.filter((j) => j.control === 'signal')
        .sort((a, b) => a.x - b.x)[0]!, 13.9);
      for (const stop of stops) {
        const j = net0.junctions[stop.junctionId]!;
        const groups = movementGroups(net0.lanes, net0.segments, j.approaches, j.connectorIds);
        model.junctions.push({
          x: j.x, y: j.y, control: 'signal',
          signal: {
            offset: wave ? stop.offset : 0,
            phases: presetPhases('permissive', groups, j.approaches, net0.lanes),
          },
        });
      }
      const net = compile(model);
      const west = net.portals.find((p) => p.entryLanes.length && p.x < -300)!;
      const east = net.portals.find((p) => p.exitLanes.length && p.x > 1500)!;
      const sim = new Simulation(net, {
        seed: 6, demandScale: 1,
        demand: [{ fromPortal: west.id, toPortal: east.id, rate: 900 }],
      });
      sim.run(900);
      return sim.metrics.totalTravel / Math.max(1, sim.metrics.arrived);
    };
    const together = run(false);
    const waved = run(true);
    // Mean journey time along the corridor, which is what a wave shortens.
    expect(waved).toBeLessThan(together);
  });
});

describe('preset generation', () => {
  it('gives every arm its own phase under split phasing, whatever the shape', () => {
    for (const shape of signalCases()) {
      const net = compile(shape.build());
      for (const junction of net.junctions) {
        if (junction.kind !== 'crossing') continue;
        const groups = movementGroups(
          net.lanes, net.segments, junction.approaches, junction.connectorIds,
        );
        const phases = presetPhases('split', groups, junction.approaches, net.lanes);
        const live = junction.approaches.filter((a) => a.incomingLanes.length > 0).length;
        expect(phases.filter((p) => p.groups.length).length, shape.name).toBe(live);
        // No phase may hold two arms, which is what makes split phasing the plan
        // that works on geometry nothing else can be trusted with.
        for (const phase of phases) {
          const arms = new Set(
            phase.groups.map((k) => groups.find((g) => g.key === k)?.approachIndex),
          );
          expect(arms.size, shape.name).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
