/**
 * Junction negotiation: signals, priority, gap acceptance and box-blocking.
 *
 * Decisions are made on the *approach*. Once a vehicle has entered a connector it
 * is committed and will not stop for priority any more — only for a vehicle
 * physically occupying its path, which is the collision-safety floor and is never
 * relaxed. Priority itself comes from the compiler's strict total order, so mutual
 * yielding is structurally impossible.
 */

import { LaneKind, TurnKind } from '../network/types';
import type { Lane } from '../network/types';
import { SignalState } from './signals';
import { idmToStop } from './idm';
import { IDM, JUNCTION } from './params';
import type { Simulation } from './sim';

const _p = { s0: IDM.s0, T: IDM.T, aMax: IDM.aMax, b: IDM.b };

/**
 * How long a vehicle needs to cover `d`, accelerating from `v` toward `vMax`.
 *
 * Constant-speed extrapolation is what let two vehicles drive through each other:
 * it reads a crawl as "miles away" for exactly as long as the crawl lasts.
 */
function arrivalTime(d: number, v: number, vMax: number, a: number): number {
  if (d <= 0) return 0;
  const top = Math.max(v, vMax);
  const runUp = (top * top - v * v) / (2 * a);
  if (d <= runUp) return (Math.sqrt(v * v + 2 * a * d) - v) / a;
  return (top - v) / a + (d - runUp) / top;
}

/** Distance from a vehicle to a point at `sPoint` on `connectorId`, or Infinity. */
function distanceToPoint(sim: Simulation, v: number, connectorId: number, sPoint: number): number {
  const store = sim.store;
  const lane = store.lane[v];
  if (lane === connectorId) return sPoint - store.s[v];
  if (sim.nextEdge[v] !== connectorId) return Infinity;
  return sim.net.lanes[lane].length - store.s[v] + sPoint;
}

/**
 * The vehicle most likely to reach `sPoint` on `connectorId` first, or -1.
 * Vehicles that have already driven clear of the point are skipped: they are no
 * longer anybody's problem.
 *
 * Off the connector, the search walks a little way down *every* lane that feeds it
 * rather than asking only the head of the first one. A junction arm usually has
 * several lanes, and the head of any of them may be turning somewhere else — read
 * only that one and the driver behind it, who is coming straight at you, is
 * invisible. That showed up as traffic with a green being made to brake for a
 * vehicle that had turned on red in front of it: the turner saw an empty junction
 * because the first car in the queue happened to be turning the other way.
 */
const CLAIMANT_DEPTH = 4;

function claimant(sim: Simulation, connectorId: number, sPoint: number): number {
  const store = sim.store;
  for (let v = store.laneFirst[connectorId]; v >= 0; v = store.behind[v]) {
    if (store.s[v] - store.len[v] > sPoint + JUNCTION.conflictZone) continue; // fully past
    return v;
  }
  const connector = sim.net.lanes[connectorId];
  let best = -1;
  let bestDistance = Infinity;
  for (const pred of connector.predecessors) {
    const lane = sim.net.lanes[pred];
    if (!lane) continue;
    let n = 0;
    for (let v = store.laneFirst[pred]; v >= 0 && n < CLAIMANT_DEPTH; v = store.behind[v], n++) {
      if (sim.nextEdge[v] !== connectorId) continue;
      const d = lane.length - store.s[v];
      if (d < bestDistance) { bestDistance = d; best = v; }
      break; // the nearest one on this lane is the only one that matters
    }
  }
  return best;
}

/** Widest angle at which two paths count as merging rather than crossing. */
const MERGING_ANGLE = (20 * Math.PI) / 180;

/**
 * Does this movement cut across another, rather than merely joining it?
 *
 * What makes a turn on red safe in the real world is not that it points right but
 * that it *crosses nothing*: it hugs the kerb and joins the near lane, so the only
 * traffic it has to deal with is the traffic it is joining. Reading the turn kind
 * alone is not enough on an irregular junction — on a five-way, a movement
 * classified as a right turn can sweep the whole box and conflict with eleven
 * others, and letting that go on red parks it across everybody's green. A
 * shared destination is recorded at zero degrees and is a merge, not a crossing,
 * which is exactly the case a turn on red is allowed to negotiate.
 */
function crossesTraffic(connector: Lane): boolean {
  for (const conflict of connector.conflicts) {
    if (conflict.angle > MERGING_ANGLE) return true;
  }
  return false;
}

export function applyJunctionRules(sim: Simulation, i: number): void {
  const store = sim.store;
  const net = sim.net;
  const laneId = store.lane[i];
  const lane = net.lanes[laneId];
  const v = store.v[i];
  const params = sim.paramsOf(i, _p);
  const v0 = sim.desiredSpeedOf(i);

  const onConnector = lane.kind === LaneKind.Connector;
  const connectorId = onConnector ? laneId : sim.nextEdge[i];
  if (connectorId < 0) {
    store.stopArrival[i] = -1;
    return;
  }
  const connector = net.lanes[connectorId];
  if (connector.kind !== LaneKind.Connector) {
    store.stopArrival[i] = -1;
    return;
  }
  const junction = net.junctions[connector.junctionId];
  const allWayStop = junction?.control === 'allway-stop';

  // Distance from the front bumper to the connector entry (negative once inside).
  const toEntry = onConnector ? -store.s[i] : lane.length - store.s[i];
  if (onConnector) store.stopArrival[i] = -1;

  // How far out a driver starts thinking about the junction.
  //
  // It cannot be a fixed number, because what it has to cover is the distance this
  // driver needs to *stop*, and that goes as the square of their speed. Ninety
  // metres is a comfortable stop at 19 m/s and nothing like one at 30, so on a fast
  // road a driver first considered the queue across the box — or the red light —
  // some way after the last moment they could have done anything about it. They
  // then rolled in and stopped inside, which is precisely how a junction deadlocks
  // from the inside.
  //
  // This went unnoticed for as long as it did because a separate rule was bleeding
  // everybody's speed off over the whole approach, so nobody ever arrived fast
  // enough to test it. That rule is gone — drivers now hold the limit and brake
  // late, as they do in life — and this one has to stand on its own.
  const approach = Math.max(
    JUNCTION.approach, (v * v) / (2 * params.b) * JUNCTION.approachMargin,
  );
  if (toEntry > approach) return;

  if (!onConnector && allWayStop) {
    // Everyone stops at the line first; who goes next is decided by who got there
    // first, not by a fixed pecking order.
    if (store.stopArrival[i] < 0) {
      sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
      if (v < JUNCTION.stoppedSpeed && toEntry < JUNCTION.stopMargin * 2 + 1) {
        store.stopArrival[i] = sim.time;
      }
      store.waitTime[i] += sim.dt;
      return;
    }
  }

  // Turning against a red: permitted for the kerb-side turn unless the junction
  // says otherwise, and only ever from a standstill, giving way to everything.
  let onRed = false;

  if (!onConnector) {
    // Signals.
    if (sim.signals.mustStop(connectorId, v, toEntry)) {
      const kerbSide = net.driveOnRight ? TurnKind.Right : TurnKind.Left;
      const mayTurn = junction?.turnOnRed === true
        && connector.turn === kerbSide
        && sim.signals.stateOf(connectorId) === SignalState.Red
        && !crossesTraffic(connector);
      if (!mayTurn) {
        store.stopArrival[i] = -1;
        sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
        store.waitTime[i] += sim.dt;
        return;
      }
      // And able to get out the other side, with room to spare. Half the reason a
      // turn on red ends up blocking a green movement is that the driver could get
      // *in* and then had nowhere to go.
      const exit = connector.successors[0];
      const exitTail = exit === undefined ? -1 : store.laneLast[exit];
      const roomBeyond = exitTail < 0
        ? Infinity : store.s[exitTail] - store.len[exitTail];
      if (mayTurn && roomBeyond < store.len[i] + JUNCTION.turnOnRedExitRoom) {
        sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
        store.waitTime[i] += sim.dt;
        return;
      }
      // Stop at the line first — that is the whole difference between turning on
      // red and running it — and only then look for a gap. Amber is deliberately
      // excluded: a green is a second away, and creeping out on it would take a
      // gap from traffic that still has the junction.
      if (store.stopArrival[i] < 0) {
        sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
        if (v < JUNCTION.stoppedSpeed && toEntry < JUNCTION.stopMargin * 2 + 1) {
          store.stopArrival[i] = sim.time;
        }
        store.waitTime[i] += sim.dt;
        return;
      }
      onRed = true;
    } else if (!allWayStop) {
      store.stopArrival[i] = -1;
    }
    // Do not block the box. The test is whether the way out is *jammed*, not merely
    // occupied: a vehicle still moving through the first few metres of the exit lane
    // will be gone by the time we get there, and refusing to follow it would
    // serialise every junction to one vehicle at a time.
    //
    // "The way out" has to start with the connector itself. Something stopped on the
    // connector we are about to enter is as final an obstruction as a full exit
    // lane — following it in parks a second body inside the box, and that is exactly
    // how a ring of stationary vehicles forms with every exit lane empty in front of
    // it. Checking only the exit lane let drivers keep entering a junction that
    // already held seven stopped vehicles, at which point the ring was permanent:
    // their bodies covered each other's conflict points, and nothing that can be
    // relaxed afterwards will unwind that.
    //
    // Below `jammedSpeed` is the whole test. A vehicle crossing normally is never
    // that slow for long, so this costs nothing at a junction that is discharging;
    // it only bites on one that has stopped, which is the only time it should.
    // A red you cannot stop for is one you were never offered.
    //
    // Where two junctions sit a few metres apart — which imported data is full of,
    // and which the compiler deliberately produces when it pulls two overlapping
    // footprints apart — the road between them is shorter than a stopping distance.
    // The signal rules first look at the second junction when the driver is already
    // a metre from it doing thirteen metres a second: `mustStop` says yes, they
    // brake at the cap, and they go through on red anyway, into the traffic that
    // has the green. Nothing downstream can fix that, because by then there is no
    // road left. The last stop line anybody actually offered them is this one.
    //
    // Only bites where the road beyond really is too short to stop in, so a normal
    // exit lane never triggers it: a driver at 14 m/s needs fifty metres and a city
    // block gives them a hundred.
    const beyondId = connector.successors[0];
    if (beyondId !== undefined) {
      const beyond = net.lanes[beyondId];
      const nextId = sim.edgeFor(beyondId, store.dest[i]);
      if (nextId >= 0 && net.lanes[nextId].kind === LaneKind.Connector
          && (v * v) / (2 * params.b) > beyond.length - JUNCTION.stopMargin
          && sim.signals.mustStop(nextId, v, beyond.length)) {
        sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
        store.waitTime[i] += sim.dt;
        return;
      }
    }

    let blocker = -1;
    let room = Infinity;
    const queued = store.laneLast[connectorId];
    if (queued >= 0) {
      // Anything sitting on our connector blocks us outright: getting out of the
      // junction means getting off this connector, and it is in the way.
      blocker = queued;
      room = 0;
    } else {
      const exitId = connector.successors[0];
      if (exitId !== undefined) {
        const tail = store.laneLast[exitId];
        if (tail >= 0) {
          blocker = tail;
          room = store.s[tail] - store.len[tail];
        }
      }
    }
    if (blocker >= 0 && store.v[blocker] < JUNCTION.jammedSpeed
        && room < store.len[i] + JUNCTION.exitClearance) {
      // Wait at the stop line, not inside the box. Rolling in and stopping is how
      // one blocked exit lane locks a whole grid.
      sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
      store.waitTime[i] += sim.dt;
    }
  }

  const conflicts = connector.conflicts;
  if (conflicts.length === 0) return;
  const myLen = store.len[i];
  const vSelf = Math.max(v, 0.5);

  for (let c = 0; c < conflicts.length; c++) {
    const conflict = conflicts[c];
    const other = net.lanes[conflict.other];
    const rival = claimant(sim, conflict.other, conflict.sOther);
    if (rival < 0 || rival === i) continue;

    const dOther = distanceToPoint(sim, rival, conflict.other, conflict.sOther);
    if (!Number.isFinite(dOther)) continue;
    const otherLen = store.len[rival];
    const otherV = store.v[rival];
    const dMe = distanceToPoint(sim, i, connectorId, conflict.sSelf);
    if (!Number.isFinite(dMe)) continue;
    // Already at or past this point: braking cannot help, and commanding a stop
    // here is how a junction deadlocks with everybody frozen mid-crossing.
    if (dMe <= 0.1) continue;

    const zone = JUNCTION.conflictZone + otherLen;
    const occupying = dOther <= 0.1 && dOther + zone >= 0;
    if (occupying) {
      // Safety floor: something is in the way, priority is irrelevant.
      sim.constrain(i, idmToStop(v, v0, Math.max(0.1, dMe - JUNCTION.stopMargin), params));
      continue;
    }

    // Whether the *rival* is committed: already on the connector, past the point
    // where it could still decide not to come.
    const committed = store.lane[rival] === conflict.other;

    // A rival held at a red is not coming. This is what makes a protected turn
    // protected: during its phase the movements that cross it are red, so the
    // turner has the junction rather than hunting for a gap in traffic that is
    // about to stop anyway. A rival already on the connector is committed and is
    // still respected — the safety floor above has just cleared it as not in the
    // way, not as not there.
    if (!committed) {
      const rivalLane = net.lanes[store.lane[rival]];
      if (sim.signals.mustStop(conflict.other, otherV, rivalLane.length - store.s[rival])) continue;
    }

    // Will our two bodies be over this point at the same time? Both of us are
    // assumed to arrive at the speed we *could* be doing and to clear at the speed
    // we *are* doing — arrives early, leaves late, for the rival and for us.
    //
    // Our own arrival has to be kinematic for the same reason theirs does, and the
    // consequence of getting it wrong is worse: from a standstill, dividing by a
    // floor of 0.5 m/s says we need forty seconds to reach a point ten metres away,
    // so anything crossing it will "be long gone" and we pull straight out in front
    // of them. That is a driver at a stop line, or one turning against a red,
    // deciding the junction is clear because they are stationary.
    const meArrive = arrivalTime(dMe, v, connector.speedLimit, JUNCTION.arrivalAccel);
    const meClear = (dMe + myLen + JUNCTION.conflictZone) / vSelf;
    const rivalArrive = arrivalTime(dOther, otherV, other.speedLimit, JUNCTION.arrivalAccel);
    const rivalClear = (dOther + otherLen + JUNCTION.conflictZone) / Math.max(otherV, 0.5);
    const shares = meArrive < rivalClear + JUNCTION.clearingMargin && rivalArrive < meClear;

    if (onConnector) {
      // Both of us are already inside the junction and our paths cross. Neither
      // can give way as a matter of priority any more, but one of us can still
      // brake, and the strict total order says which — so exactly one does and a
      // mutual standstill is impossible. Reactive occupancy on its own is not
      // enough here: it only fires once the rival is *at* the point, by which
      // time both bodies are already on it and braking is far too late. That is
      // what "vehicles passing through each other" looks like, and it shows up
      // most with a bus, which needs three times as long to clear the point it is
      // standing on.
      const yieldToRank = committed && shares && other.priorityRank < connector.priorityRank;

      // A rival that has *not* committed is normally somebody else's problem: they
      // can still choose not to come and we cannot. That stops being true when they
      // physically cannot stop short of the point we share — at which moment the
      // only party with a choice left is us, and we still have one because we have
      // not reached the point yet.
      //
      // This is the case the bench found: a left-turner crawling across at 3 m/s
      // with six metres still to go, and a through movement fifty metres out doing
      // 26 m/s, which needs fifty-five to stop. The turner ignored it because it had
      // not entered the junction, drove on into its path, and the two met in the
      // middle. Braking here is a safety floor rather than a yield — it costs a
      // driver part-way across a few seconds — and it cannot freeze anybody
      // mid-junction, because a vehicle at or past the point returned long ago.
      //
      // It deliberately stops there. Extending it to *committed* rivals looks like
      // the obvious completion — a lower-ranked driver braking at the emergency cap
      // and unable to stop inside it is read as yielding while the driver with
      // priority accelerates into the space — and it does remove those collisions.
      // But saturated, nearly every committed driver is near its point at speed, so
      // all of them end up braking for each other: `test/sim/approach.test.ts` at
      // 1.3x capacity went from discharging 12 vehicles in its final minute to 8.
      // The junction shape that needed it is a fast road crossed at grade under
      // priority, and that is fixed where it belongs — the compiler no longer
      // builds one (see `PRIORITY_MAX_SPEED`).
      const rivalCannotStop = shares && !committed
        && (otherV * otherV) / (2 * IDM.bMax) > Math.max(0, dOther - JUNCTION.stopMargin);

      if (yieldToRank || rivalCannotStop) {
        sim.constrain(i, idmToStop(v, v0, Math.max(0.1, dMe - JUNCTION.stopMargin), params));
      }
      continue;
    }

    // Do not enter a junction you might not get out of. A rival already inside it
    // and barely moving has not cleared the point we share, and driving in anyway
    // parks us against a vehicle that cannot give way — which is how a saturated
    // crossing gridlocks for good: each connector's leader is held at a conflict
    // point by the next, round a cycle of three or four arms, with every exit lane
    // completely empty in front of them. Bodies overlap the conflict points at that
    // stage, so no relaxation can unwind it; the only cure is not to start. Wait at
    // the stop line instead, where waiting costs nothing but our own time.
    if (committed && otherV < JUNCTION.jammedSpeed && dOther > -zone) {
      sim.constrain(i, idmToStop(v, v0, Math.max(0.1, toEntry - JUNCTION.stopMargin * 0.5), params));
      store.waitTime[i] += sim.dt;
      continue;
    }

    if (allWayStop) {
      // First to the line goes; ties break on the stable vehicle serial.
      const mine = store.stopArrival[i];
      const theirs = store.stopArrival[rival];
      const yieldToThem = theirs >= 0 &&
        (theirs < mine - 1e-6 || (Math.abs(theirs - mine) <= 1e-6 && store.serial[rival] < store.serial[i]));
      if (!yieldToThem) continue;
    } else if (onRed) {
      // Turning against a red gives way to everything, whatever the pecking order
      // among the movements says — the pecking order is for deciding a green.
    } else if (!committed && other.priorityRank >= connector.priorityRank) {
      continue; // we have priority
    }
    // Priority means nothing against a vehicle that is already in the junction: it
    // cannot give way any more, whatever the pecking order says. Skipping the gap
    // test on rank is how a driver with right of way ends up parked against the
    // side of somebody who was committed before they arrived.
    // A vehicle stopped short of the point is waiting, not coming — unless this is
    // an all-way stop, where waiting at the line is exactly how you take your turn,
    // or unless it is stopped *inside the junction*, where it is not waiting for
    // anything it can give up on. Reading a rival held on a connector as "not
    // coming" is how a saturated crossing deadlocks: the opposing queue stalls, a
    // turner reads the stall as an invitation and enters the box, the two block
    // each other, the next driver reads *their* stall the same way, and within a
    // couple of cycles thirty vehicles are frozen mid-junction with the exits
    // completely empty in front of them.
    if (!allWayStop && !committed && otherV < JUNCTION.stoppedSpeed && dOther > 0.5) continue;

    // The same overlap test the safety floor uses, with the driver's own critical
    // gap on top: entering is a choice, so it is made with a margin.
    if (onRed) {
      // Turning against a red is not an ordinary yield, and the difference is the
      // whole permission: it is allowed *only where it does not impede*. So rather
      // than asking whether our occupancies would overlap — which lets a driver
      // slot in ahead of traffic that then has to lift off — it asks the one-sided
      // question. Will I be completely past this point, at the speed I can actually
      // reach from here, well before they arrive? If not, wait. Anything less and a
      // right-turner pulls out in front of a green movement and meters it, which is
      // exactly what the rule exists to prevent.
      const clear = arrivalTime(
        dMe + myLen + JUNCTION.conflictZone, v, connector.speedLimit, JUNCTION.arrivalAccel,
      );
      if (rivalArrive < clear + JUNCTION.turnOnRedGap) {
        sim.constrain(i, idmToStop(v, v0, Math.max(0.1, dMe - JUNCTION.stopMargin), params));
        store.waitTime[i] += sim.dt;
      }
      continue;
    }

    const gap = store.critGap[i] * 0.5;
    if (meArrive < rivalClear + JUNCTION.clearingMargin + gap && rivalArrive < meClear + gap) {
      sim.constrain(i, idmToStop(v, v0, Math.max(0.1, dMe - JUNCTION.stopMargin), params));
      store.waitTime[i] += sim.dt;
    }
  }
}
