/**
 * Where traffic enters the network.
 *
 * A portal offers several lanes, and which one a driver arrives in used to be
 * "whichever has the most room". Room is `Infinity` for an empty lane and
 * `Infinity > Infinity` is false, so every tie went to whichever lane came first in
 * the list: on a quiet three-lane freeway **82% of all traffic entered in the kerb
 * lane** and then spread out. That is a wave of pointless lane changes at every
 * portal, and a road whose lanes look unloved for the first few hundred metres —
 * which is exactly what "some lanes never get used" looks like from the map.
 *
 * It is deliberately *not* route-aware. Letting drivers start in whichever lane the
 * router calls cheapest sounds better and measured worse: lane costs differ by
 * whole `LANE_CHANGE_COST` steps, so it stops being a bias and becomes a rule that
 * puts every exit-bound driver in one lane from the moment they appear, and leaves
 * the rest to queue. Positioning for a turn is what the routing gradient already
 * does en route, where it can see the traffic.
 */

import { describe, expect, it } from 'vitest';
import { Simulation } from '@core/sim/sim';
import { compile } from '@core/network/compiler';
import { onRampScenario } from '../helpers/scenarios';
import type { Network } from '@core/network/types';

/** Share of spawns per lane index, counting the mainline only. */
function entryShare(net: Network, demand: never, seconds: number, seed: number): number[] {
  const sim = new Simulation(net, { seed, demandScale: 1, demand });
  const byIndex: number[] = [];
  sim.observer = {
    onSpawn: (s, _i, laneId) => {
      const lane = s.net.lanes[laneId]!;
      const seg = s.net.segments[lane.segmentId];
      // A ramp's only lane is index 0 as well; counting it hides what the
      // mainline does.
      if (!seg || seg.isRamp) return;
      byIndex[lane.index] = (byIndex[lane.index] ?? 0) + 1;
    },
  };
  sim.run(seconds);
  const total = byIndex.reduce((a, b) => a + (b ?? 0), 0) || 1;
  return byIndex.map((n) => (n ?? 0) / total);
}

describe('choosing a lane to enter in', () => {
  it('spreads traffic across lanes that are equally good', () => {
    for (const flow of [1800, 3600]) {
      const sc = onRampScenario({ mainLanes: 3, mainFlow: flow, rampFlow: 500 });
      const share = entryShare(sc.net, sc.model.demand as never, 400, 4);
      expect(share.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        // Even is a third each. Anything past half is one lane taking the traffic
        // and the others being left to fill in later.
        expect(share[i], `flow ${flow}, lane ${i}: ${(share[i]! * 100).toFixed(0)}%`)
          .toBeGreaterThan(0.2);
        expect(share[i], `flow ${flow}, lane ${i}: ${(share[i]! * 100).toFixed(0)}%`)
          .toBeLessThan(0.47);
      }
    }
  });

  it('keeps every lane in use at a flow one lane could not carry', () => {
    const sc = onRampScenario({ mainLanes: 3, mainFlow: 5400, rampFlow: 0 });
    const share = entryShare(sc.net, sc.model.demand as never, 400, 9);
    const used = share.filter((x) => x > 0.15).length;
    expect(used, `lanes carrying a real share: ${share.map((x) => (x * 100).toFixed(0)).join('/')}`)
      .toBe(3);
  });

  it('never spawns a vehicle on top of one already there', () => {
    const sc = onRampScenario({ mainLanes: 3, mainFlow: 5400, rampFlow: 900 });
    const sim = new Simulation(compile(sc.model), { seed: 2, demandScale: 1, demand: sc.model.demand });
    sim.observer = {
      onSpawn: (s, i, laneId) => {
        const lead = s.store.ahead[i];
        if (lead < 0) return;
        const gap = s.store.s[lead] - s.store.len[lead] - s.store.s[i];
        expect(gap, `spawned into lane ${laneId} with ${gap.toFixed(1)} m in front`)
          .toBeGreaterThan(0);
      },
    };
    sim.run(300);
    expect(sim.metrics.spawned).toBeGreaterThan(100);
    expect(sim.metrics.collisions).toBe(0);
  });
});
