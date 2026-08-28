/** A 60-frame drag on towns of increasing size: how much of the time is the rebuild? */
import { installCanvasGlobals } from '../test/helpers/canvasStub';
installCanvasGlobals();
const { AppStore } = await import('../src/app/store');
const { NetworkPaths } = await import('../src/render/networkPaths');
const { createDocument, kph } = await import('../src/core/network/model');
const { add, line, prof } = await import('./cases');

function town(blocks: number): any {
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

console.log('blocks | segs | compiles/60 | total ms | worst frame | median frame | effective fps');
for (const b of [3, 5, 7, 9, 11, 14]) {
  const store = new AppStore(town(b));
  let paths = new NetworkPaths(store.network);
  let version = store.compileVersion;
  const pt = store.model.strokes[1].points[1];
  store.beginEdit();
  const frames: number[] = [];
  let compiles = 0;
  const t0 = performance.now();
  for (let f = 0; f < 60; f++) {
    const fs = performance.now();
    pt.x += 0.5; pt.y += 0.3;          // the drag
    store.invalidate();
    store.flush();
    if (version !== store.compileVersion) {  // the renderer's rebake
      version = store.compileVersion;
      paths = new NetworkPaths(store.network);
      compiles++;
    }
    store.staleStrokes();               // what the preview pass costs
    frames.push(performance.now() - fs);
  }
  const total = performance.now() - t0;
  store.endEdit();
  frames.sort((a, b2) => a - b2);
  console.log(`${String(b).padStart(6)} | ${String(store.network.segments.length).padStart(4)}`
    + ` | ${String(compiles).padStart(11)} | ${total.toFixed(0).padStart(8)}`
    + ` | ${frames[59].toFixed(1).padStart(11)} | ${frames[30].toFixed(2).padStart(12)}`
    + ` | ${(60000 / total).toFixed(0).padStart(13)}`);
}
