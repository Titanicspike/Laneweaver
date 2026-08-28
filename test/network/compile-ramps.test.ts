import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { LaneKind, TurnKind, type Network } from '@core/network/types';
import { addProfile, addStroke, doc, line, pts } from '../helpers/build';

function freewayDoc(mainLanes = 3, rampLanes = 1) {
  const model = doc();
  const freeway = addProfile(model, {
    name: `Freeway ${mainLanes} one-way`, lanesForward: mainLanes, lanesBackward: 0,
    laneWidth: 3.65, shoulder: 2.5,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  });
  const ramp = addProfile(model, {
    name: 'Ramp', lanesForward: rampLanes, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
    isRamp: true,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  });
  return { model, freeway, ramp };
}

/** Carriageway half-width for the 3-lane freeway above. */
const HALF = (3 * 3.65) / 2;

describe('on-ramp merge', () => {
  const { model, freeway, ramp } = freewayDoc();
  addStroke(model, freeway, line(0, 0, 2000, 0));
  addStroke(model, ramp, pts(600, 100, 1000, 0));
  const net: Network = compile(model);
  const auxLane = net.lanes.find((l) => l.aux);

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('does not split the mainline', () => {
    const mainSegments = net.segments.filter((s) => s.laneIds.length >= 3);
    expect(mainSegments.length).toBe(1);
    expect(mainSegments[0].length).toBeCloseTo(2000, 1);
  });

  it('classifies the junction as a merge', () => {
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].kind).toBe('merge');
  });

  it('grows an acceleration lane on the kerb side', () => {
    expect(auxLane).toBeDefined();
    expect(auxLane!.offset).toBeCloseTo(HALF + 3.65 / 2, 3);
    expect(auxLane!.length).toBeCloseTo(220 + 75, 0);
  });

  it('starts the accel lane at the gore, not at the road centreline', () => {
    // The ramp crosses y = HALF + 1.825 = 7.3 at x = 1000 - 400 * 7.3 / 100.
    const expectedGore = 1000 - 400 * ((HALF + 3.65 / 2) / 100);
    expect(auxLane!.parentS[0]).toBeCloseTo(expectedGore, 0);
  });

  it('ends the accel lane with a merge into the rightmost through lane', () => {
    expect(auxLane!.endsAt).toBeCloseTo(auxLane!.length, 3);
    const target = net.lanes[auxLane!.mergeTarget];
    expect(target).toBeDefined();
    expect(target.aux).toBe(false);
    expect(target.index).toBe(0);
    expect(target.offset).toBeCloseTo(HALF - 3.65 / 2, 3);
  });

  it('tapers the accel lane centreline inward at the end', () => {
    const last = auxLane!.centerline[auxLane!.centerline.length - 1];
    expect(last).toBeCloseTo(HALF, 1);
  });

  it('connects the ramp into the accel lane with a blend connector', () => {
    const connectors = net.lanes.filter((l) => l.kind === LaneKind.Connector);
    expect(connectors.length).toBe(1);
    expect(connectors[0].turn).toBe(TurnKind.Merge);
    expect(connectors[0].successors).toEqual([auxLane!.id]);
    expect(connectors[0].length).toBeGreaterThan(5);
    expect(connectors[0].length).toBeLessThan(60);
  });

  it('trims the ramp back from the gore', () => {
    const rampSeg = net.segments.find((s) => s.laneIds.length === 1)!;
    const rampLane = net.lanes[rampSeg.laneIds[0]];
    const endX = rampLane.centerline[rampLane.centerline.length - 2];
    expect(endX).toBeLessThan(960);
    expect(endX).toBeGreaterThan(880);
  });

  it('widens the road surface over the accel lane', () => {
    const main = net.segments.find((s) => s.laneIds.length >= 3)!;
    expect(main.maxHalfWidth).toBeCloseTo(HALF + 2.5 + 3.65, 2);
  });

  it('gives the ramp an entry portal but no exit at the gore', () => {
    const rampSeg = net.segments.find((s) => s.laneIds.length === 1)!;
    const portal = net.portals.find((p) => p.entryLanes.some((id) => rampSeg.laneIds.includes(id)));
    expect(portal).toBeDefined();
  });
});

describe('off-ramp diverge', () => {
  const { model, freeway, ramp } = freewayDoc();
  addStroke(model, freeway, line(0, 0, 2000, 0));
  addStroke(model, ramp, pts(1000, 0, 1400, 100));
  const net = compile(model);
  const auxLane = net.lanes.find((l) => l.aux);

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('classifies the junction as a diverge', () => {
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].kind).toBe('diverge');
  });

  it('grows a deceleration lane upstream of the gore', () => {
    expect(auxLane).toBeDefined();
    expect(auxLane!.length).toBeCloseTo(160 + 75, 0);
    const gore = 1000 + 400 * ((HALF + 3.65 / 2) / 100);
    expect(auxLane!.parentS[auxLane!.parentS.length - 1]).toBeCloseTo(gore, 0);
  });

  it('tapers in rather than ending in a merge', () => {
    expect(auxLane!.endsAt).toBe(Infinity);
    expect(auxLane!.startsAt).toBeCloseTo(75, 0);
    expect(auxLane!.centerline[1]).toBeCloseTo(HALF, 1);
  });

  it('sends the decel lane onto the ramp', () => {
    const connector = net.lanes.find((l) => l.kind === LaneKind.Connector)!;
    expect(connector.turn).toBe(TurnKind.Diverge);
    expect(connector.predecessors).toEqual([auxLane!.id]);
  });
});

describe('weaving section', () => {
  const { model, freeway, ramp } = freewayDoc();
  addStroke(model, freeway, line(0, 0, 2000, 0));
  addStroke(model, ramp, pts(600, 100, 1000, 0));
  addStroke(model, ramp, pts(1100, 0, 1500, 100));
  const net = compile(model);

  it('fuses the two auxiliary lanes into one weaving lane', () => {
    const aux = net.lanes.filter((l) => l.aux);
    expect(aux.length).toBe(1);
    expect(aux[0].length).toBeGreaterThan(100);
  });

  /**
   * The weaving lane is the section *between the gores*, and no longer.
   *
   * It used to be the union of the acceleration lane and the deceleration lane,
   * which is the same thing whenever there is room between the two ramps and wrong
   * at both ends when there is not: the entrance's acceleration lane runs on past
   * the exit, and the exit's deceleration lane starts before the entrance. Since
   * connectors run lane-end to lane-start, a lane that overshoots the exit makes the
   * diverge connector swing back upstream to find the ramp, and one that starts
   * early makes the merge connector reach forward to find the lane. On two-lane
   * ramps eighty metres apart that gave connectors of 186 m and 113 m where the same
   * pair six hundred metres apart gives 36 m — and 10% of drivers missed the exit,
   * because getting to it meant driving two hundred metres past it first.
   */
  it('runs gore to gore, so both blends stay short', () => {
    const aux = net.lanes.find((l) => l.aux)!;
    const blends = net.lanes.filter(
      (l) => l.kind === LaneKind.Connector
        && (l.predecessors.includes(aux.id) || l.successors.includes(aux.id)),
    );
    // One in, one out: the entrance's and the exit's.
    expect(blends.length).toBe(2);
    for (const b of blends) {
      expect(b.length, `blend ${b.id} is ${b.length.toFixed(0)} m long`).toBeLessThan(60);
    }
    // And the lane itself spans the two gores rather than reaching past either.
    const gap = Math.hypot(1100 - 1000, 0);
    expect(aux.length).toBeLessThan(gap + 120);
  });

  it('keeps the merge deadline so through traffic must exit or merge left', () => {
    const aux = net.lanes.find((l) => l.aux)!;
    expect(aux.endsAt).toBeCloseTo(aux.length, 3);
    expect(aux.mergeTarget).toBeGreaterThanOrEqual(0);
    expect(aux.successors.length).toBe(1);
    expect(net.lanes[aux.successors[0]].turn).toBe(TurnKind.Diverge);
  });

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

/**
 * Two-lane ramps close together — the case that fused half a stack.
 *
 * A two-lane ramp brings in a *stack* of auxiliary lanes, staggered so the road
 * grows a lane at a time. The stagger means a merge stack and a following diverge
 * stack can overlap at one depth and fall short at the next, and fusing only the
 * depth that overlaps leaves the cross-section incoherent — a continuous weaving
 * lane beside two separate ones, which then asks the road to be split straight
 * through the fused lane. The on-ramp's outer lane came out wired to the off-ramp's
 * deceleration lane 282 m downstream, and the traffic never recovered.
 */
describe('two-lane ramps close enough to weave', () => {
  for (const gap of [250, 400, 600]) {
    describe(`${gap} m apart`, () => {
      const { model, freeway, ramp } = freewayDoc(3, 2);
      addStroke(model, freeway, line(0, 0, 3000, 0));
      addStroke(model, ramp, pts(600, 100, 1000, 0));
      addStroke(model, ramp, pts(1000 + gap, 0, 1400 + gap, 100));
      const net = compile(model);

      it('reports no errors', () => {
        expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      });

      it('keeps every ramp blend a blend', () => {
        // The whole failure is visible in one number: a connector an order of
        // magnitude longer than its siblings is one that went looking for a lane
        // hundreds of metres away.
        const blends = net.lanes.filter(
          (l) => l.kind === LaneKind.Connector && l.turn === TurnKind.Diverge,
        ).concat(net.lanes.filter(
          (l) => l.kind === LaneKind.Connector && l.turn === TurnKind.Merge,
        ));
        expect(blends.length).toBe(4);
        for (const b of blends) {
          expect(b.length, `blend ${b.id} is ${b.length.toFixed(0)} m`).toBeLessThan(80);
        }
      });

      it('gives every segment a coherent cross-section', () => {
        // Within one stretch of road, either the whole auxiliary stack is a weaving
        // stack or none of it is. Half a fusion is the defect: one lane running
        // gore to gore beside another that stops in between, which is a cross-section
        // no road has and the reason the road then wanted splitting through it.
        for (const seg of net.segments) {
          const aux = seg.laneIds.map((id) => net.lanes[id]).filter((l) => l.aux);
          if (aux.length < 2) continue;
          const weaving = aux.filter((l) => l.successors.length > 0).length;
          expect(weaving === 0 || weaving === aux.length,
            `segment ${seg.id}: ${weaving} of ${aux.length} auxiliary lanes carry an exit`)
            .toBe(true);
          // And they agree about where the stack begins and ends, to within a taper.
          const los = aux.map((l) => l.parentS[0]);
          const his = aux.map((l) => l.parentS[l.parentS.length - 1]);
          expect(Math.max(...los) - Math.min(...los)).toBeLessThan(100);
          expect(Math.max(...his) - Math.min(...his)).toBeLessThan(100);
        }
      });
    });
  }
});

describe('an on-ramp and a later off-ramp on the same road', () => {
  const { model, freeway, ramp } = freewayDoc();
  addStroke(model, freeway, line(0, 0, 3000, 0));
  addStroke(model, ramp, pts(400, 100, 800, 0));
  addStroke(model, ramp, pts(2000, 0, 2400, 100));
  const net = compile(model);

  it('reports no errors', () => {
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('splits the road so each auxiliary lane gets its own cross-section', () => {
    const main = net.segments.filter((s) => s.laneIds.length >= 3);
    expect(main.length).toBe(2);
    for (const seg of main) {
      expect(seg.laneIds.filter((id) => net.lanes[id].aux).length).toBe(1);
    }
  });

  it('gives both auxiliary lanes the same slot, not stacked ones', () => {
    const aux = net.lanes.filter((l) => l.aux);
    expect(aux.length).toBe(2);
    for (const lane of aux) expect(lane.index).toBe(-1);
    expect(aux[0].offset).toBeCloseTo(aux[1].offset, 6);
  });

  it('points the acceleration lane at a real through lane', () => {
    const accel = net.lanes.find((l) => l.aux && l.endsAt < Infinity)!;
    const target = net.lanes[accel.mergeTarget];
    expect(target).toBeDefined();
    expect(target.aux).toBe(false);
    expect(target.segmentId).toBe(accel.segmentId);
    expect(target.index).toBe(0);
  });

  it('wires the through lanes straight across the split', () => {
    const main = net.segments.filter((s) => s.laneIds.length >= 3)
      .sort((a, b) => a.strokeS0 - b.strokeS0);
    const first = main[0].laneIds.map((id) => net.lanes[id]).filter((l) => !l.aux);
    const second = main[1].laneIds.map((id) => net.lanes[id]).filter((l) => !l.aux);
    for (const lane of first) {
      expect(lane.successors.length).toBe(1);
      const next = net.lanes[lane.successors[0]];
      expect(second).toContain(next);
      expect(next.index).toBe(lane.index);
    }
  });

  it('lets traffic reach the off-ramp from every lane', () => {
    const exit = net.portals.find((p) => p.exitLanes.some((id) => {
      const seg = net.segments[net.lanes[id].segmentId];
      return seg.laneIds.length === 1 && seg.strokeS0 < 500;
    }));
    expect(exit ?? net.portals.length).toBeTruthy();
  });
});

describe('multi-lane ramps', () => {
  function twoLaneDoc(kind: 'on' | 'off') {
    const model = doc();
    const freeway = addProfile(model, {
      name: 'Freeway 3 one-way', lanesForward: 3, lanesBackward: 0,
      laneWidth: 3.65, shoulder: 2.5,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const ramp = addProfile(model, {
      name: 'Ramp 2', lanesForward: 2, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
      isRamp: true,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    addStroke(model, freeway, line(0, 0, 2000, 0));
    addStroke(model, ramp, kind === 'on'
      ? pts(600, 200, 800, 90, 1000, 0)
      : pts(1000, 0, 1200, 90, 1400, 200));
    return compile(model);
  }

  for (const kind of ['on', 'off'] as const) {
    describe(`${kind}-ramp`, () => {
      const net = twoLaneDoc(kind);
      const aux = net.lanes.filter((l) => l.aux).sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));

      it('reports no errors', () => {
        expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      });

      // Two lanes of ramp need two lanes of road to arrive on or leave from. One
      // auxiliary lane feeding two ramp lanes is the defect this covers: the road
      // stays a lane too narrow and the ramp appears to double out of nothing.
      it('grows one auxiliary lane per ramp lane, stacked outward', () => {
        expect(aux.length).toBe(2);
        expect(Math.abs(aux[1].offset) - Math.abs(aux[0].offset)).toBeCloseTo(3.65, 2);
      });

      // Staggered, so the road gains a lane at a time rather than two at one taper.
      it('staggers the outer lane a taper short of the inner one', () => {
        expect(aux[1].length).toBeCloseTo(aux[0].length - 75, 0);
      });

      it('pairs each ramp lane with its own auxiliary lane', () => {
        const connectors = net.lanes.filter((l) => l.kind === LaneKind.Connector);
        expect(connectors.length).toBe(2);
        const auxEnds = new Set<number>();
        const rampEnds = new Set<number>();
        for (const c of connectors) {
          const [roadSide, rampSide] = kind === 'on'
            ? [c.successors[0], c.predecessors[0]]
            : [c.predecessors[0], c.successors[0]];
          expect(net.lanes[roadSide].aux).toBe(true);
          expect(net.lanes[rampSide].aux).toBe(false);
          auxEnds.add(roadSide);
          rampEnds.add(rampSide);
        }
        expect(auxEnds.size).toBe(2);
        expect(rampEnds.size).toBe(2);
      });

      // The two gore lines mirror each other about the movement they follow. Read
      // the connector's direction backwards and they both land down the middle,
      // which a one-lane ramp hides because its two lines are symmetric anyway.
      it('paints the gore edge lines on opposite sides of the blend', () => {
        const junction = net.junctions.find((j) => j.kind === (kind === 'on' ? 'merge' : 'diverge'));
        expect(junction).toBeDefined();
        const edges = junction!.markings.filter((m) => m.style === 'edge');
        expect(edges.length).toBe(2);
        const at = (m: { points: Float32Array }, end: 0 | 1): [number, number] => {
          const i = end === 0 ? 0 : (m.points.length >> 1) - 1;
          return [m.points[i * 2], m.points[i * 2 + 1]];
        };
        for (const end of [0, 1] as const) {
          const [ax, ay] = at(edges[0], end);
          const [bx, by] = at(edges[1], end);
          expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(4);
        }
      });
    });
  }
});

/**
 * A gore's edge lines continue the ramp's own, so where they meet they have to be
 * the same line.
 *
 * The connector is as wide as the auxiliary lane it blends into, and a ramp is
 * usually built wider than a freeway lane. Size the gore paint off the connector
 * and every ramp in the network carries a visible jog in both edge lines at the
 * hand-over — half the difference in lane width, which on stock profiles is more
 * than a whole marking width.
 */
describe('gore paint meets the ramp it continues', () => {
  function rampDoc(rampLaneWidth: number, kind: 'on' | 'off') {
    const model = doc();
    const freeway = addProfile(model, {
      name: 'Freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const ramp = addProfile(model, {
      name: 'Ramp', lanesForward: 1, lanesBackward: 0, laneWidth: rampLaneWidth,
      shoulder: 1.2, isRamp: true,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    addStroke(model, freeway, line(0, 0, 2000, 0));
    addStroke(model, ramp, kind === 'on'
      ? pts(600, 200, 800, 90, 1000, 0)
      : pts(1000, 0, 1200, 90, 1400, 200));
    return compile(model);
  }

  const endsOf = (pts2: Float32Array): Array<[number, number]> => {
    const n = pts2.length >> 1;
    return [[pts2[0], pts2[1]], [pts2[(n - 1) * 2], pts2[(n - 1) * 2 + 1]]];
  };
  const distToPolyline = (poly: Float32Array, x: number, y: number): number => {
    let best = Infinity;
    for (let i = 0; i + 3 < poly.length; i += 2) {
      const ax = poly[i], ay = poly[i + 1], bx = poly[i + 2], by = poly[i + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
    }
    return best;
  };

  // 4 m is the stock ramp width against a 3.65 m freeway lane; 3.0 exercises the
  // other direction, where the ramp is narrower than the lane it blends into.
  for (const width of [4, 3.65, 3.0]) {
    for (const kind of ['on', 'off'] as const) {
      it(`joins the ramp's edge lines at ${width} m lanes (${kind}-ramp)`, () => {
        const net = rampDoc(width, kind);
        const junction = net.junctions.find((j) => j.kind === (kind === 'on' ? 'merge' : 'diverge'));
        expect(junction).toBeDefined();
        const edges = junction!.markings.filter((m) => m.style === 'edge');
        expect(edges.length).toBe(2);
        for (const marking of edges) {
          for (const [x, y] of endsOf(marking.points)) {
            let best = Infinity;
            for (const seg of net.segments) {
              for (const other of seg.markings) {
                if (other.style !== 'edge' || other.points.length < 4) continue;
                best = Math.min(best, distToPolyline(other.points, x, y));
              }
            }
            expect(best, `end (${x.toFixed(0)},${y.toFixed(0)})`).toBeLessThan(0.12);
          }
        }
      });
    }
  }
});

/**
 * Ramp lane arrangements: a highway lane that both continues and branches off, and
 * a ramp lane that becomes a permanent highway lane.
 *
 * Both are opt-in per gore. The default has neither, because both trade something:
 * an option lane puts exiting traffic's deceleration in a through lane, and an
 * added lane commits the road to being a lane wider for the rest of its length.
 */
describe('ramp lane arrangements', () => {
  /**
   * A count, not a flag. A two-lane entrance has three sensible answers — keep
   * both, keep one and merge the other into it, keep neither — and with only a flag
   * the middle one was forced: the road grew a lane and lost it again three hundred
   * metres later with no way to say otherwise.
   */
  it('keeps exactly as many lanes as it is told to', () => {
    const keptForever = (rampLanes: number, keep: number): number => {
      const model = doc();
      const freeway = addProfile(model, {
        name: 'Freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
        rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
      });
      const ramp = addProfile(model, {
        name: 'Ramp', lanesForward: rampLanes, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
        isRamp: true,
        rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
      });
      addStroke(model, freeway, line(-1200, 0, 1200, 0));
      addStroke(model, ramp, pts(-600, 200, -300, 90, 0, 0));
      const gore = compile(model).junctions.find((j) => j.kind === 'merge')!;
      model.junctions.push({ x: gore.x, y: gore.y, control: 'priority', addedLanes: keep });
      const net = compile(model);
      expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      return net.lanes.filter((l) => l.kind === LaneKind.Road && l.aux && l.endsAt === Infinity).length;
    };

    for (const rampLanes of [1, 2]) {
      for (let keep = 0; keep <= rampLanes; keep++) {
        expect(keptForever(rampLanes, keep), `${rampLanes}-lane ramp keeping ${keep}`).toBe(keep);
      }
    }
    // And asking for more than the ramp has is clamped rather than obeyed.
    expect(keptForever(1, 3)).toBe(1);
  });


  function rampDoc(kind: 'on' | 'off', rampLanes: number, flag?: 'optionLane' | 'addedLanes') {
    const model = doc();
    const freeway = addProfile(model, {
      name: 'Freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const ramp = addProfile(model, {
      name: 'Ramp', lanesForward: rampLanes, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
      isRamp: true,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    addStroke(model, freeway, line(-1200, 0, 1200, 0));
    addStroke(model, ramp, kind === 'on'
      ? pts(-600, 200, -300, 90, 0, 0)
      : pts(0, 0, 200, 90, 500, 200));
    if (flag) {
      const gore = compile(model).junctions.find((j) => j.kind !== 'link')!;
      model.junctions.push({
        x: gore.x, y: gore.y, control: 'priority',
        ...(flag === 'addedLanes' ? { addedLanes: 1 } : { optionLane: true }),
      });
    }
    return compile(model);
  }

  const roadLanes = (net: Network) =>
    net.lanes.filter((l) => l.kind === LaneKind.Road && !net.segments[l.segmentId].isRamp);

  describe('option lane at an exit', () => {
    for (const rampLanes of [1, 2]) {
      it(`gives the kerb-side lane two ways out (${rampLanes}-lane ramp)`, () => {
        const net = rampDoc('off', rampLanes, 'optionLane');
        expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

        const branching = roadLanes(net).filter((l) => !l.aux && l.successors.length > 1);
        expect(branching.length, 'exactly one lane branches').toBe(1);
        const kinds = branching[0].successors.map((id) => net.lanes[id].kind);
        expect(kinds).toContain(LaneKind.Road);       // carries on along the highway
        expect(kinds).toContain(LaneKind.Connector);  // and takes the exit
        // It is the kerb-side lane, not one buried in the middle of the road.
        expect(branching[0].index).toBe(0);
      });
    }

    it('splits the mainline at the gore, and only there', () => {
      const plain = rampDoc('off', 1);
      const option = rampDoc('off', 1, 'optionLane');
      const mainline = (net: Network) => net.segments.filter((s) => !s.isRamp);
      expect(mainline(plain).length).toBe(1);
      expect(mainline(option).length).toBe(2);
      // The two halves meet: no gap, no junction between them.
      const [a, b] = mainline(option).sort((x, y) => x.strokeS0 - y.strokeS0);
      expect(b.strokeS0).toBeCloseTo(a.strokeS1, 3);
      expect(a.endJunction).toBe(-1);
      expect(b.startJunction).toBe(-1);
    });

    // The through lane is one of the exit's feeders, not an extra one — but a
    // one-lane exit keeps its deceleration lane, so committing early still works.
    it('trades an auxiliary lane for the option lane, never the last one', () => {
      const auxCount = (net: Network) => roadLanes(net).filter((l) => l.aux).length;
      expect(auxCount(rampDoc('off', 2))).toBe(2);
      expect(auxCount(rampDoc('off', 2, 'optionLane'))).toBe(1);
      expect(auxCount(rampDoc('off', 1))).toBe(1);
      expect(auxCount(rampDoc('off', 1, 'optionLane'))).toBe(1);
    });
  });

  describe('added lane at an entrance', () => {
    it('keeps the lane the ramp brings in, all the way to the end of the road', () => {
      const plain = rampDoc('on', 1);
      const added = rampDoc('on', 1, 'addedLanes');
      const auxOf = (net: Network) => roadLanes(net).filter((l) => l.aux);

      expect(auxOf(plain)[0].endsAt).toBeLessThan(Infinity);
      const lane = auxOf(added)[0];
      expect(lane.endsAt).toBe(Infinity);
      expect(lane.mergeTarget).toBe(-1);
      // It runs from the gore to the end of the road, not for an acceleration lane.
      expect(lane.length).toBeGreaterThan(auxOf(plain)[0].length * 3);
    });

    it('adds one lane, not the whole ramp', () => {
      const added = roadLanes(rampDoc('on', 2, 'addedLanes')).filter((l) => l.aux)
        .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
      expect(added.length).toBe(2);
      // The innermost stays; the outer one still merges into it.
      expect(added[0].endsAt).toBe(Infinity);
      expect(added[1].endsAt).toBeLessThan(Infinity);
      expect(added[1].mergeTarget).toBe(added[0].id);
    });
  });

  // An auxiliary lane cannot cross a joint, so an added lane can only stay on the
  // highway for as long as the highway is one uninterrupted stretch. Run into one
  // anyway and it stops with nowhere to go, which turns it into an exit portal —
  // a hole in the middle of the road that traffic vanishes into.
  it('merges an added lane away before the road is interrupted', () => {
    const model = doc();
    const freeway = addProfile(model, {
      name: 'Freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const ramp = addProfile(model, {
      name: 'Ramp', lanesForward: 1, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
      isRamp: true,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const street = addProfile(model, {
      name: 'Street', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4,
    });
    addStroke(model, freeway, line(-1200, 0, 1200, 0));
    addStroke(model, ramp, pts(-900, 200, -700, 90, -600, 0));
    // A crossing further along ends the segment the added lane is running in.
    addStroke(model, street, line(300, -400, 300, 400));
    const gore = compile(model).junctions.find((j) => j.kind === 'merge')!;
    model.junctions.push({ x: gore.x, y: gore.y, control: 'priority', addedLanes: 1 });

    const net = compile(model);
    expect(net.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code)).toEqual([]);
    const lane = net.lanes.find((l) => l.kind === LaneKind.Road && l.aux)!;
    // It runs on well past an acceleration lane, but stops short of the crossing
    // and merges back rather than ending in mid-road.
    expect(lane.length).toBeGreaterThan(400);
    expect(lane.endsAt).toBeLessThan(Infinity);
    expect(lane.mergeTarget).toBeGreaterThanOrEqual(0);
    for (const portal of net.portals) {
      for (const id of portal.exitLanes) {
        expect(net.lanes[id].aux, 'no auxiliary lane becomes a portal').toBe(false);
      }
    }
  });

  it('changes nothing at all when neither is asked for', () => {
    for (const kind of ['on', 'off'] as const) {
      for (const n of [1, 2]) {
        const net = rampDoc(kind, n);
        expect(net.segments.filter((s) => !s.isRamp).length, `${kind}/${n}`).toBe(1);
        const branching = roadLanes(net).filter((l) => !l.aux && l.successors.length > 1);
        expect(branching.length, `${kind}/${n}`).toBe(0);
      }
    }
  });
});
