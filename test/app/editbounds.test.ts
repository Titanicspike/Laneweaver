/**
 * Where an edit was, for deciding what may be kept.
 *
 * The renderer keeps the previous picture's houses everywhere an edit cannot have
 * reached, so the answer to "where was the edit" has to be small when the edit was
 * small. The first version answered with the changed stroke's whole bounding box —
 * and on a grid town every street spans the map, so moving one control point on a
 * four-kilometre street reported a four-kilometre edit and the entire row of houses
 * refilled. A control point moves the two bezier spans beside it and nothing else,
 * which is what is answered now.
 */

import { describe, expect, it } from 'vitest';
import { AppStore } from '@app/store';
import { exampleById } from '@app/examples';
import { kph } from '@core/network/model';
import { addProfile, addStroke, doc, line } from '../helpers/build';

describe('the area round an edit', () => {
  it('is the spans a moved control point touches, not the whole street', () => {
    // A four-kilometre street with a control point every 200 m, crossed by a few
    // side streets; move one point in the middle.
    const model = doc(3);
    const st = addProfile(model, {
      name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
    });
    const stroke = addStroke(model, st, line(0, 0, 4000, 0, 21));
    for (const x of [1000, 2000, 3000]) addStroke(model, st, line(x, -300, x, 300));
    const store = new AppStore(model);
    expect(stroke.points.length).toBe(21);
    const streetLength = Math.hypot(
      stroke.points[stroke.points.length - 1].x - stroke.points[0].x,
      stroke.points[stroke.points.length - 1].y - stroke.points[0].y,
    );
    const mid = stroke.points[Math.floor(stroke.points.length / 2)];
    mid.x += 20;
    mid.y += 15;
    store.invalidate();
    store.flush();

    const box = store.editBounds!;
    expect(box).not.toBeNull();
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    // Covers the moved point and its neighbours' spans, with the halo...
    expect(Math.max(w, h)).toBeGreaterThan(100);
    // ...and nothing like the whole street.
    expect(Math.max(w, h), `edit area ${w.toFixed(0)} x ${h.toFixed(0)} on a ${streetLength.toFixed(0)} m street`)
      .toBeLessThan(streetLength * 0.5);
    expect(box.minX).toBeLessThan(mid.x);
    expect(box.maxX).toBeGreaterThan(mid.x);
  });

  it('is nothing when no road changed shape', () => {
    const store = new AppStore(exampleById('town')!.build());
    // A control choice changes the network but moves no road.
    const j = store.network.junctions.find((x) => x.kind === 'crossing')!;
    store.model.junctions.push({ x: j.x, y: j.y, control: 'signal' });
    store.invalidate();
    store.flush();
    expect(store.editBounds).toBeNull();
  });

  it('covers where a deleted road used to be', () => {
    const store = new AppStore(exampleById('town')!.build());
    const gone = store.model.strokes[3];
    const at = gone.points[1];
    store.model.strokes.splice(3, 1);
    store.invalidate();
    store.flush();
    const box = store.editBounds!;
    expect(box).not.toBeNull();
    expect(at.x).toBeGreaterThanOrEqual(box.minX);
    expect(at.x).toBeLessThanOrEqual(box.maxX);
    expect(at.y).toBeGreaterThanOrEqual(box.minY);
    expect(at.y).toBeLessThanOrEqual(box.maxY);
  });
});
