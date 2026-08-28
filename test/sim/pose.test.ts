/**
 * How a vehicle is placed on the road.
 *
 * A car is a rigid body: its heading is the direction from its rear to its front,
 * not the tangent of the lane under its nose. Two things go wrong when you use the
 * tangent instead — the tail swings out of the lane on anything that curves, so a
 * car turning through a junction points where the road is *going* rather than where
 * the car is; and a lane change becomes a pure sideways slide, because two parallel
 * lanes share a tangent and nothing ever yaws.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { createDemoDocument } from '@app/demo';
import { onRampScenario } from '../helpers/scenarios';
import { LaneKind } from '@core/network/types';
import { DT } from '@core/sim/params';
import { closestOnPolyline, makeClosestHit, sampleSmoothTangent } from '@core/geom/polyline';

const pose = { x: 0, y: 0, heading: 0 };
const hit = makeClosestHit();
const tangent = { x: 0, y: 0 };

describe('vehicle pose', () => {
  it('keeps the whole body on the lane through a turn', () => {
    const net = compile(createDemoDocument());
    const sim = new Simulation(net, { seed: 7, demandScale: 2 });
    sim.run(240);

    let checked = 0;
    let worst = 0;
    sim.forEachVehicle((i, laneId) => {
      const lane = net.lanes[laneId]!;
      // Connectors are where the turns are, and where a tangent heading is worst.
      if (lane.kind !== LaneKind.Connector) return;
      if (sim.store.lcFrom[i] >= 0) return;
      const len = sim.store.len[i];
      // Only once the whole body is on the connector: a rear end still out on the
      // road behind is a question about the previous lane, not this one.
      if (sim.store.s[i] < len + 0.5) return;
      sim.sampleVehicle(i, 0.5, pose);
      const rx = pose.x - Math.cos(pose.heading) * len;
      const ry = pose.y - Math.sin(pose.heading) * len;
      closestOnPolyline(lane.centerline, lane.arclength, rx, ry, hit);
      worst = Math.max(worst, hit.distance);
      checked++;
    });

    expect(checked).toBeGreaterThan(5);
    // The tail sits on the path, not off the outside of the curve.
    expect(worst).toBeLessThan(0.4);
  });

  it('yaws into a lane change and straightens out again', () => {
    const { net: network } = onRampScenario({ mainFlow: 1500, rampFlow: 700 });
    const sim = new Simulation(network, { seed: 3, demandScale: 1 });

    let sawYaw = 0;
    let worstYaw = 0;
    for (let step = 0; step < 3000; step++) {
      sim.tick();
      if (step % 5 !== 0) continue;
      sim.forEachVehicle((i, laneId) => {
        if (sim.store.lcFrom[i] < 0) return;
        const lane = network.lanes[laneId]!;
        sim.sampleVehicle(i, 0, pose);
        sampleSmoothTangent(lane.centerline, lane.arclength, sim.store.s[i], tangent, 1.5);
        const along = Math.atan2(tangent.y, tangent.x);
        let d = pose.heading - along;
        while (d <= -Math.PI) d += 2 * Math.PI;
        while (d > Math.PI) d -= 2 * Math.PI;
        const deg = Math.abs((d * 180) / Math.PI);
        if (deg > 2) sawYaw++;
        worstYaw = Math.max(worstYaw, deg);
      });
    }

    // Drivers actually turn the wheel...
    expect(sawYaw).toBeGreaterThan(20);
    // ...but a lane change is not a handbrake turn, however slowly it is taken.
    expect(worstYaw).toBeLessThan(24);
  });

  it('moves continuously, with no shift at a lane boundary', () => {
    // What the eye catches is a discontinuity, and the two places to look are the
    // mouth of a junction — where the vehicle is handed to the next lane — and a
    // lane change that gets abandoned half way. Sampling across each tick rather
    // than once per tick is the point: a vehicle that stalls for the frames of one
    // tick and then jumps looks exactly like a snap, and is invisible if you only
    // ever look at the same instant.
    //
    // Two cases are left, both vanishingly rare: a mandatory change interrupting a
    // discretionary one in the other direction, and a change cancelled outright when
    // the vehicle crosses onto the next lane. Both leave the driver part of the way
    // across with nowhere to carry it to.
    const net = compile(createDemoDocument());
    const sim = new Simulation(net, { seed: 5, demandScale: 2 });
    const last = new Map<number, { x: number; y: number }>();
    const alphas = [0, 1 / 3, 2 / 3];
    let jumps = 0;
    let samples = 0;
    let worst = 0;

    for (let k = 0; k < 1200; k++) {
      sim.tick();
      if (k < 300) continue;
      for (const alpha of alphas) {
        sim.forEachVehicle((i) => {
          sim.sampleVehicle(i, alpha, pose);
          const was = last.get(sim.store.serial[i]);
          if (was) {
            samples++;
            const d = Math.hypot(pose.x - was.x, pose.y - was.y);
            // Each step covers a third of a tick, so it is a third of a tick's
            // travel — measured against this driver's own speed, because a snap in
            // a queue is small in metres and just as visible.
            const step = (sim.store.v[i] * DT) / alphas.length + 0.3;
            if (d > step) {
              jumps++;
              worst = Math.max(worst, d / step);
            }
          }
          last.set(sim.store.serial[i], { x: pose.x, y: pose.y });
        });
      }
    }

    expect(samples).toBeGreaterThan(200000);
    expect(jumps / samples).toBeLessThan(5e-5);
    // Whatever is left, it is never more than a lane width's worth of overshoot.
    expect(worst).toBeLessThan(12);
  });

  it('turns continuously, whatever length the vehicle is', () => {
    // Rotation is where length shows up. A long vehicle's rear end is further back,
    // so anywhere the sampler guesses at where "back there" is — off the start of a
    // lane, or part way through a lane change — the error grows with the wheelbase
    // and lands as a visible flick. Real rotation between two sub-tick samples is
    // under a degree even on the tightest connector.
    const net = compile(createDemoDocument());
    const sim = new Simulation(net, { seed: 5, demandScale: 2 });
    const last = new Map<number, number>();
    const alphas = [0, 1 / 3, 2 / 3];
    let jumps = 0;
    let samples = 0;
    let worst = 0;

    for (let k = 0; k < 1200; k++) {
      sim.tick();
      if (k < 300) continue;
      for (const alpha of alphas) {
        sim.forEachVehicle((i) => {
          sim.sampleVehicle(i, alpha, pose);
          const was = last.get(sim.store.serial[i]);
          if (was !== undefined) {
            samples++;
            let d = pose.heading - was;
            while (d <= -Math.PI) d += 2 * Math.PI;
            while (d > Math.PI) d -= 2 * Math.PI;
            const deg = Math.abs((d * 180) / Math.PI);
            if (deg > 4) {
              jumps++;
              worst = Math.max(worst, deg);
            }
          }
          last.set(sim.store.serial[i], pose.heading);
        });
      }
    }

    expect(samples).toBeGreaterThan(200000);
    // The rate is the check that means something: a change interrupted by one in a
    // third direction cannot be made continuous, and a change is cancelled outright
    // at a lane boundary, so a handful of these is expected and their *frequency*
    // is what must stay negligible. The magnitude of the worst single one is a
    // guard, not a target — it lands anywhere between 7 and 17 degrees depending on
    // which vehicle happened to be interrupted, so a bound fitted to one seed just
    // breaks the next time the traffic pattern shifts.
    expect(jumps / samples).toBeLessThan(5e-5);
    expect(worst).toBeLessThan(25);
  });

  it('settles back onto the lane once the change is done', () => {
    const { net: network } = onRampScenario({ mainFlow: 1200, rampFlow: 500 });
    const sim = new Simulation(network, { seed: 11, demandScale: 1 });
    sim.run(200);

    let worst = 0;
    sim.forEachVehicle((i, laneId) => {
      if (sim.store.lcFrom[i] >= 0) return;
      const lane = network.lanes[laneId]!;
      if (lane.kind === LaneKind.Connector) return;
      sim.sampleVehicle(i, 0, pose);
      closestOnPolyline(lane.centerline, lane.arclength, pose.x, pose.y, hit);
      worst = Math.max(worst, hit.distance);
    });
    // Not mid-change: the nose is on its lane's centreline.
    expect(worst).toBeLessThan(0.2);
  });
});
