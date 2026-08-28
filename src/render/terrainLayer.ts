/**
 * Terrain layer: land, water, contour lines, cliff bands and rivers.
 *
 * Drawn as flat vector fills and lines so terrain reads like a topographic map
 * rather than a photo sitting under the roads.
 */

import type { TerrainField } from '../core/terrain/terrain';
import type { Bbox } from '../core/geom/polyline';
import type { Camera } from './camera';
import { LOD, type Theme } from './theme';
import { lineWidth } from './networkPaths';

interface CachedPaths {
  field: TerrainField;
  land: Path2D;
  water: Path2D;
  contours: Path2D;
  cliffs: Path2D;
  rivers: Path2D;
}

let cache: CachedPaths | null = null;

function ringsToPath(rings: ReadonlyArray<Float32Array>, close: boolean): Path2D {
  const path = new Path2D();
  for (const ring of rings) {
    const n = ring.length >> 1;
    if (n < 2) continue;
    path.moveTo(ring[0], ring[1]);
    for (let i = 1; i < n; i++) path.lineTo(ring[i * 2], ring[i * 2 + 1]);
    if (close) path.closePath();
  }
  return path;
}

function build(field: TerrainField): CachedPaths {
  const land = new Path2D();
  const b = field.bounds;
  land.rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  return {
    field,
    land,
    water: ringsToPath(field.water, true),
    contours: ringsToPath(field.contourLines, true),
    cliffs: ringsToPath(field.cliffs, true),
    rivers: ringsToPath(field.rivers, true),
  };
}

export function invalidateTerrainCache(): void {
  cache = null;
}

export function drawTerrain(
  ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme,
  field: TerrainField, view: Bbox,
): void {
  const b = field.bounds;
  if (b.minX > view.maxX || b.maxX < view.minX || b.minY > view.maxY || b.maxY < view.minY) return;
  if (!cache || cache.field !== field) cache = build(field);

  ctx.fillStyle = theme.land;
  ctx.fill(cache.land);

  if (camera.zoom >= LOD.grid * 0.5) {
    ctx.strokeStyle = theme.contour;
    ctx.lineWidth = lineWidth(0, camera.zoom);
    ctx.stroke(cache.contours);
  }

  ctx.fillStyle = theme.cliff;
  ctx.globalAlpha = 0.55;
  ctx.fill(cache.cliffs);
  ctx.globalAlpha = 1;

  ctx.fillStyle = theme.water;
  ctx.fill(cache.water, 'evenodd');
  ctx.strokeStyle = theme.waterEdge;
  ctx.lineWidth = lineWidth(1.2, camera.zoom);
  ctx.stroke(cache.water);

  ctx.strokeStyle = theme.water;
  ctx.lineWidth = lineWidth(6, camera.zoom);
  ctx.stroke(cache.rivers);
}
