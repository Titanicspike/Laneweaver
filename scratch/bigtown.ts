/** Writes a town about five times the size of the example, for loading in the app. */
import { writeFileSync } from 'node:fs';
import { createDocument, kph } from '../src/core/network/model';
import { serialize } from '../src/core/util/serialization';
import { compile } from '../src/core/network/compiler';
import { add, line, prof } from './cases';

const blocks = Number(process.argv[2] ?? 22);
const m = createDocument(7);
const main = prof(m, { name: 'Arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, shoulder: 0.6, median: 2.4, speedLimit: kph(60), landUse: 'commercial' });
const st = prof(m, { name: 'Street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(40), verge: 3, landUse: 'residential' });
const span = blocks * 180;
for (let i = 0; i <= blocks; i++) {
  const p = i % 4 === 0 ? main : st;
  add(m, p, line(0, i * 180, span, i * 180, blocks + 1));
  add(m, p, line(i * 180, 0, i * 180, span, blocks + 1));
}
const net = compile(m);
const json = serialize(m); // already a JSON string
writeFileSync('scratch/bigtown.json', json);
console.log(`bigtown: ${m.strokes.length} strokes, ${net.segments.length} segments, ${net.junctions.length} junctions, ${(json.length / 1024).toFixed(0)} kB`);
