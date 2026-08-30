/**
 * The cached bitmap of the picture that does not move.
 *
 * Panning a big map used to redraw every road, every marking, every house and every
 * tree, in the same place and the same colours as the frame before, because the
 * camera had moved a few pixels. On a two-mile import that was 202 ms a frame at
 * zoom 0.3 and 38 ms at street level — three to twenty-five frames a second on a
 * fast machine, and the complaint that started this was about slow ones.
 *
 * Two things have to be true of a cache like this or it is worse than none: it must
 * never show a picture that is out of date, and it must never show one that does not
 * reach the edges of the window. Everything here is one of those two.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubCanvas, StubContext } from '../helpers/canvasStub';
installCanvasGlobals();

import { Camera } from '@render/camera';
import { StaticLayer } from '@render/staticLayer';

/** A camera at a round zoom, so pixel snapping never rounds a test's arithmetic. */
function camera(x = 0, y = 0): Camera {
  const cam = new Camera();
  cam.width = 400;
  cam.height = 300;
  cam.devicePixelRatio = 1;
  cam.zoom = 1;
  cam.x = x;
  cam.y = y;
  return cam;
}

function context(): StubContext {
  return new StubCanvas().context as unknown as StubContext;
}

/** How many times `draw` was asked to paint, and over what. */
function recorder(): { calls: { only: unknown }[]; draw: Parameters<StaticLayer['capture']>[3] } {
  const calls: { only: unknown }[] = [];
  return {
    calls,
    draw: (_target, _cam, only) => { calls.push({ only }); },
  };
}

describe('the static layer', () => {
  it('will not blit before it has captured anything', () => {
    const layer = new StaticLayer();
    expect(layer.blit(context() as never, camera(), 0)).toBe(false);
  });

  it('captures once and then reuses it for a small pan', () => {
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    expect(layer.capture(ctx as never, camera(), 0, rec.draw)).toBe(true);
    expect(rec.calls.length).toBe(1);
    // The first capture has nothing to reuse, so it is asked for the whole picture.
    expect(rec.calls[0].only).toBeNull();

    // A pan well inside the margin needs no drawing at all.
    for (const dx of [5, 10, 20, 40]) {
      expect(layer.blit(ctx as never, camera(dx, 0), 0)).toBe(true);
    }
    expect(rec.calls.length).toBe(1);
  });

  it('stops reusing it once the view leaves the margin', () => {
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    // The bitmap is 1.4 viewports wide, so 0.2 of one is the slack on each side.
    expect(layer.blit(ctx as never, camera(39, 0), 0)).toBe(true);
    expect(layer.blit(ctx as never, camera(300, 0), 0)).toBe(false);
  });

  it('redraws only the strip that came into view', () => {
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    layer.capture(ctx as never, camera(120, 0), 0, rec.draw);
    // One strip, not the whole picture: this is the difference between a stutter
    // twice a second and none.
    expect(rec.calls.length).toBe(2);
    const only = rec.calls[1].only as { minX: number; maxX: number } | null;
    expect(only, 'the second capture is given a region, not the whole map').not.toBeNull();
    expect(only!.maxX - only!.minX).toBeLessThan(400);
  });

  it('redraws the lot when the zoom changes', () => {
    // Scrolling a bitmap can move a picture; it cannot rescale one.
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    const zoomed = camera();
    zoomed.zoom = 2;
    expect(layer.blit(ctx as never, zoomed, 0)).toBe(false);
    layer.capture(ctx as never, zoomed, 0, rec.draw);
    expect(rec.calls[1].only, 'a rescale is not a scroll').toBeNull();
  });

  it('stretches what it has while the zoom is moving', () => {
    // A redraw is the only way to be right at a new zoom, and on a big map that is
    // two hundred milliseconds — once per notch of the wheel. Stretching is what
    // every map does instead: soft while the wheel turns, sharp when it stops.
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    const zoomed = camera();
    zoomed.zoom = 1.3;
    expect(layer.blit(ctx as never, zoomed, 0), 'not as an exact copy').toBe(false);
    expect(layer.blitScaled(ctx as never, zoomed, 0)).toBe(true);
    expect(rec.calls.length, 'and without drawing anything').toBe(1);
  });

  it('refuses to stretch past the point of being worth looking at', () => {
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    const far = camera();
    far.zoom = 8;
    expect(layer.blitScaled(ctx as never, far, 0)).toBe(false);
  });

  it('refuses to stretch where the copy no longer reaches the edges', () => {
    // Zooming *out* shows more world than the bitmap holds, however it is scaled.
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    const out = camera();
    out.zoom = 0.5;
    expect(layer.blitScaled(ctx as never, out, 0)).toBe(false);
  });

  it('never serves one grade from another grade copy', () => {
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    expect(layer.blit(ctx as never, camera(), 1)).toBe(false);
  });

  it('forgets everything when told the picture changed', () => {
    const layer = new StaticLayer();
    const ctx = context();
    const rec = recorder();
    layer.capture(ctx as never, camera(), 0, rec.draw);
    expect(layer.blit(ctx as never, camera(), 0)).toBe(true);
    layer.invalidate();
    expect(layer.blit(ctx as never, camera(), 0)).toBe(false);
    layer.capture(ctx as never, camera(), 0, rec.draw);
    expect(rec.calls[1].only, 'an edit is redrawn, not scrolled').toBeNull();
  });

  it('gives up rather than throwing where a canvas cannot blit', () => {
    // The jsdom canvas in the application tests has no `drawImage`, and a renderer
    // that assumed one would fail half way through a frame.
    const layer = new StaticLayer();
    const bare = { } as unknown as CanvasRenderingContext2D;
    const rec = recorder();
    expect(layer.blit(bare, camera(), 0)).toBe(false);
    expect(layer.capture(bare, camera(), 0, rec.draw)).toBe(false);
    expect(rec.calls.length).toBe(0);
  });
});
