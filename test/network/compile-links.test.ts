import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { LaneKind } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';

describe('link between identical roads', () => {
  const model = doc();
  const p = addProfile(model, { name: 'F2', lanesForward: 2, lanesBackward: 0 });
  addStroke(model, p, line(0, 0, 500, 0));
  addStroke(model, p, line(500, 0, 1000, 0));
  const net = compile(model);

  it('joins them with no footprint and no connectors', () => {
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].kind).toBe('link');
    expect(net.junctions[0].footprint.length).toBe(0);
    expect(net.lanes.filter((l) => l.kind === LaneKind.Connector).length).toBe(0);
  });

  it('links lane successors directly', () => {
    const first = net.segments[0];
    for (const id of first.laneIds) {
      const lane = net.lanes[id];
      expect(lane.successors.length).toBe(1);
      const next = net.lanes[lane.successors[0]];
      expect(next.segmentId).toBe(1);
      expect(next.index).toBe(lane.index);
    }
  });

  it('leaves only two portals', () => {
    expect(net.portals.length).toBe(2);
  });
});

describe('3-to-2 lane drop', () => {
  const model = doc();
  const wide = addProfile(model, {
    name: 'F3', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  });
  const narrow = addProfile(model, {
    name: 'F2', lanesForward: 2, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
  });
  addStroke(model, wide, line(0, 0, 1000, 0));
  addStroke(model, narrow, line(1000, 0, 2000, 0));
  const net = compile(model);
  const wideSeg = net.segments.find((s) => s.laneIds.length === 3)!;
  const narrowSeg = net.segments.find((s) => s.laneIds.length === 2)!;
  const wideLanes = wideSeg.laneIds.map((id) => net.lanes[id]).sort((a, b) => a.index - b.index);
  const narrowLanes = narrowSeg.laneIds.map((id) => net.lanes[id]).sort((a, b) => a.index - b.index);

  it('reports the drop and no errors', () => {
    expect(net.diagnostics.some((d) => d.code === 'lane-drop')).toBe(true);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('drops the kerb-side lane', () => {
    expect(wideLanes[0].endsAt).toBeLessThan(Infinity);
    expect(wideLanes[0].successors.length).toBe(0);
    expect(wideLanes[0].mergeTarget).toBe(wideLanes[1].id);
    expect(wideLanes[1].endsAt).toBe(Infinity);
    expect(wideLanes[2].endsAt).toBe(Infinity);
  });

  it('carries the surviving lanes through', () => {
    expect(wideLanes[1].successors).toEqual([narrowLanes[0].id]);
    expect(wideLanes[2].successors).toEqual([narrowLanes[1].id]);
  });

  it('slides the surviving lanes onto the narrow cross-section', () => {
    // Narrow road lanes sit at +-1.825; the wide road starts at +-3.65 and 0.
    const endOffsetOf = (laneIndex: number): number => {
      const lane = wideLanes[laneIndex];
      return lane.centerline[lane.centerline.length - 1];
    };
    expect(endOffsetOf(1)).toBeCloseTo(1.825, 1);
    expect(endOffsetOf(2)).toBeCloseTo(-1.825, 1);
  });

  it('converges the dropped lane onto its merge target', () => {
    const dropped = wideLanes[0];
    const target = wideLanes[1];
    expect(dropped.centerline[dropped.centerline.length - 1])
      .toBeCloseTo(target.centerline[target.centerline.length - 1], 1);
  });

  it('narrows the road surface at the join', () => {
    // Sample the surface polygon's widest and narrowest half-width along the wide road.
    let maxY = -Infinity;
    let endY = 0;
    for (let i = 0; i < wideSeg.surface.length; i += 2) {
      const x = wideSeg.surface[i];
      const y = wideSeg.surface[i + 1];
      if (y > maxY) maxY = y;
      if (x > 999) endY = Math.max(endY, y);
    }
    expect(maxY).toBeCloseTo(3 * 3.65 / 2 + 2.5, 1);
    expect(endY).toBeCloseTo(2 * 3.65 / 2 + 2.5, 1);
  });

  it('keeps the taper length from the ramp spec', () => {
    const dropped = wideLanes[0];
    // The lane only starts diverging from its base offset inside the taper.
    const sampleAt = (x: number): number => {
      for (let i = 0; i < dropped.centerline.length; i += 2) {
        if (dropped.centerline[i] >= x) return dropped.centerline[i + 1];
      }
      return NaN;
    };
    expect(sampleAt(900)).toBeCloseTo(3 * 3.65 / 2 - 3.65 / 2, 1);
    expect(sampleAt(999)).toBeGreaterThan(1.5);
  });
});

describe('2-to-3 lane gain', () => {
  const model = doc();
  const narrow = addProfile(model, { name: 'F2', lanesForward: 2, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5 });
  const wide = addProfile(model, {
    name: 'F3', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  });
  addStroke(model, narrow, line(0, 0, 1000, 0));
  addStroke(model, wide, line(1000, 0, 2000, 0));
  const net = compile(model);

  it('tapers the new lane in on the wide side', () => {
    const wideSeg = net.segments.find((s) => s.laneIds.length === 3)!;
    const lanes = wideSeg.laneIds.map((id) => net.lanes[id]).sort((a, b) => a.index - b.index);
    expect(lanes[0].predecessors.length).toBe(0);
    expect(lanes[0].startsAt).toBeGreaterThan(50);
    expect(lanes[1].predecessors.length).toBe(1);
    expect(lanes[2].predecessors.length).toBe(1);
  });

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
