/**
 * Exercises the whole render path under a stub canvas. It cannot prove pixels are
 * right, but it does prove every layer runs, that culling and level-of-detail
 * actually change what is drawn, and that the renderer never mutates sim state.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubCanvas, StubContext, callsSince, type DrawCall } from '../helpers/canvasStub';
installCanvasGlobals();

import { Renderer } from '@render/renderer';
import { NetworkPaths } from '@render/networkPaths';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { createDemoDocument } from '@app/demo';
import { generateTerrain } from '@core/terrain/terrain';
import { hashHex } from '@core/sim/hash';
import { DEFAULT_TERRAIN } from '@core/network/types';

function setup() {
  const model = createDemoDocument();
  const net = compile(model);
  // Everything this renderer draws with, including the offscreen the static layer
  // makes for itself, is created from here on.
  const mark = StubContext.instances.length;
  const canvas = new StubCanvas();
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
  renderer.camera.fit(net.bounds, 60);
  const paths = new NetworkPaths(net);
  const sim = new Simulation(net, { seed: 3, demandScale: 1 });
  sim.run(60);
  return {
    model, net, canvas, renderer, paths, sim,
    ctx: canvas.context as unknown as StubContext,
    /** Every call this renderer made, on whichever canvas it made it. */
    calls: (): DrawCall[] => callsSince(mark),
  };
}

function frame(s: ReturnType<typeof setup>, overrides: Partial<Parameters<Renderer['render']>[0]> = {}) {
  s.renderer.render({
    network: s.net,
    paths: s.paths,
    sim: s.sim,
    alpha: 0.5,
    terrain: null,
    underlay: null,
    geo: null,
    showGrid: true,
    showDiagnostics: true,
    overlays: [],
    ...overrides,
  });
}

describe('render pipeline', () => {
  it('draws a full frame without throwing', () => {
    const s = setup();
    expect(() => frame(s)).not.toThrow();
    expect(s.ctx.count('fill')).toBeGreaterThan(0);
    expect(s.ctx.count('stroke')).toBeGreaterThan(0);
    expect(s.ctx.balanced).toBe(true);
  });

  it('reports what it drew', () => {
    const s = setup();
    frame(s);
    expect(s.renderer.stats.tiles).toBeGreaterThan(0);
    expect(s.renderer.stats.vehicles).toBeGreaterThan(0);
    expect(s.renderer.stats.drawMs).toBeGreaterThanOrEqual(0);
  });

  it('never touches the simulation', () => {
    const s = setup();
    const before = hashHex(s.sim);
    frame(s);
    frame(s);
    expect(hashHex(s.sim)).toBe(before);
  });

  it('culls tiles that are off screen', () => {
    const s = setup();
    frame(s);
    const visible = s.renderer.stats.tiles;
    s.renderer.camera.x = 500000;
    s.renderer.camera.y = 500000;
    frame(s);
    expect(s.renderer.stats.tiles).toBe(0);
    expect(visible).toBeGreaterThan(0);
  });

  it('drops lane markings when zoomed out', () => {
    const dashCalls = (calls: DrawCall[]): number =>
      calls.filter((c) => c.op === 'setLineDash' && (c.args[0] as number[]).length > 0).length;

    const close = setup();
    close.renderer.camera.zoom = 3;
    frame(close);
    expect(dashCalls(close.calls())).toBeGreaterThan(0);

    const far = setup();
    far.renderer.camera.zoom = 0.05;
    frame(far);
    expect(dashCalls(far.calls())).toBe(0);
  });

  it('paints arrows and word markings only where they can be read', () => {
    const words = (calls: DrawCall[]): number => calls.filter((c) => c.op === 'fillText').length;

    const close = setup();
    close.renderer.camera.zoom = 3;
    close.renderer.camera.x = -710;
    close.renderer.camera.y = 527;
    frame(close);
    expect(words(close.calls())).toBeGreaterThan(0);
    // Word markings are stretched along the lane, never drawn square.
    const scales = close.calls().filter((c) => c.op === 'scale');
    expect(scales.length).toBeGreaterThan(0);
    for (const c of scales) expect(c.args[0]).not.toBe(c.args[1]);

    const far = setup();
    far.renderer.camera.zoom = 0.4;
    frame(far);
    expect(words(far.calls())).toBe(0);
  });

  it('stretches the dash pattern so dashes stay visible zooming out', () => {
    const dashLength = (calls: DrawCall[]): number => {
      const call = calls.find(
        (c) => c.op === 'setLineDash' && (c.args[0] as number[]).length === 2,
      );
      return call ? (call.args[0] as number[])[0]! : 0;
    };

    // The pattern is in world units, so without stretching each dash would shrink
    // to nothing on screen long before the markings LOD cuts in.
    const close = setup();
    close.renderer.camera.zoom = 3;
    frame(close);
    const near = dashLength(close.calls());
    expect(near).toBeGreaterThan(0);

    const far = setup();
    far.renderer.camera.zoom = 0.25;
    frame(far);
    const away = dashLength(far.calls());
    expect(away).toBeGreaterThan(near);
    // Whatever the zoom, a dash stays at least a couple of pixels long.
    expect(away * 0.25).toBeGreaterThanOrEqual(2);
  });

  it('draws vehicles as bodies close up and as dots far out', () => {
    const close = setup();
    close.renderer.camera.zoom = 3;
    // Point the camera at a vehicle rather than at the middle of the bounding box,
    // which need not have any traffic in it.
    const pose = { x: 0, y: 0, heading: 0 };
    let found = false;
    close.sim.forEachVehicle((i) => {
      if (found) return;
      close.sim.sampleVehicle(i, 0, pose);
      close.renderer.camera.x = pose.x;
      close.renderer.camera.y = pose.y;
      found = true;
    });
    expect(found).toBe(true);
    frame(close);
    const bodies = close.ctx.calls.filter((c) => c.op === 'rotate').length;
    expect(bodies).toBeGreaterThan(0);

    const far = setup();
    far.renderer.camera.zoom = 0.3;
    frame(far);
    expect(far.ctx.calls.filter((c) => c.op === 'rotate').length).toBe(0);
    expect(far.renderer.stats.vehicles).toBeGreaterThan(0);
  });

  it('stops drawing vehicles entirely when zoomed right out', () => {
    const s = setup();
    s.renderer.camera.zoom = 0.05;
    frame(s);
    expect(s.renderer.stats.vehicles).toBe(0);
  });

  it('draws terrain when it is present', () => {
    const s = setup();
    frame(s);
    const without = s.ctx.calls.length;
    const t = setup();
    const terrain = generateTerrain({ ...DEFAULT_TERRAIN, enabled: true }, t.net.bounds);
    frame(t, { terrain });
    expect(t.ctx.calls.length).toBeGreaterThan(without);
  });

  it('draws overlays last so they sit on top', () => {
    const s = setup();
    let sawOverlay = -1;
    frame(s, {
      overlays: [{
        draw: () => { sawOverlay = s.ctx.calls.length; },
      }],
    });
    expect(sawOverlay).toBeGreaterThan(0);
    expect(sawOverlay).toBeGreaterThanOrEqual(s.ctx.calls.length - 2);
  });

  it('survives an empty network', () => {
    const canvas = new StubCanvas();
    const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
    const net = compile({
      version: 1, profiles: createDemoDocument().profiles, strokes: [],
      settings: createDemoDocument().settings, terrain: DEFAULT_TERRAIN,
      demand: [], junctions: [], laneLinks: [],
    gateways: [], underlay: null, geo: createDemoDocument().geo, nextId: 100,
    });
    expect(() => renderer.render({
      network: net, paths: new NetworkPaths(net), sim: null, alpha: 0,
      terrain: null, underlay: null, geo: null,
      showGrid: true, showDiagnostics: true, overlays: [],
    })).not.toThrow();
  });
});
