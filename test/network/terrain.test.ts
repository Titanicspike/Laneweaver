import { describe, expect, it } from 'vitest';
import { generateTerrain, elevationAt, isWater, isCliff, slopeAt } from '@core/terrain/terrain';
import { checkTerrainConstraints, canBuildAt } from '@core/terrain/constraints';
import { DEFAULT_TERRAIN } from '@core/network/types';
import { addStroke, doc, line, profileNamed } from '../helpers/build';

const BOUNDS = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
const SETTINGS = { ...DEFAULT_TERRAIN, enabled: true, seed: 1234 };

function findWet(field: ReturnType<typeof generateTerrain>): { x: number; y: number } {
  for (let x = -1900; x < 1900; x += 37) {
    for (let y = -1900; y < 1900; y += 37) {
      if (isWater(field, x, y)) return { x, y };
    }
  }
  throw new Error('no water in this terrain');
}

describe('terrain generation', () => {
  const field = generateTerrain(SETTINGS, BOUNDS);

  it('covers the requested area', () => {
    expect(field.cols).toBeGreaterThan(8);
    expect(field.rows).toBeGreaterThan(8);
    expect(field.bounds.minX).toBeCloseTo(BOUNDS.minX, 6);
    expect(field.bounds.maxX).toBeGreaterThan(1900);
  });

  it('is deterministic for a seed', () => {
    const again = generateTerrain(SETTINGS, BOUNDS);
    expect(Array.from(again.elevation)).toEqual(Array.from(field.elevation));
    expect(again.water.length).toBe(field.water.length);
  });

  it('changes with the seed', () => {
    const other = generateTerrain({ ...SETTINGS, seed: 999 }, BOUNDS);
    expect(Array.from(other.elevation)).not.toEqual(Array.from(field.elevation));
  });

  it('produces both land and water', () => {
    let below = 0;
    for (const z of field.elevation) if (z < SETTINGS.seaLevel) below++;
    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(field.elevation.length);
    expect(field.water.length).toBeGreaterThan(0);
  });

  it('interpolates elevation smoothly', () => {
    expect(Math.abs(elevationAt(field, 0, 0) - elevationAt(field, 1, 0))).toBeLessThan(2);
  });

  it('agrees between the sampled field and the point queries', () => {
    for (let i = 0; i < 200; i++) {
      const x = -1500 + i * 15;
      const y = -900 + i * 9;
      expect(isWater(field, x, y)).toBe(elevationAt(field, x, y) < SETTINGS.seaLevel);
      expect(isCliff(field, x, y)).toBe(slopeAt(field, x, y) > SETTINGS.cliffSlope);
    }
  });

  it('traces contour lines', () => {
    expect(field.contourLines.length).toBeGreaterThan(0);
    for (const ring of field.contourLines) expect(ring.length).toBeGreaterThanOrEqual(6);
  });
});

describe('build constraints', () => {
  const field = generateTerrain(SETTINGS, BOUNDS);
  const wet = findWet(field);

  it('is silent when terrain is off', () => {
    const model = doc();
    addStroke(model, profileNamed(model, 'Collector 2-lane'), line(-1500, -1500, 1500, 1500));
    expect(checkTerrainConstraints(model, null)).toEqual([]);
    const off = { ...field, settings: { ...SETTINGS, enabled: false } };
    expect(checkTerrainConstraints(model, off)).toEqual([]);
  });

  it('flags a ground-level road that crosses water', () => {
    const model = doc();
    const road = profileNamed(model, 'Collector 2-lane');
    addStroke(model, road, line(wet.x - 60, wet.y, wet.x + 60, wet.y), 0);
    expect(checkTerrainConstraints(model, field).some((d) => d.code === 'road-over-water')).toBe(true);
  });

  it('accepts the same road as a bridge', () => {
    const model = doc();
    const road = profileNamed(model, 'Collector 2-lane');
    addStroke(model, road, line(wet.x - 60, wet.y, wet.x + 60, wet.y), 1);
    expect(checkTerrainConstraints(model, field).some((d) => d.code === 'road-over-water')).toBe(false);
  });

  it('answers point queries consistently', () => {
    expect(canBuildAt(null, 0, 0, 0)).toBe(true);
    expect(canBuildAt(field, 0, wet.x, wet.y)).toBe(false);
    expect(canBuildAt(field, 1, wet.x, wet.y)).toBe(!isCliff(field, wet.x, wet.y));
  });
});
