/**
 * How a driver approaches a junction, and what they do inside one.
 *
 * Two defects lived here, and the first was hiding the second.
 *
 * A driver routed onto a connector with a lower limit — which is every turn, and
 * on a curved crossing every movement — used to bleed the whole speed difference
 * off over the *entire* remaining lane. The arithmetic is tidy and the behaviour is
 * nothing like a driver: on a 700 m approach it works out at a quarter of a metre
 * per second squared sustained the whole way, so half the traffic on a 22 m/s
 * arterial was cruising at 10 m/s from four hundred metres out, and the rest wove
 * around them. That is where "the cars change lanes constantly for no reason and
 * never get up to speed" came from — the lane changes were a symptom.
 *
 * Removing it exposed the second, because the slow approach had been acting as an
 * accidental meter on the junction. Vehicles arriving at a realistic speed filled
 * the box, and the box-blocking rule only looked at the *exit lane*: a vehicle
 * stopped on the connector itself was not counted, so drivers queued in behind it,
 * inside the junction. Four or five of those and the ring closes — each held at a
 * conflict point by the next, bodies overlapping the points, every exit lane empty.
 * It never recovers; the only cure is not to start.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { kph } from '@core/network/model';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { LaneKind } from '@core/network/types';
import { JUNCTION } from '@core/sim/params';
import type { EditModel } from '@core/network/types';

/** A fast arterial crossed by two small streets, so every route involves a turn. */
function arterial(): EditModel {
  const m = doc(11);
  const main = addProfile(m, {
    name: 'art', lanesForward: 3, lanesBackward: 3, laneWidth: 3.5,
    shoulder: 0.8, median: 2.4, speedLimit: kph(80),
  });
  const side = addProfile(m, {
    name: 'side', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(50),
  });
  addStroke(m, main, line(-900, 0, 900, 0));
  addStroke(m, side, line(-300, -400, -300, 400));
  addStroke(m, side, line(300, -400, 300, 400));
  return m;
}

describe('approaching a junction', () => {
  const net = compile(arterial());

  it('holds the speed limit until braking is actually needed', () => {
    const sim = new Simulation(net, { seed: 5, demandScale: 0.35 });
    const S = sim.store;
    // Mean speed of through traffic bucketed by distance to the end of its lane.
    let farSum = 0, farN = 0, nearSum = 0, nearN = 0;
    let limit = 0;
    sim.run(200);
    for (let t = 0; t < 4000; t++) {
      sim.tick();
      for (let i = 0; i < S.count; i++) {
        const lane = net.lanes[S.lane[i]];
        if (!lane || lane.kind !== LaneKind.Road || lane.length < 300) continue;
        limit = Math.max(limit, lane.speedLimit);
        const toEnd = lane.length - S.s[i];
        // At least 120 m into the lane as well as 200 m from its end: a driver who
        // has just turned in off a side street is still accelerating, and counting
        // them measures the junction they came out of rather than the one ahead.
        if (toEnd > 200 && S.s[i] > 120) { farSum += S.v[i]; farN++; }
        else if (toEnd < 60) { nearSum += S.v[i]; nearN++; }
      }
    }
    expect(farN).toBeGreaterThan(1000);
    expect(nearN).toBeGreaterThan(1000);
    const far = farSum / farN;
    // Well clear of the junction, traffic runs at the limit. It used to sit at
    // under half of it, all the way back down the road.
    expect(far, `${far.toFixed(1)} m/s more than 300 m out, limit ${limit.toFixed(1)}`)
      .toBeGreaterThan(limit * 0.85);
    // And the slowing happens near the junction rather than instead of it.
    expect(nearSum / nearN).toBeLessThan(far);
  });

  it('does not weave its way down the approach', () => {
    // The lane changes were the visible half of the same defect: drivers held below
    // the limit by a rule nobody could see were overtaken by everyone else.
    const sim = new Simulation(net, { seed: 5, demandScale: 0.35 });
    const S = sim.store;
    let changes = 0;
    const laneOf = new Map<number, number>();
    sim.run(200);
    for (let t = 0; t < 4000; t++) {
      sim.tick();
      for (let i = 0; i < S.count; i++) {
        const lane = net.lanes[S.lane[i]];
        if (!lane || lane.kind !== LaneKind.Road || lane.length < 300) continue;
        if (lane.length - S.s[i] < 300) { laneOf.delete(i); continue; }
        const was = laneOf.get(i);
        if (was !== undefined && was !== S.lane[i]) changes++;
        laneOf.set(i, S.lane[i]);
      }
    }
    // Per vehicle that got that far. Sorting into a turn lane is a change or two;
    // it was more than ten, over and over, the length of the road.
    const perVehicle = changes / Math.max(1, sim.metrics.arrived);
    expect(perVehicle, `${perVehicle.toFixed(2)} changes per vehicle, 300 m+ from the junction`)
      .toBeLessThan(1.5);
  });
});

describe('the box', () => {
  const net = compile(arterial());

  it('is never entered by a driver who would have to stop inside it', () => {
    // The invariant the ring deadlock violates. A vehicle may only join a connector
    // that has nothing stationary already on it — anything else is queueing inside
    // the junction, and a ring of that is permanent.
    const sim = new Simulation(net, { seed: 3, demandScale: 1.3 });
    const S = sim.store;
    const was = new Map<number, number>();
    let entries = 0;
    let ontoBlocked = 0;
    // Judged on what the driver could act on. The decision is made at the stop line
    // and the move happens during integration, so this loop looks a tick late — and
    // a driver 0.6 m from the line at 2.9 m/s cannot stop in any case. What the rule
    // forbids is rolling into a junction that was *already* blocked, which is
    // something you do from back down the road: so the connector must have been
    // blocked for longer than this driver needed to pull up comfortably.
    //
    // Measuring "was anyone slow on it just now" instead reports the driver who
    // entered behind a leader doing 2.6 m/s and clear of the box, when that leader
    // emergency-braked on the very next tick. Measuring "could they have stopped"
    // by the distance left at the transition is worse than useless: at that moment
    // every driver is within one tick of the line, so it never fires at all — with
    // the rule deleted outright the test still passed.
    const before = new Float32Array(S.v.length);
    const blockedFor = new Map<number, number>();
    sim.run(120);
    for (let t = 0; t < 6000; t++) {
      before.set(S.v);
      sim.tick();
      for (const lane of net.lanes) {
        if (lane.kind !== LaneKind.Connector) continue;
        let jammed = false;
        for (let a = S.laneFirst[lane.id]; a >= 0; a = S.behind[a]) {
          if (S.v[a] < JUNCTION.jammedSpeed) { jammed = true; break; }
        }
        blockedFor.set(lane.id, jammed ? (blockedFor.get(lane.id) ?? 0) + 1 : 0);
      }
      for (let i = 0; i < S.count; i++) {
        const now = S.lane[i];
        const prev = was.get(i);
        was.set(i, now);
        if (prev === undefined || prev === now) continue;
        const lane = net.lanes[now];
        if (!lane || lane.kind !== LaneKind.Connector) continue;
        if (net.lanes[prev]?.kind === LaneKind.Connector) continue;
        entries++;
        // Anything already on this connector, other than us, and not moving.
        for (let a = S.laneFirst[now]; a >= 0; a = S.behind[a]) {
          if (a !== i && before[a] < JUNCTION.jammedSpeed) {
            const blockedSeconds = ((blockedFor.get(now) ?? 0) - 1) * 0.05;
            if (blockedSeconds >= before[i] / 2) ontoBlocked++;
            break;
          }
        }
      }
    }
    expect(entries).toBeGreaterThan(200);
    expect(ontoBlocked, `${ontoBlocked} of ${entries} entries joined a blocked connector`).toBe(0);
  });

  it('keeps discharging when it is given more than it can take', () => {
    // Over four seeds rather than one. What is being asserted is that a saturated
    // junction degrades instead of locking — it was exactly zero from minute four
    // onward when it locked — and a single seed's final-minute count is a noisy way
    // to ask that: the same code gives 14 on one seed and 64 on another, because
    // what a saturated junction discharges in any given minute depends on which
    // phase it happens to be in and who is at the front of which queue.
    let total = 0;
    for (const seed of [1, 2, 3, 4]) {
      const sim = new Simulation(net, { seed, demandScale: 1.3 });
      sim.run(420);
      const before = sim.metrics.arrived;
      sim.run(60);
      const discharged = sim.metrics.arrived - before;
      expect(discharged, `seed ${seed} is not locked`).toBeGreaterThan(0);
      expect(sim.metrics.collisions, `seed ${seed}`).toBe(0);
      expect(sim.metrics.lost, `seed ${seed}`).toBe(0);
      total += discharged;
    }
    expect(total, 'arrivals in the final minute across four seeds').toBeGreaterThan(40);
  });
});
