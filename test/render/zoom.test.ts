/**
 * What a wheel gesture costs.
 *
 * The static layer's whole job is to stop the renderer redrawing a picture it has
 * already drawn. It did that for panning and then threw the saving away for zooming,
 * for a reason that is invisible unless you count the redraws: a wheel does not turn
 * every frame. Notches arrive every 30-60 ms against a 16 ms frame, so most frames of
 * a gesture see an unchanged zoom — and reading "the zoom did not move since last
 * frame" as "the gesture is over" takes the full, sharp redraw *between every notch*.
 *
 * Measured on a two-mile import that was 19 full redraws in 60 frames at 234 ms each.
 * The cache was doing its job on the notches and being thrown away in between, which
 * is worse than having no cache at all, because the stretch is paid for too.
 *
 * Both halves are asserted here, because either one alone is a bug: the gesture must
 * not redraw, and it must sharpen once the hand stops.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubCanvas } from '../helpers/canvasStub';
installCanvasGlobals();

import { Renderer } from '@render/renderer';
import { NetworkPaths } from '@render/networkPaths';
import { compile } from '@core/network/compiler';
import { createDemoDocument } from '@app/demo';

function setup() {
  const net = compile(createDemoDocument());
  const canvas = new StubCanvas();
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
  renderer.camera.fit(net.bounds, 60);
  const paths = new NetworkPaths(net);
  // Nothing is cached while the picture is still being made, so finish it first.
  while (!paths.decorate(1e9)) { /* bake the houses and trees */ }
  const input = {
    network: net, paths, sim: null, alpha: 0, terrain: null, underlay: null, geo: null,
    showGrid: false, showDiagnostics: false, overlays: [],
  };
  return { renderer, input };
}

/** Renders `frames`, moving the zoom one notch every `notch` frames. */
function gesture(
  renderer: Renderer, input: Parameters<Renderer['render']>[0],
  frames: number, notch: number,
): { captures: number; notches: number } {
  const base = renderer.camera.zoom;
  let captures = 0;
  let notches = 0;
  for (let i = 0; i < frames; i++) {
    const step = Math.floor(i / notch);
    const zoom = base * Math.pow(1.05, step);
    if (zoom !== renderer.camera.zoom) notches++;
    renderer.camera.zoom = zoom;
    renderer.render(input);
    captures += renderer.stats.captures;
  }
  return { captures, notches };
}

describe('zooming', () => {
  it('does not redraw the map between wheel notches', () => {
    const { renderer, input } = setup();
    renderer.render(input);            // the first frame captures; that one is the point

    const { captures, notches } = gesture(renderer, input, 30, 3);
    expect(notches, 'the fixture has to actually turn the wheel').toBeGreaterThanOrEqual(9);
    // One redraw per notch is the defect. Stretching the copy is the whole gesture.
    expect(captures, `${captures} redraws for ${notches} notches`).toBeLessThan(3);
  });

  it('sharpens once the wheel stops', async () => {
    const { renderer, input } = setup();
    renderer.render(input);
    gesture(renderer, input, 6, 3);

    // Past the settle window, the next frame owes a redraw at the new zoom: a
    // gesture that never sharpens is a map permanently out of focus.
    await new Promise((r) => { setTimeout(r, 260); });
    renderer.render(input);
    expect(renderer.stats.captures, 'the settled frame redraws').toBe(1);

    // And having redrawn, it goes back to being free.
    renderer.render(input);
    expect(renderer.stats.captures, 'and only once').toBe(0);
  });
});
