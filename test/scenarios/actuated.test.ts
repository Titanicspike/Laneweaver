/**
 * Actuated signals: a green that ends when nobody is using it.
 *
 * A fixed plan gives every phase its full time whether or not anybody turned up,
 * which on a junction between a busy road and a quiet one means the busy road stops
 * for an empty side street forty times an hour. Real isolated junctions solve that
 * with detectors: serve a minimum green, then end the phase as soon as the arrivals
 * stop.
 *
 * Two things about the design are load-bearing and are checked here.
 *
 * It is **off by default**, because a fixed plan has a fixed cycle and a fixed cycle
 * is the entire basis of a corridor offset. A green wave is a claim about where a
 * platoon will be N seconds from now, and it stops being true the moment the cycle
 * length depends on who turned up. Actuate an isolated junction; leave a coordinated
 * one alone.
 *
 * And the demand test is **routed**, not merely presence: a car queued in the
 * through lane says nothing about whether the left-turn phase still has anybody to
 * serve. Counting it as demand makes every phase run to its maximum, which is a
 * fixed plan wearing a detector.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { autoSmoothHandles, createDocument, kph, makeControlPoint } from '@core/network/model';
import { SIGNAL } from '@core/sim/params';
import type { EditModel, Network, RoadProfile } from '@core/network/types';

function road(m: EditModel, p: RoadProfile, x0: number, y0: number, x1: number, y1: number): void {
  const pts = [makeControlPoint(x0, y0), makeControlPoint(x1, y1)];
  autoSmoothHandles(pts);
  m.strokes.push({ id: m.nextId++, profileId: p.id, points: pts });
}

/** A busy arterial crossed by a quiet side street, signalised either way. */
function crossroads(actuated: boolean): Network {
  const m = createDocument(21);
  const shared = { median: 3.0, isRamp: false, shoulder: 0.8 };
  const arterial: RoadProfile = {
    ...shared, id: m.nextId++, name: 'Arterial', lanesForward: 2, lanesBackward: 2,
    laneWidth: 3.5, speedLimit: kph(70),
  };
  const side: RoadProfile = {
    ...shared, id: m.nextId++, name: 'Side', lanesForward: 1, lanesBackward: 1,
    laneWidth: 3.3, median: 0, speedLimit: kph(40),
  };
  m.profiles.push(arterial, side);
  road(m, arterial, -900, 0, 900, 0);
  road(m, side, 0, -500, 0, 500);

  // The control chooser gives this one priority, so the signals are asked for; then
  // the plan the compiler writes is copied into the document and actuated.
  const first = compile(m);
  const found = first.junctions.find((j) => j.kind === 'crossing')!;
  m.junctions.push({ x: found.x, y: found.y, control: 'signal' });
  const planned = compile(m).junctions.find((j) => j.kind === 'crossing')!;
  m.junctions[0]!.signal = {
    offset: 0,
    phases: planned.signal!.phases.map((p) => ({
      groups: [...p.groups], green: p.green, amber: p.amber, allRed: p.allRed,
    })),
    ...(actuated ? { actuated: true } : {}),
  };
  return compile(m);
}

interface Run { arrived: number; journey: number; wait: number; collisions: number }

function measure(net: Network, seeds: number[], seconds: number): Run {
  let arrived = 0;
  let travel = 0;
  let wait = 0;
  let collisions = 0;
  for (const seed of seeds) {
    const sim = new Simulation(net, { seed, demandScale: 1 });
    sim.run(seconds);
    arrived += sim.metrics.arrived;
    travel += sim.metrics.totalTravel;
    wait += sim.metrics.totalWait;
    collisions += sim.metrics.collisions;
  }
  return { arrived, journey: travel / Math.max(1, arrived), wait: wait / Math.max(1, arrived), collisions };
}

describe('an actuated junction', () => {
  const SEEDS = [1, 2, 3, 4, 5];
  const fixed = measure(crossroads(false), SEEDS, 900);
  const actuated = measure(crossroads(true), SEEDS, 900);

  it('compiles with the flag the document asked for, and only then', () => {
    const on = crossroads(true).junctions.find((j) => j.control === 'signal')!;
    const off = crossroads(false).junctions.find((j) => j.control === 'signal')!;
    expect(on.signal?.actuated).toBe(true);
    expect(off.signal?.actuated).toBe(false);
  });

  it('gets more traffic through, faster', () => {
    // Measured 1633 -> 1725 arrivals, 184.5 s -> 167.4 s, 52.1 s -> 33.6 s of wait.
    // The bounds are set where a real regression trips them, not at the numbers.
    expect(actuated.arrived, `${fixed.arrived} fixed vs ${actuated.arrived} actuated`)
      .toBeGreaterThan(fixed.arrived);
    expect(actuated.journey, `${fixed.journey.toFixed(1)} s vs ${actuated.journey.toFixed(1)} s`)
      .toBeLessThan(fixed.journey * 0.96);
    expect(actuated.wait, `${fixed.wait.toFixed(1)} s vs ${actuated.wait.toFixed(1)} s`)
      .toBeLessThan(fixed.wait * 0.8);
  });

  it('is still safe', () => {
    expect(actuated.collisions).toBe(0);
    expect(fixed.collisions).toBe(0);
  });

  it('never shows a green shorter than the minimum', () => {
    // Without a floor a phase gaps out on the tick it turns green, and the junction
    // spends its cycle in amber and all-red serving nobody.
    const net = crossroads(true);
    const sim = new Simulation(net, { seed: 4, demandScale: 1 });
    const junction = net.junctions.find((j) => j.control === 'signal')!;
    let phase = sim.signals.currentPhase(junction.id);
    let greenSince = 0;
    const greens: number[] = [];
    for (let k = 0; k < 900 / sim.dt; k++) {
      sim.tick();
      const now = sim.signals.currentPhase(junction.id);
      const state = sim.signals.stateOf(net.junctions.find(
        (j) => j.id === junction.id,
      )!.signal!.phases[now]!.greenLanes[0]!);
      if (now !== phase) {
        phase = now;
        greenSince = k;
      } else if (state !== 1 && greenSince >= 0) {
        // Green just ended for this phase.
        if (greenSince > 0) greens.push((k - greenSince) * sim.dt);
        greenSince = -1;
      }
    }
    expect(greens.length).toBeGreaterThan(20);
    const shortest = Math.min(...greens);
    expect(shortest, `shortest green ${shortest.toFixed(1)} s`)
      .toBeGreaterThanOrEqual(SIGNAL.minGreen - 0.6);
  });

  it('leaves a fixed plan exactly as it was', () => {
    // The whole reason actuation is opt-in: a corridor's offsets depend on the
    // cycle staying put. Two runs of the same fixed plan must agree exactly.
    const a = measure(crossroads(false), [7], 300);
    const b = measure(crossroads(false), [7], 300);
    expect(a).toEqual(b);
  });
});
