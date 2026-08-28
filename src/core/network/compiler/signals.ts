/**
 * Signal plans: what a junction's phases are, and how the document says so.
 *
 * A plan is a list of phases; each greens a set of **movement groups**, runs amber,
 * then all-red before the next. A movement group is every connector that leaves one
 * approach making one kind of turn — which is the granularity a signal actually
 * works at. "The left turn off the northbound arm" is one thing to a traffic
 * engineer however many lanes feed it, it survives a recompile (connector ids do
 * not), and it is the unit a protected left turn is expressed in: a phase that
 * greens a left group while the opposing through group is red.
 *
 * Nothing here decides whether a turn is protected. That is a property of the
 * *phase*, computed from the plan by `protectionOf`: a movement is protected when
 * nothing else green at the same time crosses it, and permissive when something
 * does and it has to find a gap. Storing it per movement instead would let the
 * label disagree with what the traffic does.
 */

import { TurnKind } from '../types';
import type {
  Approach, Diagnostic, Junction, Lane, Segment, SignalPhase, SignalPlan, SignalPlanSpec,
} from '../types';
import type { Id } from '../../util/ids';
import { wrapAngle } from '../../geom/vec2';

/** Turn letters used in a group name. Compact, and readable in a save file. */
const TURN_LETTER: Record<number, string> = {
  [TurnKind.Straight]: 'S',
  [TurnKind.Left]: 'L',
  [TurnKind.Right]: 'R',
  [TurnKind.UTurn]: 'U',
  [TurnKind.Merge]: 'S',
  [TurnKind.Diverge]: 'S',
};

const TURN_WORD: Record<string, string> = { S: 'through', L: 'left', R: 'right', U: 'U-turn' };

/** Phase order within an approach: through first, then right, then left, then U. */
const TURN_RANK: Record<string, number> = { S: 0, R: 1, L: 2, U: 3 };

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Which way the traffic in this approach came *from*, as a compass point.
 *
 * `heading` is the direction of travel into the junction, so the arm is behind the
 * vehicle. World +y is south (the camera draws it downward), which is what makes
 * the label agree with where the arm sits on screen.
 */
export function compassOf(heading: number): string {
  const dx = -Math.cos(heading);
  const dy = -Math.sin(heading);
  const fromNorth = Math.atan2(dx, -dy); // 0 = north, +pi/2 = east
  const i = Math.round((fromNorth / (Math.PI * 2)) * 8 + 8) % 8;
  return COMPASS[i]!;
}

/** Every connector leaving one approach and making one kind of turn. */
export interface MovementGroup {
  /** `strokeId:side:turn`, stable across recompiles. */
  key: string;
  /** "From N · left", which is how the panel names it. */
  label: string;
  turn: TurnKind;
  letter: string;
  connectorIds: Id[];
  /** Direction of travel into the junction, radians. */
  heading: number;
  /** Index into `junction.approaches`, so the panel can group by arm. */
  approachIndex: number;
}

function groupKey(lanes: Lane[], segments: Segment[], connector: Lane): string | null {
  const from = lanes[connector.predecessors[0]!];
  const seg = from ? segments[from.segmentId] : undefined;
  if (!from || !seg) return null;
  return `${seg.strokeId}:${from.side}:${TURN_LETTER[connector.turn] ?? 'S'}`;
}

/**
 * The junction's movement groups, in the order the panel lists them: by arm going
 * clockwise from north, and within an arm through, right, left, U-turn.
 */
export function movementGroups(
  lanes: Lane[], segments: Segment[], approaches: Approach[], connectorIds: Id[],
): MovementGroup[] {
  const approachOf = new Map<number, number>();
  for (let i = 0; i < approaches.length; i++) {
    for (const id of approaches[i]!.incomingLanes) approachOf.set(id, i);
  }

  const byKey = new Map<string, MovementGroup>();
  for (const id of connectorIds) {
    const connector = lanes[id]!;
    const key = groupKey(lanes, segments, connector);
    if (key === null) continue;
    let group = byKey.get(key);
    if (!group) {
      const ai = approachOf.get(connector.predecessors[0]!) ?? 0;
      const heading = approaches[ai]?.heading ?? 0;
      const letter = key.slice(key.lastIndexOf(':') + 1);
      group = {
        key,
        label: `From ${compassOf(heading)} · ${TURN_WORD[letter] ?? letter}`,
        turn: connector.turn,
        letter,
        connectorIds: [],
        heading,
        approachIndex: ai,
      };
      byKey.set(key, group);
    }
    group.connectorIds.push(id);
  }

  const out = [...byKey.values()];
  for (const g of out) g.connectorIds.sort((a, b) => a - b);
  out.sort((a, b) => {
    const ca = clockwise(a.heading);
    const cb = clockwise(b.heading);
    if (Math.abs(ca - cb) > 1e-6) return ca - cb;
    const ra = TURN_RANK[a.letter] ?? 4;
    const rb = TURN_RANK[b.letter] ?? 4;
    if (ra !== rb) return ra - rb;
    return a.key < b.key ? -1 : 1;
  });
  return out;
}

/** Angle of the arm measured clockwise from north, so arms sort the way they look. */
function clockwise(heading: number): number {
  const a = Math.atan2(-Math.cos(heading), Math.sin(heading));
  return a < 0 ? a + Math.PI * 2 : a;
}

/**
 * Approaches grouped into opposing pairs.
 *
 * Two arms more than 150 degrees apart are the same axis and can run together; an
 * arm with nothing opposite it — the stem of a T, the fifth leg of a five-way — is
 * an axis of its own, which is what keeps the generator working on any geometry.
 */
export function axesOf(approaches: Approach[]): Approach[][] {
  const axes: Approach[][] = [];
  const used = new Set<Approach>();
  for (const a of approaches) {
    if (used.has(a) || a.incomingLanes.length === 0) continue;
    const group = [a];
    used.add(a);
    for (const b of approaches) {
      if (used.has(b) || b.incomingLanes.length === 0) continue;
      if (Math.abs(wrapAngle(a.heading - b.heading)) > (150 * Math.PI) / 180) {
        group.push(b);
        used.add(b);
      }
    }
    axes.push(group);
  }
  return axes;
}

export type SignalPreset = 'permissive' | 'protected' | 'split';

export const PRESET_LABELS: Record<SignalPreset, string> = {
  permissive: 'Permissive lefts',
  protected: 'Protected lefts',
  split: 'One arm at a time',
};

const TIMING = { green: 26, amber: 3.5, allRed: 1.5 };
/** Speed the last vehicle through a junction is assumed to clear it at, m/s. */
const CLEARING_SPEED = 9;
const CLEARING_BOUNDS = [1.5, 5] as const;

/**
 * All-red long enough for the last vehicle in to get out.
 *
 * Sized from the junction rather than fixed, the way a real intergreen is: a wide
 * or skew crossing has connectors two or three times the length of a small one, and
 * a clearance that suits the small one leaves the big one with traffic still inside
 * the box when the next phase starts. Then the arriving stream meets the departing
 * one head on in the middle, and on a saturated junction that is how the whole box
 * fills with vehicles blocking each other in a ring.
 */
function clearanceFor(lanes: Lane[], groups: MovementGroup[]): number {
  let longest = 0;
  for (const g of groups) {
    for (const id of g.connectorIds) longest = Math.max(longest, lanes[id]?.length ?? 0);
  }
  const seconds = (longest + 5) / CLEARING_SPEED;
  return Math.round(Math.max(CLEARING_BOUNDS[0], Math.min(CLEARING_BOUNDS[1], seconds)) * 10) / 10;
}
/** A left-turn phase serves far fewer vehicles, so it gets a shorter green. */
const LEFT_GREEN = 14;
/** Longest cycle a generated plan will produce, before its greens are scaled down. */
const MAX_CYCLE = 120;
const MIN_GREEN = 8;

/**
 * Does this approach have a lane that turns left and nothing else?
 *
 * It is the question that decides whether a protected left phase is worth having.
 * With a bay, holding the through movements red discharges the bay and nothing
 * else; without one, the left shares a lane with the through traffic, and then a
 * left-only phase is stopped by the first driver who wanted to go straight while
 * the through phase is stopped by the first who wanted to turn. Splitting the two
 * out on a single-lane approach does not protect the turn, it blocks the road.
 */
export function hasLeftBay(lanes: Lane[], approach: Approach): boolean {
  for (const id of approach.incomingLanes) {
    const outs = (lanes[id]?.successors ?? [])
      .map((sid) => lanes[sid])
      .filter((l): l is Lane => !!l && l.kind === 1);
    if (!outs.length) continue;
    if (outs.every((o) => o.turn === TurnKind.Left || o.turn === TurnKind.UTurn)) return true;
  }
  return false;
}

/**
 * A plan generated from the junction's own geometry.
 *
 * - `permissive` runs each axis in one phase, left turns included: a left-turner
 *   crosses on a gap, which is what an unmarked green ball means.
 * - `protected` splits each axis into its through movements and then its lefts, so
 *   a left turn gets the junction to itself and never has to find a gap.
 * - `split` gives every arm the junction on its own. It is the slowest plan and the
 *   only one that is safe on any geometry whatever, which is why it is what an
 *   awkward junction should fall back to.
 */
export function presetPhases(
  preset: SignalPreset, groups: MovementGroup[], approaches: Approach[], lanes: Lane[] = [],
): { groups: string[]; green: number; amber: number; allRed: number }[] {
  const inApproach = (indices: Set<number>, letters: string[]): string[] =>
    groups.filter((g) => indices.has(g.approachIndex) && letters.includes(g.letter))
      .map((g) => g.key);

  const indexOf = new Map<Approach, number>();
  for (let i = 0; i < approaches.length; i++) indexOf.set(approaches[i]!, i);

  const allRed = clearanceFor(lanes, groups);
  const phases: { groups: string[]; green: number; amber: number; allRed: number }[] = [];
  const push = (keys: string[], green: number): void => {
    if (keys.length) phases.push({ groups: keys, green, amber: TIMING.amber, allRed });
  };

  if (preset === 'split') {
    for (let i = 0; i < approaches.length; i++) {
      push(inApproach(new Set([i]), ['S', 'R', 'L', 'U']), TIMING.green * 0.7);
    }
    return fitCycle(phases);
  }

  for (const axis of axesOf(approaches)) {
    const indices = new Set(axis.map((a) => indexOf.get(a) ?? -1));
    if (preset === 'permissive') {
      push(inApproach(indices, ['S', 'R', 'L', 'U']), TIMING.green);
      continue;
    }
    // Protected: the lefts lead, on their own, then the through movements. An arm
    // earns that only if it has somewhere to hold the turners *and* something to
    // be protected from — a left that nothing green would cross is already
    // protected, and giving it a phase of its own only lengthens the cycle for
    // everybody. That is what keeps the plan honest on a T, where the stem's left
    // is opposed by nothing, and on a one-way arm, which has no opposing through
    // at all.
    const axisGreen = new Set<number>();
    for (const g of groups) {
      if (indices.has(g.approachIndex)) for (const id of g.connectorIds) axisGreen.add(id);
    }
    const protectedArms = new Set([...indices].filter((i) => {
      const arm = approaches[i];
      if (!arm || !hasLeftBay(lanes, arm)) return false;
      const lefts = groups.filter((g) => g.approachIndex === i && (g.letter === 'L' || g.letter === 'U'));
      return lefts.some((g) => g.connectorIds.some((id) => (lanes[id]?.conflicts ?? []).some((c) => {
        if (!axisGreen.has(c.other)) return false;
        const turn = lanes[c.other]?.turn;
        return turn === TurnKind.Straight || turn === TurnKind.Right;
      })));
    }));
    const permissiveArms = new Set([...indices].filter((i) => !protectedArms.has(i)));
    push(inApproach(protectedArms, ['L', 'U']), LEFT_GREEN);
    push([
      ...inApproach(indices, ['S', 'R']),
      ...inApproach(permissiveArms, ['L', 'U']),
    ], TIMING.green);
  }
  return fitCycle(phases);
}

/**
 * Keeps a generated cycle to something a driver would sit through.
 *
 * Phase count grows with the junction — five arms split one at a time, or four
 * arms with four bays — and a plan whose cycle runs past two minutes is one where
 * everybody's wait is dominated by the plan rather than by the traffic. Greens are
 * scaled together so the split between them is preserved; the intergreen is safety
 * timing and is never touched.
 */
function fitCycle(
  phases: { groups: string[]; green: number; amber: number; allRed: number }[],
): { groups: string[]; green: number; amber: number; allRed: number }[] {
  const fixed = phases.reduce((a, p) => a + p.amber + p.allRed, 0);
  const green = phases.reduce((a, p) => a + p.green, 0);
  const room = MAX_CYCLE - fixed;
  if (green <= room || room <= 0) return phases;
  const scale = room / green;
  for (const phase of phases) phase.green = Math.max(MIN_GREEN, Math.round(phase.green * scale * 2) / 2);
  return phases;
}

/** The plan the compiler falls back to when the document has nothing to say. */
export function defaultSpec(
  groups: MovementGroup[], approaches: Approach[], lanes: Lane[],
): SignalPlanSpec {
  return { offset: 0, phases: presetPhases('permissive', groups, approaches, lanes) };
}

/**
 * Compile a plan: resolve each phase's group names to the connectors that exist now.
 *
 * A name that no longer matches anything simply contributes no connectors, which is
 * what should happen when a road is redrawn under a plan — the phase shortens rather
 * than the plan collapsing. `validateSignalPlan` is what tells the user about it.
 */
export function buildSignalPlan(
  lanes: Lane[], segments: Segment[], approaches: Approach[], connectorIds: Id[],
  spec?: SignalPlanSpec,
): SignalPlan {
  const groups = movementGroups(lanes, segments, approaches, connectorIds);
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const source: 'auto' | 'custom' = spec && spec.phases.length ? 'custom' : 'auto';
  const use = source === 'custom' ? spec! : defaultSpec(groups, approaches, lanes);

  const phases: SignalPhase[] = [];
  for (const phase of use.phases) {
    const green = new Set<Id>();
    for (const key of phase.groups) {
      for (const id of byKey.get(key)?.connectorIds ?? []) green.add(id);
    }
    phases.push({
      greenLanes: [...green].sort((a, b) => a - b),
      groups: [...phase.groups],
      green: Math.max(1, phase.green),
      amber: Math.max(0, phase.amber),
      allRed: Math.max(0, phase.allRed),
    });
  }
  // A phase with nothing to green would hold the whole junction on red for its
  // duration. Keep it out of the running plan; the panel still shows it, and
  // validation says why it is empty.
  const live = phases.filter((p) => p.greenLanes.length > 0);
  const running = live.length ? live : phases.slice(0, 1);

  for (const id of connectorIds) lanes[id]!.signalGroup = -1;
  for (let i = 0; i < running.length; i++) {
    for (const id of running[i]!.greenLanes) lanes[id]!.signalGroup = i;
  }
  const cycle = running.reduce((acc, p) => acc + p.green + p.amber + p.allRed, 0);
  return {
    offset: use.offset ?? 0, phases: running, cycle, source,
    actuated: use.actuated === true,
  };
}

/** One signalised junction on a corridor, and how far along it sits. */
export interface CorridorStop {
  junctionId: Id;
  /** Metres along the shared road, from the first stop. */
  distance: number;
  /** Offset in seconds that would put a platoon through every stop on green. */
  offset: number;
}

/**
 * The signalised junctions sharing a road with this one, in order along it.
 *
 * A green wave is the one thing a signal *offset* is for, and computing it needs
 * only two facts the compiled network already has: which road two junctions share,
 * and how far apart they are along it. The road chosen is whichever stroke the most
 * of this junction's arms belong to — on a crossroads that is ambiguous, so the tie
 * breaks on stroke id and the caller can run it again from the other road.
 */
export function corridor(
  net: { junctions: Junction[]; segments: Segment[] },
  from: Junction,
  speed: number,
): CorridorStop[] {
  const alongStroke = (junction: Junction, strokeId: number): number | null => {
    for (const approach of junction.approaches) {
      const seg = net.segments[approach.segmentId];
      if (!seg || seg.strokeId !== strokeId) continue;
      return approach.atSegmentEnd ? seg.strokeS1 : seg.strokeS0;
    }
    return null;
  };

  const counts = new Map<number, number>();
  for (const approach of from.approaches) {
    const seg = net.segments[approach.segmentId];
    if (!seg) continue;
    counts.set(seg.strokeId, (counts.get(seg.strokeId) ?? 0) + 1);
  }
  let strokeId = -1;
  let best = 0;
  for (const [id, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (n > best) { best = n; strokeId = id; }
  }
  if (strokeId < 0) return [];

  const stops: { junctionId: Id; at: number }[] = [];
  for (const junction of net.junctions) {
    if (junction.kind !== 'crossing' || junction.control !== 'signal') continue;
    const at = alongStroke(junction, strokeId);
    if (at === null) continue;
    stops.push({ junctionId: junction.id, at });
  }
  stops.sort((a, b) => a.at - b.at || a.junctionId - b.junctionId);
  if (stops.length < 2) return [];

  const base = stops[0]!.at;
  const v = Math.max(1, speed);
  return stops.map((stop) => ({
    junctionId: stop.junctionId,
    distance: stop.at - base,
    offset: Math.round(((stop.at - base) / v) * 10) / 10,
  }));
}

/** Whether each green movement in a phase has the junction to itself. */
export type Protection = 'protected' | 'permissive';

/**
 * How a movement is protected during one phase.
 *
 * Protected means nothing else green at the same time crosses its path; permissive
 * means something does, and the driver has to find a gap. This is read off the
 * compiled conflict points, so it says what the traffic will actually do.
 */
export function protectionOf(lanes: Lane[], phase: SignalPhase, connectorId: Id): Protection {
  const green = new Set(phase.greenLanes);
  for (const conflict of lanes[connectorId]!.conflicts) {
    if (conflict.other !== connectorId && green.has(conflict.other)) return 'permissive';
  }
  return 'protected';
}

/**
 * Problems worth telling the user about.
 *
 * Two crossing movements green together is normal when one of them is a turn — that
 * is what a permissive left is. Two crossing movements where *neither* turns is a
 * mistake nobody would make on purpose: it greens two streams that both expect to
 * drive straight through each other.
 */
export function validateSignalPlan(
  lanes: Lane[], segments: Segment[], approaches: Approach[], connectorIds: Id[],
  plan: SignalPlan, at: { x: number; y: number },
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const groups = movementGroups(lanes, segments, approaches, connectorIds);

  const served = new Set<Id>();
  for (const phase of plan.phases) for (const id of phase.greenLanes) served.add(id);
  const starved = groups.filter((g) => g.connectorIds.every((id) => !served.has(id)));
  for (const group of starved) {
    out.push({
      severity: 'warning',
      code: 'signal-movement-never-green',
      message: `${group.label} never gets a green at this junction.`,
      x: at.x, y: at.y,
    });
  }

  const armOf = new Map<Id, number>();
  for (const g of groups) for (const id of g.connectorIds) armOf.set(id, g.approachIndex);
  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i]!;
    if (crossingThroughPair(lanes, armOf, phase.greenLanes)) {
      out.push({
        severity: 'error',
        code: 'signal-phase-conflict',
        message: `Phase ${i + 1} greens two streams that drive straight through each other.`,
        x: at.x, y: at.y,
      });
    }
  }
  return out;
}

/** A crossing, rather than a near-parallel or head-on brush between two curves. */
const CROSSING_BAND = [(30 * Math.PI) / 180, (150 * Math.PI) / 180] as const;

/**
 * Two through movements from different arms that genuinely cross.
 *
 * The angle band is what makes this a real finding rather than noise. Connectors
 * are sampled polylines, so on a curved crossing the two directions of *one* road
 * brush against each other at 155 degrees, and two lanes of the same stream cross
 * at 16 — neither is a pair of streams driving through each other, and reporting
 * them puts an error on the compiler's own default plan. A shared destination is
 * recorded at zero degrees, which is a merge and not this either.
 */
export function crossingThroughPair(
  lanes: Lane[], armOf: ReadonlyMap<Id, number>, green: readonly Id[],
): boolean {
  const lit = new Set(green);
  for (const id of green) {
    const lane = lanes[id];
    if (!lane || lane.turn !== TurnKind.Straight) continue;
    for (const conflict of lane.conflicts) {
      if (!lit.has(conflict.other) || conflict.other === id) continue;
      const other = lanes[conflict.other];
      if (!other || other.turn !== TurnKind.Straight) continue;
      if (armOf.get(id) === armOf.get(conflict.other)) continue;
      if (conflict.angle < CROSSING_BAND[0] || conflict.angle > CROSSING_BAND[1]) continue;
      return true;
    }
  }
  return false;
}
