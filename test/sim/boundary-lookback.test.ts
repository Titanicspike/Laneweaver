/**
 * A lane change must see the driver who is two lanes upstream.
 *
 * The lane a vehicle is joining cannot see traffic about to cross into it from
 * upstream, so the safety check looks past the boundary. It used to look exactly
 * one lane back, and one lane back is not a distance — it is a count. A junction
 * connector can be twenty metres long, which at motorway speed is two thirds of a
 * second: the connector is empty, the driver closing at 28 m/s is on the mainline
 * behind it, and a car dropping into the head of the lane lands in front of
 * somebody who then brakes at the emergency cap for the whole connector and still
 * arrives inside the gap.
 *
 * This is not a hypothetical. The motorway corridor example produced it on every
 * seed tried, two to six times in fifteen simulated minutes, always the same
 * signature: a follower doing 19 m/s handed onto a lane whose queue was doing 6.
 * The look now carries on through *empty* lanes until it has covered ninety metres
 * of road, which is the quantity that was meant all along.
 */

import { describe, expect, it } from 'vitest';
import { exampleById } from '@app/examples';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';

describe('looking upstream past a short empty connector', () => {
  const net = compile(exampleById('corridor')!.build());

  // Seed 2 was the worst of the eight tried; 400 s reaches two of its collisions.
  it('nobody is handed onto a lane on top of a queue', () => {
    const sim = new Simulation(net, { seed: 2, demandScale: 1 });
    sim.run(400);
    expect(sim.metrics.arrived).toBeGreaterThan(50);
    expect(sim.metrics.collisions).toBe(0);
  });

  it('holds across seeds', () => {
    for (const seed of [1, 3, 5]) {
      const sim = new Simulation(net, { seed, demandScale: 1 });
      sim.run(400);
      expect(sim.metrics.collisions, `seed ${seed}`).toBe(0);
      expect(sim.metrics.lost, `seed ${seed}`).toBe(0);
    }
  });
});
