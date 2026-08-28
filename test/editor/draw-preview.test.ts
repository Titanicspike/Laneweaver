/**
 * The road that lands is the road that was shown.
 *
 * The draw tool auto-smooths every point the user did not shape by hand — but it
 * did so only when the road was finished. While drawing, the preview used the raw
 * handles, which for an untouched point sit on the point itself: a chain of straight
 * lines with sharp corners that turned into a smooth curve the moment Enter was
 * pressed. The preview now shapes its points the same way `finish` does, with the
 * cursor as a provisional last point, because a point's handles depend on the point
 * after it.
 */

import { describe, expect, it } from 'vitest';
import { DrawTool } from '@editor/tools/drawTool';
import { autoSmoothHandles, cloneControlPoint, makeControlPoint } from '@core/network/model';
import type { ControlPoint } from '@core/network/types';
import { harness } from '../helpers/editor';

describe('the draw preview', () => {
  it('shows the smoothed curve the finished road will have', () => {
    const h = harness();
    const tool = new DrawTool();
    for (const [x, y] of [[0, 0], [200, 120], [400, 0]] as const) h.click(tool, x, y);
    h.move(tool, 600, 120);
    const inner = tool as unknown as {
      points: ControlPoint[];
      shaped(p: ControlPoint[], c?: { x: number; y: number }): ControlPoint[];
    };
    expect(inner.points.length).toBe(3);

    // What the preview draws, with the cursor further along.
    const shown = inner.shaped(inner.points, { x: 600, y: 120 });
    // The middle point is auto: its handles must be smoothed, not sitting on it.
    expect(Math.hypot(shown[1].hox - shown[1].x, shown[1].hoy - shown[1].y)).toBeGreaterThan(10);
    // And they are exactly what finishing would give the same points plus that one.
    const reference = [...inner.points.map(cloneControlPoint), makeControlPoint(600, 120, 0)];
    autoSmoothHandles(reference);
    for (let i = 0; i < 3; i++) {
      expect(shown[i].hox).toBeCloseTo(reference[i].hox, 6);
      expect(shown[i].hoy).toBeCloseTo(reference[i].hoy, 6);
      expect(shown[i].hix).toBeCloseTo(reference[i].hix, 6);
      expect(shown[i].hiy).toBeCloseTo(reference[i].hiy, 6);
    }

    // Finish: the built road carries the handles the preview showed for the placed
    // points — the last one's differ only because nothing came after it.
    tool.finish(h.env);
    h.settle();
    const stroke = h.store.model.strokes[h.store.model.strokes.length - 1];
    expect(stroke.points.length).toBe(3);
    expect(stroke.points[1].hox).toBeCloseTo(shown[1].hox, 6);
    expect(stroke.points[1].hoy).toBeCloseTo(shown[1].hoy, 6);
  });
});
