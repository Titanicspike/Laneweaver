/**
 * Terrain build constraints, surfaced as live editor diagnostics.
 *
 * Water and rivers need a bridge (grade > 0); cliff bands need a tunnel
 * (grade < 0). Kept out of the network compiler on purpose - terrain is optional,
 * and `compile()` must not depend on it.
 */

import { flattenStroke, gradeAtS } from '../network/model';
import type { Diagnostic, EditModel, Stroke } from '../network/types';
import { isCliff, isRiver, isWater, type TerrainField } from './terrain';

/** Distance between samples along a stroke, metres. */
const SAMPLE_STEP = 12;

interface Violation {
  code: string;
  message: string;
  x: number;
  y: number;
}

function scan(stroke: Stroke, field: TerrainField, tolerance: number): Violation[] {
  const { points, arclength, cpArc } = flattenStroke(stroke, tolerance);
  const total = arclength.length ? arclength[arclength.length - 1] : 0;
  if (total <= 0) return [];

  const out: Violation[] = [];
  let openCode = '';
  let hint = 0;

  const steps = Math.max(1, Math.ceil(total / SAMPLE_STEP));
  for (let k = 0; k <= steps; k++) {
    const s = (total * k) / steps;
    // Inlined sampling keeps this allocation-free over long strokes.
    while (hint < arclength.length - 2 && arclength[hint + 1] < s) hint++;
    const span = arclength[hint + 1] - arclength[hint];
    const t = span > 1e-6 ? (s - arclength[hint]) / span : 0;
    const x = points[hint * 2] + (points[hint * 2 + 2] - points[hint * 2]) * t;
    const y = points[hint * 2 + 1] + (points[hint * 2 + 3] - points[hint * 2 + 1]) * t;

    // The level is a property of the point on the road, not of the road: a stroke
    // that ramps up over a river is only in violation where it is still down.
    const grade = gradeAtS(stroke, cpArc, s);
    let code = '';
    let message = '';
    if (grade <= 0 && (isWater(field, x, y) || isRiver(field, x, y))) {
      code = 'road-over-water';
      message = 'This road crosses water. Raise it to a bridge.';
    } else if (grade >= 0 && isCliff(field, x, y)) {
      code = 'road-through-cliff';
      message = 'This road cuts through a cliff. Sink it to a tunnel.';
    }

    // One diagnostic per continuous run, marked where the run begins.
    if (code && code !== openCode) out.push({ code, message, x, y });
    openCode = code;
  }
  return out;
}

export function checkTerrainConstraints(model: EditModel, field: TerrainField | null): Diagnostic[] {
  if (!field || !field.settings.enabled) return [];
  const out: Diagnostic[] = [];
  for (const stroke of model.strokes) {
    for (const v of scan(stroke, field, model.settings.flattenTolerance)) {
      out.push({
        severity: 'error',
        code: v.code,
        message: v.message,
        x: v.x,
        y: v.y,
        strokeId: stroke.id,
      });
    }
  }
  return out;
}

/** True when a stroke at this grade could legally be built at that point. */
export function canBuildAt(field: TerrainField | null, grade: number, x: number, y: number): boolean {
  if (!field || !field.settings.enabled) return true;
  if (grade <= 0 && (isWater(field, x, y) || isRiver(field, x, y))) return false;
  if (grade >= 0 && isCliff(field, x, y)) return false;
  return true;
}
