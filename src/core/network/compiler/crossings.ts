/**
 * Compile steps 2-3: find where strokes meet, and classify each meeting.
 *
 * Only strokes of the same grade can meet — different grades stack visually and
 * never interact. Meetings come from two sources: proper segment crossings found
 * through the R-tree, and stroke endpoints that land on (or very near) another
 * stroke, which is how ramps and T-junctions are drawn.
 */

import { SegmentIndex } from '../../geom/spatial';
import { segmentIntersect, makeSegHit, closestParamOnSegment } from '../../geom/intersect';
import { sampleTangent } from '../../geom/polyline';
import { wrapAngle } from '../../geom/vec2';
import type { Diagnostic, JunctionKind } from '../types';
import { TurnKind } from '../types';
import type { PreparedStroke } from './prepare';

/** Below this crossing angle a meeting without an endpoint is a sliver, not a junction. */
export const NEAR_PARALLEL_ANGLE = (8 * Math.PI) / 180;
/** At or below this, an endpoint meeting is a ramp rather than a T-junction. */
export const SHALLOW_ANGLE = (30 * Math.PI) / 180;
/** Two endpoints meeting below this angle continue one road into the next. */
export const LINK_ANGLE = (60 * Math.PI) / 180;

export type EndFlag = -1 | 0 | 1;

export interface MeetingParticipant {
  strokeIdx: number;
  /** Arc-length of the meeting on that stroke. */
  s: number;
  /** -1 at the stroke start, +1 at its end, 0 in the interior. */
  end: EndFlag;
  /** Unit tangent along the stroke at `s`. */
  tx: number;
  ty: number;
  /** How far back along the stroke the junction footprint reaches. */
  trim: number;
}

export interface Meeting {
  kind: JunctionKind;
  x: number;
  y: number;
  grade: number;
  radius: number;
  participants: MeetingParticipant[];
  /** merge/diverge only: which participant is the ramp and which is the road. */
  rampIdx: number;
  roadIdx: number;
}

interface RawHit {
  ai: number;
  bi: number;
  sa: number;
  sb: number;
  x: number;
  y: number;
}

const _hit = makeSegHit();
const _ta = { x: 0, y: 0 };

/** Undirected crossing angle in [0, PI/2]. */
export function foldAngle(ax: number, ay: number, bx: number, by: number): number {
  const c = Math.abs(ax * bx + ay * by);
  return Math.acos(Math.min(1, c));
}

/**
 * Which movement a heading pair describes. Lives here rather than with the junction
 * builder so the turn-lane planner can ask the same question before any lane exists.
 */
export function classifyTurn(inHeading: number, outHeading: number): TurnKind {
  const delta = wrapAngle(outHeading - inHeading);
  const deg = (delta * 180) / Math.PI;
  if (Math.abs(deg) < 32) return TurnKind.Straight;
  if (Math.abs(deg) > 150) return TurnKind.UTurn;
  // Screen space has +y down, so a positive delta curves clockwise: a right turn.
  return deg > 0 ? TurnKind.Right : TurnKind.Left;
}

/**
 * How far back along stroke A the junction must be trimmed so its corridor clears
 * stroke B's corridor. Grows as the crossing gets shallower, and is clamped so a
 * near-tangential T-junction cannot eat an entire road.
 */
export function trimDistance(halfA: number, halfB: number, angle: number): number {
  const sin = Math.max(Math.sin(angle), 0.35);
  const cos = Math.abs(Math.cos(angle));
  const raw = (halfB + halfA * cos) / sin + 1;
  return Math.min(raw, halfB * 6 + halfA * 2 + 4);
}

/** Every proper crossing between differently-indexed strokes, plus self-crossings. */
function findRawCrossings(strokes: PreparedStroke[]): RawHit[] {
  const index = new SegmentIndex();
  for (const s of strokes) index.addPolyline(s.index, s.points);
  index.build();

  const hits: RawHit[] = [];
  const seen = new Set<string>();
  for (const a of strokes) {
    const n = a.points.length >> 1;
    for (let i = 0; i < n - 1; i++) {
      const ax = a.points[i * 2];
      const ay = a.points[i * 2 + 1];
      const bx = a.points[i * 2 + 2];
      const by = a.points[i * 2 + 3];
      const found = index.searchBox(
        Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by),
      );
      for (const other of found) {
        const b = strokes[other.owner];
        if (other.owner === a.index) {
          // Self-crossing: ignore neighbouring segments, they always "touch".
          if (Math.abs(other.index - i) <= 1) continue;
          if (other.index < i) continue; // test each self pair once
        } else if (other.owner < a.index) {
          continue; // handled from the other side
        }
        if (!segmentIntersect(ax, ay, bx, by, other.ax, other.ay, other.bx, other.by, _hit)) continue;

        const sa = a.arclength[i] + (a.arclength[i + 1] - a.arclength[i]) * _hit.t;
        const sb = b.arclength[other.index] +
          (b.arclength[other.index + 1] - b.arclength[other.index]) * _hit.u;
        if (other.owner === a.index && Math.abs(sa - sb) < a.halfWidth * 4) continue;
        // Level is a property of the point on each road, not of the road: one that
        // ramps up crosses under what it later crosses over.
        if (a.levelAt(sa) !== b.levelAt(sb)) continue;

        // Adjacent flattened segments can both report the same crossing; keep one.
        const key = `${a.index}:${other.owner}:${Math.round(_hit.x * 10)}:${Math.round(_hit.y * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ ai: a.index, bi: other.owner, sa, sb, x: _hit.x, y: _hit.y });
      }
    }
  }
  return hits;
}

/**
 * Stroke ends that stop just short of another stroke. Drawing a ramp rarely lands
 * exactly on the centreline, so an endpoint within the other road's corridor (plus
 * a margin) counts as a meeting and gets projected onto it.
 */
function findEndpointLandings(strokes: PreparedStroke[]): RawHit[] {
  const index = new SegmentIndex();
  for (const s of strokes) index.addPolyline(s.index, s.points);
  index.build();

  const hits: RawHit[] = [];
  for (const a of strokes) {
    const n = a.points.length >> 1;
    for (const which of [0, 1] as const) {
      const pi = which === 0 ? 0 : n - 1;
      const px = a.points[pi * 2];
      const py = a.points[pi * 2 + 1];
      const sa = which === 0 ? 0 : a.length;

      let best: { bi: number; sb: number; x: number; y: number; d: number } | null = null;
      const reach = a.halfWidth * 2 + 6;
      for (const cand of index.searchBox(px - reach, py - reach, px + reach, py + reach)) {
        const b = strokes[cand.owner];
        if (cand.owner === a.index) continue;
        const tol = b.halfWidth + a.halfWidth * 0.5 + 2;
        const t = closestParamOnSegment(cand.ax, cand.ay, cand.bx, cand.by, px, py);
        const cx = cand.ax + (cand.bx - cand.ax) * t;
        const cy = cand.ay + (cand.by - cand.ay) * t;
        const d = Math.hypot(px - cx, py - cy);
        if (d > tol) continue;
        if (best && d >= best.d) continue;
        const sb = b.arclength[cand.index] +
          (b.arclength[cand.index + 1] - b.arclength[cand.index]) * t;
        // A ramp that lands on a road it passes under is not a ramp onto it.
        if (a.levelAt(sa) !== b.levelAt(sb)) continue;
        best = { bi: cand.owner, sb, x: cx, y: cy, d };
      }
      if (best) hits.push({ ai: a.index, bi: best.bi, sa, sb: best.sb, x: best.x, y: best.y });
    }
  }
  return hits;
}

interface Cluster {
  hits: RawHit[];
  x: number;
  y: number;
}

/** Groups raw hits that describe the same physical junction. */
function clusterHits(hits: RawHit[], strokes: PreparedStroke[]): Cluster[] {
  const parent = hits.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const radiusOf = (h: RawHit): number =>
    Math.max(strokes[h.ai].halfWidth, strokes[h.bi].halfWidth) * 1.6 + 1;
  /** Arc-length of hit `h` on stroke `k`, which it must be on. */
  const along = (h: RawHit, k: number): number => (h.ai === k ? h.sa : h.sb);

  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i];
      const b = hits[j];
      const r = 0.5 * (radiusOf(a) + radiusOf(b));
      const shared = a.ai === b.ai || a.ai === b.bi ? a.ai : a.bi === b.ai || a.bi === b.bi ? a.bi : -1;
      let close: boolean;
      if (shared >= 0) {
        // Two hits on the same road are the same junction if they are at the same
        // place *along* it. Measuring between the hit points instead kept two stubs
        // that meet a road from opposite sides apart whenever their ends stopped
        // short of the centreline — twelve metres between the points, one place on
        // the road — and compiled them as two T-junctions back to back.
        close = Math.abs(along(a, shared) - along(b, shared)) <= r;
      } else {
        // Hits that share no road fuse when they are within a junction's radius of
        // each other. Four separate roads all ending near one point produce exactly
        // that: each half of the through road pairs off with the stub whose end is
        // nearest, and nothing ties the two pairs together except the place — an end
        // that projects past the other stroke's start is no hit at all, so the two
        // halves of the through road never meet directly. Two genuinely unrelated
        // junctions this close are already a "too close" warning.
        close = Math.hypot(a.x - b.x, a.y - b.y) <= r;
      }
      if (!close) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  const groups = new Map<number, RawHit[]>();
  for (let i = 0; i < hits.length; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(hits[i]);
  }
  const out: Cluster[] = [];
  for (const g of groups.values()) {
    let x = 0;
    let y = 0;
    for (const h of g) {
      x += h.x;
      y += h.y;
    }
    out.push({ hits: g, x: x / g.length, y: y / g.length });
  }
  // Deterministic order: by position, then by the lowest stroke index involved.
  out.sort((a, b) => a.x - b.x || a.y - b.y ||
    Math.min(...a.hits.map((h) => h.ai)) - Math.min(...b.hits.map((h) => h.ai)));
  return out;
}

function buildParticipants(cluster: Cluster, strokes: PreparedStroke[]): MeetingParticipant[] {
  const perStroke = new Map<number, number[]>();
  for (const h of cluster.hits) {
    (perStroke.get(h.ai) ?? perStroke.set(h.ai, []).get(h.ai)!).push(h.sa);
    (perStroke.get(h.bi) ?? perStroke.set(h.bi, []).get(h.bi)!).push(h.sb);
  }
  const out: MeetingParticipant[] = [];
  for (const [strokeIdx, list] of [...perStroke.entries()].sort((a, b) => a[0] - b[0])) {
    const st = strokes[strokeIdx];
    let s = list.reduce((acc, v) => acc + v, 0) / list.length;
    const endTol = Math.max(st.halfWidth * 1.5, 2.5);
    let end: EndFlag = 0;
    if (s <= endTol) {
      end = -1;
      s = 0;
    } else if (s >= st.length - endTol) {
      end = 1;
      s = st.length;
    }
    sampleTangent(st.points, st.arclength, Math.min(s, Math.max(0, st.length - 1e-3)), _ta);
    out.push({ strokeIdx, s, end, tx: _ta.x, ty: _ta.y, trim: 0 });
  }
  return out;
}

/** Angle between two participants' stroke tangents, folded to [0, PI/2]. */
export function pairAngle(a: MeetingParticipant, b: MeetingParticipant): number {
  return foldAngle(a.tx, a.ty, b.tx, b.ty);
}

/**
 * The directions an arm leaves the meeting in: one for a stroke that ends here,
 * both for a stroke that passes through.
 */
export function leaves(p: MeetingParticipant): [number, number][] {
  if (p.end === -1) return [[p.tx, p.ty]];
  if (p.end === 1) return [[-p.tx, -p.ty]];
  return [[p.tx, p.ty], [-p.tx, -p.ty]];
}

/**
 * Two arms that face each other across the meeting — one road continuing as two
 * strokes, or a stub either side of a through road — never cross. Each leaves in
 * the direction the other arrives from.
 */
export function facing(p: MeetingParticipant, q: MeetingParticipant): boolean {
  if (p.end === 0 || q.end === 0) return false;
  const [a] = leaves(p);
  const [b] = leaves(q);
  return a[0] * b[0] + a[1] * b[1] < -FACING_COS;
}

/** Within 30 degrees of straight opposite counts as facing. */
const FACING_COS = 0.866;

function assignTrims(participants: MeetingParticipant[], strokes: PreparedStroke[]): number {
  let radius = 0;
  for (const p of participants) {
    const self = strokes[p.strokeIdx];
    let trim = self.halfWidth;
    for (const q of participants) {
      if (q === p) continue;
      // An arm is trimmed back far enough to clear every road it crosses. An arm
      // facing it across the meeting is not one of them: it is the same road
      // carrying on as a second stroke, or the stub on the other side. Folding the
      // pair's angle to zero and asking the crossing formula anyway clamped its sine
      // at twenty degrees and trimmed both arms as if they crossed at that angle —
      // a four-lane arterial drawn as two strokes meeting at a point was set back
      // 52 m where 14 would do, and the junction became a fifty-metre slab.
      if (facing(p, q)) continue;
      const other = strokes[q.strokeIdx];
      const angle = pairAngle(p, q);
      // Two corridors at a shallow angle overlap for a long way along *both*, and
      // trimming either one back past the overlap is enough: the other's corridor
      // is paved by the junction there, not by its own segment. The formula is
      // symmetric, so asked naively both roads took the long trim — a slip road
      // joining an arterial at twenty degrees set the arterial back 35 m to clear
      // a road that was merely alongside it. The arm that yields is the one that
      // ends here, or failing that the narrower; the other is set back only as far
      // as a stub meeting it square on would require.
      const shallow = angle < SHALLOW_PAIR;
      // When the other arm is the one that yields, this one gets the short trim.
      const otherYields = shallow && yieldsTo(q, p, strokes);
      // The arm that yields at a shallow angle runs alongside the other road for
      // the whole of its trim, so it has to clear that road *as built*, and a road
      // is a lane wider on the approach to a junction when it grows a turn bay.
      // Bays are planned after trims, from the segments the trims define, so they
      // cannot be read here; a lane's worth of allowance is what one adds at most.
      // Without it a slip road's asphalt reached a metre and a half into the
      // arterial's, and its edge line ran across the arterial's bay.
      const otherHalf = shallow && !otherYields ? other.halfWidth + other.profile.laneWidth : other.halfWidth;
      trim = Math.max(trim, otherYields
        ? trimDistance(self.halfWidth, other.halfWidth, Math.PI / 2)
        : trimDistance(self.halfWidth, otherHalf, angle));
    }
    p.trim = trim;
    radius = Math.max(radius, trim);
  }
  return radius;
}

/** Below this crossing angle a pair of arms is alongside, not across, each other. */
const SHALLOW_PAIR = (45 * Math.PI) / 180;

/**
 * Of a shallow pair, does `p` take the long trim rather than `q`? The arm that
 * ends at the meeting yields to one that passes through; between two of a kind,
 * the narrower yields, and equals break on stroke order so the answer is stable.
 */
function yieldsTo(p: MeetingParticipant, q: MeetingParticipant, strokes: PreparedStroke[]): boolean {
  const pEnds = p.end !== 0;
  const qEnds = q.end !== 0;
  if (pEnds !== qEnds) return pEnds;
  const wp = strokes[p.strokeIdx].halfWidth;
  const wq = strokes[q.strokeIdx].halfWidth;
  if (wp !== wq) return wp < wq;
  return p.strokeIdx > q.strokeIdx;
}

/**
 * Classifies clusters into junctions.
 *
 * A two-way stroke ending on a road both feeds it and is fed by it, so that case
 * emits a merge *and* a diverge at the same point — each gets its own auxiliary
 * lane (accel downstream, decel upstream) and they never interfere.
 */
export function findMeetings(
  strokes: PreparedStroke[],
): { meetings: Meeting[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const raw = findRawCrossings(strokes);

  // Endpoint landings only matter where no crossing already covers them.
  for (const land of findEndpointLandings(strokes)) {
    const dup = raw.some(
      (h) =>
        ((h.ai === land.ai && h.bi === land.bi) || (h.ai === land.bi && h.bi === land.ai)) &&
        Math.hypot(h.x - land.x, h.y - land.y) < strokes[land.ai].halfWidth * 3 + 4,
    );
    if (!dup) raw.push(land);
  }

  const meetings: Meeting[] = [];
  for (const cluster of clusterHits(raw, strokes)) {
    const participants = buildParticipants(cluster, strokes);
    if (participants.length < 2) continue;
    const grade = strokes[participants[0].strokeIdx].levelAt(participants[0].s);

    if (participants.length > 2) {
      const radius = assignTrims(participants, strokes);
      meetings.push({
        kind: 'crossing', x: cluster.x, y: cluster.y, grade, radius,
        participants, rampIdx: -1, roadIdx: -1,
      });
      continue;
    }

    const [a, b] = participants;
    const angle = pairAngle(a, b);
    const aEnd = a.end !== 0;
    const bEnd = b.end !== 0;
    const rampProfile = strokes[a.strokeIdx].profile.isRamp || strokes[b.strokeIdx].profile.isRamp;
    const shallowLimit = rampProfile ? (45 * Math.PI) / 180 : SHALLOW_ANGLE;

    if (aEnd && bEnd) {
      if (angle <= LINK_ANGLE) {
        meetings.push({
          kind: 'link', x: cluster.x, y: cluster.y, grade, radius: 0,
          participants, rampIdx: -1, roadIdx: -1,
        });
      } else {
        const radius = assignTrims(participants, strokes);
        meetings.push({
          kind: 'crossing', x: cluster.x, y: cluster.y, grade, radius,
          participants, rampIdx: -1, roadIdx: -1,
        });
      }
      continue;
    }

    if ((aEnd || bEnd) && angle <= shallowLimit) {
      const rampIdx = aEnd ? 0 : 1;
      const roadIdx = 1 - rampIdx;
      const ramp = participants[rampIdx];
      const rampStroke = strokes[ramp.strokeIdx];
      // `end === +1` means the ramp's forward traffic arrives here.
      const feedsIn = ramp.end === 1 ? rampStroke.profile.lanesForward > 0
                                     : rampStroke.profile.lanesBackward > 0;
      const feedsOut = ramp.end === 1 ? rampStroke.profile.lanesBackward > 0
                                      : rampStroke.profile.lanesForward > 0;
      if (feedsIn) {
        meetings.push({
          kind: 'merge', x: cluster.x, y: cluster.y, grade, radius: 0,
          participants: participants.map((p) => ({ ...p })), rampIdx, roadIdx,
        });
      }
      if (feedsOut) {
        meetings.push({
          kind: 'diverge', x: cluster.x, y: cluster.y, grade, radius: 0,
          participants: participants.map((p) => ({ ...p })), rampIdx, roadIdx,
        });
      }
      if (!feedsIn && !feedsOut) {
        diagnostics.push({
          severity: 'warning', code: 'ramp-no-flow',
          message: 'Ramp meets this road but carries no traffic in either direction.',
          x: cluster.x, y: cluster.y, strokeId: rampStroke.stroke.id,
        });
      }
      continue;
    }

    if (!aEnd && !bEnd && angle < NEAR_PARALLEL_ANGLE) {
      diagnostics.push({
        severity: 'error', code: 'near-parallel-overlap',
        message:
          `Roads overlap at ${(angle * 180 / Math.PI).toFixed(1)} degrees without meeting at an end. ` +
          'Move one road, or end it on the other to make a ramp.',
        x: cluster.x, y: cluster.y, strokeId: strokes[a.strokeIdx].stroke.id,
      });
      continue;
    }

    const radius = assignTrims(participants, strokes);
    meetings.push({
      kind: 'crossing', x: cluster.x, y: cluster.y, grade, radius,
      participants, rampIdx: -1, roadIdx: -1,
    });
  }

  return { meetings, diagnostics };
}
