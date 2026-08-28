/**
 * Compile step 1: flatten every stroke and cache what later steps need.
 */

import { flattenStroke, gradeAtS, profileHalfWidth, requireProfile } from '../model';
import type { EditModel, RoadProfile, Stroke } from '../types';

export interface PreparedStroke {
  index: number;
  stroke: Stroke;
  profile: RoadProfile;
  points: Float32Array;
  arclength: Float32Array;
  /** Arc-length of each control point, so the level can be read off at any `s`. */
  cpArc: Float32Array;
  length: number;
  halfWidth: number;
  /** Level at arc-length `s`, ramping between control points. */
  gradeAt(s: number): number;
  /** Level rounded to the layer it is drawn on. */
  levelAt(s: number): number;
}

export function prepareStrokes(model: EditModel): PreparedStroke[] {
  const out: PreparedStroke[] = [];
  // Stable order: strokes are already in document order, which the editor keeps
  // deterministic. Ties anywhere downstream break on stroke id.
  const sorted = [...model.strokes].sort((a, b) => a.id - b.id);
  for (let i = 0; i < sorted.length; i++) {
    const stroke = sorted[i];
    const profile = requireProfile(model, stroke.profileId);
    const { points, arclength, cpArc } = flattenStroke(stroke, model.settings.flattenTolerance);
    if (points.length < 4) continue; // a stroke needs at least two distinct points
    out.push({
      index: out.length,
      stroke,
      profile,
      points,
      arclength,
      cpArc,
      length: arclength[arclength.length - 1],
      halfWidth: profileHalfWidth(profile),
      gradeAt: (s: number) => gradeAtS(stroke, cpArc, s),
      levelAt: (s: number) => Math.round(gradeAtS(stroke, cpArc, s)),
    });
  }
  return out;
}
