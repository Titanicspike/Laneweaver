/** Dev-only: run every case and report anything the sim is unhappy about. */
import { cases } from './cases';
import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';

let bad = 0;
for (const c of cases()) {
  const net = compile(c.model);
  if (!net.portals.length) continue;
  const sim = new Simulation(net, { seed: 11, demandScale: Number(process.argv[2] ?? 1) });
  sim.run(240);
  const m = sim.metrics as Record<string, number>;
  const stopped = Number(m.stopped ?? 0);
  const parts = Object.entries(m)
    .filter(([k]) => /collision|lost|stalled|missed/i.test(k))
    .map(([k, v]) => `${k}=${v}`);
  const trouble = parts.some(([, ]) => false)
    || Number(m.collisions ?? 0) > 0 || Number(m.lost ?? 0) > 0;
  if (trouble) bad++;
  console.log(`${c.name.padEnd(26)} veh=${String(sim.vehicleCount).padStart(4)}`
    + ` mean=${(Number(m.meanSpeed ?? 0)).toFixed(1)} m/s  ${parts.join(' ')}`
    + (stopped > 0 ? '' : ''));
}
console.log(bad ? `--- ${bad} cases in trouble ---` : '--- all cases clean ---');
