/**
 * Traffic in a cul-de-sac: it drives in, goes round the head, and comes back out.
 *
 * The U-turn existing is not the same as the U-turn being used, and the first
 * version of this feature had the first without the second: the connector was there,
 * the bulb was there, and no vehicle ever touched either, because a driver bound for
 * a house on the street simply parked at the first address they passed on the way
 * in. A movement nothing drives is scenery — the same trap as an escape hatch no
 * state can reach.
 *
 * What makes it real is where the head's houses are. Their driveways open onto the
 * turning circle rather than onto the street, so a driver reaches one by going round
 * — and is on the way out by the time they stop.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import { Simulation } from '@core/sim/sim';
import { LaneKind, TurnKind } from '@core/network/types';
import type { EditModel } from '@core/network/types';
import { addProfile, addStroke, doc, line } from '../helpers/build';

/** Houses up a cul-de-sac, shops to drive to, and a collector between them. */
function town(): EditModel {
  const m = doc(5);
  const collector = addProfile(m, {
    name: 'collector', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, speedLimit: kph(60),
  });
  const home = addProfile(m, {
    name: 'home', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40),
    landUse: 'residential',
  });
  const shops = addProfile(m, {
    name: 'shops', lanesForward: 1, lanesBackward: 1, laneWidth: 3.4, speedLimit: kph(40),
    landUse: 'commercial',
  });
  addStroke(m, collector, line(-300, 0, 300, 0));
  addStroke(m, home, line(0, 0, 0, 220));
  addStroke(m, shops, line(-300, 0, -300, 200));
  m.gateways.push({ x: 0, y: 220, role: 'culdesac' });
  return m;
}

describe('traffic in a cul-de-sac', () => {
  const net = compile(town());
  const uTurn = net.lanes.find(
    (l) => l.kind === LaneKind.Connector && l.turn === TurnKind.UTurn)!;

  it('compiles one head and one U-turn', () => {
    expect(net.junctions.filter((j) => j.kind === 'culdesac').length).toBe(1);
    expect(uTurn).toBeDefined();
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('drives round the head, and nobody is lost doing it', () => {
    const sim = new Simulation(net, { seed: 7, spawnMode: 'landuse', demandScale: 3 });
    const S = sim.store;
    const round = new Set<number>();
    let maxOnTurn = 0;
    for (let t = 0; t < 20 * 600; t++) {
      sim.tick();
      let n = 0;
      for (let v = S.laneFirst[uTurn.id]; v >= 0; v = S.behind[v]) {
        round.add(S.serial[v]);
        n++;
      }
      maxOnTurn = Math.max(maxOnTurn, n);
    }
    expect(round.size, 'vehicles that turned round in the head').toBeGreaterThan(5);
    expect(sim.metrics.arrived).toBeGreaterThan(20);
    expect(sim.metrics.lost, 'nobody driven into a dead end they cannot leave').toBe(0);
    expect(sim.metrics.collisions).toBe(0);
    // A ten-metre circle is not a queueing area: if the head ever holds a queue,
    // the movement is being used as a road rather than as a turning place.
    expect(maxOnTurn, 'vehicles in the head at once').toBeLessThanOrEqual(3);
  });

  it('does not send through traffic round it', () => {
    // A cul-de-sac is a place you go to, never a way through. In the portal mode
    // nobody lives there, so nothing should enter at all.
    const sim = new Simulation(net, { seed: 4, spawnMode: 'portals', demandScale: 2 });
    const S = sim.store;
    let visits = 0;
    for (let t = 0; t < 20 * 300; t++) {
      sim.tick();
      for (let v = S.laneFirst[uTurn.id]; v >= 0; v = S.behind[v]) visits++;
    }
    expect(visits).toBe(0);
    expect(sim.metrics.lost).toBe(0);
  });
});
