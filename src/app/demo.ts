/**
 * The document the app opens with.
 *
 * A freeway with an on-ramp, an off-ramp and a lane drop; an arterial crossing it
 * on a bridge; and a few streets to give the junction logic something to do. The
 * ramp ends are derived from the freeway's actual flattened curve rather than
 * guessed, so they land on it however the mainline is shaped.
 */

import {
  autoSmoothHandles, createDocument, flattenStroke, issueId, kph, makeControlPoint,
} from '../core/network/model';
import { samplePosition, sampleTangent } from '../core/geom/polyline';
import type { ControlPoint, EditModel, RoadProfile, Stroke } from '../core/network/types';

function points(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i], coords[i + 1]));
  return out;
}

function smooth(cp: ControlPoint[]): ControlPoint[] {
  autoSmoothHandles(cp);
  return cp;
}

function add(model: EditModel, profile: RoadProfile, cp: ControlPoint[], grade = 0): Stroke {
  for (const p of cp) p.grade = grade;
  const stroke: Stroke = { id: issueId(model), profileId: profile.id, points: cp };
  model.strokes.push(stroke);
  return stroke;
}

function profileNamed(model: EditModel, name: string): RoadProfile {
  return model.profiles.find((p) => p.name === name) ?? model.profiles[0];
}

interface Pose {
  x: number;
  y: number;
  /** Unit normal to the right of travel. */
  nx: number;
  ny: number;
}

/** Point and right-hand normal a fraction of the way along a stroke. */
function poseAt(stroke: Stroke, fraction: number): Pose {
  const { points: poly, arclength } = flattenStroke(stroke);
  const total = arclength[arclength.length - 1];
  const p = { x: 0, y: 0 };
  const t = { x: 1, y: 0 };
  samplePosition(poly, arclength, total * fraction, p);
  sampleTangent(poly, arclength, total * fraction, t);
  return { x: p.x, y: p.y, nx: -t.y, ny: t.x };
}

export function createDemoDocument(): EditModel {
  const model = createDocument(20260101);
  const wide = profileNamed(model, 'Freeway 3-lane (one-way)');
  const narrow = profileNamed(model, 'Freeway 2-lane (one-way)');
  const ramp = profileNamed(model, 'Ramp (one-way)');
  const arterial = profileNamed(model, 'Arterial 4-lane');
  const street = profileNamed(model, 'Residential 2-lane');
  // Freeway ramps are designed for a speed close to the mainline; the stock 60 km/h
  // ramp is a city ramp, and merging from it would be needlessly hard.
  ramp.speedLimit = kph(85);

  // Mainline: a gentle S so nothing in the demo is a straight line.
  const main = add(model, wide, smooth(points(
    -1500, 0, -900, -60, -200, 20, 500, 90, 1100, 60,
  )));

  // ...continuing as two lanes, which compiles into a lane drop with a taper.
  const end = poseAt(main, 1);
  add(model, narrow, smooth(points(
    end.x, end.y, end.x + 500, end.y - 30, end.x + 1000, end.y - 20,
  )));

  // An on-ramp joining from the kerb side, and an off-ramp leaving further along.
  const onGore = poseAt(main, 0.3);
  add(model, ramp, smooth(points(
    onGore.x - 460, onGore.y + 240,
    onGore.x - 220, onGore.y + 130,
    onGore.x, onGore.y,
  )));

  const offGore = poseAt(main, 0.72);
  add(model, ramp, smooth(points(
    offGore.x, offGore.y,
    offGore.x + 240, offGore.y + 130,
    offGore.x + 480, offGore.y + 250,
  )));

  // An arterial crossing the freeway on a bridge, with streets hanging off it. It
  // leaves the ground at either end and climbs to the crossing, so the level is on
  // the control points rather than the stroke.
  const bridge = poseAt(main, 0.52);
  const overpass = add(model, arterial, smooth(points(
    bridge.x - 40, bridge.y - 560,
    bridge.x, bridge.y - 120,
    bridge.x + 20, bridge.y + 380,
    bridge.x + 30, bridge.y + 760,
  )));
  for (const [i, g] of [0, 1, 1, 0].entries()) overpass.points[i].grade = g;

  add(model, street, points(bridge.x - 620, bridge.y + 500, bridge.x + 640, bridge.y + 540));
  add(model, street, points(bridge.x - 560, bridge.y + 505, bridge.x - 540, bridge.y + 1180));
  add(model, street, points(bridge.x + 420, bridge.y + 530, bridge.x + 450, bridge.y + 1180));

  // A second arterial at ground level, crossing both streets: a pair of junctions
  // big enough to earn left-turn pockets, which the all-way stops above are not.
  add(model, arterial, smooth(points(
    bridge.x - 900, bridge.y + 1090,
    bridge.x - 200, bridge.y + 1130,
    bridge.x + 800, bridge.y + 1100,
  )));

  // Opens flowing, with enough traffic that the merge is worth watching. The
  // traffic slider goes well past this.
  model.settings.demandScale = 0.6;
  return model;
}
