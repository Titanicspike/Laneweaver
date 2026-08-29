/**
 * Crossings OpenStreetMap says are not crossings.
 *
 * A hand-drawn document has only geometry, so the compiler has only geometry to go
 * on: two roads whose centrelines cross, cross. A survey has topology as well, and
 * it is unambiguous — two ways that cross **without sharing a node do not connect**.
 * That is how every flyover in OSM is recorded. Where the bridge carries a tag
 * (`bridge=yes`, `layer=1`) `layerOf` already reads it; plenty carry none, and then
 * the compiler wires a motorway into the street beneath it.
 *
 * Measured across twenty imported squares before this: **752 junctions** that OSM
 * does not have, 229 of them with a motorway or trunk road as an arm. What it costs
 * is a freeway with traffic lights on it, drivers leaving it in the middle of a
 * span, and — on the worst square — nearly all of the collisions and almost none of
 * the traffic completing its trip (135 arrivals in five minutes, against 6,184
 * once the bridges were built).
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { importOsm, type OsmWay } from '@core/osm/import';
import { bridgeSpans, findFlyovers } from '@core/osm/flyovers';

let nextId = 1;

/** A way through the given world-metre points, for the flyover finder directly. */
function metreWay(highway: string, nodes: number[], ...xy: number[]) {
  return { id: nextId++, raw: xy, nodes, tags: { highway } };
}

/** A way from lat/lon pairs, for the importer. */
function way(tags: Record<string, string>, coords: [number, number][], nodes: number[]): OsmWay {
  return { type: 'way', id: nextId++, tags, nodes, geometry: coords.map(([lat, lon]) => ({ lat, lon })) };
}

describe('finding the crossings that are not junctions', () => {
  it('reports a crossing where the two ways share no node', () => {
    // A 200 m motorway west to east, a 200 m street south to north, meeting at the
    // origin. No node in common: in OSM that is a bridge.
    const motorway = metreWay('motorway', [1, 2], -100, 0, 100, 0);
    const street = metreWay('residential', [3, 4], 0, -100, 0, 100);
    const found = findFlyovers([motorway, street]);
    // The motorway goes over, and the crossing is half way along it.
    expect(found.has(motorway.id)).toBe(true);
    expect(found.has(street.id)).toBe(false);
    expect(found.get(motorway.id)![0]).toBeCloseTo(100, 1);
  });

  it('reports nothing where they share one', () => {
    // The same shape with a node in common is a junction and must stay one.
    const motorway = metreWay('motorway', [1, 7, 2], -100, 0, 0, 0, 100, 0);
    const street = metreWay('residential', [3, 7, 4], 0, -100, 0, 0, 0, 100);
    expect(findFlyovers([motorway, street]).size).toBe(0);
  });

  it('reports nothing for two roads that only meet end to end', () => {
    // Which is what a shared node looks like geometrically, and is the case the
    // strictly-inside test in `crossAt` exists for.
    const a = metreWay('primary', [1, 2], -100, 0, 0, 0);
    const b = metreWay('primary', [3, 4], 0, 0, 100, 0);
    expect(findFlyovers([a, b]).size).toBe(0);
  });

  it('sends the bigger road over the smaller one', () => {
    const street = metreWay('residential', [1, 2], -100, 0, 100, 0);
    const trunk = metreWay('trunk', [3, 4], 0, -100, 0, 100);
    const found = findFlyovers([street, trunk]);
    expect(found.has(trunk.id)).toBe(true);
    expect(found.has(street.id)).toBe(false);
  });

  it('decides the same way whichever order it is given them in', () => {
    // Two roads of the same class and the same length: the answer still has to be
    // one answer, or two runs of the same import disagree.
    const a = metreWay('residential', [1, 2], -100, 0, 100, 0);
    const b = metreWay('residential', [3, 4], 0, -100, 0, 100);
    const one = findFlyovers([a, b]);
    const two = findFlyovers([b, a]);
    expect([...one.keys()]).toEqual([...two.keys()]);
  });
});

describe('turning a crossing into a bridge', () => {
  it('raises a stretch either side and ramps back down', () => {
    const [span] = bridgeSpans([200], 400);
    expect(span).toBeDefined();
    expect(span.from).toBeLessThan(200);
    expect(span.to).toBeGreaterThan(200);
    expect(span.rampFrom).toBeLessThan(span.from);
    expect(span.rampTo).toBeGreaterThan(span.to);
  });

  it('fits the span to the road there is', () => {
    // Ways between junctions are often eighty metres, and a fixed span needs
    // seventy-four: insisting on the full one refused most of the bridges that most
    // needed building, and a refused bridge is a motorway wired into a street.
    const [span] = bridgeSpans([40], 80);
    expect(span, 'an eighty-metre way can still carry a bridge').toBeDefined();
    expect(span.rampFrom).toBeGreaterThan(0);
    expect(span.rampTo).toBeLessThan(80);
  });

  it('refuses one that would reach the end of the way', () => {
    // The ends are where the junctions are. A way raised at the point it meets
    // another is a way that no longer meets it, which trades one broken connection
    // for a different one.
    expect(bridgeSpans([4], 400)).toEqual([]);
    expect(bridgeSpans([396], 400)).toEqual([]);
    expect(bridgeSpans([10], 20)).toEqual([]);
  });

  it('merges spans that run into each other', () => {
    // Two crossings twenty metres apart are one bridge, not two with a dip between.
    const spans = bridgeSpans([200, 220], 600);
    expect(spans.length).toBe(1);
    expect(spans[0].from).toBeLessThan(200);
    expect(spans[0].to).toBeGreaterThan(220);
  });
});

describe('importing a flyover', () => {
  /** A motorway crossing a street, with or without a node in common. */
  function extract(shared: boolean) {
    const lat = 51.5;
    const lon = -0.1;
    const d = 300 / 111320;
    const e = 300 / (111320 * Math.cos((lat * Math.PI) / 180));
    return {
      elements: [
        way({ highway: 'motorway', lanes: '3', oneway: 'yes' },
          [[lat, lon - e], [lat, lon], [lat, lon + e]], shared ? [10, 99, 11] : [10, 12, 11]),
        way({ highway: 'residential' },
          [[lat - d, lon], [lat, lon], [lat + d, lon]], shared ? [20, 99, 21] : [20, 22, 21]),
      ],
    };
  }

  it('builds a junction where the ways share a node', () => {
    const { model } = importOsm(extract(true));
    const net = compile(model);
    expect(net.junctions.filter((j) => j.kind === 'crossing').length).toBe(1);
    expect(model.strokes.every((s) => s.points.every((p) => p.grade === 0))).toBe(true);
  });

  it('builds a bridge where they do not', () => {
    const { model, report } = importOsm(extract(false));
    expect(report.flyovers).toBeGreaterThan(0);
    // The motorway is raised over the middle and back down at both ends, so its
    // ends still meet whatever is there.
    const raised = model.strokes.find((s) => s.points.some((p) => p.grade > 0));
    expect(raised, 'one road goes over').toBeDefined();
    expect(raised!.points[0].grade).toBe(0);
    expect(raised!.points[raised!.points.length - 1].grade).toBe(0);
    // And the compiler agrees they do not meet.
    const net = compile(model);
    expect(net.junctions.filter((j) => j.kind === 'crossing').length).toBe(0);
  });

  it('does not raise the street instead', () => {
    const { model } = importOsm(extract(false));
    const street = model.strokes.find((s) => {
      const profile = model.profiles.find((p) => p.id === s.profileId);
      return profile && profile.speedLimit < 20;
    });
    expect(street).toBeDefined();
    expect(street!.points.every((p) => p.grade === 0)).toBe(true);
  });
});
