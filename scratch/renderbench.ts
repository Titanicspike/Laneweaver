/**
 * Dev-only: what a frame actually costs in a browser, on a real map.
 *
 *   /renderbench.html?osm=cupertino          a cached import
 *   /renderbench.html?case=example-town      a zoo document
 *   /renderbench.html?osm=cupertino&pan=1    pan while measuring, which is the case
 *                                            somebody complains about
 *
 * `npm run bench` renders a fifty-one-segment synthetic network through a *stub*
 * canvas: it measures the renderer's own JavaScript and none of the rasterising,
 * which on a big map is most of the cost. This measures a real frame, at a
 * sweep of zooms, and reports the median and the worst — because a pan that is
 * smooth on average and drops a frame a second still reads as lag.
 */
import { compile } from '../src/core/network/compiler';
import { NetworkPaths } from '../src/render/networkPaths';
import { Renderer } from '../src/render/renderer';
import { cases } from './cases';
import type { EditModel } from '../src/core/network/types';

const params = new URLSearchParams(location.search);
const out = document.getElementById('out') as HTMLDivElement;
const canvas = document.getElementById('c') as HTMLCanvasElement;

const ZOOMS = (params.get('zooms') ?? '0.08,0.16,0.3,0.45,0.9,2')
  .split(',').map(Number).filter((z) => z > 0);
const PAN = params.get('pan') === '1';
/** Change the zoom a little each frame, which is what a wheel gesture does. */
const ZOOMING = params.get('zooming') === '1';
const FRAMES = Number(params.get('frames') ?? 45);
/** Viewports of pan per second. One is a normal drag; ten forces a redraw a frame. */
const SPEED = Number(params.get('speed') ?? 0.33);

function say(line: string): void {
  out.textContent = `${out.textContent}\n${line}`.trim();
}

async function loadModel(): Promise<{ name: string; model: EditModel }> {
  const osm = params.get('osm');
  if (osm) {
    const res = await fetch(`/scratch/osm/${osm}.json`);
    if (!res.ok) throw new Error(`no cached extract ${osm}`);
    const { importOsm } = await import('../src/core/osm/import');
    return { name: `osm:${osm}`, model: importOsm(await res.json()).model };
  }
  const want = params.get('case') ?? 'example-town';
  const found = cases().find((c) => c.name === want);
  if (!found) throw new Error(`no case ${want}`);
  return { name: found.name, model: found.model };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

async function main(): Promise<void> {
  out.textContent = '';
  const { name, model } = await loadModel();

  let t = performance.now();
  const net = compile(model);
  const compileMs = performance.now() - t;

  t = performance.now();
  const paths = new NetworkPaths(net);
  while (!paths.decorate(1e9)) { /* finish the picture before measuring it */ }
  const bakeMs = performance.now() - t;

  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  const renderer = new Renderer(canvas);
  const input = {
    network: net, paths, sim: null, alpha: 0, terrain: null, underlay: null, geo: null,
    showGrid: false, showDiagnostics: false, overlays: [],
  };

  say(`${name}: ${net.segments.length} segments, ${net.lanes.length} lanes`);
  say(`compile ${compileMs.toFixed(0)} ms, bake ${bakeMs.toFixed(0)} ms`
    + `, canvas ${canvas.width}x${canvas.height} @${devicePixelRatio}`);
  say(PAN ? 'panning while measuring' : 'still frames');
  say('');

  const rows: string[] = [];
  for (const zoom of ZOOMS) {
    renderer.camera.fit(net.bounds, 20);
    const home = { x: renderer.camera.x, y: renderer.camera.y };
    renderer.camera.zoom = zoom;
    renderer.camera.x = home.x;
    renderer.camera.y = home.y;
    // Warm up: the first frames of a zoom pay for whatever the browser caches.
    for (let i = 0; i < 5; i++) {
      renderer.render(input);
      await new Promise(requestAnimationFrame);
    }
    const samples: number[] = [];
    let blits = 0;
    let captures = 0;
    for (let i = 0; i < FRAMES; i++) {
      if (PAN) {
        renderer.camera.x = home.x + (i * canvas.clientWidth * SPEED / 60) / zoom;
      }
      if (ZOOMING) renderer.camera.zoom = zoom * Math.pow(1.02, i);
      const start = performance.now();
      renderer.render(input);
      samples.push(performance.now() - start);
      blits += renderer.stats.blits;
      captures += renderer.stats.captures;
      await new Promise(requestAnimationFrame);
    }
    const worst = Math.max(...samples);
    rows.push(`zoom ${String(zoom).padEnd(5)} median ${median(samples).toFixed(1).padStart(6)} ms`
      + `  worst ${worst.toFixed(1).padStart(6)} ms  tiles ${String(renderer.stats.tiles).padStart(4)}`
      + `  cache ${blits} reused / ${captures} redrawn`);
    say(rows[rows.length - 1]);
    // Where the frame went, worst pass first: the whole point of measuring.
    const passes = Object.entries(renderer.timings)
      .filter(([, ms]) => ms > 0.2)
      .sort((a, b) => b[1] - a[1])
      .map(([k, ms]) => `${k} ${ms.toFixed(0)}`);
    say(`      ${passes.join('  ')}`);
  }
  (window as unknown as { __bench: string[] }).__bench = rows;
  say('');
  say('done');
}

main().catch((e) => { say(`FAILED ${String(e)}`); });
