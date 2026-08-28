/**
 * Edit-model construction and queries.
 *
 * This is the layer the editor mutates and the only thing that gets saved.
 */

import { IdGen, type Id } from '../util/ids';
import { flattenCubicInto } from '../geom/flatten';
import { buildArclength, dedupePolyline } from '../geom/polyline';
import {
  DEFAULT_GEO, DEFAULT_RAMP_SPEC, DEFAULT_SETTINGS, DEFAULT_TERRAIN,
  type ControlPoint, type EditModel, type GatewayOverride, type JunctionOverride,
  type RoadProfile, type Stroke,
} from './types';

/** km/h to m/s. Profiles are authored in km/h because that is how humans think. */
export const kph = (v: number): number => v / 3.6;
export const toKph = (v: number): number => v * 3.6;

export const SAVE_VERSION = 3;

export function makeControlPoint(x: number, y: number, grade = 0): ControlPoint {
  return { x, y, hix: x, hiy: y, hox: x, hoy: y, grade };
}

export function cloneControlPoint(p: ControlPoint): ControlPoint {
  return { x: p.x, y: p.y, hix: p.hix, hiy: p.hiy, hox: p.hox, hoy: p.hoy, grade: p.grade };
}

export function cloneStroke(s: Stroke): Stroke {
  return {
    id: s.id,
    profileId: s.profileId,
    name: s.name,
    points: s.points.map(cloneControlPoint),
  };
}

/**
 * Level of a stroke at arc-length `s`, ramping between control points.
 *
 * `cpArc` is where each control point falls along the flattened polyline, which is
 * what makes this a lookup rather than a re-flatten.
 */
export function gradeAtS(stroke: Stroke, cpArc: ArrayLike<number>, s: number): number {
  const n = Math.min(stroke.points.length, cpArc.length);
  if (n === 0) return 0;
  if (n === 1 || s <= cpArc[0]) return stroke.points[0].grade;
  if (s >= cpArc[n - 1]) return stroke.points[n - 1].grade;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cpArc[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cpArc[hi] - cpArc[lo];
  const t = span > 1e-6 ? (s - cpArc[lo]) / span : 0;
  return stroke.points[lo].grade + (stroke.points[hi].grade - stroke.points[lo].grade) * t;
}

/** The levels a stroke passes through, ascending, with no duplicates. */
export function gradeLevels(stroke: Stroke): number[] {
  const seen = new Set<number>();
  for (const p of stroke.points) seen.add(Math.round(p.grade));
  return [...seen].sort((a, b) => a - b);
}

/**
 * Sets Catmull-Rom style handles so a sequence of clicked points reads as one
 * smooth road. `tension` 0 gives straight chords, 1/3 is the usual smooth default.
 */
export function autoSmoothHandles(points: ControlPoint[], tension = 1 / 3): void {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[i - 1] ?? p;
    const next = points[i + 1] ?? p;
    const dx = (next.x - prev.x) * tension;
    const dy = (next.y - prev.y) * tension;
    p.hox = p.x + dx;
    p.hoy = p.y + dy;
    p.hix = p.x - dx;
    p.hiy = p.y - dy;
  }
}

/** Total paved half-width of a profile, shoulders included. */
export function profileHalfWidth(p: RoadProfile): number {
  const lanes = p.lanesForward + p.lanesBackward;
  const median = p.lanesForward > 0 && p.lanesBackward > 0 ? p.median : 0;
  return (lanes * p.laneWidth + median) * 0.5 + p.shoulder;
}

export function findProfile(model: EditModel, id: Id): RoadProfile | undefined {
  return model.profiles.find((p) => p.id === id);
}

export function requireProfile(model: EditModel, id: Id): RoadProfile {
  const p = findProfile(model, id);
  if (p) return p;
  const fallback = model.profiles[0];
  if (!fallback) throw new Error('document has no road profiles');
  return fallback;
}

/**
 * Flattens a stroke into a polyline plus its arc-length table.
 * Strokes with fewer than two points produce an empty polyline.
 */
export function flattenStroke(
  stroke: Stroke, tolerance = DEFAULT_SETTINGS.flattenTolerance,
): { points: Float32Array; arclength: Float32Array; cpArc: Float32Array } {
  const cps = stroke.points;
  if (cps.length < 2) {
    return { points: new Float32Array(0), arclength: new Float32Array(0), cpArc: new Float32Array(0) };
  }
  const out: number[] = [cps[0].x, cps[0].y];
  // Where each control point lands along the flattened polyline. Taken before the
  // dedupe, which only drops points a millimetre apart, so the arc-lengths stand.
  const at: number[] = [0];
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i];
    const b = cps[i + 1];
    flattenCubicInto(out, a.x, a.y, a.hox, a.hoy, b.hix, b.hiy, b.x, b.y, tolerance);
    at.push((out.length >> 1) - 1);
  }
  const raw = Float32Array.from(out);
  const rawArc = buildArclength(raw);
  const cpArc = Float32Array.from(at, (i) => rawArc[Math.min(i, rawArc.length - 1)] ?? 0);
  const points = dedupePolyline(raw, 1e-3);
  return { points, arclength: buildArclength(points), cpArc };
}

/** The stock profile library, issued fresh ids from `gen`. */
export function defaultProfiles(gen: IdGen): RoadProfile[] {
  return [
    {
      id: gen.issue(),
      name: 'Residential 2-lane',
      verge: 4,
      lanesForward: 1,
      lanesBackward: 1,
      laneWidth: 3.2,
      speedLimit: kph(40),
      median: 0,
      shoulder: 0.4,
      isRamp: false,
      color: '#3b3f45',
    },
    {
      id: gen.issue(),
      name: 'Collector 2-lane',
      verge: 3,
      lanesForward: 1,
      lanesBackward: 1,
      laneWidth: 3.5,
      speedLimit: kph(60),
      median: 0,
      shoulder: 0.8,
      isRamp: false,
    },
    {
      id: gen.issue(),
      name: 'Arterial 4-lane',
      verge: 2.5,
      lanesForward: 2,
      lanesBackward: 2,
      laneWidth: 3.5,
      speedLimit: kph(70),
      median: 2.4,
      shoulder: 0.8,
      isRamp: false,
    },
    {
      id: gen.issue(),
      name: 'Freeway 3-lane',
      lanesForward: 3,
      lanesBackward: 3,
      laneWidth: 3.65,
      speedLimit: kph(110),
      median: 6,
      shoulder: 2.5,
      isRamp: false,
      rampSpec: { ...DEFAULT_RAMP_SPEC },
      color: '#34383f',
    },
    {
      id: gen.issue(),
      name: 'Freeway 3-lane (one-way)',
      lanesForward: 3,
      lanesBackward: 0,
      laneWidth: 3.65,
      speedLimit: kph(110),
      median: 0,
      shoulder: 2.5,
      isRamp: false,
      rampSpec: { ...DEFAULT_RAMP_SPEC },
      color: '#34383f',
    },
    {
      id: gen.issue(),
      name: 'Freeway 2-lane (one-way)',
      lanesForward: 2,
      lanesBackward: 0,
      laneWidth: 3.65,
      speedLimit: kph(110),
      median: 0,
      shoulder: 2.5,
      isRamp: false,
      rampSpec: { ...DEFAULT_RAMP_SPEC },
      color: '#34383f',
    },
    {
      id: gen.issue(),
      name: 'Ramp (one-way)',
      lanesForward: 1,
      lanesBackward: 0,
      laneWidth: 4,
      speedLimit: kph(60),
      median: 0,
      shoulder: 1.2,
      isRamp: true,
      rampSpec: { ...DEFAULT_RAMP_SPEC },
      color: '#3a3e45',
    },
    {
      id: gen.issue(),
      name: 'Ramp 2-lane (one-way)',
      lanesForward: 2,
      lanesBackward: 0,
      laneWidth: 3.65,
      speedLimit: kph(70),
      median: 0,
      shoulder: 1.2,
      isRamp: true,
      rampSpec: { ...DEFAULT_RAMP_SPEC },
      color: '#3a3e45',
    },
  ];
}

/**
 * The override authored for a junction at this position, if any.
 *
 * Overrides are keyed by position rather than by id because junction ids are
 * derived data: they change whenever anything upstream of them recompiles.
 */
export function junctionOverrideAt(
  list: ReadonlyArray<JunctionOverride>, x: number, y: number, radius = 0,
): JunctionOverride | null {
  const tolerance = Math.max(8, radius * 1.5);
  let best: JunctionOverride | null = null;
  let bestD = Infinity;
  for (const candidate of list) {
    const d = Math.hypot(candidate.x - x, candidate.y - y);
    if (d < bestD && d <= tolerance) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

/**
 * The gateway choice authored for the end of the network at this position.
 *
 * A tighter tolerance than a junction's: two portals can be a carriageway's width
 * apart at a divided road's end, and marking one of them entry-only should not
 * quietly mark the other one too.
 */
export function gatewayOverrideAt(
  list: ReadonlyArray<GatewayOverride>, x: number, y: number,
): GatewayOverride | null {
  let best: GatewayOverride | null = null;
  let bestD = Infinity;
  for (const candidate of list) {
    const d = Math.hypot(candidate.x - x, candidate.y - y);
    if (d < bestD && d <= 6) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

export function createDocument(seed = DEFAULT_SETTINGS.seed): EditModel {
  const gen = new IdGen(1);
  const profiles = defaultProfiles(gen);
  return {
    version: SAVE_VERSION,
    profiles,
    strokes: [],
    settings: { ...DEFAULT_SETTINGS, seed },
    terrain: { ...DEFAULT_TERRAIN },
    demand: [],
    junctions: [],
    laneLinks: [],
    gateways: [],
    underlay: null,
    geo: { ...DEFAULT_GEO },
    nextId: gen.peek(),
  };
}

export function issueId(model: EditModel): Id {
  const id = model.nextId;
  model.nextId = id + 1;
  return id;
}

export function cloneProfile(p: RoadProfile, id: Id, name?: string): RoadProfile {
  return {
    ...p,
    id,
    name: name ?? `${p.name} copy`,
    rampSpec: p.rampSpec ? { ...p.rampSpec } : undefined,
  };
}

/** Ramp spec for a profile, falling back to the library default. */
export function rampSpecOf(p: RoadProfile) {
  return p.rampSpec ?? DEFAULT_RAMP_SPEC;
}
