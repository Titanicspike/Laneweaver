import { createDocument, issueId, makeControlPoint, autoSmoothHandles, kph } from '@core/network/model';
import type { ControlPoint, EditModel, RoadProfile, Stroke } from '@core/network/types';

export function doc(seed = 1): EditModel {
  return createDocument(seed);
}

export function setJunctionControl(
  model: EditModel, x: number, y: number, control: 'priority' | 'signal' | 'allway-stop',
): void {
  model.junctions.push({ x, y, control });
}

export function profileNamed(model: EditModel, name: string): RoadProfile {
  const p = model.profiles.find((x) => x.name === name);
  if (!p) throw new Error(`no profile named ${name}; have ${model.profiles.map((x) => x.name).join(', ')}`);
  return p;
}

/** Adds a custom profile and returns it. */
export function addProfile(model: EditModel, spec: Partial<RoadProfile> & { name: string }): RoadProfile {
  const profile: RoadProfile = {
    id: issueId(model),
    lanesForward: 1,
    lanesBackward: 0,
    laneWidth: 3.65,
    speedLimit: kph(100),
    median: 0,
    shoulder: 1,
    isRamp: false,
    ...spec,
  };
  model.profiles.push(profile);
  return profile;
}

export function pts(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i], coords[i + 1]));
  return out;
}

export function smooth(points: ControlPoint[]): ControlPoint[] {
  autoSmoothHandles(points);
  return points;
}

export function addStroke(
  model: EditModel, profile: RoadProfile, points: ControlPoint[], grade = 0,
): Stroke {
  for (const p of points) p.grade = grade;
  const stroke: Stroke = { id: issueId(model), profileId: profile.id, points };
  model.strokes.push(stroke);
  return stroke;
}

/** Points along a straight line, `count` control points inclusive of both ends. */
export function line(x0: number, y0: number, x1: number, y1: number, count = 2): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(makeControlPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
  }
  return out;
}
