/**
 * Merge acceptance suite - the flagship feature's regression net.
 *
 * Every scenario runs over ten seeds of ten simulated minutes and asserts metrics,
 * never appearances. Where an absolute number would be arbitrary (throughput, hard
 * braking) the assertion is made against a *control* run: the same road carrying
 * the same demand with no ramp at all. That measures exactly what the merge cost,
 * which is the only honest way to ask whether a merge is "flawless".
 */

import { describe, expect, it } from 'vitest';
import {
  laneDropScenario, offRampScenario, onRampScenario, plainFreewayScenario, weaveScenario,
} from '../helpers/scenarios';
import { runSeeds, summarise, type MergeReport } from '../helpers/measure';
import { Simulation } from '@core/sim/sim';
import { Hold, MERGE_HOLDS } from '@core/sim/params';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const RUN = { warmup: 200, duration: 400 };

/** Invariants that hold in every scenario, without exception. */
function invariants(reports: MergeReport[]): void {
  for (const r of reports) {
    expect(r.collisions, `seed ${r.seed}: collisions`).toBe(0);
    expect(r.mergeFailures, `seed ${r.seed}: vehicles that ran off a lane end`).toBe(0);
    expect(r.stuckMergers, `seed ${r.seed}: mergers stuck with room beside them`).toBe(0);
    expect(r.lost, `seed ${r.seed}: vehicles lost at a dead end`).toBe(0);
  }
}

describe('onramp-light: mainline around 30% of capacity', () => {
  const reports = runSeeds(
    () => onRampScenario({ mainLanes: 3, mainFlow: 1800, rampFlow: 500 }), SEEDS, RUN);
  const control = runSeeds(() => plainFreewayScenario(3, 2300), SEEDS, RUN);
  const s = summarise(reports);

  it('holds the safety invariants', () => invariants(reports));

  it('merges ramp traffic early in the acceleration lane', () => {
    expect(s.earlyFraction).toBeGreaterThanOrEqual(0.85);
    expect(s.minEarlyFraction).toBeGreaterThanOrEqual(0.72);
  });

  it('slots in close to the speed of the lane being joined', () => {
    expect(s.medianDeltaV).toBeLessThan(4.5);
    expect(s.p90DeltaV).toBeLessThan(8);
  });

  it('barely disturbs the mainline', () => {
    // Hard braking near the merge, over 10 runs of nearly seven minutes each.
    expect(s.hardBrakes).toBeLessThanOrEqual(summarise(control).hardBrakes + 8);
    expect(s.meanSpeed).toBeGreaterThan(24);
    expect(s.maxStopTime).toBeLessThan(20);
  });

  it('carries the demand as well as the same road without a ramp', () => {
    expect(s.throughputVph).toBeGreaterThan(summarise(control).throughputVph * 0.95);
  });
});

describe('onramp-heavy: mainline and ramp at capacity', () => {
  const reports = runSeeds(
    () => onRampScenario({ mainLanes: 2, mainFlow: 3000, rampFlow: 900 }), SEEDS, RUN);
  const control = runSeeds(() => plainFreewayScenario(2, 3900), SEEDS, RUN);
  const s = summarise(reports);

  it('holds the safety invariants', () => invariants(reports));

  it('does not gridlock', () => {
    expect(s.meanSpeed).toBeGreaterThan(6);
    for (const r of reports) expect(r.throughputVph, `seed ${r.seed}`).toBeGreaterThan(2500);
  });

  it('keeps downstream throughput within 10% of the same road without a ramp', () => {
    expect(s.throughputVph).toBeGreaterThan(summarise(control).throughputVph * 0.9);
  });
});

describe('onramp-zipper: both streams queued at the taper', () => {
  const reports = runSeeds(
    () => onRampScenario({ mainLanes: 2, mainFlow: 2200, rampFlow: 1800 }), SEEDS, RUN);
  const s = summarise(reports);

  it('holds the safety invariants', () => invariants(reports));

  it('actually congests the taper, so the zipper is under test', () => {
    expect(s.zipperSeconds).toBeGreaterThan(60);
  });

  it('alternates admission between the two streams', () => {
    expect(s.admissionRatio).toBeGreaterThan(0.4);
    expect(s.admissionRatio).toBeLessThan(0.6);
  });

  it('still moves the traffic', () => {
    expect(s.meanSpeed).toBeGreaterThan(6);
    expect(s.throughputVph).toBeGreaterThan(2800);
  });
});

describe('lanedrop-3to2', () => {
  const reports = runSeeds(() => laneDropScenario({ flow: 3800 }), SEEDS, RUN);
  const control = runSeeds(() => plainFreewayScenario(2, 3800), SEEDS, RUN);
  const s = summarise(reports);

  it('holds the safety invariants', () => invariants(reports));

  it('keeps throughput within 10% of the same road without the drop', () => {
    expect(s.throughputVph).toBeGreaterThan(summarise(control).throughputVph * 0.9);
  });

  it('merges out of the dropped lane well before the taper ends', () => {
    expect(s.earlyFraction).toBeGreaterThanOrEqual(0.75);
  });

  it('does not gridlock', () => {
    expect(s.meanSpeed).toBeGreaterThan(10);
  });
});

describe('offramp', () => {
  const reports = runSeeds(() => offRampScenario({}), SEEDS, RUN);
  const s = summarise(reports);

  it('holds the safety invariants', () => invariants(reports));

  /**
   * This asked for zero, and got it, because the mainline was *compelled* to let
   * exiting traffic in — courtesy became mandatory above a threshold of urgency
   * whatever the driver beside you wanted. Compulsion belongs to a lane that runs
   * out of tarmac; reaching an exit is a favour being asked, and a favour can be
   * refused. So a driver who leaves it late can now miss, and what is asserted is
   * that it stays rare in free flow — the invariants above still pin zero lost,
   * and the test below still pins that nobody stops on the mainline over it.
   *
   * It went from 0.09% to 0.41% when the boundary look-back learned to see past an
   * *empty* lane. A junction connector can be twenty metres long, so "the lane
   * immediately upstream is clear" was answering a question nobody asked: the
   * driver closing at 28 m/s was one lane further back, invisible, and a car
   * dropping into the head of the lane in front of them was a collision the
   * corridor example produced on every seed. The extra misses are the same fact
   * seen from the other side — thirteen drivers per ten runs who would have taken a
   * gap that was not there, and who now go round again.
   */
  it('misses an exit only rarely in free flow', () => {
    const missed = reports.reduce((a, r) => a + r.missedExits, 0);
    const spawned = reports.reduce((a, r) => a + r.spawned, 0);
    expect(missed / spawned).toBeLessThan(0.008);
  });

  it('never stops on the mainline to exit', () => {
    for (const r of reports) expect(r.stoppedToExit, `seed ${r.seed}`).toBe(0);
    expect(s.maxStopTime).toBeLessThan(5);
  });

  it('carries the offered demand', () => {
    expect(s.throughputVph).toBeGreaterThan(3300 * 0.93);
    expect(s.meanSpeed).toBeGreaterThan(22);
  });
});

describe('weaving section: on-ramp then off-ramp sharing one auxiliary lane', () => {
  const reports = runSeeds(() => weaveScenario({}), SEEDS, RUN);
  const s = summarise(reports);

  it('holds the safety invariants', () => invariants(reports));

  it('carries the demand', () => {
    expect(s.throughputVph).toBeGreaterThan(3600 * 0.9);
    expect(s.meanSpeed).toBeGreaterThan(14);
  });

  /**
   * This used to demand zero, and got it — because the merge model would let a
   * driver force their way across at the deadline using braking the traffic behind
   * could only *physically* survive. That last resort belongs to a lane that runs
   * out of tarmac, where there is no alternative to getting in; a driver late for
   * an exit has one, which is to carry on to the next. So an occasional miss is
   * now possible here, and what has to hold is that it stays occasional and that
   * missing costs a detour rather than a life: `invariants` above already pins
   * zero lost and zero collisions.
   */
  it('misses an exit only rarely, and no seed behaves badly', () => {
    const total = reports.reduce((a, r) => a + r.missedExits, 0);
    const spawned = reports.reduce((a, r) => a + r.spawned, 0);
    expect(total / spawned).toBeLessThan(0.005);
    // Per seed rather than "how many seeds saw one at all", which was the previous
    // clause and was measuring the wrong thing. Fifteen misses across six thousand
    // drivers is a rate of 1.5 per seed, and a Poisson process at that rate leaves
    // about two seeds in ten clean — so "at most two seeds with any" was not a
    // quality bar, it was a demand that the misses arrive in *clusters*. It passed
    // only while the model had a couple of pathological seeds and eight clean ones,
    // and it failed the moment the same total spread out evenly, which is the
    // better of the two behaviours. What actually matters is the rate overall, and
    // that no individual seed falls apart.
    for (const r of reports) {
      expect(r.missedExits / r.spawned, `seed ${r.seed}`).toBeLessThan(0.015);
    }
  });
});

/**
 * Two drivers side by side, each easing off to fall in behind the other.
 *
 * Every anti-freeze floor in the merge model keeps a vehicle *moving* — gap
 * alignment never asks for less than 0.8 m/s, creeping is capped at 2 — and every
 * escape hatch was keyed on a clock that only counts standstills. So a pair caught
 * in this held each other at a crawl indefinitely: neither ever stopped, so the
 * give-up never fired, and they crept along side by side for the best part of a
 * minute with an empty road in front of them.
 *
 * The observable is deliberately not "were they deadlocked" but "was anybody
 * crawling with somewhere to go" — these scenarios have no junctions, so there is
 * nothing else a stationary driver could legitimately be waiting for.
 */
describe('nobody is held by the merge model for long', () => {
  const CRAWL = 2.4;
  const scenarios: [string, () => ReturnType<typeof offRampScenario>][] = [
    ['offramp', () => offRampScenario({})],
    ['weave', () => weaveScenario({})],
    ['lanedrop', () => laneDropScenario({})],
    ['busy offramp', () => offRampScenario({ mainLanes: 3, goreX: 700, mainFlow: 2800, exitFlow: 1000 })],
  ];

  for (const [name, build] of scenarios) {
    it(`gets everybody moving again on ${name}`, () => {
      const scenario = build();
      const sim = new Simulation(scenario.net, { seed: 3, demandScale: 1, demand: scenario.model.demand });
      const store = sim.store;
      const run = new Float32Array(store.capacity);
      let worst = 0;
      const ticks = (RUN.warmup + RUN.duration) / 0.05;
      for (let t = 0; t < ticks; t++) {
        sim.tick();
        for (let i = 0; i < store.capacity; i++) {
          if (!store.alive[i]) { run[i] = 0; continue; }
          // Held *by the merge model* — not by the queue in front, not by a
          // signal. Guessing this from speeds and gaps does not work: a queue
          // shuffling along at 2 m/s has twenty-metre gaps in it, so any
          // distance-based notion of "clear road" calls every driver in a jam
          // deadlocked. `store.hold` says which constraint actually produced the
          // acceleration the driver is using, which is the question.
          if (store.v[i] < CRAWL && MERGE_HOLDS.includes(store.hold[i] as Hold)) {
            run[i] += sim.dt;
            if (run[i] > worst) worst = run[i];
          } else {
            run[i] = 0;
          }
        }
      }
      // Creeping to the end of an acceleration lane is legitimate and takes a few
      // seconds. Three quarters of a minute is a driver the model has forgotten
      // about: it was 45 s on the lane drop before the patience clock, and it is
      // 6–14 s across seeds now.
      expect(worst, `${name}: longest stretch held by the merge model`).toBeLessThan(20);
    });
  }
});

/**
 * A driver who cannot get across in time misses the exit and reroutes.
 *
 * This is emergent rather than modelled: the deadline is blown, the destination is
 * no longer reachable from this lane, and the router hands the driver the nearest
 * one that is. What the test pins is that it *happens* under congestion — a model
 * where everybody always makes their exit is one that is forcing them in — and
 * that it costs a detour and nothing else.
 */
describe('missing an exit and rerouting', () => {
  // A three-lane freeway whose exit comes up 700 m after the entry, carrying more
  // traffic than the off-ramp scenario above: a driver bound for the ramp spawns in
  // the middle of it with two lane changes to make and not much road to make them
  // in. That is where an exit is genuinely missable, and a model in which it never
  // is would be one that forces drivers across.
  const heavy = () => offRampScenario({
    mainLanes: 3, goreX: 700, mainFlow: 2800, exitFlow: 1000,
  });
  const reports = runSeeds(heavy, SEEDS, RUN);

  it('happens when the traffic will not let a driver across', () => {
    expect(reports.reduce((a, r) => a + r.missedExits, 0)).toBeGreaterThan(0);
  });

  it('costs a detour and nothing else', () => {
    for (const r of reports) {
      expect(r.lost, `seed ${r.seed}: lost`).toBe(0);
      expect(r.collisions, `seed ${r.seed}: collisions`).toBe(0);
      expect(r.mergeFailures, `seed ${r.seed}: ran off a lane end`).toBe(0);
    }
  });

  it('sends the driver on to somewhere they can still get to', () => {
    // Followed individually: the destination changes mid-trip, and the vehicle
    // still retires as arrived rather than being written off at a dead end.
    let arrivedAfterReroute = 0;
    let stillDriving = 0;
    let retiredOtherwise = 0;
    for (const seed of SEEDS) {
      const scenario = heavy();
      const sim = new Simulation(scenario.net, { seed, demandScale: 1, demand: scenario.model.demand });
      const dest = new Int32Array(sim.store.capacity).fill(-1);
      const rerouted = new Set<number>();
      sim.observer = {
        onSpawn: (s2, i) => { dest[i] = s2.store.dest[i]; },
        onRetire: (s2, i, _lane, reason) => {
          if (!rerouted.delete(s2.store.serial[i])) return;
          if (reason === 'arrived') arrivedAfterReroute++;
          else retiredOtherwise++;
        },
      };
      const ticks = (RUN.warmup + RUN.duration) / 0.05;
      for (let t = 0; t < ticks; t++) {
        sim.tick();
        for (let i = 0; i < sim.store.capacity; i++) {
          if (!sim.store.alive[i] || dest[i] < 0) continue;
          if (sim.store.dest[i] === dest[i]) continue;
          dest[i] = sim.store.dest[i];
          rerouted.add(sim.store.serial[i]);
        }
      }
      stillDriving += rerouted.size;
    }
    // Somebody was rerouted, and nobody who was ended up written off at a dead end.
    expect(arrivedAfterReroute + stillDriving).toBeGreaterThan(0);
    expect(retiredOtherwise).toBe(0);
  });
});
