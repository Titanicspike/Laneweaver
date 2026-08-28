/**
 * Zoning a road, the way a city builder does it.
 *
 * Land use began as a property of the road *type*, which is right for drawing a town
 * — "residential street" is already a road type — and wrong for the thing anybody
 * actually wants to do next: take *this* stretch of street and put shops on it.
 * Changing the road type changes every road sharing it.
 *
 * So it is painted per road, with the road type supplying the default. Three states,
 * and the third one earns its place: `none` says "this street has nothing along it"
 * without editing the road type everybody else is using.
 */

import { describe, expect, it } from 'vitest';
import { ZoneTool } from '@editor/tools/zoneTool';
import { DrawTool } from '@editor/tools/drawTool';
import { compile } from '@core/network/compiler';
import { serialize, deserialize } from '@core/util/serialization';
import { layoutBuildings } from '@render/buildings';
import { Simulation } from '@core/sim/sim';
import { harness } from '../helpers/editor';

function town() {
  const h = harness();
  const draw = new DrawTool();
  h.click(draw, -300, 0);
  h.click(draw, 300, 0);
  h.key(draw, 'Enter');
  h.click(draw, 0, -300);
  h.click(draw, 0, 300);
  h.key(draw, 'Enter');
  h.settle();
  return h;
}

describe('the zone tool', () => {
  it('paints a road, and only the road under the pointer', () => {
    const h = town();
    const zone = new ZoneTool();
    zone.setChoice('residential');
    h.click(zone, -200, 0);
    h.settle();
    const zoned = h.store.model.strokes.filter((s) => s.landUse !== undefined);
    expect(zoned.length).toBe(1);
    expect(zoned[0]!.landUse).toBe('residential');
  });

  it('paints a run of roads in one drag, and undoes as one step', () => {
    const h = town();
    const zone = new ZoneTool();
    zone.setChoice('commercial');
    h.paint(zone, [[-200, 0], [-100, 0], [0, -100], [0, -200]]);
    h.settle();
    expect(h.store.model.strokes.filter((s) => s.landUse === 'commercial').length).toBe(2);
    h.store.undo.undo();
    h.settle();
    expect(h.store.model.strokes.filter((s) => s.landUse !== undefined).length).toBe(0);
  });

  it('does not stack an undo step for painting what is already there', () => {
    const h = town();
    const zone = new ZoneTool();
    zone.setChoice('residential');
    h.click(zone, -200, 0);
    h.settle();
    const depth = h.store.undo.depth;
    h.click(zone, -150, 0);
    h.click(zone, -100, 0);
    h.settle();
    expect(h.store.undo.depth, 'repainting the same zoning is not an edit').toBe(depth);
  });

  it('cycles what it paints on 1, 2, 3 and Tab', () => {
    const h = town();
    const zone = new ZoneTool();
    h.key(zone, '2');
    expect(zone.zoneChoice).toBe('commercial');
    h.key(zone, '3');
    expect(zone.zoneChoice).toBe('none');
    h.key(zone, '1');
    expect(zone.zoneChoice).toBe('residential');
    h.key(zone, 'Tab');
    expect(zone.zoneChoice).toBe('commercial');
  });

  it('reaches the compiler, the buildings, and the traffic', () => {
    // All three, because they used to disagree. Buildings read the *segment's* land
    // use — which carries the painted override — while zones were still built from
    // the *profile's*, so a painted street grew houses that generated no trips and
    // received none. A 6x6 stress town found it by compiling 2,375 plots and zero
    // zones; nothing smaller had both halves in view at once.
    const h = town();
    const zone = new ZoneTool();
    zone.setChoice('residential');
    h.click(zone, -200, 0);
    zone.setChoice('commercial');
    h.click(zone, 0, -200);
    h.settle();

    const net = compile(h.store.model);
    expect(net.segments.some((s) => s.landUse === 'residential')).toBe(true);
    expect(layoutBuildings(net).length).toBeGreaterThan(5);
    expect(net.zones.map((z) => z.landUse).sort()).toEqual(['commercial', 'residential']);

    const sim = new Simulation(net, { seed: 3, spawnMode: 'landuse' });
    sim.run(300);
    expect(sim.metrics.spawned, 'painted zoning generates no traffic').toBeGreaterThan(10);
    expect(sim.metrics.collisions).toBe(0);
  });

  it('overrides the road type, in both directions', () => {
    const h = town();
    // Give the road type a land use, then paint this particular road as nothing.
    const stroke = h.store.model.strokes[0]!;
    const profile = h.store.model.profiles.find((p) => p.id === stroke.profileId)!;
    profile.landUse = 'residential';
    h.store.invalidate();
    h.settle();
    expect(compile(h.store.model).segments.some((s) => s.landUse === 'residential')).toBe(true);

    const zone = new ZoneTool();
    zone.setChoice('none');
    h.click(zone, -200, 0);
    h.settle();
    const net = compile(h.store.model);
    const painted = net.segments.filter((s) => s.landUse === 'residential');
    // The crossing road still inherits it; the painted one no longer does.
    expect(painted.every((s) => Math.abs(s.centerline[0]!) < 50)).toBe(true);
  });

  it('survives a save and load', () => {
    const h = town();
    const zone = new ZoneTool();
    zone.setChoice('commercial');
    h.click(zone, -200, 0);
    h.settle();
    const back = deserialize(serialize(h.store.model));
    expect(back.strokes.filter((s) => s.landUse === 'commercial').length).toBe(1);
    expect(compile(back).segments.some((s) => s.landUse === 'commercial')).toBe(true);
  });

  it('shows what a click would do without doing it', () => {
    // Hovering previews the zoning the click would apply. It must not be an edit:
    // a tool that changes the document on pointer *move* fills the undo stack with
    // everything the cursor happened to pass over.
    const h = town();
    const zone = new ZoneTool();
    const before = JSON.stringify(h.store.model.strokes);
    const depth = h.store.undo.depth;
    h.move(zone, -200, 0);
    h.move(zone, 0, -200);
    expect(JSON.stringify(h.store.model.strokes)).toBe(before);
    expect(h.store.undo.depth).toBe(depth);
  });
});
