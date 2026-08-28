/**
 * Lane-use arrows, checked as geometry.
 *
 * Which way an arrow bends is easy to get backwards and nearly impossible to see
 * in a screenshot at map zoom, so it is pinned here instead: with the symbol
 * pointing along +x, a right turn must reach into +y and a left turn into -y,
 * because screen +y is down and the world is right-hand-drive.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubPath2D } from '../helpers/canvasStub';
installCanvasGlobals();

import { NetworkPaths } from '@render/networkPaths';
import { compile } from '@core/network/compiler';
import { TurnKind } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';

describe('lane-use arrows', () => {
  const bake = (turns: TurnKind[], heading = 0): Array<[number, number]> => {
    const model = doc();
    const street = addProfile(model, {
      name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, shoulder: 0.5,
    });
    addStroke(model, street, line(-100, 0, 100, 0));
    const net = compile(model);
    net.segments[0].symbols = [{ kind: 'arrow', x: 0, y: 0, heading, turns, width: 3.5 }];
    const paths = new NetworkPaths(net);
    const tiles = paths.query(0, { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 });
    const out: Array<[number, number]> = [];
    for (const tile of tiles) {
      for (const op of (tile.arrows as unknown as StubPath2D).ops) {
        if (op.op === 'moveTo' || op.op === 'lineTo') {
          out.push([op.args[0] as number, op.args[1] as number]);
        }
      }
    }
    return out;
  };

  /** Where the stem sits laterally: the mean of the points furthest back. */
  const stemAt = (pts: Array<[number, number]>): number => {
    const back = Math.min(...pts.map((p) => p[0]));
    const tail = pts.filter((p) => p[0] < back + 0.05);
    return tail.reduce((sum, p) => sum + p[1], 0) / tail.length;
  };

  it('bends a right turn toward the kerb and a left turn toward the median', () => {
    const right = bake([TurnKind.Right]);
    const left = bake([TurnKind.Left]);
    expect(right.length).toBeGreaterThan(8);
    // The head has to end up on the far side of the stem it grew out of, and only
    // that side: an arrow that reaches both ways is not saying anything.
    expect(Math.max(...right.map((p) => p[1])) - stemAt(right)).toBeGreaterThan(1);
    expect(stemAt(right) - Math.min(...right.map((p) => p[1]))).toBeLessThan(0.3);
    expect(stemAt(left) - Math.min(...left.map((p) => p[1]))).toBeGreaterThan(1);
    expect(Math.max(...left.map((p) => p[1])) - stemAt(left)).toBeLessThan(0.3);
  });

  it('points a through arrow the way the lane runs', () => {
    const east = bake([TurnKind.Straight]);
    const west = bake([TurnKind.Straight], Math.PI);
    // The tip is the extreme point along travel.
    expect(Math.max(...east.map((p) => p[0]))).toBeGreaterThan(2);
    expect(Math.min(...west.map((p) => p[0]))).toBeLessThan(-2);
  });

  it('keeps a combined arrow inside its lane', () => {
    for (const turns of [
      [TurnKind.Straight, TurnKind.Right],
      [TurnKind.Left, TurnKind.Right],
      [TurnKind.Straight, TurnKind.Left, TurnKind.Right],
      [TurnKind.Left],
    ]) {
      const pts = bake(turns);
      const span = Math.max(...pts.map((p) => Math.abs(p[1])));
      expect(span, `turns ${turns}`).toBeLessThan(3.5 / 2);
    }
  });
});
