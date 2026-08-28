/**
 * What a zoned road puts beside itself.
 *
 * Every failure mode here is visual and silent — a house standing in the road, two
 * houses in the same place, a terrace fanned around the mouth of a junction. None of
 * them throw and none of them move a number anybody was already watching, so they
 * have to be asserted directly or they ship.
 *
 * `layoutBuildings` is a pure function of the compiled network, which is what makes
 * that possible: no canvas, no `Path2D`, just polygons to check.
 *
 * The three that were actually shipped, and what each one looked like:
 *
 * - **Houses in the middle of the road.** Only the four corners were tested, and a
 *   ten-metre building clears a corner test happily with a three-and-a-half-metre
 *   lane running through its middle.
 * - **Houses inside other houses, worst at junctions.** Placement walked the asphalt
 *   outline, which goes *round the end caps*, so a street's buildings fanned across
 *   the junction mouth and interleaved with the next street's.
 * - **Houses on top of each other at a vertex.** The walk restarted its spacing on
 *   every edge of a flattened polyline whose longest edge is nine metres.
 */

import { describe, expect, it } from 'vitest';
import { layoutBuildings, PLOT, type Plot } from '@render/buildings';
import { compile } from '@core/network/compiler';
import { autoSmoothHandles, createDocument, kph, makeControlPoint } from '@core/network/model';
import type { ControlPoint, EditModel, LandUse, Network, RoadProfile } from '@core/network/types';
import { exampleById } from '@app/examples';

function pts(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i]!, coords[i + 1]!));
  autoSmoothHandles(out);
  return out;
}

function inRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  const n = ring.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!, yi = ring[i * 2 + 1]!;
    const xj = ring[j * 2]!, yj = ring[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Separating-axis overlap for two convex polygons, with a tolerance. */
function overlaps(a: ArrayLike<number>, b: ArrayLike<number>, slack = 0.05): boolean {
  for (const poly of [a, b]) {
    const n = poly.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const nx = -(poly[j * 2 + 1]! - poly[i * 2 + 1]!);
      const ny = poly[j * 2]! - poly[i * 2]!;
      const len = Math.hypot(nx, ny) || 1;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (let k = 0; k < a.length; k += 2) {
        const d = (a[k]! * nx + a[k + 1]! * ny) / len;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (let k = 0; k < b.length; k += 2) {
        const d = (b[k]! * nx + b[k + 1]! * ny) / len;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      if (aMax <= bMin + slack || bMax <= aMin + slack) return false;
    }
  }
  return true;
}

/** Points covering a polygon: its edges and its interior. */
function* cover(poly: ArrayLike<number>, step = 1.2): Generator<[number, number]> {
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2]!, ay = poly[i * 2 + 1]!;
    const dx = poly[j * 2]! - ax, dy = poly[j * 2 + 1]! - ay;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    for (let k = 0; k < steps; k++) yield [ax + (dx * k) / steps, ay + (dy * k) / steps];
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]!); maxX = Math.max(maxX, poly[i]!);
    minY = Math.min(minY, poly[i + 1]!); maxY = Math.max(maxY, poly[i + 1]!);
  }
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      if (inRing(poly, x, y)) yield [x, y];
    }
  }
}

/**
 * Every road surface and junction box a building could be standing on, bucketed.
 *
 * The grid is not an optimisation so much as the difference between a test that runs
 * and one that does not: the shipped town has 267 surfaces and 250 plots, and testing
 * every sample point against every ring is thirteen million point-in-polygon tests.
 */
class Tarmac {
  private readonly cells = new Map<string, Float32Array[]>();
  private static readonly CELL = 80;

  constructor(net: Network) {
    const rings: Float32Array[] = [];
    for (const s of net.segments) if (s.surface.length >= 6) rings.push(s.surface);
    for (const j of net.junctions) if (j.footprint.length >= 6) rings.push(j.footprint);
    for (const ring of rings) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        minX = Math.min(minX, ring[i]!); maxX = Math.max(maxX, ring[i]!);
        minY = Math.min(minY, ring[i + 1]!); maxY = Math.max(maxY, ring[i + 1]!);
      }
      const C = Tarmac.CELL;
      for (let gx = Math.floor(minX / C); gx <= Math.floor(maxX / C); gx++) {
        for (let gy = Math.floor(minY / C); gy <= Math.floor(maxY / C); gy++) {
          const key = `${gx}|${gy}`;
          const list = this.cells.get(key);
          if (list) list.push(ring);
          else this.cells.set(key, [ring]);
        }
      }
    }
  }

  /** Where `poly` first touches tarmac, or null. */
  hit(poly: ArrayLike<number>): string | null {
    const C = Tarmac.CELL;
    for (const [x, y] of cover(poly)) {
      const list = this.cells.get(`${Math.floor(x / C)}|${Math.floor(y / C)}`);
      if (!list) continue;
      for (const ring of list) {
        if (inRing(ring, x, y)) return `(${x.toFixed(1)},${y.toFixed(1)})`;
      }
    }
    return null;
  }
}

function areaOf(poly: ArrayLike<number>): number {
  let a = 0;
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i * 2]! * poly[j * 2 + 1]! - poly[j * 2]! * poly[i * 2 + 1]!;
  }
  return Math.abs(a) / 2;
}

// --- fixtures ---------------------------------------------------------------------

/** A zoned street crossed by a bigger road, so junction corners are exercised. */
function zoned(use: LandUse): Network {
  const m: EditModel = createDocument(77);
  const road: RoadProfile = {
    id: m.nextId++, name: use, lanesForward: 1, lanesBackward: 1, laneWidth: 3.3,
    speedLimit: kph(40), median: 0, shoulder: 0.5, isRamp: false, verge: 3, landUse: use,
  };
  const cross: RoadProfile = {
    id: m.nextId++, name: 'cross', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    speedLimit: kph(60), median: 2.4, shoulder: 0.8, isRamp: false,
  };
  m.profiles.push(road, cross);
  m.strokes.push({ id: m.nextId++, profileId: road.id, points: pts(-500, 0, 500, 0) });
  m.strokes.push({ id: m.nextId++, profileId: cross.id, points: pts(0, -400, 0, 400) });
  return compile(m);
}

describe('plots and buildings', () => {
  const net = zoned('residential');
  const plots = layoutBuildings(net);

  it('builds something on a zoned road', () => {
    expect(plots.length).toBeGreaterThan(20);
    expect(plots.every((p) => p.landUse === 'residential')).toBe(true);
  });

  it('never stands a building on a road or in a junction', () => {
    const rings = new Tarmac(net);
    for (const plot of plots) {
      const hit = rings.hit(plot.footprint);
      expect(hit, `a building covers tarmac at ${hit}`).toBeNull();
    }
  });

  it('never paves a driveway across a carriageway', () => {
    const rings = new Tarmac(net);
    for (const plot of plots) {
      if (plot.paving.length < 6) continue;
      const hit = rings.hit(plot.paving);
      expect(hit, `paving covers tarmac at ${hit}`).toBeNull();
    }
  });

  it('never puts one building inside another', () => {
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        expect(
          overlaps(plots[i]!.footprint, plots[j]!.footprint),
          `buildings ${i} and ${j} overlap`,
        ).toBe(false);
      }
    }
  });

  it('never overlaps one plot with another', () => {
    // Stronger than the building test, and the reason that one holds: reserving the
    // whole plot is what stops two roads' properties interleaving at a corner.
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        expect(overlaps(plots[i]!.ground, plots[j]!.ground), `plots ${i} and ${j} overlap`)
          .toBe(false);
      }
    }
  });

  it('holds back from the junction', () => {
    // The crossing road runs down x = 0; nothing should be built across its mouth.
    const near = plots.filter((p) => {
      for (const [x] of cover(p.footprint, 2)) if (Math.abs(x) < 12) return true;
      return false;
    });
    expect(near.length, 'buildings crowding the junction').toBe(0);
  });

  it('varies the size and the shape', () => {
    const areas = plots.map((p) => areaOf(p.footprint));
    const ratio = Math.max(...areas) / Math.min(...areas);
    expect(ratio, 'every building the same size').toBeGreaterThan(1.4);
    const corners = new Set(plots.map((p) => p.footprint.length >> 1));
    expect(corners.size, 'every building the same shape').toBeGreaterThan(1);
    expect(new Set(plots.map((p) => p.palette)).size, 'every roof the same colour')
      .toBeGreaterThan(2);
  });

  it('gives most houses a drive', () => {
    const withDrive = plots.filter((p) => p.paving.length >= 6).length;
    expect(withDrive / plots.length).toBeGreaterThan(0.5);
  });

  it('leaves a back garden', () => {
    // The plot has to be meaningfully bigger than the thing standing on it, or the
    // house fills its own ground and there is no garden to read.
    for (const plot of plots) {
      expect(areaOf(plot.footprint) / areaOf(plot.ground)).toBeLessThan(0.62);
    }
  });

  it('draws the same town every time', () => {
    const again = layoutBuildings(zoned('residential'));
    expect(again.length).toBe(plots.length);
    for (let i = 0; i < plots.length; i++) {
      expect(Array.from(again[i]!.footprint)).toEqual(Array.from(plots[i]!.footprint));
    }
  });
});

describe('shops', () => {
  const net = zoned('commercial');
  const plots = layoutBuildings(net);

  it('runs a terrace of separate units rather than a slab', () => {
    expect(plots.length).toBeGreaterThan(20);
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        expect(overlaps(plots[i]!.footprint, plots[j]!.footprint)).toBe(false);
      }
    }
  });

  it('stands closer to the road than a house does', () => {
    const houses = layoutBuildings(zoned('residential'));
    const frontage = (list: Plot[]): number => {
      let total = 0;
      for (const p of list) {
        let nearest = Infinity;
        for (let i = 0; i < p.footprint.length; i += 2) {
          nearest = Math.min(nearest, Math.abs(p.footprint[i + 1]!));
        }
        total += nearest;
      }
      return total / list.length;
    };
    expect(frontage(plots)).toBeLessThan(frontage(houses));
  });

  it('covers more of its plot than a house does', () => {
    const houses = layoutBuildings(zoned('residential'));
    const coverage = (list: Plot[]): number =>
      list.reduce((a, p) => a + areaOf(p.footprint) / areaOf(p.ground), 0) / list.length;
    expect(coverage(plots)).toBeGreaterThan(coverage(houses));
  });
});

describe('the shipped town', () => {
  const net = compile(exampleById('town')!.build());
  const plots = layoutBuildings(net);
  const rings = new Tarmac(net);

  it('builds a town', () => {
    expect(plots.length).toBeGreaterThan(150);
  });

  it('has nothing standing on a road anywhere in it', () => {
    for (const plot of plots) {
      expect(rings.hit(plot.footprint)).toBeNull();
    }
  });

  it('has nothing standing inside anything else', () => {
    // The whole town, every pair. This is the check the old placement failed worst,
    // and it failed it around junctions, where two streets' plots meet.
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        expect(overlaps(plots[i]!.ground, plots[j]!.ground), `plots ${i}/${j} overlap`)
          .toBe(false);
      }
    }
  });

  it('varies its plot depth with the room available', () => {
    // Streets inside a block back onto each other and get shallow plots; a street
    // with open ground behind it gets deep ones. A constant would fail this.
    const depths = plots.map((p) => {
      const g = p.ground;
      return Math.hypot(g[4]! - g[2]!, g[5]! - g[3]!);
    });
    const spread = Math.max(...depths) - Math.min(...depths);
    expect(spread, `plot depths span ${spread.toFixed(1)} m`).toBeGreaterThan(5);
  });

  it('stays within the budget', () => {
    expect(plots.length).toBeLessThan(PLOT.maxPlots);
  });
});
