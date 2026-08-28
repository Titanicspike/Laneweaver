/**
 * `compile(editModel) -> Network`.
 *
 * A pure function: same document in, same network out, every time. Nothing here
 * reaches back into the edit model, and nothing produced here is ever persisted.
 */

import { makeBbox, type Bbox } from '../../geom/polyline';
import type {
  Diagnostic, EditModel, Junction, Lane, Network, Portal, Segment, TurnLaneChoice, Zone,
} from '../types';
import { LaneKind } from '../types';
import { prepareStrokes } from './prepare';
import { facing, findMeetings, leaves, pairAngle, type Meeting, type MeetingParticipant } from './crossings';
import { auxSplitPoints, planAuxLanes, planRamps } from './ramps';
import { planLinks } from './links';
import { planTurnLanes } from './turnLanes';
import { buildSegments, gradeSplitPoints, planSegmentRanges } from './segments';
import { buildJunctions, paintApproaches } from './junctions';
import { buildSignalPlan, validateSignalPlan } from './signals';
import { validateNetwork } from './validate';
import { gatewayOverrideAt, junctionOverrideAt } from '../model';

function dedupeLinks(lanes: Lane[]): void {
  for (const lane of lanes) {
    if (lane.successors.length > 1) {
      lane.successors = [...new Set(lane.successors)].sort((a, b) => a - b);
    }
    if (lane.predecessors.length > 1) {
      lane.predecessors = [...new Set(lane.predecessors)].sort((a, b) => a - b);
    }
    if (lane.conflicts.length > 1) {
      lane.conflicts.sort((a, b) => a.sSelf - b.sSelf || a.other - b.other);
    }
  }
}

/**
 * Groups the lanes of every road carrying a land use into one zone per use.
 *
 * One zone per *use*, not per road: "residential" is where the town's traffic comes
 * from, taken as a whole, and a driver leaving one street for another street of the
 * same kind is a trip nobody makes on purpose. It also keeps the routing cheap —
 * one backward Dijkstra per zone rather than one per street, which on the town grid
 * is two tables instead of ninety.
 *
 * Auxiliary lanes and connectors are left out: you do not park on a slip road, and
 * a trip that ends inside a junction is one the sim would have to invent a meaning
 * for.
 */
function buildZones(segments: Segment[], lanes: Lane[], firstId: number): Zone[] {
  // One zone per zoned *street* — every segment of a stroke, taken together.
  //
  // It used to be one zone per land use, on the argument that a trip is "to the
  // shops" rather than to a particular shop and that one cost table per use is
  // cheaper than one per street. The consequence was measured on a real network:
  // with "the commercial zone" as the destination, the routing field sends every
  // driver to the *nearest* commercial street, so 12 of 83 shop streets received
  // every arrival on the map, the median trip was 400 m, and the freeway carried
  // nothing at all. Per street, a trip has a destination somewhere in particular,
  // and the spawner can spread destinations over the map. The cost tables are built
  // lazily per destination, so a street nobody is heading for costs nothing.
  const byStroke = new Map<number, Zone>();
  for (const seg of segments) {
    // The *segment's* land use, not its profile's. The segment already carries the
    // road's own zoning painted over the road type's, and reading the profile here
    // instead splits the two apart: a painted street grows houses, because the
    // renderer reads the segment, and generates no traffic, because this did not.
    const use = seg.landUse;
    if (!use) continue;
    let zone = byStroke.get(seg.strokeId);
    if (!zone) {
      zone = { id: 0, landUse: use, x: 0, y: 0, lanes: [], frontage: 0 };
      byStroke.set(seg.strokeId, zone);
    }
    for (const id of seg.laneIds) {
      const lane = lanes[id];
      if (lane.aux || lane.kind === LaneKind.Connector) continue;
      zone.lanes.push(id);
      zone.frontage += lane.length;
      zone.x += lane.centerline[0] * lane.length;
      zone.y += lane.centerline[1] * lane.length;
    }
  }
  // In stroke order so ids are stable across recompiles, and lanes sorted within a
  // zone so every iteration over them is deterministic.
  const out: Zone[] = [...byStroke.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  for (const zone of out) {
    zone.id = firstId + out.indexOf(zone);
    zone.lanes.sort((a, b) => a - b);
    if (zone.frontage > 0) { zone.x /= zone.frontage; zone.y /= zone.frontage; }
  }
  return out.filter((z) => z.lanes.length > 0);
}

function buildPortals(segments: Segment[], lanes: Lane[]): Portal[] {
  const portals: Portal[] = [];
  for (const seg of segments) {
    for (const atEnd of [false, true]) {
      const junction = atEnd ? seg.endJunction : seg.startJunction;
      if (junction >= 0) continue;
      const entry: number[] = [];
      const exit: number[] = [];
      for (const id of seg.laneIds) {
        const lane = lanes[id];
        if (lane.aux) continue;
        const flowsToEnd = lane.side === 1;
        if (flowsToEnd === atEnd) {
          // A portal is where the network stops, which is where a lane has nowhere
          // left to go — not merely where no junction was recorded. A plain split
          // wires its lanes straight across without one, and reading that as a free
          // end drops a spawn point into the middle of a running carriageway:
          // vehicles appear on top of traffic crossing the boundary, and the ones
          // behind stop dead.
          if (lane.successors.length) continue;
          if (lane.endsAt === Infinity) exit.push(id);
        } else if (lane.startsAt <= 0.01) {
          if (lane.predecessors.length) continue;
          entry.push(id);
        }
      }
      if (!entry.length && !exit.length) continue;
      const px = atEnd ? seg.centerline[seg.centerline.length - 2] : seg.centerline[0];
      const py = atEnd ? seg.centerline[seg.centerline.length - 1] : seg.centerline[1];
      portals.push({
        id: portals.length,
        name: `Portal ${portals.length + 1}`,
        x: px,
        y: py,
        entryLanes: entry,
        exitLanes: exit,
        weight: 1,
        role: 'both',
      });
    }
  }
  return portals;
}

function boundsOf(segments: Segment[], lanes: Lane[]): Bbox {
  const b = makeBbox();
  const consume = (poly: ArrayLike<number>): void => {
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i] < b.minX) b.minX = poly[i];
      if (poly[i] > b.maxX) b.maxX = poly[i];
      if (poly[i + 1] < b.minY) b.minY = poly[i + 1];
      if (poly[i + 1] > b.maxY) b.maxY = poly[i + 1];
    }
  };
  for (const s of segments) consume(s.surface);
  for (const l of lanes) consume(l.centerline);
  if (!Number.isFinite(b.minX)) {
    b.minX = -100; b.minY = -100; b.maxX = 100; b.maxY = 100;
  }
  return b;
}

/**
 * Re-applies the user's choices for a junction: what controls it, and — when that
 * is a signal — the phase plan itself. Junctions have no stable identity across
 * recompiles, so overrides are matched by position within a tolerance derived from
 * the junction's own size.
 *
 * The plan is rebuilt whether or not the control *changed*, because a junction the
 * compiler already decided to signalise still has to pick up a plan the document
 * holds for it. Reading the override only when it disagrees about the control is
 * how a hand-authored plan gets silently ignored at exactly the junctions that
 * wanted one most.
 */
function applyJunctionOverrides(
  model: EditModel, junctions: Junction[], lanes: Lane[], segments: Segment[],
  diagnostics: Diagnostic[],
): void {
  for (const junction of junctions) {
    if (junction.kind !== 'crossing') continue;
    const best = model.junctions.length
      ? junctionOverrideAt(model.junctions, junction.x, junction.y, junction.radius)
      : undefined;
    if (best) {
      // A right-in / right-out runs on priority whatever the document says: a
      // signal here would stop the traffic the arrangement exists to leave alone.
      junction.control = junction.rightInRightOut ? 'priority' : best.control;
      junction.turnOnRed = best.turnOnRed !== false;
    }
    if (junction.control !== 'signal') {
      junction.signal = undefined;
      for (const id of junction.connectorIds) lanes[id].signalGroup = -1;
      continue;
    }
    junction.signal = buildSignalPlan(
      lanes, segments, junction.approaches, junction.connectorIds, best?.signal,
    );
    diagnostics.push(...validateSignalPlan(
      lanes, segments, junction.approaches, junction.connectorIds, junction.signal, junction,
    ));
  }
}

export function compile(model: EditModel): Network {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const driveOnRight = model.settings.driveOnRight;
  const diagnostics: Diagnostic[] = [];
  const lanes: Lane[] = [];

  const strokes = prepareStrokes(model);
  const { meetings, diagnostics: meetDiags } = findMeetings(strokes);
  diagnostics.push(...meetDiags);

  const { plans: rampPlans, diagnostics: rampDiags } = planRamps(strokes, meetings, driveOnRight);
  // An option lane is a property of the gore, so it has to be known before the
  // auxiliary lanes are planned: the through lane is one of the exit's feeders, not
  // an extra one, so the ramp needs one auxiliary lane fewer.
  for (const plan of rampPlans) {
    const override = junctionOverrideAt(model.junctions, plan.meeting.x, plan.meeting.y);
    plan.optionLane = plan.kind === 'diverge' && override?.optionLane === true;
    plan.addedLanes = plan.kind === 'merge'
      ? Math.max(0, Math.min(plan.rampLanes, Math.floor(override?.addedLanes ?? 0)))
      : 0;
  }
  diagnostics.push(...rampDiags);
  const { aux: auxPlans, diagnostics: auxDiags } = planAuxLanes(rampPlans, strokes, meetings, driveOnRight);
  diagnostics.push(...auxDiags);

  const { links, transitions, diagnostics: linkDiags } = planLinks(strokes, meetings, driveOnRight);
  diagnostics.push(...linkDiags);

  const rampCuts = rampPlans.map((p) => ({
    strokeIdx: p.rampStrokeIdx,
    s: p.rampCutS,
    keepBelow: p.rampEnd === 1,
  }));
  // An option lane needs the kerb-side through lane to *end* at the gore, so it has
  // somewhere to branch from — the one place a diverge splits the road it leaves,
  // and only where the document asks for it.
  const optionSplits = rampPlans
    .filter((p) => p.optionLane)
    .map((p) => ({ strokeIdx: p.roadStrokeIdx, s: p.sGoreRoad }));
  const firstRanges = planSegmentRanges(strokes, meetings, rampCuts,
    [...auxSplitPoints(auxPlans), ...gradeSplitPoints(strokes), ...optionSplits]);
  let ranges = firstRanges.ranges;
  const rangeDiags = firstRanges.diagnostics;
  diagnostics.push(...rangeDiags);

  const rightInRightOutAt = (x: number, y: number, radius?: number): boolean =>
    junctionOverrideAt(model.junctions, x, y, radius)?.rightInRightOut === true;
  const turnChoice = (meeting: Meeting, approach: string): TurnLaneChoice => {
    const override = junctionOverrideAt(model.junctions, meeting.x, meeting.y);
    return override?.turnLanes?.find((t) => t.approach === approach)?.choice ?? 'auto';
  };
  const riroAt = (meeting: Meeting): boolean => rightInRightOutAt(meeting.x, meeting.y, meeting.radius);
  let turnLanes = planTurnLanes(strokes, meetings, ranges, turnChoice, riroAt);
  diagnostics.push(...turnLanes.diagnostics);

  // A turn bay flares its approach a lane wider, and the arms crossing that
  // approach were trimmed to clear the road's *profile* width — bays are planned
  // from the segments the trims define, so the first pass cannot know about them.
  // The difference is a street's cap corner a metre inside the arterial's flare,
  // and at a skew crossing its zebra crossing drawn over the arterial's kerb. So:
  // for every bay, push out each arm that crosses its approach by the flare over
  // the sine of the angle between them, and plan the segments again. Once is
  // enough — a bay's own length changes by a couple of metres at most, and the
  // second plan is asked with the same rules.
  // Which arms a bay's flare pushes out, and by how much. A left bay slides the
  // approach's through lanes toward its own kerb, so the flare is on that kerb and
  // upstream of the junction: an arm faces it only if it leaves the meeting on that
  // side. The two bays of one through road flare opposite kerbs, so a road crossing
  // it has one arm against each — and takes the larger, never the sum. Summing them
  // set a minor road back by both flares at once, four metres past what either
  // kerb asked, and on a priority crossing that was the difference between a side
  // street that found its gaps and one that starved.
  const flared = new Map<MeetingParticipant, { extra: number; meeting: Meeting }>();
  for (const plan of turnLanes.plans) {
    if (plan.widen <= 0.01) continue;
    const range = ranges[plan.rangeIdx];
    const mi = plan.atEnd ? range.endMeeting : range.startMeeting;
    const meeting = mi >= 0 ? meetings[mi] : undefined;
    const me = meeting?.participants.find((p) => p.strokeIdx === range.strokeIdx);
    if (!meeting || !me) continue;
    const dx = plan.side * me.tx, dy = plan.side * me.ty;
    const kx = -dy, ky = dx;
    for (const q of meeting.participants) {
      if (q === me || facing(me, q)) continue;
      if (!leaves(q).some(([ax, ay]) => ax * kx + ay * ky > 0)) continue;
      const extra = plan.widen / Math.max(Math.sin(pairAngle(me, q)), 0.35);
      const had = flared.get(q);
      if (!had || extra > had.extra) flared.set(q, { extra, meeting });
    }
  }
  const grew = flared.size > 0;
  for (const [q, { extra, meeting }] of flared) {
    q.trim += extra;
    meeting.radius = Math.max(meeting.radius, q.trim);
  }
  if (grew) {
    const again = planSegmentRanges(strokes, meetings, rampCuts,
      [...auxSplitPoints(auxPlans), ...gradeSplitPoints(strokes), ...optionSplits]);
    ranges = again.ranges;
    turnLanes = planTurnLanes(strokes, meetings, ranges, turnChoice, riroAt);
  }

  const built = buildSegments(strokes, ranges, auxPlans, transitions, turnLanes.plans, driveOnRight, lanes);
  diagnostics.push(...built.diagnostics);

  const { junctions, diagnostics: junctionDiags } = buildJunctions({
    laneLinks: model.laneLinks,
    rightInRightOutAt,
    strokes,
    meetings,
    segments: built.segments,
    ranges: built.ranges,
    lanes,
    links,
    rampPlans,
    auxPlans,
    auxLaneByPlan: built.auxLaneByPlan,
    driveOnRight,
  });
  diagnostics.push(...junctionDiags);

  applyJunctionOverrides(model, junctions, lanes, built.segments, diagnostics);
  // After the overrides: the control choice decides whether STOP gets painted.
  for (const junction of junctions) paintApproaches(lanes, built.segments, junction);
  dedupeLinks(lanes);
  const portals = buildPortals(built.segments, lanes);
  // The user's choice about each end of the network, keyed by position because
  // portal ids are derived data like everything else here.
  for (const portal of portals) {
    const chosen = gatewayOverrideAt(model.gateways, portal.x, portal.y);
    if (chosen) portal.role = chosen.role;
  }
  const zones = buildZones(built.segments, lanes, portals.length);

  let connectors = 0;
  let totalLaneLength = 0;
  for (const lane of lanes) {
    if (lane.kind === LaneKind.Connector) connectors++;
    totalLaneLength += lane.length;
  }

  const network: Network = {
    segments: built.segments,
    lanes,
    junctions,
    portals,
    zones,
    diagnostics,
    bounds: boundsOf(built.segments, lanes),
    driveOnRight,
    stats: {
      strokes: strokes.length,
      segments: built.segments.length,
      lanes: lanes.length - connectors,
      connectors,
      junctions: junctions.length,
      portals: portals.length,
      totalLaneLength,
      compileMs: 0,
    },
  };

  network.diagnostics.push(...validateNetwork(network));
  network.stats.compileMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
  return network;
}

export { prepareStrokes, findMeetings };
