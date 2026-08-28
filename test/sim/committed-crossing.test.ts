/**
 * A driver part-way across a junction, and a rival that cannot stop.
 *
 * Once a vehicle has entered a connector it is committed: it stops giving way as a
 * matter of priority, because it has nowhere to give way *to* and freezing
 * mid-junction is worse than carrying on. That rule is right, and it had a hole in
 * it — a rival that had not yet entered the junction was ignored **entirely**,
 * however fast it was coming.
 *
 * The perf bench found it, which is the only place in the suite with five thousand
 * vehicles and three hundred conflict points: a left-turner crawling across at
 * 3 m/s with six metres still to go, and a through movement fifty metres out doing
 * 26 m/s — which needs fifty-five metres to stop. The turner ignored it because it
 * had not entered the junction, drove on into its path, and the two met in the
 * middle. Two such events in the bench's window, three in forty simulated minutes,
 * and one of them had been there before any of this session's changes.
 *
 * The fix is a safety floor rather than a yield, and the distinction is what keeps
 * it from reintroducing the frozen-junction problem: a vehicle that has *reached*
 * the conflict point returns long before this code, so nobody is ever asked to stop
 * on top of one. It only ever asks a driver still short of the point — who
 * therefore still has a choice — to use it.
 *
 * This runs the bench's own network, because the failure needs a lot of traffic and
 * a lot of conflict points to show up at all. Two hundred seconds is enough: the
 * two collisions it used to produce at this seed were at t=101 and t=117.
 *
 * **Known limitation.** At an at-grade *priority* crossing where the speeds are
 * wildly mismatched — a 110 km/h dual carriageway crossed by a 45 km/h street —
 * collisions still happen: three on one seed in six, over fifteen simulated
 * minutes. The junction is a hazard in reality for the same reason, which is why
 * they get signals or a bridge, but the invariant here is zero and this is not yet
 * zero. It is the next thing to fix in the junction model.
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

/** The perf bench's synthetic corridor, verbatim: three freeways with ramps. */
function benchNetwork(): EditModel {
  const model = createDocument(31337);
  const freeway: RoadProfile = {
    id: issueId(model), name: 'Bench freeway', lanesForward: 3, lanesBackward: 3,
    laneWidth: 3.65, speedLimit: kph(110), median: 6, shoulder: 2.5, isRamp: false,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  };
  const ramp: RoadProfile = {
    id: issueId(model), name: 'Bench ramp', lanesForward: 1, lanesBackward: 0,
    laneWidth: 4, speedLimit: kph(85), median: 0, shoulder: 1.2, isRamp: true,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  };
  model.profiles.push(freeway, ramp);
  const LENGTH = 15000;
  for (let c = 0; c < 3; c++) {
    const y = c * 900;
    model.strokes.push({
      id: issueId(model), profileId: freeway.id,
      points: points(0, y, LENGTH / 2, y + 120, LENGTH, y),
    });
    for (let k = 1; k < 5; k++) {
      const x = (LENGTH * k) / 5;
      model.strokes.push({
        id: issueId(model), profileId: ramp.id,
        points: points(x - 500, y + 260, x - 200, y + 150, x, y + 30),
      });
      model.strokes.push({
        id: issueId(model), profileId: ramp.id,
        points: points(x + 400, y - 30, x + 700, y - 150, x + 1000, y - 260),
      });
    }
  }
  model.settings.demandScale = 6;
  return model;
}

describe('a rival that has not entered the junction yet', () => {
  const net = compile(benchNetwork());

  it('is the network with the conflict points that found this', () => {
    // The bench's freeways curve, so some ramps end up crossing one at grade — an
    // accident of the synthetic geometry, and the only place in the suite where a
    // fast road crosses a slow one under priority control.
    expect(net.junctions.some((j) => j.kind === 'crossing')).toBe(true);
    expect(net.lanes.reduce((acc, l) => acc + l.conflicts.length, 0)).toBeGreaterThan(50);
  });

  it('never drives into a vehicle that cannot stop for it', () => {
    const sim = new Simulation(net, { seed: 1, maxVehicles: 9000, demandScale: 6 });
    sim.run(200);
    expect(sim.store.count, 'traffic should have built up').toBeGreaterThan(1200);
    expect(sim.metrics.collisions).toBe(0);
  });

  it('does not achieve that by stopping everybody', () => {
    // The cheap way to make a crossing collision-free is to make nobody cross.
    const sim = new Simulation(net, { seed: 1, maxVehicles: 9000, demandScale: 6 });
    sim.run(200);
    // 16.5 m/s across a filling network with ramps merging everywhere.
    expect(sim.metrics.meanSpeed).toBeGreaterThan(14);
    expect(sim.metrics.stalled, 'vehicles stopped for over a minute').toBe(0);
  });
});
