/**
 * Dev-only: what a frame is made of on a big map.
 *
 *   npx tsx scratch/rendercost.ts [place] [zooms...]
 *
 * `npm run bench` renders a fifty-one-segment synthetic network through a stub
 * canvas, which measures the renderer's own JavaScript and none of the rasterising.
 * On a real map neither number is the one that matters: what matters is how much
 * geometry each `fill` is handed, and how many of them there are. Both are visible
 * from the stub, because it records the calls it is given.
 */
import { readFileSync } from 'node:fs';
import { installCanvasGlobals, StubCanvas, StubContext, StubPath2D } from '../test/helpers/canvasStub';
installCanvasGlobals();

import { compile } from '../src/core/network/compiler';
import { importOsm } from '../src/core/osm/import';
import { NetworkPaths } from '../src/render/networkPaths';
import { Renderer } from '../src/render/renderer';
import type { Network } from '../src/core/network/types';

const place = process.argv[2] ?? 'cupertino';
const zooms = process.argv.slice(3).map(Number);
const { model } = importOsm(JSON.parse(
  readFileSync(new URL(`./osm/${place}.json`, import.meta.url), 'utf8')));

const t0 = Date.now();
const net: Network = compile(model);
const compileMs = Date.now() - t0;

const t1 = Date.now();
const paths = new NetworkPaths(net);
let bakeMs = Date.now() - t1;
const t2 = Date.now();
// The frame loop decorates a little at a time; here we want the finished picture.
while (!paths.decorate(1e9)) { /* keep going */ }
bakeMs += Date.now() - t2;

const canvas = new StubCanvas();
const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
const input = {
  network: net, paths, sim: null, alpha: 0, terrain: null, underlay: null, geo: null,
  showGrid: false, showDiagnostics: false, overlays: [],
};

console.log(`${place}: ${net.segments.length} segments, compile ${compileMs} ms, bake ${bakeMs} ms`);
console.log(`  tiles ${(paths as unknown as { tiles: Map<string, unknown> }).tiles?.size ?? '?'}`);

/** Points in a recorded path — the geometry one fill or stroke is handed. */
function pointsOf(p: unknown): number {
  const ops = (p as StubPath2D | undefined)?.ops;
  if (!ops) return 0;
  let n = 0;
  for (const op of ops) {
    if (op.op === 'moveTo' || op.op === 'lineTo') n++;
    else if (op.op === 'bezierCurveTo') n += 3;
    else if (op.op === 'quadraticCurveTo') n += 2;
    else if (op.op === 'arc') n += 8;
  }
  return n;
}

for (const zoom of zooms.length ? zooms : [0.08, 0.2, 0.45, 0.9, 2]) {
  renderer.camera.fit(net.bounds, 20);
  renderer.camera.zoom = zoom;
  renderer.camera.x = 0;
  renderer.camera.y = 0;
  const ctx = canvas.context as unknown as StubContext;
  ctx.calls.length = 0;
  const start = Date.now();
  const reps = 5;
  for (let i = 0; i < reps; i++) { ctx.calls.length = 0; renderer.render(input); }
  const jsMs = (Date.now() - start) / reps;

  let fills = 0;
  let strokes = 0;
  let pts = 0;
  const byOp = new Map<string, { n: number; pts: number }>();
  for (const c of ctx.calls) {
    if (c.op !== 'fill' && c.op !== 'stroke') continue;
    const n = pointsOf(c.args[0]);
    pts += n;
    if (c.op === 'fill') fills++; else strokes++;
    const key = `${c.op}:${((c.op === 'fill' ? c.fillStyle : c.strokeStyle) || '?').slice(0, 12)}`;
    const at = byOp.get(key) ?? { n: 0, pts: 0 };
    at.n++;
    at.pts += n;
    byOp.set(key, at);
  }
  const top = [...byOp].sort((a, b) => b[1].pts - a[1].pts).slice(0, 6)
    .map(([k, v]) => `${k} ${v.n}x/${(v.pts / 1000).toFixed(0)}k`);
  console.log(`  zoom ${String(zoom).padEnd(5)} tiles ${String(renderer.stats.tiles).padStart(4)}`
    + `  draws ${String(fills + strokes).padStart(5)} (${fills} fill, ${strokes} stroke)`
    + `  points ${(pts / 1000).toFixed(0)}k  js ${jsMs.toFixed(1)} ms`);
  console.log(`      ${top.join('  ')}`);
}
