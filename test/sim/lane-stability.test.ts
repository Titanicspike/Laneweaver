/**
 * Drivers must not change lanes and change straight back.
 *
 * Two halves of the model decide lane changes, and they used to disagree about the
 * same lane. The discretionary half asks `advise`, whose answer for a lane that is
 * already on the route is "you need not move" — so a drift *out* of that lane paid
 * no route penalty at all. The mandatory half then ordered the driver back on the
 * very next tick, because mandatory changes are checked every tick and do not wait
 * out the cooldown. The result was a two-cycle at 20 Hz, limited only by the
 * three-second cooldown on the discretionary leg.
 *
 * It was not subtle once measured: on the town grid **91% of all lane changes were
 * reversals and 47% of them completed and undid themselves inside one second**,
 * 415,000 lane changes in half an hour of simulated traffic. It is invisible in the
 * merge scenarios, which are one segment of freeway with one ramp, and that is why
 * it survived — it needs a junction to appear, and the numbers below come from the
 * example maps for exactly that reason.
 *
 * What fixed it: a discretionary change now reads the *target* lane's lateral plan.
 * Inside the range where that plan would be urgent the change is refused outright —
 * going there voluntarily is choosing to be thrown back — and outside it, it costs
 * something proportionate to how soon it would have to be undone. Overtaking with a
 * kilometre in hand is still nearly free, which is why the merge suite does not
 * move.
 */

import { describe, expect, it } from 'vitest';
import { exampleById } from '@app/examples';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';

interface Churn { changes: number; quick: number; }

function churn(exampleId: string, seconds: number, seed: number): Churn {
  const net = compile(exampleById(exampleId)!.build());
  const sim = new Simulation(net, { seed, demandScale: 1 });
  const last = new Map<number, { t: number; from: number; to: number }>();
  let changes = 0;
  let quick = 0;
  let t = 0;
  sim.observer = {
    onLaneChange: (s, i, from, to) => {
      changes++;
      const serial = s.store.serial[i];
      const prev = last.get(serial);
      // A reversal: the same driver undoing the move it just made.
      if (prev && prev.to === from && prev.from === to && t - prev.t < 1) quick++;
      last.set(serial, { t, from, to });
    },
  };
  const dt = 0.05;
  for (let k = 0; k < Math.round(seconds / dt); k++) {
    t = k * dt;
    sim.tick();
  }
  return { changes, quick };
}

describe('lane changes do not undo themselves', () => {
  // A grid is the worst case: short blocks, so the deadline for being in the right
  // lane for a turn is always close, and every lane is off-route for somebody.
  it.each([['town', 300], ['arterial', 300], ['corridor', 300], ['diamond', 300]] as const)(
    '%s',
    (id, seconds) => {
      const { changes, quick } = churn(id, seconds, 3);
      expect(changes, 'some lane changing should happen').toBeGreaterThan(50);
      const rate = quick / changes;
      // Measured 0.2-0.6% across these four. It was 17-47% before, and the bound is
      // set where a real regression trips it rather than at the measured value.
      expect(rate, `${id}: ${quick}/${changes} reversed inside a second`).toBeLessThan(0.05);
    },
  );

  it('has not simply stopped changing lanes', () => {
    // The cheap way to pass the test above is to never change lanes, which would
    // starve every lane the route does not strictly need. A three-lane freeway
    // carrying ramp traffic has to keep sorting itself out.
    const { changes } = churn('corridor', 300, 3);
    expect(changes).toBeGreaterThan(1000);
  });
});
