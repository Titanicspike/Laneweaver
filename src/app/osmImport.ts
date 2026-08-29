/**
 * Importing a square of the real world.
 *
 * The network side of the OSM import: everything that touches Overpass or a dropped
 * file lives here, and everything that turns the data into a document lives in
 * `core/osm`. Two ways in, because they fail differently — a coordinate needs the
 * internet and somebody else's server, a file needs neither.
 */

import { importOsm, type ImportOptions, type ImportResult } from '../core/osm/import';
import { OVERPASS_ENDPOINTS, areaKm2, overpassQuery, squareAround } from '../core/osm/overpass';

export interface FetchRequest {
  lat: number;
  lon: number;
  /** Side of the square, in miles. */
  miles: number;
  options?: ImportOptions;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

/** Anything bigger than this is a download nobody wants to sit through by accident. */
export const MAX_MILES = 4;

export class ImportError extends Error {}

/**
 * Fetches a square from Overpass and imports it.
 *
 * The endpoints are tried in turn: they are a free public service run by
 * volunteers, they go down, and they rate-limit. A 429 or a 504 from one is not a
 * reason to tell somebody their coordinates are wrong.
 */
export async function fetchAndImport(req: FetchRequest): Promise<ImportResult> {
  const miles = Math.max(0.1, Math.min(MAX_MILES, req.miles));
  const box = squareAround(req.lat, req.lon, miles * 1609.344);
  const query = overpassQuery(box);
  const body = new URLSearchParams({ data: query }).toString();

  let lastError = 'no endpoint answered';
  for (const endpoint of OVERPASS_ENDPOINTS) {
    req.onProgress?.(`Asking ${new URL(endpoint).hostname} for ${miles.toFixed(1)} miles square…`);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: req.signal,
      });
      if (!res.ok) { lastError = `${new URL(endpoint).hostname} answered ${res.status}`; continue; }
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) {
        lastError = `${new URL(endpoint).hostname} sent something that is not map data`;
        continue;
      }
      req.onProgress?.(`Building the road network from ${(text.length / 1024 / 1024).toFixed(1)} MB…`);
      return importFromText(text, req.options);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      lastError = `${new URL(endpoint).hostname}: ${(err as Error).message}`;
    }
  }
  throw new ImportError(
    `Could not download the map data — ${lastError}. `
    + `The area is about ${areaKm2(box).toFixed(1)} km²; try a smaller square, or again in a minute.`);
}

/** Imports an Overpass JSON document that somebody already has. */
export function importFromText(text: string, options?: ImportOptions): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('That file is not Overpass JSON. Export with `out geom;` and try again.');
  }
  const elements = (parsed as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) {
    throw new ImportError('That file has no `elements`, so it is not an Overpass export.');
  }
  const result = importOsm({ elements: elements as never }, options);
  if (!result.model.strokes.length) {
    throw new ImportError(
      'Nothing drivable in that data. It may be an area with no roads, or an export '
      + 'made without `out geom;` — the geometry has to come with the ways.');
  }
  return result;
}

/** Whether a dropped file looks like map data rather than an image to trace over. */
export function looksLikeOsm(file: File): boolean {
  return /\.(json|geojson|osm)$/i.test(file.name) || file.type === 'application/json';
}
