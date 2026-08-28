/**
 * A merger who has run out of both road and speed.
 *
 * The gap scorer has two rules that keep a driver from wanting a gap they cannot
 * get to: do not drop back once dropping back has stopped working, and do not want
 * a gap further away than the runway left. Both are right, and both are written for
 * a driver who is still moving. For one who has stopped on the last metre of an
 * acceleration lane they are exactly inverted — that driver cannot drive to a gap
 * at all, so the only reachable one is the one still coming toward them, and the
 * one alongside is the single worst choice available.
 *
 * Together the two rules left the gap alongside as the only candidate. It slides
 * past at the speed of the mainline, so the choice advanced by one vehicle every
 * couple of seconds, indefinitely — and each re-selection handed the cooperation
 * job to whichever mainline driver happened to be level at that moment, so nobody
 * ever held it long enough to open anything. Measured on `onramp-heavy`: seventy-six
 * seconds stationary at the lane end, with the mainline flowing past at 10 m/s and
 * room beside them the whole time.
 *
 * This is the same shape as the mainline-side stickiness tarpit, seen from the
 * other side: whoever is choosing has to hold the choice long enough for it to mean
 * something.
 */

import { describe, expect, it } from 'vitest';
import { onRampScenario } from '../helpers/scenarios';
import { Simulation } from '@core/sim/sim';

describe('a merger stranded at the end of an acceleration lane', () => {
  /** Longest any vehicle sits stopped on the auxiliary lane, over ten minutes. */
  function worstStop(seed: number): { stop: number; arrived: number; collisions: number } {
    const scen = onRampScenario({ mainLanes: 2, mainFlow: 3000, rampFlow: 900 });
    const sim = new Simulation(scen.net, { seed, demand: scen.model.demand });
    const aux = scen.net.lanes.find((l) => l.aux && l.kind === 0)!;
    const S = sim.store;
    let stop = 0;
    sim.run(200);
    for (let t = 0; t < 8000; t++) {
      sim.tick();
      for (let i = 0; i < S.count; i++) {
        if (S.lane[i] === aux.id && S.stoppedTime[i] > stop) stop = S.stoppedTime[i];
      }
    }
    return { stop, arrived: sim.metrics.arrived, collisions: sim.metrics.collisions };
  }

  it('gets in rather than waiting for a gap that keeps moving away', () => {
    // Two seeds that reproduce it: without the fix these stop for 13 s and 39 s,
    // and across all ten the worst runs to 39 s against 5 s with it. Which seed
    // shows it worst moves whenever anything upstream changes the arrival pattern
    // — the pathology is a property of the scorer, not of a particular run — so
    // what is asserted is the worst of a handful rather than one chosen number.
    let worst = 0;
    for (const seed of [3, 7]) {
      const { stop, arrived, collisions } = worstStop(seed);
      expect(collisions, `seed ${seed}`).toBe(0);
      expect(arrived, `seed ${seed}`).toBeGreaterThan(300);
      worst = Math.max(worst, stop);
    }
    // Creeping to the end of an acceleration lane and waiting a few seconds for a
    // gap is legitimate and happens constantly at capacity. Half a minute of it is
    // two drivers waiting for each other.
    expect(worst, 'longest stop on the acceleration lane').toBeLessThan(12);
  });
});
