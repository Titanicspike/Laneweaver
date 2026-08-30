/**
 * Regressions for how a road that changes level is drawn.
 *
 * Both bugs here read as the same thing to a user — "the bridge looks disconnected
 * from the road" — and both come from treating a joint the road drives straight
 * through as if it were the end of something.
 *
 * The shadow was the whole surface translated by the segment's *layer*, so a bridge
 * threw its full offset right up to its abutment and the ground road beyond threw
 * none: a solid block of shadow lying across the road at the joint. It is now grown
 * from the road's own height at each point, which is the same on both sides there.
 *
 * The casing was stroked around the closed surface ring, end caps included. Within
 * one grade stack that never showed, because every casing in a stack is stroked
 * before any of its asphalt is filled; across two stacks the upper road's cap
 * casing landed on the finished lower one as a black bar across the carriageway.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubPath2D, callsSince } from '../helpers/canvasStub';
installCanvasGlobals();

import { NetworkPaths, SHADOW_OFFSET } from '@render/networkPaths';
import { DARK } from '@render/theme';
import { Renderer } from '@render/renderer';
import { StubCanvas, StubContext } from '../helpers/canvasStub';
import { compile } from '@core/network/compiler';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import { kph } from '@core/network/model';
import { samplePosition, sampleTangent } from '@core/geom/polyline';
import type { EditModel, Network, Segment } from '@core/network/types';

const WORLD = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };

/** A straight road that climbs to a bridge and comes back down to the ground. */
function overpass(grade: number): Network {
  const model: EditModel = doc();
  const profile = addProfile(model, {
    name: 'arterial', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
    median: 2.4, shoulder: 0.5, speedLimit: kph(70),
  });
  const stroke = addStroke(model, profile, line(0, -600, 0, 600, 4));
  [0, grade, grade, 0].forEach((g, i) => { stroke.points[i]!.grade = g; });
  return compile(model);
}

interface Subpath { points: number[]; closed: boolean }

/** Every subpath of a recorded stub path, and whether it was closed. */
function subpaths(path: unknown): Subpath[] {
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  for (const op of (path as StubPath2D).ops) {
    if (op.op === 'moveTo') {
      current = { points: [op.args[0] as number, op.args[1] as number], closed: false };
      out.push(current);
    } else if (op.op === 'lineTo' && current) {
      current.points.push(op.args[0] as number, op.args[1] as number);
    } else if (op.op === 'closePath' && current) {
      current.closed = true;
    }
  }
  return out;
}

function crosses(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < 0
    && side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0;
}

/**
 * Does any edge of the path cut across the middle of the road at this end?
 *
 * The probe is a stub of centreline running from just outside the cap to a few
 * metres inside it. A cap that is drawn crosses it; two edges running up either
 * side of the road never can.
 */
function drawsACapAt(runs: Subpath[], segment: Segment, atEnd: boolean): boolean {
  const s = atEnd ? segment.length : 0;
  const p = { x: 0, y: 0 };
  const t = { x: 0, y: 0 };
  samplePosition(segment.centerline, segment.arclength, s, p);
  sampleTangent(segment.centerline, segment.arclength, s, t);
  const sign = atEnd ? 1 : -1;
  const ax = p.x + t.x * sign * 1.5;
  const ay = p.y + t.y * sign * 1.5;
  const bx = p.x - t.x * sign * 4;
  const by = p.y - t.y * sign * 4;
  for (const sub of runs) {
    const pts = sub.points;
    const n = pts.length >> 1;
    for (let i = 1; i < n; i++) {
      const cx = pts[(i - 1) * 2]!;
      const cy = pts[(i - 1) * 2 + 1]!;
      if (crosses(ax, ay, bx, by, cx, cy, pts[i * 2]!, pts[i * 2 + 1]!)) return true;
    }
    if (sub.closed && n >= 2
      && crosses(ax, ay, bx, by, pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!, pts[0]!, pts[1]!)) {
      return true;
    }
  }
  return false;
}

/** Every subpath of one layer, across however many tiles the road is bucketed into. */
function layer(paths: NetworkPaths, grade: number, which: 'casing' | 'shadow'): Subpath[] {
  const tiles = paths.query(grade, WORLD);
  expect(tiles.length).toBeGreaterThan(0);
  return tiles.flatMap((tile) => subpaths(tile[which]));
}

/**
 * The deck's own shadow: the biggest subpath in the layer.
 *
 * Not "the one with as many points as the surface ring" — the bake simplifies the
 * geometry it draws (`BAKE_TOLERANCE`), so the drawn ring is a fifth of the compiled
 * one and matching on length silently found nothing.
 */
function deckShadow(paths: NetworkPaths, grade: number): Subpath {
  const found = layer(paths, grade, 'shadow')
    .sort((a, b) => b.points.length - a.points.length)[0];
  expect(found, `a level ${grade} deck casts a shadow`).toBeDefined();
  return found!;
}

/** How far a subpath is thrown from a ring, comparing like extremes with like. */
function displacement(cast: Subpath, ring: Float32Array): { at0: number; worst: number } {
  let castMax = -Infinity;
  let ringMax = -Infinity;
  for (let i = 0; i < cast.points.length; i += 2) castMax = Math.max(castMax, cast.points[i]!);
  for (let i = 0; i < ring.length; i += 2) ringMax = Math.max(ringMax, ring[i]!);
  // Douglas-Peucker always keeps the first point, so index zero still lines up.
  return { at0: cast.points[0]! - ring[0]!, worst: castMax - ringMax };
}

describe('a road that changes level', () => {
  it('agrees with itself about how high it is at the abutment', () => {
    const net = overpass(1);
    const climbing = net.segments.filter((s) => s.grade === 0);
    const deck = net.segments.find((s) => s.grade === 1)!;
    expect(climbing.length).toBe(2);

    // The split lands on the half-level, so both sides of the joint are half a
    // storey up there and the shadow comes out the same size either side of it.
    expect(deck.surfaceHeight[0]!).toBeCloseTo(0.5, 2);
    expect(deck.surfaceHeight[deck.surfaceHeight.length - 1]!).toBeCloseTo(0.5, 2);
    for (const ground of climbing) {
      let peak = 0;
      for (const h of ground.surfaceHeight) peak = Math.max(peak, h);
      expect(peak).toBeCloseTo(0.5, 2);
    }
  });

  it('grows the shadow out of the ground instead of laying it across the road', () => {
    const paths = new NetworkPaths(overpass(1));
    // The climbing halves are on the ground layer and still throw a shadow: that is
    // what makes the shadow continuous across the joint rather than appearing all at
    // once at it.
    expect(layer(paths, 0, 'shadow').length).toBeGreaterThan(0);

    // A road that never leaves the ground throws none at all, so the pass costs
    // nothing on level ground.
    const model = doc();
    const flat = addProfile(model, { name: 'flat', lanesForward: 1, lanesBackward: 1 });
    addStroke(model, flat, line(-300, 0, 300, 0));
    expect(layer(new NetworkPaths(compile(model)), 0, 'shadow').length).toBe(0);
  });

  it('never displaces the shadow further than the road is high', () => {
    const net = overpass(1);
    const paths = new NetworkPaths(net);
    const deck = net.segments.find((s) => s.grade === 1)!;
    const ring = deck.surface;
    // The deck's shadow is its own ring pushed by the height at each point, so at
    // the abutment — half a storey up — it is half the full offset, not all of it.
    const cast = deckShadow(paths, 1);
    expect(cast.points[0]! - ring[0]!).toBeCloseTo(SHADOW_OFFSET.x * 0.5, 2);
    expect(cast.points[1]! - ring[1]!).toBeCloseTo(SHADOW_OFFSET.y * 0.5, 2);
  });

  it('does not move the shadow four times as far for a fourth level', () => {
    // A shadow is what says which road is above which, and at a stacked interchange
    // that has to keep working four levels up. Offset linearly, a level-three deck
    // throws its shadow twenty metres clear of the road that casts it, where it has
    // stopped reading as a shadow and started reading as another dark road.
    const thrown = (grade: number): number => {
      const net = overpass(grade);
      const paths = new NetworkPaths(net);
      const deck = net.segments.find((s) => s.grade === grade)!;
      // The furthest the shadow is thrown anywhere along the deck. Point zero is at
      // the abutment, where every deck is half a level up whatever it climbs to, so
      // comparing there would compare two roads at the same height.
      return displacement(deckShadow(paths, grade), deck.surface).worst;
    };
    const one = thrown(1);
    const three = thrown(3);
    // Still ordered — a higher deck is still further out, or the stack stops reading
    // at all — but compressed well below the three times a linear offset would give.
    expect(three).toBeGreaterThan(one);
    expect(three).toBeLessThan(one * 2.2);
  });

  it('cases a raised deck as a parapet and the ground as a kerb', () => {
    // Occlusion says which road is on top and nothing about why. The parapet is the
    // cue that says the top one is carried on something, so it has to be the thing
    // that differs between a deck and the road it lands on.
    const net = overpass(1);
    const paths = new NetworkPaths(net);
    const mark = StubContext.instances.length;
    const canvas = new StubCanvas();
    const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
    renderer.camera.fit(net.bounds, 60);
    renderer.render({
      network: net, paths, sim: null, alpha: 0,
      terrain: null, underlay: null, geo: null,
      showGrid: false, showDiagnostics: false, overlays: [],
    });
    // The static picture may have been drawn into the cache's own canvas rather
    // than this one, so the question is what was stroked, not where.
    const calls = callsSince(mark);
    const styleOf = (grade: number): string | undefined => {
      const casings = new Set(paths.query(grade, WORLD).map((t) => t.casing));
      return calls.find((c) => c.op === 'stroke' && casings.has(c.args[0] as never))?.strokeStyle;
    };
    const deck = styleOf(1);
    const ground = styleOf(0);
    expect(deck).toBeDefined();
    expect(ground).toBeDefined();
    expect(deck).not.toBe(ground);
    expect(deck).toBe(DARK.bridgeParapet);
    expect(ground).toBe(DARK.casing);
  });

  it('leaves the casing open where the road drives straight through', () => {
    const net = overpass(1);
    const paths = new NetworkPaths(net);
    const deck = net.segments.find((s) => s.grade === 1)!;
    const casing = layer(paths, 1, 'casing');
    expect(drawsACapAt(casing, deck, false)).toBe(false);
    expect(drawsACapAt(casing, deck, true)).toBe(false);
    // Two runs of edge, one up each side, and neither of them closed.
    expect(casing.length).toBe(2);
    expect(casing.every((r) => !r.closed)).toBe(true);
  });

  it('still cases the end of a road that actually stops', () => {
    const net = overpass(1);
    const paths = new NetworkPaths(net);
    const casing = layer(paths, 0, 'casing');
    // Each ground segment has one free end and one joint. Exactly one is drawn.
    for (const seg of net.segments.filter((s) => s.grade === 0)) {
      const atStart = drawsACapAt(casing, seg, false);
      const atEnd = drawsACapAt(casing, seg, true);
      expect(atStart !== atEnd).toBe(true);
    }
  });

  it('strokes the casing outline and never the surface itself', () => {
    const net = overpass(1);
    const paths = new NetworkPaths(net);
    const mark = StubContext.instances.length;
    const canvas = new StubCanvas();
    const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
    renderer.camera.fit(net.bounds, 60);
    renderer.render({
      network: net, paths, sim: null, alpha: 0,
      terrain: null, underlay: null, geo: null,
      showGrid: false, showDiagnostics: false, overlays: [],
    });
    const ctx = canvas.context as unknown as StubContext;
    const stroked = new Set(
      callsSince(mark).filter((c) => c.op === 'stroke').map((c) => c.args[0]));
    const tiles = [...paths.query(0, WORLD), ...paths.query(1, WORLD)];
    expect(tiles.length).toBeGreaterThan(1);
    for (const tile of tiles) {
      // The surface is a fill, not an outline: stroking it is what drew the bar.
      expect(stroked.has(tile.asphalt)).toBe(false);
      expect(stroked.has(tile.casing)).toBe(true);
    }
    // And the round line cap is put back, or every dashed marking after it changes.
    expect(ctx.lineCap).toBe('round');
  });

  it('does the same under a tunnel, where the two halves differ in alpha too', () => {
    const net = overpass(-1);
    const paths = new NetworkPaths(net);
    const bore = net.segments.find((s) => s.grade === -1)!;
    const casing = layer(paths, -1, 'casing');
    expect(drawsACapAt(casing, bore, false)).toBe(false);
    expect(drawsACapAt(casing, bore, true)).toBe(false);
    // Nothing above a tunnel is in its shadow.
    expect(layer(paths, -1, 'shadow').length).toBe(0);
  });
});
