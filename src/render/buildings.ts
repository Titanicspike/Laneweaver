/**
 * What a zoned road puts beside itself: plots, and the buildings on them.
 *
 * This is a pure function of the compiled network — no canvas, no `Path2D` — so the
 * audit and the tests can check every rectangle it produces without rendering
 * anything. That matters more here than anywhere else in the renderer, because the
 * failure modes are all *visual* and all silent: a house standing in the road, two
 * houses in the same place, a terrace fanned around the outside of a junction. None
 * of them throw, and none of them show up in a number anybody was already watching.
 *
 * ## Plots, not scattered rectangles
 *
 * The first version walked the segment's asphalt outline and dropped a rectangle
 * every so many metres. That is wrong in three ways at once, and it produced all
 * three: the outline goes *round the end caps*, so buildings fanned across the mouth
 * of every junction; the walk restarts on every edge of a flattened polyline, so two
 * buildings could land on top of each other at a vertex; and two roads meeting at a
 * corner know nothing about each other, so their buildings interleave.
 *
 * A plot fixes all three by construction. Each side of a road is divided into
 * disjoint intervals along its own frontage — so nothing on that side can overlap
 * anything else on it — the ends are held back from the junctions, and every plot is
 * registered in a shared grid so a plot from *another* road cannot land inside one.
 *
 * ## Depth comes from the land, not from a constant
 *
 * A plot is as deep as there is room for, found by probing outward until something
 * paved gets in the way, capped at a sensible maximum. Two streets forty metres
 * apart back onto each other with twenty-metre gardens; a street on the edge of town
 * gets the full depth. It is one probe per plot and it is what stops the whole thing
 * looking like a stamped pattern.
 */

import { Mulberry32 } from '../core/util/rng';
import {
  bboxOfPolyline, samplePosition, sampleTangent, type Bbox,
} from '../core/geom/polyline';
import type { Frontage, LandUse, Network, Segment } from '../core/network/types';
import type { Id } from '../core/util/ids';

/** One property: its ground, its building, and whatever is paved in front. */
export interface Plot {
  segmentId: Id;
  landUse: LandUse;
  /** The layer it draws on: its road's. */
  grade: number;
  /** The plot boundary, kerb to rear fence — a trapezium on a curve. */
  ground: Float32Array;
  /** The building's footprint, inside the ground. */
  footprint: Float32Array;
  storeys: number;
  /** A driveway or a service yard; empty when there is none. */
  paving: Float32Array;
  /** Roof colour, as an index into the renderer's palette for this land use. */
  palette: number;
}

/** Tunables for laying plots out. Metres. */
export const PLOT = {
  /** How deep a plot may get, before the depth probe cuts it down. */
  houseDepth: 34,
  shopDepth: 30,
  /** Shallower than this and nothing is built. */
  minDepth: 13,
  /** Clear of the carriageway before anything is built. */
  kerbClearance: 1.5,
  /** The depth probe's step, and how far short of what it hits the plot stops. */
  probeStep: 2.5,
  probeMargin: 4,
  /** A backstop, not a design limit. */
  maxPlots: 20000,
} as const;

/** How many roof colours each land use has. The renderer supplies the actual ones. */
export const ROOF_COLOURS = { residential: 5, commercial: 5 } as const;

// --- small geometry helpers -------------------------------------------------------

function quad(
  cx: number, cy: number, tx: number, ty: number, along: number, deep: number,
): Float32Array {
  const hx = (tx * along) / 2;
  const hy = (ty * along) / 2;
  const px = (-ty * deep) / 2;
  const py = (tx * deep) / 2;
  return new Float32Array([
    cx - hx - px, cy - hy - py,
    cx + hx - px, cy + hy - py,
    cx + hx + px, cy + hy + py,
    cx - hx + px, cy - hy + py,
  ]);
}

function pointInRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  const n = ring.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Do two axis-aligned boxes overlap? Used only to prune before the real test. */
function boxesOverlap(a: Bbox, b: Bbox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * Separating-axis test for two convex quads.
 *
 * Plots are quads by construction — the *building* on one may be an L, but the plot
 * that reserves the ground is always a rectangle, and reserving the plot is what
 * keeps two roads' properties from interleaving at a corner.
 */
function quadsOverlap(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (const poly of [a, b]) {
    const n = poly.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly[j * 2] - poly[i * 2];
      const ay = poly[j * 2 + 1] - poly[i * 2 + 1];
      const nx = -ay;
      const ny = ax;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (let k = 0; k < a.length; k += 2) {
        const d = a[k] * nx + a[k + 1] * ny;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (let k = 0; k < b.length; k += 2) {
        const d = b[k] * nx + b[k + 1] * ny;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      if (aMax <= bMin + 1e-6 || bMax <= aMin + 1e-6) return false;
    }
  }
  return true;
}

// --- what the ground is already used for ------------------------------------------

const CELL = 60;

/** A coarse grid of everything already claimed, so placement stays linear. */
class Claimed {
  private readonly cells = new Map<number, Float32Array[]>();

  add(poly: Float32Array): void {
    const box = bboxOfPolyline(poly);
    for (let gx = Math.floor(box.minX / CELL); gx <= Math.floor(box.maxX / CELL); gx++) {
      for (let gy = Math.floor(box.minY / CELL); gy <= Math.floor(box.maxY / CELL); gy++) {
        const key = cellKey(gx, gy);
        const list = this.cells.get(key);
        if (list) list.push(poly);
        else this.cells.set(key, [poly]);
      }
    }
  }

  /** True when `poly` overlaps anything already claimed. */
  hits(poly: Float32Array): boolean {
    const box = bboxOfPolyline(poly);
    const seen = new Set<Float32Array>();
    for (let gx = Math.floor(box.minX / CELL); gx <= Math.floor(box.maxX / CELL); gx++) {
      for (let gy = Math.floor(box.minY / CELL); gy <= Math.floor(box.maxY / CELL); gy++) {
        for (const other of this.cells.get(cellKey(gx, gy)) ?? []) {
          if (seen.has(other)) continue;
          seen.add(other);
          if (!boxesOverlap(box, bboxOfPolyline(other))) continue;
          if (quadsOverlap(poly, other)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Is this point on tarmac?
 *
 * Every road surface and every junction footprint, bucketed. The same test the verge
 * planting uses, and for the same reason: a tree in the carriageway and a house in
 * the carriageway are the same mistake.
 */
/** The paved parts of the network, queryable by point and by footprint. */
export interface Pavement {
  /** Is this point on a road or in a junction box? */
  at(x: number, y: number): boolean;
  /** Does any part of this footprint lie on pavement? Exact, not sampled. */
  overlaps(poly: Float32Array): boolean;
}

export function pavement(net: Network): Pavement {
  // Each ring is stored *clipped to the cell*, not whole. A street's surface ring
  // has a vertex every metre or two — three hundred of them on a long block — and
  // dropping the whole ring into every cell its bounding box touches meant every
  // depth probe walked all three hundred edges, for every road near it. Buildings
  // probe about fifty times a plot, and a town of fifteen thousand plots spent a
  // full second on this one test: 85% of the entire bake, measured. Clipped to a
  // twelve-metre cell the same ring is six or eight edges, and the answer inside the
  // cell is identical, because clipping keeps exactly the part of the interior that
  // lies in it.
  const cells = new Map<number, Float32Array[]>();
  const put = (ring: Float32Array): void => {
    const box = bboxOfPolyline(ring);
    for (let gx = Math.floor(box.minX / CELL); gx <= Math.floor(box.maxX / CELL); gx++) {
      for (let gy = Math.floor(box.minY / CELL); gy <= Math.floor(box.maxY / CELL); gy++) {
        const piece = clipToCell(ring, gx * CELL, gy * CELL, (gx + 1) * CELL, (gy + 1) * CELL);
        if (piece.length < 6) continue;
        const key = cellKey(gx, gy);
        const list = cells.get(key);
        if (list) list.push(piece);
        else cells.set(key, [piece]);
      }
    }
  };
  for (const s of net.segments) if (s.surface.length >= 6) put(s.surface);
  for (const j of net.junctions) if (j.footprint.length >= 6) put(j.footprint);
  return {
    at(x, y) {
      const list = cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
      if (!list) return false;
      for (const ring of list) {
        if (pointInRing(ring, x, y)) return true;
      }
      return false;
    },
    // Exact rather than sampled. A footprint sampled on a grid can step straight
    // over a thin sliver of road, and sampling finely enough not to was most of what
    // the bake cost. Against the clipped pieces the exact test is cheap: a piece is
    // a handful of edges, and two polygons overlap only if an edge of one crosses an
    // edge of the other or a vertex of one lies inside the other.
    overlaps(poly) {
      const box = bboxOfPolyline(poly);
      for (let gx = Math.floor(box.minX / CELL); gx <= Math.floor(box.maxX / CELL); gx++) {
        for (let gy = Math.floor(box.minY / CELL); gy <= Math.floor(box.maxY / CELL); gy++) {
          const list = cells.get(cellKey(gx, gy));
          if (!list) continue;
          for (const piece of list) {
            if (polygonsOverlap(poly, piece)) return true;
          }
        }
      }
      return false;
    },
  };
}

/** Do two simple polygons share any area? Exact for non-convex shapes. */
function polygonsOverlap(a: Float32Array, b: Float32Array): boolean {
  const na = a.length >> 1, nb = b.length >> 1;
  for (let i = 0; i < na; i++) {
    const ax = a[i * 2], ay = a[i * 2 + 1];
    const bx = a[((i + 1) % na) * 2], by = a[((i + 1) % na) * 2 + 1];
    for (let j = 0; j < nb; j++) {
      if (segmentsCross(ax, ay, bx, by,
        b[j * 2], b[j * 2 + 1], b[((j + 1) % nb) * 2], b[((j + 1) % nb) * 2 + 1])) return true;
    }
  }
  // No edges cross: one is either inside the other or they are apart. One vertex
  // from each settles which.
  return pointInRing(b, a[0], a[1]) || pointInRing(a, b[0], b[1]);
}

function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** A single number for a grid cell, so the lookup allocates no string. */
function cellKey(gx: number, gy: number): number {
  return (gx + 0x8000) * 0x10000 + (gy + 0x8000);
}

/**
 * Sutherland–Hodgman against an axis-aligned rectangle: the part of `ring` that
 * lies inside it, as a closed polygon (possibly empty).
 */
function clipToCell(
  ring: Float32Array, minX: number, minY: number, maxX: number, maxY: number,
): Float32Array {
  let input: number[] = Array.from(ring);
  // Each edge of the rectangle in turn: keep what is inside it, adding the crossing
  // point wherever the polygon passes through.
  const passes: [number, (x: number, y: number) => number][] = [
    [minX, (x) => x - minX], [maxX, (x) => maxX - x],
    [minY, (_x, y) => y - minY], [maxY, (_x, y) => maxY - y],
  ];
  for (let pass = 0; pass < 4 && input.length >= 6; pass++) {
    const inside = passes[pass][1];
    const output: number[] = [];
    const n = input.length >> 1;
    for (let i = 0; i < n; i++) {
      const ax = input[((i + n - 1) % n) * 2], ay = input[((i + n - 1) % n) * 2 + 1];
      const bx = input[i * 2], by = input[i * 2 + 1];
      const da = inside(ax, ay), db = inside(bx, by);
      if (db >= 0) {
        if (da < 0) {
          const t = da / (da - db);
          output.push(ax + (bx - ax) * t, ay + (by - ay) * t);
        }
        output.push(bx, by);
      } else if (da >= 0) {
        const t = da / (da - db);
        output.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    input = output;
  }
  return Float32Array.from(input);
}

/**
 * Is every part of this footprint off the tarmac?
 *
 * Sampled across the whole rectangle rather than at its corners. A ten-metre shop
 * clears a corner test happily with a three-and-a-half-metre lane running through
 * its middle, and that is exactly the picture this exists to prevent.
 */
function offRoad(poly: Float32Array, road: Pavement): boolean {
  return !road.overlaps(poly);
}

// --- placing along the road -------------------------------------------------------

/**
 * The frame at a point on the segment centreline, and the kerb beside it.
 *
 * Plots are laid out from the *centreline* rather than from the asphalt outline,
 * because that is the parameterisation the compiler's frontage list uses and the one
 * the simulation reads when it puts a car on a driveway. Projecting outward to a
 * constant kerb offset also gives a straight building line down a road that widens
 * for a turn bay, which is what a real street has.
 */
interface Frame {
  x: number; y: number; tx: number; ty: number; nx: number; ny: number;
}

/**
 * The frame `offset` metres along a frontage from its centre.
 *
 * A plot round a turning head has no position along the centreline to be taken from:
 * it faces the bulb from outside, so its frame is radial and its own "along" runs
 * round the circle. Everything downstream — the trapezium of ground, the probe for
 * how deep it can go, the building laid out square to the road — works off these
 * three frames and needs no further special case.
 */
function frameOn(segment: Segment, front: Frontage, offset: number, out: Frame): void {
  const head = front.head;
  if (!head) {
    const length = segment.arclength[segment.arclength.length - 1];
    frameAt(segment, Math.min(length, Math.max(0, front.s + offset)), front.side, out);
    return;
  }
  const angle = head.angle + offset / head.radius;
  out.nx = Math.cos(angle);
  out.ny = Math.sin(angle);
  out.tx = -out.ny;
  out.ty = out.nx;
  const kerb = head.radius + PLOT.kerbClearance;
  out.x = head.cx + out.nx * kerb;
  out.y = head.cy + out.ny * kerb;
}

function frameAt(segment: Segment, s: number, side: 1 | -1, out: Frame): void {
  samplePosition(segment.centerline, segment.arclength, s, _pos);
  sampleTangent(segment.centerline, segment.arclength, s, _tan);
  out.tx = _tan.x;
  out.ty = _tan.y;
  out.nx = -_tan.y * side;
  out.ny = _tan.x * side;
  const kerb = segment.maxHalfWidth + PLOT.kerbClearance;
  out.x = _pos.x + out.nx * kerb;
  out.y = _pos.y + out.ny * kerb;
}

const _pos = { x: 0, y: 0 };
const _tan = { x: 0, y: 0 };

// --- building shapes --------------------------------------------------------------

/**
 * A footprint with a wing running back from one side, giving an L.
 *
 * Real houses are not boxes, and at map zoom the difference between a street of
 * boxes and a street of Ls is most of what makes one look drawn and the other look
 * stamped. The wing is always at the *back*, so the frontage line stays straight —
 * which is what a street of houses actually looks like from above, and what stops
 * the L from eating the front garden or the drive.
 *
 * Coordinates are (`along`, `outward`) about the building centre, with the front
 * face at `-d/2`.
 */
function ellShape(
  cx: number, cy: number, tx: number, ty: number, nx: number, ny: number,
  w: number, d: number, wingW: number, wingD: number, side: 1 | -1,
): Float32Array {
  const hw = w / 2;
  const hd = d / 2;
  const inner = side * (hw - wingW);
  const ring: number[] = [];
  const push = (a: number, b: number): void => {
    ring.push(cx + tx * a + nx * b, cy + ty * a + ny * b);
  };
  push(-hw, -hd);
  push(hw, -hd);
  if (side > 0) {
    push(hw, hd + wingD);
    push(inner, hd + wingD);
    push(inner, hd);
    push(-hw, hd);
  } else {
    push(hw, hd);
    push(inner, hd);
    push(inner, hd + wingD);
    push(-hw, hd + wingD);
  }
  return new Float32Array(ring);
}

// --- the layout -------------------------------------------------------------------

export function layoutBuildings(net: Network): Plot[] {
  const plan = planBuildings(net);
  const plots: Plot[] = [];
  for (let batch = plan.next(); batch; batch = plan.next()) plots.push(...batch);
  return plots;
}

/**
 * The same layout, one road at a time.
 *
 * Laying out a town is the largest single cost of turning a network into a
 * picture — a quarter of a second on a big one — and it is decoration: nothing
 * about editing the roads waits on it. So the app takes it a road per call and
 * spreads the calls over frames, and the picture fills in behind the cursor rather
 * than in front of it. The plots come out identical to the all-at-once layout,
 * because placement is seeded per road and claims are checked in road order either
 * way; the only difference is when the work happens.
 */
export function planBuildings(
  net: Network, paved: Pavement | null = null,
): { next(): Plot[] | null } {
  const zoned = net.segments.filter((seg) => seg.landUse && seg.frontages.length);
  if (!zoned.length) return { next: () => null };
  // The caller may already have indexed the pavement for the trees; it is the
  // same index, and building it is not free on a town.
  const onRoad = paved ?? pavement(net);
  const claimed = new Claimed();
  let index = 0;
  let placed = 0;
  return {
    next() {
      if (index >= zoned.length || placed >= PLOT.maxPlots) return null;
      const segment = zoned[index++];
      const houses = segment.landUse === 'residential';
      // Seeded per segment: the same document always draws the same street.
      const rng = new Mulberry32(Math.imul(segment.id + 104729, 2654435761) >>> 0);
      const plots: Plot[] = [];
      for (const front of segment.frontages) {
        if (placed >= PLOT.maxPlots) break;
        const plot = placePlot(segment, front, houses, rng, onRoad, claimed);
        if (plot) {
          plots.push(plot);
          claimed.add(plot.ground);
          placed++;
        }
      }
      return plots;
    },
  };
}

/**
 * Lays out one plot on one frontage, or returns null if it will not fit.
 *
 * The ground is built from the two *boundary* points rather than from a centre and a
 * width, so on a curve it comes out as the trapezium a real plot is — wider at the
 * kerb on the outside of a bend, narrower on the inside — and two neighbours share
 * one boundary line instead of having two that disagree.
 *
 * The depth is probed rather than assumed, and the plot is then tried at that depth
 * and two shallower ones. Giving up leaves a gap in the street, which is what a real
 * street has where something else is in the way — and far better than the
 * alternative, which is a house in the road.
 */
function placePlot(
  segment: Segment, front: Frontage, houses: boolean, rng: Mulberry32,
  onRoad: Pavement, claimed: Claimed,
): Plot | null {
  const length = segment.arclength[segment.arclength.length - 1];
  // Offsets from the frontage's centre, clipped to the road for a plot along it and
  // taken whole for one round a head, which is not on the road at all.
  const lo = front.head ? -front.half : Math.max(0, front.s - front.half) - front.s;
  const hi = front.head ? front.half : Math.min(length, front.s + front.half) - front.s;
  if (hi - lo < 6) return null;
  frameOn(segment, front, lo, _fa);
  frameOn(segment, front, hi, _fb);
  frameOn(segment, front, (lo + hi) / 2, _fm);

  const width = Math.hypot(_fb.x - _fa.x, _fb.y - _fa.y);
  if (width < 6) return null;
  const maxDepth = houses ? PLOT.houseDepth : PLOT.shopDepth;

  // How much room is there before something paved gets in the way? Probed at both
  // boundaries and the middle, because a road cutting a corner off a plot is
  // invisible to a single centre probe.
  let room: number = maxDepth;
  for (const f of [_fa, _fm, _fb]) {
    for (let d = 0; d <= maxDepth; d += PLOT.probeStep) {
      if (onRoad.at(f.x + f.nx * d, f.y + f.ny * d)) {
        room = Math.min(room, d - PLOT.probeMargin);
        break;
      }
    }
  }
  if (room < PLOT.minDepth) return null;

  for (const depth of [room, room * 0.72, PLOT.minDepth]) {
    if (depth < PLOT.minDepth) continue;
    const ground = new Float32Array([
      _fa.x, _fa.y,
      _fb.x, _fb.y,
      _fb.x + _fb.nx * depth, _fb.y + _fb.ny * depth,
      _fa.x + _fa.nx * depth, _fa.y + _fa.ny * depth,
    ]);
    if (claimed.hits(ground)) continue;
    // The building is laid out in the middle frame, which is square to the road.
    const cx = _fm.x + _fm.nx * (depth / 2);
    const cy = _fm.y + _fm.ny * (depth / 2);
    const built = buildOn(
      ground, cx, cy, _fm.tx, _fm.ty, _fm.nx, _fm.ny, width, depth, houses, rng, onRoad,
    );
    if (!built) continue;
    return {
      segmentId: segment.id,
      landUse: segment.landUse!,
      grade: segment.grade,
      ground,
      footprint: built.footprint,
      storeys: built.storeys,
      paving: built.paving,
      palette: built.palette,
    };
  }
  return null;
}

const _fa: Frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
const _fb: Frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
const _fm: Frame = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };

const EMPTY = new Float32Array(0);

/** Puts a building on a plot that is known to be free. */
function buildOn(
  ground: Float32Array, cx: number, cy: number, tx: number, ty: number,
  nx: number, ny: number, width: number, depth: number, houses: boolean,
  rng: Mulberry32, onRoad: Pavement,
): {
  footprint: Float32Array; storeys: number; paving: Float32Array; palette: number;
} | null {
  void ground;
  // Where the building sits within the plot, measured from the plot's front edge.
  const front = houses
    ? Math.min(depth * 0.34, 4 + rng.next() * 5)
    : Math.min(depth * 0.16, 1 + rng.next() * 2.5);
  const back = houses ? Math.max(4, depth * 0.22) : 2.5;
  const bd = Math.max(6, Math.min(houses ? 8 + rng.next() * 5 : 11 + rng.next() * 7,
    depth - front - back));
  if (bd < 5.5) return null;

  // A terrace of shops runs nearly the full frontage; houses leave room either side,
  // and more of it on one side for the drive.
  const bw = houses
    ? Math.max(6, width * (0.5 + rng.next() * 0.16))
    : Math.max(6, width * (0.84 + rng.next() * 0.12));
  const driveSide: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
  // Offset the house away from the drive, so the drive has somewhere to be.
  const shift = houses ? -driveSide * (width - bw) * 0.28 : 0;

  // Building centre, in plot coordinates: `a` along the road, `b` outward.
  const a = shift;
  const b = -depth / 2 + front + bd / 2;
  const bx = cx + tx * a + nx * b;
  const by = cy + ty * a + ny * b;

  let footprint: Float32Array;
  const shape = rng.next();
  if (houses && shape < 0.42) {
    // An L: a wing running back from one side. Kept inside the plot by construction,
    // because the wing depth is taken out of the back garden, not out of the plot.
    const wingD = Math.min(back * 0.55, 2.5 + rng.next() * 3);
    const wingW = bw * (0.34 + rng.next() * 0.2);
    footprint = ellShape(bx, by, tx, ty, nx, ny, bw, bd, wingW, wingD,
      rng.next() < 0.5 ? 1 : -1);
  } else if (!houses && shape < 0.3) {
    // A shop unit with a deeper back section — a stockroom behind the shopfront.
    const wingD = Math.min(back * 0.6, 2 + rng.next() * 3);
    footprint = ellShape(bx, by, tx, ty, nx, ny, bw, bd, bw * 0.55, wingD,
      rng.next() < 0.5 ? 1 : -1);
  } else {
    footprint = quad(bx, by, tx, ty, bw, bd);
  }
  if (!offRoad(footprint, onRoad)) return null;

  // Paving. A house gets a drive from the kerb to the front of the building; a shop
  // gets a forecourt across its whole frontage.
  let paving: Float32Array = EMPTY;
  if (houses) {
    const driveW = Math.min(3.4, (width - bw) * 0.75);
    if (driveW > 2) {
      const driveA = driveSide * (width / 2 - driveW / 2 - 0.4);
      const driveLen = front + Math.min(bd * 0.3, 2);
      const driveB = -depth / 2 + driveLen / 2;
      const candidate = quad(
        cx + tx * driveA + nx * driveB, cy + ty * driveA + ny * driveB,
        tx, ty, driveW, driveLen,
      );
      if (offRoad(candidate, onRoad)) paving = candidate;
    }
  } else if (front > 1.2) {
    const candidate = quad(
      cx + nx * (-depth / 2 + front / 2), cy + ny * (-depth / 2 + front / 2),
      tx, ty, width * 0.94, front,
    );
    if (offRoad(candidate, onRoad)) paving = candidate;
  }

  const palette = Math.floor(rng.next()
    * (houses ? ROOF_COLOURS.residential : ROOF_COLOURS.commercial));
  // Storeys drive the drop shadow, which is the only thing telling a viewer that a
  // building has height at all. A house is one or two; a shop on a high street is
  // two or three, which is why a parade reads as taller than the street behind it.
  const storeys = houses
    ? (rng.next() < 0.35 ? 1 : 2)
    : (rng.next() < 0.5 ? 2 : 3);
  return { footprint, storeys, paving, palette };
}
