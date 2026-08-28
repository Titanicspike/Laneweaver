/**
 * The shape of a junction box, for junctions nobody drew on purpose.
 *
 * An approach corridor reaches *across* the junction and no further: its length is
 * its own trim plus the widest road it crosses, measured perpendicular to itself so
 * a skew crossing gets the longer span it needs. The load-bearing word is "crosses".
 *
 * A road with nothing opposite it does not get crossed — traffic turns onto it, it
 * does not drive over it. Without that distinction a Y junction, where all three
 * roads stop at one point and none is opposite another, had every arm reaching
 * across every other one. On a measured shape the narrow arm was told to reach 21.5 m
 * past the junction on a four-metre-wide road, which puts a spur of asphalt into a
 * sector with no road in it at all — and a spur is exactly what "that intersection
 * looks wrong" turns out to be when you go and measure it.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import { addProfile, addStroke, doc, line, pts } from '../helpers/build';
import { LaneKind } from '@core/network/types';
import type { Network } from '@core/network/types';

/** An n-armed junction at the origin, arms leaving on the given bearings. */
function star(bearings: number[], lanes: number[]): Network {
  const m = doc(7);
  for (let i = 0; i < bearings.length; i++) {
    const p = addProfile(m, {
      name: `r${i}`, lanesForward: lanes[i], lanesBackward: lanes[i],
      laneWidth: 3.5, shoulder: 0.5, speedLimit: kph(50 + lanes[i] * 10),
    });
    const a = (bearings[i] * Math.PI) / 180;
    addStroke(m, p, pts(
      0, 0,
      Math.cos(a) * 130, Math.sin(a) * 130,
      Math.cos(a) * 260, Math.sin(a) * 260,
    ));
  }
  return compile(m);
}

/** How far the junction box reaches in a direction, and how far any road does. */
function reachTowards(net: Network, bearingDeg: number): { box: number; road: number } {
  const j = net.junctions.find((x) => x.kind === 'crossing')!;
  const a = (bearingDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  let box = 0;
  for (let i = 0; i < j.footprint.length; i += 2) {
    box = Math.max(box, (j.footprint[i] - j.x) * ux + (j.footprint[i + 1] - j.y) * uy);
  }
  let road = 0;
  for (const seg of net.segments) {
    for (let i = 0; i < seg.surface.length; i += 2) {
      road = Math.max(road, (seg.surface[i] - j.x) * ux + (seg.surface[i + 1] - j.y) * uy);
    }
  }
  return { box, road };
}

/** The widest half-carriageway meeting this junction, measured at the end caps. */
function widestHalfWidth(net: Network): number {
  const j = net.junctions.find((x) => x.kind === 'crossing')!;
  let widest = 0;
  for (const a of j.approaches) {
    const seg = net.segments[a.segmentId];
    const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
    if (cap.length < 4) continue;
    widest = Math.max(widest, Math.hypot(cap[0] - cap[2], cap[1] - cap[3]) / 2);
  }
  return widest;
}

/**
 * How far past the widest arm's own half-width the box may reach into a sector with
 * no road in it.
 *
 * A regression bound rather than a derived one, and the margin is worth stating: on
 * the shape below the arms' caps are 14.5 m half-width, the box reached 16.8 m into
 * the empty sector before an arm stopped crossing roads that stop at the junction,
 * and reaches 12.1 m now. Two metres sits between those, so this catches the old
 * behaviour coming back without being so tight that a fillet tweak trips it.
 */
const KERB = 2;

describe('junction box shape', () => {
  it('does not reach across a road that stops at the junction', () => {
    // A Y: three roads, all ending here, none opposite another. The measured case —
    // a four-metre arm was reaching 21.5 m past the centre because a 14.5 m road
    // sat 31 degrees away and it was told to span it.
    const net = star([49, 158, 189], [3, 3, 1]);
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Into the empty sector — the 220 degrees with no road in it.
    //
    // Something has to be there: roads twenty-two metres wide meeting at a point make
    // a box at least eleven metres across whichever way you measure it, and the corner
    // between two arms is filleted at a kerb radius on top of that. What may *not* be
    // there is an arm reaching across a road that nothing crosses. So the bound is the
    // widest road's own half-width plus a kerb radius — 16.8 m before, 12.1 m now.
    const { box } = reachTowards(net, 283);
    const widest = widestHalfWidth(net);
    expect(box, `box reaches ${box.toFixed(1)} m into an empty sector`
      + ` on roads ${widest.toFixed(1)} m wide either side of their centre`)
      .toBeLessThan(widest + KERB);
  });

  it('still reaches across a road that carries on through', () => {
    // The rule must not cost a real crossing its span: at a four-way, the arm being
    // crossed is precisely the one with a partner opposite it.
    const net = star([0, 90, 180, 270], [3, 3, 3, 3]);
    const j = net.junctions.find((x) => x.kind === 'crossing')!;
    const wide = 3 * 3.5 + 0.5; // half the carriageway plus the shoulder
    // Measured along one arm's travel, the box has to span the crossing road.
    const { box } = reachTowards(net, 0);
    expect(box, 'a crossing arm must still span the road it crosses')
      .toBeGreaterThan(wide);
    expect(j.footprint.length).toBeGreaterThan(6);
  });

  it('and across the top of a T', () => {
    // The stem has to reach the far kerb of the through road, or a vehicle turning
    // out of it is driving on unpaved ground.
    const net = star([0, 180, 90], [3, 3, 1]);
    const { box } = reachTowards(net, -90); // the stem's direction of travel
    expect(box).toBeGreaterThan(3 * 3.5);
  });

  it('sets an arm back for the flare it meets, not for both of them', () => {
    // A left bay flares its approach's own kerb. The two approaches of a through
    // road flare opposite kerbs, so a road crossing it has one arm against each —
    // and each arm has to clear one flare, never the sum of the two. Charged both,
    // the minor road stood 2 m further back than the asphalt it crosses, at every
    // arm of every bayed junction; on a priority crossing that was the difference
    // between a side road that found its gaps and one that starved and gridlocked.
    const m = doc(5);
    const major = addProfile(m, {
      name: 'major', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2, speedLimit: kph(70),
    });
    const minor = addProfile(m, {
      name: 'minor', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(50),
    });
    addStroke(m, major, line(-400, 0, 400, 0));
    addStroke(m, minor, line(0, -400, 0, 400));
    const net = compile(m);
    const j = net.junctions.find((x) => x.kind === 'crossing')!;
    expect(net.lanes.some((l) => l.aux && l.kind === LaneKind.Road), 'the junction has bays').toBe(true);

    /** Widest the major road's asphalt gets, either side, within 5 m of its cap. */
    let flared = 0;
    for (const a of j.approaches) {
      const seg = net.segments[a.segmentId]!;
      if (seg.strokeId !== m.strokes[0].id) continue;
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const cx = (cap[0] + cap[2]) / 2;
      // The major road runs along x here, so its asphalt at the cap is the widest
      // |y| within a few metres of the cap along the road.
      for (let i = 0; i < seg.surface.length; i += 2) {
        if (Math.abs(seg.surface[i]! - cx) > 5) continue;
        flared = Math.max(flared, Math.abs(seg.surface[i + 1]!));
      }
    }
    expect(flared).toBeGreaterThan(9);          // 8.5 m of road plus a bay's widening

    for (const a of j.approaches) {
      const seg = net.segments[a.segmentId]!;
      if (seg.strokeId !== m.strokes[1].id) continue;
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const d = Math.hypot((cap[0] + cap[2]) / 2 - j.x, (cap[1] + cap[3]) / 2 - j.y);
      // Far enough to clear the flared asphalt it crosses...
      expect(d, `minor arm set back ${d.toFixed(1)} m against ${flared.toFixed(1)} m of road`)
        .toBeGreaterThan(flared - 0.5);
      // ...and no further than a kerb. Charging it both flares adds a whole 1.95 m.
      expect(d, `minor arm set back ${d.toFixed(1)} m against ${flared.toFixed(1)} m of road`)
        .toBeLessThan(flared + 1.8);
    }
  });

  it('leaves no junction sticking out of a shape nobody planned for', () => {
    // A handful of awkward but legal shapes, checked for the one thing that reads as
    // broken on screen: asphalt a long way past where any road goes.
    for (const [bearings, lanes] of [
      [[0, 120, 240], [2, 2, 2]],
      [[0, 90, 180, 270], [3, 1, 3, 1]],
      [[0, 72, 144, 216, 288], [2, 2, 2, 2, 2]],
      [[10, 100, 190, 280], [3, 3, 1, 1]],
      [[0, 45, 180], [3, 2, 3]],
    ] as [number[], number[]][]) {
      const net = star(bearings, lanes);
      const label = `[${bearings.join(',')}] lanes [${lanes.join(',')}]`;
      expect(net.diagnostics.filter((d) => d.severity === 'error'), label).toEqual([]);
      const j = net.junctions.find((x) => x.kind === 'crossing');
      expect(j, label).toBeDefined();
      for (let b = 0; b < 360; b += 15) {
        const { box, road } = reachTowards(net!, b);
        expect(box, `${label} at ${b} degrees: box ${box.toFixed(1)} m, road ${road.toFixed(1)} m`)
          .toBeLessThan(road + 12);
      }
    }
  });
});
