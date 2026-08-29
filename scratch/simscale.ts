/**
 * Dev-only: which pass costs what, as the imported area grows.
 *
 *   npx tsx scratch/simscale.ts
 *
 * The tick budget is asserted on one synthetic freeway network of a fixed size, so
 * nothing in `npm run bench` notices a cost that scales with the *network* rather
 * than with the traffic on it. This does: the same city at two, three and four
 * miles, with `sim.timings` broken out. A pass whose number grows faster than the
 * vehicle count is doing something per-lane or per-portal, and on a city that is
 * the difference between 0.4 ms and 47.
import { readFileSync } from 'node:fs';
import { compile } from '../src/core/network/compiler';
import { importOsm } from '../src/core/osm/import';
import { Simulation } from '../src/core/sim/sim';
import { LaneKind } from '../src/core/network/types';

for (const id of ['cupertino', 'cupertino-3mi', 'cupertino-4mi']) {
  const { model } = importOsm(JSON.parse(
    readFileSync(new URL(`./osm/${id}.json`, import.meta.url), 'utf8')));
  const net = compile(model);
  const sim = new Simulation(net, { seed: 3, demandScale: 1, spawnMode: model.settings.spawnMode });
  sim.run(60);
  const totals: Record<string, number> = {};
  const t0 = Date.now();
  const N = 600;
  for (let i = 0; i < N; i++) {
    sim.tick();
    for (const [k, v] of Object.entries(sim.timings)) totals[k] = (totals[k] ?? 0) + (v as number);
  }
  const ms = (Date.now() - t0) / N;
  const roads = net.lanes.filter((l) => l.kind === LaneKind.Road).length;
  const parts = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k} ${(v / N).toFixed(2)}`);
  console.log(`${id.padEnd(15)} ${roads} road lanes, ${net.lanes.length - roads} connectors,`
    + ` ${net.portals.length} portals, ${sim.store.count} vehicles`);
  console.log(`  tick ${ms.toFixed(2)} ms  |  ${parts.join('  ')}`);
}
