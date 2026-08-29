/**
 * Dev-only: emergency braking in a vehicle's first seconds, and what caused it.
 *
 *   npx tsx scratch/spawncheck.ts
 *
 * A driver who has been travelling arrives at a queue, or at slower road, with the
 * whole approach behind them to slow down in. One that is *created* at the edge of
 * the network does not, and no car-following model can undo a vehicle placed
 * somewhere it could never have reached at that speed — it is at the emergency cap
 * from its first tick and stays there until it hits something.
 *
 * The hold tag says who is responsible, which is the whole point of printing it:
 * `leader` and `speedlimit` are the spawner's business, `gapfollow` is the merge
 * model's, and `junction` is a signal or a conflict. Only the first two are fixed
 * by choosing a better entry speed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { compile } from '../src/core/network/compiler';
import { importOsm } from '../src/core/osm/import';
import { Simulation } from '../src/core/sim/sim';
import type { EditModel } from '../src/core/network/types';
import { PLACES } from './osmPlaces';
import { cases } from './cases';

const HOLD = ['free', 'leader', 'speedlimit', 'softwall', 'gapfollow', 'cooperate', 'junction'];

function run(name: string, model: EditModel, seconds: number): void {
  const net = compile(model);
  const sim = new Simulation(net, { seed: 3, demandScale: 1, spawnMode: model.settings.spawnMode });
  const S = sim.store;
  const by = new Map<string, number>();
  let young = 0, spawned = 0;
  const seen = new Set<number>();
  for (let t = 0; t < seconds / 0.05; t++) {
    sim.tick();
    for (let i = 0; i < S.capacity; i++) {
      if (S.lane[i] < 0 || S.age[i] > 3 || S.a[i] > -5.95) continue;
      if (seen.has(S.serial[i])) continue;
      seen.add(S.serial[i]);
      young++;
      const k = HOLD[S.hold[i]] ?? String(S.hold[i]);
      by.set(k, (by.get(k) ?? 0) + 1);
    }
  }
  spawned = sim.metrics.spawned;
  if (!young) { console.log(`${name.padEnd(18)} ${String(spawned).padStart(5)} spawned  none`); return; }
  console.log(`${name.padEnd(18)} ${String(spawned).padStart(5)} spawned  ${young} at the cap when young`
    + ` (${(100 * young / Math.max(1, spawned)).toFixed(1)}%)  ${[...by].map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

console.log('--- example maps ---');
for (const c of cases()) if (c.name.startsWith('example') || c.name === 'demo-document') run(c.name, c.model, 120);
console.log('--- imported ---');
for (const p of PLACES.slice(0, 6)) {
  const f = new URL(`./osm/${p.id}.json`, import.meta.url);
  if (existsSync(f)) run(p.id, importOsm(JSON.parse(readFileSync(f, 'utf8'))).model, 120);
}
