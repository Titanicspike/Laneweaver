import { compile } from '@core/network/compiler';
import { kph } from '@core/network/model';
import type { EditModel, Network, RoadProfile } from '@core/network/types';
import { addProfile, addStroke, doc, line, pts } from './build';

export interface ScenarioNet {
  model: EditModel;
  net: Network;
  /** Portal ids, resolved by position. */
  mainEntry: number;
  mainExit: number;
  rampEntry: number;
  rampExit: number;
  /** The auxiliary (accel/decel) lane, when the scenario has one. */
  auxLane: number;
  goreX: number;
}

const RAMP_SPEC = { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 };

export function findPortal(net: Network, x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const p of net.portals) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

function freewayProfile(model: EditModel, lanes: number, name: string): RoadProfile {
  return addProfile(model, {
    name,
    lanesForward: lanes,
    lanesBackward: 0,
    laneWidth: 3.65,
    shoulder: 2.5,
    speedLimit: kph(110),
    rampSpec: { ...RAMP_SPEC },
  });
}

function rampProfile(model: EditModel): RoadProfile {
  return addProfile(model, {
    name: 'Ramp',
    lanesForward: 1,
    lanesBackward: 0,
    laneWidth: 4,
    shoulder: 1.2,
    speedLimit: kph(85),
    isRamp: true,
    rampSpec: { ...RAMP_SPEC },
  });
}

export interface OnRampOptions {
  mainLanes?: number;
  length?: number;
  goreX?: number;
  /** Vehicles per hour on the mainline and on the ramp. */
  mainFlow?: number;
  rampFlow?: number;
}

/** Straight freeway with a single on-ramp joining from the kerb side. */
export function onRampScenario(options: OnRampOptions = {}): ScenarioNet {
  const mainLanes = options.mainLanes ?? 2;
  const length = options.length ?? 3000;
  const goreX = options.goreX ?? 1000;
  const model = doc();
  const freeway = freewayProfile(model, mainLanes, `Freeway ${mainLanes}`);
  const ramp = rampProfile(model);
  addStroke(model, freeway, line(0, 0, length, 0));
  addStroke(model, ramp, pts(goreX - 400, 110, goreX + 30, 0));
  const net = compile(model);

  const mainEntry = findPortal(net, 0, 0);
  const mainExit = findPortal(net, length, 0);
  const rampEntry = findPortal(net, goreX - 400, 110);
  const aux = net.lanes.find((l) => l.aux);
  model.demand = [
    { fromPortal: mainEntry, toPortal: mainExit, rate: options.mainFlow ?? 1800 },
    { fromPortal: rampEntry, toPortal: mainExit, rate: options.rampFlow ?? 500 },
  ];
  return {
    model, net, mainEntry, mainExit, rampEntry, rampExit: -1,
    auxLane: aux ? aux.id : -1, goreX,
  };
}

export interface OffRampOptions {
  mainLanes?: number;
  length?: number;
  goreX?: number;
  mainFlow?: number;
  exitFlow?: number;
}

/** Straight freeway with a single off-ramp leaving from the kerb side. */
export function offRampScenario(options: OffRampOptions = {}): ScenarioNet {
  const mainLanes = options.mainLanes ?? 3;
  const length = options.length ?? 3000;
  const goreX = options.goreX ?? 1800;
  const model = doc();
  const freeway = freewayProfile(model, mainLanes, `Freeway ${mainLanes}`);
  const ramp = rampProfile(model);
  addStroke(model, freeway, line(0, 0, length, 0));
  addStroke(model, ramp, pts(goreX - 30, 0, goreX + 400, 110));
  const net = compile(model);

  const mainEntry = findPortal(net, 0, 0);
  const mainExit = findPortal(net, length, 0);
  const rampExit = findPortal(net, goreX + 400, 110);
  const aux = net.lanes.find((l) => l.aux);
  model.demand = [
    { fromPortal: mainEntry, toPortal: mainExit, rate: options.mainFlow ?? 2400 },
    { fromPortal: mainEntry, toPortal: rampExit, rate: options.exitFlow ?? 900 },
  ];
  return {
    model, net, mainEntry, mainExit, rampEntry: -1, rampExit,
    auxLane: aux ? aux.id : -1, goreX,
  };
}

export interface LaneDropOptions {
  fromLanes?: number;
  toLanes?: number;
  dropX?: number;
  length?: number;
  flow?: number;
}

/** Freeway that loses a lane at a link junction. */
export function laneDropScenario(options: LaneDropOptions = {}): ScenarioNet {
  const fromLanes = options.fromLanes ?? 3;
  const toLanes = options.toLanes ?? 2;
  const dropX = options.dropX ?? 1500;
  const length = options.length ?? 3000;
  const model = doc();
  const wide = freewayProfile(model, fromLanes, `Freeway ${fromLanes}`);
  const narrow = freewayProfile(model, toLanes, `Freeway ${toLanes}`);
  addStroke(model, wide, line(0, 0, dropX, 0));
  addStroke(model, narrow, line(dropX, 0, length, 0));
  const net = compile(model);

  const mainEntry = findPortal(net, 0, 0);
  const mainExit = findPortal(net, length, 0);
  const dropped = net.lanes.find((l) => l.endsAt < Infinity && l.mergeTarget >= 0);
  model.demand = [{ fromPortal: mainEntry, toPortal: mainExit, rate: options.flow ?? 4200 }];
  return {
    model, net, mainEntry, mainExit, rampEntry: -1, rampExit: -1,
    auxLane: dropped ? dropped.id : -1, goreX: dropX,
  };
}

/**
 * The same freeway with no ramp at all, carrying the same total demand. Used as
 * the control for "how much capacity did the merge cost?", which is a far more
 * honest yardstick than any absolute vehicles-per-hour number.
 */
export function plainFreewayScenario(lanes: number, flow: number, length = 3000): ScenarioNet {
  const model = doc();
  const freeway = freewayProfile(model, lanes, `Freeway ${lanes}`);
  addStroke(model, freeway, line(0, 0, length, 0));
  const net = compile(model);
  const mainEntry = findPortal(net, 0, 0);
  const mainExit = findPortal(net, length, 0);
  model.demand = [{ fromPortal: mainEntry, toPortal: mainExit, rate: flow }];
  return { model, net, mainEntry, mainExit, rampEntry: -1, rampExit: -1, auxLane: -1, goreX: 0 };
}

/** On-ramp closely followed by an off-ramp: the weaving acid test. */
export function weaveScenario(options: { mainFlow?: number; rampFlow?: number; exitFlow?: number } = {}): ScenarioNet {
  const model = doc();
  const freeway = freewayProfile(model, 2, 'Freeway 2');
  const ramp = rampProfile(model);
  addStroke(model, freeway, line(0, 0, 3000, 0));
  addStroke(model, ramp, pts(600, 110, 1030, 0));
  addStroke(model, ramp, pts(1420, 0, 1850, 110));
  const net = compile(model);

  const mainEntry = findPortal(net, 0, 0);
  const mainExit = findPortal(net, 3000, 0);
  const rampEntry = findPortal(net, 600, 110);
  const rampExit = findPortal(net, 1850, 110);
  const aux = net.lanes.find((l) => l.aux);
  model.demand = [
    { fromPortal: mainEntry, toPortal: mainExit, rate: options.mainFlow ?? 2200 },
    { fromPortal: rampEntry, toPortal: mainExit, rate: options.rampFlow ?? 700 },
    { fromPortal: mainEntry, toPortal: rampExit, rate: options.exitFlow ?? 700 },
  ];
  return {
    model, net, mainEntry, mainExit, rampEntry, rampExit,
    auxLane: aux ? aux.id : -1, goreX: 1030,
  };
}
