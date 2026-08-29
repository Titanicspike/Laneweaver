/**
 * Dev-only: where an imported city's collisions happen, and what kind of place it is.
 *
 *   npx tsx scratch/osmcollide.ts la-interchange [seconds]
 *
 * Collisions on imported data are almost never one bug. This groups them by the
 * junction they happen at and says what that junction is — its kind, its control, how
 * many arms, how fast the roads are — because the answer to "why does this city
 * collide" is usually a *kind* of junction rather than a place.
 */

import { readFileSync } from 'node:fs';
import { compile } from '../src/core/network/compiler';
import { importOsm } from '../src/core/osm/import';
import { Simulation } from '../src/core/sim/sim';
import { LaneKind } from '../src/core/network/types';
import type { Junction, Lane, Network } from '../src/core/network/types';

const place = process.argv[2] ?? 'la-interchange';
const seconds = Number(process.argv[3] ?? 120);
const { model } = importOsm(JSON.parse(
  readFileSync(new URL(`./osm/${place}.json`, import.meta.url), 'utf8')));
const net = compile(model);
const sim = new Simulation(net, { seed: 3, demandScale: 1, spawnMode: model.settings.spawnMode });
const S = sim.store;

/** Conflict pairs, the way the sim counts a crossing collision. */
const pairs: { a: number; b: number; sa: number; sb: number }[] = [];
for (const l of net.lanes) {
  for (const c of l.conflicts) if (l.id < c.other) {
    pairs.push({ a: l.id, b: c.other, sa: c.sSelf, sb: c.sOther });
  }
}
const bodyOver = (laneId: number, s: number): number => {
  for (let v = S.laneFirst[laneId]; v >= 0; v = S.behind[v]) {
    if (S.s[v] - S.len[v] > s) return -1;
    if (S.s[v] >= s) return v;
  }
  return -1;
};
const junctionOf = (laneId: number): Junction | undefined =>
  net.junctions.find((j) => j.connectorIds.includes(laneId));

interface Site { n: number; what: string }
const sites = new Map<string, Site>();
const seen = new Set<string>();
const note = (key: string, what: string): void => {
  const s = sites.get(key) ?? { n: 0, what };
  s.n++;
  sites.set(key, s);
};

const describe = (j: Junction | undefined, a: Lane, b: Lane): string => {
  if (!j) return 'no junction (rear-end on a road)';
  const arms = j.approaches.length;
  const fastest = Math.max(...j.approaches.map((ap) => {
    const lanes = [...ap.incomingLanes, ...ap.outgoingLanes].map((id) => net.lanes[id]);
    return Math.max(0, ...lanes.map((l) => l.speedLimit));
  }));
  const slowest = Math.min(...j.approaches.map((ap) => {
    const lanes = [...ap.incomingLanes, ...ap.outgoingLanes].map((id) => net.lanes[id]);
    return Math.min(Infinity, ...lanes.map((l) => l.speedLimit));
  }));
  return `${j.kind}/${j.control} ${arms} arms, ${(fastest * 3.6).toFixed(0)}↔${(slowest * 3.6).toFixed(0)} km/h`
    + `, turns ${a.turn}/${b.turn}`;
};

for (let t = 0; t < seconds / 0.05; t++) {
  sim.tick();
  for (const p of pairs) {
    const a = bodyOver(p.a, p.sa); if (a < 0) continue;
    const b = bodyOver(p.b, p.sb); if (b < 0) continue;
    const key = `X${S.serial[a]}:${S.serial[b]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const la = net.lanes[p.a], lb = net.lanes[p.b];
    const j = junctionOf(p.a) ?? junctionOf(p.b);
    note(`${j ? `${j.x.toFixed(0)},${j.y.toFixed(0)}` : '?'}`, describe(j, la, lb));
  }
  for (const l of net.lanes) {
    for (let v = S.laneFirst[l.id]; v >= 0; v = S.behind[v]) {
      const lead = S.ahead[v];
      if (lead < 0) continue;
      if (S.s[lead] - S.s[v] - S.len[lead] >= 0) continue;
      const key = `R${S.serial[lead]}:${S.serial[v]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const j = l.kind === LaneKind.Connector ? junctionOf(l.id) : undefined;
      note(`rear-end ${l.kind === LaneKind.Connector ? 'on a connector' : 'on a road'}`,
        j ? describe(j, l, l) : `${l.kind === LaneKind.Connector ? 'connector' : 'road'}`
          + ` limit ${(l.speedLimit * 3.6).toFixed(0)} km/h aux ${l.aux}`);
    }
  }
}

console.log(`${place}: ${sim.metrics.collisions} collisions in ${seconds} s`
  + ` (${sim.store.count} vehicles, ${sim.metrics.arrived} arrived, ${sim.metrics.lost} lost)`);
for (const [key, s] of [...sites].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`  ${String(s.n).padStart(3)}x  ${key.padEnd(22)} ${s.what}`);
}
