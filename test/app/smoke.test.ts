/**
 * End-to-end smoke test for the application layer.
 *
 * The browser build cannot be exercised here, so this drives the same objects
 * `main.ts` wires together - store, compiler, simulation, renderer, every tool -
 * against the demo document, and checks that a realistic edit-run-render cycle
 * works and stays consistent.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubCanvas } from '../helpers/canvasStub';
installCanvasGlobals();

import { AppStore } from '@app/store';
import { createDemoDocument } from '@app/demo';
import { Renderer } from '@render/renderer';
import { NetworkPaths } from '@render/networkPaths';
import { harness } from '../helpers/editor';
import { DrawTool } from '@editor/tools/drawTool';
import { SelectTool } from '@editor/tools/selectTool';
import { BulldozeTool } from '@editor/tools/bulldozeTool';
import { InspectTool } from '@editor/tools/inspectTool';
import { UnderlayTool } from '@editor/tools/underlayTool';
import { deserialize, serialize } from '@core/util/serialization';
import { hashHex } from '@core/sim/hash';

describe('the demo document', () => {
  const store = new AppStore(createDemoDocument());

  it('compiles cleanly', () => {
    expect(store.network.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(store.network.segments.length).toBeGreaterThan(5);
    expect(store.network.junctions.length).toBeGreaterThan(2);
  });

  it('shows off every junction kind it claims to', () => {
    const kinds = new Set(store.network.junctions.map((j) => j.kind));
    expect(kinds.has('merge')).toBe(true);
    expect(kinds.has('diverge')).toBe(true);
    expect(kinds.has('crossing')).toBe(true);
  });

  it('has roads on more than one grade', () => {
    const grades = new Set(store.network.segments.map((s) => s.grade));
    expect(grades.size).toBeGreaterThan(1);
  });

  it('runs traffic without incident', () => {
    for (let i = 0; i < 6000; i++) store.sim.tick();
    expect(store.sim.metrics.collisions).toBe(0);
    expect(store.sim.metrics.mergeFailures).toBe(0);
    expect(store.sim.metrics.lost).toBe(0);
    expect(store.sim.metrics.arrived).toBeGreaterThan(20);
    expect(store.sim.validateLists()).toEqual([]);
  });

  it('round-trips through the save format unchanged', () => {
    const again = deserialize(serialize(store.model));
    expect(again.strokes).toEqual(store.model.strokes);
    expect(again.profiles).toEqual(store.model.profiles);
  });
});

describe('an edit, run and render cycle', () => {
  it('stays consistent through every tool', () => {
    const h = harness(createDemoDocument());
    const canvas = new StubCanvas();
    const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
    renderer.camera.fit(h.store.network.bounds, 40);
    let paths = new NetworkPaths(h.store.network);

    const render = (): void => {
      renderer.render({
        network: h.store.network, paths, sim: h.store.sim, alpha: 0.5,
        terrain: h.store.terrain, underlay: h.store.model.underlay, geo: null,
        showGrid: true, showDiagnostics: true, overlays: [],
      });
    };
    const rebuild = (): void => {
      h.settle();
      paths = new NetworkPaths(h.store.network);
      renderer.setNetwork(h.store.network);
    };

    render();
    const before = h.store.model.strokes.length;

    const draw = new DrawTool();
    h.env.activeProfileId = h.store.model.profiles[0].id;
    h.click(draw, -900, 700);
    h.click(draw, -400, 760);
    h.click(draw, 100, 720);
    h.key(draw, 'Enter');
    rebuild();
    render();
    expect(h.store.model.strokes.length).toBe(before + 1);

    const select = new SelectTool();
    h.click(select, -400, 760);
    h.drag(select, [-400, 760], [-400, 800]);
    rebuild();
    render();

    const inspect = new InspectTool();
    const junction = h.store.network.junctions.find((j) => j.kind === 'crossing');
    if (junction) {
      h.click(inspect, junction.x, junction.y);
      rebuild();
      render();
    }

    const bulldoze = new BulldozeTool();
    h.click(bulldoze, -400, 800);
    rebuild();
    render();
    expect(h.store.model.strokes.length).toBe(before);

    const underlay = new UnderlayTool();
    h.move(underlay, 0, 0);
    render();

    while (h.store.undo.canUndo) h.store.undo.undo();
    rebuild();
    render();
    expect(h.store.model.strokes.length).toBe(before);
    expect(h.store.network.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('keeps the simulation reproducible across separate runs', () => {
    const a = new AppStore(createDemoDocument());
    a.sim.run(60);
    const b = new AppStore(createDemoDocument());
    b.sim.run(60);
    expect(hashHex(b.sim)).toBe(hashHex(a.sim));
  });
});

describe('editing while traffic runs', () => {
  it('rebuilds the simulation once per gesture, not once per frame', () => {
    const h = harness(createDemoDocument());
    h.store.sim.run(30);
    const before = h.store.sim;

    const select = new SelectTool();
    const stroke = h.store.model.strokes[0];
    const point = { ...stroke.points[1] };
    h.click(select, point.x, point.y);
    expect(h.store.selection.size).toBe(1);

    // A drag held across several frames, each of which recompiles the network.
    const at = (x: number, y: number) => ({
      worldX: x, worldY: y, screenX: 0, screenY: 0,
      button: 0, shift: false, alt: false, ctrl: false,
    });
    h.store.beginEdit();
    select.pointerDown?.(at(point.x, point.y), h.env);
    for (let i = 1; i <= 5; i++) {
      select.pointerMove?.(at(point.x, point.y + i * 4), h.env);
      h.store.flush();
      expect(h.store.simStale).toBe(true);
      expect(h.store.sim).toBe(before);
    }
    select.pointerUp?.(at(point.x, point.y + 20), h.env);
    h.store.endEdit();
    expect(h.store.simStale).toBe(false);
    expect(h.store.sim).not.toBe(before);
    expect(h.store.network.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('rebuilds immediately for an edit that is not a drag', () => {
    const h = harness(createDemoDocument());
    const before = h.store.sim;
    h.store.model.settings.demandScale = 1.4;
    h.store.invalidate();
    h.store.flush();
    expect(h.store.simStale).toBe(false);
    expect(h.store.sim).not.toBe(before);
  });
});
