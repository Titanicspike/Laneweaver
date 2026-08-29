/**
 * Reading a road out of OpenStreetMap's tags.
 *
 * The tags are written by hand by a few million people over twenty years, so almost
 * nothing is reliably present. `lanes` is missing from most residential streets on
 * earth; `maxspeed` is missing from most roads outside Europe; `width` is missing
 * from nearly everything. What *is* reliably present is `highway`, the road's class,
 * and that carries most of the information: everybody knows roughly how wide a
 * residential street is.
 *
 * So the class supplies the defaults and the tags override them, rather than the
 * other way round. That is also what makes an import look coherent — a town drawn
 * from a dozen profiles reads as a town, and one drawn from four hundred slightly
 * different ones reads as noise.
 */

export type Tags = Record<string, string>;

/** How a way is classified, in descending order of importance. */
export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'residential' | 'living_street' | 'unclassified' | 'service'
  | 'ramp' | 'slip';

export interface ClassSpec {
  /** Lanes in each direction when the tags do not say. */
  lanes: number;
  laneWidth: number;
  /** Metres per second. */
  speed: number;
  shoulder: number;
  median: number;
  /** Planted verge either side; decoration, but it is what a suburb looks like. */
  verge: number;
  isRamp: boolean;
}

/**
 * The defaults, per class.
 *
 * Widths are the ones a highway engineer would build to, not the ones OSM records:
 * 3.65 m motorway lanes, 3.0 m on a residential street. Speeds are the common legal
 * default for that class where the tag is missing, which is wrong in any particular
 * country and right on average.
 */
export const CLASS_SPECS: Record<RoadClass, ClassSpec> = {
  motorway:      { lanes: 3, laneWidth: 3.65, speed: 30.5, shoulder: 2.5, median: 6, verge: 0, isRamp: false },
  trunk:         { lanes: 2, laneWidth: 3.5, speed: 25, shoulder: 1.5, median: 3, verge: 0, isRamp: false },
  primary:       { lanes: 2, laneWidth: 3.5, speed: 18, shoulder: 0.6, median: 2.4, verge: 1.5, isRamp: false },
  secondary:     { lanes: 2, laneWidth: 3.4, speed: 16, shoulder: 0.5, median: 1.6, verge: 1.5, isRamp: false },
  tertiary:      { lanes: 1, laneWidth: 3.4, speed: 14, shoulder: 0.4, median: 0, verge: 2, isRamp: false },
  residential:   { lanes: 1, laneWidth: 3.1, speed: 11, shoulder: 0.3, median: 0, verge: 3, isRamp: false },
  living_street: { lanes: 1, laneWidth: 3.0, speed: 5.5, shoulder: 0.2, median: 0, verge: 2, isRamp: false },
  unclassified:  { lanes: 1, laneWidth: 3.2, speed: 13, shoulder: 0.3, median: 0, verge: 2, isRamp: false },
  service:       { lanes: 1, laneWidth: 2.9, speed: 6, shoulder: 0.2, median: 0, verge: 0, isRamp: false },
  // A motorway link is a ramp: it has an acceleration lane, a gore, the lot.
  ramp:          { lanes: 1, laneWidth: 4.0, speed: 22, shoulder: 1.2, median: 0, verge: 0, isRamp: true },
  // Every other `*_link` is not. A `primary_link` is the slip road that cuts the
  // corner at an ordinary junction, a hundred metres of one-way street between two
  // at-grade roads — and building it as a ramp asks the compiler for a gore and an
  // auxiliary lane on a road that has neither the room nor the reason. That single
  // misreading was most of the errors in the first city that imported.
  slip:          { lanes: 1, laneWidth: 3.4, speed: 11, shoulder: 0.3, median: 0, verge: 0, isRamp: false },
};

const CLASS_OF: Record<string, RoadClass> = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary',
  tertiary: 'tertiary', residential: 'residential', living_street: 'living_street',
  unclassified: 'unclassified', service: 'service', road: 'unclassified',
  busway: 'service',
  motorway_link: 'ramp', trunk_link: 'ramp',
  primary_link: 'slip', secondary_link: 'slip', tertiary_link: 'slip',
};

/** Whether a car can drive on this way at all. */
export function isDrivable(tags: Tags): boolean {
  const highway = tags.highway;
  if (!highway || !CLASS_OF[highway]) return false;
  if (tags.area === 'yes') return false;
  // Under construction, or planned and not built: the geometry exists, the road
  // does not.
  if (highway === 'construction' || highway === 'proposed') return false;
  if (tags.access === 'no' || tags.access === 'private') {
    // ...unless something is explicitly let through. A gated community's streets
    // are private and are still streets.
    if (!tags['motor_vehicle'] && !tags['vehicle'] && !tags['motorcar']) return false;
  }
  if (tags.motor_vehicle === 'no' || tags.vehicle === 'no') return false;
  // A parking aisle is not a road; the road *into* the car park is.
  if (tags.service === 'parking_aisle' || tags.service === 'drive-through') return false;
  return true;
}

export function classOf(tags: Tags): RoadClass {
  return CLASS_OF[tags.highway] ?? 'unclassified';
}

/** `-1` when the way's own direction is the wrong way round. */
export function onewayOf(tags: Tags): 0 | 1 | -1 {
  const v = tags.oneway;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  // A motorway carriageway is one-way whether or not anybody tagged it.
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

function num(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Speed limit in metres per second.
 *
 * `maxspeed` is km/h unless it says mph. The country-code forms (`GB:national`)
 * are common enough in Europe to be worth the table.
 */
export function speedOf(tags: Tags, spec: ClassSpec): number {
  const limit = taggedSpeed(tags, spec);
  // A roundabout is taken at roundabout speed whatever the road it belongs to is
  // signed at. OSM carries the parent road's `maxspeed` round the circle — Milton
  // Keynes' grid roundabouts come through at 95 km/h — and a circulating carriageway
  // at ninety-five is not a roundabout, it is a very fast bend that traffic queues
  // on: every collision in that city was two cars on a roundabout connector.
  return isRoundabout(tags) ? Math.min(limit, ROUNDABOUT_SPEED) : limit;
}

/** What a roundabout is driven at, whatever the road it interrupts is signed at. */
const ROUNDABOUT_SPEED = 35 / 3.6;

function taggedSpeed(tags: Tags, spec: ClassSpec): number {
  const raw = tags.maxspeed ?? tags['maxspeed:forward'];
  if (!raw) return spec.speed;
  const mph = /mph/i.test(raw);
  const n = num(raw.replace(/[^\d.]/g, ''));
  if (n !== null && n > 0) return mph ? n * 0.44704 : n / 3.6;
  if (/walk|living/i.test(raw)) return 2.2;
  return spec.speed;
}

export interface LaneCount {
  forward: number;
  backward: number;
}

/**
 * How many lanes each way.
 *
 * `lanes` counts *both* directions, and is the total including turn lanes, so a
 * two-way street tagged `lanes=2` has one each way. Where the split is tagged
 * explicitly it wins. Anything unbelievable is ignored rather than believed: a
 * residential street tagged with eight lanes is a mistake somebody made, and
 * building it makes the whole import look broken at that one street.
 */
export function lanesOf(tags: Tags, spec: ClassSpec, oneway: boolean): LaneCount {
  const cap = spec.isRamp ? 4 : 8;
  const fwd = num(tags['lanes:forward']);
  const bwd = num(tags['lanes:backward']);
  if (fwd !== null || bwd !== null) {
    return {
      forward: clampLanes(fwd ?? spec.lanes, cap),
      backward: oneway ? 0 : clampLanes(bwd ?? spec.lanes, cap),
    };
  }
  const total = num(tags.lanes);
  if (total !== null && total >= 1) {
    const t = clampLanes(total, cap * 2);
    if (oneway) return { forward: t, backward: 0 };
    // An odd count on a two-way road usually means a centre turn lane, which this
    // model has no room for: give the extra to the busier direction.
    return { forward: Math.ceil(t / 2), backward: Math.floor(t / 2) || 1 };
  }
  return { forward: spec.lanes, backward: oneway ? 0 : spec.lanes };
}

function clampLanes(n: number, cap: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(cap, Math.round(n)));
}

/** Lane width from `width`, when it is present and believable. */
export function laneWidthOf(tags: Tags, spec: ClassSpec, lanes: LaneCount): number {
  const total = num(tags.width) ?? num(tags['est_width']);
  const count = lanes.forward + lanes.backward;
  if (total === null || count < 1) return spec.laneWidth;
  const each = total / count;
  // Believe it only within reach of a real lane. `width=1` on a two-lane road is
  // somebody recording a footpath's width on the wrong object.
  return each >= 2.2 && each <= 6 ? each : spec.laneWidth;
}

/**
 * The level this way sits on.
 *
 * `layer` is the general one; `bridge` and `tunnel` imply a layer when none is
 * tagged, which is common. Clamped hard: OSM has `layer=-5` on mine shafts, and a
 * road five levels down is a rendering problem rather than a road.
 */
export function layerOf(tags: Tags): number {
  const explicit = num(tags.layer);
  if (explicit !== null) return Math.max(-2, Math.min(3, Math.round(explicit)));
  if (tags.tunnel && tags.tunnel !== 'no') return -1;
  if (tags.bridge && tags.bridge !== 'no') return 1;
  return 0;
}

export function isRoundabout(tags: Tags): boolean {
  return tags.junction === 'roundabout' || tags.junction === 'circular';
}

/** A short human name for the profile this way wants. */
export function profileName(cls: RoadClass, lanes: LaneCount, oneway: boolean, kph: number): string {
  const shape = oneway ? `${lanes.forward} one-way` : `${lanes.forward}+${lanes.backward}`;
  const pretty = cls === 'ramp' ? 'Ramp'
    : cls === 'slip' ? 'Slip road'
    : cls.replace('_', ' ').replace(/^./, (c) => c.toUpperCase());
  return `${pretty} ${shape} · ${Math.round(kph)}`;
}
