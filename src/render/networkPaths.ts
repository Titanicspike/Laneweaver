/**
 * Cached vector geometry for the compiled network.
 *
 * The compiler already emits the exact polygons and marking polylines it wants
 * drawn, so the renderer's job is only to bake them into `Path2D` objects once per
 * recompile and stroke them with the camera transform applied. Everything is
 * bucketed into tiles so a large network only pays for what is on screen.
 */

import type { Junction, Lane, Marking, Network, RoadSymbol, Segment } from '../core/network/types';
import { TurnKind } from '../core/network/types';
import { LaneKind } from '../core/network/types';
import { bboxOfPolyline, expandBbox, samplePosition, sampleTangent, type Bbox } from '../core/geom/polyline';
import { markKept, simplifyPolyline } from '../core/geom/fit';
import { WIDTHS } from './theme';
import { Mulberry32 } from '../core/util/rng';
import { pavement, planBuildings, ROOF_COLOURS, type Plot } from './buildings';

const TILE = 800; // metres

/**
 * Where the sun is, for building shadows. Down and to the right, which is the
 * convention every printed map uses and the one that reads as height rather than as
 * a smudge. Metres of shadow per storey.
 */
const LIGHT_X = 0.62;
const LIGHT_Y = 0.78;
const SHADOW_PER_STOREY = 1.35;

/** Roof fill paths per tile: every residential colour, then every shop one. */
const ROOF_SLOTS = ROOF_COLOURS.residential + ROOF_COLOURS.commercial;

export interface Tile {
  grade: number;
  /** Grade and grid cell, the same string `tiles` is keyed by. */
  key: string;
  /** Of the tile's *content*: it starts as the grid cell and grows with what is baked. */
  bounds: Bbox;
  asphalt: Path2D;
  /**
   * The outline the casing is stroked along: the asphalt, minus the end caps a road
   * continues straight through. A cap that carries on into another segment is not an
   * edge of anything, and drawing one lays a dark bar across the road — which is
   * invisible while both sides are in the same grade stack, because every casing in
   * a stack is stroked before any of its asphalt is filled, and glaring at a bridge
   * abutment, where the two halves are drawn in different stacks.
   */
  casing: Path2D;
  dashed: Path2D;
  solid: Path2D;
  double: Path2D;
  median: Path2D;
  edge: Path2D;
  stopBars: Path2D;
  /** Pedestrian crossings: one thick stroked bar per stripe. */
  zebra: Path2D;
  /** Turn arrows, baked once per recompile like every other bit of paint. */
  arrows: Path2D;
  /** Word markings, which need the text API and so cannot live in a Path2D. */
  words: RoadSymbol[];
  /**
   * Where a raised road throws its shadow, grown from the height of the road. Two
   * of them, at different distances: a single hard-edged copy reads as a second
   * road lying beside the first, and two make a falloff that reads as air.
   */
  shadow: Path2D;
  shadowFar: Path2D;
  /**
   * Made ground either side of a road that is climbing or falling — an embankment on
   * the way up, a cutting on the way down — and the hachures across it. See
   * `addEarthwork`.
   */
  earthwork: Path2D;
  slope: Path2D;
  /** Verge planting: crowns, then the lighter side of each one. */
  trees: Path2D;
  treeTops: Path2D;
  /**
   * What a zoned road puts beside itself. Roofs are split by palette entry, because
   * a fill path carries one colour and a street of identical roofs reads as a
   * diagram; `roofLit` goes over all of them and `plotEdge` outlines them.
   */
  /** Gardens behind houses, and the service yards behind shops. Not the same. */
  plotGround: Path2D;
  plotYard: Path2D;
  plotPaving: Path2D;
  roofs: Path2D[];
  /** Drop shadows, cast the same way for every building on the map. */
  roofShadow: Path2D;
  roofEdge: Path2D;
  /**
   * Whether anything was built in this tile at all.
   *
   * A tile carries thirteen separate building paths — ground, yard, paving, ten roof
   * colours, shadow, outline — and filling every one of them for a tile with no
   * buildings in it is thirteen no-op draw calls per tile per frame. On a motorway
   * with no land use anywhere that is the entire cost of the feature, paid by
   * everybody who never uses it.
   */
  built: boolean;
}


function makeTile(grade: number, gx: number, gy: number): Tile {
  return {
    grade,
    key: `${grade}|${gx}|${gy}`,
    bounds: {
      minX: gx * TILE, minY: gy * TILE,
      maxX: (gx + 1) * TILE, maxY: (gy + 1) * TILE,
    },
    asphalt: new Path2D(),
    casing: new Path2D(),
    dashed: new Path2D(),
    solid: new Path2D(),
    double: new Path2D(),
    median: new Path2D(),
    edge: new Path2D(),
    stopBars: new Path2D(),
    zebra: new Path2D(),
    arrows: new Path2D(),
    words: [],
    shadow: new Path2D(),
    shadowFar: new Path2D(),
    earthwork: new Path2D(),
    slope: new Path2D(),
    trees: new Path2D(),
    treeTops: new Path2D(),
    plotGround: new Path2D(),
    plotYard: new Path2D(),
    plotPaving: new Path2D(),
    roofs: Array.from({ length: ROOF_SLOTS }, () => new Path2D()),
    roofShadow: new Path2D(),
    roofEdge: new Path2D(),
    built: false,
  };
}

/**
 * Add a polygon to a fill path, always wound the same way.
 *
 * Canvas fills with the nonzero rule, so two overlapping rings of *opposite*
 * winding cancel and leave a hole. Nothing here ever wants a hole — the asphalt
 * layer is a union of road surfaces and junction footprints — but the footprints
 * come back from polygon-clipping with its winding, not ours, and the surfaces
 * with ours. Normalising the orientation is what makes the overlap merge instead
 * of punching through to the background.
 */
/**
 * How far a baked path may stray from the geometry it was compiled from, in metres.
 *
 * The compiler flattens to 0.15 m and then caps a flattened segment at 20 m so the
 * R-tree boxes stay tight, and the offsetter emits a point wherever its source had
 * one. The result is a straight road carrying a vertex every couple of metres that
 * says nothing: on a two-mile import the surface rings come to 142,000 points, and
 * **four fifths of them are exactly collinear**. Stroking and filling that, twice
 * over per frame, was 128 ms of a 268 ms frame — the single largest cost in the
 * renderer and all of it redundant.
 *
 * A centimetre is a quarter of a pixel at `MAX_ZOOM`, so nothing it removes could
 * ever have been seen. It is deliberately *not* a level-of-detail tolerance keyed to
 * zoom: this geometry is not needed at any zoom, and one baked path that is right
 * everywhere beats two that have to be chosen between.
 */
const BAKE_TOLERANCE = 0.01;

/**
 * A ring simplified for drawing, with its split index moved with it.
 *
 * The two runs either side of the split are simplified separately, so the corners
 * of the end caps survive exactly: simplifying across the join would cut them off.
 *
 * Only the *shape* is simplified, and only the shape may be. The shadow is grown
 * from a per-point height, and a straight bridge deck is geometrically two points —
 * so simplifying the ring the shadow is built from throws away every point that
 * carried the climb, and the shadow comes out half height at both ends and flat in
 * between, which is the opposite of a road going over something. The shadow keeps
 * the compiled ring; it costs about a millisecond a frame because only a raised
 * segment casts one at all.
 */
interface DrawRing {
  points: Float32Array;
  split: number;
}

function simplifyRing(ring: Float32Array, split: number): DrawRing {
  const n = ring.length >> 1;
  if (n < 4) return { points: ring, split };
  const keep = new Uint8Array(n);
  const cut = split > 1 && split < n - 1 ? split : n;
  markKept(ring, 0, cut - 1, BAKE_TOLERANCE, keep);
  if (cut < n) markKept(ring, cut, n - 1, BAKE_TOLERANCE, keep);

  let kept = 0;
  for (let i = 0; i < n; i++) kept += keep[i];
  const points = new Float32Array(kept * 2);
  let at = 0;
  let newSplit = cut < n ? 0 : split;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    if (cut < n && i === cut) newSplit = at;
    points[at * 2] = ring[i * 2];
    points[at * 2 + 1] = ring[i * 2 + 1];
    at++;
  }
  return { points, split: newSplit };
}

function addPolygon(path: Path2D, points: ArrayLike<number>): void {
  const n = points.length >> 1;
  if (n < 3) return;
  let twiceArea = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    twiceArea += points[j * 2] * points[i * 2 + 1] - points[i * 2] * points[j * 2 + 1];
  }
  if (twiceArea >= 0) {
    path.moveTo(points[0], points[1]);
    for (let i = 1; i < n; i++) path.lineTo(points[i * 2], points[i * 2 + 1]);
  } else {
    path.moveTo(points[(n - 1) * 2], points[(n - 1) * 2 + 1]);
    for (let i = n - 2; i >= 0; i--) path.lineTo(points[i * 2], points[i * 2 + 1]);
  }
  path.closePath();
}

function addPolyline(path: Path2D, points: ArrayLike<number>): void {
  const n = points.length >> 1;
  if (n < 2) return;
  path.moveTo(points[0], points[1]);
  for (let i = 1; i < n; i++) path.lineTo(points[i * 2], points[i * 2 + 1]);
}

/**
 * A lane arrow: one shaft, and a head for every movement the lane may make.
 *
 * Drawn to the road rather than to the screen — the glyph is a couple of metres
 * across whatever the zoom — and combined movements share a shaft, which is how a
 * "through or right" arrow is actually painted.
 */
/**
 * A lane-use arrow, built to roughly MUTCD proportions: a 0.45 m stem about 4.5 m
 * long, turn branches on a tight quarter-arc, everything inside the lane. Slightly
 * bolder than the real thing so it still reads at the zoom where it switches on.
 *
 * Every ring is wound the same way before it goes in, because the canvas fills with
 * the nonzero rule and an opposite ring would punch a hole through the overlap.
 */
function addArrow(path: Path2D, symbol: RoadSymbol): void {
  const k = Math.min(symbol.width, 3.8) / 3.5;
  const len = 4.6 * k;        // overall length along travel
  const hs = 0.2 * k;         // stem half-width
  const hw = 0.62 * k;        // head half-width
  const hl = 0.85 * k;        // head length
  const radius = 0.55 * k;    // turn arc radius
  const run = 0.15 * k;       // straight run after the arc, so the head sits square
  // How far a turn branch reaches sideways. A left-and-right arrow is symmetric and
  // cannot be shifted, so this is what has to fit inside half a lane.
  const reach = radius + run + hl;
  const cos = Math.cos(symbol.heading);
  const sin = Math.sin(symbol.heading);
  const straight = symbol.turns.includes(TurnKind.Straight);

  // A turn-only arrow is lopsided — stem on one side, head on the other — so its
  // bounding box, not its stem, is what gets centred in the lane.
  let lo = straight ? -hw : -hs;
  let hi = straight ? hw : hs;
  for (const turn of symbol.turns) {
    if (turn === TurnKind.Left) lo = Math.min(lo, -reach);
    if (turn === TurnKind.Right) hi = Math.max(hi, reach);
  }
  const shift = -(lo + hi) / 2;

  // Local frame: +u along travel, +v to the right of it (screen +y is down).
  const put = (u: number, v: number): [number, number] =>
    [symbol.x + cos * u - sin * (v + shift), symbol.y + sin * u + cos * (v + shift)];

  const emit = (local: Array<[number, number]>): void => {
    let area = 0;
    for (let i = 0; i < local.length; i++) {
      const a = local[i];
      const b = local[(i + 1) % local.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const ordered = area < 0 ? [...local].reverse() : local;
    for (let i = 0; i < ordered.length; i++) {
      const [x, y] = put(ordered[i][0], ordered[i][1]);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
  };

  /** A constant-width ribbon along `spine`, capped with an arrowhead. */
  const branch = (spine: Array<[number, number]>): void => {
    const left: Array<[number, number]> = [];
    const right: Array<[number, number]> = [];
    for (let i = 0; i < spine.length; i++) {
      const a = spine[Math.max(0, i - 1)];
      const b = spine[Math.min(spine.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const m = Math.hypot(dx, dy) || 1;
      const nx = -dy / m;
      const ny = dx / m;
      left.push([spine[i][0] + nx * hs, spine[i][1] + ny * hs]);
      right.push([spine[i][0] - nx * hs, spine[i][1] - ny * hs]);
    }
    emit([...left, ...right.reverse()]);

    const tipFrom = spine[spine.length - 2];
    const tipAt = spine[spine.length - 1];
    const dx = tipAt[0] - tipFrom[0];
    const dy = tipAt[1] - tipFrom[1];
    const m = Math.hypot(dx, dy) || 1;
    const ux = dx / m;
    const uy = dy / m;
    emit([
      [tipAt[0] - uy * hw, tipAt[1] + ux * hw],
      [tipAt[0] + uy * hw, tipAt[1] - ux * hw],
      [tipAt[0] + ux * hl, tipAt[1] + uy * hl],
    ]);
  };

  const tail = -len * 0.5;
  const turning = symbol.turns.some((t) => t !== TurnKind.Straight);
  // Branches leave a shared stem; a lane that only turns keeps a shorter one.
  const split = tail + len * (straight ? 0.46 : 0.34);

  if (straight) branch([[tail, 0], [len * 0.5 - hl, 0]]);
  else if (turning) emit([[tail, -hs], [split, -hs], [split, hs], [tail, hs]]);

  for (const turn of symbol.turns) {
    if (turn === TurnKind.Straight) continue;
    const dir = turn === TurnKind.Right ? 1 : -1;
    const spine: Array<[number, number]> = [[split, 0]];
    const STEPS = 6;
    for (let i = 1; i <= STEPS; i++) {
      const t = (Math.PI / 2) * (i / STEPS);
      spine.push([split + radius * Math.sin(t), dir * radius * (1 - Math.cos(t))]);
    }
    // A short lateral run so the head points squarely across, not off the arc.
    spine.push([split + radius, dir * (radius + run)]);
    branch(spine);
  }
}

function addMarking(tile: Tile, marking: Marking): void {
  // Paint is offset from a lane centreline and inherits its vertices, so it is as
  // over-dense as the surface is: three quarters of a marking's points are exactly
  // collinear. A zebra is short bars whose corners are the whole shape, so it is
  // left alone.
  const points = marking.style === 'zebra'
    ? marking.points : simplifyPolyline(marking.points, BAKE_TOLERANCE);
  switch (marking.style) {
    case 'dashed': addPolyline(tile.dashed, points); break;
    case 'solid': addPolyline(tile.solid, points); break;
    case 'double': addPolyline(tile.double, points); break;
    case 'median': addPolyline(tile.median, points); break;
    case 'edge': addPolyline(tile.edge, points); break;
    case 'zebra': addPolyline(tile.zebra, points); break;
  }
}

const _p = { x: 0, y: 0 };
const _t = { x: 0, y: 0 };

export class NetworkPaths {
  /** Distinct grades present, ascending, so stacks draw bottom-up. */
  readonly grades: number[] = [];

  /**
   * Bumped whenever the baked picture changes, which during decoration is most
   * frames. Anything keeping a copy of the picture — see `StaticLayer` — has to be
   * able to tell that the houses have moved on without diffing the paths.
   */
  version = 0;
  private readonly tiles = new Map<string, Tile>();
  private readonly scratch: Tile[] = [];

  /**
   * What is left to decorate — buildings and verge planting — or null once done.
   *
   * The roads are baked in the constructor, because the picture has to be right
   * the moment the network changes. The decoration is not on that path: the app
   * calls `decorate` with a time budget from its frame loop and the houses and
   * trees fill in over the next few dozen frames, which on a large town is the
   * difference between a half-second freeze at the end of every edit and none.
   * Everything else — tests, the gallery, the audit — leaves `decorate` on and
   * gets the whole picture at once, as before.
   */
  /**
   * The previous picture's houses and trees, drawn in place of this one's until
   * this one has finished decorating — everywhere except around the edit.
   *
   * Without it, taking decoration off the editing path had a side effect nobody
   * would thank us for: every edit emptied the whole map of houses and refilled it
   * over the next forty frames, which reads as "changing one road reloads the
   * entire town". The town did not change; only the road did. So the old
   * decoration stays up wherever the edit cannot have reached — a plot depends on
   * the roads within a house-depth of it and nothing further — and the area round
   * the edit fills in fresh, which is the only place anything is actually different.
   */
  private carry: { from: NetworkPaths; except: Bbox | null } | null = null;
  private readonly decoScratch: Tile[] = [];

  private pending: {
    net: Network;
    /** Built on the first slice, not in the constructor: it is decoration's. */
    buildings: { next(): Plot[] | null } | null;
    verge: Segment[];
    vergeAt: number;
    clear: ((x: number, y: number) => boolean) | null;
    budget: number;
  } | null = null;

  constructor(
    net: Network,
    options: { decorate?: boolean; carryFrom?: NetworkPaths | null; carryExcept?: Bbox | null } = {},
  ) {
    const seen = new Set<number>();
    for (const segment of net.segments) {
      seen.add(segment.grade);
      this.addSegment(net, segment);
    }
    this.pending = {
      net,
      buildings: null,
      verge: net.segments.filter((s) => s.verge > 0 && s.surface.length >= 8),
      vergeAt: 0,
      clear: null,
      budget: 24000, // trees; a backstop, not a design limit
    };
    if (options.decorate ?? true) {
      this.decorate();
    } else if (options.carryFrom) {
      // If the previous picture was itself still filling in, carry what *it* was
      // carrying — the last complete one — and keep both edits' surroundings fresh.
      const prev = options.carryFrom;
      const from = prev.decorated ? prev : prev.carry?.from ?? null;
      if (from) {
        const except = unionBbox(options.carryExcept ?? null, prev.decorated ? null : prev.carry?.except ?? null);
        this.carry = { from, except };
      }
    }
    for (const junction of net.junctions) {
      seen.add(junction.grade);
      if (junction.footprint.length >= 6) {
        const tile = this.tileFor(junction.grade, junction.x, junction.y);
        addPolygon(tile.asphalt, junction.footprint);
        addPolygon(tile.casing, simplifyPolyline(junction.footprint, BAKE_TOLERANCE));
        addShadow(tile.shadow, junction.footprint, junction.grade);
        // A gore's asphalt joins two carriageways whose markings both run through
        // it; only a crossing box hides what is underneath.
        // No cover. It used to be the junction's whole footprint, painted over the
        // markings to hide overlaps inside the box — but the footprint reaches
        // *eight metres up every approach* (its own trim plus the width of the road
        // it crosses), so what it actually hid was the last eight metres of every
        // road's lane lines, median and edge lines. Paint that stops dead a car's
        // length before the stop bar is the single thing that made every junction in
        // the network look unfinished.
        //
        // And it was hiding nothing: segments are trimmed back to the junction
        // radius, so their markings cannot reach the box interior. Measured across
        // the whole scenario zoo, *zero* marking points fall inside any crossing's
        // box. `scratch/audit.ts` now checks that rather than assuming it, so a
        // geometry that does put paint in a box is a finding instead of a silent
        // smear.
      }
      for (const marking of junction.markings) {
        const tile = this.tileFor(junction.grade, junction.x, junction.y);
        addMarking(tile, marking);
      }
      // Only a crossing has a stop line. Painting one across a merge or diverge
      // gore draws a bar straight through the middle of the road.
      if (junction.kind === 'crossing') this.addStopBars(net, junction);
    }
    this.grades = [...seen].sort((a, b) => a - b);
  }

  private tileFor(grade: number, x: number, y: number): Tile {
    const gx = Math.floor(x / TILE);
    const gy = Math.floor(y / TILE);
    const key = `${grade}|${gx}|${gy}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = makeTile(grade, gx, gy);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  private addSegment(net: Network, segment: Segment): void {
    const box = bboxOfPolyline(segment.surface);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const tile = this.tileFor(segment.grade, cx, cy);
    expandBbox(box, 2);
    tile.bounds.minX = Math.min(tile.bounds.minX, box.minX);
    tile.bounds.minY = Math.min(tile.bounds.minY, box.minY);
    tile.bounds.maxX = Math.max(tile.bounds.maxX, box.maxX);
    tile.bounds.maxY = Math.max(tile.bounds.maxY, box.maxY);

    // Once per segment: all four of these want the same ring, and simplifying it is
    // most of what makes a frame affordable (see `BAKE_TOLERANCE`).
    const ring = simplifyRing(segment.surface, segment.surfaceSplit);
    addPolygon(tile.asphalt, ring.points);
    addCasing(tile.casing, net, segment, ring);
    addShadow(tile.shadow, segment.surface, segment.surfaceHeight);
    addShadow(tile.shadowFar, segment.surface, segment.surfaceHeight, SHADOW_SPREAD);
    addEarthwork(tile.earthwork, tile.slope, segment.surface, segment.surfaceHeight,
      segment.surfaceSplit);

    for (const marking of segment.markings) addMarking(tile, marking);
    for (const symbol of segment.symbols) {
      const at = this.tileFor(segment.grade, symbol.x, symbol.y);
      if (symbol.kind === 'arrow') addArrow(at.arrows, symbol);
      else at.words.push(symbol);
    }
  }

  /**
   * Bakes the plots that `layoutBuildings` worked out into the tiles.
   *
   * All the thinking is in `buildings.ts`, which is a pure function of the network —
   * so the audit and the tests can check every rectangle without a canvas anywhere
   * near them. This end only chooses which path each polygon goes into.
   */
  /** True once every building and tree is in the tiles. */
  get decorated(): boolean {
    return this.pending === null;
  }

  /**
   * Bakes buildings and trees, a road at a time, until `budgetMs` is spent or
   * there is nothing left. Returns true when it is finished. With no budget it
   * runs to completion.
   */
  decorate(budgetMs = Infinity): boolean {
    const work = this.pending;
    if (!work) return true;
    this.version++;
    const started = budgetMs === Infinity ? 0 : performance.now();
    if (!work.buildings || !work.clear) {
      // One pavement index for both jobs: a tree in the carriageway and a house in
      // the carriageway are the same mistake, and testing for it twice in two ways
      // is how one of them survives.
      const paved = pavement(work.net);
      work.buildings = planBuildings(work.net, paved);
      work.clear = (x, y) => !paved.at(x, y);
    }
    for (;;) {
      if (budgetMs !== Infinity && performance.now() - started > budgetMs) return false;
      const batch = work.buildings.next();
      if (batch) {
        this.bakePlots(batch);
        continue;
      }
      if (work.vergeAt < work.verge.length && work.budget > 0) {
        work.budget = this.plantVerge(work.verge[work.vergeAt++], work.clear, work.budget);
        continue;
      }
      this.pending = null;
      this.carry = null;
      return true;
    }
  }

  /**
   * The tiles to draw houses and trees from for this view: this picture's own once
   * it is decorated, and until then the previous picture's wherever the edit could
   * not have reached, so that only the area round the edit visibly refills.
   */
  decorationTiles(grade: number, view: Bbox): Tile[] {
    const own = this.query(grade, view);
    const carry = this.carry;
    if (!carry) return own;
    const out = this.decoScratch;
    out.length = 0;
    const except = carry.except;
    const near = (b: Bbox): boolean => except !== null
      && !(b.minX > except.maxX || b.maxX < except.minX || b.minY > except.maxY || b.maxY < except.minY);
    const seen = new Set<string>();
    for (const tile of own) {
      const key = tileKey(tile);
      seen.add(key);
      // Round the edit the old houses may sit on the new road, and the new ones are
      // arriving: show the new picture there, incomplete as it is.
      if (near(tile.bounds)) { out.push(tile); continue; }
      out.push(carry.from.tiles.get(key) ?? tile);
    }
    // The previous picture may have decorated tiles this one has no roads in yet.
    for (const tile of carry.from.query(grade, view)) {
      if (seen.has(tileKey(tile)) || near(tile.bounds)) continue;
      out.push(tile);
    }
    return out;
  }

  private bakePlots(plots: Plot[]): void {
    for (const plot of plots) {
      const cx = plot.footprint[0];
      const cy = plot.footprint[1];
      const tile = this.tileFor(plot.grade, cx, cy);
      tile.built = true;
      const houses = plot.landUse === 'residential';
      addPolygon(houses ? tile.plotGround : tile.plotYard, plot.ground);
      if (plot.paving.length >= 6) addPolygon(tile.plotPaving, plot.paving);
      const slot = houses ? plot.palette : ROOF_COLOURS.residential + plot.palette;
      // One light direction for the whole map, so every shadow falls the same way.
      // A per-building highlight keyed to the *road* looks wrong the moment two
      // streets meet at an angle: the same terrace lit from two directions at once.
      const drop = plot.storeys * SHADOW_PER_STOREY;
      addPolygon(tile.roofShadow, offsetPolygon(plot.footprint, drop * LIGHT_X, drop * LIGHT_Y));
      addPolygon(tile.roofs[Math.min(slot, ROOF_SLOTS - 1)], plot.footprint);
      addPolygon(tile.roofEdge, plot.footprint);
    }
  }

  /**
   * Trees down the verge of every road whose profile asks for one.
   *
   * They are placed by walking the segment's own asphalt outline and stepping
   * outward, so a road that widens for a turn bay pushes its trees out with it
   * rather than growing them through the new lane. Anything that still lands on
   * pavement — a neighbouring road, a junction box — is dropped, because a tree in
   * the carriageway is the one mistake nobody would forgive.
   */
  private plantVerge(
    segment: Segment, clear: (x: number, y: number) => boolean, budget: number,
  ): number {
    const SPACING = 13;
    {
      const ring = segment.surface;
      const n = ring.length >> 1;
      const outward = ringOutwardSign(ring);
      const rng = new Mulberry32(Math.imul(segment.id + 1, 2654435761) >>> 0);
      let carry = SPACING * rng.next();
      for (let i = 0; i < n && budget > 0; i++) {
        const ax = ring[i * 2];
        const ay = ring[i * 2 + 1];
        const bx = ring[((i + 1) % n) * 2];
        const by = ring[((i + 1) % n) * 2 + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const nx = (-dy / len) * outward;
        const ny = (dx / len) * outward;
        let d = carry;
        for (; d < len; d += SPACING * (0.75 + rng.next() * 0.6)) {
          const t = d / len;
          // Crowns are sized to the verge and centred in it, so a narrow verge gets
          // small trees rather than trees overhanging the carriageway.
          const r = Math.min(2.6, segment.verge * 0.6) * (0.72 + rng.next() * 0.5);
          const off = segment.verge * 0.55 + 0.6 + (rng.next() - 0.5) * segment.verge * 0.3;
          const x = ax + dx * t + nx * off;
          const y = ay + dy * t + ny * off;
          if (!clear(x, y)) continue;
          const tile = this.tileFor(segment.grade, x, y);
          tile.trees.moveTo(x + r, y);
          tile.trees.arc(x, y, r, 0, Math.PI * 2);
          const hx = x - r * 0.22;
          const hy = y - r * 0.22;
          tile.treeTops.moveTo(hx + r * 0.55, hy);
          tile.treeTops.arc(hx, hy, r * 0.55, 0, Math.PI * 2);
          if (--budget <= 0) break;
        }
        // Carry the leftover spacing into the next edge so the rhythm survives a
        // corner instead of restarting at every vertex of the outline.
        carry = Math.max(0, d - len);
      }
    }
    return budget;
  }

  /** A bar across each incoming lane where it meets a controlled junction. */
  private addStopBars(net: Network, junction: Junction): void {
    // At a priority junction only the approaches that give way get a line — every
    // movement from them yields to something. The through road has none: painting
    // bars across it said the major road stops here, which is the one thing a
    // priority junction promises it does not, and at a right-in / right-out it
    // would put a bar across the carriageway the whole arrangement leaves alone.
    const givesWay = new Set<number>();
    if (junction.control === 'priority') {
      for (const approach of junction.approaches) {
        const movements = junction.connectorIds
          .map((id) => net.lanes[id])
          .filter((c) => approach.incomingLanes.includes(c.predecessors[0]));
        if (movements.length && movements.every((c) => c.yields)) {
          for (const lane of approach.incomingLanes) givesWay.add(lane);
        }
      }
    }
    const drawn = new Set<number>();
    for (const id of junction.connectorIds) {
      const connector = net.lanes[id];
      if (connector.kind !== LaneKind.Connector) continue;
      const from = connector.predecessors[0];
      if (from === undefined || drawn.has(from)) continue;
      if (junction.control === 'priority' && !givesWay.has(from)) continue;
      drawn.add(from);
      const lane: Lane = net.lanes[from];
      if (lane.length < 1) continue;
      samplePosition(lane.centerline, lane.arclength, lane.length - 0.4, _p);
      sampleTangent(lane.centerline, lane.arclength, Math.max(0, lane.length - 0.6), _t);
      const half = lane.width * 0.5;
      const nx = -_t.y * half;
      const ny = _t.x * half;
      const tile = this.tileFor(junction.grade, _p.x, _p.y);
      tile.stopBars.moveTo(_p.x + nx, _p.y + ny);
      tile.stopBars.lineTo(_p.x - nx, _p.y - ny);
    }
  }

  /** Tiles of one grade overlapping the view rectangle. */
  query(grade: number, view: Bbox): Tile[] {
    const out = this.scratch;
    out.length = 0;
    for (const tile of this.tiles.values()) {
      if (tile.grade !== grade) continue;
      const b = tile.bounds;
      if (b.minX > view.maxX || b.maxX < view.minX || b.minY > view.maxY || b.maxY < view.minY) continue;
      out.push(tile);
    }
    return out;
  }
}

function tileKey(tile: Tile): string {
  // Not derived from `bounds`, which grows with the tile's content and can put a
  // corner a cell over: the key the tile was made with.
  return tile.key;
}

function unionBbox(a: Bbox | null, b: Bbox | null): Bbox | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Line width in world units, never thinner than `WIDTHS.minPixels` on screen. */
export function lineWidth(world: number, zoom: number): number {
  return Math.max(world, WIDTHS.minPixels / zoom);
}

/** Even-odd point test against a closed ring. */
/** A copy of a polygon shifted by (dx, dy). */
function offsetPolygon(poly: Float32Array, dx: number, dy: number): Float32Array {
  const out = new Float32Array(poly.length);
  for (let i = 0; i < poly.length; i += 2) {
    out[i] = poly[i] + dx;
    out[i + 1] = poly[i + 1] + dy;
  }
  return out;
}

/**
 * Which side of a ring edge points away from the interior: +1 if the right-hand
 * normal does, -1 if the left-hand one does. The compiler winds its rings
 * consistently, but "consistently" is not the same as "the way this code assumes".
 */
function ringOutwardSign(ring: ArrayLike<number>): 1 | -1 {
  const n = ring.length >> 1;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return area > 0 ? -1 : 1;
}

/**
 * Does the road carry on past this end of the segment?
 *
 * The same test the portal rule uses, and for the same reason: a plain split has no
 * junction id, so "no junction here" is not the question. A lane with somewhere to
 * go is a road that continues. Lanes running against the stroke leave by the start
 * cap and arrive at the end one, so each side is asked about the direction it
 * actually travels.
 */
function capContinues(net: Network, segment: Segment, atEnd: boolean): boolean {
  for (const id of segment.laneIds) {
    const lane = net.lanes[id];
    if (!lane || lane.kind !== LaneKind.Road) continue;
    const leaves = (lane.side === 1) === atEnd;
    if (leaves ? lane.successors.length > 0 : lane.predecessors.length > 0) return true;
  }
  return false;
}

/**
 * The segment's outline with any end cap the road drives straight through left open.
 *
 * The surface ring runs up the right edge and back down the left, so the end cap is
 * the edge either side of `surfaceSplit` and the start cap is the one that closes the
 * ring. Dropping an edge from a closed ring leaves an open run starting just after
 * it; dropping both leaves the two edges on their own.
 */
function addCasing(path: Path2D, net: Network, segment: Segment, drawn: DrawRing): void {
  const ring = drawn.points;
  const n = ring.length >> 1;
  const rn = drawn.split;
  if (n < 3 || rn < 2 || rn > n - 2) {
    addPolygon(path, ring);
    return;
  }
  const openStart = capContinues(net, segment, false);
  const openEnd = capContinues(net, segment, true);
  if (!openStart && !openEnd) {
    addPolygon(path, ring);
    return;
  }
  if (openStart && openEnd) {
    run(path, ring, 0, rn);
    run(path, ring, rn, n - rn);
    return;
  }
  // One cap survives, so the outline is still a single run — it just starts after
  // whichever edge was dropped and wraps round the one that stayed.
  run(path, ring, openEnd ? rn : 0, n);
}

/** `count` points of a ring from `from`, wrapping, as one open subpath. */
function run(path: Path2D, ring: Float32Array, from: number, count: number): void {
  const n = ring.length >> 1;
  path.moveTo(ring[from * 2], ring[from * 2 + 1]);
  for (let i = 1; i < count; i++) {
    const k = (from + i) % n;
    path.lineTo(ring[k * 2], ring[k * 2 + 1]);
  }
}

/**
 * How far a road one grade up throws its shadow, in metres, and how much further
 * the outer layer of it reaches.
 *
 * It was a third of this, which on an eighteen-metre carriageway is a sliver a
 * metre and a half wide — and on a road running the same way as the light, all of
 * it hidden under the road itself. A bridge then had no cue at all beyond covering
 * up the road beneath it, which says which one is on top and nothing about why.
 */
export const SHADOW_OFFSET = { x: 2.8, y: 4.2 };
export const SHADOW_SPREAD = 1.55;

/**
 * How far the shadow moves for the *second* and later levels of a stack.
 *
 * Not linearly, which is what a real shadow does and what a four-level interchange
 * cannot afford: at level three a linear offset puts the shadow twenty metres from
 * the road that casts it, and twenty metres away it has stopped reading as a shadow
 * and started reading as another dark road. Compressing it keeps the *order* legible
 * — every level still sits above the one below — which is the only thing the shadow
 * is being asked to say.
 */
const STACK_COMPRESSION = 0.45;

function shadowHeight(h: number): number {
  return h <= 1 ? h : 1 + (h - 1) * STACK_COMPRESSION;
}

/**
 * How a slope is drawn: earthworks.
 *
 * The shadow says how *high* a road is, and it does that well. What it cannot say is
 * that the road is *changing* height — a shadow that grows along a ramp still reads,
 * at a glance, as a road that happens to be higher at one end. Everything else about
 * a change of level is a step: the parapet switches on at the half-level where the
 * segment splits, and so does the tunnel alpha, however gradual the ramp underneath.
 *
 * So the ground is drawn. A road that climbs is on an embankment and a road that
 * descends is in a cutting, and from above both are a band of made ground either side
 * of the carriageway, widening as the road gets further from the level of everything
 * around it. That is a real thing that is really there, it is continuous by
 * construction, and it is legible as a *shape* at map zoom where a line would be
 * sub-pixel. Hachures across the band — the convention every survey map uses — carry
 * it close up, and point down the slope: outward off an embankment, inward into a
 * cutting.
 *
 * Only where the road is actually sloping. A deck spanning on piers has no earthwork
 * under it, and the band stopping at the abutment is the point: that is where the
 * bridge begins, which nothing else in the picture says.
 */
const SLOPE_TICK_SPACING = 7;

/** How far the short hachure of each pair reaches, as a fraction of the long one. */
const HACHURE_SHORT = 0.5;

/** How broad a hachure is at the top of the slope, before it tapers to a point. */
const HACHURE_WIDTH = 1.1;

/** How far the made ground reaches from the kerb at one level of height. */
const EARTHWORK_PER_LEVEL = 5;

/**
 * Below this much height gained per metre travelled, a road is not sloping.
 *
 * Height is in *levels*, not metres, and how fast a road climbs one is up to whoever
 * drew it: the importer ramps over a fixed 45 m (0.022 a metre), and a hand-drawn
 * road ramps over however far apart its control points are — a quarter of a
 * two-kilometre road is 0.003. The floor has to sit under the gentlest of those, and
 * it can, because a level run is *exactly* level: heights are interpolated from the
 * control points, so a flat deck's gradient is zero rather than nearly zero and there
 * is no drift to exclude.
 *
 * It was 0.004 first, which is above a hand-drawn ramp and below an imported one — so
 * it drew nothing at all on the case built to show it off.
 */
const SLOPE_MIN_GRADIENT = 2e-4;

/** Narrower than this the band is a smudge, so that stretch is left bare. */
const EARTHWORK_MIN = 0.4;

/**
 * The made ground either side of a segment, wherever it is climbing or falling.
 *
 * The surface ring is the two edges back to back — `split` is where it turns the
 * corner — so each is walked on its own and the caps are skipped. Which way is
 * "outward" comes from the ring's own winding rather than from an assumption about
 * which edge is which: for a counter-clockwise ring the interior is on the left of
 * travel, so the outward normal is on the right, and a clockwise ring is the mirror.
 * Both edges then come out facing away from the road without having to know which is
 * which.
 */
function addEarthwork(
  band: Path2D, ticks: Path2D, ring: Float32Array, height: Float32Array, split: number,
): void {
  const n = ring.length >> 1;
  if (n < 4 || split < 2 || split > n - 2 || height.length < n) return;

  // Twice the signed area. Positive is counter-clockwise in the canvas's y-down
  // world, so the sign convention is settled here once.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  const hand = area > 0 ? 1 : -1;

  for (const [from, to] of [[0, split], [split, n]] as [number, number][]) {
    // Maximal runs of sloping edge. A run is one piece of embankment or cutting; the
    // flat deck between two of them has no made ground under it at all.
    let i = from;
    while (i < to - 1) {
      if (!sloping(ring, height, i)) { i++; continue; }
      let j = i;
      while (j < to - 1 && sloping(ring, height, j)) j++;
      addEarthworkRun(band, ticks, ring, height, i, j, hand);
      i = j + 1;
    }
  }
}

/** Whether the edge leaving vertex `i` gains enough height to be a slope. */
function sloping(ring: Float32Array, height: Float32Array, i: number): boolean {
  const dx = ring[(i + 1) * 2] - ring[i * 2];
  const dy = ring[(i + 1) * 2 + 1] - ring[i * 2 + 1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-4) return false;
  return Math.abs((height[i + 1] ?? 0) - (height[i] ?? 0)) / len >= SLOPE_MIN_GRADIENT;
}

/** One run of made ground: out along the toe of the slope, back along the kerb. */
function addEarthworkRun(
  band: Path2D, ticks: Path2D, ring: Float32Array, height: Float32Array,
  from: number, to: number, hand: number,
): void {
  // Compressed above the first level the same way the shadow is: a level-three deck
  // otherwise grows an apron wider than the road is, and what has to survive is that
  // it is sloping, not how far.
  const reach = (i: number): number =>
    shadowHeight(Math.abs(height[i] ?? 0)) * EARTHWORK_PER_LEVEL;
  if (reach(from) < EARTHWORK_MIN && reach(to) < EARTHWORK_MIN) return;

  // The made ground is *outside* the carriageway either way: an embankment is fill
  // heaped against the road and a cutting is ground left standing beside it. Putting
  // a cutting's band on the inside — which is where "point down the slope" naively
  // leads — buries the whole thing under the asphalt drawn on top of it, which is
  // exactly how the first version drew nothing at all for a tunnel.
  const nrm: [number, number] = [0, 0];
  const normal = (i: number): void => {
    const k = Math.min(i, to - 1);
    const dx = ring[(k + 1) * 2] - ring[k * 2];
    const dy = ring[(k + 1) * 2 + 1] - ring[k * 2 + 1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    nrm[0] = (dy / len) * hand;
    nrm[1] = (-dx / len) * hand;
  };

  // Out along the toe of the slope...
  for (let i = from; i <= to; i++) {
    normal(i);
    const r = reach(i);
    const x = ring[i * 2] + nrm[0] * r;
    const y = ring[i * 2 + 1] + nrm[1] * r;
    if (i === from) band.moveTo(x, y);
    else band.lineTo(x, y);
  }
  // ...and back along the kerb, which closes the band against the road.
  for (let i = to; i >= from; i--) band.lineTo(ring[i * 2], ring[i * 2 + 1]);
  band.closePath();

  // Which end of a hachure is the top of the slope, which is the only thing that
  // says embankment from cutting: a road on fill is the high side, a road in a cut
  // is the low one. A plain line cannot carry that — it looks the same drawn either
  // way — so each hachure is a thin wedge, broad at the top and pointed at the
  // bottom, which is how a survey map draws made ground and is readable at a glance.
  const cutting = (height[(from + to) >> 1] ?? 0) < 0;

  // Alternating long and short, because even ticks of one length read as sleepers —
  // a railway, which is the one thing on a map this must not be mistaken for.
  let since = SLOPE_TICK_SPACING;
  let long = true;
  for (let i = from; i <= to; i++) {
    if (i > from) {
      const dx = ring[i * 2] - ring[(i - 1) * 2];
      const dy = ring[i * 2 + 1] - ring[(i - 1) * 2 + 1];
      since += Math.sqrt(dx * dx + dy * dy);
    }
    if (since < SLOPE_TICK_SPACING) continue;
    const full = reach(i);
    if (full < EARTHWORK_MIN) continue;
    const r = full * (long ? 1 : HACHURE_SHORT);
    since = 0;
    long = !long;
    normal(i);

    // Along the road, to give the wedge its width.
    const tx = -nrm[1];
    const ty = nrm[0];
    const kerbX = ring[i * 2];
    const kerbY = ring[i * 2 + 1];
    // A short hachure hangs from the top of the slope rather than floating in the
    // middle of the band, so the row of tops stays a line the eye can follow.
    const topX = cutting ? kerbX + nrm[0] * full : kerbX;
    const topY = cutting ? kerbY + nrm[1] * full : kerbY;
    const dir = cutting ? -1 : 1;
    const w = HACHURE_WIDTH * 0.5;
    ticks.moveTo(topX + tx * w, topY + ty * w);
    ticks.lineTo(topX - tx * w, topY - ty * w);
    ticks.lineTo(topX + nrm[0] * r * dir, topY + nrm[1] * r * dir);
    ticks.closePath();
  }
}

/**
 * A raised road's shadow: the same ring, each point pushed by however high the road
 * is *there*.
 *
 * Displacing the whole shape by the segment's layer instead puts a solid block of
 * shadow across the road at every abutment, because a bridge's ends are ramps and
 * the offset copy runs on past the cap into the road it hands over to. Growing the
 * offset out of the height makes the shadow appear as the road climbs and close up
 * again as it comes down, which is both what a shadow does and continuous across
 * the joint — the segment either side of it is at the same height there.
 */
function addShadow(
  path: Path2D, ring: Float32Array, height: Float32Array | number, spread = 1,
): void {
  const n = ring.length >> 1;
  if (n < 3) return;
  const at = (i: number): number =>
    Math.max(0, typeof height === 'number' ? height : height[i] ?? 0);
  let lifted = false;
  for (let i = 0; i < n; i++) if (at(i) > 0.02) { lifted = true; break; }
  if (!lifted) return;
  for (let i = 0; i < n; i++) {
    const h = shadowHeight(at(i)) * spread;
    const x = ring[i * 2] + SHADOW_OFFSET.x * h;
    const y = ring[i * 2 + 1] + SHADOW_OFFSET.y * h;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
}
