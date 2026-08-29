/**
 * Dev-only: every sensible way to wire a two-lane gore by hand, compiled and driven.
 *
 * The tool now offers the mainline's own lanes at a gore as well as its auxiliary
 * ones, which is what makes the interesting arrangements expressible: a lane that
 * carries on *and* exits, a lane that may only exit, two lanes funnelling into one.
 * Each of those is a different lane graph, and the ways they go wrong are quiet —
 * a lane with nowhere to go, traffic vanishing at a joint, a connector over grass —
 * so this compiles each one, audits the geometry, and runs traffic through it.
 *
 *   npx tsx scratch/goreWiring.ts [case]
 */

import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import { createDocument, kph } from '../src/core/network/model';
import { LaneKind } from '../src/core/network/types';
import type { EditModel, Lane, Network } from '../src/core/network/types';
import { add, pts, prof } from './cases';
import { auditModel } from './audit';

/** `strokeId:side:index`, the way the document names a lane. */
function key(net: Network, lane: Lane): string {
  return `${net.segments[lane.segmentId].strokeId}:${lane.side}:${lane.index}`;
}

interface Case {
  name: string;
  what: string;
  /** Links, named from the lanes of the *unwired* compile. */
  wire(net: Network, gore: { x: number; y: number }): { from: string; to: string }[];
}

/** A 3-lane freeway with a two-lane exit, or entrance. */
function freeway(diverge: boolean): EditModel {
  const m = createDocument(11);
  const fw = prof(m, {
    name: 'fw3', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
    speedLimit: kph(110),
  });
  const ramp = prof(m, {
    name: 'ramp2', lanesForward: 2, lanesBackward: 0, laneWidth: 3.8, shoulder: 1.2,
    speedLimit: kph(80), isRamp: true,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  });
  add(m, fw, pts(-1200, 0, 0, 0, 1200, 0));
  // Ending *on* the freeway, which is what the compiler classifies as a gore.
  if (diverge) add(m, ramp, pts(0, 0, 200, 90, 500, 200));
  else add(m, ramp, pts(-500, 200, -200, 90, 0, 0));
  return m;
}

/**
 * The mainline's through lanes at the gore, innermost first.
 *
 * Found by how near the lane runs to the gore rather than by where it ends: before
 * anything is wired the mainline is one continuous lane a kilometre either side,
 * which is the whole reason a through lane needs a split before it can branch.
 */
function roadLanes(net: Network, x: number, y: number): Lane[] {
  const out: Lane[] = [];
  for (const lane of net.lanes) {
    if (lane.kind !== LaneKind.Road || lane.aux) continue;
    let near = Infinity;
    for (let i = 0; i < lane.centerline.length; i += 2) {
      near = Math.min(near, Math.hypot(lane.centerline[i] - x, lane.centerline[i + 1] - y));
    }
    if (near > 30) continue;
    // One entry per slot: either side of a split they are the same lane, and they
    // are named the same way.
    if (!out.some((l) => l.index === lane.index && l.side === lane.side)) out.push(lane);
  }
  return out.sort((a, b) => a.index - b.index);
}

function rampLanes(net: Network, x: number, y: number, incoming: boolean): Lane[] {
  const gore = net.junctions.find((j) => Math.hypot(j.x - x, j.y - y) < 5);
  const out: Lane[] = [];
  for (const approach of gore?.approaches ?? []) {
    for (const id of incoming ? approach.incomingLanes : approach.outgoingLanes) {
      out.push(net.lanes[id]);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Auxiliary lanes of the mainline reaching the gore. */
function auxLanes(net: Network, x: number, y: number): Lane[] {
  const out: Lane[] = [];
  for (const lane of net.lanes) {
    if (lane.kind !== LaneKind.Road || !lane.aux) continue;
    const n = lane.centerline.length;
    const near = Math.min(
      Math.hypot(lane.centerline[n - 2] - x, lane.centerline[n - 1] - y),
      Math.hypot(lane.centerline[0] - x, lane.centerline[1] - y));
    if (near > 40) continue;
    out.push(lane);
  }
  return out.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
}

const DIVERGE: Case[] = [
  {
    name: 'diverge-default',
    what: 'no wiring at all: the compiler pairs the two decel lanes with the ramp',
    wire: () => [],
  },
  {
    name: 'diverge-option-lane',
    what: 'the kerb-side through lane both carries on and exits',
    wire: (net, g) => {
      const road = roadLanes(net, g.x, g.y);
      const ramp = rampLanes(net, g.x, g.y, false);
      const aux = auxLanes(net, g.x, g.y);
      const links = road.map((l) => ({ from: key(net, l), to: key(net, l) }));
      links.push({ from: key(net, road[0]), to: key(net, ramp[0]) });
      aux.forEach((a, i) => links.push({ from: key(net, a), to: key(net, ramp[Math.min(i + 1, ramp.length - 1)]) }));
      return links;
    },
  },
  {
    name: 'diverge-exit-only',
    what: 'the kerb-side through lane must exit: it does not carry on',
    wire: (net, g) => {
      const road = roadLanes(net, g.x, g.y);
      const ramp = rampLanes(net, g.x, g.y, false);
      const aux = auxLanes(net, g.x, g.y);
      // Everything but the kerb-side lane carries on; that one only exits.
      const links = road.slice(1).map((l) => ({ from: key(net, l), to: key(net, l) }));
      links.push({ from: key(net, road[0]), to: key(net, ramp[0]) });
      aux.forEach((a, i) => links.push({ from: key(net, a), to: key(net, ramp[Math.min(i + 1, ramp.length - 1)]) }));
      return links;
    },
  },
  {
    name: 'diverge-both-to-one',
    what: 'both deceleration lanes funnel into the kerb-side ramp lane',
    wire: (net, g) => {
      const ramp = rampLanes(net, g.x, g.y, false);
      const aux = auxLanes(net, g.x, g.y);
      return aux.map((l) => ({ from: key(net, l), to: key(net, ramp[0]) }));
    },
  },
];

const DIVERGE_BAD: Case[] = [
  {
    name: 'diverge-stranded',
    what: 'a through lane wired to nothing: the warning has to fire',
    wire: (net, g) => {
      const road = roadLanes(net, g.x, g.y);
      const ramp = rampLanes(net, g.x, g.y, false);
      const aux = auxLanes(net, g.x, g.y);
      // Every lane but the kerb-side one carries on, and that one goes nowhere.
      const links = road.slice(1).map((l) => ({ from: key(net, l), to: key(net, l) }));
      aux.forEach((a, i) => links.push({ from: key(net, a), to: key(net, ramp[Math.min(i, ramp.length - 1)]) }));
      return links;
    },
  },
];

const MERGE: Case[] = [
  {
    name: 'merge-default',
    what: 'no wiring: each ramp lane takes its own acceleration lane',
    wire: () => [],
  },
  {
    name: 'merge-straight-to-through',
    what: 'the inner ramp lane joins the through lane directly, not the accel lane',
    wire: (net, g) => {
      const ramp = rampLanes(net, g.x, g.y, true);
      const road = roadLanes(net, g.x, g.y);
      const aux = auxLanes(net, g.x, g.y);
      const links = road.map((l) => ({ from: key(net, l), to: key(net, l) }));
      links.push({ from: key(net, ramp[ramp.length - 1]), to: key(net, road[0]) });
      if (aux[0] && ramp[0]) links.push({ from: key(net, ramp[0]), to: key(net, aux[0]) });
      return links;
    },
  },
  {
    name: 'merge-both-to-one',
    what: 'both ramp lanes join the one acceleration lane',
    wire: (net, g) => {
      const ramp = rampLanes(net, g.x, g.y, true);
      const aux = auxLanes(net, g.x, g.y);
      return ramp.map((l) => ({ from: key(net, l), to: key(net, aux[0]) }));
    },
  },
];

function run(c: Case, diverge: boolean): void {
  const base = compile(freeway(diverge));
  const gore = base.junctions.find((j) => j.kind === (diverge ? 'diverge' : 'merge'));
  if (!gore) { console.log(`${c.name}: NO GORE COMPILED`); return; }

  const model = freeway(diverge);
  const links = c.wire(base, gore);
  if (links.length) model.laneLinks.push({ x: gore.x, y: gore.y, links });
  const net = compile(model);

  const diags = net.diagnostics.filter((d) => d.severity !== 'info');
  const findings = auditModel(c.name, model);
  const conns = net.lanes.filter((l) => l.kind === LaneKind.Connector && l.junctionId >= 0
    && net.junctions[l.junctionId]?.kind === (diverge ? 'diverge' : 'merge'));
  // Lanes that lead nowhere: a road lane with no successor that is not a portal.
  const dead = net.lanes.filter((l) => l.kind === LaneKind.Road && !l.successors.length
    && l.endsAt === Infinity
    && !net.portals.some((p) => p.exitLanes.includes(l.id)));

  const sim = new Simulation(net, { seed: 3, demandScale: 1.4 });
  sim.run(420);
  const m = sim.metrics;
  console.log(
    `${c.name.padEnd(26)} links ${String(links.length).padStart(2)} · `
    + `gore connectors ${conns.length} · ${diags.length ? diags.map((d) => d.code).join(',') : 'clean'} · `
    + `audit ${findings.length} · dead-ends ${dead.length} · `
    + `arrived ${m.arrived} lost ${m.lost} collisions ${m.collisions} `
    + `mean ${m.meanSpeed.toFixed(1)} m/s`);
  for (const l of dead) {
    console.log(`      DEAD END lane ${l.id} idx ${l.index} aux ${l.aux} len ${l.length.toFixed(0)} m`
      + ` endsAt ${l.endsAt === Infinity ? 'inf' : l.endsAt.toFixed(0)} mergeTarget ${l.mergeTarget}`);
  }
  for (const f of findings.slice(0, 2)) console.log(`      ${f.slice(0, 130)}`);
  for (const d of diags.slice(0, 3)) console.log(`      ${d.severity} ${d.code}: ${d.message}`);
  console.log(`      ${c.what}`);
}

const only = process.argv[2];
for (const c of [...DIVERGE, ...DIVERGE_BAD]) if (!only || c.name.includes(only)) run(c, true);
for (const c of MERGE) if (!only || c.name.includes(only)) run(c, false);
