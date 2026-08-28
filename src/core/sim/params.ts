/**
 * Simulation constants.
 *
 * Everything tunable lives here so behaviour changes are one diff and the
 * scenario tests have a single place to read the numbers they assert against.
 */

/** Fixed simulation timestep. Never varies — determinism depends on it. */
export const DT = 0.05;

// --- car following (IDM) --------------------------------------------------------
export const IDM = {
  /** Standstill gap, metres. */
  s0: 2.0,
  /** Desired time headway, seconds. */
  T: 1.4,
  /** Comfortable acceleration, m/s^2. */
  aMax: 1.4,
  /** Comfortable deceleration, m/s^2. */
  b: 2.0,
  /** Emergency deceleration cap. Only ever used to avoid a collision. */
  bMax: 6.0,
  /** Free-flow exponent. */
  delta: 4,
};

/** Per-driver variation, applied multiplicatively from a seeded stream. */
export const DRIVER_SPREAD = {
  desiredSpeed: 0.10,
  headway: 0.10,
  politeness: 0.35,
  acceleration: 0.12,
  /** Fraction of drivers who will open a gap for a merger. */
  courtesyBase: 0.70,
  /** Critical gap for junction entry, seconds. */
  criticalGap: 4.5,
  criticalGapSpread: 0.22,
};

// --- lane changing (MOBIL) ------------------------------------------------------
export const MOBIL = {
  politeness: 0.3,
  /** Advantage threshold before a discretionary change is worth it, m/s^2. */
  threshold: 0.15,
  /** Hard collision floor on the deceleration a change may impose on anyone. */
  bSafe: 4.0,
  /**
   * Comfort ceiling on induced braking. A driver choosing to change lanes will not
   * make the car behind brake harder than this, which is what keeps a merge from
   * showing up as a shockwave in the mainline.
   */
  bCourteous: 3.0,
  /** Seconds before a vehicle may change lanes again. */
  cooldown: 3.0,
  /**
   * How often a driver reconsiders a *discretionary* lane change. Drivers do not
   * re-evaluate twenty times a second, and pretending they do costs roughly half
   * the tick budget for no behavioural gain. Mandatory changes are still checked
   * every tick, because those are the time-critical ones.
   */
  evaluate: 0.4,
  /** Bias toward the kerb side, m/s^2 (keep-right rule). */
  keepRightBias: 0.12,
  /** Seconds a lateral movement takes, for rendering only. */
  lateralTime: 2.2,
  /**
   * How far ahead a driver reads the speed of each lane. Without this, nobody
   * moves out of a lane until they are already in its queue, and traffic piles
   * into one lane while the next runs empty.
   */
  lookAhead: 260,
  /** Incentive per m/s of downstream speed advantage, m/s^2. */
  laneSpeedGain: 0.07,
  /** Cap on that incentive, m/s^2. */
  laneSpeedCap: 1.6,
  /**
   * What it costs to drift off the route, per lane change it would owe, m/s^2.
   *
   * `advise` answers "which way from here", and its answer for a lane already on
   * the route is "nowhere" — so a discretionary change *out* of that lane used to
   * pay nothing, and the mandatory rules pulled the driver straight back on the
   * next tick. On a network with more than one segment that pair was nine out of
   * ten lane changes, and roughly half of them completed and reversed inside a
   * single second.
   */
  offRoutePenalty: 3.0,
  /**
   * Metres of road that halve it, near enough. Drifting left with a kilometre in
   * hand is nearly free and is how a driver overtakes; doing it a hundred metres
   * from the gore is how a driver misses their exit.
   */
  offRouteRelief: 300,
};

// --- merging --------------------------------------------------------------------
export const MERGE = {
  /** Distance over which urgency ramps from 0 to 1 as the lane end approaches. */
  urgencyRange: 250,
  /** Gap re-evaluation period, seconds. */
  reevaluate: 0.5,
  /** How far ahead a vehicle starts looking for its merge, metres. */
  horizon: 380,
  /** The soft wall at a lane end only bites inside this multiple of stopping distance. */
  wallEngage: 1.5,
  /**
   * How far off the target lane's speed a driver will slot in at zero urgency.
   * Below this they keep accelerating instead — which is the whole point of an
   * acceleration lane, and it is what keeps mainline traffic from being disturbed.
   */
  speedMatchTolerance: 3.0,
  /** Extra tolerance granted at full urgency, m/s. */
  speedMatchRelief: 8,
  /**
   * Merging drivers accelerate harder than their comfortable cruise would suggest.
   * Without this, IDM's free term decays so gently that matching mainline speed
   * eats most of the acceleration lane.
   */
  speedBoost: 1.22,
  /** Distance from the lane end where creeping into any opening is allowed. */
  creepZone: 18,
  /**
   * How close to the deadline counts as *stranded* — out of road as well as speed.
   *
   * Wider than the creep zone, because the question this answers is not "may I
   * nose in" but "can I still drive to a gap, or must I wait for one to reach me",
   * and the answer to that stops being yes well before the last few metres.
   */
  strandedZone: 40,
  /** Creep speed cap, m/s. */
  creepSpeed: 2.0,
  /**
   * Hardest braking a creeping merger may impose on the traffic it slots in front
   * of. Lower than the collision floor on purpose: nosing in from walking pace in
   * front of fast traffic is legal but antisocial, and it shows up as a shockwave.
   */
  creepBrake: 2.6,
  /** Above this urgency the chosen lag vehicle must yield. */
  mandatoryCourtesy: 0.85,
  /**
   * A taper switches to enforced alternation when traffic there drops below this
   * fraction of the free speed (capped in absolute terms). Measured upstream of the
   * merge only: traffic that has already got through says nothing about the queue.
   */
  zipperSpeedFraction: 0.35,
  zipperSpeedMax: 8.0,
  /** Distance either side of a taper considered when measuring congestion. */
  zipperWindow: 150,
  /** Extra MOBIL incentive to vacate a lane an on-ramp feeds into, m/s^2. */
  keepClearBias: 1.0,
  /** Mergers needed before keep-clear reaches full strength. */
  keepClearSaturation: 2,
  /**
   * Keep-clear only applies to traffic still moving reasonably freely. Shuffling
   * lanes inside a queue does not help anyone and costs discharge rate.
   */
  keepClearMinSpeedFraction: 0.55,
  /** How far upstream of a gore keep-clear applies, metres. */
  keepClearRange: 380,
  /**
   * Seconds a driver will go on being refused a mandatory change before they stop
   * asking politely.
   *
   * Past this they take whatever hole is there, which is what a real driver does
   * when everybody is trying to feed into one lane and none of it is moving. It is
   * not the same as being *stopped*: in a jam the queue shuffles forward the whole
   * time, so a clock that waits for a standstill never starts.
   */
  patience: 14,

  /**
   * And past *this*, a driver whose lane does not physically end gives up on the
   * change altogether and carries on — missing their turn-off rather than sitting
   * in a live lane holding up the road behind them. A lane that runs out of tarmac
   * has no such option, which is why the two are separate.
   */
  giveUpOnRoute: 34,
  /** Seconds stopped at a lane end before the safety fallback forces a change. */
  stuckTimeout: 12,
  /**
   * Metres past the deadline before the exit counts as missed.
   *
   * Not zero: merge planning runs before lane changes within a tick, so a driver
   * sitting exactly on the line is one who is about to make it, not one who has
   * failed. Rerouting them there writes off drivers who were fine.
   */
  missedBy: 6,
  /** Seconds crawling with an empty road ahead before gap alignment is abandoned. */
  alignGiveUp: 8,
  /** Score bonus for keeping the gap chosen last time, so cooperation can build. */
  gapHysteresis: 0.5,
  /**
   * Speed below which a vehicle counts as making no progress, m/s.
   *
   * Above every floor the merge model applies — gap alignment's 0.8 and creeping's
   * 2.0 — because those floors are exactly what a deadlocked driver ends up doing.
   */
  crawlSpeed: 2.4,
  /** Slowest speed gap alignment will ask for, m/s. */
  alignFloor: 0.8,
  /** Candidate gaps examined either side of the aligned position. */
  candidates: 3,
  /**
   * Seconds a follower spends still closing before its braking takes effect, used
   * by the collision floor.
   *
   * The floor asks whether the follower can physically stop in the gap, and it used
   * to assume the braking started the instant the change did. Nobody brakes in zero
   * time — least of all a driver who is still accelerating — so a change accepted
   * at exactly the kinematic limit consumed a couple of metres it had not budgeted
   * for, and at a high closing speed that is the difference between a tight merge
   * and a shunt.
   */
  insertReaction: 0.45,
  /** Hardest a courteous driver will brake to open a gap, m/s^2. */
  courtesyDecel: 1.3,
  /** Hardest a driver must brake once yielding has become mandatory, m/s^2. */
  courtesyDecelMandatory: 2.5,
  /** Headway multiplier used when holding back for a merger. */
  courtesyHeadway: 0.7,
};

// --- junctions ------------------------------------------------------------------
export const JUNCTION = {
  /** How far before a junction vehicles start negotiating, metres. */
  approach: 90,
  /**
   * Slack on the speed-derived approach distance, so the decision is taken while
   * stopping is still comfortable rather than exactly at the limit of it.
   */
  approachMargin: 1.4,
  /** Extra clearance around a conflict point, metres. */
  conflictZone: 3.0,
  /** Safety margin added to the other vehicle's clearing time, seconds. */
  clearingMargin: 0.6,
  /** Stop line offset back from a conflict point, metres. */
  stopMargin: 1.5,
  /** Minimum space that must exist beyond a junction before entering it. */
  exitClearance: 1.5,
  /** Speed under which a yielding vehicle counts as stopped. */
  stoppedSpeed: 0.4,
  /** Speed under which traffic on the far side of a junction counts as jammed. */
  jammedSpeed: 2.5,
  /**
   * Acceleration a rival is assumed to be capable of when predicting when it will
   * arrive at a shared point, m/s^2.
   *
   * Extrapolating a rival at the speed it happens to have is the one prediction
   * guaranteed to be wrong in stop-and-go traffic: a vehicle crawling into a
   * junction at 1 m/s is accelerating, and by the time it reaches the point it
   * shares with you it is doing five. Predicting from the crawl says it is fifteen
   * seconds away, you take the gap, and it arrives in four. Clearing is still
   * predicted from the speed it actually has, because a slow vehicle really does
   * take a long time to get out of the way — the envelope is deliberately
   * asymmetric: arrives early, leaves late. Bounding the prediction by the road's
   * own speed limit is what keeps it from being conservative in the other
   * direction and refusing gaps against traffic a hundred metres away.
   */
  arrivalAccel: 1.5,
  /**
   * Extra seconds of clearance a driver turning against a red must find, on top of
   * their own critical gap.
   *
   * Turning on red is permitted only where it does not impede — that is the rule,
   * not an implementation detail. A driver pulling away from a standstill crosses
   * slowly, and once they are inside the junction the traffic with a green has to
   * yield to them, because a vehicle already in the box cannot give way any more.
   * So an ordinary gap is not enough: accepting one costs the green movement more
   * than the turn is worth, and it showed up as a tenth of the green crossings
   * disappearing.
   */
  turnOnRedGap: 3.5,
  /**
   * Clear road a driver turning against a red must see beyond the junction, on top
   * of their own length, metres.
   *
   * Getting in is only half the permission. A driver who takes the turn and then
   * stops halfway across, because the road they turned into is full, is parked
   * across a movement that has a green — and by then they are committed and cannot
   * give way. The ordinary don't-block-the-box test is deliberately loose (it asks
   * whether the far side is *jammed*, not merely occupied) because serialising
   * every junction to one vehicle at a time is worse; a turn on red has no such
   * excuse, because waiting costs nobody anything but the driver's own time.
   */
  turnOnRedExitRoom: 14,
};

// --- signals --------------------------------------------------------------------
export const SIGNAL = {
  /** Amber is run through when stopping would need more than this deceleration. */
  amberDecel: 3.0,
  /**
   * Shortest green an actuated phase may show, whatever the detectors say.
   *
   * Without a floor a phase that gaps out on the tick it turns green shows a green
   * nobody can react to, and the junction spends its whole cycle in amber and
   * all-red. This is also what stops one straggler getting a full green to itself
   * and then the next one getting another.
   */
  minGreen: 7,
  /**
   * How far back from the stop line an actuated phase looks for someone to serve.
   *
   * A real loop detector sits a few car lengths back; the number matters because it
   * decides what "still arriving" means. Too short and a platoon gets cut in half;
   * too long and the phase never gaps out on a busy road, which is the same as not
   * being actuated at all.
   */
  detector: 45,
};

/**
 * Why a vehicle is not going as fast as it would like. Ordered loosely from "the
 * road" to "the merge model", which is what most measurements want to separate.
 */
export const Hold = {
  Free: 0,
  /** Following whatever is in front, across lane boundaries. */
  Leader: 1,
  /** A slower speed limit on the lane being entered. */
  SpeedLimit: 2,
  /** The virtual obstacle at the end of a lane that runs out. */
  SoftWall: 3,
  /** Regulating speed against a chosen gap in the target lane. */
  GapFollow: 4,
  /** Opening up to let a merger in. */
  Cooperate: 5,
  /** A signal, a stop line, or a conflict inside a junction. */
  Junction: 6,
} as const;
export type Hold = (typeof Hold)[keyof typeof Hold];

/** The holds that mean "the merge model is what is stopping you". */
export const MERGE_HOLDS: readonly Hold[] = [Hold.SoftWall, Hold.GapFollow, Hold.Cooperate];

// --- vehicles -------------------------------------------------------------------
export interface VehicleClass {
  name: string;
  length: number;
  width: number;
  /** Multiplier on the profile speed limit. */
  speedFactor: number;
  aMax: number;
  b: number;
  /** Relative share of spawns. */
  share: number;
}

export const VEHICLE_CLASSES: VehicleClass[] = [
  { name: 'car', length: 4.6, width: 1.8, speedFactor: 1.0, aMax: 1.4, b: 2.0, share: 0.78 },
  { name: 'van', length: 5.6, width: 2.0, speedFactor: 0.97, aMax: 1.15, b: 1.9, share: 0.13 },
  { name: 'truck', length: 12.5, width: 2.5, speedFactor: 0.86, aMax: 0.75, b: 1.5, share: 0.07 },
  { name: 'bus', length: 11.0, width: 2.55, speedFactor: 0.9, aMax: 0.9, b: 1.6, share: 0.02 },
];

export const SIM_LIMITS = {
  /** Vehicles the store is sized for. */
  maxVehicles: 8000,
  /** Vehicles are removed if they somehow leave the graph. */
  maxLifetime: 3600,
};
