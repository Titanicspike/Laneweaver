/**
 * Snapping while drawing and dragging.
 *
 * Three kinds, in priority order:
 *  - stroke endpoints, which also carry the tangent so an extension stays smooth;
 *  - road edges, which is how a ramp gets attached and classified as a merge;
 *  - angle snap relative to the previous point, off by default (Shift toggles).
 */

import { closestOnPolyline, makeClosestHit, sampleTangent } from '../core/geom/polyline';
import { offsetPolyline } from '../core/geom/offset';
import { levelOf, type StrokeGeometry } from '../app/store';

export type SnapKind = 'none' | 'endpoint' | 'edge' | 'angle';

export interface SnapResult {
  kind: SnapKind;
  x: number;
  y: number;
  /** Stroke the snap attached to, or -1. */
  strokeId: number;
  /** For endpoint snaps: 0 = start, 1 = end. */
  end: 0 | 1 | -1;
  /** Arc-length along that stroke for an edge snap. */
  s: number;
  /** Unit tangent at the snap point, for tangent continuity. */
  tx: number;
  ty: number;
}

export interface SnapOptions {
  /** Snap radius in world metres, normally a few pixels' worth. */
  tolerance: number;
  /** Strokes to ignore, e.g. the one being drawn. */
  exclude?: ReadonlySet<number>;
  /**
   * Only snap where the other road is on this layer; two roads at different levels
   * never connect. Asked of the *place* on the road, not of the road — a stroke
   * that climbs is at ground level at its ends and a bridge in the middle, so it
   * offers its ends to a road being drawn on the ground and its flanks to one
   * being drawn as a bridge.
   */
  level?: number;
  /** Previous point, for angle snapping. */
  fromX?: number;
  fromY?: number;
  angleSnap?: boolean;
  /** Include road-edge snapping (used when attaching ramps). */
  edges?: boolean;
}

const ANGLE_STEP = Math.PI / 12; // 15 degrees
const _hit = makeClosestHit();
const _t = { x: 0, y: 0 };

function result(): SnapResult {
  return { kind: 'none', x: 0, y: 0, strokeId: -1, end: -1, s: 0, tx: 1, ty: 0 };
}

/** Cached edge polylines, keyed by stroke id and rebuilt when geometry changes. */
const edgeCache = new WeakMap<StrokeGeometry, { left: Float32Array; right: Float32Array }>();

function edgesOf(geom: StrokeGeometry): { left: Float32Array; right: Float32Array } {
  let cached = edgeCache.get(geom);
  if (!cached) {
    cached = {
      right: offsetPolyline(geom.points, geom.arclength, geom.halfWidth).points,
      left: offsetPolyline(geom.points, geom.arclength, -geom.halfWidth).points,
    };
    edgeCache.set(geom, cached);
  }
  return cached;
}

export function snap(
  geometry: ReadonlyMap<number, StrokeGeometry>, x: number, y: number, options: SnapOptions,
): SnapResult {
  const out = result();
  out.x = x;
  out.y = y;
  const tol = options.tolerance;
  let bestDistance = tol;

  for (const [strokeId, geom] of geometry) {
    if (options.exclude?.has(strokeId)) continue;
    const n = geom.points.length >> 1;
    for (const which of [0, 1] as const) {
      const i = which === 0 ? 0 : n - 1;
      const px = geom.points[i * 2];
      const py = geom.points[i * 2 + 1];
      const d = Math.hypot(px - x, py - y);
      if (d > bestDistance) continue;
      const endS = which === 0 ? 0 : geom.length;
      if (options.level !== undefined && levelOf(geom, endS) !== options.level) continue;
      bestDistance = d;
      sampleTangent(geom.points, geom.arclength, which === 0 ? 0.01 : geom.length - 0.01, _t);
      out.kind = 'endpoint';
      out.x = px;
      out.y = py;
      out.strokeId = strokeId;
      out.end = which;
      out.s = which === 0 ? 0 : geom.length;
      out.tx = _t.x;
      out.ty = _t.y;
    }
  }
  if (out.kind === 'endpoint') return out;

  if (options.edges) {
    for (const [strokeId, geom] of geometry) {
      if (options.exclude?.has(strokeId)) continue;
      const { left, right } = edgesOf(geom);
      for (const edge of [right, left]) {
        closestOnPolyline(edge, geom.arclength, x, y, _hit);
        if (_hit.distance > bestDistance) continue;
        // The level has to be read at the point that was hit, not once for the
        // stroke: half a bridge is a ramp, and a ramp is at ground level for part
        // of its length.
        if (options.level !== undefined && levelOf(geom, _hit.s) !== options.level) continue;
        bestDistance = _hit.distance;
        sampleTangent(geom.points, geom.arclength, _hit.s, _t);
        out.kind = 'edge';
        out.x = _hit.x;
        out.y = _hit.y;
        out.strokeId = strokeId;
        out.end = -1;
        out.s = _hit.s;
        out.tx = _t.x;
        out.ty = _t.y;
      }
    }
    if (out.kind === 'edge') return out;
  }

  if (options.angleSnap && options.fromX !== undefined && options.fromY !== undefined) {
    const dx = x - options.fromX;
    const dy = y - options.fromY;
    const len = Math.hypot(dx, dy);
    if (len > 0.5) {
      const angle = Math.round(Math.atan2(dy, dx) / ANGLE_STEP) * ANGLE_STEP;
      out.kind = 'angle';
      out.x = options.fromX + Math.cos(angle) * len;
      out.y = options.fromY + Math.sin(angle) * len;
      out.tx = Math.cos(angle);
      out.ty = Math.sin(angle);
    }
  }
  return out;
}

/**
 * Closest stroke to a world point, for selection and bulldozing.
 *
 * `level` is the layer being worked on. Where a bridge crosses a road, both are
 * under the cursor and picking whichever centreline happens to be nearer is a coin
 * flip — so a road on the working level wins over one that is not, however much
 * closer the other is. It is a preference and not a filter: clicking a lone bridge
 * while the toolbar says Ground still selects the bridge, because there is nothing
 * else there and refusing would just be baffling.
 */
export function pickStroke(
  geometry: ReadonlyMap<number, StrokeGeometry>, x: number, y: number, slack = 0,
  level?: number,
): { strokeId: number; s: number; distance: number } | null {
  let best: { strokeId: number; s: number; distance: number } | null = null;
  let bestOnLevel = false;
  for (const [strokeId, geom] of geometry) {
    closestOnPolyline(geom.points, geom.arclength, x, y, _hit);
    const reach = geom.halfWidth + slack;
    if (_hit.distance > reach) continue;
    const onLevel = level === undefined || levelOf(geom, _hit.s) === level;
    if (best && bestOnLevel && !onLevel) continue;
    if (best && bestOnLevel === onLevel && _hit.distance >= best.distance) continue;
    best = { strokeId, s: _hit.s, distance: _hit.distance };
    bestOnLevel = onLevel;
  }
  return best;
}
