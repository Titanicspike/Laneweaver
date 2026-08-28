import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, type StubPath2D } from '../helpers/canvasStub';
import { Camera } from '@render/camera';
import { NetworkPaths, lineWidth } from '@render/networkPaths';
import { compile } from '@core/network/compiler';
import { createDemoDocument } from '@app/demo';

// Installed before any describe body runs, which is where paths get built.
installCanvasGlobals();

describe('camera', () => {
  const camera = new Camera();
  camera.width = 800;
  camera.height = 600;
  camera.zoom = 2;
  camera.x = 100;
  camera.y = 50;

  it('round-trips world and screen coordinates', () => {
    for (const [x, y] of [[0, 0], [123.5, -44], [1e4, -1e4]]) {
      expect(camera.screenToWorldX(camera.worldToScreenX(x))).toBeCloseTo(x, 6);
      expect(camera.screenToWorldY(camera.worldToScreenY(y))).toBeCloseTo(y, 6);
    }
  });

  it('puts the camera centre at the middle of the viewport', () => {
    expect(camera.worldToScreenX(100)).toBeCloseTo(400, 6);
    expect(camera.worldToScreenY(50)).toBeCloseTo(300, 6);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const c = new Camera();
    c.width = 800;
    c.height = 600;
    const before = { x: c.screenToWorldX(620), y: c.screenToWorldY(140) };
    c.zoomAt(620, 140, 2.5);
    expect(c.screenToWorldX(620)).toBeCloseTo(before.x, 6);
    expect(c.screenToWorldY(140)).toBeCloseTo(before.y, 6);
  });

  it('clamps zoom to sane limits', () => {
    const c = new Camera();
    for (let i = 0; i < 200; i++) c.zoomAt(0, 0, 0.5);
    expect(c.zoom).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) c.zoomAt(0, 0, 2);
    expect(c.zoom).toBeLessThanOrEqual(24);
  });

  it('fits bounds inside the viewport', () => {
    const c = new Camera();
    c.width = 800;
    c.height = 600;
    c.fit({ minX: -500, minY: -100, maxX: 500, maxY: 100 }, 50);
    const view = c.visibleRect();
    expect(view.minX).toBeLessThanOrEqual(-500);
    expect(view.maxX).toBeGreaterThanOrEqual(500);
    expect(c.x).toBeCloseTo(0, 6);
  });

  it('reports a visible rectangle that matches the transform', () => {
    const view = camera.visibleRect();
    expect(view.minX).toBeCloseTo(camera.screenToWorldX(0), 6);
    expect(view.maxY).toBeCloseTo(camera.screenToWorldY(600), 6);
  });

  it('never draws a hairline thinner than the pixel floor', () => {
    expect(lineWidth(0, 4)).toBeGreaterThan(0);
    expect(lineWidth(0.1, 0.05)).toBeGreaterThan(0.1);
    expect(lineWidth(5, 4)).toBe(5);
  });
});

describe('network paths', () => {
  const net = compile(createDemoDocument());
  const paths = new NetworkPaths(net);

  it('finds every grade in the network', () => {
    expect(paths.grades).toContain(0);
    expect(paths.grades).toContain(1);
    expect(paths.grades[0]).toBeLessThan(paths.grades[paths.grades.length - 1]);
  });

  it('buckets geometry into tiles that can be culled', () => {
    const all = paths.query(0, { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 }).length;
    const none = paths.query(0, { minX: 1e5, minY: 1e5, maxX: 1e5 + 10, maxY: 1e5 + 10 }).length;
    expect(all).toBeGreaterThan(0);
    expect(none).toBe(0);
  });

  it('emits real geometry for asphalt and markings', () => {
    const tiles = paths.query(0, { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 });
    let asphalt = 0;
    let dashed = 0;
    for (const tile of tiles) {
      asphalt += (tile.asphalt as unknown as StubPath2D).length;
      dashed += (tile.dashed as unknown as StubPath2D).length;
    }
    expect(asphalt).toBeGreaterThan(50);
    expect(dashed).toBeGreaterThan(20);
  });
});
