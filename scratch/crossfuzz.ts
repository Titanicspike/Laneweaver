/**
 * Crossings the way a user draws them, scored by the audit's own checks.
 *
 * The zoo has the shapes somebody thought of. This builds the ones that come out of
 * drawing by hand: stubs that end a few metres off the road they meet, stubs from
 * opposite sides that do not quite line up, a continuous road met by two separate
 * roads, four separate roads meeting at a point, stubs on a curve, mismatched
 * widths, one-way arms, two T's close together, a fifth arm on a crossing — each at
 * a range of angles. For every shape it reports what the compiler made of it: how
 * many junctions, how many arms, whether anything was refused, and what the audit
 * finds, plus how far each arm was set back beyond what it needs.
 */
import { compile } from '../src/core/network/compiler';
import { auditModel } from './audit';
import { createDocument, kph } from '../src/core/network/model';
import { add, pts, prof } from './cases';
import { Mulberry32 } from '../src/core/util/rng';
import type { EditModel, Network, RoadProfile } from '../src/core/network/types';

type Kind = 'two-strokes' | 'stubs-both-sides' | 'four-stubs' | 'one-stub' | 'double-tee' | 'five-arm' | 'stub-on-curve' | 'oneway-stub';

interface Shape { name: string; kind: Kind; model: EditModel }

const rng = new Mulberry32(20260828);
const rand = (lo: number, hi: number) => lo + rng.next() * (hi - lo);
const pick = <T>(xs: T[]): T => xs[Math.floor(rng.next() * xs.length)];

function road(m: EditModel, lanes: number, twoWay: boolean, median = 0): RoadProfile {
  return prof(m, {
    name: `r${lanes}${twoWay ? 't' : 'o'}${median}`, lanesForward: lanes, lanesBackward: twoWay ? lanes : 0,
    laneWidth: 3.5, shoulder: 0.5, median, speedLimit: kph(40 + lanes * 15),
  });
}

/** A straight or gently curved road through the origin at `bearing`, or ending there. */
function arm(m: EditModel, p: RoadProfile, bearingDeg: number, from: number, to: number, bend = 0): void {
  const a = (bearingDeg * Math.PI) / 180;
  const nx = -Math.sin(a), ny = Math.cos(a);
  const at = (d: number, k: number) => [Math.cos(a) * d + nx * bend * k, Math.sin(a) * d + ny * bend * k];
  const p0 = at(from, 0), p1 = at((from + to) / 2, 0.25), p2 = at(to, 1);
  add(m, p, pts(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]));
}

function shapes(): Shape[] {
  const out: Shape[] = [];
  const make = (name: string, kind: Kind, build: (m: EditModel) => void): void => {
    const m = createDocument(7);
    build(m);
    out.push({ name, kind, model: m });
  };
  for (let i = 0; i < 60; i++) {
    const angle = Math.round(rand(60, 120));            // the cross road's bearing
    const wide = pick([1, 2, 3]), narrow = pick([1, 1, 2]);
    const median = wide > 1 && rng.next() < 0.5 ? 2.4 : 0;
    const off = Math.round(rand(0, 6));                  // metres the stub ends short/long of the centreline
    const skew = Math.round(rand(-6, 6));                // lateral misalignment of opposite stubs
    const bend = rng.next() < 0.3 ? Math.round(rand(-60, 60)) : 0;
    const tag = `a${angle} w${wide}/${narrow} m${median} off${off} skew${skew} bend${bend}`;

    make(`two-strokes ${tag}`, 'two-strokes', (m) => {
      arm(m, road(m, wide, true, median), 0, -400, 400, bend);
      arm(m, road(m, narrow, true), angle, -350, 350);
    });
    make(`stubs-both-sides ${tag}`, 'stubs-both-sides', (m) => {
      const main = road(m, wide, true, median), side = road(m, narrow, true);
      arm(m, main, 0, -400, 400, bend);
      // One stub from each side, ending `off` metres past or short of the centreline,
      // and `skew` metres apart laterally, the way two hand-drawn roads land.
      const a = (angle * Math.PI) / 180;
      const sx = -Math.sin(a) * skew * 0.5, sy = Math.cos(a) * skew * 0.5;
      add(m, side, pts(Math.cos(a) * 350 + sx, Math.sin(a) * 350 + sy, Math.cos(a) * 175 + sx, Math.sin(a) * 175 + sy, Math.cos(a) * off + sx, Math.sin(a) * off + sy));
      add(m, side, pts(-Math.cos(a) * 350 - sx, -Math.sin(a) * 350 - sy, -Math.cos(a) * 175 - sx, -Math.sin(a) * 175 - sy, -Math.cos(a) * off - sx, -Math.sin(a) * off - sy));
    });
    make(`four-stubs ${tag}`, 'four-stubs', (m) => {
      const main = road(m, wide, true, median), side = road(m, narrow, true);
      arm(m, main, 0, -400, -off * 0.5);
      arm(m, main, 180, -400, -off * 0.5);
      arm(m, side, angle, -350, -off);
      arm(m, side, angle + 180, -350, -off);
    });
    make(`one-stub ${tag}`, 'one-stub', (m) => {
      arm(m, road(m, wide, true, median), 0, -400, 400, bend);
      arm(m, road(m, narrow, true), angle, -350, -off);
    });
    if (i % 3 === 0) {
      make(`double-tee ${tag}`, 'double-tee', (m) => {
        const main = road(m, wide, true, median), side = road(m, narrow, true);
        arm(m, main, 0, -400, 400, bend);
        // Two stubs on the same side, a little apart.
        const gap = Math.round(rand(20, 90));
        const a = (angle * Math.PI) / 180;
        add(m, side, pts(Math.cos(a) * 350, Math.sin(a) * 350, Math.cos(a) * 175, Math.sin(a) * 175, 0, 0));
        add(m, side, pts(Math.cos(a) * 350 + gap, Math.sin(a) * 350, Math.cos(a) * 175 + gap, Math.sin(a) * 175, gap, 0));
      });
      const fifth = Math.round(rand(200, 340));
      make(`five-arm ${tag} fifth${fifth}`, 'five-arm', (m) => {
        arm(m, road(m, wide, true, median), 0, -400, 400);
        arm(m, road(m, narrow, true), angle, -350, 350);
        arm(m, road(m, 1, true), fifth, -300, -off);
      });
      make(`oneway-stub ${tag}`, 'oneway-stub', (m) => {
        arm(m, road(m, wide, true, median), 0, -400, 400, bend);
        arm(m, road(m, narrow, false), angle, -350, -off);
      });
    }
  }
  return out;
}

/** Excess setback: cap distance beyond what clearing the roads it meets requires. */
function worstSetback(net: Network): number {
  let worst = 0;
  for (const j of net.junctions) {
    if (j.kind !== 'crossing') continue;
    // How far the road reaches from its own centreline at the cap. Half the cap
    // chord is only that when the road is symmetric about its centreline, and a
    // left-turn bay flares one kerb and not the other: the outer extent on the
    // flared side is what an arm crossing there actually has to clear.
    const halves = j.approaches.map((a) => {
      const seg = net.segments[a.segmentId];
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const cl = seg.centerline;
      const [mx, my] = a.atSegmentEnd ? [cl[cl.length - 2], cl[cl.length - 1]] : [cl[0], cl[1]];
      return Math.max(Math.hypot(cap[0] - mx, cap[1] - my), Math.hypot(cap[2] - mx, cap[3] - my));
    });
    j.approaches.forEach((a, i) => {
      const seg = net.segments[a.segmentId];
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const d = Math.hypot((cap[0] + cap[2]) / 2 - j.x, (cap[1] + cap[3]) / 2 - j.y);
      const hx = Math.cos(a.heading), hy = Math.sin(a.heading);
      let need = halves[i];
      j.approaches.forEach((b, k) => {
        if (k === i) return;
        const dot = hx * Math.cos(b.heading) + hy * Math.sin(b.heading);
        if (dot < -0.866) return;
        const sin = Math.max(Math.sqrt(Math.max(0, 1 - dot * dot)), 0.2);
        // Alongside at a shallow angle, an arm clears the other road as it may be
        // widened for a turn bay: one lane more.
        const bay = sin < 0.707 ? 3.5 : 0;
        need = Math.max(need, (halves[k] + bay + halves[i] * Math.abs(dot)) / sin);
      });
      worst = Math.max(worst, d - (need + 3));
    });
  }
  return worst;
}

const problems = new Map<string, { n: number; eg: string }>();
const note = (key: string, eg: string) => { const p = problems.get(key); if (p) p.n++; else problems.set(key, { n: 1, eg }); };
const byKind = new Map<Kind, { n: number; bad: number }>();
let checked = 0;
for (const s of shapes()) {
  let net: Network;
  try { net = compile(s.model); } catch (e) { note('THREW', `${s.name}: ${(e as Error).message}`); continue; }
  checked++;
  const k = byKind.get(s.kind) ?? { n: 0, bad: 0 }; k.n++; byKind.set(s.kind, k);
  const issues: string[] = [];
  const crossings = net.junctions.filter((j) => j.kind === 'crossing');
  const expectJunctions = s.kind === 'double-tee' ? 2 : 1;
  if (crossings.length !== expectJunctions) issues.push(`${crossings.length} crossings (expected ${expectJunctions})`);
  const arms = crossings.map((j) => j.approaches.filter((a) => a.incomingLanes.length || a.outgoingLanes.length).length);
  const expectArms = s.kind === 'one-stub' || s.kind === 'oneway-stub' ? 3 : s.kind === 'five-arm' ? 5 : s.kind === 'double-tee' ? 3 : 4;
  if (crossings.length && !arms.every((n) => n === expectArms)) issues.push(`arms ${arms.join('/')} (expected ${expectArms})`);
  for (const d of net.diagnostics) if (d.severity !== 'info') issues.push(`${d.severity} ${d.code}`);
  const excess = worstSetback(net);
  if (excess > 4) issues.push(`setback excess ${excess.toFixed(0)} m`);
  for (const a of auditModel(s.name, s.model)) issues.push(a.replace(/^[^:]*: /, '').replace(/-?\d+(\.\d+)?/g, 'N').slice(0, 80));
  if (issues.length) { k.bad++; for (const i of issues) note(`${s.kind}: ${i}`, s.name); }
}
console.log(`checked ${checked} hand-drawn crossings`);
for (const [kind, k] of byKind) console.log(`  ${kind.padEnd(18)} ${k.n} shapes, ${k.bad} with a problem`);
console.log('problems:');
for (const [key, p] of [...problems].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(p.n).padStart(3)}x  ${key}\n        e.g. ${p.eg}`);
