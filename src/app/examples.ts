/**
 * Worked examples: documents that show the compiler and the traffic model doing
 * something worth looking at.
 *
 * These are not test fixtures. A fixture exists to break in a particular way; these
 * exist to be opened, run and edited, so each one is a *real* piece of road network
 * built the way a user would build it — strokes with profiles, ramps drawn onto
 * freeway edges, grades set on control points — rather than a pile of geometry that
 * happens to compile.
 *
 * The interchanges are the reason this file exists. A diamond, a trumpet and a
 * cloverleaf between them exercise every ramp shape, both gore kinds, stacked
 * grades, weaving sections and signalised ramp terminals; if the compiler is going
 * to be wrong about a junction, it will be wrong about one of these. Every example
 * is asserted to compile without errors and to run without losing anybody.
 */

import {
  autoSmoothHandles, createDocument, flattenStroke, issueId, kph, makeControlPoint,
} from '../core/network/model';
import { samplePosition, sampleTangent } from '../core/geom/polyline';
import type {
  ControlPoint, EditModel, Grade, RoadProfile, Stroke,
} from '../core/network/types';

// --- building blocks ------------------------------------------------------------

function pts(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i]!, coords[i + 1]!));
  autoSmoothHandles(out);
  return out;
}

/** Straight run, with `n` control points so a grade can vary along it. */
function line(x0: number, y0: number, x1: number, y1: number, n = 2): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(makeControlPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
  }
  autoSmoothHandles(out);
  return out;
}


function add(model: EditModel, profile: RoadProfile, cp: ControlPoint[], grade: Grade = 0): Stroke {
  for (const p of cp) p.grade = grade;
  const stroke: Stroke = { id: issueId(model), profileId: profile.id, points: cp };
  model.strokes.push(stroke);
  return stroke;
}

/** Sets the grade of a run of control points, so one stroke can rise and fall. */
function grades(stroke: Stroke, ...levels: Grade[]): Stroke {
  for (let i = 0; i < stroke.points.length; i++) {
    stroke.points[i]!.grade = levels[Math.min(i, levels.length - 1)]!;
  }
  return stroke;
}

interface Pose {
  x: number;
  y: number;
  /** Unit tangent along travel. */
  tx: number;
  ty: number;
  /** Unit normal to the right of travel. */
  nx: number;
  ny: number;
}

/**
 * Point, tangent and right-hand normal a fraction of the way along a stroke.
 *
 * Ramp ends are derived from the mainline's own flattened curve rather than
 * guessed. Guessing works right up until the mainline is not a straight line, and
 * then the ramp lands ninety metres off the carriageway, gets classified as a
 * crossing or as nothing at all, and the interchange quietly stops being one.
 */
function poseAt(stroke: Stroke, fraction: number): Pose {
  const { points: poly, arclength } = flattenStroke(stroke);
  const total = arclength[arclength.length - 1]!;
  const p = { x: 0, y: 0 };
  const t = { x: 1, y: 0 };
  samplePosition(poly, arclength, total * fraction, p);
  sampleTangent(poly, arclength, total * fraction, t);
  return { x: p.x, y: p.y, tx: t.x, ty: t.y, nx: -t.y, ny: t.x };
}

/** A point `along` metres down the road from a pose and `off` metres to its right. */
function at(pose: Pose, along: number, off: number): [number, number] {
  return [pose.x + pose.tx * along + pose.nx * off, pose.y + pose.ty * along + pose.ny * off];
}

/** Half the paved width of a profile, which is where a ramp meets it. */
function edgeOf(p: RoadProfile): number {
  return ((p.lanesForward + p.lanesBackward) * p.laneWidth + (p.lanesBackward ? p.median : 0)) / 2;
}

/**
 * A ramp running from one place and heading to another, sampled as control points.
 *
 * Hermite rather than hand-placed arcs. Arcs read fine until an interchange has to
 * be adjusted, at which point every one of them has to be recomputed by hand and
 * the odds of a ramp landing ninety metres off the carriageway go to one. Giving
 * both ends a position and a direction and letting the curve work itself out is
 * easier to read and much harder to get subtly wrong.
 */
function connect(
  a: readonly [number, number], aDir: readonly [number, number],
  b: readonly [number, number], bDir: readonly [number, number],
  n = 9, reach = 150,
): ControlPoint[] {
  // `reach` is how far the curve holds each end's heading, in metres, and it is
  // capped rather than a fraction of the span on purpose. A fraction gives a long
  // ramp a three-hundred-metre tangent, so it leaves the mainline at six degrees
  // and runs alongside it for half a kilometre — which the compiler correctly
  // refuses as a near-parallel overlap rather than building a sliver junction.
  const span = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.5, reach);
  const scaled = (d: readonly [number, number]): [number, number] => {
    const len = Math.hypot(d[0], d[1]) || 1;
    return [(d[0] / len) * span, (d[1] / len) * span];
  };
  const m0 = scaled(aDir);
  const m1 = scaled(bDir);
  const out: ControlPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const t2 = t * t;
    const t3 = t2 * t;
    out.push(makeControlPoint(
      (2 * t3 - 3 * t2 + 1) * a[0] + (t3 - 2 * t2 + t) * m0[0]
        + (-2 * t3 + 3 * t2) * b[0] + (t3 - t2) * m1[0],
      (2 * t3 - 3 * t2 + 1) * a[1] + (t3 - 2 * t2 + t) * m0[1]
        + (-2 * t3 + 3 * t2) * b[1] + (t3 - t2) * m1[1],
    ));
  }
  autoSmoothHandles(out);
  return out;
}

function profile(model: EditModel, spec: Partial<RoadProfile> & { name: string }): RoadProfile {
  const p: RoadProfile = {
    id: issueId(model), lanesForward: 1, lanesBackward: 0, laneWidth: 3.65,
    speedLimit: kph(100), median: 0, shoulder: 1.5, isRamp: false, ...spec,
  };
  model.profiles.push(p);
  return p;
}

interface Kit {
  freeway: RoadProfile;
  freewayWide: RoadProfile;
  ramp: RoadProfile;
  ramp2: RoadProfile;
  arterial: RoadProfile;
  collector: RoadProfile;
  street: RoadProfile;
  highStreet: RoadProfile;
}

/** The road types every example is drawn with. */
function kit(model: EditModel): Kit {
  return {
    freeway: profile(model, {
      name: 'Freeway 3-lane (one-way)', lanesForward: 3, shoulder: 2.5, speedLimit: kph(110),
    }),
    freewayWide: profile(model, {
      name: 'Freeway 4-lane (one-way)', lanesForward: 4, shoulder: 2.5, speedLimit: kph(110),
    }),
    ramp: profile(model, {
      name: 'Ramp', lanesForward: 1, laneWidth: 4.2, shoulder: 1.2,
      speedLimit: kph(75), isRamp: true,
    }),
    ramp2: profile(model, {
      name: 'Ramp 2-lane', lanesForward: 2, laneWidth: 3.8, shoulder: 1.2,
      speedLimit: kph(70), isRamp: true,
    }),
    arterial: profile(model, {
      name: 'Arterial 4-lane', lanesForward: 2, lanesBackward: 2, laneWidth: 3.5,
      median: 2.4, shoulder: 0.8, speedLimit: kph(70), verge: 2.5,
    }),
    collector: profile(model, {
      name: 'Collector 2-lane', lanesForward: 1, lanesBackward: 1, laneWidth: 3.4,
      shoulder: 0.6, speedLimit: kph(60), verge: 3,
    }),
    street: profile(model, {
      name: 'Residential 2-lane', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2,
      shoulder: 0.4, speedLimit: kph(40), verge: 4.5, landUse: 'residential',
    }),
    highStreet: profile(model, {
      name: 'High street 2-lane', lanesForward: 1, lanesBackward: 1, laneWidth: 3.3,
      shoulder: 1.2, speedLimit: kph(40), landUse: 'commercial',
    }),
  };
}

// --- the examples ---------------------------------------------------------------

/**
 * A diamond interchange: the commonest one there is.
 *
 * A one-way freeway pair runs east–west; an arterial crosses it on a bridge; four
 * ramps connect them at their terminals. Everything an interchange needs and
 * nothing it does not, which makes it the one to read first.
 */
function diamond(): EditModel {
  const m = createDocument(11);
  const k = kit(m);
  const SEP = 34;
  const half = edgeOf(k.freeway);
  const TERM = 520; // how far out the ramps meet the arterial, clear of the bridge

  // Right of travel is the kerb side, and it has to face *outward*. World +y is
  // south, so the carriageway running east belongs on the south side of the median
  // and the one running west on the north. Swap them and every ramp leaves from the
  // median, crosses the opposing carriageway and is quite rightly called a crossing.
  const east = add(m, k.freeway, line(-2600, SEP / 2, 2600, SEP / 2, 5));
  const west = add(m, k.freeway, line(2600, -SEP / 2, -2600, -SEP / 2, 5));
  // Enough control points that the bridge spans only the freeway, leaving the
  // ramp terminals on the ground where they can actually meet the arterial.
  grades(add(m, k.arterial, line(0, -1300, 0, 1300, 13)),
    0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0);
  const artHalf = edgeOf(k.arterial);

  // Ramps leave and join the kerb edge of their own carriageway and end on the
  // *arterial's* edge — a ramp that stops short of the road it is meant to meet is
  // a dangling stub, and the compiler is quite right to make nothing of it.
  // Eastbound runs left to right along the bottom, so its kerb side is south.
  const ramp = (road: Stroke, fraction: number, leaving: boolean, sy: number): void => {
    const pose = poseAt(road, fraction);
    const edge: [number, number] = at(pose, 0, half);
    // Which side of the arterial the terminal sits on follows the gore, not the
    // direction of travel: a ramp leaving west of the bridge meets the arterial's
    // west edge. And which side of the freeway it runs to follows the carriageway's
    // own kerb — send it the other way and it crosses the median and the opposing
    // carriageway to get there.
    const term: [number, number] = [Math.sign(pose.x) * artHalf, sy * TERM];
    const termDir: [number, number] = [0, -sy];
    add(m, k.ramp, leaving
      ? connect(edge, [pose.tx, pose.ty], term, termDir, 9)
      : connect(term, [-termDir[0], -termDir[1]], edge, [pose.tx, pose.ty], 9));
  };
  ramp(east, 0.30, true, 1);
  ramp(east, 0.70, false, 1);
  ramp(west, 0.30, true, -1);
  ramp(west, 0.70, false, -1);

  // A cross street either side, so the arterial is a road rather than a stub.
  add(m, k.collector, line(-1300, -900, 1300, -900));
  add(m, k.collector, line(-1300, 900, 1300, 900));
  return m;
}

/**
 * A collector-distributor road: a second carriageway alongside the mainline that
 * takes all the ramp traffic, so entering and leaving traffic never weaves with
 * through traffic.
 *
 * This is here rather than a trumpet or a cloverleaf on purpose. Those are defined
 * by ramps that cross each other, which real ones settle with a third level and
 * which a hand-placed example settles with a lot of guessed coordinates; a C-D road
 * is defined by *merges*, which is what this simulator is for. It has four gores in
 * two kilometres — the mainline splitting off, a local exit, a local entrance and
 * the mainline taking it back — so the traffic on it is doing the flagship
 * manoeuvre four times over, at speed, with somewhere to be.
 *
 * Both carriageways get one, mirrored, so the map is a working piece of motorway
 * rather than a diagram of one.
 */
function collectorDistributor(): EditModel {
  const m = createDocument(12);
  const k = kit(m);
  const SEP = 46;
  const CD = 68; // how far out the collector road sits from the mainline centre
  const mainHalf = edgeOf(k.freewayWide);

  // `side` is +1 for the carriageway on the +y side of the median, which runs -x.
  const build = (side: 1 | -1): void => {
    const y = (side * SEP) / 2;
    const dir = -side; // +y carriageway runs -x, -y carriageway runs +x
    add(m, k.freewayWide, dir > 0
      ? line(-3400, y, 3400, y, 6)
      : line(3400, y, -3400, y, 6));
    // The collector road: away from the mainline on its kerb side, which is the
    // side away from the median.
    const out = y + side * (CD - SEP / 2 + mainHalf);
    const gore = (x: number): [number, number] => [x, y + side * mainHalf];
    // Sampled evenly end to end rather than chained out of three runs. Handles are
    // auto-smoothed from neighbouring points, so butting a run sampled every 160 m
    // against one sampled every 470 m puts a kink at the seam — which the offsetter
    // then reports as curvature tighter than the road is wide.
    const CD_N = 26;
    const cdPts: ControlPoint[] = [];
    for (let i = 0; i < CD_N; i++) {
      const u = -1500 + (3000 * i) / (CD_N - 1);
      // Flat across the middle, easing out to the mainline edge at either gore.
      const t = Math.min(1, Math.max(0, (Math.abs(u) - 1080) / 340));
      const ease = t * t * (3 - 2 * t);
      cdPts.push(makeControlPoint(dir * u, out + (gore(0)[1] - out) * ease));
    }
    autoSmoothHandles(cdPts);
    add(m, k.ramp2, cdPts);
    const cdHalf = edgeOf(k.ramp2);
    const cdOut = out + side * cdHalf;
    // A local exit and a local entrance off the collector road. Each meets the
    // frontage road head-on rather than curling round to run alongside it: a ramp
    // that arrives parallel has to arrive on the correct side of a two-way road,
    // and one that arrives across it is a plain T-junction, which is what a ramp
    // terminal without signals actually is.
    const front = side * 430;
    add(m, k.ramp, connect(
      [dir * -430, cdOut], [dir, 0], [dir * -80, front], [0, side], 9, 210,
    ));
    add(m, k.ramp, connect(
      [dir * 80, front], [0, -side], [dir * 430, cdOut], [dir, 0], 9, 210,
    ));
    add(m, k.collector, line(-1600, front, 1600, front, 4));
  };
  build(1);
  build(-1);
  return m;
}

/**
 * A signalised arterial: four crossings in a row, far enough apart to coordinate.
 *
 * This is the map the signal work is for. Every junction earns left-turn bays (a
 * four-arm crossing, two lanes each way, a median to take the bay out of), the
 * spacing is a green wave's worth apart, and the side streets are small enough that
 * the control chooser gives the arterial priority at the ends and signals in the
 * middle. Straight lines throughout: the point here is the timing, not the geometry.
 *
 * Included partly because it is the counter-example to the interchanges — a road
 * network that is nothing but conflict points, where every second of delay comes
 * from a decision rather than from a merge.
 */
function arterial(): EditModel {
  const m = createDocument(13);
  const k = kit(m);
  const SPACING = 420;
  const N = 4;

  add(m, k.arterial, line(-1400, 0, N * SPACING + 400, 0));
  for (let i = 0; i < N; i++) {
    const x = i * SPACING;
    // Alternating cross-street size, so the control chooser has something to
    // choose between: a collector gets signals, a residential street gets priority.
    add(m, i % 2 === 0 ? k.collector : k.street, line(x, -700, x, 700, 3));
  }
  // Something for the side streets to lead to, so their traffic is not all
  // through-traffic on a stub.
  add(m, k.street, line(-200, -620, N * SPACING + 200, -620, 4));
  add(m, k.street, line(-200, 620, N * SPACING + 200, 620, 4));
  return m;
}

/**
 * A motorway corridor: three entrances, two exits and a lane drop, laid out the way
 * a real stretch of motorway is.
 *
 * This is the one to run the traffic on. Everything the merge model claims to do
 * happens here at least once, and it is long enough that a shockwave has room to
 * form and clear.
 */
function corridor(): EditModel {
  const m = createDocument(14);
  const k = kit(m);
  const half = edgeOf(k.freewayWide);

  const main = add(m, k.freewayWide, pts(-3200, 0, -1600, -70, 400, 60, 2000, 20));
  // ...continuing as three lanes, which compiles into a lane drop with a taper.
  const tail = poseAt(main, 1);
  add(m, k.freeway, connect([tail.x, tail.y], [tail.tx, tail.ty], [3400, 40], [1, 0], 4));

  const on = (fraction: number, from: readonly [number, number], p: RoadProfile): void => {
    const pose = poseAt(main, fraction);
    add(m, p, connect(from, [1, -0.55], at(pose, 0, half), [pose.tx, pose.ty], 8));
  };
  const off = (fraction: number, to: readonly [number, number]): void => {
    const pose = poseAt(main, fraction);
    add(m, k.ramp, connect(at(pose, 0, half), [pose.tx, pose.ty], to, [1, 0.55], 8));
  };

  on(0.18, [-2800, 460], k.ramp);
  off(0.36, [-1400, 470]);
  on(0.54, [-600, 470], k.ramp2);
  off(0.74, [1000, 470]);
  on(0.88, [1800, 460], k.ramp);

  // A collector picking the ramps up, so they go somewhere.
  add(m, k.collector, line(-3000, 640, 2600, 640, 4));
  return m;
}

/**
 * A town: an arterial grid with signals, collectors between, and residential
 * streets inside the blocks.
 *
 * The point of this one is the *land use*. It is what the residential spawning mode
 * is for, and it is the only example where the junction logic has to cope with
 * dozens of crossings at once rather than one interesting one.
 */
function town(): EditModel {
  const m = createDocument(15);
  const k = kit(m);
  const BLOCK = 440;

  for (let i = -2; i <= 2; i++) {
    const p = i * BLOCK * 2;
    add(m, k.arterial, line(p, -BLOCK * 4.4, p, BLOCK * 4.4, 3));
    add(m, k.arterial, line(-BLOCK * 4.4, p, BLOCK * 4.4, p, 3));
  }
  for (let i = -2; i < 2; i++) {
    const p = i * BLOCK * 2 + BLOCK;
    add(m, k.collector, line(p, -BLOCK * 4.4, p, BLOCK * 4.4, 3));
    add(m, k.collector, line(-BLOCK * 4.4, p, BLOCK * 4.4, p, 3));
  }
  // Residential streets inside a few of the blocks.
  for (const [bx, by] of [[-2, -2], [-1, -1], [0, -1], [-1, 0], [1, 1], [0, 1]] as const) {
    const x0 = bx * BLOCK;
    const y0 = by * BLOCK;
    // Reaching the roads that bound the block, not stopping short of them. A
    // street that ends thirty metres shy of the collector is an island: it compiles
    // to lanes nothing connects to, so in the portal mode it grows two portals of
    // its own and traffic drives its length and vanishes, and in the land-use mode
    // it generates trips that can never arrive.
    add(m, k.street, line(x0 + 150, y0, x0 + 150, y0 + BLOCK));
    add(m, k.street, line(x0 + 290, y0, x0 + 290, y0 + BLOCK));
    add(m, k.street, line(x0, y0 + 220, x0 + BLOCK, y0 + 220));
  }
  // A high street through the middle, so the land-use mode has somewhere to send
  // everybody. An L of it rather than a single road: every trip in the town ending
  // on the same hundred metres would queue there whatever the rest of the network
  // did, and measure the shop doorway rather than the streets.
  add(m, k.highStreet, line(0, 220, BLOCK * 2, 220, 3));
  add(m, k.highStreet, line(220, 0, 220, BLOCK * 2, 3));
  m.settings.spawnMode = 'landuse';
  return m;
}

export interface Example {
  id: string;
  name: string;
  /** One line, shown beside the name. */
  about: string;
  build(): EditModel;
}

export const EXAMPLES: Example[] = [
  { id: 'diamond', name: 'Diamond interchange', about: 'Freeway under an arterial, four ramps', build: diamond },
  { id: 'cdroad', name: 'Collector-distributor road', about: 'Ramp traffic kept off the mainline; four gores', build: collectorDistributor },
  { id: 'arterial', name: 'Signalised arterial', about: 'Four coordinated crossings with turn bays', build: arterial },
  { id: 'corridor', name: 'Motorway corridor', about: 'Three entrances, two exits, a lane drop', build: corridor },
  { id: 'town', name: 'Town grid', about: 'Land-use traffic: houses to the high street', build: town },
];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
