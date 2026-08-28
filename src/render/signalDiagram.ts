/**
 * A junction drawn as its own movements, for the signal panel.
 *
 * The picture is the compiled connector centrelines — the same splines the traffic
 * follows — scaled to fit a small box, never a schematic redrawn from headings. A
 * plan is edited by clicking the movements in this picture, so a picture that
 * disagreed with the lane graph would be an editor for a junction that does not
 * exist. It also means the diagram needs no special cases: a five-way, a skew
 * crossing and a T all draw themselves.
 *
 * Green movements are drawn in the signal's own green, dashed when they are
 * permissive — crossed by something else that is green at the same time, so the
 * driver has to find a gap. Everything else is drawn dark, the way a red aspect
 * reads.
 */

import { samplePosition, sampleTangent } from '../core/geom/polyline';
import type { Junction, Lane, Network } from '../core/network/types';
import type { MovementGroup } from '../core/network/compiler/signals';
import type { Theme } from './theme';

const _p = { x: 0, y: 0 };
const _t = { x: 0, y: 0 };

export interface DiagramOptions {
  width: number;
  height: number;
  /** Connectors that are green in the phase being drawn. */
  green: ReadonlySet<number>;
  /** Connectors that are green but crossed by another green movement. */
  permissive?: ReadonlySet<number>;
  groups: MovementGroup[];
  /** Group drawn brighter, e.g. the one under the cursor. */
  highlight?: string | null;
  theme: Theme;
}

/** What was drawn, so a click can be turned back into the movement it landed on. */
export interface SignalDiagram {
  /** Group key nearest to a point in the diagram's own pixels, or null. */
  hitTest(px: number, py: number, radius?: number): string | null;
}

interface Placed {
  key: string;
  /** Screen-space polyline of the connector, in diagram pixels. */
  points: number[];
}

/**
 * Draws the junction into `ctx`, which must already be scaled to CSS pixels.
 * Returns a hit tester so the caller can make the picture clickable.
 */
export function drawSignalDiagram(
  ctx: CanvasRenderingContext2D, net: Network, junction: Junction, opts: DiagramOptions,
): SignalDiagram {
  const { width, height, theme } = opts;
  ctx.clearRect(0, 0, width, height);

  const connectors = junction.connectorIds.map((id) => net.lanes[id]!).filter(Boolean);
  // A stub of each approach and exit, so the arms read as roads rather than the
  // movements floating in space.
  const stubs: Lane[] = [];
  for (const approach of junction.approaches) {
    for (const id of [...approach.incomingLanes, ...approach.outgoingLanes]) {
      const lane = net.lanes[id];
      if (lane) stubs.push(lane);
    }
  }

  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const consume = (x: number, y: number): void => {
    if (x < box.minX) box.minX = x;
    if (x > box.maxX) box.maxX = x;
    if (y < box.minY) box.minY = y;
    if (y > box.maxY) box.maxY = y;
  };
  for (const lane of connectors) {
    for (let i = 0; i < lane.centerline.length; i += 2) consume(lane.centerline[i]!, lane.centerline[i + 1]!);
  }
  for (let i = 0; i < junction.footprint.length; i += 2) {
    consume(junction.footprint[i]!, junction.footprint[i + 1]!);
  }
  if (!Number.isFinite(box.minX)) {
    return { hitTest: () => null };
  }
  // Reach a little way up every arm so the junction sits in a road network — but
  // only a little, or the junction itself, which is the part being edited, shrinks
  // into the middle of the picture.
  const STUB = Math.max(9, junction.radius * 0.7);
  const armPoints: number[][] = [];
  for (const lane of stubs) {
    const run: number[] = [];
    const from = lane.predecessors.length && junction.connectorIds.includes(lane.predecessors[0]!)
      ? 0 : Math.max(0, lane.length - STUB);
    const to = from === 0 ? Math.min(lane.length, STUB) : lane.length;
    for (let s = from; s <= to + 0.01; s += Math.max(1, (to - from) / 6)) {
      samplePosition(lane.centerline, lane.arclength, Math.min(s, lane.length), _p);
      run.push(_p.x, _p.y);
      consume(_p.x, _p.y);
    }
    if (run.length >= 4) armPoints.push(run);
  }

  const pad = 8;
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const sx = (x: number): number => (x - cx) * scale + width / 2;
  const sy = (y: number): number => (y - cy) * scale + height / 2;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  // The arms and the box, in asphalt, so the movements have a road to sit on.
  ctx.strokeStyle = theme.asphalt;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const run of armPoints) {
    ctx.lineWidth = Math.max(3, 3.6 * scale);
    ctx.beginPath();
    ctx.moveTo(sx(run[0]!), sy(run[1]!));
    for (let i = 2; i < run.length; i += 2) ctx.lineTo(sx(run[i]!), sy(run[i + 1]!));
    ctx.stroke();
  }
  if (junction.footprint.length >= 6) {
    ctx.fillStyle = theme.asphalt;
    ctx.beginPath();
    ctx.moveTo(sx(junction.footprint[0]!), sy(junction.footprint[1]!));
    for (let i = 2; i < junction.footprint.length; i += 2) {
      ctx.lineTo(sx(junction.footprint[i]!), sy(junction.footprint[i + 1]!));
    }
    ctx.closePath();
    ctx.fill();
  }

  const keyOf = new Map<number, string>();
  for (const group of opts.groups) for (const id of group.connectorIds) keyOf.set(id, group.key);

  const placed: Placed[] = [];
  // Red first, so a green movement is never hidden under one that is stopped.
  const order = [...connectors].sort((a, b) => Number(opts.green.has(a.id)) - Number(opts.green.has(b.id)));
  for (const lane of order) {
    const key = keyOf.get(lane.id) ?? '';
    const isGreen = opts.green.has(lane.id);
    const permissive = isGreen && (opts.permissive?.has(lane.id) ?? false);
    const lit = opts.highlight !== null && opts.highlight !== undefined && opts.highlight === key;

    const pts: number[] = [];
    for (let i = 0; i < lane.centerline.length; i += 2) {
      pts.push(sx(lane.centerline[i]!), sy(lane.centerline[i + 1]!));
    }
    if (pts.length < 4) continue;
    placed.push({ key, points: pts });

    ctx.strokeStyle = isGreen ? theme.signalGreen : theme.signalRed;
    ctx.globalAlpha = isGreen ? 1 : 0.45;
    ctx.lineWidth = lit ? 3.4 : isGreen ? 2.4 : 1.6;
    ctx.setLineDash(permissive ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    ctx.stroke();
    ctx.setLineDash([]);

    // A head where the movement arrives, which is what settles its direction.
    samplePosition(lane.centerline, lane.arclength, Math.max(0, lane.length - 0.5), _p);
    sampleTangent(lane.centerline, lane.arclength, Math.max(0, lane.length - 0.5), _t);
    const hx = sx(_p.x);
    const hy = sy(_p.y);
    const a = Math.atan2(_t.y, _t.x);
    const size = lit ? 7 : 5.5;
    ctx.fillStyle = isGreen ? theme.signalGreen : theme.signalRed;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - Math.cos(a - 0.42) * size, hy - Math.sin(a - 0.42) * size);
    ctx.lineTo(hx - Math.cos(a + 0.42) * size, hy - Math.sin(a + 0.42) * size);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  return {
    hitTest(px: number, py: number, radius = 12): string | null {
      let best: string | null = null;
      let bestD = radius;
      for (const item of placed) {
        for (let i = 2; i < item.points.length; i += 2) {
          const d = distanceToSegment(
            px, py, item.points[i - 2]!, item.points[i - 1]!, item.points[i]!, item.points[i + 1]!,
          );
          if (d < bestD) { bestD = d; best = item.key; }
        }
      }
      return best;
    },
  };
}

function distanceToSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
