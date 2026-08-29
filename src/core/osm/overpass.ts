/**
 * Asking Overpass for a square of road network.
 *
 * Only the query, never the request: core has no network any more than it has a DOM,
 * and keeping the string here means the app and the dev scripts ask for exactly the
 * same thing.
 */

/**
 * Everything a car can drive on, and nothing else.
 *
 * Footways and cycleways outnumber roads in a European centre and none of them is a
 * road; asking for them would triple the download to throw it away. `service` stays —
 * a supermarket's aisles are noise, but the road into the supermarket is a road, and
 * telling those apart is the importer's job rather than the query's.
 */
const DRIVABLE = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'motorway_link', 'trunk_link',
  'primary_link', 'secondary_link', 'tertiary_link', 'road', 'busway',
].join('|');

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Metres per degree of latitude. Near enough anywhere for a few square miles. */
const METRES_PER_DEGREE = 111320;

/**
 * The square of `sizeMetres` on a side centred on a point.
 *
 * Longitude degrees shrink with latitude, which is why the two are not the same
 * number: two miles across is two miles across in Reykjavík as well as in Lagos.
 */
export function squareAround(lat: number, lon: number, sizeMetres: number): Bbox {
  const half = sizeMetres / 2;
  const dLat = half / METRES_PER_DEGREE;
  const dLon = half / (METRES_PER_DEGREE * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

/** How many square kilometres a box covers, for warning about a big ask. */
export function areaKm2(box: Bbox): number {
  const midLat = (box.south + box.north) / 2;
  const h = (box.north - box.south) * METRES_PER_DEGREE;
  const w = (box.east - box.west) * METRES_PER_DEGREE * Math.cos((midLat * Math.PI) / 180);
  return (h * w) / 1e6;
}

/** The Overpass QL for one box: drivable ways, with their geometry and node ids. */
export function overpassQuery(box: Bbox, timeoutSeconds = 180): string {
  const bbox = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(6)).join(',');
  return `[out:json][timeout:${timeoutSeconds}];way(${bbox})[highway~"^(${DRIVABLE})$"];out geom;`;
}

/** The public endpoints, in the order worth trying. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
