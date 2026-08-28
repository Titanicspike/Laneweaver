/**
 * Dev-only stress test for zoning, buildings and the clock.
 *
 * Builds a town far larger than any example, zones all of it, and checks the two
 * things that are silent when they go wrong: the geometry (nothing standing on a
 * road, nothing inside anything else) and a full day of its own traffic (nothing
 * lost, nothing colliding, nothing gridlocked at the peak).
 *
 * `npx tsx scratch/townstress.ts [blocks] [demand]`
 */

import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import { layoutBuildings, type Plot } from '../src/render/buildings';
import {
  autoSmoothHandles, createDocument, issueId, kph, makeControlPoint,
} from '../src/core/network/model';
import type { ControlPoint, EditModel, Network, RoadProfile } from '../src/core/network/types';
import { formatClock } from '../src/core/sim/clock';

const BLOCKS = Number(process.argv[2] ?? 7);
const DEMAND = Number(process.argv[3] ?? 1);
const BLOCK = 420;

function line(x0: number, y0: number, x1: number, y1: number, n = 2): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(makeControlPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
  }
  autoSmoothHandles(out);
  return out;
}

function bigTown(): EditModel {
  const m = createDocument(4242);
  const mk = (spec: Partial<RoadProfile> & { name: string }): RoadProfile => {
    const p: RoadProfile = {
      id: issueId(m), lanesForward: 1, lanesBackward: 1, laneWidth: 3.4,
      speedLimit: kph(50), median: 0, shoulder: 0.5, isRamp: false, ...spec,
    };
    m.profiles.push(p);
    return p;
  };
  const arterial = mk({
    name: 'Arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    median: 2.6, shoulder: 0.8, speedLimit: kph(70), verge: 2.5,
  });
  const street = mk({ name: 'Street', laneWidth: 3.2, speedLimit: kph(40), verge: 4 });
  const high = mk({ name: 'High street', laneWidth: 3.3, shoulder: 1.2, speedLimit: kph(40) });

  const span = BLOCKS * BLOCK;
  for (let i = 0; i <= BLOCKS; i++) {
    const p = i * BLOCK;
    m.strokes.push({ id: issueId(m), profileId: arterial.id, points: line(p, 0, p, span, 3) });
    m.strokes.push({ id: issueId(m), profileId: arterial.id, points: line(0, p, span, p, 3) });
  }
  // Residential streets inside every block, and a high street through the middle.
  for (let bx = 0; bx < BLOCKS; bx++) {
    for (let by = 0; by < BLOCKS; by++) {
      const x0 = bx * BLOCK;
      const y0 = by * BLOCK;
      const mid = Math.floor(BLOCKS / 2);
      const commercial = bx === mid || by === mid;
      const profile = commercial ? high : street;
      m.strokes.push({
        id: issueId(m), profileId: profile.id,
        points: line(x0 + 150, y0, x0 + 150, y0 + BLOCK),
        landUse: commercial ? 'commercial' : 'residential',
      });
      m.strokes.push({
        id: issueId(m), profileId: profile.id,
        points: line(x0, y0 + 210, x0 + BLOCK, y0 + 210),
        landUse: commercial ? 'commercial' : 'residential',
      });
    }
  }
  m.settings.spawnMode = 'landuse';
  m.settings.dayLength = 24 * 90;
  m.settings.startHour = 0;
  return m;
}

// --- geometry checks --------------------------------------------------------------

function inRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  const n = ring.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!, yi = ring[i * 2 + 1]!;
    const xj = ring[j * 2]!, yj = ring[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function boxOf(poly: ArrayLike<number>): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    a = Math.min(a, poly[i]!); c = Math.max(c, poly[i]!);
    b = Math.min(b, poly[i + 1]!); d = Math.max(d, poly[i + 1]!);
  }
  return [a, b, c, d];
}

function sat(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (const poly of [a, b]) {
    const n = poly.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const nx = -(poly[j * 2 + 1]! - poly[i * 2 + 1]!);
      const ny = poly[j * 2]! - poly[i * 2]!;
      const len = Math.hypot(nx, ny) || 1;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (let k = 0; k < a.length; k += 2) {
        const v = (a[k]! * nx + a[k + 1]! * ny) / len;
        if (v < aMin) aMin = v; if (v > aMax) aMax = v;
      }
      for (let k = 0; k < b.length; k += 2) {
        const v = (b[k]! * nx + b[k + 1]! * ny) / len;
        if (v < bMin) bMin = v; if (v > bMax) bMax = v;
      }
      if (aMax <= bMin + 0.05 || bMax <= aMin + 0.05) return false;
    }
  }
  return true;
}

function checkGeometry(net: Network, plots: Plot[]): { onRoad: number; clashes: number } {
  const CELL = 80;
  const cells = new Map<string, Float32Array[]>();
  const put = (ring: Float32Array): void => {
    const [minX, minY, maxX, maxY] = boxOf(ring);
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
      for (let gy = Math.floor(minY / CELL); gy <= Math.floor(maxY / CELL); gy++) {
        const key = `${gx}|${gy}`;
        const list = cells.get(key);
        if (list) list.push(ring); else cells.set(key, [ring]);
      }
    }
  };
  for (const s of net.segments) if (s.surface.length >= 6) put(s.surface);
  for (const j of net.junctions) if (j.footprint.length >= 6) put(j.footprint);

  let onRoad = 0;
  for (const plot of plots) {
    const [minX, minY, maxX, maxY] = boxOf(plot.footprint);
    let hit = false;
    for (let x = minX; x <= maxX && !hit; x += 1.2) {
      for (let y = minY; y <= maxY && !hit; y += 1.2) {
        if (!inRing(plot.footprint, x, y)) continue;
        for (const ring of cells.get(`${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`) ?? []) {
          if (inRing(ring, x, y)) { hit = true; break; }
        }
      }
    }
    if (hit) onRoad++;
  }

  // Plots against each other, bucketed so this stays linear on a big town.
  const plotCells = new Map<string, number[]>();
  const boxes = plots.map((p) => boxOf(p.ground));
  plots.forEach((_, i) => {
    const [minX, minY, maxX, maxY] = boxes[i]!;
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
      for (let gy = Math.floor(minY / CELL); gy <= Math.floor(maxY / CELL); gy++) {
        const key = `${gx}|${gy}`;
        const list = plotCells.get(key);
        if (list) list.push(i); else plotCells.set(key, [i]);
      }
    }
  });
  let clashes = 0;
  const seen = new Set<string>();
  for (const list of plotCells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a]!, j = list[b]!;
        const key = i < j ? `${i}|${j}` : `${j}|${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bi = boxes[i]!, bj = boxes[j]!;
        if (bi[0] > bj[2] || bj[0] > bi[2] || bi[1] > bj[3] || bj[1] > bi[3]) continue;
        if (sat(plots[i]!.ground, plots[j]!.ground)) clashes++;
      }
    }
  }
  return { onRoad, clashes };
}

// --- run --------------------------------------------------------------------------

const model = bigTown();
const t0 = performance.now();
const net = compile(model);
const compileMs = performance.now() - t0;

const t1 = performance.now();
const plots = layoutBuildings(net);
const layoutMs = performance.now() - t1;

const errors = net.diagnostics.filter((d) => d.severity === 'error');
const warnings = net.diagnostics.filter((d) => d.severity === 'warning');

console.log(`town: ${BLOCKS}x${BLOCKS} blocks, ${net.segments.length} segments, `
  + `${net.junctions.length} junctions, ${net.zones.length} zones`);
console.log(`compile ${compileMs.toFixed(0)} ms · buildings ${layoutMs.toFixed(0)} ms `
  + `for ${plots.length} plots`);
console.log(`diagnostics: ${errors.length} errors, ${warnings.length} warnings`);
for (const d of errors.slice(0, 4)) console.log(`   ERROR ${d.code}: ${d.message}`);

const geom = checkGeometry(net, plots);
console.log(`geometry: ${geom.onRoad} buildings on a road, ${geom.clashes} overlapping plots`);

// A full simulated day of the town's own traffic.
const sim = new Simulation(net, {
  seed: 3, demandScale: DEMAND, spawnMode: 'landuse',
  dayLength: model.settings.dayLength, startHour: 0, maxVehicles: 20000,
});
const perHour = new Array<number>(24).fill(0);
let peakVehicles = 0;
let worstTick = 0;
const day = model.settings.dayLength;
const steps = Math.round(day / sim.dt);
for (let k = 0; k < steps; k++) {
  const before = performance.now();
  sim.tick();
  worstTick = Math.max(worstTick, performance.now() - before);
  peakVehicles = Math.max(peakVehicles, sim.store.count);
  if (k % 40 === 0) perHour[Math.floor(sim.timeOfDay)]! += sim.store.count;
}
const m = sim.metrics;
console.log(`day: spawned ${m.spawned} arrived ${m.arrived} live ${m.vehicles} `
  + `peak ${peakVehicles} worst tick ${worstTick.toFixed(1)} ms`);
console.log(`safety: collisions ${m.collisions} lost ${m.lost} mergeFail ${m.mergeFailures} `
  + `stalled ${m.stalled} missed ${m.missedExits}`);
const busiest = perHour.indexOf(Math.max(...perHour));
console.log(`busiest hour ${formatClock(busiest)} (${Math.max(...perHour)}), `
  + `quietest ${formatClock(perHour.indexOf(Math.min(...perHour)))}`);

const bad = errors.length + geom.onRoad + geom.clashes + m.collisions + m.lost + m.mergeFailures;
console.log(bad === 0 ? '--- clean ---' : `--- ${bad} problems ---`);
