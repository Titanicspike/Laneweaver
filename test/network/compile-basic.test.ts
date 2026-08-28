import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { LaneKind } from '@core/network/types';
import { addProfile, addStroke, doc, line, profileNamed } from '../helpers/build';
import { createDemoDocument } from '@app/demo';

describe('compiling a single straight road', () => {
  const model = doc();
  const profile = profileNamed(model, 'Collector 2-lane');
  addStroke(model, profile, line(0, 0, 400, 0));
  const net = compile(model);

  it('emits one segment', () => {
    expect(net.segments.length).toBe(1);
    expect(net.segments[0].length).toBeCloseTo(400, 2);
  });

  it('emits one lane per direction with correct offsets', () => {
    expect(net.lanes.length).toBe(2);
    const forward = net.lanes.find((l) => l.side === 1);
    const backward = net.lanes.find((l) => l.side === -1);
    expect(forward).toBeDefined();
    expect(backward).toBeDefined();
    // Right-hand traffic, y down: forward traffic sits at positive offset.
    expect(forward!.offset).toBeCloseTo(1.75, 6);
    expect(backward!.offset).toBeCloseTo(-1.75, 6);
    expect(forward!.centerline[1]).toBeCloseTo(1.75, 3);
    expect(backward!.centerline[1]).toBeCloseTo(-1.75, 3);
  });

  it('orients lanes along their direction of travel', () => {
    const forward = net.lanes.find((l) => l.side === 1)!;
    const backward = net.lanes.find((l) => l.side === -1)!;
    expect(forward.centerline[0]).toBeCloseTo(0, 3);
    expect(forward.centerline[forward.centerline.length - 2]).toBeCloseTo(400, 3);
    expect(backward.centerline[0]).toBeCloseTo(400, 3);
    expect(backward.centerline[backward.centerline.length - 2]).toBeCloseTo(0, 3);
  });

  it('makes a portal at each free end', () => {
    expect(net.portals.length).toBe(2);
    const entries = net.portals.flatMap((p) => p.entryLanes);
    const exits = net.portals.flatMap((p) => p.exitLanes);
    expect(entries.length).toBe(2);
    expect(exits.length).toBe(2);
  });

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('draws a road surface of the right area', () => {
    const seg = net.segments[0];
    expect(seg.surface.length).toBeGreaterThan(6);
    expect(seg.maxHalfWidth).toBeCloseTo(3.5 + 0.8, 6);
  });
});

describe('compiling a one-way freeway', () => {
  const model = doc();
  const profile = addProfile(model, { name: 'F3', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65 });
  addStroke(model, profile, line(0, 0, 1000, 0));
  const net = compile(model);

  it('centres the cross-section on the stroke', () => {
    const offsets = net.lanes.map((l) => l.offset).sort((a, b) => a - b);
    expect(offsets.length).toBe(3);
    expect(offsets[0]).toBeCloseTo(-3.65, 6);
    expect(offsets[1]).toBeCloseTo(0, 6);
    expect(offsets[2]).toBeCloseTo(3.65, 6);
  });

  it('indexes lane 0 as the rightmost', () => {
    const byIndex = new Map(net.lanes.map((l) => [l.index, l]));
    expect(byIndex.get(0)!.offset).toBeCloseTo(3.65, 6);
    expect(byIndex.get(2)!.offset).toBeCloseTo(-3.65, 6);
  });

  it('links lateral neighbours', () => {
    const byIndex = new Map(net.lanes.map((l) => [l.index, l]));
    expect(byIndex.get(0)!.left).toBe(byIndex.get(1)!.id);
    expect(byIndex.get(0)!.right).toBe(-1);
    expect(byIndex.get(1)!.right).toBe(byIndex.get(0)!.id);
    expect(byIndex.get(2)!.left).toBe(-1);
  });

  it('has no connectors', () => {
    expect(net.lanes.filter((l) => l.kind === LaneKind.Connector).length).toBe(0);
  });
});

describe('portals', () => {
  it('only marks an end where the network actually stops', () => {
    // A plain split — one stroke carrying two auxiliary lanes on the same side, so
    // each gets its own cross-section — wires its lanes straight across without a
    // junction. Reading "no junction here" as "the road ends here" drops a spawn
    // point into the middle of a running carriageway: vehicles appear on top of
    // traffic crossing the boundary and the ones behind stop dead.
    const net = compile(createDemoDocument());
    expect(net.portals.length).toBeGreaterThan(0);
    for (const portal of net.portals) {
      for (const id of portal.exitLanes) {
        expect(net.lanes[id]!.successors.length).toBe(0);
      }
      for (const id of portal.entryLanes) {
        expect(net.lanes[id]!.predecessors.length).toBe(0);
      }
    }
  });

  it('leaves the freeway with one entry and one exit, end to end', () => {
    const net = compile(createDemoDocument());
    // Every lane of the mainline stroke, and the two-lane stroke it drops into.
    const mainline = net.segments.filter((s) => s.strokeId === net.segments[0]!.strokeId);
    expect(mainline.length).toBeGreaterThan(1);
    const ids = new Set(mainline.flatMap((s) => s.laneIds));
    for (const portal of net.portals) {
      for (const id of [...portal.entryLanes, ...portal.exitLanes]) {
        if (!ids.has(id)) continue;
        // The only portal on the mainline is at its far upstream end.
        const lane = net.lanes[id]!;
        const seg = net.segments[lane.segmentId]!;
        expect(seg.strokeS0).toBeLessThan(1);
      }
    }
  });
});
