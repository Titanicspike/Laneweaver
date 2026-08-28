/**
 * The shipped example maps.
 *
 * These are the first thing a user opens, so a fault in one of them is a fault in
 * the product rather than in a fixture. Each one has to compile without an error
 * *or a warning* — the warnings are the interesting half, because they are how the
 * compiler says "I built something, but not what you drew": a ramp on the median
 * side, an auxiliary lane clipped by a junction, a curve tighter than the road is
 * wide. Every one of those was a real defect in one of these maps while it was
 * being laid out.
 *
 * They also have to *run*: traffic that arrives, nobody lost at a dead end, nobody
 * failing to merge, and no collisions. A map that compiles into a network vehicles
 * cannot drive is not an example of anything.
 */

import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '@app/examples';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { serialize, deserialize } from '@core/util/serialization';

describe.each(EXAMPLES.map((e) => [e.id, e] as const))('example %s', (_id, example) => {
  const model = example.build();
  const net = compile(model);

  it('compiles with no errors and no warnings', () => {
    const bad = net.diagnostics.filter((d) => d.severity !== 'info');
    expect(bad.map((d) => `${d.severity} ${d.code}: ${d.message}`)).toEqual([]);
  });

  it('has somewhere for traffic to come from and go to', () => {
    // Both halves matter: a network with entries and no exits fills up and stops,
    // and one with exits and no entries never starts.
    expect(net.portals.filter((p) => p.entryLanes.length > 0).length).toBeGreaterThan(1);
    expect(net.portals.filter((p) => p.exitLanes.length > 0).length).toBeGreaterThan(1);
  });

  it('runs clean for five minutes', () => {
    // Through the document's own spawn mode, not the default: the town generates
    // its traffic from land use, and running it on portals would test a network
    // nobody opens.
    const sim = new Simulation(net, {
      seed: 7, demandScale: 1, spawnMode: model.settings.spawnMode,
    });
    sim.run(300);
    expect(sim.metrics.arrived, 'vehicles completed a trip').toBeGreaterThan(20);
    expect(sim.metrics.collisions, 'collisions').toBe(0);
    expect(sim.metrics.lost, 'vehicles retired at a dead end').toBe(0);
    expect(sim.metrics.mergeFailures, 'reached a lane end without merging').toBe(0);
  });

  it('survives a save and load', () => {
    // Examples are built by code but reach the user as documents, so they go
    // through the same versioning every other document does.
    const back = deserialize(serialize(model));
    expect(back.strokes.length).toBe(model.strokes.length);
    expect(compile(back).segments.length).toBe(net.segments.length);
  });
});
