/**
 * The road preview: the picture behind both the road-type list and the editor.
 *
 * It has to agree with what the compiler will actually build — same lane count,
 * same order, same total width — because the whole point of drawing it is that
 * picking a road type stops being guesswork.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubContext } from '../helpers/canvasStub';
installCanvasGlobals();

import { drawRoadPreview, previewWidth } from '@render/roadPreview';
import { profileHalfWidth } from '@core/network/model';
import type { RoadProfile } from '@core/network/types';
import {
  groupSign, halfCarriageway, lanesOnSide, medianOf,
} from '@core/network/compiler/layout';

function profile(spec: Partial<RoadProfile>): RoadProfile {
  return {
    id: 3, name: 'test', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    speedLimit: 20, median: 2.4, shoulder: 0.8, isRamp: false, ...spec,
  };
}

function draw(p: RoadProfile, w = 200, h = 90, options = {}) {
  const ctx = new StubContext();
  const bands = drawRoadPreview(ctx as unknown as CanvasRenderingContext2D, p, w, h, options);
  return { ctx, bands };
}

/** Every horizontal line the preview stroked, as an offset in metres. */
function markingOffsets(ctx: StubContext, height: number, metresPerPixel: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < ctx.calls.length; k++) {
    if (ctx.calls[k].op !== 'moveTo') continue;
    const next = ctx.calls[k + 1];
    if (!next || next.op !== 'lineTo') continue;
    const y = ctx.calls[k].args[1] as number;
    if (Math.abs((next.args[1] as number) - y) > 0.01) continue; // not horizontal
    out.push((y - height / 2) * metresPerPixel);
  }
  return out;
}

/** What `buildSegments` would emit for this profile, as offsets in metres. */
function compilerOffsets(p: RoadProfile, driveOnRight = true): number[] {
  const half = halfCarriageway(p);
  const out = [half, -half];
  for (const side of [1, -1] as const) {
    const g = groupSign(side, driveOnRight);
    for (let k = 1; k < lanesOnSide(p, side); k++) out.push(g * (half - k * p.laneWidth));
  }
  if (p.lanesForward > 0 && p.lanesBackward > 0) {
    if (medianOf(p) > 0) out.push(medianOf(p) / 2, -medianOf(p) / 2);
    else out.push(0);
  }
  return out.sort((a, b) => a - b);
}

describe('road preview', () => {
  /**
   * The picture is only worth drawing if it agrees with the road. It used to derive
   * lane dividers itself — "on the outer side of every lane but the outermost,
   * outer being the sign of its offset" — which holds only when a direction group
   * sits wholly on one side of the centreline. A one-way road straddles it, so on
   * every one-way profile the dividers went on the *outside* of the carriageway and
   * a two-lane ramp drew as a plain grey bar.
   */
  it('marks the road in exactly the places the compiler would', () => {
    for (const spec of [
      { lanesForward: 2, lanesBackward: 0, median: 0 },
      { lanesForward: 3, lanesBackward: 0, median: 0 },
      { lanesForward: 5, lanesBackward: 0, median: 0 },
      { lanesForward: 0, lanesBackward: 2, median: 0 },
      { lanesForward: 1, lanesBackward: 1, median: 0 },
      { lanesForward: 2, lanesBackward: 2, median: 0 },
      { lanesForward: 3, lanesBackward: 3, median: 6 },
      { lanesForward: 3, lanesBackward: 1, median: 2 },
      { lanesForward: 1, lanesBackward: 3, median: 2 },
    ]) {
      const p = profile(spec);
      const height = 400;
      const { ctx } = draw(p, 200, height);
      const scale = (height - 6) / previewWidth(p, false);
      const drawn = markingOffsets(ctx, height, 1 / scale).sort((a, b) => a - b);
      const wanted = compilerOffsets(p);
      const label = `${p.lanesForward}+${p.lanesBackward} median ${p.median}`;
      expect(drawn.length, `${label}: line count`).toBe(wanted.length);
      for (let i = 0; i < wanted.length; i++) {
        expect(drawn[i], `${label}: line ${i}`).toBeCloseTo(wanted[i], 1);
      }
    }
  });

  it('draws one band per lane, in cross-section order', () => {
    const { bands } = draw(profile({ lanesForward: 3, lanesBackward: 2 }));
    const lanes = bands.filter((b) => b.kind === 'lane');
    expect(lanes.length).toBe(5);
    // Top to bottom, no two lanes overlapping and none inverted.
    const sorted = [...lanes].sort((a, b) => a.y0 - b.y0);
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i].y1).toBeGreaterThan(sorted[i].y0);
      if (i) expect(sorted[i].y0).toBeGreaterThanOrEqual(sorted[i - 1].y1 - 0.01);
    }
  });

  it('scales to the road the compiler would build', () => {
    const p = profile({ verge: 4 });
    expect(previewWidth(p, false)).toBeCloseTo(profileHalfWidth(p) * 2, 5);
    expect(previewWidth(p, true)).toBeCloseTo(profileHalfWidth(p) * 2 + 8, 5);
  });

  it('fits the whole road inside the box it was given', () => {
    for (const spec of [
      { lanesForward: 1, lanesBackward: 1, median: 0, verge: 6 },
      { lanesForward: 4, lanesBackward: 4, median: 8, shoulder: 2.5 },
      { lanesForward: 2, lanesBackward: 0, median: 0 },
    ]) {
      const { bands } = draw(profile(spec), 200, 90);
      for (const band of bands) {
        expect(band.y0, JSON.stringify(spec)).toBeGreaterThanOrEqual(-0.01);
        expect(band.y1, JSON.stringify(spec)).toBeLessThanOrEqual(90.01);
      }
    }
  });

  it('paints a yellow line between opposing traffic and none on a one-way', () => {
    const two = draw(profile({}));
    const one = draw(profile({ lanesForward: 3, lanesBackward: 0, median: 0 }));
    const yellows = (c: StubContext): number =>
      c.calls.filter((k) => k.op === 'stroke').length;
    expect(yellows(two.ctx)).toBeGreaterThan(yellows(one.ctx));
  });

  it('draws a direction arrow per lane only when asked', () => {
    const plain = draw(profile({}));
    const arrows = draw(profile({}), 200, 90, { direction: true });
    expect(arrows.ctx.count('fill')).toBeGreaterThan(plain.ctx.count('fill'));
  });

  it('leaves the context balanced', () => {
    const { ctx } = draw(profile({ verge: 5 }), 200, 90, { direction: true });
    expect(ctx.balanced).toBe(true);
  });
});
