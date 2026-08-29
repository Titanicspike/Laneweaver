/** Dev-only: every scenario drawn with the real renderer, side by side. */
import { compile } from '../src/core/network/compiler';
import { Renderer } from '../src/render/renderer';
import { NetworkPaths } from '../src/render/networkPaths';
import { Simulation } from '../src/core/sim/sim';
import { cases } from './cases';

const params = new URLSearchParams(location.search);
const only = (params.get('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const zoomOverride = Number(params.get('zoom') || 0);
const runSeconds = Number(params.get('run') || 0);
const tall = Number(params.get('h') || 300);
const grid = document.getElementById('grid')!;
document.documentElement.style.setProperty('--h', `${tall}px`);
if (params.get('wide')) grid.setAttribute('style', 'grid-template-columns: 1fr');

/**
 * An imported place, fetched from the cache the dev server happens to be serving.
 * `?osm=cupertino` draws it exactly as the app would, which is the only way to see
 * whether an import looks like a city or like a diagram.
 */
async function osmCase(id: string): Promise<Case | null> {
  const res = await fetch(`/scratch/osm/${id}.json`);
  if (!res.ok) return null;
  const { importOsm } = await import('../src/core/osm/import');
  const { model, report } = await Promise.resolve(importOsm(await res.json()));
  console.log(`${id}: ${report.imported} ways, ${report.controlPoints} control points, ${report.ms} ms`);
  return { name: `osm:${id}`, model, zoom: 0 };
}

const osmWanted = (params.get('osm') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const extra: Case[] = [];
for (const id of osmWanted) {
  const c = await osmCase(id);
  if (c) extra.push(c);
}

for (const c of [...extra, ...(osmWanted.length ? [] : cases())]) {
  if (only.length && !only.some((o) => c.name.includes(o))) continue;
  const net = compile(c.model);
  const fig = document.createElement('figure');
  const cap = document.createElement('figcaption');
  const errs = net.diagnostics.filter((d) => d.severity !== 'info').length;
  cap.innerHTML = `<span>${c.name}</span><span class="note">${net.segments.length} seg · `
    + `${net.junctions.map((j) => j.kind).join(',') || 'no junction'}${errs ? ` · ${errs} diag` : ''}</span>`;
  const canvas = document.createElement('canvas');
  fig.append(cap, canvas);
  grid.append(fig);

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr) || 900;
  canvas.height = Math.round(tall * dpr);
  const renderer = new Renderer(canvas);
  renderer.resize();
  const paths = new NetworkPaths(net);
  let sim: Simulation | null = null;
  if (runSeconds > 0) {
    sim = new Simulation(net, { seed: 4, demandScale: 1 });
    sim.run(runSeconds);
  }
  // Fit first, then honour whatever the case or the URL asks for. A case that
  // says zoom 0 is saying "whatever fits", which is the right answer for anything
  // whose extent is not known up front.
  renderer.camera.fit(net.bounds, 20);
  const zoom = zoomOverride > 0 ? zoomOverride : c.zoom;
  if (zoom > 0) renderer.camera.zoom = zoom;
  const focus = params.get('at');
  const [fx, fy] = focus ? focus.split(',').map(Number) : c.at ?? [];
  if (fx !== undefined) { renderer.camera.x = fx; renderer.camera.y = fy!; }
  renderer.render({
    network: net, paths, sim, alpha: 0, terrain: null, underlay: null, geo: null,
    showGrid: false, showDiagnostics: params.get('diag') !== '0', overlays: [],
  });
}
