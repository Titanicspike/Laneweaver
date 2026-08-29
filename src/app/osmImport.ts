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

export class ImportError extends Error {
  /**
   * Whether another server might answer differently.
   *
   * "The square you asked for has no drivable roads in it" is a fact about the
   * square, and asking three servers in turn wastes half a minute to reach the same
   * answer. "That server sent an empty document" is a fact about the server.
   */
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

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

  // Every failure, not just the last one. These are free public servers run by
  // volunteers: on any given try one is rate-limiting, one is down and one works,
  // and which is which changes by the hour. Keeping only the last message means the
  // user is told about whichever server happened to be asked last — the least
  // relevant one — while the reason the *good* server refused is thrown away. That
  // is exactly what happened the first time this was run against a live endpoint.
  const failures: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const host = new URL(endpoint).hostname;
    req.onProgress?.(`Asking ${host} for ${miles.toFixed(1)} miles square…`);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: req.signal,
      });
      if (!res.ok) {
        failures.push(`${host} answered ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
        continue;
      }
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) {
        // Overpass reports its own errors as prose with a 200, so this is the
        // common shape of "busy", not a corrupt download.
        failures.push(`${host} sent a message rather than map data`
          + ` ("${text.trim().replace(/\s+/g, ' ').slice(0, 80)}")`);
        continue;
      }
      req.onProgress?.(`Building the road network from ${(text.length / 1024 / 1024).toFixed(1)} MB…`);
      return importFromText(text, req.options);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      // A verdict about the data is not a verdict about the server: no other
      // endpoint will find roads in a square that has none, and saying "could not
      // download" sends somebody looking for a network problem they do not have.
      if (err instanceof ImportError && !err.retryable) throw err;
      failures.push(`${host}: ${(err as Error).message}`);
    }
  }
  throw new ImportError(
    `Could not download the map data. ${failures.join('; ')}. `
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
    throw new ImportError('That file has no `elements`, so it is not an Overpass export.', true);
  }
  if (elements.length === 0) {
    // Nothing at all came back. A working server would have said so with an error,
    // so this is worth asking somebody else about.
    throw new ImportError('That data is empty — no ways at all came back.', true);
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
