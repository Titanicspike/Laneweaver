/**
 * Cars join and leave the road where the buildings are.
 *
 * A land-use trip used to end at `min(30 m, half the lane)` — a fixed distance — so
 * every arrival in the town happened in the first thirty metres of whatever street
 * the driver turned into. Traffic appeared to vanish at the mouth of every road, and
 * the houses further down were scenery nobody ever drove to. Measured on the town
 * grid: **67% of arrivals in the first fifth of the lane, and none at all past the
 * middle.**
 *
 * The fix is that the compiler now emits the frontages — where the buildings stand —
 * and *both* consumers read the same list. The renderer puts a plot on every one; the
 * simulation starts and ends trips on them. That shared list is the point: a car
 * pulling out where no house stands, or stopping in the middle of a block, is what
 * gives away that the houses are wallpaper.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { layoutBuildings } from '@render/buildings';
import { parentToLaneS } from '@core/network/laneGraph';
import { exampleById } from '@app/examples';
import type { Network } from '@core/network/types';

/** Nearest frontage on this lane to `s`, in metres. */
function nearestFrontage(net: Network, laneId: number, s: number): number {
  const lane = net.lanes[laneId]!;
  const seg = net.segments[lane.segmentId];
  if (!seg || !seg.frontages.length) return Infinity;
  let best = Infinity;
  for (const f of seg.frontages) {
    best = Math.min(best, Math.abs(parentToLaneS(lane, f.s) - s));
  }
  return best;
}

/** How evenly a set of fractions covers 0..1, as the emptiest tenth's share. */
function evenness(fractions: number[]): number {
  const bins = new Array(10).fill(0);
  for (const f of fractions) bins[Math.max(0, Math.min(9, Math.floor(f * 10)))]!++;
  return Math.min(...bins) / (fractions.length / 10);
}

describe('land-use trips use the frontages', () => {
  const net = compile(exampleById('town')!.build());

  it('the compiler emits frontages on zoned roads and nowhere else', () => {
    const zoned = net.segments.filter((s) => s.landUse);
    const bare = net.segments.filter((s) => !s.landUse);
    expect(zoned.length).toBeGreaterThan(20);
    expect(zoned.some((s) => s.frontages.length > 0)).toBe(true);
    expect(bare.every((s) => s.frontages.length === 0)).toBe(true);
  });

  it('the buildings stand on those frontages', () => {
    // The renderer and the simulation must be reading the same list, or a car pulls
    // out of a driveway that is not there.
    const plots = layoutBuildings(net);
    expect(plots.length).toBeGreaterThan(150);
    const byId = new Map(net.segments.map((s) => [s.id, s]));
    for (const plot of plots) {
      const seg = byId.get(plot.segmentId)!;
      expect(seg.frontages.length, `a plot on segment ${seg.id}, which has no frontages`)
        .toBeGreaterThan(0);
    }
    // Never more plots than frontages: one property per frontage.
    const perSegment = new Map<number, number>();
    for (const plot of plots) perSegment.set(plot.segmentId, (perSegment.get(plot.segmentId) ?? 0) + 1);
    for (const [id, count] of perSegment) {
      expect(count).toBeLessThanOrEqual(byId.get(id)!.frontages.length);
    }
  });

  it('starts trips at a building, not at a random point on the kerb', () => {
    const sim = new Simulation(net, { seed: 3, spawnMode: 'landuse' });
    let checked = 0;
    let onAddress = 0;
    sim.observer = {
      onSpawn: (s, i, laneId) => {
        checked++;
        if (nearestFrontage(net, laneId, s.store.s[i]) < 0.5) onAddress++;
      },
    };
    sim.run(600);
    expect(checked).toBeGreaterThan(200);
    expect(onAddress / checked, `${onAddress}/${checked} spawns at a frontage`)
      .toBeGreaterThan(0.95);
  });

  it('ends trips at a building', () => {
    const sim = new Simulation(net, { seed: 3, spawnMode: 'landuse' });
    let checked = 0;
    let onAddress = 0;
    sim.observer = {
      onRetire: (s, i, laneId, reason) => {
        if (reason !== 'arrived') return;
        checked++;
        // The vehicle retires on the tick it passes the address, so it overshoots
        // by one step of travel — under a metre on a 40 km/h street.
        if (nearestFrontage(net, laneId, s.store.s[i]) < 2) onAddress++;
      },
    };
    sim.run(600);
    expect(checked).toBeGreaterThan(150);
    expect(onAddress / checked, `${onAddress}/${checked} arrivals at a frontage`)
      .toBeGreaterThan(0.9);
  });

  it('spreads arrivals down the whole street, not just its mouth', () => {
    // This is the symptom that started it. The old rule put 67% of arrivals in the
    // first fifth of the lane and none past the middle.
    const sim = new Simulation(net, { seed: 3, spawnMode: 'landuse' });
    const where: number[] = [];
    sim.observer = {
      onRetire: (s, i, laneId, reason) => {
        if (reason === 'arrived') where.push(s.store.s[i] / net.lanes[laneId]!.length);
      },
    };
    sim.run(600);
    expect(where.length).toBeGreaterThan(150);
    const firstFifth = where.filter((f) => f < 0.2).length / where.length;
    const pastHalf = where.filter((f) => f > 0.5).length / where.length;
    expect(firstFifth, `${(firstFifth * 100).toFixed(0)}% arrive in the first fifth`)
      .toBeLessThan(0.35);
    expect(pastHalf, `${(pastHalf * 100).toFixed(0)}% arrive past the middle`)
      .toBeGreaterThan(0.25);
    // Every tenth of the street gets some, rather than the tail being empty.
    expect(evenness(where), 'the emptiest tenth of the street').toBeGreaterThan(0.25);
  });

  it('still spreads departures the same way', () => {
    const sim = new Simulation(net, { seed: 5, spawnMode: 'landuse' });
    const where: number[] = [];
    sim.observer = {
      onSpawn: (s, i, laneId) => where.push(s.store.s[i] / net.lanes[laneId]!.length),
    };
    sim.run(600);
    expect(where.length).toBeGreaterThan(200);
    expect(evenness(where)).toBeGreaterThan(0.3);
  });

  it('is still safe', () => {
    const sim = new Simulation(net, { seed: 4, spawnMode: 'landuse' });
    sim.run(600);
    expect(sim.metrics.collisions).toBe(0);
    expect(sim.metrics.lost).toBe(0);
    expect(sim.metrics.arrived).toBeGreaterThan(100);
  });
});
