/**
 * End-to-end stroke joints ("link" junctions).
 *
 * Two roads that meet end to end at a shallow angle continue into each other with
 * no junction footprint and no connectors — lane successors link directly. When
 * their cross-sections differ, the upstream road morphs into the downstream one
 * over a taper: lanes that have no counterpart end (or begin) there, and every
 * other lane slides to its new offset. That is how a 3-to-2 lane drop compiles,
 * and it reuses exactly the same merge machinery as an on-ramp.
 */

import { layoutProfile, halfCarriageway } from './layout';
import { rampSpecOf } from '../model';
import type { Diagnostic } from '../types';
import type { Meeting } from './crossings';
import type { PreparedStroke } from './prepare';

/** Target cross-section a segment morphs into at one of its ends. */
export interface EndTransition {
  taper: number;
  /** Target outer extent (carriageway half-width + shoulder) either side. */
  halfPos: number;
  halfNeg: number;
  /** Target shoulder width, so the edge line can stay off the shoulder. */
  shoulder: number;
  /** `${side}:${index}` -> lane centre offset at the link. */
  targets: Map<string, number>;
  /** Lane keys with no counterpart across the link: they taper away (or in). */
  vanishing: Set<string>;
}

export interface TransitionPlan {
  strokeIdx: number;
  /** +1 at the stroke's end, -1 at its start. */
  atEnd: 1 | -1;
  transition: EndTransition;
}

export interface LinkPlan {
  meetingIndex: number;
  a: { strokeIdx: number; atEnd: 1 | -1 };
  b: { strokeIdx: number; atEnd: 1 | -1 };
  /** +1 when the two strokes' frames agree, -1 when one is drawn backwards. */
  frameFlip: 1 | -1;
  x: number;
  y: number;
}

function key(side: 1 | -1, index: number): string {
  return `${side}:${index}`;
}

/**
 * Builds the transition each side of a link needs.
 *
 * `self` morphs into `other`. Lanes align from the median outward, so a road that
 * loses a lane loses its kerb-side one — which is what real lane drops do.
 */
function transitionFor(
  self: PreparedStroke, other: PreparedStroke, frameFlip: 1 | -1, driveOnRight: boolean,
): EndTransition {
  const selfSlots = layoutProfile(self.profile, driveOnRight);
  const otherSlots = layoutProfile(other.profile, driveOnRight);
  const targets = new Map<string, number>();
  const vanishing = new Set<string>();

  for (const side of [1, -1] as const) {
    const otherSide = (side * frameFlip) as 1 | -1;
    const mine = selfSlots.filter((s) => s.side === side).sort((a, b) => a.index - b.index);
    const theirs = otherSlots.filter((s) => s.side === otherSide).sort((a, b) => a.index - b.index);
    const shift = mine.length - theirs.length;
    for (const slot of mine) {
      const j = slot.index - shift;
      if (j >= 0 && j < theirs.length) {
        targets.set(key(side, slot.index), frameFlip * theirs[j].offset);
      } else {
        vanishing.add(key(side, slot.index));
      }
    }
    // A vanishing lane converges onto the lane inside it, so the taper closes
    // exactly where the merge has to be complete.
    for (let i = mine.length - 1; i >= 0; i--) {
      const k = key(side, mine[i].index);
      if (!vanishing.has(k)) continue;
      const inner = mine[i + 1];
      const innerKey = inner ? key(side, inner.index) : undefined;
      const fallback = innerKey !== undefined ? targets.get(innerKey) : undefined;
      targets.set(k, fallback ?? (theirs.length ? frameFlip * theirs[theirs.length - 1].offset : 0));
    }
  }

  const otherHalf = halfCarriageway(other.profile) + other.profile.shoulder;
  const spec = rampSpecOf(self.profile);
  return {
    taper: spec.taperLength,
    halfPos: otherHalf,
    halfNeg: otherHalf,
    shoulder: other.profile.shoulder,
    targets,
    vanishing,
  };
}

export function planLinks(
  strokes: PreparedStroke[], meetings: Meeting[], driveOnRight: boolean,
): { links: LinkPlan[]; transitions: TransitionPlan[]; diagnostics: Diagnostic[] } {
  const links: LinkPlan[] = [];
  const transitions: TransitionPlan[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let mi = 0; mi < meetings.length; mi++) {
    const meeting = meetings[mi];
    if (meeting.kind !== 'link') continue;
    const [pa, pb] = meeting.participants;
    const a = strokes[pa.strokeIdx];
    const b = strokes[pb.strokeIdx];
    const frameFlip: 1 | -1 = pa.tx * pb.tx + pa.ty * pb.ty >= 0 ? 1 : -1;

    const link: LinkPlan = {
      meetingIndex: mi,
      a: { strokeIdx: pa.strokeIdx, atEnd: pa.end === 1 ? 1 : -1 },
      b: { strokeIdx: pb.strokeIdx, atEnd: pb.end === 1 ? 1 : -1 },
      frameFlip,
      x: meeting.x,
      y: meeting.y,
    };
    links.push(link);

    const sameSection =
      a.profile.lanesForward === b.profile.lanesForward &&
      a.profile.lanesBackward === b.profile.lanesBackward &&
      Math.abs(a.profile.laneWidth - b.profile.laneWidth) < 1e-6 &&
      Math.abs(halfCarriageway(a.profile) - halfCarriageway(b.profile)) < 1e-6 &&
      Math.abs(a.profile.shoulder - b.profile.shoulder) < 1e-6 &&
      frameFlip === 1;
    if (sameSection) continue;

    // The wider road does the tapering, so a dropped lane visibly narrows on the
    // side that actually has it. Ties break on stroke index to stay deterministic.
    const aWider =
      a.profile.lanesForward + a.profile.lanesBackward !==
      b.profile.lanesForward + b.profile.lanesBackward
        ? a.profile.lanesForward + a.profile.lanesBackward >
          b.profile.lanesForward + b.profile.lanesBackward
        : halfCarriageway(a.profile) !== halfCarriageway(b.profile)
          ? halfCarriageway(a.profile) > halfCarriageway(b.profile)
          : pa.strokeIdx < pb.strokeIdx;

    const self = aWider ? a : b;
    const other = aWider ? b : a;
    const selfPart = aWider ? pa : pb;
    const transition = transitionFor(self, other, frameFlip, driveOnRight);
    transitions.push({
      strokeIdx: selfPart.strokeIdx,
      atEnd: selfPart.end === 1 ? 1 : -1,
      transition,
    });

    const drops = transition.vanishing.size;
    if (drops > 0) {
      diagnostics.push({
        severity: 'info', code: 'lane-drop',
        message: drops > 1
          ? `${drops} lanes taper away where these roads join.`
          : 'A lane tapers away where these roads join.',
        x: meeting.x, y: meeting.y, strokeId: self.stroke.id,
      });
    }
  }

  return { links, transitions, diagnostics };
}

export { key as transitionKey };
