import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { LaneKind, TurnKind } from '@core/network/types';
import { polygonArea } from '@core/geom/intersect';
import { addProfile, addStroke, doc, line, profileNamed, pts } from '../helpers/build';

describe('four-way crossing', () => {
  const model = doc();
  const road = profileNamed(model, 'Collector 2-lane');
  addStroke(model, road, line(-300, 0, 300, 0));
  addStroke(model, road, line(0, -300, 0, 300));
  const net = compile(model);

  it('builds one junction', () => {
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].kind).toBe('crossing');
    expect(net.junctions[0].x).toBeCloseTo(0, 3);
    expect(net.junctions[0].y).toBeCloseTo(0, 3);
  });

  it('splits both strokes into two segments each', () => {
    expect(net.segments.length).toBe(4);
    for (const seg of net.segments) expect(seg.length).toBeGreaterThan(280);
  });

  it('covers the crossing with a footprint', () => {
    const fp = net.junctions[0].footprint;
    expect(fp.length).toBeGreaterThan(8);
    expect(Math.abs(polygonArea(fp))).toBeGreaterThan(50);
  });

  it('gives every approach a full set of movements', () => {
    const j = net.junctions[0];
    expect(j.approaches.length).toBe(4);
    const connectors = j.connectorIds.map((id) => net.lanes[id]);
    // One incoming lane per approach, three destinations each.
    expect(connectors.length).toBe(12);
    const turns = new Set(connectors.map((c) => c.turn));
    expect(turns.has(TurnKind.Straight)).toBe(true);
    expect(turns.has(TurnKind.Left)).toBe(true);
    expect(turns.has(TurnKind.Right)).toBe(true);
    expect(turns.has(TurnKind.UTurn)).toBe(false);
  });

  it('ranks priority as a strict total order', () => {
    const j = net.junctions[0];
    const ranks = j.connectorIds.map((id) => net.lanes[id].priorityRank).sort((a, b) => a - b);
    expect(ranks).toEqual(ranks.map((_, i) => i));
  });

  it('finds conflicts between crossing movements', () => {
    const j = net.junctions[0];
    const total = j.connectorIds.reduce((acc, id) => acc + net.lanes[id].conflicts.length, 0);
    expect(total).toBeGreaterThan(8);
  });

  it('makes lower-priority movements yield', () => {
    const j = net.junctions[0];
    const yielding = j.connectorIds.filter((id) => net.lanes[id].yields);
    expect(yielding.length).toBeGreaterThan(0);
    expect(yielding.length).toBeLessThan(j.connectorIds.length);
  });

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('T-junction', () => {
  const model = doc();
  const road = profileNamed(model, 'Collector 2-lane');
  addStroke(model, road, line(-300, 0, 300, 0));
  addStroke(model, road, line(0, 200, 0, 0));
  const net = compile(model);

  it('classifies as a crossing with three approaches', () => {
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].kind).toBe('crossing');
    expect(net.junctions[0].approaches.length).toBe(3);
  });

  it('leaves the stem as one segment', () => {
    expect(net.segments.length).toBe(3);
  });

  it('lets the stem turn both ways and lets the through road turn in', () => {
    const j = net.junctions[0];
    const turns = j.connectorIds.map((id) => net.lanes[id].turn);
    expect(turns.filter((t) => t === TurnKind.Left).length).toBeGreaterThan(0);
    expect(turns.filter((t) => t === TurnKind.Right).length).toBeGreaterThan(0);
    expect(turns.filter((t) => t === TurnKind.Straight).length).toBe(2);
  });

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('near-parallel overlap', () => {
  it('is rejected rather than turned into a sliver junction', () => {
    const model = doc();
    const road = profileNamed(model, 'Collector 2-lane');
    addStroke(model, road, line(-300, 0, 300, 0));
    addStroke(model, road, pts(-200, -20, 200, 20));
    const net = compile(model);
    expect(net.junctions.length).toBe(0);
    expect(net.diagnostics.some((d) => d.code === 'near-parallel-overlap')).toBe(true);
  });
});

describe('grade separation', () => {
  it('does not join roads on different grades', () => {
    const model = doc();
    const road = profileNamed(model, 'Collector 2-lane');
    addStroke(model, road, line(-300, 0, 300, 0), 0);
    addStroke(model, road, line(0, -300, 0, 300), 1);
    const net = compile(model);
    expect(net.junctions.length).toBe(0);
    expect(net.segments.length).toBe(2);
    expect(net.lanes.filter((l) => l.kind === LaneKind.Connector).length).toBe(0);
  });
});

describe('signalised junction', () => {
  it('gets a phase plan when every approach is multi-lane', () => {
    const model = doc();
    const arterial = addProfile(model, {
      name: 'A4', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2,
    });
    addStroke(model, arterial, line(-400, 0, 400, 0));
    addStroke(model, arterial, line(0, -400, 0, 400));
    const net = compile(model);
    const j = net.junctions[0];
    expect(j.control).toBe('signal');
    expect(j.signal).toBeDefined();
    expect(j.signal!.phases.length).toBe(2);
    expect(j.signal!.cycle).toBeGreaterThan(30);
    const covered = new Set(j.signal!.phases.flatMap((p) => p.greenLanes));
    expect(covered.size).toBe(j.connectorIds.length);
  });
});

describe('junction control overrides', () => {
  it('honours a user choice across recompiles', () => {
    const model = doc();
    const arterial = addProfile(model, {
      name: 'A4', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2,
    });
    addStroke(model, arterial, line(-400, 0, 400, 0));
    addStroke(model, arterial, line(0, -400, 0, 400));
    expect(compile(model).junctions[0].control).toBe('signal');

    model.junctions.push({ x: 0, y: 0, control: 'priority' });
    const net = compile(model);
    expect(net.junctions[0].control).toBe('priority');
    expect(net.junctions[0].signal).toBeUndefined();
    for (const id of net.junctions[0].connectorIds) expect(net.lanes[id].signalGroup).toBe(-1);
  });

  it('re-matches the override after the junction moves a little', () => {
    const model = doc();
    const road = profileNamed(model, 'Collector 2-lane');
    addStroke(model, road, line(-300, 0, 300, 0));
    addStroke(model, road, line(0, -300, 0, 300));
    model.junctions.push({ x: 0, y: 0, control: 'signal' });
    expect(compile(model).junctions[0].control).toBe('signal');

    // Nudge one road: the junction shifts but stays the same junction.
    model.strokes[1].points.forEach((p) => { p.x += 4; p.hix += 4; p.hox += 4; });
    expect(compile(model).junctions[0].control).toBe('signal');
  });

  it('ignores an override that no longer belongs to any junction', () => {
    const model = doc();
    const major = addProfile(model, {
      name: 'Major', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2, speedLimit: 19,
    });
    const minor = profileNamed(model, 'Residential 2-lane');
    addStroke(model, major, line(-300, 0, 300, 0));
    addStroke(model, minor, line(0, -300, 0, 300));
    expect(compile(model).junctions[0].control).toBe('priority');
    model.junctions.push({ x: 900, y: 900, control: 'signal' });
    expect(compile(model).junctions[0].control).toBe('priority');
  });
});

/**
 * A junction box may not stick out past the roads that made it.
 *
 * Each approach corridor is a rectangle cut square across its far end, so at a skew
 * its leading *corner* runs ahead of its centreline by half a width times the
 * cosine. Reach far enough for the centreline to touch the far kerb and that corner
 * clears it — a rectangular hump of asphalt poking out of the far side of the box,
 * on a side no road goes.
 */
describe('junction footprint extent', () => {
  function skewTee(angleDeg: number) {
    const model = doc();
    const arterial = addProfile(model, {
      name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      shoulder: 0.8, median: 2.4, speedLimit: 19,
    });
    const street = addProfile(model, {
      name: 'street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
      shoulder: 0.4, speedLimit: 11,
    });
    addStroke(model, arterial, line(-400, 0, 400, 0));
    const t = (angleDeg * Math.PI) / 180;
    addStroke(model, street, line(0, 0, Math.cos(t) * 600, Math.sin(t) * 600));
    return compile(model);
  }

  for (const angle of [35, 50, 90]) {
    it(`keeps the box off the far kerb at ${angle} degrees`, () => {
      const net = skewTee(angle);
      const junction = net.junctions.find((j) => j.kind === 'crossing');
      expect(junction, `${angle} deg`).toBeDefined();
      const arterial = net.segments.reduce((a, b) => (a.maxHalfWidth > b.maxHalfWidth ? a : b));
      // The street leaves on the +y side, so nothing is meant to be up at -y beyond
      // the arterial's kerb but the corner fillet.
      let highest = 0;
      const f = junction!.footprint;
      for (let i = 1; i < f.length; i += 2) highest = Math.min(highest, f[i]);
      expect(-highest - arterial.maxHalfWidth, `${angle} deg`).toBeLessThan(0.6);
    });
  }
});
