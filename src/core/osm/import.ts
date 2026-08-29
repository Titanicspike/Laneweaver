/**
 * Turning an OpenStreetMap extract into an edit model.
 *
 * The compiler already wants exactly what OSM has: centrelines, plus a cross-section
 * for each. It finds junctions geometrically, so the import does not have to supply
 * any — two ways that share a node come out with coincident endpoints, and the
 * compiler makes the junction. That is the whole reason this is a small piece of
 * code rather than a second compiler.
 *
 * Four things have to be got right, and each of them is a way an import looks wrong
 * rather than a way it fails:
 *
 * - **Fitting.** A way is a dense chain of surveyed positions. Kept as control points
 *   it is a faceted polygon; fitted to cubics it is a road. See `geom/fit.ts`.
 * - **Profiles.** A few dozen shared road types, not one per way. A town drawn from
 *   twelve profiles reads as a town.
 * - **Levels.** `layer` is per way, but grade in this model is per *point*, which is
 *   better: a bridge's ends are where it meets the ground, and knowing which nodes it
 *   shares with a ground-level way is what says where to ramp.
 * - **Scale.** Everything is metres from a single anchor, so the Mercator distortion
 *   is divided out once rather than accumulating across the extract.
 */

import { lonLatToWorld } from '../geo/mercator';
import { fitPolyline, simplifyPolyline } from '../geom/fit';
import { createDocument, issueId, makeControlPoint } from '../network/model';
import type { ControlPoint, EditModel, RoadProfile, Stroke } from '../network/types';
import type { Georeference } from '../geo/mercator';
import {
  CLASS_SPECS, classOf, isDrivable, isRoundabout, lanesOf, laneWidthOf, layerOf,
  onewayOf, profileName, speedOf, type Tags,
} from './tags';

/** One way, as Overpass hands it over with `out geom`. */
export interface OsmWay {
  type: string;
  id: number;
  nodes?: number[];
  geometry?: ({ lat: number; lon: number } | null)[];
  tags?: Tags;
}

export interface OsmExtract {
  elements: OsmWay[];
}

export interface ImportOptions {
  /** Metres the fitted road may stray from the survey. */
  tolerance?: number;
  /** Drop anything shorter than this: stubs, kerb returns, driveway ends. */
  minLength?: number;
  /** Leave out service roads, which are most of the ways in a suburb. */
  includeService?: boolean;
  /** Where world (0,0) sits. Defaults to the middle of the extract. */
  anchor?: { lat: number; lon: number };
}

export interface ImportReport {
  ways: number;
  imported: number;
  skipped: { notDrivable: number; tooShort: number; degenerate: number; isolated: number };
  strokes: number;
  profiles: number;
  roundabouts: number;
  controlPoints: number;
  /** Vertices in, control points out: the fit's compression. */
  vertices: number;
  bounds: { west: number; south: number; east: number; north: number };
  ms: number;
}

export interface ImportResult {
  model: EditModel;
  report: ImportReport;
  /** Stroke id to the OSM way it came from, for tracing a fault back to the data. */
  source: Map<number, number>;
}

const DEFAULTS: Required<Omit<ImportOptions, 'anchor'>> = {
  tolerance: 1.2,
  minLength: 8,
  includeService: true,
};

/**
 * Reads an extract into a fresh edit model.
 *
 * Deliberately pure and headless: it takes parsed JSON and returns a document, so it
 * can be run over a hundred cities in a test without a browser anywhere near it.
 */
export function importOsm(extract: OsmExtract, options: ImportOptions = {}): ImportResult {
  const t0 = Date.now();
  const opts = { ...DEFAULTS, ...options };
  const ways = (extract.elements ?? []).filter(
    (w) => w.type === 'way' && Array.isArray(w.geometry) && w.geometry.length >= 2);

  const anchor = options.anchor ?? centreOf(ways);
  const geo: Georeference = { lat: anchor.lat, lon: anchor.lon };

  // What level each shared node sits at: the lowest of the ways meeting there. A
  // bridge's own layer applies along it, but where it lands on a ground-level road
  // it is at ground, and that is what makes a road ramp instead of stepping.
  const nodeLevel = new Map<number, number>();
  /** How many kept ways touch each node: where two meet is a junction. */
  const nodeUses = new Map<number, number>();
  const kept: { way: OsmWay; tags: Tags; level: number }[] = [];
  const report: ImportReport = {
    ways: ways.length, imported: 0,
    skipped: { notDrivable: 0, tooShort: 0, degenerate: 0, isolated: 0 },
    strokes: 0, profiles: 0, roundabouts: 0, controlPoints: 0, vertices: 0,
    bounds: { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }, ms: 0,
  };

  for (const way of ways) {
    const tags = way.tags ?? {};
    if (!isDrivable(tags)) { report.skipped.notDrivable++; continue; }
    if (!opts.includeService && tags.highway === 'service') { report.skipped.notDrivable++; continue; }
    const level = layerOf(tags);
    kept.push({ way, tags, level });
    for (const id of way.nodes ?? []) {
      const at = nodeLevel.get(id);
      nodeLevel.set(id, at === undefined ? level : Math.min(at, level));
      nodeUses.set(id, (nodeUses.get(id) ?? 0) + 1);
    }
  }

  // A way that shares no node with any other is a fragment: the entrance to a car
  // park whose aisles were filtered out, a driveway, a stub somebody drew and never
  // joined up. Nothing can reach it, so it carries no traffic — it is litter on the
  // map and a spawn point in the middle of nowhere. Unless it reaches the edge of the
  // extract, where the road it connects to is simply outside the square.
  const lonLatBounds = boundsOfKept(kept);
  const isolated = new Set<number>();
  for (const { way } of kept) {
    if ((way.nodes ?? []).some((id) => (nodeUses.get(id) ?? 0) > 1)) continue;
    if (touchesEdge(way, lonLatBounds)) continue;
    isolated.add(way.id);
  }

  const model = emptyModel();
  const source = new Map<number, number>();
  model.geo = { ...model.geo, lat: anchor.lat, lon: anchor.lon };
  const profiles = new ProfileTable(model);

  for (const { way, tags, level } of kept) {
    if (isolated.has(way.id)) { report.skipped.isolated++; continue; }
    const geom = (way.geometry ?? []).filter((g): g is { lat: number; lon: number } => !!g);
    if (geom.length < 2) { report.skipped.degenerate++; continue; }

    // Survey positions to metres, then drop repeated ones: OSM has plenty of
    // duplicate consecutive nodes, and a zero-length step has no direction.
    const raw: number[] = [];
    for (const g of geom) {
      const p = lonLatToWorld(geo, g.lon, g.lat);
      const n = raw.length;
      if (n >= 2 && Math.hypot(p.x - raw[n - 2], p.y - raw[n - 1]) < 0.05) continue;
      raw.push(p.x, p.y);
      report.bounds.west = Math.min(report.bounds.west, p.x);
      report.bounds.east = Math.max(report.bounds.east, p.x);
      report.bounds.south = Math.min(report.bounds.south, p.y);
      report.bounds.north = Math.max(report.bounds.north, p.y);
    }
    if (raw.length < 4) { report.skipped.degenerate++; continue; }
    report.vertices += raw.length >> 1;
    if (lengthOf(raw) < opts.minLength) { report.skipped.tooShort++; continue; }

    const oneway = onewayOf(tags);
    if (oneway === -1) reverseInPlace(raw);

    const spec = CLASS_SPECS[classOf(tags)];
    const lanes = lanesOf(tags, spec, oneway !== 0);
    const laneWidth = laneWidthOf(tags, spec, lanes);
    const speed = speedOf(tags, spec);
    const profile = profiles.get(classOf(tags), lanes, laneWidth, speed, oneway !== 0, spec);

    // A closed way — a roundabout drawn as one circle, an island, a loop of service
    // road — is a road whose two ends are each other. The compiler refuses a movement
    // that leaves a junction by the road it came in on, quite rightly, so a single
    // closed stroke never joins up: on Milton Keynes a third of the roundabouts are
    // drawn that way and none of them circulated. Cut into arcs, each arc's ends meet
    // a *different* arc and the ring closes.
    const closed = (way.nodes?.length ?? 0) > 2 && way.nodes![0] === way.nodes![way.nodes!.length - 1];
    const cuts = closed ? loopCuts(way.nodes ?? [], raw, nodeUses) : null;
    const pieces = cuts ? splitAt(raw, cuts) : [raw];

    let madeAny = false;
    for (const piece of pieces) {
      if (piece.length < 4 || lengthOf(piece) < opts.minLength) continue;
      const points = fitToControlPoints(piece, opts.tolerance);
      if (points.length < 2) continue;
      // Grade per point: the way's own level along it, dropping to whatever the ends
      // actually meet. Nodes were counted before any way was dropped, so a bridge
      // still ramps down to a road that was itself filtered out.
      applyLevels(points, piece, pieces.length === 1 ? way.nodes ?? [] : [], nodeLevel, level);

      const stroke: Stroke = { id: issueId(model), profileId: profile.id, points };
      if (isRoundabout(tags)) stroke.roundabout = true;
      model.strokes.push(stroke);
      source.set(stroke.id, way.id);
      report.controlPoints += points.length;
      madeAny = true;
    }
    if (!madeAny) { report.skipped.degenerate++; continue; }
    report.imported++;
    if (isRoundabout(tags)) report.roundabouts++;
  }

  markEnds(model, report, kept.length ? opts : opts);
  report.strokes = model.strokes.length;
  report.profiles = model.profiles.length;
  report.ms = Date.now() - t0;
  if (!Number.isFinite(report.bounds.west)) {
    report.bounds = { west: 0, south: 0, east: 0, north: 0 };
  }
  return { model, report, source };
}

/**
 * Says what each end of the network does.
 *
 * An extract is a square cut out of a country, and the two kinds of end inside it
 * are nothing alike. A road the *boundary* cut carries on in the real world, so
 * traffic comes in and out of it — that is where the through traffic belongs. A road
 * that ends in the middle of the square ends in the middle of the real world too:
 * it is a dead end, and traffic appearing out of it is traffic arriving from a
 * cul-de-sac's hedge.
 *
 * Left undistinguished, a two-mile square of suburb spawns from nine hundred places
 * at once and gridlocks in five minutes at four thousand vehicles and nine
 * kilometres an hour. Told apart, the traffic enters where a city's traffic enters.
 */
function markEnds(model: EditModel, report: ImportReport, opts: typeof DEFAULTS): void {
  const b = report.bounds;
  if (!Number.isFinite(b.west)) return;
  const nearEdge = (x: number, y: number): boolean =>
    x - b.west < EDGE_TOLERANCE || b.east - x < EDGE_TOLERANCE
    || y - b.south < EDGE_TOLERANCE || b.north - y < EDGE_TOLERANCE;

  // Where a stroke end meets another road it is a junction, not an end; the compiler
  // works that out geometrically, so the test here is only about the boundary.
  const ends: { x: number; y: number }[] = [];
  for (const stroke of model.strokes) {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    for (const p of [first, last]) if (!nearEdge(p.x, p.y)) ends.push({ x: p.x, y: p.y });
  }
  // Two ends at the same place are a road meeting another road, which is a junction
  // and not an end at all. Bucketed rather than compared pairwise: a city has a few
  // thousand ends and the square of that is the whole import's budget.
  const cell = 3;
  const buckets = new Map<string, number>();
  const keyOf = (x: number, y: number): string =>
    `${Math.round(x / cell)},${Math.round(y / cell)}`;
  for (const e of ends) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = keyOf(e.x + dx * cell, e.y + dy * cell);
        buckets.set(k, (buckets.get(k) ?? 0) + (dx === 0 && dy === 0 ? 1 : 0));
      }
    }
  }
  for (const e of ends) {
    if ((buckets.get(keyOf(e.x, e.y)) ?? 0) > 1) continue;
    model.gateways.push({ x: e.x, y: e.y, role: 'off' });
  }
  // Traffic comes from the ends that were marked, which is what the gateway mode
  // means. In the portal mode every end is a source, and for an extract that is
  // nine hundred sources in four square miles.
  model.settings.spawnMode = 'gateways';
  void opts;
}

/** How near the extract's edge an end has to be to count as leaving the map. */
const EDGE_TOLERANCE = 30;

/** The extract's extent in degrees, from the ways that survived the filter. */
function boundsOfKept(kept: { way: OsmWay }[]): { s: number; w: number; n: number; e: number } {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const { way } of kept) {
    for (const g of way.geometry ?? []) {
      if (!g) continue;
      s = Math.min(s, g.lat); n = Math.max(n, g.lat);
      w = Math.min(w, g.lon); e = Math.max(e, g.lon);
    }
  }
  return { s, w, n, e };
}

/** Whether a way reaches the edge of the extract, where its neighbours would be. */
function touchesEdge(way: OsmWay, b: { s: number; w: number; n: number; e: number }): boolean {
  const dLat = (b.n - b.s) * 0.01;
  const dLon = (b.e - b.w) * 0.01;
  for (const g of way.geometry ?? []) {
    if (!g) continue;
    if (g.lat - b.s < dLat || b.n - g.lat < dLat) return true;
    if (g.lon - b.w < dLon || b.e - g.lon < dLon) return true;
  }
  return false;
}

/**
 * Where to cut a closed way, as vertex indices.
 *
 * At the nodes it shares with other ways, which is where the junctions are going to
 * be anyway — a roundabout cut at its entries gives arcs that run entry to entry.
 * Failing that (a loop nothing else touches), in three, which is the fewest that
 * gives every arc two different neighbours.
 */
function loopCuts(
  nodes: number[], raw: number[], uses: Map<number, number>,
): number[] {
  const vertexCount = raw.length >> 1;
  // Distance along the loop to each vertex, so arcs can be spaced by metres. Two
  // entries four metres apart are one place on the ring, and cutting at both makes a
  // four-metre stroke that carries a junction at each end and no traffic at all.
  const along = new Float64Array(vertexCount);
  for (let i = 1; i < vertexCount; i++) {
    along[i] = along[i - 1] + Math.hypot(raw[i * 2] - raw[i * 2 - 2], raw[i * 2 + 1] - raw[i * 2 - 1]);
  }
  const total = along[vertexCount - 1];
  const cuts: number[] = [];
  let lastAt = 0;
  for (let i = 1; i < nodes.length - 1 && i < vertexCount - 1; i++) {
    if ((uses.get(nodes[i]) ?? 0) <= 1) continue;
    if (along[i] - lastAt < MIN_ARC || total - along[i] < MIN_ARC) continue;
    cuts.push(i);
    lastAt = along[i];
  }
  if (cuts.length >= 2) return cuts;
  // A loop nothing else touches: in three, which is the fewest that gives every arc
  // two different neighbours. Too small for that and it is left whole — a ten-metre
  // loop is not a roundabout.
  if (total < MIN_ARC * 3) return [];
  const at = (want: number): number => {
    for (let i = 1; i < vertexCount; i++) if (along[i] >= want) return i;
    return vertexCount - 1;
  };
  return [at(total / 3), at((total * 2) / 3)];
}

/** Shortest arc a split loop is cut into. */
const MIN_ARC = 18;

/** Splits a flat polyline at the given vertex indices, sharing the cut vertices. */
function splitAt(raw: number[], cuts: number[]): number[][] {
  if (!cuts.length) return [raw];
  const out: number[][] = [];
  let from = 0;
  for (const cut of [...cuts, (raw.length >> 1) - 1]) {
    if (cut <= from) continue;
    out.push(raw.slice(from * 2, (cut + 1) * 2));
    from = cut;
  }
  return out;
}

/** Fits a metric polyline and turns the cubics into control points. */
function fitToControlPoints(raw: number[], tolerance: number): ControlPoint[] {
  // Simplify first at a fraction of the tolerance: the fit is O(n) per iteration and
  // survey data is mostly vertices that say nothing, but simplifying at the full
  // tolerance spends the whole budget before the fit has had any.
  const simple = simplifyPolyline(Float32Array.from(raw), tolerance * 0.4);
  const curves = fitPolyline(simple, tolerance);
  if (!curves.length) return [];
  const points: ControlPoint[] = [];
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    if (i === 0) {
      const p = makeControlPoint(c.x0, c.y0);
      p.hox = c.c1x; p.hoy = c.c1y;
      p.hix = c.x0 - (c.c1x - c.x0); p.hiy = c.y0 - (c.c1y - c.y0);
      points.push(p);
    } else {
      // The joint between two cubics: incoming handle from the one before, outgoing
      // from this one. They are not made collinear — the fit split there because the
      // road actually turns, and smoothing it would put the corner back.
      const prev = points[points.length - 1];
      prev.hox = c.c1x; prev.hoy = c.c1y;
    }
    const end = makeControlPoint(c.x1, c.y1);
    end.hix = c.c2x; end.hiy = c.c2y;
    end.hox = c.x1 + (c.x1 - c.c2x); end.hoy = c.y1 + (c.y1 - c.c2y);
    points.push(end);
  }
  return points;
}

/** Puts each control point on the level its own place along the way sits at. */
function applyLevels(
  points: ControlPoint[], raw: number[], nodes: number[],
  nodeLevel: Map<number, number>, level: number,
): void {
  for (const p of points) p.grade = level;
  if (level === 0 || points.length < 2) return;
  // Only the ends can ramp, and only when what they meet is lower. Anything else —
  // a bridge that starts in mid-air — is a tagging error rather than a road.
  const endLevel = (nodeId: number | undefined): number =>
    nodeId === undefined ? level : Math.min(level, nodeLevel.get(nodeId) ?? level);
  const first = endLevel(nodes[0]);
  const last = endLevel(nodes[nodes.length - 1]);
  if (first !== level) points[0].grade = first;
  if (last !== level) points[points.length - 1].grade = last;
  void raw;
}

/** Total length of a flat [x,y,...] polyline. */
function lengthOf(raw: number[]): number {
  let total = 0;
  for (let i = 2; i < raw.length; i += 2) {
    total += Math.hypot(raw[i] - raw[i - 2], raw[i + 1] - raw[i - 1]);
  }
  return total;
}

function reverseInPlace(raw: number[]): void {
  for (let i = 0, j = raw.length - 2; i < j; i += 2, j -= 2) {
    const x = raw[i], y = raw[i + 1];
    raw[i] = raw[j]; raw[i + 1] = raw[j + 1];
    raw[j] = x; raw[j + 1] = y;
  }
}

/** The middle of everything, so the anchor is where the distortion is smallest. */
function centreOf(ways: OsmWay[]): { lat: number; lon: number } {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const w of ways) {
    for (const g of w.geometry ?? []) {
      if (!g) continue;
      minLat = Math.min(minLat, g.lat); maxLat = Math.max(maxLat, g.lat);
      minLon = Math.min(minLon, g.lon); maxLon = Math.max(maxLon, g.lon);
    }
  }
  if (!Number.isFinite(minLat)) return { lat: 0, lon: 0 };
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/**
 * The profiles an import uses, made once and shared.
 *
 * Keyed on what actually differs — class, lane counts, width, speed to the nearest
 * 5 km/h — so a city comes out with a few dozen road types rather than one per way.
 * The speed rounding is what keeps `maxspeed=48` and `maxspeed=50` from being two
 * different kinds of road.
 */
class ProfileTable {
  private readonly byKey = new Map<string, RoadProfile>();

  constructor(private readonly model: EditModel) {}

  get(
    cls: ReturnType<typeof classOf>, lanes: { forward: number; backward: number },
    laneWidth: number, speed: number, oneway: boolean, spec: typeof CLASS_SPECS[keyof typeof CLASS_SPECS],
  ): RoadProfile {
    const kph = Math.max(5, Math.round((speed * 3.6) / 5) * 5);
    const width = Math.round(laneWidth * 10) / 10;
    const key = `${cls}|${lanes.forward}|${lanes.backward}|${width}|${kph}`;
    const found = this.byKey.get(key);
    if (found) return found;
    const profile: RoadProfile = {
      id: issueId(this.model),
      name: profileName(cls, lanes, oneway, kph),
      lanesForward: lanes.forward,
      lanesBackward: lanes.backward,
      laneWidth: width,
      // Only a divided road gets a median, and only where there is a direction each
      // way to divide.
      median: lanes.backward > 0 && lanes.forward + lanes.backward >= 4 ? spec.median : 0,
      shoulder: spec.shoulder,
      speedLimit: (kph * 1000) / 3600,
      isRamp: spec.isRamp,
      rampSpec: spec.isRamp
        ? { accelLaneLength: 180, decelLaneLength: 130, taperLength: 60 }
        : undefined,
      verge: spec.verge,
      landUse: cls === 'residential' || cls === 'living_street' ? 'residential' : undefined,
    };
    this.model.profiles.push(profile);
    this.byKey.set(key, profile);
    return profile;
  }
}

/** A document with no roads and no default profiles: the import supplies its own. */
function emptyModel(): EditModel {
  const model = createDocument();
  // The stock profiles are for drawing by hand. An import names its own from the
  // tags, and leaving both in gives a road-type list where half the entries are
  // unused and none of them says which.
  model.profiles.length = 0;
  return model;
}
