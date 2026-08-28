/**
 * Reference imagery under the network: a dropped image, and satellite tiles.
 *
 * Both are drawn below everything else so roads trace on top of them. Tiles are
 * fetched lazily, cached, and drawn at whatever zoom is already loaded while the
 * right one arrives, so panning never flashes empty.
 */

import type { GeoSettings, ImageUnderlay } from '../core/network/types';
import type { Bbox } from '../core/geom/polyline';
import {
  tileToMercator, tileSpan, tilesForRect, tileUrl, worldToMercator, zoomForScale,
} from '../core/geo/mercator';
import type { Camera } from './camera';

type Loadable = { image: HTMLImageElement; ready: boolean; failed: boolean };

const images = new Map<string, Loadable>();

function load(src: string): Loadable {
  let entry = images.get(src);
  if (entry) return entry;
  const image = new Image();
  entry = { image, ready: false, failed: false };
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.addEventListener('load', () => { entry!.ready = true; });
  image.addEventListener('error', () => { entry!.failed = true; });
  image.src = src;
  images.set(src, entry);
  return entry;
}

/** Drops cached images; call when the document changes. */
export function clearImageCache(): void {
  images.clear();
}

export function drawImageUnderlay(
  ctx: CanvasRenderingContext2D, underlay: ImageUnderlay | null,
): void {
  if (!underlay || !underlay.visible) return;
  const entry = load(underlay.src);
  if (!entry.ready) return;
  ctx.save();
  ctx.globalAlpha = underlay.opacity;
  ctx.translate(underlay.x, underlay.y);
  ctx.rotate(underlay.rotation);
  ctx.drawImage(
    entry.image,
    -underlay.width / 2, -underlay.height / 2, underlay.width, underlay.height,
  );
  ctx.restore();
}

/** Tiles asked for and actually drawn last frame, for the statistics panel. */
export const tileStats = { requested: 0, drawn: 0, zoom: 0 };

export function drawSatelliteTiles(
  ctx: CanvasRenderingContext2D, camera: Camera, geo: GeoSettings, view: Bbox,
): void {
  tileStats.requested = 0;
  tileStats.drawn = 0;
  if (!geo.enabled || !geo.tileUrl) return;

  const zoom = zoomForScale(geo, camera.zoom);
  tileStats.zoom = zoom;
  const tiles = tilesForRect(geo, view.minX, view.minY, view.maxX, view.maxY, zoom, 240);
  const span = tileSpan(zoom);
  const scale = 1 / Math.cos((geo.lat * Math.PI) / 180);
  const origin = worldToMercator(geo, 0, 0);

  ctx.save();
  ctx.globalAlpha = geo.opacity;
  ctx.imageSmoothingEnabled = true;
  for (const tile of tiles) {
    tileStats.requested++;
    const entry = load(tileUrl(geo.tileUrl, tile));
    if (!entry.ready || entry.failed) continue;
    const corner = tileToMercator(tile.x, tile.y, zoom);
    // Mercator metres back to world metres, y flipped.
    const x = (corner.x - origin.x) / scale;
    const y = (origin.y - corner.y) / scale;
    const size = span / scale;
    // Half a pixel of overlap hides the seams between neighbouring tiles.
    const bleed = 0.5 / camera.zoom;
    ctx.drawImage(entry.image, x - bleed, y - bleed, size + bleed * 2, size + bleed * 2);
    tileStats.drawn++;
  }
  ctx.restore();
}
