/**
 * Dev-only: every intersection shape in the zoo, under every signal plan.
 *
 * Prints what the plan actually does — throughput, mean speed, the worst wait any
 * driver had, and whether anybody was starved. Run it before touching the signal
 * model; the numbers are what `test/scenarios/signals.test.ts` asserts on.
 */

import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import {
  movementGroups, presetPhases, type SignalPreset,
} from '../src/core/network/compiler/signals';
import type { EditModel } from '../src/core/network/types';
import { signalCases, planFor } from './signalCases';

const PRESETS: SignalPreset[] = ['permissive', 'protected', 'split'];
const MINUTES = Number(process.argv[3] ?? 6);
const DEMAND = Number(process.argv[4] ?? 1);
const only = process.argv[2] && !/^\d/.test(process.argv[2]) ? process.argv[2] : null;

function run(model: EditModel, seconds: number, seed: number, demandScale: number) {
  const net = compile(model);
  const sim = new Simulation(net, { seed, demandScale });
  // Every connector a vehicle has actually been seen on. A movement that never
  // gets a green is not unreachable, just never served, so no other metric catches
  // it — the queue simply grows for ten minutes and nothing says why.
  const used = new Set<number>();
  const connectors = net.lanes.filter((l) => l.kind === 1).map((l) => l.id);
  const step = 5;
  for (let t = 0; t < seconds; t += step) {
    sim.run(step);
    for (const id of connectors) if (sim.store.laneFirst[id] >= 0) used.add(id);
  }
  const m = sim.metrics;
  let worstWait = 0;
  for (let i = 0; i < sim.store.capacity; i++) {
    if (sim.store.alive[i]) worstWait = Math.max(worstWait, sim.store.waitTime[i]);
  }
  const errors = net.diagnostics.filter((d) => d.severity === 'error');
  return { net, sim, m, worstWait, errors, starved: connectors.length - used.size };
}

console.log(
  'case'.padEnd(22) + 'plan'.padEnd(12) + 'arrived  mean  worstWait  coll lost stall  unused  diag',
);
for (const c of signalCases()) {
  if (only && !c.name.includes(only)) continue;
  for (const preset of PRESETS) {
    const model = planFor(c.build(), preset);
    const { net, m, worstWait, errors, starved } = run(model, MINUTES * 60, 7, DEMAND);
    const signalled = net.junctions.filter((j) => j.control === 'signal');
    const groups = signalled
      .map((j) => movementGroups(net.lanes, net.segments, j.approaches, j.connectorIds).length);
    const cycles = signalled.map((j) => `${j.signal!.phases.length}p/${j.signal!.cycle.toFixed(0)}s`);
    void presetPhases;
    console.log(
      c.name.padEnd(22) + preset.padEnd(12)
      + String(m.arrived).padStart(7)
      + m.meanSpeed.toFixed(1).padStart(6)
      + worstWait.toFixed(0).padStart(11)
      + String(m.collisions).padStart(6)
      + String(m.lost).padStart(5)
      + String(m.stalled).padStart(6)
      + String(starved).padStart(8)
      + `   ${cycles.join(' ')}  ${groups.join('/')} grp`
      + `${errors.length ? ` !${errors.map((d) => d.code).join(',')}` : ''}`,
    );
  }
}
