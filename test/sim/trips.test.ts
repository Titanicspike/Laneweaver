/**
 * Where a town's trips go.
 *
 * Three things found on one real network, all with the same symptom — "nobody goes
 * anywhere across the map, and nobody uses the highway":
 *
 * - One zone per land use meant "the commercial zone" was the destination, and the
 *   routing field sends a driver to the *nearest* lane of their destination. So
 *   every trip ended at the closest shop street: 12 of 83 shop streets received
 *   every arrival on the map, and the median trip was 400 m. Zones are now one per
 *   street, and a home's trips are spread over shop streets by a gravity rule.
 * - A street at the edge of the map has one direction that leads only off it. The
 *   spawner drew a lane by length and gave up when it could not reach the shops,
 *   which threw the trip away; 12% of residential frontage faced the wrong way.
 * - The town's own trips never leave the map, and a freeway from one edge to the
 *   other was on none of them. The mixed mode adds through traffic to them.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import { Simulation } from '@core/sim/sim';
import { exampleById } from '@app/examples';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { deserialize, serialize } from '@core/util/serialization';
import type { EditModel } from '@core/network/types';

/**
 * A residential street from the map's edge to a T with a collector, and a shop
 * street off the collector. Half the residential frontage faces the edge.
 */
function edgeStreet(): EditModel {
  const m = doc(3);
  const st = addProfile(m, {
    name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
    landUse: 'residential',
  });
  const col = addProfile(m, {
    name: 'col', lanesForward: 1, lanesBackward: 1, laneWidth: 3.4, speedLimit: kph(60),
  });
  const shop = addProfile(m, {
    name: 'shop', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
    landUse: 'commercial',
  });
  addStroke(m, st, line(0, 0, 600, 0));
  addStroke(m, col, line(600, -500, 600, 500));
  addStroke(m, shop, line(600, 500, 1200, 500));
  return m;
}

describe('leaving in the direction that gets there', () => {
  it('spawns only on lanes that can reach the destination, and drops nothing', () => {
    const net = compile(edgeStreet());
    const sim = new Simulation(net, { seed: 2, spawnMode: 'landuse', demandScale: 3 });
    const router = (sim as unknown as { router: { costTo(d: number): Float64Array } }).router;
    const S = sim.store;
    let spawns = 0;
    let unreachable = 0;
    sim.observer = {
      onSpawn: (_s, i, laneId) => {
        spawns++;
        if (!Number.isFinite(router.costTo(S.dest[i])[laneId])) unreachable++;
      },
    };
    let queuedSum = 0;
    let ticks = 0;
    for (let t = 0; t < 20 * 300; t++) {
      sim.tick();
      queuedSum += sim.metrics.queued;
      ticks++;
    }
    expect(spawns).toBeGreaterThan(20);
    expect(unreachable).toBe(0);
    // Nothing waits: a trip that draws the wrong direction used to sit in the
    // pair's queue failing every tick, which is what "waiting to enter" counted.
    expect(queuedSum / ticks, 'mean trips waiting to enter').toBeLessThan(0.5);
    expect(sim.metrics.lost).toBe(0);
  });
});

describe('zones are streets', () => {
  it('spreads a town\'s trips over its shop streets rather than the nearest one', () => {
    // Five residential streets crossed by four shop streets, so there are four
    // places to go and every home has a nearest one.
    const m = doc(4);
    const home = addProfile(m, {
      name: 'home', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
      landUse: 'residential',
    });
    const shop = addProfile(m, {
      name: 'shop', lanesForward: 1, lanesBackward: 1, laneWidth: 3.4, speedLimit: kph(50),
      landUse: 'commercial',
    });
    for (let i = 0; i < 5; i++) addStroke(m, home, line(0, i * 250, 1500, i * 250, 6));
    for (let i = 0; i < 4; i++) addStroke(m, shop, line(i * 500, -200, i * 500, 1200, 6));
    const net = compile(m);
    const shops = net.zones.filter((z) => z.landUse === 'commercial');
    expect(shops.length).toBe(4);
    const sim = new Simulation(net, { seed: 3, spawnMode: 'landuse' });
    const S = sim.store;
    const served = new Set<number>();
    sim.observer = {
      onRetire: (_s, i, _lane, reason) => { if (reason === 'arrived') served.add(S.dest[i]); },
    };
    sim.run(600);
    expect(sim.metrics.arrived).toBeGreaterThan(100);
    const share = [...served].filter((id) => shops.some((z) => z.id === id)).length / shops.length;
    // With one zone per use every arrival went to whichever shop street was
    // nearest; on the real network that was twelve streets of eighty-three.
    expect(share, `${(share * 100).toFixed(0)}% of shop streets received anyone`).toBeGreaterThan(0.5);
  });
});

describe('the mixed mode', () => {
  it('runs the town\'s trips and through traffic together', () => {
    const net = compile(exampleById('town')!.build());
    const sim = new Simulation(net, { seed: 4, spawnMode: 'mixed' });
    const S = sim.store;
    let fromZones = 0;
    let fromPortals = 0;
    sim.observer = {
      onSpawn: (_s, i) => { if (S.origin[i] >= net.portals.length) fromZones++; else fromPortals++; },
    };
    sim.run(300);
    expect(fromZones, 'trips from houses and shops').toBeGreaterThan(20);
    expect(fromPortals, 'through trips from the road ends').toBeGreaterThan(20);
    expect(sim.metrics.lost).toBe(0);
  });

  it('is a setting a document can carry', () => {
    const m = exampleById('town')!.build();
    m.settings.spawnMode = 'mixed';
    expect(deserialize(serialize(m)).settings.spawnMode).toBe('mixed');
  });
});
