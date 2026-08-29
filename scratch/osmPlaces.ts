/**
 * Dev-only: the places the OSM importer is tested against.
 *
 * Chosen to break different things rather than to be representative. A suburban US
 * grid and a mediaeval European centre fail in opposite ways; a city built on
 * roundabouts, one built on elevated expressways and one built on neither are three
 * different importers as far as the compiler is concerned.
 *
 * `size` is the side of the square in miles, centred on the point. Two miles is the
 * target the importer is built for.
 */

export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Square side in miles. */
  size: number;
  /** What this one is here to break. */
  about: string;
}

export const PLACES: Place[] = [
  // The one to optimise for: suburban California, two freeways, a lot of
  // parking-lot service roads, and the flattest grid in the set.
  { id: 'cupertino', name: 'Cupertino, California', lat: 37.3303843, lon: -122.0490306, size: 2,
    about: 'the target: suburban grid, I-280 and CA-85, service roads everywhere' },

  { id: 'manhattan', name: 'Midtown Manhattan', lat: 40.7549, lon: -73.9840, size: 2,
    about: 'the densest regular grid there is, and almost all of it one-way' },
  { id: 'london', name: 'Central London', lat: 51.5074, lon: -0.1278, size: 2,
    about: 'irregular mediaeval geometry, left-hand traffic, roundabouts' },
  { id: 'paris', name: 'Paris, Étoile', lat: 48.8738, lon: 2.2950, size: 2,
    about: 'a twelve-arm roundabout and radial avenues' },
  { id: 'tokyo', name: 'Tokyo, Shibuya', lat: 35.6595, lon: 139.7005, size: 2,
    about: 'elevated expressways stacked over surface streets: layers' },
  { id: 'milton-keynes', name: 'Milton Keynes', lat: 52.0406, lon: -0.7594, size: 2,
    about: 'a city planned around roundabouts, one per grid intersection' },
  { id: 'la-interchange', name: 'Los Angeles, I-105/I-110', lat: 33.9280, lon: -118.2820, size: 2,
    about: 'a four-level stack: the hardest grade separation in the set' },
  { id: 'sao-paulo', name: 'São Paulo, Paulista', lat: -23.5614, lon: -46.6559, size: 2,
    about: 'southern hemisphere, dense, steep, complex one-way pairs' },
  { id: 'delhi', name: 'New Delhi, Connaught Place', lat: 28.6315, lon: 77.2167, size: 2,
    about: 'concentric ring roads and radial spokes' },
  { id: 'amsterdam', name: 'Amsterdam centre', lat: 52.3702, lon: 4.8952, size: 2,
    about: 'canals, bridges, and a way network that is mostly not for cars' },
  { id: 'sydney', name: 'Sydney CBD', lat: -33.8688, lon: 151.2093, size: 2,
    about: 'southern hemisphere, harbour tunnels, left-hand traffic' },
  { id: 'moscow', name: 'Moscow, Garden Ring', lat: 55.7558, lon: 37.6173, size: 2,
    about: 'very wide multi-carriageway arterials' },
  { id: 'lagos', name: 'Lagos, Ikeja', lat: 6.6018, lon: 3.3515, size: 2,
    about: 'near the equator, sparse tagging, informal geometry' },
  { id: 'cairo', name: 'Cairo, Tahrir', lat: 30.0444, lon: 31.2357, size: 2,
    about: 'right-hand traffic, heavy flyovers, Arabic names' },
  { id: 'seoul', name: 'Seoul, Gangnam', lat: 37.4979, lon: 127.0276, size: 2,
    about: 'superblocks with very wide arterials' },
  { id: 'istanbul', name: 'Istanbul, Beşiktaş', lat: 41.0422, lon: 29.0093, size: 2,
    about: 'steep, curved, two continents worth of tagging conventions' },
  { id: 'rural-iowa', name: 'Rural Iowa', lat: 41.8780, lon: -93.0977, size: 2,
    about: 'the empty case: a section grid and almost nothing else' },
  { id: 'reykjavik', name: 'Reykjavík', lat: 64.1466, lon: -21.9426, size: 2,
    about: 'high latitude, where Mercator distortion is largest' },
];

export function placeById(id: string): Place | undefined {
  return PLACES.find((p) => p.id === id);
}

/** The bounding box of a place, in degrees: [south, west, north, east]. */
export function bboxOf(place: Place): [number, number, number, number] {
  const half = (place.size * 1609.344) / 2;
  const dLat = (half / 111320) * 1;
  const dLon = half / (111320 * Math.cos((place.lat * Math.PI) / 180));
  return [place.lat - dLat, place.lon - dLon, place.lat + dLat, place.lon + dLon];
}
