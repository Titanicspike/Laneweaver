/**
 * Determinism is a hard requirement, not a nice-to-have: the merge acceptance
 * metrics and the golden hashes below are only meaningful if the same seed always
 * produces the same run.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { hashHex } from '@core/sim/hash';
import { onRampScenario, weaveScenario, type ScenarioNet } from '../helpers/scenarios';
import { addProfile, addStroke, doc, line, profileNamed } from '../helpers/build';

function gridDoc() {
  const model = doc();
  const arterial = addProfile(model, {
    name: 'A4', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2,
  });
  const street = profileNamed(model, 'Collector 2-lane');
  for (let i = 0; i < 3; i++) {
    addStroke(model, i === 1 ? arterial : street, line(-500, i * 250 - 250, 500, i * 250 - 250));
    addStroke(model, i === 1 ? arterial : street, line(i * 250 - 250, -500, i * 250 - 250, 500));
  }
  return model;
}

function runHash(build: () => ScenarioNet, seed: number, seconds: number): string {
  const sc = build();
  const sim = new Simulation(sc.net, { seed, demand: sc.model.demand });
  sim.run(seconds);
  return hashHex(sim);
}

describe('determinism', () => {
  it('reproduces an on-ramp run exactly', () => {
    const build = () => onRampScenario({ mainLanes: 3, mainFlow: 1800, rampFlow: 500 });
    const a = runHash(build, 42, 180);
    const b = runHash(build, 42, 180);
    expect(a).toBe(b);
  });

  it('produces a different run for a different seed', () => {
    const build = () => onRampScenario({ mainLanes: 3, mainFlow: 1800, rampFlow: 500 });
    expect(runHash(build, 42, 180)).not.toBe(runHash(build, 43, 180));
  });

  it('reproduces a weaving run exactly', () => {
    const build = () => weaveScenario({});
    expect(runHash(build, 7, 150)).toBe(runHash(build, 7, 150));
  });

  it('reproduces a signalised grid exactly', () => {
    const model = gridDoc();
    const net = compile(model);
    expect(net.junctions.length).toBeGreaterThan(0);
    const a = new Simulation(net, { seed: 9, demandScale: 1 });
    a.run(180);
    const b = new Simulation(net, { seed: 9, demandScale: 1 });
    b.run(180);
    expect(hashHex(a)).toBe(hashHex(b));
  });

  it('recompiling the same document gives an identical network', () => {
    const model = gridDoc();
    const a = compile(model);
    const b = compile(model);
    expect(a.lanes.length).toBe(b.lanes.length);
    expect(a.junctions.length).toBe(b.junctions.length);
    for (let i = 0; i < a.lanes.length; i++) {
      expect(Array.from(a.lanes[i].centerline)).toEqual(Array.from(b.lanes[i].centerline));
      expect(a.lanes[i].successors).toEqual(b.lanes[i].successors);
      expect(a.lanes[i].priorityRank).toBe(b.lanes[i].priorityRank);
    }
  });

  it('is stable when the simulation is stepped in different chunk sizes', () => {
    const sc = onRampScenario({ mainLanes: 2, mainFlow: 2000, rampFlow: 700 });
    const a = new Simulation(sc.net, { seed: 5, demand: sc.model.demand });
    a.run(120);
    const b = new Simulation(sc.net, { seed: 5, demand: sc.model.demand });
    for (let i = 0; i < 12; i++) b.run(10);
    expect(hashHex(a)).toBe(hashHex(b));
  });
});
