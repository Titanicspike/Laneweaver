/** How compile time scales with network size, and where it goes. */
import { compile } from '../src/core/network/compiler';
import { createDocument, kph } from '../src/core/network/model';
import { add, line, prof } from './cases';
import type { EditModel } from '../src/core/network/types';

/** A town grid of n x n blocks, 200 m spacing — the shape that gets big. */
function grid(n: number): EditModel {
  const m = createDocument(7);
  const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
  const span = n * 200;
  for (let i = 0; i <= n; i++) {
    add(m, st, line(0, i * 200, span, i * 200, Math.max(2, n)));
    add(m, st, line(i * 200, 0, i * 200, span, Math.max(2, n)));
  }
  return m;
}

console.log(' n | strokes | segments | junctions |  compile ms | ms/segment');
for (const n of [2, 3, 4, 6, 8, 10, 12]) {
  const m = grid(n);
  compile(m); // warm
  const t0 = performance.now();
  const reps = n <= 4 ? 5 : 2;
  let net: any;
  for (let r = 0; r < reps; r++) net = compile(m);
  const ms = (performance.now() - t0) / reps;
  console.log(`${String(n).padStart(2)} | ${String(m.strokes.length).padStart(7)} | ${String(net.segments.length).padStart(8)}`
    + ` | ${String(net.junctions.length).padStart(9)} | ${ms.toFixed(1).padStart(11)} | ${(ms / net.segments.length).toFixed(2).padStart(10)}`);
}
