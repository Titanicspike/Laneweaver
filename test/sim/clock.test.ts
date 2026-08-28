/**
 * Time of day, and the waves of traffic that come with it.
 *
 * A simulator generating the same flow at 03:00 as at 08:30 is measuring an hour
 * that never happens. The clock is what makes "does this junction cope" a question
 * about the *shape* of a day rather than about one number, and it is what makes a
 * peak something you can sit and watch.
 *
 * The one non-obvious constraint is at the bottom of `clock.ts` and it is checked
 * here: the flow multiplier is never allowed to reach zero. The spawner draws its
 * next arrival from an exponential with the rate as the parameter, so a rate of zero
 * gives an interval of infinity — a pair that goes quiet at 03:00 would never wake
 * up, and the morning peak would arrive with nobody in it.
 */

import { describe, expect, it } from 'vitest';
import { flowAt, formatClock, homeToWorkAt, periodOf } from '@core/sim/clock';
import { Simulation } from '@core/sim/sim';
import { compile } from '@core/network/compiler';
import { exampleById } from '@app/examples';

describe('the shape of a day', () => {
  it('peaks morning and evening, with a midday plateau between', () => {
    const morning = flowAt(8);
    const midday = flowAt(13);
    const evening = flowAt(17.5);
    const night = flowAt(3);
    expect(morning).toBeGreaterThan(midday * 1.4);
    expect(evening).toBeGreaterThan(midday * 1.4);
    expect(night).toBeLessThan(midday * 0.3);
    // Two peaks, not one long one: the middle of the day has to dip between them.
    expect(midday).toBeLessThan(Math.min(morning, evening) * 0.75);
  });

  it('never reaches zero', () => {
    for (let h = 0; h < 24; h += 0.25) {
      expect(flowAt(h), `flow at ${h}`).toBeGreaterThan(0);
    }
  });

  it('reverses the commute over the day', () => {
    expect(homeToWorkAt(8)).toBeGreaterThan(0.85);
    expect(homeToWorkAt(17.5)).toBeLessThan(0.15);
    // And passes through the middle rather than jumping.
    expect(homeToWorkAt(12.5)).toBeGreaterThan(0.35);
    expect(homeToWorkAt(12.5)).toBeLessThan(0.65);
  });

  it('interpolates rather than stepping on the hour', () => {
    // A step change on the hour puts a visible seam in the traffic every sixty
    // minutes, which reads as a bug in the spawner.
    const before = flowAt(7.99);
    const after = flowAt(8.01);
    expect(Math.abs(after - before)).toBeLessThan(0.02);
  });

  it('wraps, so a run can cross midnight', () => {
    expect(flowAt(24.5)).toBeCloseTo(flowAt(0.5), 5);
    expect(flowAt(-1)).toBeCloseTo(flowAt(23), 5);
  });

  it('reads out as a clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(13.75)).toBe('13:45');
    expect(formatClock(24.25)).toBe('00:15');
    expect(periodOf(8)).toBe('morning peak');
    expect(periodOf(3)).toBe('night');
  });
});

describe('a simulation with a clock', () => {
  const net = compile(exampleById('arterial')!.build());

  it('has no clock unless the document asks for one', () => {
    const sim = new Simulation(net, { seed: 1 });
    expect(sim.timeOfDay).toBe(-1);
  });

  it('runs the clock from the hour it was told to start at', () => {
    const sim = new Simulation(net, { seed: 1, dayLength: 2400, startHour: 6 });
    expect(sim.timeOfDay).toBeCloseTo(6, 5);
    sim.run(100); // 2400 s per day, so 100 s is one hour
    expect(sim.timeOfDay).toBeCloseTo(7, 3);
    sim.run(2400);
    expect(sim.timeOfDay, 'a full day returns to the same hour').toBeCloseTo(7, 2);
  });

  it('generates a peak and a trough in one day', () => {
    // Counted per simulated hour across a whole day. The peak hour has to carry
    // several times what the quiet hour does, or the clock is decorative.
    const sim = new Simulation(net, { seed: 4, dayLength: 24 * 100, startHour: 0 });
    const perHour = new Array<number>(24).fill(0);
    sim.observer = {
      onSpawn: (s) => { perHour[Math.floor(s.timeOfDay)] = (perHour[Math.floor(s.timeOfDay)] ?? 0) + 1; },
    };
    sim.run(24 * 100);
    const busiest = Math.max(...perHour);
    const quietest = Math.min(...perHour);
    expect(busiest, 'nothing was generated at all').toBeGreaterThan(20);
    expect(busiest / Math.max(1, quietest), `peak ${busiest} vs trough ${quietest}`)
      .toBeGreaterThan(4);
    // The busiest hour should be one of the two peaks rather than the middle of the
    // night, which is the thing that would silently be wrong.
    const peakHour = perHour.indexOf(busiest);
    expect(peakHour >= 6 && peakHour <= 19, `busiest hour was ${peakHour}:00`).toBe(true);
  });

  /**
   * The departures actually follow the curve.
   *
   * They did not, and the reason is worth keeping: the spawner drew an *interval*
   * from the rate that applied when the last vehicle left, then counted it down. A
   * rate that changes during the countdown is simply not consulted — an interval
   * drawn at three in the morning is minutes long, so it swallows the whole dawn
   * ramp before it next looks, and one drawn at the evening peak keeps firing long
   * after the peak has gone. Over a simulated day that lost 58% of all demand and
   * put the busiest hour at 20:00, at half the peak flow. The fix is to spend a
   * Poisson *quota* at whatever rate currently applies, which is exact for a rate
   * that varies.
   */
  it('departs the traffic the clock asked for, when it asked for it', () => {
    const sim = new Simulation(net, { seed: 4, dayLength: 24 * 100, startHour: 0 });
    const perHour = new Array<number>(24).fill(0);
    sim.observer = { onSpawn: (s) => { perHour[Math.floor(s.timeOfDay)]++; } };
    sim.run(24 * 100);

    // What the demand curve asked for over the day, in the same units. The flow
    // multiplier is the only thing that varies, so the shape is the curve itself.
    const asked = new Array<number>(24).fill(0).map((_, h) => flowAt(h + 0.5));
    const total = perHour.reduce((a, b) => a + b, 0);
    const askedTotal = asked.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(400);

    // Hour by hour, departures track the curve. Correlation rather than an exact
    // count, because a busy hour genuinely cannot always place what it generates.
    let num = 0, dx = 0, dy = 0;
    const mx = total / 24, my = askedTotal / 24;
    for (let h = 0; h < 24; h++) {
      num += (perHour[h] - mx) * (asked[h] - my);
      dx += (perHour[h] - mx) ** 2;
      dy += (asked[h] - my) ** 2;
    }
    const r = num / Math.sqrt(dx * dy);
    expect(r, `departures vs the demand curve correlate at r=${r.toFixed(2)}`)
      .toBeGreaterThan(0.8);

    // And the quiet half of the day carries much less than the busy half, rather
    // than the backlog of the busy half being released into it.
    const night = perHour.slice(0, 6).reduce((a, b) => a + b, 0);
    const day = perHour.slice(7, 19).reduce((a, b) => a + b, 0);
    expect(day / Math.max(1, night)).toBeGreaterThan(4);
  });

  it('stays deterministic with the clock running', () => {
    const run = (): number => {
      const sim = new Simulation(net, { seed: 9, dayLength: 3000, startHour: 7 });
      sim.run(900);
      return sim.metrics.spawned * 1000 + sim.metrics.arrived;
    };
    expect(run()).toBe(run());
  });

  it('is still safe through a peak', () => {
    // A whole day, at a demand the arterial can actually carry through its peak. At
    // full demand the peak saturates and the run is dominated by the queue rather
    // than by the thing being checked, which is that a *changing* rate does not
    // break anything the fixed one did not.
    // 05:00 to 13:00, which is the interesting half: the flow climbs by a factor of
    // twenty on the way into the morning peak and falls again after it.
    const sim = new Simulation(net, {
      seed: 2, dayLength: 24 * 70, startHour: 5, demandScale: 0.7,
    });
    sim.run(8 * 70);
    expect(sim.timeOfDay).toBeCloseTo(13, 1);
    expect(sim.metrics.collisions).toBe(0);
    expect(sim.metrics.lost).toBe(0);
    expect(sim.metrics.arrived).toBeGreaterThan(40);
  });
});
