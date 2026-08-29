/**
 * Cul-de-sacs: the turning head, the U-turn in it, and the houses round it.
 *
 * Three things have to be true at once for one of these to be worth having, and each
 * of them was wrong at some point on the way here:
 *
 * - The end stops being a *portal*. A dead end is where trips begin and finish; a
 *   cul-de-sac is not, because there is nothing beyond it. That falls out of the
 *   existing rule — a lane with somewhere to go is not an exit — as soon as the
 *   U-turn exists, which is why the U-turn is the load-bearing part.
 * - The U-turn stays on the tarmac and uses the bulb. Sized as a fraction of the
 *   radius it was a hairpin down the middle of a circle three times wider than it
 *   needed; a step further and it swung two metres outside the kerb.
 * - The houses stand round the head rather than along the street, and their
 *   driveways open onto the circle — which is what makes the traffic go round it.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import { LaneKind, TurnKind } from '@core/network/types';
import type { EditModel, Network } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { deserialize, serialize } from '@core/util/serialization';

/** A residential street off a collector, closed at the far end. */
function street(mark = true, lanes = 1, length = 200): EditModel {
  const m = doc(3);
  const collector = addProfile(m, {
    name: 'collector', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, speedLimit: kph(60),
  });
  const home = addProfile(m, {
    name: 'home', lanesForward: lanes, lanesBackward: lanes, laneWidth: 3.2,
    speedLimit: kph(40), landUse: 'residential',
  });
  addStroke(m, collector, line(-260, 0, 260, 0));
  addStroke(m, home, line(0, 0, 0, length));
  if (mark) m.gateways.push({ x: 0, y: length, role: 'culdesac' });
  return m;
}

const headOf = (net: Network) => net.junctions.find((j) => j.kind === 'culdesac');
const uTurnOf = (net: Network) => net.lanes.find(
  (l) => l.kind === LaneKind.Connector && l.turn === TurnKind.UTurn);

describe('a cul-de-sac', () => {
  it('is built only where the document asks for one', () => {
    const plain = compile(street(false));
    expect(headOf(plain)).toBeUndefined();
    expect(uTurnOf(plain)).toBeUndefined();
    // Left alone, the end is an end of the network, exactly as it was.
    expect(plain.portals.some((p) => Math.hypot(p.x - 0, p.y - 200) < 5)).toBe(true);

    const marked = compile(street(true));
    expect(headOf(marked)).toBeDefined();
    expect(marked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('stops being an end of the network', () => {
    // The whole difference between a cul-de-sac and a road that happens to stop:
    // nothing enters or leaves the map here, so no portal, and no traffic appearing
    // out of a hedge at the end of somebody's street.
    const net = compile(street(true));
    expect(net.portals.some((p) => Math.hypot(p.x - 0, p.y - 200) < 12)).toBe(false);
    // ...and the two ends of the collector still are.
    expect(net.portals.length).toBe(2);
  });

  it('fits inside the road that was drawn', () => {
    const net = compile(street(true));
    const head = headOf(net)!;
    // The bulb is centred on the end the user drew, and the street is cut back by
    // its radius — so the whole thing lands inside the stroke rather than adding ten
    // metres of road past the point they stopped drawing.
    expect(Math.hypot(head.x - 0, head.y - 200)).toBeLessThan(0.5);
    const seg = net.segments.find((s) => s.laneIds.some(
      (id) => net.lanes[id].id === uTurnOf(net)!.predecessors[0]))!;
    const far = Math.max(seg.centerline[seg.centerline.length - 1], seg.centerline[1]);
    expect(200 - far).toBeGreaterThan(head.radius - 1);
    expect(200 - far).toBeLessThan(head.radius + 1);
  });

  it('turns traffic round inside the bulb, on the tarmac', () => {
    for (const lanes of [1, 2]) {
      const net = compile(street(true, lanes));
      const head = headOf(net)!;
      const turn = uTurnOf(net)!;
      expect(turn.junctionId).toBe(head.id);

      // Every point of the movement is inside the bulb, allowing for the vehicle's
      // own width — except its two ends, which sit on the road at the mouth.
      const ax = Math.cos(head.approaches[0].heading), ay = Math.sin(head.approaches[0].heading);
      let apex = -Infinity;
      let outside = 0;
      for (let i = 0; i < turn.centerline.length; i += 2) {
        const dx = turn.centerline[i] - head.x, dy = turn.centerline[i + 1] - head.y;
        apex = Math.max(apex, dx * ax + dy * ay);
        // Depth into the head, so the mouth end is excluded from the kerb test.
        if (dx * ax + dy * ay > 0 && Math.hypot(dx, dy) + turn.width / 2 > head.radius) outside++;
      }
      expect(outside, `${lanes}-lane street: points outside the bulb`).toBe(0);
      // And it goes round the head rather than pivoting at its mouth: past the
      // centre, which is what lets something longer than a car use it.
      expect(apex, `${lanes}-lane street: apex past the centre`).toBeGreaterThan(1);
    }
  });

  it('refuses one where a driver could not turn round', () => {
    // A one-way street has nothing to turn into. Saying so is better than building a
    // head that quietly traps everything that drives in.
    const m = doc(3);
    const oneWay = addProfile(m, {
      name: 'oneway', lanesForward: 1, lanesBackward: 0, laneWidth: 3.2, speedLimit: kph(40),
    });
    addStroke(m, oneWay, line(0, 0, 0, 200));
    m.gateways.push({ x: 0, y: 200, role: 'culdesac' });
    const net = compile(m);
    expect(headOf(net)).toBeUndefined();
    expect(net.diagnostics.some((d) => d.code === 'culdesac-one-way')).toBe(true);

    // And on a road with no room for both a street and a head.
    const short = street(true, 1, 24);
    const net2 = compile(short);
    expect(headOf(net2)).toBeUndefined();
    expect(net2.diagnostics.some((d) => d.code === 'culdesac-too-short')).toBe(true);
  });

  it('rings the head with houses, served from the way out', () => {
    const net = compile(street(true));
    const head = headOf(net)!;
    const seg = net.segments.find((s) => s.frontages.some((f) => f.head))!;
    const ring = seg.frontages.filter((f) => f.head);
    expect(ring.length, 'houses round the head').toBeGreaterThanOrEqual(3);

    for (const f of ring) {
      // On the bulb, clear of the mouth the road comes in through.
      expect(Math.hypot(f.head!.cx - head.x, f.head!.cy - head.y)).toBeLessThan(0.5);
      const away = Math.abs(Math.atan2(
        Math.sin(f.head!.angle - head.approaches[0].heading),
        Math.cos(f.head!.angle - head.approaches[0].heading)));
      expect(away, 'a plot laid across the road').toBeGreaterThan(0.3);
      // Reached from the lane leaving the head: the driveways open onto the circle,
      // so a driver has been round it by the time they stop.
      const turn = uTurnOf(net)!;
      expect(f.head!.fromSide).toBe(net.lanes[turn.successors[0]].side);
    }
  });

  it('survives a save and reload', () => {
    const m = street(true);
    const back = deserialize(serialize(m));
    expect(back.gateways.some((g) => g.role === 'culdesac')).toBe(true);
    expect(headOf(compile(back))).toBeDefined();
  });
});
