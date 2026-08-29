/**
 * Save format: versioned JSON of the edit model, and nothing else.
 *
 * The compiled network is derived data and is never written. Migrations live here
 * and run in order, so an old save always loads — it never fails silently and it
 * never loads as something subtly different.
 */

import {
  DEFAULT_GEO, DEFAULT_RAMP_SPEC, DEFAULT_SETTINGS, DEFAULT_TERRAIN,
  type ControlPoint, type EditModel, type GatewayRole, type GeoSettings,
  type ImageUnderlay, type LandUse, type RoadProfile, type SignalPlanSpec,
  type SpawnMode, type Stroke, type TurnLaneChoice, type TurnLaneOverride, type ZoneChoice,
} from '../network/types';
import { SAVE_VERSION } from '../network/model';

export interface SaveFile {
  version: number;
  profiles: unknown[];
  strokes: unknown[];
  settings: Record<string, unknown>;
  terrain?: Record<string, unknown>;
  demand?: unknown[];
  junctions?: unknown[];
  laneLinks?: unknown[];
  gateways?: unknown[];
  underlay?: unknown;
  geo?: Record<string, unknown>;
  nextId?: number;
}

export class SaveError extends Error {
  override name = 'SaveError';
}

type Migration = (doc: SaveFile) => SaveFile;

/**
 * Indexed by the version being migrated *from*: add an entry here for each format
 * change, bump `SAVE_VERSION`, and never edit an existing one. Empty so far, which
 * is why the table looks lonely.
 */
const MIGRATIONS: Record<number, Migration> = {
  /**
   * v1 -> v2: level moved from the stroke onto its control points, so a road can
   * ramp between them. Every point of an old stroke takes the stroke's level.
   */
  /**
   * v2 -> v3: land use on profiles, a spawn mode on settings, and gateway roles.
   * Nothing to rewrite — every one of them is optional with a default that is the
   * old behaviour — so this exists to record that the format grew, and so a v3 file
   * carrying gateways is refused by older code rather than half-loaded without
   * them.
   */
  2: (doc) => doc,
  1: (doc) => {
    const strokes = Array.isArray(doc.strokes) ? doc.strokes : [];
    for (const raw of strokes) {
      if (!raw || typeof raw !== 'object') continue;
      const stroke = raw as Record<string, unknown>;
      const grade = Math.round(num(stroke.grade, 0));
      const points = Array.isArray(stroke.points) ? stroke.points : [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (Array.isArray(p)) {
          while (p.length < 6) p.push(0);
          p[6] = grade;
        } else if (p && typeof p === 'object') {
          (p as Record<string, unknown>).grade = grade;
        }
      }
      delete stroke.grade;
    }
    return doc;
  },
};

export function serialize(model: EditModel): string {
  return JSON.stringify(toSaveFile(model));
}

export function toSaveFile(model: EditModel): SaveFile {
  return {
    version: SAVE_VERSION,
    profiles: model.profiles.map((p) => ({ ...p, rampSpec: p.rampSpec ? { ...p.rampSpec } : undefined })),
    strokes: model.strokes.map((s) => ({
      id: s.id,
      profileId: s.profileId,
      name: s.name,
      ...(s.landUse ? { landUse: s.landUse } : {}),
      // Control points go out as flat arrays: seven numbers each instead of seven
      // keys. The level goes on the point, so one road can rise and fall.
      points: s.points.map((p) => [p.x, p.y, p.hix, p.hiy, p.hox, p.hoy, p.grade]),
    })),
    settings: { ...model.settings },
    terrain: { ...model.terrain },
    demand: model.demand.map((d) => ({ ...d })),
    junctions: model.junctions.map((j) => ({ ...j })),
    gateways: model.gateways.map((g) => ({ ...g })),
    laneLinks: model.laneLinks.map((l) => ({ x: l.x, y: l.y, links: l.links.map((k) => ({ ...k })) })),
    underlay: model.underlay ? { ...model.underlay } : null,
    geo: { ...model.geo },
    nextId: model.nextId,
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A hand-authored signal plan, read defensively.
 *
 * Timings are clamped rather than rejected, and a group name that no longer matches
 * anything is left alone: the compiler resolves names to connectors and simply
 * finds none, which shortens the phase instead of losing the plan. A plan with no
 * usable phase is dropped so the junction falls back to the automatic one rather
 * than sitting on all-red.
 */
/**
 * How many lanes a merge keeps, reading the flag this used to be.
 *
 * `addedLane: true` meant "one", which is what a flag can say — and the reason a
 * two-lane entrance had no way to keep both.
 */
/**
 * Per-approach turn-bay choices, read defensively like everything else here.
 *
 * An approach name that no longer matches anything is kept rather than dropped: the
 * road it refers to may be coming back — an undo, or a document opened against a
 * newer version of itself — and a choice that quietly deletes itself is worse than
 * one that does nothing for a while. `auto` entries are dropped, because that is
 * what an absent entry already means.
 */
function readTurnLanes(raw: unknown): { turnLanes?: TurnLaneOverride[] } {
  if (!Array.isArray(raw)) return {};
  const choices = new Set(['auto', 'none', 'left', 'right', 'both']);
  const out: TurnLaneOverride[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item.approach !== 'string') continue;
    if (typeof item.choice !== 'string' || !choices.has(item.choice)) continue;
    if (item.choice === 'auto') continue;
    out.push({ approach: item.approach, choice: item.choice as TurnLaneChoice });
  }
  return out.length ? { turnLanes: out } : {};
}

function readAddedLanes(j: Record<string, unknown>): { addedLanes?: number } {
  if (typeof j.addedLanes === 'number' && Number.isFinite(j.addedLanes)) {
    const n = Math.max(0, Math.min(8, Math.floor(j.addedLanes)));
    return n > 0 ? { addedLanes: n } : {};
  }
  return j.addedLane === true ? { addedLanes: 1 } : {};
}

function readSignalPlan(raw: unknown): { signal?: SignalPlanSpec } {
  if (!raw || typeof raw !== 'object') return {};
  const doc = raw as Record<string, unknown>;
  const phases = (Array.isArray(doc.phases) ? doc.phases : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      groups: (Array.isArray(p.groups) ? p.groups : []).filter((g): g is string => typeof g === 'string'),
      green: Math.max(1, Math.min(600, num(p.green, 26))),
      amber: Math.max(0, Math.min(20, num(p.amber, 3.5))),
      allRed: Math.max(0, Math.min(20, num(p.allRed, 1.5))),
    }))
    .filter((p) => p.groups.length > 0);
  if (!phases.length) return {};
  return {
    signal: {
      offset: Math.max(0, num(doc.offset, 0)),
      phases,
      ...(doc.actuated === true ? { actuated: true } : {}),
    },
  };
}

function readPoint(raw: unknown): ControlPoint | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const x = num(raw[0], NaN);
    const y = num(raw[1], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      x, y,
      hix: num(raw[2], x), hiy: num(raw[3], y),
      hox: num(raw[4], x), hoy: num(raw[5], y),
      grade: Math.round(num(raw[6], 0)),
    };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const x = num(o.x, NaN);
    const y = num(o.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      x, y,
      hix: num(o.hix, x), hiy: num(o.hiy, y),
      hox: num(o.hox, x), hoy: num(o.hoy, y),
      grade: Math.round(num(o.grade, 0)),
    };
  }
  return null;
}

function readProfile(raw: unknown, index: number): RoadProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = num(o.id, -1);
  if (id < 0) return null;
  const spec = o.rampSpec as Record<string, unknown> | undefined;
  return {
    id,
    name: typeof o.name === 'string' ? o.name : `Profile ${index + 1}`,
    lanesForward: Math.max(0, Math.round(num(o.lanesForward, 1))),
    lanesBackward: Math.max(0, Math.round(num(o.lanesBackward, 1))),
    laneWidth: Math.max(2, num(o.laneWidth, 3.5)),
    speedLimit: Math.max(1, num(o.speedLimit, 13.9)),
    median: Math.max(0, num(o.median, 0)),
    shoulder: Math.max(0, num(o.shoulder, 0)),
    isRamp: bool(o.isRamp, false),
    color: typeof o.color === 'string' ? o.color : undefined,
    verge: o.verge === undefined ? undefined : Math.max(0, Math.min(30, num(o.verge, 0))),
    landUse: o.landUse === 'residential' || o.landUse === 'commercial'
      ? (o.landUse as LandUse)
      : undefined,
    rampSpec: spec
      ? {
          accelLaneLength: Math.max(20, num(spec.accelLaneLength, DEFAULT_RAMP_SPEC.accelLaneLength)),
          decelLaneLength: Math.max(20, num(spec.decelLaneLength, DEFAULT_RAMP_SPEC.decelLaneLength)),
          taperLength: Math.max(10, num(spec.taperLength, DEFAULT_RAMP_SPEC.taperLength)),
        }
      : undefined,
  };
}

function readStroke(raw: unknown, validProfiles: Set<number>, fallbackProfile: number): Stroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = num(o.id, -1);
  if (id < 0) return null;
  const points: ControlPoint[] = [];
  if (Array.isArray(o.points)) {
    for (const p of o.points) {
      const cp = readPoint(p);
      if (cp) points.push(cp);
    }
  }
  if (points.length < 2) return null;
  const profileId = num(o.profileId, fallbackProfile);
  return {
    id,
    profileId: validProfiles.has(profileId) ? profileId : fallbackProfile,
    name: typeof o.name === 'string' ? o.name : undefined,
    // Zoning painted on this road. An unrecognised value is simply dropped, which
    // leaves the road inheriting its road type's — the same thing an older file does.
    landUse: o.landUse === 'residential' || o.landUse === 'commercial' || o.landUse === 'none'
      ? (o.landUse as ZoneChoice)
      : undefined,
    points,
  };
}

/** Parses and migrates a save file. Throws `SaveError` on anything unusable. */
export function deserialize(text: string): EditModel {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SaveError(`That does not look like a Laneweaver file: ${(err as Error).message}`);
  }
  return fromSaveFile(raw);
}

export function fromSaveFile(raw: unknown): EditModel {
  if (!raw || typeof raw !== 'object') throw new SaveError('Save file is empty.');
  let doc = raw as SaveFile;
  const version = num(doc.version, 0);
  if (version > SAVE_VERSION) {
    throw new SaveError(
      `This file was written by a newer version of Laneweaver (format ${version}, this build reads ${SAVE_VERSION}).`,
    );
  }
  for (let v = version; v < SAVE_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) break;
    doc = migrate(doc);
  }

  const profiles: RoadProfile[] = [];
  if (Array.isArray(doc.profiles)) {
    doc.profiles.forEach((p, i) => {
      const profile = readProfile(p, i);
      if (profile) profiles.push(profile);
    });
  }
  if (!profiles.length) throw new SaveError('Save file contains no road profiles.');

  const ids = new Set(profiles.map((p) => p.id));
  const fallback = profiles[0].id;
  const strokes: Stroke[] = [];
  if (Array.isArray(doc.strokes)) {
    for (const s of doc.strokes) {
      const stroke = readStroke(s, ids, fallback);
      if (stroke) strokes.push(stroke);
    }
  }

  const settings = (doc.settings ?? {}) as Record<string, unknown>;
  const terrain = (doc.terrain ?? {}) as Record<string, unknown>;
  let nextId = num(doc.nextId, 1);
  for (const p of profiles) nextId = Math.max(nextId, p.id + 1);
  for (const s of strokes) nextId = Math.max(nextId, s.id + 1);

  const demand = Array.isArray(doc.demand)
    ? (doc.demand as Record<string, unknown>[])
        .map((d) => ({
          fromPortal: Math.round(num(d.fromPortal, -1)),
          toPortal: Math.round(num(d.toPortal, -1)),
          rate: Math.max(0, num(d.rate, 0)),
        }))
        .filter((d) => d.fromPortal >= 0 && d.toPortal >= 0)
    : [];

  const controls = new Set(['priority', 'signal', 'allway-stop']);
  const spawnModes = new Set(['portals', 'gateways', 'landuse', 'mixed']);
  const junctions = Array.isArray(doc.junctions)
    ? (doc.junctions as Record<string, unknown>[])
        .filter((j) => typeof j.control === 'string' && controls.has(j.control))
        .map((j) => ({
          x: num(j.x, 0),
          y: num(j.y, 0),
          control: j.control as 'priority' | 'signal' | 'allway-stop',
          ...(j.optionLane === true ? { optionLane: true } : {}),
          ...readAddedLanes(j),
          ...(j.turnOnRed === false ? { turnOnRed: false } : {}),
          ...(j.rightInRightOut === true ? { rightInRightOut: true } : {}),
          ...readTurnLanes(j.turnLanes),
          ...readSignalPlan(j.signal),
        }))
    : [];

  // Which ends of the network let traffic in and out, for the gateway spawn mode.
  const roles = new Set(['both', 'entry', 'exit', 'off', 'culdesac']);
  const gateways = Array.isArray(doc.gateways)
    ? (doc.gateways as Record<string, unknown>[])
        .filter((g) => typeof g.role === 'string' && roles.has(g.role))
        .map((g) => ({ x: num(g.x, 0), y: num(g.y, 0), role: g.role as GatewayRole }))
    : [];

  // Hand-wired junction movements. A pair naming a lane that no longer exists is
  // simply dropped at compile time, so loading stays forgiving.
  const laneLinks = Array.isArray(doc.laneLinks)
    ? (doc.laneLinks as Record<string, unknown>[])
        .map((l) => ({
          x: num(l.x, 0),
          y: num(l.y, 0),
          links: (Array.isArray(l.links) ? l.links : [])
            .filter((k): k is { from: string; to: string } =>
              !!k && typeof k === 'object'
              && typeof (k as Record<string, unknown>).from === 'string'
              && typeof (k as Record<string, unknown>).to === 'string')
            .map((k) => ({ from: k.from, to: k.to })),
        }))
        .filter((l) => l.links.length > 0)
    : [];

  const underlay = readUnderlay(doc.underlay);
  const geoRaw = (doc.geo ?? {}) as Record<string, unknown>;
  const geo: GeoSettings = {
    enabled: bool(geoRaw.enabled, DEFAULT_GEO.enabled),
    lat: Math.max(-85, Math.min(85, num(geoRaw.lat, DEFAULT_GEO.lat))),
    lon: Math.max(-180, Math.min(180, num(geoRaw.lon, DEFAULT_GEO.lon))),
    tileUrl: typeof geoRaw.tileUrl === 'string' ? geoRaw.tileUrl : DEFAULT_GEO.tileUrl,
    attribution: typeof geoRaw.attribution === 'string' ? geoRaw.attribution : DEFAULT_GEO.attribution,
    opacity: Math.max(0, Math.min(1, num(geoRaw.opacity, DEFAULT_GEO.opacity))),
  };

  return {
    version: SAVE_VERSION,
    profiles,
    strokes,
    settings: {
      driveOnRight: bool(settings.driveOnRight, DEFAULT_SETTINGS.driveOnRight),
      flattenTolerance: Math.max(0.01, num(settings.flattenTolerance, DEFAULT_SETTINGS.flattenTolerance)),
      seed: Math.round(num(settings.seed, DEFAULT_SETTINGS.seed)),
      demandScale: Math.max(0, num(settings.demandScale, DEFAULT_SETTINGS.demandScale)),
      junctionRadiusScale: Math.max(0.2, num(settings.junctionRadiusScale, DEFAULT_SETTINGS.junctionRadiusScale)),
      spawnMode: typeof settings.spawnMode === 'string' && spawnModes.has(settings.spawnMode)
        ? settings.spawnMode as SpawnMode
        : DEFAULT_SETTINGS.spawnMode,
      dayLength: Math.max(0, num(settings.dayLength, DEFAULT_SETTINGS.dayLength)),
      startHour: Math.max(0, Math.min(24, num(settings.startHour, DEFAULT_SETTINGS.startHour))),
    },
    terrain: {
      enabled: bool(terrain.enabled, DEFAULT_TERRAIN.enabled),
      seed: Math.round(num(terrain.seed, DEFAULT_TERRAIN.seed)),
      featureScale: Math.max(50, num(terrain.featureScale, DEFAULT_TERRAIN.featureScale)),
      seaLevel: num(terrain.seaLevel, DEFAULT_TERRAIN.seaLevel),
      cliffSlope: Math.max(0.05, num(terrain.cliffSlope, DEFAULT_TERRAIN.cliffSlope)),
      amplitude: Math.max(0, num(terrain.amplitude, DEFAULT_TERRAIN.amplitude)),
    },
    demand,
    junctions,
    laneLinks,
    gateways,
    underlay,
    geo,
    nextId,
  };
}

function readUnderlay(raw: unknown): ImageUnderlay | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.src !== 'string' || !o.src) return null;
  return {
    src: o.src,
    x: num(o.x, 0),
    y: num(o.y, 0),
    width: Math.max(1, num(o.width, 1000)),
    height: Math.max(1, num(o.height, 1000)),
    rotation: num(o.rotation, 0),
    opacity: Math.max(0, Math.min(1, num(o.opacity, 0.7))),
    visible: bool(o.visible, true),
  };
}
