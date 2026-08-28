/**
 * An edit refills its own surroundings, not the whole town.
 *
 * Decoration — houses and trees — is baked off the editing path, a road per slice,
 * so a large town's picture no longer freezes at the end of every edit. The first
 * version of that had a side effect nobody would thank us for: the new picture
 * started empty, so every edit emptied the whole map of houses and refilled it over
 * the next forty frames. "Changing one road reloads the entire town." It does not:
 * only the road changed, and a plot depends on nothing further away than a
 * house-depth. So the previous picture's decoration stays up wherever the edit
 * cannot have reached, and only the area round the edit visibly refills.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installCanvasGlobals } from '../helpers/canvasStub';
import { compile } from '@core/network/compiler';
import { exampleById } from '@app/examples';
import type { Bbox } from '@core/geom/polyline';

let restore: () => void;
beforeAll(() => { restore = installCanvasGlobals(); });
afterAll(() => restore());

describe('decoration carried over an edit', () => {
  it('keeps the old houses away from the edit and refills only round it', async () => {
    const { NetworkPaths } = await import('@render/networkPaths');
    const model = exampleById('town')!.build();
    const before = new NetworkPaths(compile(model));
    expect(before.decorated).toBe(true);

    // Move one street's control point, and say where.
    const stroke = model.strokes[Math.floor(model.strokes.length / 2)];
    const point = stroke.points[1];
    const edit: Bbox = { minX: point.x - 80, minY: point.y - 80, maxX: point.x + 80, maxY: point.y + 80 };
    point.x += 25;
    const after = new NetworkPaths(compile(model), { decorate: false, carryFrom: before, carryExcept: edit });
    expect(after.decorated).toBe(false);

    // Far from the edit: the previous picture's tiles, houses and all.
    const far: Bbox = { minX: point.x + 2000, minY: point.y + 2000, maxX: point.x + 2600, maxY: point.y + 2600 };
    const farTiles = after.decorationTiles(0, far);
    const oldTiles = new Set(before.query(0, far));
    expect(farTiles.length).toBeGreaterThan(0);
    for (const tile of farTiles) expect(oldTiles.has(tile), 'a far tile should be the old picture\'s').toBe(true);

    // Round the edit: this picture's own, however incomplete.
    const nearTiles = after.decorationTiles(0, edit);
    expect(nearTiles.length).toBeGreaterThan(0);
    for (const tile of nearTiles) expect(oldTiles.has(tile)).toBe(false);

    // Once decorated, it stands on its own and lets the old picture go.
    while (!after.decorate(4)) { /* a slice at a time, as the frame loop does */ }
    expect(after.decorated).toBe(true);
    const own = new Set(after.query(0, far));
    for (const tile of after.decorationTiles(0, far)) expect(own.has(tile)).toBe(true);
  });

  it('shows nothing old at all when the whole document changed', async () => {
    const { NetworkPaths } = await import('@render/networkPaths');
    const before = new NetworkPaths(compile(exampleById('town')!.build()));
    const swapped = compile(exampleById('arterial')!.build());
    // A document swap has no "area round the edit" — everything is new — and the
    // store says so with a box covering the old map. Nothing old may show through.
    const everywhere: Bbox = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };
    const after = new NetworkPaths(swapped, { decorate: false, carryFrom: before, carryExcept: everywhere });
    const view: Bbox = { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 };
    const oldTiles = new Set(before.query(0, view));
    for (const tile of after.decorationTiles(0, view)) expect(oldTiles.has(tile)).toBe(false);
  });
});
