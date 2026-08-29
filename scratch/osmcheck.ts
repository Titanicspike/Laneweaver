/**
 * Dev-only: import every cached place, compile it, audit it, and drive traffic on it.
 *
 *   npx tsx scratch/osmcheck.ts             # every cached place
 *   npx tsx scratch/osmcheck.ts cupertino   # one
 *   npx tsx scratch/osmcheck.ts --sim 120   # longer run
 *   npx tsx scratch/osmcheck.ts --audit     # geometry audit too (slow)
 *
 * The point is the failure modes an import has that a hand-drawn document does not:
 * ten thousand ways nobody checked, tagged by strangers, meeting at angles nobody
 * would draw. Every number here is one somebody has to look at before believing a
 * city imported cleanly.
 */

import { readFileSync, existsSync } from 'node:fs';
import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import { importOsm } from '../src/core/osm/import';
import { LaneKind } from '../src/core/network/types';
import type { Network } from '../src/core/network/types';
import { PLACES, placeById, type Place } from './osmPlaces';
import { auditModel } from './audit';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const simSeconds = flag('sim', 60);
const wantAudit = args.includes('--audit');
const named = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

function fileFor(place: Place): URL {
  return new URL(`./osm/${place.id}.json`, import.meta.url);
}

/** Lanes that lead nowhere and are not an edge of the map. */
function strandedLanes(net: Network): number {
  let n = 0;
  for (const lane of net.lanes) {
    if (lane.kind !== LaneKind.Road) continue;
    if (lane.successors.length || lane.endsAt < Infinity) continue;
    if (net.portals.some((p) => p.exitLanes.includes(lane.id))) continue;
    n++;
  }
  return n;
}

interface Row {
  place: string;
  ok: boolean;
  note: string;
}

const rows: Row[] = [];
const wanted = named.length
  ? named.map((id) => placeById(id)).filter((p): p is Place => !!p)
  : PLACES;

for (const place of wanted) {
  const file = fileFor(place);
  if (!existsSync(file)) { console.log(`${place.id.padEnd(16)} not cached`); continue; }
  const raw = JSON.parse(readFileSync(file, 'utf8'));

  let line = place.id.padEnd(16);
  try {
    const { model, report } = importOsm(raw);
    const t0 = Date.now();
    const net = compile(model);
    const compileMs = Date.now() - t0;

    const errors = net.diagnostics.filter((d) => d.severity === 'error');
    const warnings = net.diagnostics.filter((d) => d.severity === 'warning');
    const stranded = strandedLanes(net);

    const t1 = Date.now();
    const sim = new Simulation(net, {
      seed: 3, demandScale: 1, spawnMode: model.settings.spawnMode,
    });
    sim.run(simSeconds);
    const simMs = Date.now() - t1;
    const m = sim.metrics;

    const kmLane = net.lanes.reduce((s, l) => s + l.length, 0) / 1000;
    line += `${String(report.imported).padStart(5)} ways `
      + `${String(net.segments.length).padStart(5)} seg `
      + `${String(net.junctions.length).padStart(5)} jn `
      + `${report.profiles.toString().padStart(3)} prof `
      + `${(report.vertices / Math.max(1, report.controlPoints)).toFixed(1)}x fit `
      + `| import ${String(report.ms).padStart(4)} ms compile ${String(compileMs).padStart(5)} ms `
      + `| ${kmLane.toFixed(0)} km lane `
      + `| err ${errors.length} warn ${warnings.length} stranded ${stranded} `
      + `| sim ${String(simMs).padStart(4)} ms veh ${String(m.vehicles).padStart(4)} `
      + `arr ${String(m.arrived).padStart(4)} lost ${m.lost} coll ${m.collisions}`;
    if (wantAudit) {
      const findings = auditModel(place.id, model);
      line += ` | audit ${findings.length}`;
    }
    const ok = errors.length === 0 && m.lost === 0 && m.collisions === 0;
    rows.push({ place: place.id, ok, note: '' });
    console.log(line);
    const byCode = new Map<string, number>();
    for (const d of net.diagnostics) {
      if (d.severity === 'info') continue;
      byCode.set(`${d.severity} ${d.code}`, (byCode.get(`${d.severity} ${d.code}`) ?? 0) + 1);
    }
    const top = [...byCode].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length) console.log(`                 ${top.map(([k, v]) => `${k} x${v}`).join(', ')}`);
  } catch (err) {
    rows.push({ place: place.id, ok: false, note: (err as Error).message });
    console.log(`${line}THREW ${(err as Error).message}`);
    const stack = (err as Error).stack?.split('\n').slice(1, 4).join('\n') ?? '';
    console.log(stack);
  }
}

const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - bad.length}/${rows.length} places clean`
  + (bad.length ? `; problems: ${bad.map((b) => b.place).join(', ')}` : ''));
