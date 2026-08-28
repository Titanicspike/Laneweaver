/**
 * Compile step 9: validation.
 *
 * Problems surface as editor diagnostics, never as silent breakage. Anything that
 * would make the simulation misbehave (NaNs, dead ends, unreachable lanes,
 * priority cycles) is caught here.
 */

import type { Diagnostic, Lane, Network } from '../types';
import { LaneKind } from '../types';

function hasNaN(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true;
  return false;
}

export function validateNetwork(net: Network): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { lanes } = net;

  for (const lane of lanes) {
    if (lane.centerline.length < 4) {
      out.push({
        severity: 'error', code: 'degenerate-lane',
        message: 'A lane came out with no geometry.', laneId: lane.id,
      });
      continue;
    }
    if (hasNaN(lane.centerline) || hasNaN(lane.arclength) || !Number.isFinite(lane.length)) {
      out.push({
        severity: 'error', code: 'nan-geometry',
        message: 'A lane has non-finite geometry.', laneId: lane.id,
        x: lane.centerline[0], y: lane.centerline[1],
      });
    }
    if (lane.length < 0.05) {
      out.push({
        severity: 'warning', code: 'zero-length-lane',
        message: 'A lane is effectively zero length.', laneId: lane.id,
        x: lane.centerline[0], y: lane.centerline[1],
      });
    }
    for (let i = 1; i < lane.arclength.length; i++) {
      if (lane.arclength[i] < lane.arclength[i - 1]) {
        out.push({
          severity: 'error', code: 'non-monotone-arclength',
          message: 'A lane arc-length table is not monotone.', laneId: lane.id,
        });
        break;
      }
    }
    if (lane.kind === LaneKind.Connector) {
      if (lane.predecessors.length !== 1 || lane.successors.length !== 1) {
        out.push({
          severity: 'error', code: 'orphan-connector',
          message: 'A junction connector is not wired to exactly one lane at each end.',
          laneId: lane.id, junctionId: lane.junctionId,
        });
      }
      for (const c of lane.conflicts) {
        if (!lanes[c.other] || lanes[c.other].junctionId !== lane.junctionId) {
          out.push({
            severity: 'error', code: 'bad-conflict',
            message: 'A conflict point references a connector from another junction.',
            laneId: lane.id, junctionId: lane.junctionId,
          });
          break;
        }
      }
    }
    if (lane.mergeTarget >= 0 && !lanes[lane.mergeTarget]) {
      out.push({
        severity: 'error', code: 'bad-merge-target',
        message: 'A lane points at a merge target that does not exist.', laneId: lane.id,
      });
    }
    if (lane.endsAt < Infinity && lane.mergeTarget < 0 && lane.successors.length === 0) {
      out.push({
        severity: 'warning', code: 'dead-end-lane',
        message: 'A lane ends with nowhere for its traffic to go.',
        laneId: lane.id,
        x: lane.centerline[lane.centerline.length - 2],
        y: lane.centerline[lane.centerline.length - 1],
      });
    }
  }

  // Priority within a junction must be a strict total order.
  for (const junction of net.junctions) {
    const ranks = new Set<number>();
    for (const id of junction.connectorIds) {
      const r = lanes[id].priorityRank;
      if (ranks.has(r)) {
        out.push({
          severity: 'error', code: 'priority-cycle-risk',
          message: 'Two connectors in this junction share a priority rank.',
          junctionId: junction.id, x: junction.x, y: junction.y,
        });
        break;
      }
      ranks.add(r);
    }
    if (junction.kind === 'crossing' && junction.connectorIds.length === 0) {
      out.push({
        severity: 'warning', code: 'empty-junction',
        message: 'This junction has no legal movements.',
        junctionId: junction.id, x: junction.x, y: junction.y,
      });
    }
  }

  // Reachability: every road lane should be enterable and leavable.
  const enterable = new Set<number>();
  const leavable = new Set<number>();
  for (const p of net.portals) {
    for (const id of p.entryLanes) enterable.add(id);
    for (const id of p.exitLanes) leavable.add(id);
  }
  const forward: Lane[] = [...enterable].map((id) => lanes[id]);
  while (forward.length) {
    const lane = forward.pop() as Lane;
    for (const id of lane.successors) {
      if (enterable.has(id)) continue;
      enterable.add(id);
      forward.push(lanes[id]);
    }
    if (lane.mergeTarget >= 0 && !enterable.has(lane.mergeTarget)) {
      enterable.add(lane.mergeTarget);
      forward.push(lanes[lane.mergeTarget]);
    }
    for (const id of [lane.left, lane.right]) {
      if (id < 0 || enterable.has(id)) continue;
      enterable.add(id);
      forward.push(lanes[id]);
    }
  }
  const backward: Lane[] = [...leavable].map((id) => lanes[id]);
  while (backward.length) {
    const lane = backward.pop() as Lane;
    for (const id of lane.predecessors) {
      if (leavable.has(id)) continue;
      leavable.add(id);
      backward.push(lanes[id]);
    }
    for (const id of [lane.left, lane.right]) {
      if (id < 0 || leavable.has(id)) continue;
      leavable.add(id);
      backward.push(lanes[id]);
    }
  }

  let unreachable = 0;
  let stranded = 0;
  for (const lane of lanes) {
    if (lane.kind !== LaneKind.Road) continue;
    if (!enterable.has(lane.id)) unreachable++;
    else if (!leavable.has(lane.id) && lane.endsAt === Infinity) stranded++;
  }
  if (unreachable > 0) {
    out.push({
      severity: 'info', code: 'unreachable-lanes',
      message: `${unreachable} lane${unreachable > 1 ? 's' : ''} cannot be reached from any entry point.`,
    });
  }
  if (stranded > 0) {
    out.push({
      severity: 'info', code: 'stranded-lanes',
      message: `${stranded} lane${stranded > 1 ? 's' : ''} lead nowhere.`,
    });
  }

  return out;
}
