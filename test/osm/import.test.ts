/**
 * Reading OpenStreetMap into an edit model.
 *
 * The compiler already wants what OSM has — centrelines plus a cross-section — so
 * most of the importer is interpretation rather than geometry, and most of the ways
 * it goes wrong are ways a city comes out looking or behaving wrong rather than ways
 * it fails. Each case here is one of those, found on a real extract:
 *
 * - A `primary_link` is a slip road at an ordinary junction, not a freeway ramp.
 * - A roundabout is taken at roundabout speed whatever the road it interrupts is
 *   signed at, and traffic already on it has priority.
 * - A roundabout drawn as one closed way is a road whose two ends are each other,
 *   and the compiler quite rightly refuses to connect those — so it is cut into arcs.
 * - A road the extract's *boundary* cut carries on in the real world; a road that
 *   ends in the middle of it does not, and traffic must not appear out of it.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { importOsm, type OsmWay } from '@core/osm/import';
import { classOf, isDrivable, lanesOf, layerOf, onewayOf, speedOf, CLASS_SPECS } from '@core/osm/tags';
import { squareAround, overpassQuery } from '@core/osm/overpass';
import { LaneKind } from '@core/network/types';
import { deserialize, serialize } from '@core/util/serialization';

/** A way from `lat,lon` to `lat,lon`, straight, with the tags given. */
let nextId = 1;
function way(tags: Record<string, string>, coords: [number, number][], nodes?: number[]): OsmWay {
  return {
    type: 'way', id: nextId++, tags,
    nodes: nodes ?? coords.map((_, i) => nextId * 1000 + i),
    geometry: coords.map(([lat, lon]) => ({ lat, lon })),
  };
}

/** A north–south line of `n` points starting at (lat, lon), `metres` long. */
function line(lat: number, lon: number, metres: number, n = 6): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push([lat + (metres / 111320) * (i / (n - 1)), lon]);
  return out;
}

describe('reading tags', () => {
  it('knows what a car may drive on', () => {
    expect(isDrivable({ highway: 'residential' })).toBe(true);
    expect(isDrivable({ highway: 'motorway' })).toBe(true);
    expect(isDrivable({ highway: 'footway' })).toBe(false);
    expect(isDrivable({ highway: 'residential', access: 'private' })).toBe(false);
    // ...unless something is let through: a gated street is still a street.
    expect(isDrivable({ highway: 'residential', access: 'private', motor_vehicle: 'destination' })).toBe(true);
    // A parking aisle is not a road; the road into the car park is.
    expect(isDrivable({ highway: 'service', service: 'parking_aisle' })).toBe(false);
    expect(isDrivable({ highway: 'service' })).toBe(true);
  });

  it('treats a motorway link as a ramp and every other link as a slip road', () => {
    // A gore with an acceleration lane belongs on a motorway. Building one where a
    // `primary_link` cuts the corner at an ordinary junction asks the compiler for a
    // taper on a road with neither the room nor the reason, which was most of the
    // errors in the first city that imported.
    expect(classOf({ highway: 'motorway_link' })).toBe('ramp');
    expect(CLASS_SPECS[classOf({ highway: 'motorway_link' })].isRamp).toBe(true);
    expect(classOf({ highway: 'primary_link' })).toBe('slip');
    expect(CLASS_SPECS[classOf({ highway: 'primary_link' })].isRamp).toBe(false);
  });

  it('reads speeds in both units, and caps a roundabout', () => {
    const spec = CLASS_SPECS.primary;
    expect(speedOf({ maxspeed: '50' }, spec) * 3.6).toBeCloseTo(50, 3);
    expect(speedOf({ maxspeed: '30 mph' }, spec) * 3.6).toBeCloseTo(48.28, 1);
    expect(speedOf({}, spec)).toBe(spec.speed);
    // The parent road's limit is carried round the circle by OSM. A circulating
    // carriageway at ninety-five is a very fast bend that traffic queues on.
    expect(speedOf({ maxspeed: '95', junction: 'roundabout' }, spec) * 3.6).toBeLessThanOrEqual(35);
  });

  it('splits lanes the way the tags mean them', () => {
    const spec = CLASS_SPECS.primary;
    // `lanes` counts both directions.
    expect(lanesOf({ lanes: '4' }, spec, false)).toEqual({ forward: 2, backward: 2 });
    expect(lanesOf({ lanes: '4' }, spec, true)).toEqual({ forward: 4, backward: 0 });
    // An explicit split wins.
    expect(lanesOf({ 'lanes:forward': '3', 'lanes:backward': '1' }, spec, false))
      .toEqual({ forward: 3, backward: 1 });
    // Nonsense is ignored rather than believed: one street with eight lanes makes a
    // whole import look broken at that one street.
    expect(lanesOf({ lanes: '40' }, spec, true).forward).toBeLessThanOrEqual(16);
    expect(lanesOf({ lanes: 'two' }, spec, false)).toEqual({ forward: 2, backward: 2 });
  });

  it('reads one-way and level, including the implied ones', () => {
    expect(onewayOf({ oneway: 'yes' })).toBe(1);
    expect(onewayOf({ oneway: '-1' })).toBe(-1);
    expect(onewayOf({ junction: 'roundabout' })).toBe(1);
    expect(onewayOf({ highway: 'motorway' })).toBe(1);
    expect(onewayOf({ highway: 'residential' })).toBe(0);
    expect(layerOf({ bridge: 'yes' })).toBe(1);
    expect(layerOf({ tunnel: 'yes' })).toBe(-1);
    expect(layerOf({ layer: '2' })).toBe(2);
    // A road five levels down is a rendering problem rather than a road.
    expect(layerOf({ layer: '-9' })).toBeGreaterThanOrEqual(-2);
  });
});

describe('the Overpass query', () => {
  it('asks for a square of the size it was given, at any latitude', () => {
    for (const lat of [0, 37.33, 64.15, -33.87]) {
      const box = squareAround(lat, 10, 3218.7);
      const h = (box.north - box.south) * 111320;
      const w = (box.east - box.west) * 111320 * Math.cos((lat * Math.PI) / 180);
      expect(h, `height at ${lat}`).toBeCloseTo(3218.7, -1);
      expect(w, `width at ${lat}`).toBeCloseTo(3218.7, -1);
    }
  });

  it('asks only for roads, and for their geometry', () => {
    const q = overpassQuery(squareAround(51.5, -0.1, 1000));
    expect(q).toContain('out geom;');
    expect(q).toContain('motorway');
    expect(q).not.toContain('footway');
  });
});

describe('importing an extract', () => {
  it('turns ways into strokes, sharing road types', () => {
    const { model, report } = importOsm({ elements: [
      way({ highway: 'residential', name: 'A' }, line(0, 0, 300)),
      way({ highway: 'residential', name: 'B' }, line(0, 0.002, 300)),
      way({ highway: 'primary', lanes: '4' }, line(0, 0.004, 300)),
      way({ highway: 'footway' }, line(0, 0.006, 300)),
    ] });
    expect(report.imported).toBe(3);
    expect(report.skipped.notDrivable).toBe(1);
    // Two residential streets share one road type; the primary is its own.
    expect(model.profiles.length).toBe(2);
    expect(model.strokes.length).toBe(3);
    // A road drawn from six survey points comes out as a couple of control points.
    expect(report.controlPoints).toBeLessThan(report.vertices);
  });

  it('cuts a closed way into arcs so the ring can join up', () => {
    // A roundabout drawn as one closed way is a road whose two ends are each other.
    // The compiler refuses a movement that leaves by the road it came in on, so a
    // single closed stroke never circulates: a third of Milton Keynes' roundabouts
    // are drawn this way.
    const n = 24;
    const coords: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      coords.push([Math.sin(a) * 0.00035, Math.cos(a) * 0.00035]);
    }
    const nodes = coords.map((_, i) => (i === coords.length - 1 ? 900 : 900 + i));
    const { model } = importOsm({ elements: [
      way({ highway: 'primary', junction: 'roundabout' }, coords, nodes),
    ] });
    expect(model.strokes.length).toBeGreaterThanOrEqual(2);
    expect(model.strokes.every((s) => s.roundabout)).toBe(true);
  });

  it('closes the ends inside the extract and leaves the edges open', () => {
    // A road the boundary cut carries on in the real world. One ending in the middle
    // does not, and traffic appearing out of it is traffic from a hedge.
    const { model } = importOsm({ elements: [
      // Two roads spanning the extract, so their four ends are all at the edge.
      way({ highway: 'primary' }, line(0, 0, 1000)),
      way({ highway: 'primary' }, line(0, 0.008, 1000)),
      // A stub hanging off the first one, ending well inside the square.
      way({ highway: 'residential' }, [[0.0045, 0], [0.0045, 0.0015]]),
    ] });
    const closed = model.gateways.filter((g) => g.role === 'off');
    expect(closed.length, 'the dangling end of the stub is closed').toBe(1);
    // ...and nothing at the boundary is, or the map would have no traffic at all.
    const bounds = model.strokes.flatMap((st) => st.points);
    const east = Math.max(...bounds.map((p) => p.x));
    expect(closed.every((g) => Math.abs(g.x - east) > 1)).toBe(true);
    expect(model.settings.spawnMode).toBe('gateways');
  });

  it('compiles, and roundabout traffic has priority over what is joining', () => {
    const n = 20;
    const ring: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push([Math.sin(a) * 0.0004, Math.cos(a) * 0.0004]);
    }
    const { model } = importOsm({ elements: [
      way({ highway: 'primary', junction: 'roundabout' }, ring, ring.map((_, i) => (i === n ? 800 : 800 + i))),
      way({ highway: 'primary' }, [[-0.0040, 0], [-0.0004, 0]]),
      way({ highway: 'primary' }, [[0.0004, 0], [0.0040, 0]]),
    ] });
    const net = compile(model);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const rabSegs = new Set(net.segments.filter((s) => s.roundabout).map((s) => s.id));
    expect(rabSegs.size).toBeGreaterThan(0);
    // Nothing on a roundabout is signalised or made an all-way stop by the compiler.
    const onRing = net.junctions.filter((j) => j.approaches.some((a) => rabSegs.has(a.segmentId)));
    expect(onRing.length).toBeGreaterThan(0);
    for (const j of onRing) expect(j.control, `${j.kind} at ${j.x.toFixed(0)}`).toBe('priority');
    // ...and the circulating movements are not the ones giving way.
    let circulatingYields = 0;
    for (const j of onRing) {
      for (const id of j.connectorIds) {
        const c = net.lanes[id];
        const from = net.lanes[c.predecessors[0]];
        if (from && rabSegs.has(from.segmentId) && c.yields) circulatingYields++;
      }
    }
    expect(circulatingYields).toBe(0);
  });

  it('survives a save and reload, roundabouts included', () => {
    const ring: [number, number][] = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ring.push([Math.sin(a) * 0.0004, Math.cos(a) * 0.0004]);
    }
    const { model } = importOsm({ elements: [
      way({ highway: 'primary', junction: 'roundabout' }, ring, ring.map((_, i) => (i === 16 ? 700 : 700 + i))),
    ] });
    const back = deserialize(serialize(model));
    expect(back.strokes.length).toBe(model.strokes.length);
    expect(back.strokes.every((s) => s.roundabout)).toBe(true);
  });

  it('says what it could not use rather than dropping it silently', () => {
    const { report } = importOsm({ elements: [
      way({ highway: 'residential' }, [[0, 0], [0, 0]]),          // no length
      way({ highway: 'residential' }, line(0, 0.01, 3)),           // shorter than the floor
      way({ highway: 'path' }, line(0, 0.02, 300)),                // not a road
      way({ highway: 'residential' }, line(0, 0.03, 300)),         // fine
    ] });
    expect(report.imported).toBe(1);
    expect(report.skipped.notDrivable).toBe(1);
    expect(report.skipped.tooShort + report.skipped.degenerate).toBe(2);
  });

  it('puts a bridge on its own level and ramps it down to what it meets', () => {
    const shared = [10, 11, 12, 13];
    const { model } = importOsm({ elements: [
      way({ highway: 'primary' }, line(0, 0, 200, 4), shared),
      way({ highway: 'primary', bridge: 'yes', layer: '1' }, line(0.0018, 0, 200, 4), [13, 14, 15, 16]),
    ] });
    const bridge = model.strokes[1];
    // Its own level along it, dropping to ground where it lands on the road.
    expect(Math.max(...bridge.points.map((p) => p.grade))).toBe(1);
    expect(bridge.points[0].grade).toBe(0);
  });

  it('compiles a mixed extract clean and drives traffic on it', () => {
    const elements: OsmWay[] = [];
    for (let i = 0; i < 4; i++) {
      elements.push(way({ highway: 'residential' }, line(0, i * 0.002, 900, 8)));
    }
    for (let i = 0; i < 3; i++) {
      const lat = 0.002 + i * 0.002;
      elements.push(way({ highway: 'secondary', lanes: '4' },
        [[lat, 0], [lat, 0.002], [lat, 0.004], [lat, 0.006]]));
    }
    const { model } = importOsm({ elements });
    const net = compile(model);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(net.junctions.length).toBeGreaterThan(4);
    expect(net.lanes.some((l) => l.kind === LaneKind.Connector)).toBe(true);
  });
});
