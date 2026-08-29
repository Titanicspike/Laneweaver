/**
 * How fast a driver may be *put* on the road.
 *
 * A driver who has been travelling arrives at a queue, or at slower road, with the
 * whole approach behind them to slow down in. One who is created at the edge of the
 * network does not, and no car-following model can undo a vehicle that was placed
 * somewhere it could never have reached at that speed: it brakes at the emergency
 * cap from the first tick and still runs into whatever is there.
 *
 * On an imported freeway interchange this was almost every rear-end collision, in
 * two flavours. A road end in a city is metres from the junction it feeds, so the
 * queue a new arrival joins is usually on the *next* lane. And a five-metre entry
 * lane onto a five-arm junction offers a 60 km/h movement beside a 13 km/h one — so
 * looking down one successor spawns drivers at the limit in front of the turn they
 * are about to take.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { autoSmoothHandles, createDocument, issueId, kph, makeControlPoint } from '@core/network/model';
import { EXAMPLES } from '@app/examples';
import { Hold } from '@core/sim/params';
import { LaneKind } from '@core/network/types';
import type {
  ControlPoint, EditModel, Network, RoadProfile, SpawnMode,
} from '@core/network/types';

function points(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i]!, coords[i + 1]!));
  autoSmoothHandles(out);
  return out;
}

/**
 * The shape an import makes constantly, and the one a hand-drawn document almost
 * never does: a **short** fast stub ending at a junction with slow roads.
 *
 * The stub is what makes it bite. Its far end is where the network stops, so it is
 * an entry portal, and a driver created there has forty metres before a turn taken
 * at walking pace. A driver who had come from anywhere else would have slowed down
 * over the approach; this one is simply put there at the limit.
 *
 * It also has a *fast* way out beside the slow ones — the road carries straight on —
 * which is why the entry speed has to consider every successor rather than the
 * first. Read one and the answer is "the road ahead is fast", which is true of the
 * way this driver is not going.
 *
 * One lane each way on purpose. With two, somebody can change into the gap in front
 * of a driver that has just been placed — which is that driver's decision and not
 * the spawner's, and it is the example maps below that say whether it happens often
 * enough to matter.
 */
function shortFastStub(): EditModel {
  const model = createDocument(11);
  const fast: RoadProfile = {
    id: issueId(model), name: 'fast', lanesForward: 1, lanesBackward: 1,
    laneWidth: 3.65, speedLimit: kph(80), median: 2, shoulder: 1, isRamp: false,
  };
  const slow: RoadProfile = {
    id: issueId(model), name: 'slow', lanesForward: 1, lanesBackward: 1,
    laneWidth: 3, speedLimit: kph(30), median: 0, shoulder: 0, isRamp: false,
  };
  model.profiles.push(fast, slow);
  // The stub, then the same road carrying on well past the junction.
  model.strokes.push({ id: issueId(model), profileId: fast.id, points: points(-40, 0, 0, 0) });
  model.strokes.push({ id: issueId(model), profileId: fast.id, points: points(0, 0, 600, 0) });
  model.strokes.push({ id: issueId(model), profileId: slow.id, points: points(0, -300, 0, 0, 0, 300) });
  return model;
}

/**
 * The worst deceleration asked of a driver in their first seconds *by the road or
 * the traffic in front of them* — the two things the entry speed is chosen against,
 * and so the two this file is about.
 *
 * Deliberately not every cause and deliberately only the first tick. A merger
 * regulating against a chosen gap (`Hold.GapFollow`) can legitimately brake hard
 * early on and is the merge model's business; and a second later somebody may have
 * changed lanes in front of this driver, which is that driver's decision, not the
 * spawner's. On the spawn tick nothing has happened yet except being put there, so
 * emergency braking then has exactly one possible author.
 */
function worstPlacementBraking(
  net: Network, seconds: number, spawnMode?: SpawnMode, youngFor = 0.06,
): number {
  const sim = new Simulation(net, { seed: 4, demandScale: 1.5, spawnMode });
  const store = sim.store;
  let worst = 0;
  for (let t = 0; t < seconds / 0.05; t++) {
    sim.tick();
    for (let i = 0; i < store.capacity; i++) {
      if (store.lane[i] < 0 || store.age[i] > youngFor) continue;
      if (store.hold[i] !== Hold.Leader && store.hold[i] !== Hold.SpeedLimit) continue;
      worst = Math.min(worst, store.a[i]);
    }
  }
  return worst;
}

describe('the speed a vehicle is created at', () => {
  const net = compile(shortFastStub());

  it('is never faster than the road it is about to reach allows', () => {
    const sim = new Simulation(net, { seed: 4, demandScale: 1.5 });
    const seen: { v: number; cap: number }[] = [];
    sim.observer = {
      onSpawn(s, i, laneId) {
        // What could this driver still be doing, given every way out of here?
        let cap = Infinity;
        const walk = (lane: number, dist: number, hops: number): void => {
          if (hops <= 0 || dist > 200) return;
          for (const next of s.net.lanes[lane].successors) {
            const l = s.net.lanes[next];
            cap = Math.min(cap, Math.sqrt(l.speedLimit * l.speedLimit + 2 * 2.0 * dist));
            walk(next, dist + l.length, hops - 1);
          }
        };
        walk(laneId, s.net.lanes[laneId].length - s.store.s[i], 6);
        seen.push({ v: s.store.v[i], cap });
      },
    };
    sim.run(120);
    expect(seen.length).toBeGreaterThan(30);
    // A tolerance, not a fudge: the walk above uses comfortable braking exactly as
    // the spawner does, so anything over it is a driver placed too fast.
    for (const s of seen) expect(s.v).toBeLessThanOrEqual(s.cap + 0.5);
  });

  it('does not need the emergency cap to survive being spawned', () => {
    // 6 m/s2 is the hard cap and is meant for emergencies. Nobody should reach it on
    // the tick they are created: before the fix, drivers were placed at 28 m/s a few
    // metres from a 30 km/h turn, or ten metres behind traffic doing eighteen, and
    // were at the cap from their very first evaluation.
    expect(worstPlacementBraking(net, 120)).toBeGreaterThan(-5.9);
  });

  it('holds on the documents people actually open', () => {
    // The synthetic case above is built to be nasty. These are the five shipped
    // example maps, where this used to happen to one spawn in twenty: on the
    // diamond interchange and the C-D road, fifteen drivers in a two-minute run
    // were at the emergency cap in their first seconds because of where they had
    // been put.
    for (const example of EXAMPLES) {
      const model = example.build();
      // In the mode the document actually uses: the town grid's traffic starts at
      // its own front doors, and that is a different placement path.
      const worst = worstPlacementBraking(compile(model), 90, model.settings.spawnMode);
      expect(worst, example.name).toBeGreaterThan(-5.9);
    }
  });

  it('does not achieve that by refusing to spawn anybody', () => {
    const sim = new Simulation(net, { seed: 4, demandScale: 1.5 });
    sim.run(120);
    expect(sim.metrics.spawned).toBeGreaterThan(30);
    expect(sim.metrics.collisions).toBe(0);
    // And the traffic still gets up to speed once it has room to.
    const fast = net.lanes.filter((l) => l.kind === LaneKind.Road && l.speedLimit > 20);
    expect(fast.length).toBeGreaterThan(0);
    expect(sim.metrics.meanSpeed).toBeGreaterThan(4);
  });
});
