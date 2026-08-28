/**
 * Fuzzes junction geometry against the audit's own checks.
 *
 * A real network is full of shapes the zoo does not have: arms at awkward angles,
 * roads of very different width meeting, approaches that arrive on a curve, five
 * and six-way junctions, and junctions close enough together to interfere. Anything
 * the audit flags here is something that would look wrong on screen.
 */
import { auditModel } from './audit';
import { createDocument, kph } from '../src/core/network/model';
import { compile } from '../src/core/network/compiler';
import { add, pts, prof } from './cases';
import { Mulberry32 } from '../src/core/util/rng';
import type { EditModel } from '../src/core/network/types';

/** An n-armed junction with the given bearings, widths and approach curvature. */
function star(bearings: number[], lanes: number[], bend: number[], median: number[]): EditModel {
  const m = createDocument(7);
  for (let i = 0; i < bearings.length; i++) {
    const p = prof(m, {
      name: `r${i}`, lanesForward: lanes[i], lanesBackward: lanes[i], laneWidth: 3.5,
      shoulder: 0.5, median: median[i], speedLimit: kph(50 + lanes[i] * 10),
    });
    const a = (bearings[i] * Math.PI) / 180;
    const L = 260;
    // A curved arm: the far end swings off by `bend` metres perpendicular.
    const nx = -Math.sin(a), ny = Math.cos(a);
    add(m, p, pts(
      0, 0,
      Math.cos(a) * L * 0.5 + nx * bend[i] * 0.25, Math.sin(a) * L * 0.5 + ny * bend[i] * 0.25,
      Math.cos(a) * L + nx * bend[i], Math.sin(a) * L + ny * bend[i],
    ));
  }
  return m;
}

const rng = new Mulberry32(20260827);
let checked = 0;
const failures: string[] = [];
const seen = new Set<string>();
const counts = new Map<string, number>();
let worstStick = 0;
let worstCase = '';
const worstList: { m: number; s: string }[] = [];

for (let trial = 0; trial < 420; trial++) {
  const arms = 3 + Math.floor(rng.next() * 4); // 3..6
  const bearings: number[] = [];
  for (let i = 0; i < arms; i++) {
    // Spread them out but let them get awkwardly close.
    bearings.push(Math.round((i * 360) / arms + (rng.next() - 0.5) * (360 / arms) * 0.9));
  }
  const lanes = bearings.map(() => 1 + Math.floor(rng.next() * 3));
  const bend = bearings.map(() => (rng.next() - 0.5) * 120);
  const median = lanes.map((n) => (n > 1 && rng.next() < 0.6 ? 2.4 : 0));
  const model = star(bearings, lanes, bend, median);
  let bad: string[];
  try {
    bad = auditModel(`arms=${arms} bearings=[${bearings.join(',')}] lanes=[${lanes.join(',')}]`, model);
  } catch (e) {
    failures.push(`THREW arms=${arms} bearings=[${bearings.join(',')}]: ${(e as Error).message}`);
    continue;
  }
  checked++;
  // Compiler errors count too — a junction that will not build is as visible as one
  // that builds wrong.
  const net = compile(model);
  for (const d of net.diagnostics) {
    if (d.severity === 'error') bad.push(`${d.code}: ${d.message}`);
  }
  for (const b of bad) {
    const kind = b.replace(/^[^:]*: /, '').replace(/-?\d+(\.\d+)?/g, 'N').slice(0, 90);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const mag = /sticks out ([\d.]+) m/.exec(b);
    if (mag) worstList.push({ m: Number(mag[1]), s: b });
    if (mag && Number(mag[1]) > worstStick) { worstStick = Number(mag[1]); worstCase = b; }
    if (!seen.has(kind)) { seen.add(kind); failures.push(b); }
  }
}
console.log(`checked ${checked} junction shapes`);
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}x  ${k}`);
}
console.log(`worst overhang ${worstStick.toFixed(1)} m`);
console.log('  WORST: ' + worstCase);
// The five worst, so the shape of the problem is visible rather than one example.
worstList.sort((a, b) => b.m - a.m);
for (const w of worstList.slice(0, 8)) console.log(`  ${w.m.toFixed(1).padStart(5)} m  ${w.s}`);
for (const f of failures.slice(0, 6)) console.log('  eg ' + f);
