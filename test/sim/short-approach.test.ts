/**
 * Two junctions closer together than a stopping distance.
 *
 * Imported data is full of these — a divided road crossing another road makes one
 * junction per carriageway — and the compiler makes them itself whenever it pulls
 * two overlapping footprints apart. What is left between them is a road four metres
 * long, and four metres is not a stop line: the signal rules first look at the second
 * junction when the driver is already a metre from it doing thirteen metres a second.
 * `mustStop` says yes, they brake at the emergency cap, and they cross on red anyway,
 * into the traffic that has the green. The decision has to be taken at the last stop
 * line anybody actually offered them, which is the junction before (`applyJunctionRules`).
 *
 * **What this file does and does not show.** It guards the invariants for the shape:
 * that the compiler really does produce it, that traffic through it neither collides
 * nor gets lost, and that it still discharges. It does **not** isolate the rule — a
 * synthetic pair of crossings will not reproduce the failure however it is posed.
 * Free-flowing, the two signals never conflict for long enough; congested, the queue
 * reaches back through the first junction and its box-blocking rule stops anybody
 * arriving at speed, which hides the fault. Measured across eight seeds either way,
 * with the rule and without it, this fixture gives the same number.
 *
 * The evidence for the rule is the eighteen imported cities, where it was worth more
 * than any other single change to the junction model: collisions over five simulated
 * minutes each went from 24 to 6. It was found by tracing one of them (a driver on a
 * 4.0 m lane at 13.7 m/s with a red connector 0.9 m ahead) and confirmed by re-running
 * that driver, who is now held to 3 m/s thirty metres upstream. `scratch/osmcheck.ts`
 * is where that lives, because it needs a real network and those are not in the repo.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { autoSmoothHandles, createDocument, issueId, kph, makeControlPoint } from '@core/network/model';
import type { ControlPoint, EditModel, RoadProfile } from '@core/network/types';

function points(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i]!, coords[i + 1]!));
  autoSmoothHandles(out);
  return out;
}

/** An arterial crossed by two parallel roads twenty metres apart. */
function twinCrossings(): EditModel {
  const model = createDocument(3);
  const road: RoadProfile = {
    id: issueId(model), name: 'arterial', lanesForward: 2, lanesBackward: 2,
    laneWidth: 3.5, speedLimit: kph(60), median: 0, shoulder: 0, isRamp: false,
  };
  model.profiles.push(road);
  model.strokes.push({ id: issueId(model), profileId: road.id, points: points(-500, 0, 500, 0) });
  model.strokes.push({ id: issueId(model), profileId: road.id, points: points(-10, -300, -10, 300) });
  model.strokes.push({ id: issueId(model), profileId: road.id, points: points(10, -300, 10, 300) });
  return model;
}

describe('a junction reached across four metres of road', () => {
  const net = compile(twinCrossings());

  it('is the shape this is about', () => {
    const signals = net.junctions.filter((j) => j.kind === 'crossing' && j.control === 'signal');
    expect(signals.length, 'two signalised crossings').toBe(2);
    // The road between them is far shorter than a stopping distance at 60 km/h,
    // which is about 70 m of comfortable braking.
    const between = net.segments
      .filter((s) => s.startJunction >= 0 && s.endJunction >= 0)
      .map((s) => s.length);
    expect(Math.min(...between)).toBeLessThan(10);
  });

  it('carries traffic through both of them without anybody being hurt or lost', () => {
    // Two independent signals twenty metres apart is a genuinely awkward thing to
    // drive, and the point here is that awkward is as bad as it gets: no vehicle
    // drives through another, and none is written off at a dead end.
    for (const seed of [1, 2, 3, 4]) {
      const sim = new Simulation(net, { seed, demandScale: 0.8 });
      sim.run(300);
      expect(sim.metrics.collisions, `seed ${seed}`).toBe(0);
      expect(sim.metrics.lost, `seed ${seed}`).toBe(0);
    }
  });

  it('does not achieve that by stopping the road', () => {
    // The cheap way to stop anybody running a red is to let nobody through at all.
    const sim = new Simulation(net, { seed: 2, demandScale: 0.35 });
    sim.run(300);
    expect(sim.metrics.arrived).toBeGreaterThan(60);
    expect(sim.metrics.lost).toBe(0);
    expect(sim.metrics.stalled, 'vehicles stopped for over a minute').toBe(0);
  });
});
