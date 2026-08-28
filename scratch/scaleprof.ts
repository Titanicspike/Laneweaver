/** What a drag frame costs as the network grows. */
import { compile } from '../src/core/network/compiler';
import { createDocument, kph } from '../src/core/network/model';
import { add, line, prof } from './cases';
import type { EditModel } from '../src/core/network/types';

function town(blocks: number): EditModel {
  const m = createDocument(7);
  const main = prof(m, { name: 'art', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, shoulder: 0.6, median: 2.4, speedLimit: kph(60) });
  const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(40), verge: 3 });
  const span = blocks * 180;
  for (let i = 0; i <= blocks; i++) {
    const p = i % 3 === 0 ? main : st;
    add(m, p, line(0, i * 180, span, i * 180, blocks + 1));
    add(m, p, line(i * 180, 0, i * 180, span, blocks + 1));
  }
  return m;
}
console.log('blocks | strokes | segments | junctions | compile ms |   fps');
for (const b of [3, 5, 7, 9, 11]) {
  const m = town(b);
  compile(m);
  const reps = b <= 5 ? 5 : 2;
  const t0 = performance.now();
  let net: any;
  for (let r = 0; r < reps; r++) net = compile(m);
  const ms = (performance.now() - t0) / reps;
  console.log(`${String(b).padStart(6)} | ${String(m.strokes.length).padStart(7)} | ${String(net.segments.length).padStart(8)}`
    + ` | ${String(net.junctions.length).padStart(9)} | ${ms.toFixed(1).padStart(10)} | ${(1000 / ms).toFixed(1).padStart(5)}`);
}
