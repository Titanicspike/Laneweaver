/**
 * Dev-only: junctions the compiler invented that OSM does not have.
 *
 * In OSM two ways that cross without sharing a node are grade-separated - that is
 * the data model, not a convention. A junction built where there is no shared node
 * is a road connected to a road it flies over.
 */
import { readFileSync, existsSync } from 'node:fs';
import { compile } from '../src/core/network/compiler';
import { importOsm } from '../src/core/osm/import';
import { PLACES } from './osmPlaces';

for (const place of PLACES) {
  const f = new URL(`./osm/${place.id}.json`, import.meta.url);
  if (!existsSync(f)) continue;
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  const { model, source } = importOsm(raw);
  const net = compile(model);

  // Every node of every way, with its position, and which ways use it.
  const wayNodes = new Map<number, Set<number>>();   // way id -> node ids
  const nodePos = new Map<number, { lat: number; lon: number }>();
  for (const el of raw.elements) {
    if (el.type !== 'way' || !el.nodes) continue;
    wayNodes.set(el.id, new Set(el.nodes));
    if (el.geometry) {
      el.nodes.forEach((n: number, i: number) => {
        const g = el.geometry[i];
        if (g) nodePos.set(n, g);
      });
    }
  }
  const wayOf = (strokeId: number): number | undefined => source.get(strokeId);

  let checked = 0, invented = 0;
  const worst: string[] = [];
  for (const j of net.junctions) {
    if (j.kind !== 'crossing') continue;
    const ways = new Set<number>();
    for (const ap of j.approaches) {
      const seg = net.segments[ap.segmentId];
      const w = wayOf(seg?.strokeId ?? -1);
      if (w !== undefined) ways.add(w);
    }
    if (ways.size < 2) continue;
    checked++;
    // Do any two of the ways meeting here share a node?
    const list = [...ways];
    let shares = false;
    outer: for (let a = 0; a < list.length && !shares; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = wayNodes.get(list[a]), B = wayNodes.get(list[b]);
        if (!A || !B) continue;
        for (const n of A) if (B.has(n)) { shares = true; break outer; }
      }
    }
    if (shares) continue;
    invented++;
    if (worst.length < 3) {
      const speeds = j.approaches.map((ap) => {
        const ls = [...ap.incomingLanes, ...ap.outgoingLanes].map((id) => net.lanes[id].speedLimit);
        return ls.length ? Math.round(Math.max(...ls) * 3.6) : 0;
      });
      worst.push(`(${j.x.toFixed(0)},${j.y.toFixed(0)}) ${j.approaches.length} arms ${speeds.join('/')} km/h`);
    }
  }
  console.log(`${place.id.padEnd(16)} ${checked} multi-way crossings  |  no shared node: ${invented}`
    + ` (${(100 * invented / Math.max(1, checked)).toFixed(1)}%)  ${worst.join('  ')}`);
}
