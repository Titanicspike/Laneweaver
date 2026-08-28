/**
 * Junction regressions: a four-way priority crossing and a signalised arterial.
 *
 * The point of these is the same as the merge suite — that traffic keeps flowing,
 * nobody collides, and nobody waits forever — but exercising the conflict-point and
 * signal machinery rather than the merge model.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { addProfile, addStroke, doc, line, profileNamed } from '../helpers/build';
import { LaneKind } from '@core/network/types';
import type { EditModel } from '@core/network/types';

interface Outcome {
  arrived: number;
  spawned: number;
  collisions: number;
  stalled: number;
  maxStop: number;
  meanSpeed: number;
  vehicles: number;
}

function run(model: EditModel, seed: number, seconds: number, demandScale = 1): Outcome {
  const net = compile(model);
  expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const sim = new Simulation(net, { seed, demandScale });
  let collisions = 0;
  let maxStop = 0;
  let speedSum = 0;
  let ticks = 0;
  const steps = Math.round(seconds / sim.dt);
  for (let i = 0; i < steps; i++) {
    sim.tick();
    if (sim.time < 60) continue;
    collisions += sim.metrics.collisions;
    speedSum += sim.metrics.meanSpeed;
    ticks++;
    sim.forEachVehicle((v) => {
      if (sim.store.stoppedTime[v] > maxStop) maxStop = sim.store.stoppedTime[v];
    });
  }
  return {
    arrived: sim.metrics.arrived,
    spawned: sim.metrics.spawned,
    collisions,
    stalled: sim.metrics.stalled,
    maxStop,
    meanSpeed: ticks ? speedSum / ticks : 0,
    vehicles: sim.metrics.vehicles,
  };
}

/** A major road crossed by a minor one: the classic priority junction. */
function priorityCrossing(): EditModel {
  const model = doc();
  const major = addProfile(model, {
    name: 'Major', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2, speedLimit: 19,
  });
  const minor = profileNamed(model, 'Residential 2-lane');
  addStroke(model, major, line(-400, 0, 400, 0));
  addStroke(model, minor, line(0, -400, 0, 400));
  return model;
}

function signalisedGrid(): EditModel {
  const model = doc();
  const arterial = addProfile(model, {
    name: 'Arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2,
    speedLimit: 16,
  });
  addStroke(model, arterial, line(-700, 0, 700, 0));
  for (const x of [-300, 0, 300]) addStroke(model, arterial, line(x, -400, x, 400));
  return model;
}

describe('four-way priority junction', () => {
  const outcomes = [1, 2, 3].map((seed) => run(priorityCrossing(), seed, 420, 0.5));

  it('gives priority to the major road', () => {
    const net = compile(priorityCrossing());
    expect(net.junctions.length).toBe(1);
    const j = net.junctions[0];
    expect(j.control).toBe('priority');
    // Movements off the minor road must yield; the major road's straight ones must not.
    const minorApproaches = j.approaches.filter((a) => a.incomingLanes.length === 1);
    expect(minorApproaches.length).toBe(2);
    const minorConnectors = j.connectorIds.filter((id) =>
      minorApproaches.some((a) => a.incomingLanes.includes(net.lanes[id].predecessors[0])));
    expect(minorConnectors.length).toBeGreaterThan(0);
    for (const id of minorConnectors) expect(net.lanes[id].yields).toBe(true);
  });

  it('never collides', () => {
    for (const o of outcomes) expect(o.collisions).toBe(0);
  });

  it('clears traffic through the junction', () => {
    for (const o of outcomes) {
      expect(o.arrived).toBeGreaterThan(o.spawned * 0.65);
      expect(o.meanSpeed).toBeGreaterThan(6);
    }
  });

  it('never leaves anyone waiting indefinitely', () => {
    for (const o of outcomes) expect(o.maxStop).toBeLessThan(90);
  });
});

/** Two equal streets crossing: the classic all-way stop. */
function equalCrossing(): EditModel {
  const model = doc();
  const street = profileNamed(model, 'Residential 2-lane');
  addStroke(model, street, line(-350, 0, 350, 0));
  addStroke(model, street, line(0, -350, 0, 350));
  return model;
}

describe('all-way stop', () => {
  it('is the default for two comparable minor roads', () => {
    const net = compile(equalCrossing());
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].control).toBe('allway-stop');
    expect(net.junctions[0].signal).toBeUndefined();
  });

  const outcomes = [1, 2, 3].map((seed) => run(equalCrossing(), seed, 420, 0.9));

  it('never collides', () => {
    for (const o of outcomes) expect(o.collisions).toBe(0);
  });

  it('shares the junction fairly, so nobody waits indefinitely', () => {
    for (const o of outcomes) expect(o.maxStop).toBeLessThan(60);
  });

  it('clears traffic', () => {
    for (const o of outcomes) {
      expect(o.arrived).toBeGreaterThan(o.spawned * 0.7);
      expect(o.meanSpeed).toBeGreaterThan(5);
    }
  });

  it('makes everyone actually stop at the line', () => {
    const net = compile(equalCrossing());
    const sim = new Simulation(net, { seed: 4, demandScale: 0.9 });
    let seenMoving = 0;
    let seenStopped = 0;
    const steps = Math.round(300 / sim.dt);
    for (let i = 0; i < steps; i++) {
      sim.tick();
      sim.forEachVehicle((v, laneId) => {
        const lane = net.lanes[laneId];
        // Only lanes that actually feed the junction; a lane that ends at a portal
        // has no stop line to obey.
        if (lane.kind !== LaneKind.Road) return;
        if (!lane.successors.some((id) => net.lanes[id].kind === LaneKind.Connector)) return;
        if (lane.length - sim.store.s[v] > 3) return;
        if (sim.store.v[v] > 6) seenMoving++;
        else seenStopped++;
      });
    }
    expect(seenStopped).toBeGreaterThan(0);
    expect(seenMoving).toBe(0);
  });
});

describe('signalised arterial grid', () => {
  const model = signalisedGrid();
  const net = compile(model);

  it('generates signal plans for the busy junctions', () => {
    const signalised = net.junctions.filter((j) => j.control === 'signal');
    expect(signalised.length).toBe(3);
    for (const j of signalised) {
      expect(j.signal).toBeDefined();
      expect(j.signal!.phases.length).toBeGreaterThanOrEqual(2);
      const covered = new Set(j.signal!.phases.flatMap((p) => p.greenLanes));
      expect(covered.size).toBe(j.connectorIds.length);
    }
  });

  const outcomes = [1, 2].map((seed) => run(signalisedGrid(), seed, 480, 0.15));

  it('never collides', () => {
    for (const o of outcomes) expect(o.collisions).toBe(0);
  });

  it('keeps waits inside a couple of signal cycles', () => {
    for (const o of outcomes) expect(o.maxStop).toBeLessThan(90);
  });

  it('clears traffic', () => {
    for (const o of outcomes) {
      expect(o.arrived).toBeGreaterThan(o.spawned * 0.6);
      expect(o.meanSpeed).toBeGreaterThan(5);
    }
  });
});

/**
 * A five-way junction, where some destinations are simply not reachable from some
 * approach lanes.
 *
 * When the routing field has nothing to say about a lane, the driver still has to
 * leave it somehow. Deciding that at the boundary means the leader look-ahead never
 * looked down the connector they end up taking: they arrive at full speed into
 * whatever is queued on it with no road left to stop in, and drive through it. The
 * decision has to be made while there is still road to brake in.
 */
describe('five-way junction', () => {
  function fiveWay(): EditModel {
    const model = doc();
    const arterial = addProfile(model, {
      name: 'Arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, median: 2.4,
      shoulder: 0.8, speedLimit: 19,
    });
    const street = profileNamed(model, 'Residential 2-lane');
    addStroke(model, arterial, line(-500, 0, 500, 0));
    addStroke(model, arterial, line(0, -500, 0, 500));
    addStroke(model, street, line(0, 0, 420, -420));
    return model;
  }

  it('never drives one vehicle through another, however busy it gets', () => {
    const net = compile(fiveWay());
    const sim = new Simulation(net, { seed: 11, demandScale: 1 });
    let worst = 0;
    const steps = Math.round(300 / sim.dt);
    for (let i = 0; i < steps; i++) {
      sim.tick();
      sim.forEachVehicle((v) => {
        const lead = sim.store.ahead[v];
        if (lead < 0) return;
        const gap = sim.store.s[lead] - sim.store.len[lead] - sim.store.s[v];
        if (-gap > worst) worst = -gap;
      });
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('flows when the demand is inside its capacity', () => {
    const o = run(fiveWay(), 4, 300, 0.4);
    expect(o.collisions).toBe(0);
    expect(o.stalled).toBe(0);
    expect(o.meanSpeed).toBeGreaterThan(6);
  });
});

/**
 * Ramp lane arrangements, driven rather than inspected.
 *
 * An option lane puts a lane's exiting traffic in a through lane and an added lane
 * commits the road to being wider, so both change how the traffic behaves. The
 * invariants do not move: nobody is lost, nobody collides, nobody stalls.
 */
describe('option and added lanes', () => {
  function rampModel(kind: 'on' | 'off', flag?: 'optionLane' | 'addedLanes'): EditModel {
    const model = doc();
    const freeway = addProfile(model, {
      name: 'Freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
      speedLimit: 30, rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    const ramp = addProfile(model, {
      name: 'Ramp', lanesForward: 1, lanesBackward: 0, laneWidth: 4, shoulder: 1.2,
      isRamp: true, speedLimit: 22,
      rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
    });
    addStroke(model, freeway, line(-1200, 0, 1200, 0));
    addStroke(model, ramp, kind === 'on'
      ? line(-600, 200, 0, 0)
      : line(0, 0, 600, 200));
    if (flag) {
      const gore = compile(model).junctions.find((j) => j.kind !== 'link')!;
      model.junctions.push({
        x: gore.x, y: gore.y, control: 'priority',
        ...(flag === 'addedLanes' ? { addedLanes: 1 } : { optionLane: true }),
      });
    }
    return model;
  }

  // Against a control run of the same road without the arrangement, because what
  // matters is what the choice cost, not an arbitrary absolute number.
  it('carries traffic through an option lane without losing anyone', () => {
    const control = run(rampModel('off'), 7, 300, 0.5);
    const o = run(rampModel('off', 'optionLane'), 7, 300, 0.5);
    expect(o.collisions).toBe(0);
    expect(o.stalled).toBe(0);
    // Exiting traffic now slows in a through lane, which costs something — but the
    // exit must keep carrying most of what it did.
    expect(o.arrived).toBeGreaterThan(control.arrived * 0.7);
  });

  // No control run here: an added lane is a fourth exit portal at the end of the
  // road, so the two documents do not carry the same demand and comparing their
  // throughput would be comparing two different problems. What has to hold is that
  // the road still runs freely with the lane kept.
  it('carries traffic onto an added lane and keeps the road flowing', () => {
    for (const seed of [7, 8]) {
      const o = run(rampModel('on', 'addedLanes'), seed, 480, 0.5);
      expect(o.collisions, `seed ${seed}`).toBe(0);
      expect(o.stalled, `seed ${seed}`).toBe(0);
      expect(o.meanSpeed, `seed ${seed}`).toBeGreaterThan(20);
      expect(o.arrived, `seed ${seed}`).toBeGreaterThan(o.spawned * 0.7);
    }
  });
});
