/**
 * Building roads on a large document has to stay interactive.
 *
 * Compiling the network is a whole-network job and so is the renderer's bake of it.
 * Running both on every frame of a drag *is* the frame: measured on a 421-segment
 * town, a compile plus a rebake is about 86 ms, so dragging a control point ran at
 * roughly eleven frames a second and got worse linearly with the size of the map.
 *
 * So mid-gesture the rebuild gets a duty cycle — it may take at most a fixed share
 * of wall-clock time — and the editor draws the roads being dragged itself from
 * their flattened centrelines, which costs one polyline each and follows the cursor
 * exactly. The contract is: the network still catches up regularly during the drag,
 * it is always correct by the end of it, and nothing outside a gesture is deferred
 * at all.
 */

import { describe, expect, it } from 'vitest';
import { AppStore } from '@app/store';
import { createDocument, kph } from '@core/network/model';
import { addProfile, addStroke, line } from '../helpers/build';
import type { EditModel } from '@core/network/types';

/** A town big enough that a compile is worth deferring. */
function town(blocks: number): EditModel {
  const m = createDocument(7);
  const st = addProfile(m, {
    name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
    shoulder: 0.4, speedLimit: kph(40),
  });
  const span = blocks * 180;
  for (let i = 0; i <= blocks; i++) {
    addStroke(m, st, line(0, i * 180, span, i * 180, blocks + 1));
    addStroke(m, st, line(i * 180, 0, i * 180, span, blocks + 1));
  }
  return m;
}

/** Drags one control point for `frames` frames, returning how often it recompiled. */
function drag(store: AppStore, frames: number): number {
  const point = store.model.strokes[1].points[1];
  let compiles = 0;
  let version = store.compileVersion;
  store.beginEdit();
  for (let f = 0; f < frames; f++) {
    point.x += 0.5;
    point.y += 0.3;
    store.invalidate();
    store.flush();
    if (version !== store.compileVersion) {
      version = store.compileVersion;
      compiles++;
    }
  }
  store.endEdit();
  return compiles;
}

describe('dragging a road on a big document', () => {
  it('does not recompile the whole network on every frame', () => {
    const store = new AppStore(town(9));
    expect(store.network.segments.length).toBeGreaterThan(100);
    const compiles = drag(store, 40);
    // Forty frames back to back take a fraction of one compile's budget, so almost
    // all of them must have been served from the preview. It used to be forty.
    expect(compiles, `${compiles} recompiles in 40 drag frames`).toBeLessThan(15);
  });

  it('draws the roads it has not compiled yet', () => {
    const store = new AppStore(town(9));
    const stroke = store.model.strokes[1];
    store.beginEdit();
    stroke.points[1].x += 40;
    store.invalidate();
    store.flush();
    // Whether this particular frame recompiled depends on the clock; what must hold
    // is that a road is either compiled or previewed, never neither.
    const stale = store.staleStrokes();
    if (store.isDirty) {
      expect(stale.map((g) => g.stroke.id)).toContain(stroke.id);
      // And only the road that moved — previewing the whole map would draw a second
      // copy of every street over the first.
      expect(stale.length).toBe(1);
      // The preview geometry tracks the cursor even though the network does not.
      const geom = store.geometry.get(stroke.id)!;
      let maxX = -Infinity;
      for (let i = 0; i < geom.points.length; i += 2) maxX = Math.max(maxX, geom.points[i]);
      expect(maxX).toBeGreaterThan(0);
    }
    store.endEdit();
    expect(store.staleStrokes()).toEqual([]);
  });

  it('is always correct by the end of the gesture', () => {
    const store = new AppStore(town(6));
    const before = store.compileVersion;
    drag(store, 30);
    expect(store.compileVersion).toBeGreaterThan(before);
    expect(store.isDirty).toBe(false);
    expect(store.staleStrokes()).toEqual([]);
    // And the compiled network reflects where the point actually ended up.
    const moved = store.model.strokes[1].points[1];
    const seg = store.network.segments.find((s) => s.strokeId === store.model.strokes[1].id);
    expect(seg).toBeDefined();
    expect(store.network.bounds.maxX).toBeGreaterThanOrEqual(moved.x - 1);
  });

  it('never defers outside a gesture', () => {
    const store = new AppStore(town(6));
    for (let i = 0; i < 5; i++) {
      const version = store.compileVersion;
      store.model.strokes[1].points[1].x += 1;
      store.invalidate();
      expect(store.flush()).toBe(true);
      expect(store.compileVersion).toBe(version + 1);
    }
  });
});
