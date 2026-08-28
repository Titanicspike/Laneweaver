/** Scenario zoo: every road/junction shape worth looking at, built the same way. */
import { createDocument, issueId, kph, autoSmoothHandles, makeControlPoint } from '../src/core/network/model';
import type { ControlPoint, EditModel, RoadProfile } from '../src/core/network/types';
import { createDemoDocument } from '../src/app/demo';
import { EXAMPLES } from '../src/app/examples';

export function pts(...c: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < c.length; i += 2) out.push(makeControlPoint(c[i]!, c[i + 1]!));
  autoSmoothHandles(out);
  return out;
}
export function line(x0: number, y0: number, x1: number, y1: number, n = 2): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(makeControlPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t));
  }
  autoSmoothHandles(out);
  return out;
}
export function prof(m: EditModel, spec: Partial<RoadProfile> & { name: string }): RoadProfile {
  const p: RoadProfile = {
    id: issueId(m), lanesForward: 1, lanesBackward: 0, laneWidth: 3.5,
    speedLimit: kph(60), median: 0, shoulder: 0.5, isRamp: false, ...spec,
  };
  m.profiles.push(p);
  return p;
}
export function add(m: EditModel, p: RoadProfile, cp: ControlPoint[], grade = 0) {
  for (const q of cp) q.grade = grade;
  const s = { id: issueId(m), profileId: p.id, points: cp };
  m.strokes.push(s);
  return s;
}

export interface Case { name: string; model: EditModel; at?: [number, number]; zoom: number }

export function cases(): Case[] {
  const out: Case[] = [];
  const make = (name: string, build: (m: EditModel) => void, at: [number, number] = [0, 0], zoom = 3): void => {
    const m = createDocument(7);
    build(m);
    out.push({ name, model: m, at, zoom });
  };

  const freeway = (m: EditModel, lanes: number) =>
    prof(m, { name: `fw${lanes}`, lanesForward: lanes, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5, speedLimit: kph(110) });
  const ramp = (m: EditModel, lanes: number) =>
    prof(m, { name: `ramp${lanes}`, lanesForward: lanes, lanesBackward: 0, laneWidth: 4, shoulder: 1.2, speedLimit: kph(80), isRamp: true });
  const arterial = (m: EditModel, median: number) =>
    prof(m, { name: `art`, lanesForward: 2, lanesBackward: 2, laneWidth: 3.5, shoulder: 0.8, median, speedLimit: kph(70), verge: 2.5 });
  const street = (m: EditModel) =>
    prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(40), verge: 4 });

  for (const rl of [1, 2]) {
    for (const ml of [2, 3, 4]) {
      make(`onramp-${rl}lane-into-${ml}`, (m) => {
        add(m, freeway(m, ml), line(-1200, 0, 1200, 0, 3));
        add(m, ramp(m, rl), pts(-500, 200, -200, 90, 0, 0));
      }, [-60, 25], 2.6);
      make(`offramp-${rl}lane-from-${ml}`, (m) => {
        add(m, freeway(m, ml), line(-1200, 0, 1200, 0, 3));
        add(m, ramp(m, rl), pts(0, 0, 200, 90, 500, 200));
      }, [60, 25], 2.6);
    }
  }
  // Ramp lane arrangements: the exit's kerb-side lane may also carry on, and the
  // lane an entrance brings in may stay on the highway.
  make('offramp-option-lane', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 1), pts(0, 0, 200, 90, 500, 200));
    m.junctions.push({ x: 0, y: 0, control: 'priority', optionLane: true });
  }, [40, 25], 2.6);
  make('offramp-option-2lane', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 2), pts(0, 0, 200, 90, 500, 200));
    m.junctions.push({ x: 0, y: 0, control: 'priority', optionLane: true });
  }, [40, 25], 2.6);
  make('onramp-added-lane', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 1), pts(-500, 200, -200, 90, 0, 0));
    m.junctions.push({ x: 0, y: 0, control: 'priority', addedLanes: 1 });
  }, [-40, 25], 2.6);
  make('onramp-added-2lane', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 2), pts(-500, 200, -200, 90, 0, 0));
    m.junctions.push({ x: 0, y: 0, control: 'priority', addedLanes: 1 });
  }, [-40, 25], 2.6);
  make('weave-1lane', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 1), pts(-600, 200, -300, 90, -100, 0));
    add(m, ramp(m, 1), pts(150, 0, 350, 90, 650, 200));
  }, [0, 20], 1.6);
  // Ramps close enough that their auxiliary lanes fuse into one weaving lane, which
  // is where "it breaks if an on-ramp and off-ramp are too close" lives.
  make('weave-tight', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 1), pts(-600, 200, -300, 90, -100, 0));
    add(m, ramp(m, 1), pts(-20, 0, 200, 90, 500, 200));
  }, [0, 20], 1.6);
  make('weave-2lane', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 2), pts(-600, 200, -300, 90, -100, 0));
    add(m, ramp(m, 2), pts(150, 0, 350, 90, 650, 200));
  }, [0, 20], 1.6);
  make('weave-2lane-tight', (m) => {
    add(m, freeway(m, 3), line(-1200, 0, 1200, 0, 3));
    add(m, ramp(m, 2), pts(-600, 200, -300, 90, -100, 0));
    add(m, ramp(m, 2), pts(-20, 0, 200, 90, 500, 200));
  }, [0, 20], 1.6);
  // Big-city crossings: wide divided arterials, several lanes each way, meeting
  // square and at a skew. This is the shape a traced real-world junction produces
  // and the one that looks wrong when the box is wrong.
  make('cross-wide-wide', (m) => {
    const big = prof(m, {
      name: 'art8', lanesForward: 4, lanesBackward: 4, laneWidth: 3.5,
      shoulder: 0.6, median: 3.0, speedLimit: kph(70),
    });
    add(m, big, line(-600, 0, 600, 0));
    add(m, big, line(0, -600, 0, 600));
  }, [0, 0], 3.4);
  make('cross-wide-wide-skew', (m) => {
    const big = prof(m, {
      name: 'art8', lanesForward: 4, lanesBackward: 4, laneWidth: 3.5,
      shoulder: 0.6, median: 3.0, speedLimit: kph(70),
    });
    add(m, big, line(-600, 0, 600, 0));
    add(m, big, line(-160, -600, 160, 600));
  }, [0, 0], 3.4);
  make('cross-wide-narrow-skew', (m) => {
    const big = prof(m, {
      name: 'art6', lanesForward: 3, lanesBackward: 3, laneWidth: 3.5,
      shoulder: 0.6, median: 3.0, speedLimit: kph(70),
    });
    const small = prof(m, {
      name: 'st2', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(50),
    });
    add(m, big, line(-600, 0, 600, 0));
    add(m, small, line(-200, -500, 200, 500));
  }, [0, 0], 3.4);
  // The fuzzer's worst three-arm shape: every road stops here, none is opposite
  // another, and all three leave within 140 degrees. Where the spur grew.
  make('tee-y-obtuse', (m) => {
    const wide = prof(m, { name: 'y3', lanesForward: 3, lanesBackward: 3, laneWidth: 3.5, shoulder: 0.5, speedLimit: kph(80) });
    const narrow = prof(m, { name: 'y1', lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, shoulder: 0.5, speedLimit: kph(60) });
    for (const [deg, p] of [[49, wide], [158, wide], [189, narrow]] as [number, typeof wide][]) {
      const a = (deg * Math.PI) / 180;
      add(m, p, pts(0, 0, Math.cos(a) * 130, Math.sin(a) * 130, Math.cos(a) * 260, Math.sin(a) * 260));
    }
  }, [-10, -5], 4);
  // A minor road meeting a divided arterial, kerb-side turns only: the median
  // runs through unbroken and the far carriageway is never touched.
  make('riro', (m) => {
    const a = arterial(m, 2.4);
    const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
    add(m, a, line(-500, 0, 500, 0));
    add(m, st, line(0, 400, 0, 0));
    m.junctions.push({ x: 0, y: 0, control: 'priority', rightInRightOut: true });
  }, [0, 30], 4);
  // The same 90-degree crossing built three ways. Two strokes crossing is the
  // picture everybody likes; one continuous road with two separate stubs ending on
  // it from opposite sides, and four separate strokes all ending at one point, are
  // the same junction as far as a driver is concerned and must look the same.
  make('cross-three-strokes', (m) => {
    const a = arterial(m, 2.4);
    const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
    add(m, a, line(-500, 0, 500, 0));
    add(m, st, line(0, -400, 0, 0));
    add(m, st, line(0, 400, 0, 0));
  }, [0, 0], 4);
  make('cross-four-strokes', (m) => {
    const a = arterial(m, 2.4);
    const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
    add(m, a, line(-500, 0, 0, 0));
    add(m, a, line(500, 0, 0, 0));
    add(m, st, line(0, -400, 0, 0));
    add(m, st, line(0, 400, 0, 0));
  }, [0, 0], 4);
  // Drawn by hand, the two stubs never land on exactly the same point.
  make('cross-three-strokes-offset', (m) => {
    const a = arterial(m, 2.4);
    const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
    add(m, a, line(-500, 0, 500, 0));
    add(m, st, line(-3, -400, -3, 0));
    add(m, st, line(4, 400, 4, 0));
  }, [0, 0], 4);
  make('cross-three-strokes-equal', (m) => {
    const a = arterial(m, 2.4);
    add(m, a, line(-500, 0, 500, 0));
    add(m, a, line(0, -500, 0, 0));
    add(m, a, line(0, 500, 0, 0));
  }, [0, 0], 4);
  make('cross-four-streets', (m) => {
    const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
    add(m, st, line(-400, 0, 0, 0));
    add(m, st, line(400, 0, 0, 0));
    add(m, st, line(0, -400, 0, 0));
    add(m, st, line(0, 400, 0, 0));
  }, [0, 0], 5);
  // A slip road joining at a crossing: a fifth arm twenty degrees off one of the
  // through road's arms. Two corridors at that angle overlap for forty metres, and
  // the trim rule set the *through road* back that far to clear a road that was
  // merely alongside it.
  make('cross-5way-slip', (m) => {
    const a = arterial(m, 2.4);
    const st = prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
    add(m, a, line(-500, 0, 500, 0));
    add(m, st, line(0, -400, 0, 400));
    const t = (200 * Math.PI) / 180;
    add(m, st, pts(Math.cos(t) * 350, Math.sin(t) * 350, Math.cos(t) * 175, Math.sin(t) * 175, 0, 0));
  }, [-30, 10], 3);
  make('cross-arterial-arterial', (m) => {
    const a = arterial(m, 2.4);
    add(m, a, line(-500, 0, 500, 0));
    add(m, a, line(0, -500, 0, 500));
  }, [0, 0], 4);
  make('cross-arterial-street', (m) => {
    add(m, arterial(m, 2.4), line(-500, 0, 500, 0));
    add(m, street(m), line(0, -500, 0, 500));
  }, [0, 0], 4);
  make('tee-street', (m) => {
    add(m, street(m), line(-400, 0, 400, 0));
    add(m, street(m), line(0, 0, 0, 400));
  }, [0, 0], 6);
  make('cross-skew-60', (m) => {
    const a = arterial(m, 2.4);
    add(m, a, line(-500, 0, 500, 0));
    add(m, a, line(-260, -450, 260, 450));
  }, [0, 0], 4);
  make('cross-5way', (m) => {
    const a = arterial(m, 2.4);
    add(m, a, line(-500, 0, 500, 0));
    add(m, a, line(0, -500, 0, 500));
    add(m, street(m), line(0, 0, 420, -420));
  }, [0, 0], 4);
  make('lanedrop-4to2', (m) => {
    add(m, freeway(m, 4), line(-800, 0, 0, 0, 3));
    add(m, freeway(m, 2), line(0, 0, 800, 0, 3));
  }, [0, 0], 3);
  make('grade-ramp-over', (m) => {
    const a = arterial(m, 2.4);
    add(m, freeway(m, 3), line(-800, 0, 800, 0, 3));
    const s = add(m, a, line(0, -600, 0, 600, 4));
    [0, 1, 1, 0].forEach((g, i) => { s.points[i]!.grade = g; });
  }, [0, 0], 2.2);
  // The same road going the other way. A tunnel's abutment is the case where a
  // dashed casing and a half-transparent surface meet a solid opaque one, so it is
  // where a joint drawn as an edge shows up worst.
  make('grade-ramp-under', (m) => {
    const a = arterial(m, 2.4);
    add(m, freeway(m, 3), line(-800, 0, 800, 0, 3));
    const s = add(m, a, line(0, -600, 0, 600, 4));
    [0, -1, -1, 0].forEach((g, i) => { s.points[i]!.grade = g; });
  }, [0, 0], 2.2);
  // Junctions that are awkward on purpose: this is where an arm grown a little too
  // long shows up as asphalt hanging off the far side of the box.
  make('tee-skew-35', (m) => {
    add(m, arterial(m, 2.4), line(-400, 0, 400, 0));
    add(m, street(m), pts(0, 0, 260, 180, 520, 360));
  }, [10, 25], 4);
  make('tee-wide-into-narrow', (m) => {
    add(m, street(m), line(-300, 0, 300, 0));
    add(m, freeway(m, 4), line(0, 0, 0, 500, 3));
  }, [0, 0], 4);
  make('cross-curved', (m) => {
    add(m, arterial(m, 2.4), pts(-500, -160, -120, 40, 220, -20, 520, 140));
    add(m, arterial(m, 2.4), pts(-40, -420, 60, -80, -20, 200, 90, 480));
  }, [45, 15], 3.4);
  make('cross-curved-street', (m) => {
    add(m, street(m), pts(-400, 120, -60, -40, 260, 60, 520, -60));
    add(m, arterial(m, 3.6), pts(60, -400, -20, -60, 80, 220, 10, 460));
  }, [-19, -42], 4);
  make('tee-acute-pair', (m) => {
    const a = arterial(m, 2.4);
    add(m, a, line(-500, 0, 500, 0));
    add(m, street(m), pts(-180, -300, -60, -140, 0, 0));
    add(m, street(m), pts(0, 0, 80, 150, 220, 320));
  }, [0, 0], 4);
  make('cross-tight-pair', (m) => {
    const a = arterial(m, 2.4);
    add(m, a, line(-500, 0, 500, 0));
    add(m, street(m), line(-30, -300, -30, 300));
    add(m, street(m), line(70, -300, 70, 300));
  }, [20, 0], 4);
  make('curved-onramp', (m) => {
    add(m, freeway(m, 3), pts(-1200, 200, -400, -60, 400, 40, 1200, -120));
    add(m, ramp(m, 1), pts(-700, 120, -450, 0, -250, -66));
  }, [-280, -40], 2.6);
  // The document the app opens with: curved, mixed grades, ramps and street
  // junctions. Whatever the zoo misses, the thing the user actually looks at.
  out.push({ name: 'demo-document', model: createDemoDocument(), at: [0, 0], zoom: 1 });
  // The shipped example maps, drawn through the real renderer like everything else.
  // These are the documents a user actually opens, so a fault in one of them is a
  // fault the user sees first.
  for (const ex of EXAMPLES) {
    out.push({ name: `example-${ex.id}`, model: ex.build(), zoom: 0 });
  }
  return out;
}
