/**
 * Dev-only: fetch the test extracts from Overpass and cache them on disk.
 *
 *   npx tsx scratch/osmfetch.ts            # everything not already cached
 *   npx tsx scratch/osmfetch.ts cupertino  # one place
 *   npx tsx scratch/osmfetch.ts --force    # re-fetch even if cached
 *
 * Cached under `scratch/osm/`, which is gitignored: the data is somebody else's
 * (ODbL, © OpenStreetMap contributors) and it is derived input, not source.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { PLACES, bboxOf, placeById, type Place } from './osmPlaces';

const DIR = new URL('./osm/', import.meta.url);
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Everything a car can drive on, and nothing else.
 *
 * Footways and cycleways outnumber roads in a European centre and none of them is a
 * road; fetching them would triple the download to throw it away. `service` stays —
 * a supermarket's aisles are noise, but the road into the supermarket is a road, and
 * telling those apart is the importer's job rather than the query's.
 */
const DRIVABLE = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential'
  + '|living_street|service|motorway_link|trunk_link|primary_link|secondary_link'
  + '|tertiary_link|road|busway';

function queryFor(place: Place): string {
  const [s, w, n, e] = bboxOf(place);
  const bbox = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  return `[out:json][timeout:180];way(${bbox})[highway~"^(${DRIVABLE})$"];out geom;`;
}

async function fetchPlace(place: Place, force: boolean): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const file = new URL(`${place.id}.json`, DIR);
  if (!force && existsSync(file)) {
    const kb = (statSync(file).size / 1024).toFixed(0);
    console.log(`${place.id.padEnd(16)} cached (${kb} kB)`);
    return;
  }
  const body = new URLSearchParams({ data: queryFor(place) }).toString();
  // Overpass answers 406 to Node's default user agent. Saying who we are is also
  // what their usage policy asks for.
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Laneweaver/0.1 (traffic simulator; OSM import development)',
  };
  let lastError = '';
  for (const endpoint of ENDPOINTS) {
    try {
      const t0 = Date.now();
      const res = await fetch(endpoint, { method: 'POST', headers, body });
      if (!res.ok) { lastError = `${endpoint}: HTTP ${res.status}`; continue; }
      const text = await res.text();
      if (!text.startsWith('{')) { lastError = `${endpoint}: not JSON`; continue; }
      writeFileSync(file, text);
      const ways = (JSON.parse(text).elements ?? []).length;
      console.log(`${place.id.padEnd(16)} ${ways} ways, ${(text.length / 1024).toFixed(0)} kB`
        + `, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return;
    } catch (err) {
      lastError = `${endpoint}: ${(err as Error).message}`;
    }
  }
  console.log(`${place.id.padEnd(16)} FAILED — ${lastError}`);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const named = args.filter((a) => !a.startsWith('--'));
const wanted = named.length
  ? named.map((id) => placeById(id)).filter((p): p is Place => !!p)
  : PLACES;

for (const place of wanted) {
  await fetchPlace(place, force);
  // Overpass is a shared public service; one request at a time, with a pause.
  await new Promise((r) => setTimeout(r, 1200));
}
