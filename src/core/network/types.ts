/**
 * Network types: the persisted edit model, and the compiled network derived from it.
 *
 * Only the edit model is ever saved. Everything under "compiled network" is
 * rebuildable from it by `compile()` and must never be persisted.
 */

import type { Id } from '../util/ids';
import type { Bbox } from '../geom/polyline';

// ============================================================================
// Edit model (persisted)
// ============================================================================

/** A bezier control point with absolute handle positions. */
export interface ControlPoint {
  x: number;
  y: number;
  /** Incoming handle (controls the curve arriving at this point). */
  hix: number;
  hiy: number;
  /** Outgoing handle (controls the curve leaving this point). */
  hox: number;
  hoy: number;
  /**
   * Height level here: -1 tunnel, 0 ground, +1 bridge. The road ramps between
   * consecutive points, which is what lets one stroke rise, cross over something and
   * come back down. The compiler splits it into segments where the level changes.
   */
  grade: Grade;
}

export interface RampSpec {
  /** Length of the acceleration lane downstream of an on-ramp gore. */
  accelLaneLength: number;
  /** Length of the deceleration lane upstream of an off-ramp gore. */
  decelLaneLength: number;
  /** Length over which an auxiliary lane tapers away. */
  taperLength: number;
}

export const DEFAULT_RAMP_SPEC: RampSpec = {
  accelLaneLength: 220,
  decelLaneLength: 160,
  taperLength: 75,
};

export interface RoadProfile {
  id: Id;
  name: string;
  /** Lanes travelling along the stroke direction. */
  lanesForward: number;
  /** Lanes travelling against it. 0 makes the road one-way. */
  lanesBackward: number;
  laneWidth: number;
  /** Free-flow speed, m/s. */
  speedLimit: number;
  /** Median width in metres; 0 = painted centre line only. */
  median: number;
  /** Paved shoulder either side; cosmetic, widens the asphalt. */
  shoulder: number;
  /** Marks the profile as ramp geometry, which changes junction classification. */
  isRamp: boolean;
  rampSpec?: RampSpec;
  /** Asphalt tint override for the renderer. */
  color?: string;
  /**
   * Metres of planted verge either side. Purely decorative — the compiler never
   * sees it — but a residential street reads completely differently with it.
   */
  verge?: number;
  /**
   * What is beside this road, which is where its traffic comes from and goes to.
   *
   * Only meaningful in the land-use spawn mode, where trips start on a residential
   * street rather than at the edge of the map — a driver pulling off a driveway —
   * and finish where there is something to arrive at. It is a property of the
   * *profile* rather than of the stroke on purpose: "residential street" is already
   * a road type, and making it a second thing to set per road would mean drawing a
   * town twice.
   */
  landUse?: LandUse;
}

/** What sits beside a road, for traffic generation and for what gets drawn there. */
export type LandUse = 'residential' | 'commercial';

import type { Frontage } from './frontage';

/**
 * What one road is zoned as, overriding whatever its road type says.
 *
 * `undefined` inherits from the profile, which is what makes "residential street" a
 * road type you can just draw with. `'none'` is the third state and it has to exist:
 * without it there is no way to say "this particular stretch of residential street
 * has nothing along it", only "change the road type", which changes every other road
 * using it too.
 */
export type ZoneChoice = LandUse | 'none';

/** -1 = tunnel, 0 = ground, +1 = bridge; larger magnitudes stack further. */
export type Grade = number;

export interface Stroke {
  id: Id;
  profileId: Id;
  /** Zoning painted on this road, overriding the profile's. See `ZoneChoice`. */
  landUse?: ZoneChoice;
  points: ControlPoint[];
  name?: string;
}

export interface EditSettings {
  /** Right-hand traffic. Flips the whole cross-section layout when false. */
  driveOnRight: boolean;
  /** Adaptive flattening tolerance, metres. */
  flattenTolerance: number;
  /** Master seed for the simulation. */
  seed: number;
  /** Global multiplier on portal demand. */
  demandScale: number;
  /** Junction trim radius multiplier (1 = derived purely from road widths). */
  junctionRadiusScale: number;
  /** Where traffic comes from and goes to. */
  spawnMode: SpawnMode;
  /**
   * Simulated seconds in a day, and the hour the clock starts at.
   *
   * A day is compressed rather than real-time: at the default a minute of simulation
   * is an hour of the day, so a whole day's traffic passes in twenty-four minutes
   * and the morning peak is something you can sit and watch rather than schedule.
   * Set it to zero to switch the clock off entirely and generate flat demand, which
   * is what every scenario test wants.
   */
  dayLength: number;
  startHour: number;
}

/**
 * How traffic is generated.
 *
 * - `portals`: every place the network stops is both an origin and a destination,
 *   weighted by the road's size. Needs nothing set up, which is why it is the
 *   default and why every scenario and example uses it.
 * - `gateways`: the same, but only at the ends the user marked, and only in the
 *   direction they marked them. This is how you ask a specific question — "what
 *   happens to this junction if everything comes in from the north".
 * - `landuse`: trips start on residential streets, anywhere along them, and finish
 *   at commercial ones. Nobody enters from off-map at all; the traffic is the town's
 *   own. Falls back to `portals` when the document has no land use set, because a
 *   mode that silently generates nothing is indistinguishable from a broken one.
 * - `mixed`: both at once — the town's own trips plus through traffic from every
 *   road end. A town with a freeway past it has traffic that is not the town's, and
 *   without it the freeway sat empty: measured on a real network, not one of 2,464
 *   house-to-shop pairs was faster by the freeway, because it runs from one edge of
 *   the map to the other and the town's trips never leave the map.
 */
export type SpawnMode = 'portals' | 'gateways' | 'landuse' | 'mixed';

/** What role a place where the network stops plays in the gateway spawn mode. */
export type GatewayRole = 'both' | 'entry' | 'exit' | 'off';

/**
 * A user's choice about one end of the network, keyed by position.
 *
 * Position rather than id for the same reason junction control is: portals are
 * derived data and their ids change whenever anything upstream recompiles.
 */
export interface GatewayOverride {
  x: number;
  y: number;
  role: GatewayRole;
}

export const DEFAULT_SETTINGS: EditSettings = {
  driveOnRight: true,
  flattenTolerance: 0.15,
  seed: 1337,
  demandScale: 1,
  junctionRadiusScale: 1,
  spawnMode: 'portals',
  dayLength: 1440,
  startHour: 6,
};

export interface TerrainSettings {
  enabled: boolean;
  seed: number;
  /** Metres per noise unit; larger = broader features. */
  featureScale: number;
  seaLevel: number;
  /** Slope (rise/run) above which a cliff band is drawn. */
  cliffSlope: number;
  amplitude: number;
}

export const DEFAULT_TERRAIN: TerrainSettings = {
  enabled: false,
  seed: 20260101,
  featureScale: 900,
  seaLevel: -6,
  cliffSlope: 0.42,
  amplitude: 90,
};

/**
 * A user's choice of control type for a junction. Junctions are derived data with
 * no stable identity, so the override is keyed by position and re-matched on every
 * recompile — close enough survives an edit nearby, far enough is a new junction.
 */
/**
 * What turn bays an approach gets, overriding what the compiler would choose.
 *
 * `auto` is the compiler's own decision and is what an untouched junction has.
 * The rest force the answer — including `none`, which is how you take away a bay
 * the compiler was right to offer and you do not want.
 */
export type TurnLaneChoice = 'auto' | 'none' | 'left' | 'right' | 'both';

export interface TurnLaneOverride {
  /**
   * The approach, named `strokeId:side` — side +1 travels along the stroke, -1
   * against it. Named rather than identified because segments and lanes are derived
   * data and are rebuilt on every recompile, exactly as with signal groups and
   * hand-wired movements.
   */
  approach: string;
  choice: TurnLaneChoice;
}

export interface JunctionOverride {
  x: number;
  y: number;
  control: JunctionControl;
  /**
   * Right-in / right-out: only the kerb-side turns, at a T.
   *
   * A minor road meeting a divided major one may then only turn onto the near
   * carriageway, and only the near carriageway may turn into it. Nothing crosses the
   * median, so it stays unbroken, and the far carriageway is never touched — no
   * conflict point, no signal, no stop line. Runs on priority whatever `control`
   * says: a signal here would stop the very traffic the arrangement exists to leave
   * alone. (Left-in / left-out where traffic drives on the left.)
   */
  rightInRightOut?: boolean;
  /**
   * Per-approach turn bays. Absent means every approach is on `auto`.
   *
   * The compiler's own rule is a good default and a bad master: it builds a left bay
   * where the junction is a crossing with three or more arms, the group has two
   * lanes or more, there is somewhere to turn left to and the block is long enough.
   * All of those are judgements about a typical junction, and the whole point of
   * drawing your own network is that some of them are not typical.
   */
  turnLanes?: TurnLaneOverride[];
  /**
   * Diverge only: the kerb-side through lane may take the exit as well as carrying
   * on, so one lane on the highway both continues and branches off. The mainline is
   * split at the gore to give that lane an end to branch from — the one place a
   * merge or diverge splits the road it joins, and only when asked.
   */
  optionLane?: boolean;
  /**
   * Merge only: how many of the lanes the ramp brings in stay on the highway as new
   * through lanes instead of tapering away, so the road simply gets wider after the
   * entrance. 0 or absent is the ordinary taper.
   *
   * A count rather than a flag because a two-lane entrance has a real choice: both
   * lanes can stay, one can stay while the other merges into it, or neither can —
   * and with only a flag the middle answer was forced, which is why a two-lane
   * entrance grew a lane and lost it again three hundred metres later with no way
   * to say otherwise.
   */
  addedLanes?: number;
  /**
   * Whether the kerb-side turn may be taken against a red — a right turn where
   * traffic drives on the right, a left where it drives on the left. On unless
   * this says otherwise, which is how the rule works in the places that have it:
   * permitted by default, forbidden by a sign at the junctions that need one.
   */
  turnOnRed?: boolean;
  /**
   * A hand-authored signal plan, replacing the one the compiler would generate.
   * Only meaningful while `control` is `signal`, and kept when it is not so that
   * switching a junction off signals and back on does not throw the plan away.
   */
  signal?: SignalPlanSpec;
}

/**
 * One phase of a signal plan as the document stores it.
 *
 * Movements are named rather than numbered, for the same reason hand-wired lane
 * links are: a connector's id is derived data and changes on every recompile. A
 * *movement group* is every connector leaving one approach and making one kind of
 * turn — `strokeId:side:turn`, where side is +1 along the stroke and -1 against it
 * and turn is one of L, S, R, U. That is the granularity a signal actually works
 * at: "the left turn off the northbound arm" is one thing to a traffic engineer
 * however many lanes feed it, and it stays the same thing when a lane is added.
 */
export interface SignalPhaseSpec {
  groups: string[];
  /** Seconds of green, then amber, then all-red before the next phase. */
  green: number;
  amber: number;
  allRed: number;
}

export interface SignalPlanSpec {
  /** Seconds into the cycle this junction starts, for coordinating a corridor. */
  offset: number;
  phases: SignalPhaseSpec[];
  /**
   * Whether a green ends as soon as nobody is using it.
   *
   * Off by default, and that is not laziness. A fixed plan has a fixed cycle, which
   * is what makes a corridor offset mean anything: the green wave below is a
   * statement about where a platoon will be N seconds from now, and it stops being
   * true the moment the cycle length depends on who turned up. Real coordinated
   * arterials solve that by actuating the *splits* inside a fixed cycle; an
   * isolated junction has nothing to coordinate with and should gap out.
   *
   * So: turn it on for a junction on its own, leave it off along a corridor.
   */
  actuated?: boolean;
}

/**
 * A hand-wired set of movements for one junction, replacing what the compiler would
 * lay out itself.
 *
 * Lanes are named rather than numbered, because lane ids are derived data and change
 * on every recompile: `strokeId:side:index`, where side is +1 along the stroke and
 * -1 against it, and index is 0 for the kerbside through lane. Within a junction the
 * two halves of a pair say which is which, so an incoming lane and an outgoing lane
 * of the same road can share a name without ambiguity.
 *
 * One incoming lane may feed several outgoing ones and several may feed the same
 * one; that is the point of writing them out by hand.
 */
export interface LaneLinkOverride {
  /** Junction position when it was authored; re-matched by proximity on recompile. */
  x: number;
  y: number;
  links: { from: string; to: string }[];
}

/** Traffic demand between two portals. */
export interface DemandEntry {
  fromPortal: Id;
  toPortal: Id;
  /** Vehicles per hour. */
  rate: number;
}

/** A dropped image traced over, positioned by hand. */
export interface ImageUnderlay {
  /** Data URL of the image; saved with the document so a save is self-contained. */
  src: string;
  /** World position of the image centre, and its size in metres. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
}

/**
 * Ties the canvas to real-world coordinates so satellite tiles line up and traced
 * roads come out at true scale. The tile template is supplied by the user, who is
 * responsible for their provider's terms.
 */
export interface GeoSettings {
  enabled: boolean;
  lat: number;
  lon: number;
  /** XYZ template, e.g. https://example.com/tiles/{z}/{x}/{y}.jpg */
  tileUrl: string;
  attribution: string;
  opacity: number;
}

export const DEFAULT_GEO: GeoSettings = {
  enabled: false,
  lat: 51.5074,
  lon: -0.1278,
  tileUrl: '',
  attribution: '',
  opacity: 0.85,
};

export interface EditModel {
  version: number;
  profiles: RoadProfile[];
  strokes: Stroke[];
  settings: EditSettings;
  terrain: TerrainSettings;
  demand: DemandEntry[];
  junctions: JunctionOverride[];
  laneLinks: LaneLinkOverride[];
  gateways: GatewayOverride[];
  underlay: ImageUnderlay | null;
  geo: GeoSettings;
  /** Next id to issue; persisted so loads never collide with live ids. */
  nextId: number;
}

// ============================================================================
// Compiled network (derived, never persisted)
// ============================================================================

/** Road lanes and junction connectors are both traversable edges of the lane graph. */
export const LaneKind = { Road: 0, Connector: 1 } as const;
export type LaneKind = (typeof LaneKind)[keyof typeof LaneKind];

export const TurnKind = {
  Straight: 0,
  Left: 1,
  Right: 2,
  UTurn: 3,
  /** Ramp merging into a road. */
  Merge: 4,
  /** Road diverging onto a ramp. */
  Diverge: 5,
} as const;
export type TurnKind = (typeof TurnKind)[keyof typeof TurnKind];

/** Where two connectors cross inside a junction. */
export interface ConflictPoint {
  /** The other connector lane. */
  other: Id;
  /** Arc-length of the crossing on this connector. */
  sSelf: number;
  /** Arc-length of the crossing on the other connector. */
  sOther: number;
  /** Crossing angle, radians in [0, PI]. Shallow crossings need longer clearance. */
  angle: number;
}

/**
 * A traversable edge.
 *
 * One flat shape for road lanes and junction connectors alike: the simulation's
 * hot loops touch these constantly and a single hidden class keeps property
 * access monomorphic. Fields that do not apply to a kind hold -1 / Infinity.
 */
export interface Lane {
  id: Id;
  kind: LaneKind;

  /** Road lanes: owning segment. Connectors: -1. */
  segmentId: Id;
  /** Connectors: owning junction. Road lanes: -1. */
  junctionId: Id;
  /**
   * Cross-section slot within the direction group: 0 is the rightmost *through*
   * lane, positive runs toward the median, and auxiliary lanes outside the
   * carriageway take negative slots. -1 for connectors.
   */
  index: number;
  /** +1 travels along the parent stroke, -1 against it. */
  side: 1 | -1;

  centerline: Float32Array;
  arclength: Float32Array;
  /**
   * Arc-length on the parent segment centreline for each centreline point.
   * This is what makes exact s-mapping between neighbouring lanes possible, which
   * the merge model depends on. Monotone (decreasing for `side === -1`).
   */
  parentS: Float32Array;
  length: number;
  width: number;
  /** Signed lateral offset from the segment centreline, positive to the right of travel. */
  offset: number;
  speedLimit: number;

  successors: Id[];
  predecessors: Id[];
  /** Adjacent lane to the left of travel in the same direction group, else -1. */
  left: Id;
  /** Adjacent lane to the right of travel in the same direction group, else -1. */
  right: Id;

  /** Auxiliary (accel/decel/weave) lane rather than a through lane. */
  aux: boolean;
  /**
   * Usable range along this lane, in its own arc-length. Geometry always spans
   * [0, length]; `startsAt` marks where the lane is wide enough to occupy (a
   * taper-in), and `endsAt` where it ceases to exist and vehicles must have merged
   * away (Infinity for lanes that run through).
   */
  startsAt: number;
  endsAt: number;
  /** Lane vehicles must merge into before `endsAt`, else -1. */
  mergeTarget: Id;

  /** Connectors only. */
  conflicts: ConflictPoint[];
  /** Lower rank yields to nobody; a strict total order within a junction. */
  priorityRank: number;
  turn: TurnKind;
  /** Index into the junction's signal plan phase membership, or -1. */
  signalGroup: number;
  /** True when this connector must give way at the junction entry. */
  yields: boolean;
}

export type { Frontage } from './frontage';

export type MarkingStyle =
  /** Lane divider between same-direction lanes. */
  | 'dashed'
  /** No-crossing divider: taper edges, approach bars. */
  | 'solid'
  /** Undivided centre line between opposing traffic. */
  | 'double'
  /** Median edge: the left-hand boundary of a carriageway on a divided road. */
  | 'median'
  /** Carriageway edge line. */
  | 'edge'
  /**
   * One bar of a pedestrian crossing, laid *along* the traffic direction and
   * repeated across the carriageway. Painted only where traffic is made to stop by
   * something other than a gap in the traffic — a signal or an all-way stop — because
   * that is where a crossing can exist.
   */
  | 'zebra';

export interface Marking {
  style: MarkingStyle;
  points: Float32Array;
}

/**
 * Paint that is a picture rather than a line: turn arrows and the word STOP.
 *
 * Arrows are read off the movements the compiler actually built, so re-wiring a
 * junction re-paints its approaches without anyone having to say so.
 */
export interface RoadSymbol {
  kind: 'arrow' | 'stop';
  x: number;
  y: number;
  /** Direction of travel, radians. */
  heading: number;
  /** Movements this lane may make; empty for `stop`. */
  turns: TurnKind[];
  /** Lane width, so the glyph is drawn to the road rather than to the screen. */
  width: number;
}

export interface Segment {
  id: Id;
  strokeId: Id;
  profileId: Id;
  grade: Grade;
  /** Range of the parent stroke covered by this segment. */
  strokeS0: number;
  strokeS1: number;
  centerline: Float32Array;
  arclength: Float32Array;
  length: number;
  laneIds: Id[];
  /** Junction at each end, or -1 for a free end (a network portal). */
  startJunction: Id;
  endJunction: Id;
  /** Profile is marked as ramp geometry; the renderer tints these differently. */
  isRamp: boolean;
  /** Planted verge either side, metres. Decoration; the simulation never sees it. */
  verge: number;
  /**
   * What is beside this road, copied off the profile. The simulation reads it via
   * the zones the compiler builds from it; the renderer reads it to decide what to
   * draw there. Carried on the segment for the same reason `verge` is — the
   * renderer only ever sees the compiled network, never the profiles.
   */
  landUse?: LandUse;
  /**
   * Where the buildings stand along this road, if it is zoned.
   *
   * Emitted by the compiler so that the renderer's plots and the simulation's
   * land-use trips agree about where the houses are: a car pulls out of a driveway
   * that exists and parks at one, rather than appearing at the kerb wherever the
   * random number generator happened to land.
   */
  frontages: Frontage[];
  /** Half-width of the base paved corridor (excludes auxiliary lanes). */
  halfWidth: number;
  /** Widest half-width anywhere along the segment (includes auxiliary lanes). */
  maxHalfWidth: number;
  /**
   * Asphalt polygon, tapers included. Built by the compiler so the renderer never
   * has to re-derive road geometry.
   */
  surface: Float32Array;
  /**
   * How high the road is at each point of `surface`, in grade units — fractional,
   * because grade lives on control points and ramps between them. `grade` is this
   * rounded to the layer the segment draws on; this is the real height, and it is
   * what lets a bridge's shadow grow out of the ground rather than appear all at
   * once at the abutment.
   */
  surfaceHeight: Float32Array;
  /**
   * Where the left edge starts in `surface`. The ring runs up the right edge and
   * back down the left, so the two end caps are the edges either side of this
   * index — which is what lets the renderer case a road's sides without casing a
   * joint the road continues straight through.
   */
  surfaceSplit: number;
  /**
   * The two asphalt corners at each end, `[rightX, rightY, leftX, leftY]`. The
   * junction builder grows its footprint from these so an approach corridor is
   * exactly as wide as the road it continues, and flush with both its edges.
   */
  capStart: Float32Array;
  capEnd: Float32Array;
  markings: Marking[];
  symbols: RoadSymbol[];
}

export type JunctionKind = 'crossing' | 'merge' | 'diverge' | 'link';
export type JunctionControl = 'priority' | 'signal' | 'allway-stop';

export interface SignalPhase {
  /** Connector lanes that get green. */
  greenLanes: Id[];
  /**
   * Movement groups this phase greens, by the same names the document stores.
   * Connector ids are derived data and change on every recompile; these do not,
   * which is what lets the panel show the plan the document actually holds.
   */
  groups: string[];
  green: number;
  amber: number;
  allRed: number;
}

export interface SignalPlan {
  offset: number;
  phases: SignalPhase[];
  /** Greens end early when nothing is waiting on them. See `SignalPlanSpec`. */
  actuated: boolean;
  /** Sum of every phase's green + amber + allRed. */
  cycle: number;
  /** Whether the document holds this plan or the compiler made it up. */
  source: 'auto' | 'custom';
}

/** One incoming or outgoing road end at a junction. */
export interface Approach {
  segmentId: Id;
  /** True when the segment's *end* touches the junction. */
  atSegmentEnd: boolean;
  /** Heading into the junction, radians. */
  heading: number;
  incomingLanes: Id[];
  outgoingLanes: Id[];
  /** Rough importance: lane count * speed limit. Drives priority ranking. */
  weight: number;
}

export interface Junction {
  id: Id;
  /**
   * Paint the junction owns rather than its approaches. Only gores have any: the
   * ramp's edge lines have to carry on across the blend connector, or the paint
   * stops dead a connector's length short of the carriageway it is joining.
   */
  markings: Marking[];
  kind: JunctionKind;
  x: number;
  y: number;
  radius: number;
  grade: Grade;
  footprint: Float32Array;
  connectorIds: Id[];
  approaches: Approach[];
  control: JunctionControl;
  /** Compiled as right-in / right-out: see `JunctionOverride.rightInRightOut`. */
  rightInRightOut?: boolean;
  signal?: SignalPlan;
  /**
   * Kerb-side turns may be taken against a red here, after stopping and giving way
   * to everything. Defaults to on; the document turns it off per junction.
   */
  turnOnRed: boolean;
}

/** A free road end where traffic enters and leaves the network. */
export interface Portal {
  id: Id;
  name: string;
  x: number;
  y: number;
  /** Lanes flowing into the network from here. */
  entryLanes: Id[];
  /** Lanes flowing out of the network here. */
  exitLanes: Id[];
  /** Relative demand weight. */
  weight: number;
  /** What this end may do in the gateway spawn mode. */
  role: GatewayRole;
}

/**
 * Somewhere a trip can begin or end that is not the edge of the map.
 *
 * A zone is every lane of every road carrying one land use, taken together. It
 * shares the portals' id space — a zone's id continues where the portals' ids stop —
 * so a destination is a single number throughout the simulation and the router,
 * spawner and vehicle store did not have to learn about a second kind of thing.
 *
 * Arriving at a zone is not driving off the end of a lane, the way arriving at a
 * portal is. It is *reaching* one of its lanes and going a little way down it,
 * which is a driver pulling onto their own street and parking.
 */
export interface Zone {
  id: Id;
  landUse: LandUse;
  /** Centroid, for the UI. */
  x: number;
  y: number;
  /** Every lane belonging to the zone, sorted, so iteration is deterministic. */
  lanes: Id[];
  /** Total lane length, which is how much frontage the zone has. */
  frontage: number;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  x?: number;
  y?: number;
  strokeId?: Id;
  junctionId?: Id;
  laneId?: Id;
}

export interface NetworkStats {
  strokes: number;
  segments: number;
  lanes: number;
  connectors: number;
  junctions: number;
  portals: number;
  totalLaneLength: number;
  compileMs: number;
}

export interface Network {
  segments: Segment[];
  /** Dense: `lanes[i].id === i`. Road lanes and connectors share the index space. */
  lanes: Lane[];
  junctions: Junction[];
  portals: Portal[];
  zones: Zone[];
  diagnostics: Diagnostic[];
  bounds: Bbox;
  stats: NetworkStats;
  /** Cross-section slot ordering for rendering; unrelated to simulation. */
  driveOnRight: boolean;
}
