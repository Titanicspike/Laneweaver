/**
 * Verge planting.
 *
 * The one thing that must never happen is a tree standing in the carriageway, and
 * that is exactly what a naive "offset from the centreline" placement does as soon
 * as a road widens for a turn bay or another road runs alongside. Placement follows
 * the segment's own asphalt outline and drops anything that still lands on pavement.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubPath2D } from '../helpers/canvasStub';
installCanvasGlobals();

import { NetworkPaths } from '@render/networkPaths';
import { compile } from '@core/network/compiler';
import type { Network } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';

const VIEW = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 };

/** Every tree centre, recovered from the arc calls the crowns are built from. */
function treeCentres(net: Network): Array<[number, number]> {
  const paths = new NetworkPaths(net);
  const out: Array<[number, number]> = [];
  for (const grade of paths.grades) {
    for (const tile of paths.query(grade, VIEW)) {
      for (const op of (tile.trees as unknown as StubPath2D).ops) {
        if (op.op === 'arc') out.push([op.args[0] as number, op.args[1] as number]);
      }
    }
  }
  return out;
}

function inRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  const n = ring.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function street(verge: number) {
  const model = doc();
  const profile = addProfile(model, {
    name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
    shoulder: 0.4, speedLimit: 11, verge,
  });
  const arterial = addProfile(model, {
    name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    shoulder: 0.8, median: 2.4, speedLimit: 20, verge: 2.5,
  });
  addStroke(model, profile, line(-400, 0, 400, 0));
  addStroke(model, arterial, line(0, -400, 0, 400));
  return compile(model);
}

describe('verge planting', () => {
  it('plants a road whose profile asks for it, and only then', () => {
    expect(treeCentres(street(4)).length).toBeGreaterThan(40);
    const bare = compile((() => {
      const model = doc();
      const profile = addProfile(model, {
        name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4,
      });
      addStroke(model, profile, line(-400, 0, 400, 0));
      return model;
    })());
    expect(treeCentres(bare).length).toBe(0);
  });

  it('never stands a tree on any road or junction', () => {
    const net = street(6);
    const centres = treeCentres(net);
    expect(centres.length).toBeGreaterThan(20);
    for (const [x, y] of centres) {
      for (const seg of net.segments) {
        expect(inRing(seg.surface, x, y), `tree (${x.toFixed(0)},${y.toFixed(0)}) on seg ${seg.id}`)
          .toBe(false);
      }
      for (const j of net.junctions) {
        if (j.footprint.length < 6) continue;
        expect(inRing(j.footprint, x, y), `tree (${x.toFixed(0)},${y.toFixed(0)}) in junction ${j.id}`)
          .toBe(false);
      }
    }
  });

  it('stays close to the road it belongs to', () => {
    const net = street(5);
    for (const [x, y] of treeCentres(net)) {
      let best = Infinity;
      for (const seg of net.segments) {
        for (let i = 0; i + 1 < seg.centerline.length; i += 2) {
          best = Math.min(best, Math.hypot(x - seg.centerline[i], y - seg.centerline[i + 1]));
        }
      }
      // Half the road plus its verge, with room for the sampling step.
      expect(best).toBeLessThan(20);
    }
  });

  it('gives the same planting every time it is baked', () => {
    const net = street(4);
    expect(treeCentres(net)).toEqual(treeCentres(net));
  });
});
