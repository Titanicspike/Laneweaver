/**
 * Intelligent Driver Model.
 *
 *   a = aMax * [ 1 - (v/v0)^delta - (sStar/gap)^2 ]
 *   sStar = s0 + max(0, v*T + v*dv / (2*sqrt(aMax*b)))
 *
 * `gap` is bumper to bumper, `dv` is the approach rate (positive when closing).
 * Pure functions, no allocation — this runs for every vehicle every tick.
 */

import { IDM } from './params';

export interface IdmParams {
  s0: number;
  T: number;
  aMax: number;
  b: number;
}

export function desiredGap(v: number, dv: number, p: IdmParams): number {
  const dynamic = (v * dv) / (2 * Math.sqrt(p.aMax * p.b));
  const s = p.s0 + v * p.T + dynamic;
  return s > p.s0 ? s : p.s0;
}

/** Acceleration with no vehicle ahead. */
export function freeAccel(v: number, v0: number, aMax: number): number {
  const ratio = v0 > 0.01 ? v / v0 : 2;
  return aMax * (1 - ratio * ratio * ratio * ratio);
}

/**
 * Full IDM acceleration. `gap` may be Infinity for free flow and is clamped to a
 * small positive value so an overlap produces hard braking rather than NaN.
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number, p: IdmParams): number {
  const free = freeAccel(v, v0, p.aMax);
  if (!Number.isFinite(gap)) return clampAccel(free, p);
  const s = gap > 0.1 ? gap : 0.1;
  const star = desiredGap(v, dv, p);
  const ratio = star / s;
  return clampAccel(free - p.aMax * ratio * ratio, p);
}

export function clampAccel(a: number, p: IdmParams): number {
  if (a > p.aMax) return p.aMax;
  if (a < -IDM.bMax) return -IDM.bMax;
  return a;
}

/** Deceleration needed to stop in `distance` from speed `v`. */
export function stoppingDecel(v: number, distance: number): number {
  if (distance <= 0.05) return IDM.bMax;
  return (v * v) / (2 * distance);
}

/** Distance needed to stop from `v` at deceleration `b`. */
export function stoppingDistance(v: number, b: number): number {
  return (v * v) / (2 * Math.max(b, 0.1));
}

/** IDM against a stationary obstacle `distance` ahead (a stop line or lane end). */
export function idmToStop(v: number, v0: number, distance: number, p: IdmParams): number {
  return idmAccel(v, v0, distance, v, p);
}
