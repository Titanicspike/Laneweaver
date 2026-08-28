/**
 * MOBIL lane-change decisions.
 *
 *   change if  da_self + p * (da_newFollower + da_oldFollower) > threshold
 *   subject to a_newFollower >= -bSafe
 *
 * The safety term is a hard floor and is never relaxed, not even at maximum merge
 * urgency. The incentive term is where merge cooperation, keep-right and
 * keep-clear biases get folded in.
 */

import { idmAccel, type IdmParams } from './idm';
import { MOBIL } from './params';

export interface MobilInput {
  /** Own speed and desired speed. */
  v: number;
  v0: number;
  params: IdmParams;
  /** Gap and approach rate to the current leader (Infinity gap when none). */
  gapCurrent: number;
  dvCurrent: number;
  /** Same, for the leader in the target lane. */
  gapTarget: number;
  dvTarget: number;
  /** Follower behind me now: its speed, gap to me, and its params. */
  oldFollowerV: number;
  oldFollowerGap: number;
  oldFollowerV0: number;
  oldFollowerParams: IdmParams | null;
  /** The gap the old follower would inherit once I leave. */
  oldFollowerGapAfter: number;
  oldFollowerDvAfter: number;
  /** Follower in the target lane. */
  newFollowerV: number;
  newFollowerV0: number;
  newFollowerParams: IdmParams | null;
  /** Gap that follower has now, and the gap it would have with me inserted. */
  newFollowerGapBefore: number;
  newFollowerDvBefore: number;
  newFollowerGapAfter: number;
  newFollowerDvAfter: number;
  /** Politeness, 0 = selfish. */
  politeness: number;
  /** Extra incentive in m/s^2 (keep-right, keep-clear, route pressure). */
  bias: number;
  /** Advantage needed before changing. */
  threshold: number;
  /** Hardest deceleration a change may impose on the new follower. */
  bSafe: number;
}

export interface MobilResult {
  safe: boolean;
  /** Total incentive; positive means the change is worth making. */
  incentive: number;
  /** Deceleration the new follower would suffer, m/s^2 (negative = braking). */
  newFollowerAccel: number;
}

export function evaluateMobil(input: MobilInput, out: MobilResult): MobilResult {
  const {
    v, v0, params, gapCurrent, dvCurrent, gapTarget, dvTarget,
    politeness, bias, threshold, bSafe,
  } = input;

  const aSelfBefore = idmAccel(v, v0, gapCurrent, dvCurrent, params);
  const aSelfAfter = idmAccel(v, v0, gapTarget, dvTarget, params);

  let aNewBefore = 0;
  let aNewAfter = 0;
  if (input.newFollowerParams) {
    aNewBefore = idmAccel(
      input.newFollowerV, input.newFollowerV0,
      input.newFollowerGapBefore, input.newFollowerDvBefore, input.newFollowerParams,
    );
    aNewAfter = idmAccel(
      input.newFollowerV, input.newFollowerV0,
      input.newFollowerGapAfter, input.newFollowerDvAfter, input.newFollowerParams,
    );
  }

  let aOldBefore = 0;
  let aOldAfter = 0;
  if (input.oldFollowerParams) {
    aOldBefore = idmAccel(
      input.oldFollowerV, input.oldFollowerV0,
      input.oldFollowerGap, input.oldFollowerV - v, input.oldFollowerParams,
    );
    aOldAfter = idmAccel(
      input.oldFollowerV, input.oldFollowerV0,
      input.oldFollowerGapAfter, input.oldFollowerDvAfter, input.oldFollowerParams,
    );
  }

  out.newFollowerAccel = aNewAfter;
  out.safe = aNewAfter >= -bSafe;
  out.incentive =
    aSelfAfter - aSelfBefore +
    politeness * ((aNewAfter - aNewBefore) + (aOldAfter - aOldBefore)) +
    bias - threshold;
  return out;
}

export function makeMobilResult(): MobilResult {
  return { safe: false, incentive: 0, newFollowerAccel: 0 };
}

/** Fresh input object with neutral defaults, reused across ticks. */
export function makeMobilInput(): MobilInput {
  return {
    v: 0, v0: 0, params: { s0: 2, T: 1.4, aMax: 1.4, b: 2 },
    gapCurrent: Infinity, dvCurrent: 0,
    gapTarget: Infinity, dvTarget: 0,
    oldFollowerV: 0, oldFollowerGap: Infinity, oldFollowerV0: 0, oldFollowerParams: null,
    oldFollowerGapAfter: Infinity, oldFollowerDvAfter: 0,
    newFollowerV: 0, newFollowerV0: 0, newFollowerParams: null,
    newFollowerGapBefore: Infinity, newFollowerDvBefore: 0,
    newFollowerGapAfter: Infinity, newFollowerDvAfter: 0,
    politeness: MOBIL.politeness, bias: 0,
    threshold: MOBIL.threshold, bSafe: MOBIL.bSafe,
  };
}
