/**
 * Where traffic comes from.
 *
 * Three answers, and they are genuinely different questions rather than three dials
 * on one:
 *
 * - `portals` puts traffic in at every place the network stops. It needs nothing
 *   set up, which is why it is the default and why every scenario uses it.
 * - `gateways` restricts that to the ends the user marked, in the direction they
 *   marked them — which is how you ask "what happens to this junction if everything
 *   arrives from the north".
 * - `landuse` generates the town's own traffic: trips start *along* residential
 *   streets, anywhere on them, the way they do when everybody leaves for work, and
 *   finish at a commercial one. Nothing enters from off-map at all.
 *
 * The land-use mode is the one with new machinery underneath it. A zone is a
 * routing destination like a portal, sharing the portals' id space so a destination
 * stays a single number everywhere; arriving at one is *reaching* one of its streets
 * rather than driving off the end of the network; and a trip starts in the middle of
 * a live lane, which is the first spawn in this simulator that has to check what is
 * behind it as well as what is in front.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { autoSmoothHandles, createDocument, kph, makeControlPoint } from '@core/network/model';
import type { EditModel, RoadProfile } from '@core/network/types';
import { exampleById } from '@app/examples';

function road(m: EditModel, p: RoadProfile, x0: number, y0: number, x1: number, y1: number): void {
  const pts = [makeControlPoint(x0, y0), makeControlPoint(x1, y1)];
  autoSmoothHandles(pts);
  m.strokes.push({ id: m.nextId++, profileId: p.id, points: pts });
}

/** A link road with two residential arms crossing it and one commercial arm. */
function landUseDoc(): EditModel {
  const m = createDocument(11);
  const base = {
    lanesBackward: 1, lanesForward: 1, median: 0, isRamp: false,
  };
  const houses: RoadProfile = {
    ...base, id: m.nextId++, name: 'Houses', laneWidth: 3.2, shoulder: 0.4,
    speedLimit: kph(40), landUse: 'residential',
  };
  const shops: RoadProfile = {
    ...base, id: m.nextId++, name: 'Shops', laneWidth: 3.4, shoulder: 0.6,
    speedLimit: kph(40), landUse: 'commercial',
  };
  const link: RoadProfile = {
    ...base, id: m.nextId++, name: 'Link', laneWidth: 3.5, shoulder: 0.5,
    speedLimit: kph(60),
  };
  m.profiles.push(houses, shops, link);
  road(m, link, -900, 0, 900, 0);
  road(m, houses, -600, -700, -600, 700);
  road(m, houses, -200, -700, -200, 700);
  road(m, shops, 500, -700, 500, 700);
  m.settings.spawnMode = 'landuse';
  return m;
}

describe('land-use spawning', () => {
  const model = landUseDoc();
  const net = compile(model);

  it('compiles one zone per zoned street', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect([...new Set(net.zones.map((z) => z.landUse))].sort()).toEqual(['commercial', 'residential']);
    // A zone is one street — every segment of one stroke, taken together — so that
    // a trip has a destination somewhere in particular. One zone per *use* sent
    // every driver to the nearest shop street and left the rest of the map empty.
    for (const zone of net.zones) {
      const strokes = new Set(zone.lanes.map((id) => net.segments[net.lanes[id].segmentId].strokeId));
      expect(strokes.size, `zone ${zone.id} spans ${strokes.size} streets`).toBe(1);
    }
    const residential = net.zones.filter((z) => z.landUse === 'residential');
    // Both residential roads, both directions, split at the crossing: plenty of
    // lanes and a couple of kilometres of frontage between them.
    expect(residential.length).toBe(2);
    expect(residential.reduce((a, z) => a + z.lanes.length, 0)).toBeGreaterThanOrEqual(4);
    expect(residential.reduce((a, z) => a + z.frontage, 0)).toBeGreaterThan(2000);
    // Zone ids continue the portals', so a destination is one number everywhere.
    expect(Math.min(...net.zones.map((z) => z.id))).toBe(net.portals.length);
  });

  it('runs every trip between a house and a shop, one way or the other', () => {
    const sim = new Simulation(net, { seed: 3, spawnMode: 'landuse' });
    const residential = net.zones.filter((z) => z.landUse === 'residential');
    const commercial = net.zones.filter((z) => z.landUse === 'commercial');
    const homes = new Set(residential.flatMap((z) => z.lanes));
    const shops = new Set(commercial.flatMap((z) => z.lanes));
    const homeIds = new Set(residential.map((z) => z.id));
    const shopIds = new Set(commercial.map((z) => z.id));
    let spawns = 0;
    let arrivals = 0;
    sim.observer = {
      onSpawn: (s, i, laneId) => {
        spawns++;
        // Every trip has a house at one end and a shop at the other. Which end is
        // which depends on the hour, so both are legitimate.
        const fromHome = homes.has(laneId);
        expect(fromHome || shops.has(laneId), `spawned on lane ${laneId}`).toBe(true);
        expect((fromHome ? shopIds : homeIds).has(s.store.dest[i]), `trip from lane ${laneId} to ${s.store.dest[i]}`).toBe(true);
      },
      onRetire: (_s, _i, laneId, reason) => {
        if (reason !== 'arrived') return;
        arrivals++;
        expect(homes.has(laneId) || shops.has(laneId), `arrived on lane ${laneId}`).toBe(true);
      },
    };
    sim.run(600);
    expect(spawns).toBeGreaterThan(30);
    expect(arrivals).toBeGreaterThan(20);
    expect(sim.metrics.collisions).toBe(0);
    expect(sim.metrics.lost).toBe(0);
  });

  /**
   * The commute reverses over the day.
   *
   * This is the whole reason both directions exist. With a clock running, the
   * morning is almost entirely house-to-shop and the evening is almost entirely the
   * other way — and if it were not, the morning peak and the evening peak would be
   * the same picture twice, which is exactly what a rush hour is not.
   */
  it('sends people out in the morning and home in the evening', () => {
    const homes = new Set(net.zones.filter((z) => z.landUse === 'residential').flatMap((z) => z.lanes));
    const outboundShare = (startHour: number): number => {
      const sim = new Simulation(net, {
        seed: 5, spawnMode: 'landuse', dayLength: 24 * 600, startHour,
      });
      let out = 0;
      let total = 0;
      sim.observer = {
        onSpawn: (_s, _i, laneId) => {
          total++;
          if (homes.has(laneId)) out++;
        },
      };
      // Ten simulated minutes is one hour of the day at this compression.
      sim.run(600);
      expect(total, `nobody travelled at ${startHour}:00`).toBeGreaterThan(15);
      return out / total;
    };
    const morning = outboundShare(8);
    const evening = outboundShare(17.5);
    expect(morning, `morning outbound share ${morning.toFixed(2)}`).toBeGreaterThan(0.75);
    expect(evening, `evening outbound share ${evening.toFixed(2)}`).toBeLessThan(0.3);
  });

  it('never drops a car on top of one already there', () => {
    // The one thing a mid-lane spawn can do that a portal spawn cannot. A portal
    // has nothing behind it by definition; a driveway has traffic both ways.
    const sim = new Simulation(net, { seed: 8, demandScale: 3, spawnMode: 'landuse' });
    sim.observer = {
      onSpawn: (s, i) => {
        const lead = s.store.ahead[i];
        const lag = s.store.behind[i];
        if (lead >= 0) {
          expect(s.store.s[lead] - s.store.len[lead] - s.store.s[i]).toBeGreaterThan(0);
        }
        if (lag >= 0) {
          expect(s.store.s[i] - s.store.len[i] - s.store.s[lag]).toBeGreaterThan(0);
        }
      },
    };
    sim.run(400);
    expect(sim.metrics.spawned).toBeGreaterThan(50);
    expect(sim.metrics.collisions).toBe(0);
  });

  it('falls back to portals when the document has no land use', () => {
    // A mode that silently generates nothing is indistinguishable from a broken
    // one, so asking for land use on a document without any behaves as before.
    const plainNet = compile(exampleById('corridor')!.build());
    expect(plainNet.zones).toEqual([]);
    const sim = new Simulation(plainNet, { seed: 2, spawnMode: 'landuse' });
    sim.run(200);
    expect(sim.metrics.spawned).toBeGreaterThan(50);
  });
});

describe('gateway spawning', () => {
  /** Marks every portal on the west half as entry-only and the rest exit-only. */
  function marked(): EditModel {
    const m = exampleById('corridor')!.build();
    const first = compile(m);
    const midX = (first.bounds.minX + first.bounds.maxX) / 2;
    m.gateways = first.portals.map((p) => ({
      x: p.x, y: p.y, role: p.x < midX ? ('entry' as const) : ('exit' as const),
    }));
    m.settings.spawnMode = 'gateways';
    return m;
  }

  const net = compile(marked());

  it('carries the roles through the compiler', () => {
    expect(net.portals.every((p) => p.role === 'entry' || p.role === 'exit')).toBe(true);
    expect(net.portals.some((p) => p.role === 'entry')).toBe(true);
    expect(net.portals.some((p) => p.role === 'exit')).toBe(true);
  });

  it('only lets traffic in where it was told to', () => {
    const sim = new Simulation(net, { seed: 4, spawnMode: 'gateways' });
    const entries = new Set(net.portals.filter((p) => p.role === 'entry').map((p) => p.id));
    let spawns = 0;
    sim.observer = {
      onSpawn: (s, i) => {
        spawns++;
        expect(entries.has(s.store.origin[i]), `spawned from portal ${s.store.origin[i]}`).toBe(true);
      },
    };
    sim.run(400);
    expect(spawns).toBeGreaterThan(50);
    expect(sim.metrics.collisions).toBe(0);
  });

  it('an unmarked document behaves exactly like the portal mode', () => {
    // Switching to this mode has to be a starting point, not a cliff: an end nobody
    // has marked is `both`, so nothing changes until something is marked.
    const plain = compile(exampleById('diamond')!.build());
    const a = new Simulation(plain, { seed: 6, spawnMode: 'portals' });
    const b = new Simulation(plain, { seed: 6, spawnMode: 'gateways' });
    a.run(200);
    b.run(200);
    expect(b.metrics.spawned).toBe(a.metrics.spawned);
    expect(b.metrics.arrived).toBe(a.metrics.arrived);
  });
});
