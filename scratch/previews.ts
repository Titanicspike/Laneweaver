/**
 * Dev-only: every road profile's preview beside what the compiler actually builds
 * from it.
 *
 * The whole point of drawing the swatch is that picking a road type stops being
 * guesswork, so the swatch disagreeing with the map is the one failure that makes
 * it worse than a grey box. Left is `drawRoadPreview`; right is a straight piece of
 * that road compiled and drawn by the real renderer.
 */
import { createDocument, issueId, kph, makeControlPoint } from '../src/core/network/model';
import { compile } from '../src/core/network/compiler';
import { Renderer } from '../src/render/renderer';
import { NetworkPaths } from '../src/render/networkPaths';
import { drawRoadPreview, previewWidth } from '../src/render/roadPreview';
import type { EditModel, RoadProfile } from '../src/core/network/types';

const grid = document.getElementById('grid')!;
const params = new URLSearchParams(location.search);
const only = params.get('only');

function variants(): RoadProfile[] {
  const base = createDocument(1).profiles;
  const out = [...base];
  const mk = (name: string, patch: Partial<RoadProfile>): RoadProfile => ({
    id: 9000 + out.length, name, lanesForward: 1, lanesBackward: 0, laneWidth: 3.5,
    speedLimit: kph(60), median: 0, shoulder: 0.5, isRamp: false, ...patch,
  });
  // The cases the road editor's steppers can produce, which is where it broke.
  for (const f of [1, 2, 3, 4, 5]) out.push(mk(`${f}+0 one-way`, { lanesForward: f, lanesBackward: 0 }));
  for (const f of [1, 2, 3, 4]) out.push(mk(`${f}+${f} no median`, { lanesForward: f, lanesBackward: f, median: 0 }));
  for (const f of [1, 2, 3]) out.push(mk(`${f}+${f} median 3`, { lanesForward: f, lanesBackward: f, median: 3 }));
  out.push(mk('3+1 asymmetric', { lanesForward: 3, lanesBackward: 1, median: 2 }));
  out.push(mk('1+3 asymmetric', { lanesForward: 1, lanesBackward: 3, median: 2 }));
  out.push(mk('0+2 backward only', { lanesForward: 0, lanesBackward: 2 }));
  out.push(mk('2+2 wide shoulder', { lanesForward: 2, lanesBackward: 2, shoulder: 3, median: 1 }));
  out.push(mk('2+2 verge', { lanesForward: 2, lanesBackward: 2, median: 2, verge: 5 }));
  out.push(mk('narrow lanes', { lanesForward: 2, lanesBackward: 2, laneWidth: 2.6, median: 0.5 }));
  return out;
}

function roadDoc(profile: RoadProfile): EditModel {
  const m = createDocument(3);
  const p = { ...profile, id: issueId(m) };
  m.profiles.push(p);
  m.strokes.push({
    id: issueId(m), profileId: p.id,
    points: [makeControlPoint(-260, 0), makeControlPoint(260, 0)],
  });
  return m;
}

for (const profile of variants()) {
  if (only && !profile.name.toLowerCase().includes(only.toLowerCase())) continue;
  const fig = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.innerHTML = `<span>${profile.name}</span><span class="note">`
    + `${profile.lanesForward}+${profile.lanesBackward} · lane ${profile.laneWidth} · `
    + `median ${profile.median} · shoulder ${profile.shoulder} · `
    + `${previewWidth(profile, (profile.verge ?? 0) > 0).toFixed(1)} m</span>`;
  const pair = document.createElement('div');
  pair.className = 'pair';
  const left = document.createElement('div');
  left.dataset.label = 'preview';
  const right = document.createElement('div');
  right.dataset.label = 'compiled';
  const a = document.createElement('canvas');
  const b = document.createElement('canvas');
  left.append(a); right.append(b); pair.append(left, right);
  fig.append(cap, pair);
  grid.append(fig);

  const dpr = window.devicePixelRatio || 1;
  for (const c of [a, b]) {
    c.width = Math.round(c.clientWidth * dpr) || 400;
    c.height = Math.round(110 * dpr);
  }
  const ctxA = a.getContext('2d')!;
  ctxA.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRoadPreview(ctxA, profile, a.clientWidth, 110, { direction: true });

  const net = compile(roadDoc(profile));
  const renderer = new Renderer(b);
  renderer.resize();
  const paths = new NetworkPaths(net);
  renderer.camera.fit(net.bounds, 4);
  // Match the preview's scale so the two pictures are comparable.
  renderer.camera.zoom = 110 / Math.max(1, previewWidth(profile, (profile.verge ?? 0) > 0) + 6);
  renderer.camera.x = 0;
  renderer.camera.y = 0;
  renderer.render({
    network: net, paths, sim: null, alpha: 0, terrain: null, underlay: null, geo: null,
    showGrid: false, showDiagnostics: false, overlays: [],
  });
}
