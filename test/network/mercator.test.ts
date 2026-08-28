import { describe, expect, it } from 'vitest';
import {
  groundScale, lonLatToWorld, lonToMercatorX, latToMercatorY, mercatorToTile,
  mercatorXToLon, mercatorYToLat, tileToMercator, tileSpan, tileUrl, tilesForRect,
  worldToLonLat, zoomForScale, EARTH_RADIUS, clampLatitude,
} from '@core/geo/mercator';

const LONDON = { lat: 51.5074, lon: -0.1278 };
const EQUATOR = { lat: 0, lon: 0 };

describe('mercator projection', () => {
  it('round-trips longitude and latitude', () => {
    for (const lon of [-179, -0.1278, 0, 12.5, 179]) {
      expect(mercatorXToLon(lonToMercatorX(lon))).toBeCloseTo(lon, 9);
    }
    for (const lat of [-80, -51.5, 0, 51.5074, 80]) {
      expect(mercatorYToLat(latToMercatorY(lat))).toBeCloseTo(lat, 7);
    }
  });

  it('clamps beyond the Mercator limit', () => {
    expect(clampLatitude(90)).toBeLessThan(86);
    expect(clampLatitude(-90)).toBeGreaterThan(-86);
    expect(Number.isFinite(latToMercatorY(90))).toBe(true);
  });

  it('puts the world origin at the anchor point', () => {
    const back = worldToLonLat(LONDON, 0, 0);
    expect(back.lon).toBeCloseTo(LONDON.lon, 9);
    expect(back.lat).toBeCloseTo(LONDON.lat, 7);
  });

  it('round-trips world coordinates through lon/lat', () => {
    for (const [x, y] of [[0, 0], [500, -800], [-12000, 4300]]) {
      const ll = worldToLonLat(LONDON, x, y);
      const back = lonLatToWorld(LONDON, ll.lon, ll.lat);
      expect(back.x).toBeCloseTo(x, 3);
      expect(back.y).toBeCloseTo(y, 3);
    }
  });

  it('keeps one world unit close to one real metre near the anchor', () => {
    // 1 km east of the anchor should be about 1 km of real ground distance.
    const ll = worldToLonLat(LONDON, 1000, 0);
    const metres = ((ll.lon - LONDON.lon) * Math.PI / 180) * EARTH_RADIUS * groundScale(LONDON.lat);
    expect(metres).toBeCloseTo(1000, 0);
  });

  it('accounts for latitude in the ground scale', () => {
    expect(groundScale(0)).toBeCloseTo(1, 9);
    expect(groundScale(60)).toBeCloseTo(0.5, 6);
  });
});

describe('slippy tiles', () => {
  it('round-trips tile coordinates', () => {
    for (const z of [0, 5, 12, 18]) {
      const m = tileToMercator(3.25, 7.5, z);
      const t = mercatorToTile(m.x, m.y, z);
      expect(t.x).toBeCloseTo(3.25, 6);
      expect(t.y).toBeCloseTo(7.5, 6);
    }
  });

  it('halves the tile span with each zoom level', () => {
    expect(tileSpan(1)).toBeCloseTo(tileSpan(0) / 2, 6);
    expect(tileSpan(10)).toBeCloseTo(tileSpan(9) / 2, 6);
  });

  it('places 0/0/0 over the whole world', () => {
    const t = mercatorToTile(0, 0, 0);
    expect(t.x).toBeCloseTo(0.5, 9);
    expect(t.y).toBeCloseTo(0.5, 9);
  });

  it('covers a view rectangle without gaps', () => {
    const tiles = tilesForRect(LONDON, -1000, -1000, 1000, 1000, 15);
    expect(tiles.length).toBeGreaterThan(1);
    const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
    expect(keys.size).toBe(tiles.length);
    // The centre tile must be among them.
    const centre = mercatorToTile(lonToMercatorX(LONDON.lon), latToMercatorY(LONDON.lat), 15);
    expect(keys.has(`${Math.floor(centre.x)}/${Math.floor(centre.y)}`)).toBe(true);
  });

  it('honours the tile budget', () => {
    const tiles = tilesForRect(LONDON, -50000, -50000, 50000, 50000, 18, 50);
    expect(tiles.length).toBeLessThanOrEqual(50);
  });

  it('picks a zoom that matches the camera scale', () => {
    const near = zoomForScale(LONDON, 4);
    const far = zoomForScale(LONDON, 0.25);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(21);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  it('fills a URL template', () => {
    expect(tileUrl('https://x/{z}/{x}/{y}.png', { z: 3, x: 4, y: 5 }))
      .toBe('https://x/3/4/5.png');
  });

  it('is symmetric at the equator', () => {
    const p = lonLatToWorld(EQUATOR, 1, 0);
    const q = lonLatToWorld(EQUATOR, -1, 0);
    expect(p.x).toBeCloseTo(-q.x, 6);
  });
});
