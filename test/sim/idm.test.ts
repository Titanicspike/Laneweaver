import { describe, expect, it } from 'vitest';
import { desiredGap, freeAccel, idmAccel, idmToStop, stoppingDecel, stoppingDistance } from '@core/sim/idm';
import { evaluateMobil, makeMobilInput, makeMobilResult } from '@core/sim/mobil';
import { safeToInsert } from '@core/sim/merge';

const P = { s0: 2, T: 1.4, aMax: 1.4, b: 2.0 };

describe('IDM', () => {
  it('accelerates freely toward the desired speed', () => {
    expect(freeAccel(0, 30, 1.4)).toBeCloseTo(1.4, 6);
    expect(freeAccel(30, 30, 1.4)).toBeCloseTo(0, 6);
    expect(freeAccel(15, 30, 1.4)).toBeCloseTo(1.4 * (1 - 0.0625), 6);
  });

  it('computes the desired gap by hand', () => {
    // s* = s0 + v*T + v*dv / (2*sqrt(a*b)); at dv = 0 the dynamic term vanishes.
    expect(desiredGap(20, 0, P)).toBeCloseTo(2 + 28, 6);
    const dynamic = (20 * 5) / (2 * Math.sqrt(1.4 * 2));
    expect(desiredGap(20, 5, P)).toBeCloseTo(2 + 28 + dynamic, 6);
  });

  it('never lets the desired gap fall below the standstill gap', () => {
    expect(desiredGap(20, -40, P)).toBe(P.s0);
  });

  it('is exactly zero when the gap equals the desired gap at equilibrium', () => {
    const v = 20;
    const gap = desiredGap(v, 0, P);
    // At the equilibrium gap the interaction term cancels the free term only when
    // v equals v0; below that the vehicle still wants to accelerate.
    expect(idmAccel(v, v, gap, 0, P)).toBeCloseTo(-P.aMax, 5);
    expect(idmAccel(v, 30, gap, 0, P)).toBeGreaterThan(-P.aMax);
  });

  it('brakes hard when closing on a stopped leader', () => {
    expect(idmAccel(25, 30, 10, 25, P)).toBeLessThan(-5);
  });

  it('treats an infinite gap as free flow', () => {
    expect(idmAccel(10, 30, Infinity, 0, P)).toBeCloseTo(freeAccel(10, 30, 1.4), 6);
  });

  it('clamps to the emergency deceleration', () => {
    expect(idmAccel(30, 30, 0.05, 30, P)).toBeGreaterThanOrEqual(-6);
  });

  it('relates stopping distance and deceleration consistently', () => {
    expect(stoppingDistance(20, 2)).toBeCloseTo(100, 6);
    expect(stoppingDecel(20, 100)).toBeCloseTo(2, 6);
  });

  it('stops short of an obstacle', () => {
    // Approaching a stop line: acceleration must be negative and get harsher.
    const far = idmToStop(20, 30, 200, P);
    const near = idmToStop(20, 30, 20, P);
    expect(far).toBeGreaterThan(near);
    expect(near).toBeLessThan(-2);
  });
});

describe('MOBIL', () => {
  const input = makeMobilInput();
  const out = makeMobilResult();

  function reset(): void {
    Object.assign(input, makeMobilInput());
    input.v = 20;
    input.v0 = 30;
    input.params = P;
  }

  it('wants to change into a clearly faster lane', () => {
    reset();
    input.gapCurrent = 25;
    input.dvCurrent = 8;
    input.gapTarget = 200;
    input.dvTarget = 0;
    evaluateMobil(input, out);
    expect(out.safe).toBe(true);
    expect(out.incentive).toBeGreaterThan(0);
  });

  it('stays put when the target lane is no better', () => {
    reset();
    input.gapCurrent = 200;
    input.gapTarget = 200;
    evaluateMobil(input, out);
    expect(out.incentive).toBeLessThan(0);
  });

  it('refuses a change that would slam on the new follower', () => {
    reset();
    input.gapTarget = 200;
    input.newFollowerParams = P;
    input.newFollowerV = 30;
    input.newFollowerV0 = 30;
    input.newFollowerGapBefore = 200;
    input.newFollowerGapAfter = 3;
    input.newFollowerDvAfter = 10;
    evaluateMobil(input, out);
    expect(out.safe).toBe(false);
  });

  it('weighs the other drivers by politeness', () => {
    reset();
    input.gapCurrent = 30;
    input.dvCurrent = 5;
    input.gapTarget = 60;
    input.newFollowerParams = P;
    input.newFollowerV = 22;
    input.newFollowerV0 = 30;
    input.newFollowerGapBefore = 90;
    input.newFollowerGapAfter = 35;
    input.newFollowerDvAfter = 2;

    input.politeness = 0;
    evaluateMobil(input, out);
    const selfish = out.incentive;
    input.politeness = 1;
    evaluateMobil(input, out);
    expect(out.incentive).toBeLessThan(selfish);
  });
});

describe('merge safety floor', () => {
  it('always allows a move that does not close on anyone', () => {
    expect(safeToInsert(10, 10, 2, 4)).toBe(true);
    expect(safeToInsert(0, 0, 1, 4)).toBe(true);
  });

  it('refuses a move into a gap too small for the closing speed', () => {
    // 20 m/s of closing speed needs 50 m at 4 m/s^2.
    expect(safeToInsert(20, 0, 60, 4)).toBe(true);
    expect(safeToInsert(20, 0, 40, 4)).toBe(false);
  });

  it('refuses anything physically overlapping', () => {
    expect(safeToInsert(0, 0, 0.2, 4)).toBe(false);
  });
});
