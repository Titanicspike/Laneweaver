/**
 * Traffic signals.
 *
 * A plan is a list of phases; each phase greens a set of connectors, then runs
 * amber, then all-red before the next. Amber uses the comfortable-stop rule: a
 * driver who would need harder than `SIGNAL.amberDecel` to stop carries on.
 */

import type { Network } from '../network/types';
import { SIGNAL } from './params';

export const SignalState = { Red: 0, Green: 1, Amber: 2 } as const;
export type SignalState = (typeof SignalState)[keyof typeof SignalState];

export class SignalController {
  private readonly phase: Int32Array;
  private readonly timer: Float32Array;
  private readonly stage: Uint8Array; // 0 green, 1 amber, 2 all-red
  private readonly laneState: Uint8Array;
  /** Seconds the current green has been showing, for an actuated plan. */
  private readonly greenFor: Float32Array;

  constructor(private readonly net: Network) {
    this.phase = new Int32Array(net.junctions.length);
    this.timer = new Float32Array(net.junctions.length);
    this.stage = new Uint8Array(net.junctions.length);
    this.laneState = new Uint8Array(net.lanes.length);
    this.greenFor = new Float32Array(net.junctions.length);
    this.reset();
  }

  reset(): void {
    this.phase.fill(0);
    this.stage.fill(0);
    this.greenFor.fill(0);
    this.laneState.fill(SignalState.Green);
    for (const junction of this.net.junctions) {
      const plan = junction.signal;
      if (!plan || junction.control !== 'signal' || plan.phases.length === 0) continue;
      this.timer[junction.id] = plan.phases[0].green;
      // Wind the plan forward to where its offset says it should be. Everything
      // downstream of this — the phase, the stage, the timer — is exactly what the
      // junction would have been showing had it been running since t = -offset,
      // which is what makes a corridor of junctions hold a fixed relationship to
      // each other. Without it a plan's offset is a number nobody reads.
      this.wind(junction.id, ((plan.offset % plan.cycle) + plan.cycle) % plan.cycle);
      this.applyPhase(junction.id);
    }
  }

  /** Advances one junction's plan by `seconds`, without touching anything else. */
  private wind(id: number, seconds: number): void {
    const plan = this.net.junctions[id]?.signal;
    if (!plan || plan.cycle <= 0) return;
    let left = seconds;
    // Bounded: one pass per stage, and the loop consumes at least the shortest
    // stage each time round.
    for (let guard = 0; guard < plan.phases.length * 3 + 4 && left > 0; guard++) {
      const stageLength = this.stageLength(id);
      if (stageLength > left) {
        this.timer[id] -= left;
        return;
      }
      left -= stageLength;
      this.advanceStage(id);
    }
  }

  /** How long the stage this junction is in lasts in total. */
  private stageLength(id: number): number {
    const plan = this.net.junctions[id]!.signal!;
    const phase = plan.phases[this.phase[id]]!;
    return this.stage[id] === 0 ? phase.green : this.stage[id] === 1 ? phase.amber : phase.allRed;
  }

  /** Moves to the next stage (green -> amber -> all-red -> next phase's green). */
  private advanceStage(id: number): void {
    const plan = this.net.junctions[id]!.signal!;
    const phase = plan.phases[this.phase[id]]!;
    if (this.stage[id] === 0) {
      this.stage[id] = 1;
      this.timer[id] = phase.amber;
    } else if (this.stage[id] === 1) {
      this.stage[id] = 2;
      this.timer[id] = phase.allRed;
    } else {
      this.stage[id] = 0;
      this.phase[id] = (this.phase[id] + 1) % plan.phases.length;
      this.timer[id] = plan.phases[this.phase[id]]!.green;
    }
  }

  private applyPhase(junctionId: number): void {
    const junction = this.net.junctions[junctionId];
    const plan = junction.signal;
    if (!plan) return;
    for (const id of junction.connectorIds) this.laneState[id] = SignalState.Red;
    const phase = plan.phases[this.phase[junctionId]];
    if (!phase) return;
    const state = this.stage[junctionId] === 0 ? SignalState.Green
      : this.stage[junctionId] === 1 ? SignalState.Amber
        : SignalState.Red;
    for (const id of phase.greenLanes) this.laneState[id] = state;
  }

  /**
   * Advances every plan by `dt`.
   *
   * `waiting` answers "is anybody still using this green" for an actuated plan, and
   * is only ever called for junctions that asked to be actuated — an isolated
   * junction that should not sit through an empty left-turn phase while the main
   * road queues. It is passed in rather than reached for, because this class knows
   * about the network and deliberately nothing about vehicles.
   */
  update(dt: number, waiting?: (junctionId: number, greenLanes: readonly number[]) => boolean): void {
    for (const junction of this.net.junctions) {
      const plan = junction.signal;
      if (!plan || junction.control !== 'signal' || plan.phases.length === 0) continue;
      const id = junction.id;
      this.timer[id] -= dt;

      // Gap-out. The phase's own `green` is the *maximum* under actuation, which the
      // timer above already enforces; this ends it early once the minimum has been
      // served and the detectors are clear. Skipping straight to amber rather than
      // to the next phase matters — a green that vanishes without an amber is a
      // green that a driver at the line was entitled to rely on.
      if (this.timer[id] > 0) {
        if (!plan.actuated || !waiting || this.stage[id] !== 0) continue;
        this.greenFor[id] += dt;
        if (this.greenFor[id] < SIGNAL.minGreen) continue;
        const phase = plan.phases[this.phase[id]]!;
        if (waiting(id, phase.greenLanes)) continue;
        this.timer[id] = 0;
      }

      const carry = this.timer[id];
      this.advanceStage(id);
      // Carry the overshoot, or a plan drifts by up to one tick every stage.
      this.timer[id] += carry;
      if (this.stage[id] === 0) this.greenFor[id] = 0;
      this.applyPhase(id);
    }
  }

  stateOf(connectorId: number): SignalState {
    return this.laneState[connectorId] as SignalState;
  }

  /** True when a vehicle at `distance` travelling at `v` must stop for this signal. */
  mustStop(connectorId: number, v: number, distance: number): boolean {
    const state = this.laneState[connectorId];
    if (state === SignalState.Green) return false;
    if (state === SignalState.Red) return true;
    // Amber: stop only if it can be done comfortably.
    if (distance <= 0.2) return false;
    return (v * v) / (2 * distance) <= SIGNAL.amberDecel;
  }

  /** Remaining seconds in the current stage, for the UI. */
  remaining(junctionId: number): number {
    return this.timer[junctionId];
  }

  currentPhase(junctionId: number): number {
    return this.phase[junctionId];
  }
}
