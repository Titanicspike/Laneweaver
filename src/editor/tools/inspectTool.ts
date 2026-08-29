/**
 * Junction inspector: the lane graph, made visible.
 *
 * Every movement the compiler built is drawn as the spline traffic actually follows
 * — the connector centrelines themselves, so nothing here re-derives geometry and
 * the picture cannot disagree with what the simulation drives. Pointing at a lane
 * picks its own movements out of the rest rather than hiding the rest, which is
 * what makes "where can I go from here" answerable at a glance.
 *
 * Clicking a junction cycles its control. The choice is stored in the document
 * keyed by position, so it survives recompiles and saves.
 */

import { setGatewayRole, setJunctionControl, setLaneLinks } from '../commands';
import { laneKeyOf } from '../../core/network/compiler/junctions';
import type { PointerInfo, Tool, ToolEnv } from '../tool';
import type { Camera } from '../../render/camera';
import type { Theme } from '../../render/theme';
import { lineWidth } from '../../render/networkPaths';
import { samplePosition } from '../../core/geom/polyline';
import {
  LaneKind, TurnKind,
  type GatewayRole, type Junction, type JunctionControl, type Lane, type Network,
} from '../../core/network/types';

const _p = { x: 0, y: 0 };

/**
 * How close the cursor has to be to a lane's centreline to pick it.
 *
 * Ten pixels' worth of world is right when zoomed out and useless when zoomed in:
 * at street level it is half a metre, so pointing anywhere but the exact middle of
 * a 3.5 m lane picks nothing. Half a lane is what the eye expects, with a pixel
 * floor so the target never gets fiddly on a wide view.
 */
function pickRadius(env: ToolEnv): number {
  return Math.max(1.9, env.scale * 12);
}

/** Signal state to theme key: the aspect a movement is showing. */
const SIGNAL_COLOURS: Record<number, 'signalRed' | 'signalGreen' | 'signalAmber'> = {
  0: 'signalRed', 1: 'signalGreen', 2: 'signalAmber',
};

/** A chevron pointing along (dx, dy), with its tip at (x, y). */
function chevron(
  ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, size: number,
): void {
  const px = -dy * size * 0.6;
  const py = dx * size * 0.6;
  ctx.moveTo(x - dx * size + px, y - dy * size + py);
  ctx.lineTo(x, y);
  ctx.lineTo(x - dx * size - px, y - dy * size - py);
}

/** What each gateway role is called in the status line. */
const GATEWAY_LABEL: Record<GatewayRole, string> = {
  both: 'traffic in and out',
  entry: 'traffic in only',
  exit: 'traffic out only',
  off: 'closed to traffic',
  culdesac: 'a cul-de-sac, with a turning head',
};

const LABELS: Record<JunctionControl, string> = {
  priority: 'priority control',
  'allway-stop': 'an all-way stop',
  signal: 'traffic signals',
};

/** Reads out the lane under the cursor, which is the quickest way to check what
 *  the compiler actually built. */
function describeLane(env: ToolEnv, p: PointerInfo): string | null {
  const hit = env.store.laneIndex.pick(p.worldX, p.worldY, pickRadius(env));
  if (!hit) return null;
  const lane = env.store.network.lanes[hit.laneId];
  if (lane.kind === LaneKind.Connector) {
    return `Junction movement, ${Math.round(lane.speedLimit * 3.6)} km/h, ` +
      `${lane.conflicts.length} conflict points, priority rank ${lane.priorityRank}.`;
  }
  const parts = [`Lane ${lane.index}`, `${Math.round(lane.speedLimit * 3.6)} km/h`];
  if (lane.aux) parts.push('auxiliary');
  if (lane.endsAt < Infinity) parts.push(`ends after ${Math.round(lane.endsAt)} m`);
  return `${parts.join(', ')}.`;
}

export class InspectTool implements Tool {
  readonly id = 'inspect';
  readonly name = 'Junctions';
  readonly hint =
    'Every movement is drawn as the spline traffic follows: blue straight on, green right, ' +
    'amber left, cyan a ramp blend. Point at a lane to pick out its own. Click a junction to ' +
    'open it in the signal panel; C cycles it between priority, all-way stop and signals. ' +
    'Hold Shift and click a lane entering the junction, then one leaving it, to wire that ' +
    'movement by hand. Escape clears.';
  readonly cursor = 'help';

  private hover: Junction | null = null;
  /** Lane under the cursor, which picks its own movements out of the rest. */
  private hoverLane: Lane | null = null;
  /** Junction whose movements are being wired, and the lane picked so far. */
  private wiring: { junction: Junction; from: Lane | null } | null = null;

  /**
   * Lanes that run into, and out of, a junction — the two halves of a movement.
   *
   * With a lane already picked, the arm it came from is excluded: the compiler
   * refuses a movement that leaves by the road it arrived on, so offering it would
   * be offering something that gets thrown away.
   */
  private sides(
    net: Network, junction: Junction, from: Lane | null = null,
  ): { incoming: Lane[]; outgoing: Lane[] } {
    if (junction.kind === 'merge' || junction.kind === 'diverge') {
      return this.goreSides(net, junction);
    }
    const incoming: Lane[] = [];
    const outgoing: Lane[] = [];
    const source = from
      ? junction.approaches.find((a) => a.incomingLanes.includes(from.id))
      : undefined;
    for (const approach of junction.approaches) {
      for (const id of approach.incomingLanes) incoming.push(net.lanes[id]);
      if (approach === source) continue;
      for (const id of approach.outgoingLanes) outgoing.push(net.lanes[id]);
    }
    return { incoming, outgoing };
  }

  /**
   * The two halves of a gore.
   *
   * A merge or a diverge has one approach — the ramp — and its other half is a set
   * of auxiliary lanes belonging to the mainline, which is not an approach at all.
   * Reading them off the connectors alone would work until you unwired the last
   * movement to a lane, at which point it would vanish and you could never wire it
   * back; so the auxiliary lanes come from the mainline segment itself.
   */
  private goreSides(net: Network, junction: Junction): { incoming: Lane[]; outgoing: Lane[] } {
    const merge = junction.kind === 'merge';
    const ramp: Lane[] = [];
    for (const approach of junction.approaches) {
      for (const id of merge ? approach.incomingLanes : approach.outgoingLanes) {
        ramp.push(net.lanes[id]);
      }
    }
    // Whichever mainline segment the movements land on, and every auxiliary lane of
    // it that reaches this gore.
    const segments = new Set<number>();
    for (const id of junction.connectorIds) {
      const connector = net.lanes[id];
      const road = net.lanes[merge ? connector.successors[0] : connector.predecessors[0]];
      if (road) segments.add(road.segmentId);
    }
    // Every mainline lane with an end at the gore, not just the auxiliary ones: a
    // through lane is where the interesting choices are — carry on *and* exit, or
    // exit only — and offering only the auxiliary ones is why the tool could change
    // which ramp lane fed which and nothing else.
    const roadIn: Lane[] = [];
    const roadOut: Lane[] = [];
    for (const segId of segments) {
      const seg = net.segments[segId];
      for (const id of seg?.laneIds ?? []) {
        const lane = net.lanes[id];
        if (nearestDistance(lane, junction.x, junction.y) > lane.width * 4 + 12) continue;
        if (lane.aux) {
          // An auxiliary lane already begins or ends here: a deceleration lane feeds
          // the exit, an acceleration lane is fed by the entrance.
          (merge ? roadOut : roadIn).push(lane);
          continue;
        }
        // A through lane belongs to whichever half its own end is at — and to *both*
        // when it has no end here at all, which is every mainline lane until
        // something is wired: it arrives and it leaves, and "carries on" is the
        // movement joining those two. Offering it on one side only is why the seed
        // could not describe a lane that simply continues.
        const ends = laneEndsAt(lane, junction.x, junction.y);
        if (ends !== 'start') roadIn.push(lane);
        if (ends !== 'end') roadOut.push(lane);
      }
    }
    const order = (a: Lane, b: Lane): number =>
      Math.abs(a.offset) - Math.abs(b.offset) || a.id - b.id;
    roadIn.sort(order);
    roadOut.sort(order);
    return merge
      ? { incoming: [...ramp, ...roadIn], outgoing: roadOut }
      : { incoming: roadIn, outgoing: [...ramp, ...roadOut] };
  }

  /** The movements currently wired by hand for this junction, if any. */
  private linksOf(env: ToolEnv, junction: Junction): { from: string; to: string }[] | null {
    const found = env.store.model.laneLinks.find(
      (l) => Math.hypot(l.x - junction.x, l.y - junction.y) <= Math.max(8, junction.radius * 1.5),
    );
    return found ? found.links.map((l) => ({ ...l })) : null;
  }

  /** Whatever is wired now, or the compiler's own layout written out as pairs. */
  private currentLinks(env: ToolEnv, junction: Junction): { from: string; to: string }[] {
    const existing = this.linksOf(env, junction);
    if (existing) return existing;
    const net = env.store.network;
    const out: { from: string; to: string }[] = [];
    for (const id of junction.connectorIds) {
      const connector = net.lanes[id];
      const from = net.lanes[connector.predecessors[0]];
      const to = net.lanes[connector.successors[0]];
      if (!from || !to) continue;
      out.push({ from: laneKeyOf(from, net.segments), to: laneKeyOf(to, net.segments) });
    }
    // At a gore the through movements are part of the wiring too — the mainline is
    // split there once anything is wired by hand, and the override then owns that
    // carriageway completely. So they have to be in the seed: without them the very
    // first movement anybody adds would take the through movements away with it, and
    // one shift-click would end the motorway. A lane carrying on is written as
    // itself, because either side of a split it is the same lane with the same name.
    if (junction.kind === 'merge' || junction.kind === 'diverge') {
      const sides = this.sides(net, junction);
      for (const lane of sides.incoming) {
        if (lane.aux || lane.kind === LaneKind.Connector) continue;
        const key = laneKeyOf(lane, net.segments);
        if (!sides.outgoing.some((l) => laneKeyOf(l, net.segments) === key)) continue;
        if (out.some((l) => l.from === key && l.to === key)) continue;
        out.push({ from: key, to: key });
      }
    }
    return out;
  }

  /** `crossing` alone for the control cycle; gores as well for hover and wiring. */
  private pick(p: PointerInfo, env: ToolEnv, crossingsOnly = true): Junction | null {
    let best: Junction | null = null;
    let bestD = Infinity;
    for (const junction of env.store.network.junctions) {
      if (crossingsOnly ? junction.kind !== 'crossing' : junction.kind === 'link') continue;
      const d = Math.hypot(junction.x - p.worldX, junction.y - p.worldY);
      const reach = Math.max(junction.radius, env.scale * 16);
      if (d > reach || d >= bestD) continue;
      bestD = d;
      best = junction;
    }
    return best;
  }

  pointerMove(p: PointerInfo, env: ToolEnv): void {
    const next = this.pick(p, env, false);
    // A junction takes precedence over a lane: pointing at the box asks about the
    // whole junction, pointing at a lane asks about that lane.
    const hit = next ? null : env.store.laneIndex.pick(p.worldX, p.worldY, pickRadius(env));
    const lane = hit ? env.store.network.lanes[hit.laneId] : null;
    if (next === this.hover && lane === this.hoverLane) return;
    this.hover = next;
    this.hoverLane = lane;
    if (next) {
      env.setStatus(next.kind === 'crossing'
        ? `Junction: ${next.approaches.length} approaches, ${next.connectorIds.length} movements, `
          + `${LABELS[next.control]}.`
        : `Ramp ${next.kind}: ${next.connectorIds.length} movement`
          + `${next.connectorIds.length === 1 ? '' : 's'}. Click to `
          + (next.kind === 'merge'
            ? 'keep the lane it brings in on the highway'
            : 'let the kerb-side lane take this exit too')
          + '; shift-click a lane to rewire it.');
    } else if (lane) {
      env.setStatus(`${describeLane(env, p) ?? ''} ${this.movementSummary(env, lane)}`.trim());
    } else {
      env.setStatus(this.hint);
    }
    env.requestRender();
  }

  /** What the highlighted splines are saying, in words. */
  private movementSummary(env: ToolEnv, lane: Lane): string {
    const net = env.store.network;
    if (lane.kind === LaneKind.Connector) return '';
    const names: Record<number, string> = {
      [TurnKind.Left]: 'left', [TurnKind.Right]: 'right', [TurnKind.Straight]: 'straight',
      [TurnKind.UTurn]: 'a U-turn', [TurnKind.Merge]: 'merge', [TurnKind.Diverge]: 'exit',
    };
    const turns = new Set<string>();
    let joints = 0;
    for (const id of lane.successors) {
      const next = net.lanes[id];
      if (!next) continue;
      if (next.kind === LaneKind.Connector) turns.add(names[next.turn] ?? 'on');
      else joints++;
    }
    if (!turns.size && !joints) return 'Nothing leaves this lane.';
    if (!turns.size) return 'Continues straight into the next road.';
    return `Leads: ${[...turns].join(', ')}.`;
  }

  pointerDown(p: PointerInfo, env: ToolEnv): void {
    if (p.button !== 0) return;
    if (p.shift) {
      this.wireAt(p, env);
      return;
    }
    const junction = this.pick(p, env, false);
    // A turning head is a junction to the compiler and an *end of the road* to the
    // person clicking it: one movement, no control to choose and no phases to edit.
    // So it belongs to the end cycle rather than to the panel — and being picked as
    // a junction first is what made a cul-de-sac impossible to turn back off.
    if (!junction || junction.kind === 'culdesac') {
      // Nothing here, but there may be an end of the network: those are what the
      // gateway spawn mode is about, and there is nowhere else to click them.
      if (this.cycleGateway(p, env)) return;
      env.store.selectJunction(null);
      return;
    }
    if (junction.kind !== 'crossing') {
      // A gore opens in the panel like a crossing does. It used to cycle its one
      // setting on each click, which was fine while that setting was a flag and
      // became hopeless once an entrance had a *count* of lanes to keep — and a
      // click that changes something is not a click you can use to look.
      env.store.selectJunction({ x: junction.x, y: junction.y });
      env.setStatus(junction.kind === 'merge'
        ? 'Entrance. Choose how many of its lanes stay on the highway in the panel.'
        : 'Exit. Choose whether the through lane may take it in the panel.');
      env.requestRender();
      return;
    }
    // Selecting rather than cycling: a click is how you *open* a junction now that
    // there is a panel to open it into, and flipping a signalised junction to
    // priority on the way in would be the opposite of what the click meant.
    env.store.selectJunction({ x: junction.x, y: junction.y });
    env.setStatus(
      `${LABELS[junction.control]} junction, ${junction.approaches.length} arms. `
      + 'Press C to change the control, or use the panel.',
    );
    env.requestRender();
  }

  /**
   * Every end of the network, and what it currently lets traffic do.
   *
   * An arrow rather than a ring, because the whole choice is directional: which way
   * traffic may cross this line. Pointing into the network is an entry, out of it an
   * exit, both ways is both, and a crossed-out ring is closed. Drawn only while the
   * junction tool is up, since these are only clickable there.
   */
  private drawGateways(
    ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv,
  ): void {
    const net = env.store.network;
    const heads = net.junctions.filter((j) => j.kind === 'culdesac');
    if (!net.portals.length && !heads.length) return;
    const r = Math.max(2.4, 9 / camera.zoom);
    ctx.lineWidth = lineWidth(0.3, camera.zoom);
    ctx.lineCap = 'round';
    // A turning head is an end of the road that is no longer an end of the network,
    // so it has no portal to draw. It still has to be visible, or the one state you
    // cannot see is the one you need to click to undo.
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = theme.portal;
    for (const head of heads) {
      ctx.beginPath();
      ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // A loop back on itself: the movement this end offers, and the only one.
      ctx.beginPath();
      ctx.arc(head.x, head.y, r * 1.9, Math.PI * 0.15, Math.PI * 1.85);
      ctx.stroke();
    }
    for (const portal of net.portals) {
      // Which way is *into* the network, from the lane this end carries.
      const lane = net.lanes[portal.entryLanes[0] ?? portal.exitLanes[0] ?? -1];
      if (!lane || lane.centerline.length < 4) continue;
      const entering = portal.entryLanes.length > 0;
      const n = lane.centerline.length;
      const ax = lane.centerline[entering ? 0 : n - 2];
      const ay = lane.centerline[entering ? 1 : n - 1];
      const bx = lane.centerline[entering ? 2 : n - 4];
      const by = lane.centerline[entering ? 3 : n - 3];
      let dx = bx - ax;
      let dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      const role = portal.role;
      ctx.globalAlpha = role === 'both' ? 0.3 : 0.75;
      ctx.strokeStyle = role === 'off' ? theme.errorMark
        : role === 'entry' ? theme.signalGreen
        : role === 'exit' ? theme.warnMark : theme.portal;
      ctx.beginPath();
      ctx.arc(portal.x, portal.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (role === 'off') {
        // A cross through it: closed is the one state with no direction to draw.
        const d = r * 0.7;
        ctx.beginPath();
        ctx.moveTo(portal.x - d, portal.y - d);
        ctx.lineTo(portal.x + d, portal.y + d);
        ctx.moveTo(portal.x + d, portal.y - d);
        ctx.lineTo(portal.x - d, portal.y + d);
        ctx.stroke();
      } else {
        // Pointing the way traffic may cross, which for `both` is both ways.
        const inward = role !== 'exit';
        const outward = role !== 'entry';
        const tip = r * 1.9;
        ctx.beginPath();
        if (inward) chevron(ctx, portal.x + dx * tip, portal.y + dy * tip, dx, dy, r * 0.8);
        if (outward) chevron(ctx, portal.x - dx * tip, portal.y - dy * tip, -dx, -dy, r * 0.8);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Cycles what the end of the network under the pointer lets traffic do.
   *
   * both -> entry only -> exit only -> closed -> both. A closed end still exists as
   * road; it simply stops being somewhere trips begin or finish, which is how you
   * ask "what if nothing came in from the north" without deleting the north.
   *
   * Available whatever the spawn mode is. Marking an end in the portal mode does
   * nothing until the mode is switched, and refusing the click there would mean
   * discovering the control only after you already needed it.
   */
  private cycleGateway(p: PointerInfo, env: ToolEnv): boolean {
    let best: { x: number; y: number; role: GatewayRole } | null = null;
    let bestD = Infinity;
    // A turning head is no longer a portal — that is the whole point of it — so the
    // ends on offer are the portals *and* the heads. Without the second list the
    // control is one-way: you could make a cul-de-sac and never unmake it.
    const ends: { x: number; y: number; role: GatewayRole }[] = [
      ...env.store.network.portals,
      ...env.store.network.junctions
        .filter((j) => j.kind === 'culdesac')
        .map((j) => ({ x: j.x, y: j.y, role: 'culdesac' as GatewayRole })),
    ];
    for (const end of ends) {
      const d = Math.hypot(end.x - p.worldX, end.y - p.worldY);
      if (d > env.scale * 18 || d >= bestD) continue;
      bestD = d;
      best = end;
    }
    if (!best) return false;
    const order: GatewayRole[] = ['both', 'entry', 'exit', 'off', 'culdesac'];
    const next = order[(order.indexOf(best.role) + 1) % order.length]!;
    env.store.run(setGatewayRole(best.x, best.y, next));
    env.setStatus(`Road end: ${GATEWAY_LABEL[next]}.`);
    env.requestRender();
    return true;
  }

  /** Cycles the selected junction's control type, which is the quick way round. */
  private cycleControl(env: ToolEnv): boolean {
    const junction = env.store.junctionSelection();
    if (!junction) {
      env.setStatus('Click a junction first, then press C to change how it is controlled.');
      return true;
    }
    const order: JunctionControl[] = ['priority', 'allway-stop', 'signal'];
    const next = order[(order.indexOf(junction.control) + 1) % order.length]!;
    env.store.run(setJunctionControl(junction.x, junction.y, next));
    env.setStatus(`Junction set to ${LABELS[next]}.`);
    env.requestRender();
    return true;
  }

  /** Shift-click: pick the lane going in, then the lane coming out. */
  private wireAt(p: PointerInfo, env: ToolEnv): void {
    const net = env.store.network;
    const hit = env.store.laneIndex.pick(p.worldX, p.worldY, pickRadius(env));
    const lane = hit ? net.lanes[hit.laneId] : null;
    if (!lane || lane.kind === LaneKind.Connector) {
      env.setStatus('Shift-click a lane running into a junction to start a movement.');
      return;
    }

    if (!this.wiring || this.wiring.from === null) {
      const junction = net.junctions.find(
        (j) => j.kind !== 'link' && this.sides(net, j).incoming.some((l) => l.id === lane.id),
      );
      if (!junction) {
        env.setStatus('That lane does not run into a junction.');
        return;
      }
      this.wiring = { junction, from: lane };
      env.setStatus(junction.kind === 'crossing'
        ? 'Now click a lane leaving the junction. Click the same pair again to remove it.'
        : 'Now click where it should go — the ramp, or the road carrying on. '
          + 'Click the same pair again to remove it.');
      env.requestRender();
      return;
    }

    const { junction, from } = this.wiring;
    const goesOut = this.sides(net, junction, from).outgoing.some((l) => l.id === lane.id);
    if (!goesOut) {
      const sameArm = junction.approaches.some(
        (a) => a.outgoingLanes.includes(lane.id) && a.incomingLanes.includes(from.id),
      );
      env.setStatus(sameArm
        ? 'That lane goes back the way this one came. Pick another arm, or press Escape.'
        : 'That lane does not leave this junction. Pick one that does, or press Escape.');
      return;
    }

    const key = { from: laneKeyOf(from, net.segments), to: laneKeyOf(lane, net.segments) };
    const links = this.currentLinks(env, junction);
    const at = links.findIndex((l) => l.from === key.from && l.to === key.to);
    if (at >= 0) links.splice(at, 1);
    else links.push(key);

    env.store.run(setLaneLinks(junction.x, junction.y, links));
    this.wiring = { junction, from: null };
    env.setStatus(
      `${at >= 0 ? 'Removed' : 'Added'} a movement; this junction now has ${links.length} wired by hand.`,
    );
    env.requestRender();
  }

  key(event: KeyboardEvent, env: ToolEnv): boolean {
    if (event.key === 'c' || event.key === 'C') return this.cycleControl(env);
    if (event.key !== 'Escape') return false;
    // First Escape drops a half-made movement, a second hands the junction back.
    if (this.wiring?.from) {
      this.wiring = { junction: this.wiring.junction, from: null };
      env.setStatus('Movement cancelled.');
    } else if (this.wiring) {
      const junction = this.wiring.junction;
      this.wiring = null;
      if (this.linksOf(env, junction)) {
        env.store.run(setLaneLinks(junction.x, junction.y, []));
        env.setStatus('Junction handed back to the compiler.');
      }
    } else {
      return false;
    }
    env.requestRender();
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv): void {
    ctx.setLineDash([]);
    this.drawGateways(ctx, camera, theme, env);
    const selected = env.store.junctionSelection();
    for (const junction of env.store.network.junctions) {
      if (junction.kind === 'link') continue;
      const active = junction === this.hover || junction === selected;
      const gore = junction.kind !== 'crossing';
      ctx.strokeStyle = gore ? theme.movementBlend
        : junction.control === 'signal' ? theme.signalGreen
        : junction.control === 'allway-stop' ? theme.markingWhite : theme.selection;
      ctx.globalAlpha = active ? 0.5 : 0.22;
      ctx.lineWidth = lineWidth(active ? 0.35 : 0.25, camera.zoom);
      const r = Math.max(junction.radius, 6 / camera.zoom);
      ctx.beginPath();
      ctx.arc(junction.x, junction.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // A second, dashed ring means the movements here were written out by hand.
      if (this.linksOf(env, junction)) {
        const dash = Math.max(1.5, 6 / camera.zoom);
        ctx.setLineDash([dash, dash]);
        ctx.beginPath();
        ctx.arc(junction.x, junction.y, r * 0.82, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // The junction the panel is looking at gets a ring you cannot miss, because
      // everything the panel says applies to this one and not the others.
      if (junction === selected) {
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = lineWidth(0.45, camera.zoom);
        ctx.strokeStyle = theme.selection;
        ctx.beginPath();
        ctx.arc(junction.x, junction.y, r * 1.15, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Splines over the ring: the ring is only a click target, the splines are the
    // information.
    this.drawMovements(ctx, camera, theme, env, selected);
    this.drawWiring(ctx, camera, theme, env);
  }

  /**
   * Every movement the compiler built, drawn as the spline the traffic actually
   * follows.
   *
   * The connector centrelines are already the curves vehicles drive, so nothing is
   * re-derived here — the overlay is the lane graph made visible. Colour reinforces
   * the shape rather than carrying it on its own: a left turn visibly curves left,
   * so the picture reads without a legend. Hovering picks a subset out of the rest
   * instead of hiding it, which is what makes "where can I go from this lane"
   * answerable at a glance.
   */
  private drawMovements(
    ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv,
    selected: Junction | null = null,
  ): void {
    const net = env.store.network;
    const view = camera.visibleRect(60 / camera.zoom);
    const focus = this.focusedMovements(net);
    // At the junction being edited, the movements are painted in the aspect each
    // one is showing right now. That is the phase plan on the map rather than in a
    // list, and it is the same live state the panel counts down.
    const aspects = selected?.control === 'signal'
      ? env.store.sim.signals : null;

    // Two passes so the highlighted splines always land on top of the dimmed ones.
    for (const pass of [0, 1]) {
      for (const junction of net.junctions) {
        if (junction.x < view.minX || junction.x > view.maxX) continue;
        if (junction.y < view.minY || junction.y > view.maxY) continue;
        const wired = this.linksOf(env, junction) !== null;
        for (const id of junction.connectorIds) {
          const lit = focus === null || focus.has(id);
          if ((pass === 1) !== lit) continue;
          const aspect = aspects && junction === selected
            ? SIGNAL_COLOURS[aspects.stateOf(id)] : null;
          this.strokeMovement(ctx, camera, theme, net.lanes[id], lit, wired,
            aspect ? theme[aspect] : null);
        }
      }
      // A link or a plain split has no connector: its lanes simply continue into
      // each other. Draw those only for the lane under the cursor, or a lane drop
      // would scribble over every joint in the network.
      if (pass === 1 && this.hoverLane) {
        for (const id of this.hoverLane.successors) {
          const next = net.lanes[id];
          if (!next || next.kind === LaneKind.Connector) continue;
          this.strokeJoint(ctx, camera, theme, this.hoverLane, next);
        }
      }
    }
  }

  /** Connector ids to pick out, or null when everything is equally interesting. */
  private focusedMovements(net: Network): Set<number> | null {
    if (this.hoverLane) {
      const out = new Set<number>();
      for (const id of this.hoverLane.successors) {
        if (net.lanes[id]?.kind === LaneKind.Connector) out.add(id);
      }
      for (const id of this.hoverLane.predecessors) {
        if (net.lanes[id]?.kind === LaneKind.Connector) out.add(id);
      }
      if (this.hoverLane.kind === LaneKind.Connector) out.add(this.hoverLane.id);
      return out;
    }
    if (this.hover) return new Set(this.hover.connectorIds);
    return null;
  }

  private colourOf(theme: Theme, turn: TurnKind): string {
    switch (turn) {
      case TurnKind.Left:
      case TurnKind.UTurn: return theme.movementLeft;
      case TurnKind.Right: return theme.movementRight;
      case TurnKind.Merge:
      case TurnKind.Diverge: return theme.movementBlend;
      default: return theme.movementStraight;
    }
  }

  private strokeMovement(
    ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme,
    connector: Lane, lit: boolean, wired: boolean, override: string | null = null,
  ): void {
    if (!connector || connector.centerline.length < 4) return;
    // A dark casing first, or a thin bright line over pale asphalt disappears.
    ctx.globalAlpha = lit ? 0.85 : 0.3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = theme.casing;
    ctx.lineWidth = lineWidth(lit ? 0.85 : 0.55, camera.zoom);
    strokeLane(ctx, connector);
    const colour = override ?? this.colourOf(theme, connector.turn);
    ctx.strokeStyle = colour;
    ctx.lineWidth = lineWidth(lit ? (wired ? 0.62 : 0.45) : 0.28, camera.zoom);
    strokeLane(ctx, connector);
    if (lit) arrowHead(ctx, camera, connector, colour);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  /** Where two road lanes continue into each other with no connector between. */
  private strokeJoint(
    ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, from: Lane, to: Lane,
  ): void {
    const REACH = 10;
    const a = sampleAt(from, Math.max(0, from.length - REACH));
    const b = sampleAt(from, from.length);
    const c = sampleAt(to, Math.min(to.length, REACH));
    ctx.globalAlpha = 0.85;
    ctx.lineCap = 'round';
    ctx.strokeStyle = theme.casing;
    ctx.lineWidth = lineWidth(0.85, camera.zoom);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();
    ctx.strokeStyle = theme.movementStraight;
    ctx.lineWidth = lineWidth(0.45, camera.zoom);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  /** The lanes on offer while wiring, and the movement being built. */
  private drawWiring(
    ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv,
  ): void {
    if (!this.wiring) return;
    const net = env.store.network;
    const { incoming, outgoing } = this.sides(net, this.wiring.junction, this.wiring.from);
    const picking = this.wiring.from !== null;
    const wanted = picking ? outgoing : incoming;
    // Only the stretch beside the junction. A lane runs the length of its road, and
    // stroking the whole thing paints every street in the view solid amber — which
    // says nothing, since the choice being offered is only about the junction end.
    const reach = Math.max(20, 90 / camera.zoom);
    ctx.lineCap = 'round';
    ctx.lineWidth = lineWidth(1.2, camera.zoom);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = picking ? theme.signalGreen : theme.selection;
    for (const lane of wanted) strokeLaneEnd(ctx, lane, !picking, reach);
    if (this.wiring.from) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.signalAmber;
      ctx.lineWidth = lineWidth(1.6, camera.zoom);
      strokeLaneEnd(ctx, this.wiring.from, true, reach);
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }
}

function strokeLane(ctx: CanvasRenderingContext2D, lane: Lane): void {
  const n = lane.centerline.length >> 1;
  if (n < 2) return;
  ctx.beginPath();
  ctx.moveTo(lane.centerline[0], lane.centerline[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(lane.centerline[i * 2], lane.centerline[i * 2 + 1]);
  ctx.stroke();
}

/** Point on a lane at an arc-length, as a plain pair. */
function sampleAt(lane: Lane, s: number): [number, number] {
  samplePosition(lane.centerline, lane.arclength, s, _p);
  return [_p.x, _p.y];
}

/**
 * A solid head where the movement arrives, so its direction is never in doubt.
 * Sized in world units with a pixel floor, like every other bit of overlay chrome.
 */
function arrowHead(
  ctx: CanvasRenderingContext2D, camera: Camera, connector: Lane, colour: string,
): void {
  const n = connector.centerline.length >> 1;
  if (n < 2) return;
  const tipX = connector.centerline[(n - 1) * 2];
  const tipY = connector.centerline[(n - 1) * 2 + 1];
  const backX = connector.centerline[(n - 2) * 2];
  const backY = connector.centerline[(n - 2) * 2 + 1];
  const dx = tipX - backX;
  const dy = tipY - backY;
  const m = Math.hypot(dx, dy) || 1;
  const len = Math.max(1.1, 7 / camera.zoom);
  const half = len * 0.42;
  const ux = dx / m;
  const uy = dy / m;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * len - uy * half, tipY - uy * len + ux * half);
  ctx.lineTo(tipX - ux * len + uy * half, tipY - uy * len - ux * half);
  ctx.closePath();
  ctx.fill();
}

/**
 * The last (or first) `reach` metres of a lane — the end that meets the junction.
 * Incoming lanes are highlighted at their finish, outgoing ones at their start.
 */
function strokeLaneEnd(
  ctx: CanvasRenderingContext2D, lane: Lane, atEnd: boolean, reach: number,
): void {
  const n = lane.centerline.length >> 1;
  if (n < 2) return;
  const lo = atEnd ? Math.max(0, lane.length - reach) : 0;
  const hi = atEnd ? lane.length : Math.min(lane.length, reach);
  samplePosition(lane.centerline, lane.arclength, lo, _p);
  ctx.beginPath();
  ctx.moveTo(_p.x, _p.y);
  for (let i = 0; i < n; i++) {
    const s = lane.arclength[i];
    if (s <= lo || s >= hi) continue;
    ctx.lineTo(lane.centerline[i * 2], lane.centerline[i * 2 + 1]);
  }
  samplePosition(lane.centerline, lane.arclength, hi, _p);
  ctx.lineTo(_p.x, _p.y);
  ctx.stroke();
}

/** Closest approach of a lane's centreline to a point. */
/**
 * Which of a lane's own ends is at this point, if either.
 *
 * Either side of a split the two halves of a mainline lane carry the same name, so
 * the tool tells them apart by which one actually finishes here — and a lane that
 * finishes neither way is one that runs straight past, which is both halves at once.
 */
function laneEndsAt(lane: Lane, x: number, y: number): 'end' | 'start' | 'through' {
  const n = lane.centerline.length;
  if (n < 4) return 'through';
  const toEnd = Math.hypot(lane.centerline[n - 2] - x, lane.centerline[n - 1] - y);
  const toStart = Math.hypot(lane.centerline[0] - x, lane.centerline[1] - y);
  const reach = lane.width * 4 + 12;
  if (toEnd < reach && toEnd <= toStart) return 'end';
  if (toStart < reach) return 'start';
  return 'through';
}

function nearestDistance(lane: Lane, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < lane.centerline.length; i += 2) {
    best = Math.min(best, Math.hypot(x - lane.centerline[i], y - lane.centerline[i + 1]));
  }
  return best;
}
