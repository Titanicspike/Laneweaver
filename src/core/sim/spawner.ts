/**
 * Traffic generation.
 *
 * Each ordered portal pair is an independent Poisson process drawing from the
 * shared seeded stream. When a spawn cannot fit (the entry lane is backed up) it is
 * held rather than dropped, so demand that exceeds capacity queues at the portal
 * instead of quietly vanishing — which is what you want when measuring throughput.
 */

import { expUnit, type Rng } from '../util/rng';
import type { DemandEntry, Network, Portal, SpawnMode, Zone } from '../network/types';
import { VEHICLE_CLASSES } from './params';

export interface DemandPair {
  from: number;
  to: number;
  /** Vehicles per second, before the time of day scales it. */
  rate: number;
  /**
   * Poisson *quota* remaining before the next departure, in vehicles.
   *
   * Not a countdown in seconds. Under a clock the rate changes continuously, and a
   * duration drawn from the rate that happened to apply when the last vehicle left
   * is wrong the moment that rate moves: an interval drawn at three in the morning
   * is minutes long and swallows the whole of the dawn ramp before it next looks.
   * Measured on the arterial over a simulated day, that lost 58% of all demand and
   * moved what survived hours late — the busiest hour of the day came out as 20:00,
   * at half the peak flow. Spending a quota at the current rate instead is exact.
   */
  timer: number;
  /** Spawns that could not fit yet. */
  queued: number;
  /**
   * Which way round this trip runs, for the land-use mode.
   *
   * `out` is house to shop and `back` is shop to house; the clock decides how much
   * of each hour is which. `any` is every other pair, which the clock only scales.
   */
  when: 'any' | 'out' | 'back';
}

/**
 * Default flow per entry lane, in vehicles per hour, derived from the lane's speed
 * limit. It scales with the square of speed because that is roughly how the road
 * hierarchy works: a 40 km/h street carries a trickle, a 110 km/h freeway carries a
 * flood, and a single flat number would either drown the side streets or leave the
 * freeway empty. Only a default — explicit origin-destination demand overrides it.
 */
export const FLOW_SPEED_EXPONENT = 1.0;
export const MIN_LANE_FLOW = 60;
export const MAX_LANE_FLOW = 1100;

export function defaultLaneFlow(speedLimit: number): number {
  return Math.max(MIN_LANE_FLOW, Math.min(MAX_LANE_FLOW, speedLimit * speedLimit * FLOW_SPEED_EXPONENT));
}

function laneFlow(net: Network, laneIds: ReadonlyArray<number>): number {
  let total = 0;
  for (const id of laneIds) total += defaultLaneFlow(net.lanes[id].speedLimit);
  return total;
}

/**
 * Vehicles per hour a zone generates, from how much frontage it has.
 *
 * A metre of residential street is roughly a metre of houses, so the flow scales
 * with total lane length. `ZONE_FLOW_PER_KM` is per kilometre of *lane*, which on a
 * two-way street is half a kilometre of road — the units are lane-metres because
 * that is what the compiler gives us and what the spawner walks.
 */
export const ZONE_FLOW_PER_KM = 260;

/**
 * Distance at which a shop street's pull has halved, in metres.
 *
 * Two kilometres keeps the next block favoured over the far side of town without
 * making the far side unreachable: at four kilometres a street still draws a fifth
 * of what it would next door, which across a whole town's worth of streets is a
 * steady stream of trips long enough to want the freeway.
 */
const TRIP_DISTANCE_SCALE = 2000;

function zoneFlow(zone: Zone): number {
  return (zone.frontage / 1000) * ZONE_FLOW_PER_KM;
}

/** Portals that may originate traffic in this mode, and those that may receive it. */
function gateways(net: Network, mode: SpawnMode): { origins: Portal[]; exits: Portal[] } {
  if (mode !== 'gateways') {
    return {
      origins: net.portals.filter((p) => p.entryLanes.length > 0),
      exits: net.portals.filter((p) => p.exitLanes.length > 0),
    };
  }
  // Marked ends only, and only in the direction they were marked. An unmarked end
  // is `both`, so a document nobody has marked behaves exactly like `portals` —
  // which is what makes switching to this mode a starting point rather than a
  // cliff.
  return {
    origins: net.portals.filter((p) => p.entryLanes.length > 0 && (p.role === 'both' || p.role === 'entry')),
    exits: net.portals.filter((p) => p.exitLanes.length > 0 && (p.role === 'both' || p.role === 'exit')),
  };
}

export function buildDemand(
  net: Network,
  explicit: ReadonlyArray<DemandEntry>,
  scale: number,
  reachable: (from: number, to: number) => boolean,
  mode: SpawnMode = 'portals',
): DemandPair[] {
  const pairs: DemandPair[] = [];
  const add = (from: number, to: number, vph: number, when: DemandPair['when'] = 'any'): void => {
    if (vph <= 0 || from === to || !reachable(from, to)) return;
    pairs.push({ from, to, rate: (vph * scale) / 3600, timer: 0, queued: 0, when });
  };

  if (explicit.length) {
    for (const entry of explicit) {
      const from = net.portals[entry.fromPortal];
      const to = net.portals[entry.toPortal];
      if (!from || !to || from === to) continue;
      if (!from.entryLanes.length || !to.exitLanes.length) continue;
      add(from.id, to.id, entry.rate);
    }
    pairs.sort((a, b) => a.from - b.from || a.to - b.to);
    return pairs;
  }

  const residential = net.zones.filter((z) => z.landUse === 'residential');
  const commercial = net.zones.filter((z) => z.landUse === 'commercial');
  const townTrips = (mode === 'landuse' || mode === 'mixed') && residential.length > 0 && commercial.length > 0;
  if (townTrips) {
    // Nobody enters from off-map: the traffic is the town's own. Both directions are
    // built, and the clock decides how much of each hour is which — in the morning
    // almost everybody is going *to* the shops and in the evening almost everybody
    // is coming back. Without both, the morning peak and the evening peak are the
    // same picture twice, which is exactly what a rush hour is not.
    for (const home of residential) {
      // Where this street's trips go: every shop street, weighted by how much of it
      // there is and by how far away it is. A gravity model — nearer shops get more,
      // but a street across town gets some — because a town whose every trip ends
      // at the nearest shop has no reason to own a freeway. Measured on a real
      // network before this: median trip 400 m, twelve shop streets out of
      // eighty-three receiving anyone, and nothing on the freeway at all.
      const weight = (shop: Zone): number => {
        const d = Math.hypot(shop.x - home.x, shop.y - home.y) / TRIP_DISTANCE_SCALE;
        return shop.frontage / (1 + d * d);
      };
      const total = commercial.reduce((acc, z) => acc + weight(z), 0) || 1;
      // Half each way. The clock then hands almost all of it to one direction in the
      // morning and to the other in the evening, so a day's total is the same flow
      // the one-way version generated — just not at the same time or in the same
      // direction.
      const half = zoneFlow(home) / 2;
      for (const shop of commercial) {
        const share = weight(shop) / total;
        add(home.id, shop.id, half * share, 'out');
        add(shop.id, home.id, half * share, 'back');
      }
    }
    if (mode === 'landuse') {
      pairs.sort((a, b) => a.from - b.from || a.to - b.to);
      return pairs;
    }
  }

  {
    // Through traffic: every road end, weighted by road size, as in `portals`. In
    // the mixed mode it rides alongside the town's own trips.
    const { origins, exits } = gateways(net, mode === 'mixed' ? 'portals' : mode);
    for (const from of origins) {
      const destinations = exits.filter((to) => to.id !== from.id && reachable(from.id, to.id));
      if (!destinations.length) continue;
      const totalWeight = destinations.reduce((acc, d) => acc + d.weight, 0) || 1;
      const originFlow = laneFlow(net, from.entryLanes) * from.weight;
      for (const to of destinations) add(from.id, to.id, (originFlow * to.weight) / totalWeight);
    }
  }
  pairs.sort((a, b) => a.from - b.from || a.to - b.to);
  return pairs;
}

/**
 * Draws each pair's first arrival.
 *
 * `rateOf` rather than `pair.rate`, because the clock may make the opening hour a
 * fraction of the base rate — and priming from the base rate empties a whole hour's
 * worth of traffic into the first few minutes of a run that starts at three in the
 * morning. The busiest hour of the day then appears to be whichever one the
 * simulation happened to begin at.
 */
export function primeTimers(pairs: DemandPair[], rng: Rng): void {
  for (const pair of pairs) pair.timer = expUnit(rng);
}

/** Picks a vehicle class by share. */
export function pickClass(rng: Rng): number {
  const r = rng.next();
  let acc = 0;
  for (let i = 0; i < VEHICLE_CLASSES.length; i++) {
    acc += VEHICLE_CLASSES[i].share;
    if (r < acc) return i;
  }
  return 0;
}
