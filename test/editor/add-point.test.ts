/**
 * Adding a point where the road does not go.
 *
 * Alt-click already added a point *on* a road — de Casteljau, so the shape does not
 * move and all you get is another handle. What it could not do was add a point
 * somewhere the road had never been, which is the other half of what people mean:
 * carry the road on past its end, or make it bend through a place it misses.
 *
 * Which of those two you get is decided by where the click is *along* the road, not
 * by which part of it happens to be nearest: standing off to one side of the last
 * few metres is a bend in that span, and the same distance further on is the road
 * carrying on.
 */

import { describe, expect, it } from 'vitest';
import { SelectTool } from '@editor/tools/selectTool';
import { addControlPointAt, addPlacement } from '@editor/curveEdit';
import { flattenStroke, makeControlPoint } from '@core/network/model';
import type { ControlPoint } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { harness } from '../helpers/editor';

/** A straight road along +x, auto-smoothed the way the draw tool leaves one. */
function road(): ControlPoint[] {
  return [makeControlPoint(0, 0), makeControlPoint(100, 0), makeControlPoint(200, 0)];
}

/** How far the road passes from a point, by its flattened centreline. */
function missBy(points: ControlPoint[], x: number, y: number): number {
  const flat = flattenStroke({ id: 1, profileId: 1, points }, 0.1);
  let best = Infinity;
  for (let i = 0; i < flat.points.length; i += 2) {
    best = Math.min(best, Math.hypot(flat.points[i] - x, flat.points[i + 1] - y));
  }
  return best;
}

describe('adding a point off the road', () => {
  it('carries the road on past its end', () => {
    const before = road();
    const where = addPlacement(before, 300, 40);
    expect(where).toEqual({ kind: 'extend', atStart: false });

    const after = addControlPointAt(before, 300, 40)!;
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1].x).toBeCloseTo(300);
    expect(after[after.length - 1].y).toBeCloseTo(40);
    // Everything that was there is still where it was.
    for (let i = 0; i < before.length; i++) {
      expect(after[i].x).toBeCloseTo(before[i].x);
      expect(after[i].y).toBeCloseTo(before[i].y);
    }
    expect(missBy(after, 300, 40)).toBeLessThan(0.5);
  });

  it('carries it on past the other end too', () => {
    const before = road();
    expect(addPlacement(before, -120, -30)).toEqual({ kind: 'extend', atStart: true });
    const after = addControlPointAt(before, -120, -30)!;
    expect(after[0].x).toBeCloseTo(-120);
    expect(after[0].y).toBeCloseTo(-30);
    expect(after.length).toBe(4);
  });

  it('bends the road through a point beside it', () => {
    const before = road();
    const where = addPlacement(before, 150, 60);
    expect(where).toEqual({ kind: 'bend', segment: 1 });

    const after = addControlPointAt(before, 150, 60)!;
    expect(after.length).toBe(4);
    // The road now goes there, and it did not before.
    expect(missBy(before, 150, 60)).toBeGreaterThan(50);
    expect(missBy(after, 150, 60)).toBeLessThan(0.5);
    // Both ends stay put: adding a point in the middle is not a way to move a road.
    expect(after[0].x).toBeCloseTo(0);
    expect(after[after.length - 1].x).toBeCloseTo(200);
  });

  it('tells a bend beside the last span from an extension past it', () => {
    // Same distance from the road, opposite sides of its end.
    const before = road();
    expect(addPlacement(before, 190, 40)?.kind).toBe('bend');
    expect(addPlacement(before, 210, 40)?.kind).toBe('extend');
  });

  it('leaves the rest of the road shape alone', () => {
    // A hand-shaped kink at the far end survives a point added at the near one.
    const before = road();
    before[2].hix = 160;
    before[2].hiy = -70;
    const after = addControlPointAt(before, -50, 20)!;
    const far = after[after.length - 1];
    expect(far.hix).toBeCloseTo(160);
    expect(far.hiy).toBeCloseTo(-70);
  });

  it('is what Alt-click does in open space, on the selected road', () => {
    const m = doc(3);
    const p = addProfile(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2 });
    addStroke(m, p, line(0, 0, 200, 0));
    const h = harness(m);
    h.settle();
    const tool = new SelectTool();

    // Nothing selected: the click says so rather than guessing a road.
    h.click(tool, 320, 40, { alt: true });
    h.settle();
    expect(h.store.model.strokes[0].points.length).toBe(2);

    h.click(tool, 100, 0);          // select the road
    h.click(tool, 320, 40, { alt: true });
    h.settle();
    const points = h.store.model.strokes[0].points;
    expect(points.length).toBe(3);
    expect(points[2].x).toBeCloseTo(320);
    expect(points[2].y).toBeCloseTo(40);
    // And it is one undo step, like every other edit.
    h.store.undo.undo();
    h.settle();
    expect(h.store.model.strokes[0].points.length).toBe(2);
  });

  it('still adds a point on the road without moving it', () => {
    // The other half of the gesture, unchanged: clicking the road itself subdivides.
    const m = doc(3);
    const p = addProfile(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2 });
    addStroke(m, p, line(0, 0, 200, 0));
    const h = harness(m);
    h.settle();
    const tool = new SelectTool();
    h.click(tool, 100, 0, { alt: true });
    h.settle();
    const points = h.store.model.strokes[0].points;
    expect(points.length).toBe(3);
    expect(missBy(points, 100, 0)).toBeLessThan(0.1);
    expect(points[0].x).toBeCloseTo(0);
    expect(points[2].x).toBeCloseTo(200);
  });
});
