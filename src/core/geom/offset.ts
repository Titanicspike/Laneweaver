/**
 * Polyline offsetting.
 *
 * Lane centrelines are offsets of their segment centreline. There are no analytic
 * curve offsets here by design ("sample, don't solve"): we offset vertices along
 * mitred normals, then repair the two failure modes that offsetting always has —
 * inverted segments (cusps) and self-intersection loops on the inside of tight
 * curves. See the "offset cusps" tarpit note in CLAUDE.md.
 *
 * Convention: positive distance offsets to the **right** of the travel direction.
 */

import { EPS } from './vec2';
import { segmentIntersect, makeSegHit } from './intersect';

export interface OffsetOptions {
  /** Cap on the mitre extension, as a multiple of |distance|. */
  miterLimit?: number;
  /** Search window (in vertices) for self-intersection loops. */
  loopWindow?: number;
  /** Skip loop repair (faster; only safe for gentle curves). */
  skipLoopRepair?: boolean;
}

export interface OffsetResult {
  points: Float32Array;
  /** Arc-length on the *source* polyline for each output point. */
  sourceS: Float32Array;
  /** Vertices removed by cusp/loop repair. */
  culled: number;
  /**
   * Worst ratio of |offset| to the local turning radius on the inside of a curve.
   * Above 1 the true offset would be degenerate and the result was repaired.
   */
  worstRatio: number;
}

const DEFAULT_MITER_LIMIT = 4;
const DEFAULT_LOOP_WINDOW = 32;

/**
 * Offset-to-radius ratio below which a mitred offset cannot have folded on itself.
 * A little under one, because these are sampled polylines rather than curves.
 */
const LOOP_SAFE_RATIO = 0.9;

/** Offsets by a constant distance. */
export function offsetPolyline(
  poly: ArrayLike<number>, arc: ArrayLike<number>, distance: number, opts?: OffsetOptions,
): OffsetResult {
  return offsetPolylineVariable(poly, arc, () => distance, opts);
}

/**
 * Offsets by a distance that varies along the source arc-length — how tapers are
 * built. `distanceAt` receives the source arc-length and the vertex index.
 */
export function offsetPolylineVariable(
  poly: ArrayLike<number>,
  arc: ArrayLike<number>,
  distanceAt: (s: number, index: number) => number,
  opts: OffsetOptions = {},
): OffsetResult {
  const n = poly.length >> 1;
  const miterLimit = opts.miterLimit ?? DEFAULT_MITER_LIMIT;

  if (n < 2) {
    return {
      points: Float32Array.from(poly),
      sourceS: Float32Array.from(arc),
      culled: 0,
      worstRatio: 0,
    };
  }

  // --- pass A: mitred vertex offsets -------------------------------------------
  // Scratch buffers rather than four fresh typed arrays per call. Offsetting is the
  // single most-called piece of geometry in the compiler — a town-sized document
  // runs it four thousand times over a hundred and fifty thousand vertices — so the
  // allocations alone were showing up as garbage collection. Safe to share: this
  // function runs to completion before it returns, and it copies its results into
  // fresh arrays at the end.
  const ox = scratchF64(0, n);
  const oy = scratchF64(1, n);
  const ss = scratchF64(2, n);
  const alive = scratchU8(n);
  alive.fill(1, 0, n);
  let worstRatio = 0;

  for (let i = 0; i < n; i++) {
    const d = distanceAt(arc[i], i);
    ss[i] = arc[i];

    // Directions of the incoming and outgoing segments (equal at the ends).
    let inx = 0, iny = 0, outx = 0, outy = 0;
    if (i > 0) {
      inx = poly[i * 2] - poly[i * 2 - 2];
      iny = poly[i * 2 + 1] - poly[i * 2 - 1];
      const l = Math.sqrt(inx * inx + iny * iny) || 1;
      inx /= l; iny /= l;
    }
    if (i < n - 1) {
      outx = poly[i * 2 + 2] - poly[i * 2];
      outy = poly[i * 2 + 3] - poly[i * 2 + 1];
      const l = Math.sqrt(outx * outx + outy * outy) || 1;
      outx /= l; outy /= l;
    }
    if (i === 0) { inx = outx; iny = outy; }
    if (i === n - 1) { outx = inx; outy = iny; }

    // Right-hand normals of each segment, then the bisector.
    const nix = -iny, niy = inx;
    const nox = -outy, noy = outx;
    let bx = nix + nox;
    let by = niy + noy;
    let bl = Math.sqrt(bx * bx + by * by);
    if (bl < 1e-6) {
      // 180-degree reversal: fall back to the incoming normal.
      bx = nix; by = niy; bl = 1;
    }
    bx /= bl; by /= bl;

    // Mitre length: 1 / cos(half turn angle).
    const cosHalf = bx * nix + by * niy;
    let scale = cosHalf > 1e-4 ? 1 / cosHalf : miterLimit;
    if (scale > miterLimit) scale = miterLimit;

    // Inside-of-curve check: the offset collapses when |d| approaches the radius.
    const turn = inx * outy - iny * outx; // >0 turns one way, <0 the other
    if (Math.abs(turn) > 1e-6) {
      let chord = 0;
      if (i > 0 && i < n - 1) {
        const ax = poly[i * 2] - poly[i * 2 - 2];
        const ay = poly[i * 2 + 1] - poly[i * 2 - 1];
        const bx2 = poly[i * 2 + 2] - poly[i * 2];
        const by2 = poly[i * 2 + 3] - poly[i * 2 + 1];
        chord = 0.5 * (Math.sqrt(ax * ax + ay * ay) + Math.sqrt(bx2 * bx2 + by2 * by2));
      }
      if (chord > EPS) {
        const angle = Math.asin(Math.max(-1, Math.min(1, turn)));
        const radius = Math.abs(angle) > 1e-6 ? chord / Math.abs(angle) : Infinity;
        // Offsetting toward the inside means d and turn have opposite signs.
        if (d * turn < 0 && radius > EPS) {
          const ratio = Math.abs(d) / radius;
          if (ratio > worstRatio) worstRatio = ratio;
        }
      }
    }

    ox[i] = poly[i * 2] + bx * d * scale;
    oy[i] = poly[i * 2 + 1] + by * d * scale;
  }

  // --- pass B: drop inverted vertices ------------------------------------------
  // A segment whose offset direction opposes its source direction has folded over.
  // Removing the shorter side of the fold repeatedly converges quickly.
  for (let sweep = 0; sweep < 4; sweep++) {
    let changed = false;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      if (prev >= 0) {
        const sdx = poly[i * 2] - poly[prev * 2];
        const sdy = poly[i * 2 + 1] - poly[prev * 2 + 1];
        const odx = ox[i] - ox[prev];
        const ody = oy[i] - oy[prev];
        if (sdx * odx + sdy * ody < 0) {
          // Fold: drop whichever endpoint is not an end of the polyline.
          const victim = i < n - 1 ? i : prev > 0 ? prev : -1;
          if (victim >= 0) {
            alive[victim] = 0;
            changed = true;
            if (victim === i) continue; // keep `prev`, re-test against the next vertex
          }
        }
      }
      prev = i;
    }
    if (!changed) break;
  }

  // Compact.
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    ox[m] = ox[i];
    oy[m] = oy[i];
    ss[m] = ss[i];
    m++;
  }

  const culledCount = n - m;

  // --- pass C: repair self-intersection loops ----------------------------------
  // Loop repair is a windowed all-pairs segment test, and on a road that did not
  // fold it finds nothing after doing all of the work — which is most roads, most of
  // the time. An offset closer than the radius of curvature cannot cusp, and pass B
  // above reports whether anything actually folded, so the two together say when
  // there is nothing to look for. The margin is because these are sampled polylines
  // rather than curves, and the window is local, so this only ever rules out the
  // local folds it was looking for in the first place.
  const mayHaveFolded = culledCount > 0 || worstRatio >= LOOP_SAFE_RATIO;
  if (!opts.skipLoopRepair && m > 3 && mayHaveFolded) {
    m = repairLoops(ox, oy, ss, m, opts.loopWindow ?? DEFAULT_LOOP_WINDOW);
  }

  const points = new Float32Array(m * 2);
  const sourceS = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    points[i * 2] = ox[i];
    points[i * 2 + 1] = oy[i];
    sourceS[i] = ss[i];
  }
  return { points, sourceS, culled: n - m, worstRatio };
}

/**
 * Growable scratch buffers for the offsetter's three vertex arrays and its liveness
 * flags. `Math.hypot` is avoided in the same loops for the same reason: it is several
 * times the cost of the equivalent `sqrt` in V8 because it guards against overflow,
 * and world coordinates are metres, where there is none to guard against.
 */
const _f64: Float64Array[] = [new Float64Array(0), new Float64Array(0), new Float64Array(0)];
let _u8 = new Uint8Array(0);

function scratchF64(slot: number, n: number): Float64Array {
  if (_f64[slot].length < n) _f64[slot] = new Float64Array(Math.max(n, 256));
  return _f64[slot];
}

function scratchU8(n: number): Uint8Array {
  if (_u8.length < n) _u8 = new Uint8Array(Math.max(n, 256));
  return _u8;
}

const _hit = makeSegHit();

/**
 * Removes loops by finding the first pair of non-adjacent segments that cross,
 * splicing in the crossing point, and restarting from there. Bounded by `window`
 * so cost stays linear in practice.
 */
function repairLoops(
  ox: Float64Array, oy: Float64Array, ss: Float64Array, count: number, window: number,
): number {
  let m = count;
  let guard = 0;
  let i = 0;
  while (i < m - 2 && guard++ < 4096) {
    const limit = Math.min(m - 1, i + window);
    let found = -1;
    for (let j = i + 2; j < limit; j++) {
      if (segmentIntersect(
        ox[i], oy[i], ox[i + 1], oy[i + 1],
        ox[j], oy[j], ox[j + 1], oy[j + 1],
        _hit,
      )) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      i++;
      continue;
    }
    // Collapse vertices i+1 .. found into the crossing point.
    const sMid = ss[i] + (ss[found + 1] - ss[i]) * 0.5;
    ox[i + 1] = _hit.x;
    oy[i + 1] = _hit.y;
    ss[i + 1] = sMid;
    const removed = found - (i + 1);
    if (removed > 0) {
      ox.copyWithin(i + 2, found + 1, m);
      oy.copyWithin(i + 2, found + 1, m);
      ss.copyWithin(i + 2, found + 1, m);
      m -= removed;
    }
    i++;
  }
  return m;
}

/**
 * Builds the closed polygon of a corridor of half-width `half` around a centreline:
 * the right offset forward, then the left offset back. Used for road footprints and
 * junction covers.
 */
export function corridorPolygon(
  poly: ArrayLike<number>, arc: ArrayLike<number>, half: number,
): Float32Array {
  const right = offsetPolyline(poly, arc, half);
  const left = offsetPolyline(poly, arc, -half);
  const rn = right.points.length >> 1;
  const ln = left.points.length >> 1;
  const out = new Float32Array((rn + ln) * 2);
  for (let i = 0; i < rn; i++) {
    out[i * 2] = right.points[i * 2];
    out[i * 2 + 1] = right.points[i * 2 + 1];
  }
  for (let i = 0; i < ln; i++) {
    const src = ln - 1 - i;
    out[(rn + i) * 2] = left.points[src * 2];
    out[(rn + i) * 2 + 1] = left.points[src * 2 + 1];
  }
  return out;
}
