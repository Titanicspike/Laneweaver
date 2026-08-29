/**
 * Crossings OpenStreetMap says are not crossings, and the levels they need.
 *
 * A hand-drawn document has only geometry, so the compiler has only geometry to go
 * on: two roads whose centrelines cross, cross. A survey has topology as well, and
 * it is unambiguous — two ways that cross **without sharing a node do not connect**.
 * That is how every flyover in OSM is recorded. Where the bridge carries a tag
 * (`bridge=yes`, `layer=1`) `layerOf` already reads it; plenty carry none, and then
 * the compiler wires a motorway into the street beneath it.
 *
 * Which of the two goes over is **not** a pairwise question, and answering it as one
 * is what broke the interchanges. Four ramps crossing in the same hundred metres
 * have six crossings between them; "the bigger road goes over", applied to each in
 * turn, puts three of them on level 1 where they cross each other again. It is a
 * colouring, and `assignLevels` does it as one.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { importOsm, type OsmWay } from '@core/osm/import';
import { assignLevels, bridgeSpans, findCrossings } from '@core/osm/flyovers';

let nextId = 1;

/** A way through the given world-metre points, for the crossing finder directly. */
function metreWay(highway: string, nodes: number[], ...xy: number[]) {
  return { id: nextId++, raw: xy, nodes, tags: { highway }, base: 0 };
}

/** The level each way ends up on, keyed by way id. */
function levels(ways: ReturnType<typeof metreWay>[]): Map<number, number> {
  const offset = assignLevels(ways, findCrossings(ways));
  return new Map(ways.map((w, i) => [w.id, w.base + offset[i]]));
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
    const found = findCrossings([motorway, street]);
    expect(found.length).toBe(1);
    // Half way along each.
    expect(found[0].sa).toBeCloseTo(100, 1);
    expect(found[0].sb).toBeCloseTo(100, 1);
  });

  it('reports nothing where they share one', () => {
    // The same shape with a node in common is a junction and must stay one.
    const motorway = metreWay('motorway', [1, 7, 2], -100, 0, 0, 0, 100, 0);
    const street = metreWay('residential', [3, 7, 4], 0, -100, 0, 0, 0, 100);
    expect(findCrossings([motorway, street]).length).toBe(0);
  });

  it('reports nothing for two roads that only meet end to end', () => {
    // Which is what a shared node looks like geometrically, and is the case the
    // end-margin test exists for: a way that ends on another meets it.
    const a = metreWay('primary', [1, 2], -100, 0, 0, 0);
    const b = metreWay('primary', [3, 4], 0, 0, 100, 0);
    expect(findCrossings([a, b]).length).toBe(0);
  });

  it('reports nothing where the tags already put them on different levels', () => {
    const under = metreWay('primary', [1, 2], -100, 0, 100, 0);
    const over = { ...metreWay('primary', [3, 4], 0, -100, 0, 100), base: 1 };
    expect(findCrossings([under, over]).length).toBe(0);
  });
});

describe('choosing a level for each road', () => {
  it('sends the bigger road over the smaller one', () => {
    const street = metreWay('residential', [1, 2], -100, 0, 100, 0);
    const trunk = metreWay('trunk', [3, 4], 0, -100, 0, 100);
    const at = levels([street, trunk]);
    expect(at.get(street.id)).toBe(0);
    expect(at.get(trunk.id)).toBe(1);
  });

  it('stacks an interchange instead of putting it all on one level', () => {
    // Four roads crossing in the same place, none sharing a node with any other:
    // six crossings between them. Answered one pair at a time, three of them land
    // on level 1 and cross each other there — the stack joined back together.
    const roads = [
      metreWay('service', [1, 2], -100, 0, 100, 0),
      metreWay('residential', [3, 4], 0, -100, 0, 100),
      metreWay('primary', [5, 6], -100, -100, 100, 100),
      metreWay('motorway', [7, 8], -100, 100, 100, -100),
    ];
    const at = levels(roads);
    const used = roads.map((r) => at.get(r.id) as number);
    expect(new Set(used).size, 'every road on its own level').toBe(4);
    // And in the order a real interchange has them.
    expect(used[0]).toBeLessThan(used[3]);
    expect(at.get(roads[3].id)).toBe(3);
  });

  it('reuses a level where two roads never meet each other', () => {
    // Two parallel side streets crossing one main road: they do not cross each
    // other, so they share the ground and only the main road climbs. A stack that
    // counted crossings rather than colouring them would put them on 0 and 1.
    const a = metreWay('residential', [1, 2], -100, -50, 100, -50);
    const b = metreWay('residential', [3, 4], -100, 50, 100, 50);
    const main = metreWay('primary', [5, 6], 0, -100, 0, 100);
    const at = levels([a, b, main]);
    expect(at.get(a.id)).toBe(0);
    expect(at.get(b.id)).toBe(0);
    expect(at.get(main.id)).toBe(1);
  });

  it('decides the same way whichever order it is given them in', () => {
    const a = metreWay('residential', [1, 2], -100, 0, 100, 0);
    const b = metreWay('residential', [3, 4], 0, -100, 0, 100);
    const one = levels([a, b]);
    const two = levels([b, a]);
    expect(one.get(a.id)).toBe(two.get(a.id));
    expect(one.get(b.id)).toBe(two.get(b.id));
  });

  it('leaves a road alone rather than hanging it in the sky', () => {
    // Six roads all crossing each other would need six levels. Four is a stack;
    // more than that is a tagging problem, and one wrong junction beats a road at
    // level nine.
    const roads: ReturnType<typeof metreWay>[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI;
      roads.push(metreWay('primary', [i * 2 + 1, i * 2 + 2],
        -Math.cos(a) * 100, -Math.sin(a) * 100, Math.cos(a) * 100, Math.sin(a) * 100));
    }
    const at = levels(roads);
    for (const r of roads) expect(at.get(r.id)).toBeLessThanOrEqual(3);
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
