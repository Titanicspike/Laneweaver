/**
 * Web Mercator, for tracing over satellite imagery.
 *
 * The canvas is georeferenced by pinning world (0, 0) to a latitude and longitude.
 * From there world metres map to Mercator metres and then to standard slippy tile
 * z/x/y, so any XYZ tile provider works.
 *
 * Scale note: Mercator distorts by 1/cos(latitude). We divide it out at the anchor
 * latitude so one world unit is one real metre on the ground near the origin, which
 * is what keeps a traced network at true scale.
 */

export const EARTH_RADIUS = 6378137;
export const TILE_SIZE = 256;
const MAX_LAT = 85.05112878;

export interface Georeference {
  /** Latitude and longitude pinned to world (0, 0). */
  lat: number;
  lon: number;
}

export function clampLatitude(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Longitude/latitude to Mercator metres. */
export function lonToMercatorX(lon: number): number {
  return (lon * Math.PI * EARTH_RADIUS) / 180;
}

export function latToMercatorY(lat: number): number {
  const phi = (clampLatitude(lat) * Math.PI) / 180;
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

export function mercatorXToLon(x: number): number {
  return (x * 180) / (Math.PI * EARTH_RADIUS);
}

export function mercatorYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
}

/** Ground metres per Mercator metre at a latitude. */
export function groundScale(lat: number): number {
  return Math.cos((clampLatitude(lat) * Math.PI) / 180);
}

/** World metres (y down) to Mercator metres (y up). */
export function worldToMercator(geo: Georeference, x: number, y: number): { x: number; y: number } {
  const scale = groundScale(geo.lat);
  return {
    x: lonToMercatorX(geo.lon) + x / scale,
    y: latToMercatorY(geo.lat) - y / scale,
  };
}

export function mercatorToWorld(geo: Georeference, mx: number, my: number): { x: number; y: number } {
  const scale = groundScale(geo.lat);
  return {
    x: (mx - lonToMercatorX(geo.lon)) * scale,
    y: (latToMercatorY(geo.lat) - my) * scale,
  };
}

export function worldToLonLat(geo: Georeference, x: number, y: number): { lon: number; lat: number } {
  const m = worldToMercator(geo, x, y);
  return { lon: mercatorXToLon(m.x), lat: mercatorYToLat(m.y) };
}

export function lonLatToWorld(geo: Georeference, lon: number, lat: number): { x: number; y: number } {
  return mercatorToWorld(geo, lonToMercatorX(lon), latToMercatorY(lat));
}

/** Mercator metres spanned by one tile at this zoom. */
export function tileSpan(zoom: number): number {
  return (2 * Math.PI * EARTH_RADIUS) / Math.pow(2, zoom);
}

export interface TileRef {
  z: number;
  x: number;
  y: number;
}

/** Tile containing a Mercator point, with fractional position inside it. */
export function mercatorToTile(mx: number, my: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const world = 2 * Math.PI * EARTH_RADIUS;
  return {
    x: ((mx + world / 2) / world) * n,
    y: ((world / 2 - my) / world) * n,
  };
}

export function tileToMercator(tx: number, ty: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const world = 2 * Math.PI * EARTH_RADIUS;
  return {
    x: (tx / n) * world - world / 2,
    y: world / 2 - (ty / n) * world,
  };
}

/**
 * The zoom level whose tiles land closest to one image pixel per screen pixel.
 * `pixelsPerWorldUnit` is the camera zoom.
 */
export function zoomForScale(geo: Georeference, pixelsPerWorldUnit: number): number {
  const mercatorPerWorld = 1 / groundScale(geo.lat);
  const pixelsPerMercator = pixelsPerWorldUnit / mercatorPerWorld;
  const worldSpan = 2 * Math.PI * EARTH_RADIUS;
  // pixelsPerMercator = (TILE_SIZE * 2^z) / worldSpan
  const z = Math.log2((pixelsPerMercator * worldSpan) / TILE_SIZE);
  return Math.max(0, Math.min(21, Math.round(z)));
}

/** Every tile overlapping a world-space rectangle at the given zoom. */
export function tilesForRect(
  geo: Georeference, minX: number, minY: number, maxX: number, maxY: number,
  zoom: number, limit = 400,
): TileRef[] {
  const a = worldToMercator(geo, minX, minY);
  const b = worldToMercator(geo, maxX, maxY);
  // World y is down, Mercator y is up, so the corners swap.
  const t0 = mercatorToTile(Math.min(a.x, b.x), Math.max(a.y, b.y), zoom);
  const t1 = mercatorToTile(Math.max(a.x, b.x), Math.min(a.y, b.y), zoom);
  const n = Math.pow(2, zoom);
  const out: TileRef[] = [];
  const x0 = Math.floor(t0.x);
  const x1 = Math.floor(t1.x);
  const y0 = Math.floor(t0.y);
  const y1 = Math.floor(t1.y);
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = x0; x <= x1; x++) {
      const wrapped = ((x % n) + n) % n;
      out.push({ z: zoom, x: wrapped, y });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function tileUrl(template: string, tile: TileRef): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}
