/**
 * Procedural terrain.
 *
 * An fBm simplex heightfield, vectorised with marching squares so it matches the
 * rest of the app's flat vector look rather than sitting under it as a bitmap.
 * From the same field we derive three things roads care about:
 *
 *   - water, anywhere below sea level (crossing it needs a bridge);
 *   - cliff bands, where the slope exceeds a threshold (crossing needs a tunnel);
 *   - rivers, from downhill flow accumulation (also need a bridge).
 *
 * Headless and seeded like everything else in `core`.
 */

import { contours } from 'd3-contour';
import { createNoise2D } from 'simplex-noise';
import { Mulberry32 } from '../util/rng';
import type { TerrainSettings } from '../network/types';
import type { Bbox } from '../geom/polyline';

export interface TerrainField {
  settings: TerrainSettings;
  /** Grid dimensions in cells, and metres per cell. */
  cols: number;
  rows: number;
  cell: number;
  originX: number;
  originY: number;
  elevation: Float32Array;
  slope: Float32Array;
  /** Flow accumulation, in upstream cell counts. */
  flow: Float32Array;
  /** Closed rings in world coordinates. */
  water: Float32Array[];
  cliffs: Float32Array[];
  contourLines: Float32Array[];
  rivers: Float32Array[];
  bounds: Bbox;
}

/** Cells across the widest axis; the grid is capped so generation stays instant. */
const MAX_CELLS = 320;
const OCTAVES = 5;

function fbm(noise: (x: number, y: number) => number, x: number, y: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < OCTAVES; o++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function sampleGrid(field: TerrainField, grid: Float32Array, x: number, y: number): number {
  const gx = (x - field.originX) / field.cell;
  const gy = (y - field.originY) / field.cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  const cx = (v: number): number => (v < 0 ? 0 : v > field.cols - 1 ? field.cols - 1 : v);
  const cy = (v: number): number => (v < 0 ? 0 : v > field.rows - 1 ? field.rows - 1 : v);
  const ax = cx(x0);
  const bx = cx(x0 + 1);
  const ay = cy(y0);
  const by = cy(y0 + 1);
  const v00 = grid[ay * field.cols + ax];
  const v10 = grid[ay * field.cols + bx];
  const v01 = grid[by * field.cols + ax];
  const v11 = grid[by * field.cols + bx];
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

export function elevationAt(field: TerrainField, x: number, y: number): number {
  return sampleGrid(field, field.elevation, x, y);
}

export function slopeAt(field: TerrainField, x: number, y: number): number {
  return sampleGrid(field, field.slope, x, y);
}

export function flowAt(field: TerrainField, x: number, y: number): number {
  return sampleGrid(field, field.flow, x, y);
}

export function isWater(field: TerrainField, x: number, y: number): boolean {
  return elevationAt(field, x, y) < field.settings.seaLevel;
}

export function isCliff(field: TerrainField, x: number, y: number): boolean {
  return slopeAt(field, x, y) > field.settings.cliffSlope;
}

/** Rivers are the cells with enough upstream area to have carved a channel. */
export function isRiver(field: TerrainField, x: number, y: number): boolean {
  return flowAt(field, x, y) >= riverThreshold(field) && !isWater(field, x, y);
}

export function riverThreshold(field: TerrainField): number {
  return Math.max(24, (field.cols * field.rows) / 900);
}

/** Marching-squares rings from `d3-contour`, converted to world coordinates. */
function traceRings(
  values: Float32Array, cols: number, rows: number, threshold: number,
  originX: number, originY: number, cell: number,
): Float32Array[] {
  const generator = contours().size([cols, rows]).thresholds([threshold]);
  const out: Float32Array[] = [];
  for (const shape of generator(Array.from(values))) {
    for (const polygon of shape.coordinates) {
      for (const ring of polygon) {
        if (ring.length < 4) continue;
        const flat = new Float32Array(ring.length * 2);
        for (let i = 0; i < ring.length; i++) {
          flat[i * 2] = originX + ring[i][0] * cell;
          flat[i * 2 + 1] = originY + ring[i][1] * cell;
        }
        out.push(flat);
      }
    }
  }
  return out;
}

/** Slope magnitude per cell, as rise over run. */
function computeSlope(elevation: Float32Array, cols: number, rows: number, cell: number): Float32Array {
  const slope = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < cols - 1 ? x + 1 : x;
      const ym = y > 0 ? y - 1 : y;
      const yp = y < rows - 1 ? y + 1 : y;
      const dx = (elevation[y * cols + xp] - elevation[y * cols + xm]) / ((xp - xm) * cell);
      const dy = (elevation[yp * cols + x] - elevation[ym * cols + x]) / ((yp - ym) * cell);
      slope[y * cols + x] = Math.hypot(dx, dy);
    }
  }
  return slope;
}

/**
 * Downhill flow accumulation: sort cells high to low, then push each cell's
 * accumulated water into its lowest neighbour. Where enough of it collects, there
 * is a river.
 */
function computeFlow(elevation: Float32Array, cols: number, rows: number): Float32Array {
  const n = cols * rows;
  const flow = new Float32Array(n).fill(1);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Sort by descending elevation, breaking ties on index so it stays deterministic.
  const sorted = Array.from(order).sort((a, b) => elevation[b] - elevation[a] || a - b);
  for (const i of sorted) {
    const x = i % cols;
    const y = (i / cols) | 0;
    let best = -1;
    let bestZ = elevation[i];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx;
        if (elevation[j] < bestZ) {
          bestZ = elevation[j];
          best = j;
        }
      }
    }
    if (best >= 0) flow[best] += flow[i];
  }
  return flow;
}

export function generateTerrain(settings: TerrainSettings, bounds: Bbox): TerrainField {
  const width = Math.max(400, bounds.maxX - bounds.minX);
  const height = Math.max(400, bounds.maxY - bounds.minY);
  const span = Math.max(width, height);
  const cell = Math.max(span / MAX_CELLS, settings.featureScale / 24);
  const cols = Math.max(8, Math.min(MAX_CELLS, Math.ceil(width / cell) + 1));
  const rows = Math.max(8, Math.min(MAX_CELLS, Math.ceil(height / cell) + 1));
  const originX = bounds.minX;
  const originY = bounds.minY;

  const rng = new Mulberry32(settings.seed);
  const noise = createNoise2D(() => rng.next());
  const elevation = new Float32Array(cols * rows);
  const scale = 1 / settings.featureScale;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const wx = (originX + x * cell) * scale;
      const wy = (originY + y * cell) * scale;
      // Ridged component on top of plain fBm gives believable valleys and spurs.
      const base = fbm(noise, wx, wy);
      const ridge = 1 - Math.abs(fbm(noise, wx * 2 + 31.7, wy * 2 - 11.3));
      elevation[y * cols + x] = (base * 0.7 + (ridge * 2 - 1) * 0.3) * settings.amplitude;
    }
  }

  const slope = computeSlope(elevation, cols, rows, cell);
  const flow = computeFlow(elevation, cols, rows);

  const field: TerrainField = {
    settings,
    cols, rows, cell, originX, originY,
    elevation, slope, flow,
    water: traceRings(elevation, cols, rows, settings.seaLevel, originX, originY, cell),
    cliffs: traceRings(slope, cols, rows, settings.cliffSlope, originX, originY, cell),
    contourLines: [],
    rivers: [],
    bounds: { minX: originX, minY: originY, maxX: originX + (cols - 1) * cell, maxY: originY + (rows - 1) * cell },
  };

  // Water rings come out as filled regions below sea level; d3-contour gives the
  // region *above* the threshold, so invert the field for that one.
  const inverted = new Float32Array(cols * rows);
  for (let i = 0; i < inverted.length; i++) inverted[i] = -elevation[i];
  field.water = traceRings(inverted, cols, rows, -settings.seaLevel, originX, originY, cell);

  const step = Math.max(8, settings.amplitude / 6);
  for (let z = settings.seaLevel + step; z < settings.amplitude; z += step) {
    for (const ring of traceRings(elevation, cols, rows, z, originX, originY, cell)) {
      field.contourLines.push(ring);
    }
  }

  const threshold = riverThreshold(field);
  const riverMask = new Float32Array(cols * rows);
  for (let i = 0; i < riverMask.length; i++) {
    riverMask[i] = flow[i] >= threshold && elevation[i] >= settings.seaLevel ? 1 : 0;
  }
  field.rivers = traceRings(riverMask, cols, rows, 0.5, originX, originY, cell);

  return field;
}
