/**
 * Vehicle state, structure-of-arrays.
 *
 * Every per-vehicle quantity is a typed array indexed by a dense slot. Slots are
 * recycled through a free list, so a running simulation allocates nothing.
 *
 * Per-lane membership is a doubly linked list kept sorted by descending `s`
 * (`ahead` points at the vehicle in front). Cars cannot pass within a lane, so the
 * order stays sorted for free; only spawns and lane changes splice, and both know
 * their insertion point already.
 *
 * `s` is the **front bumper** position, so the gap to a leader is
 * `s[lead] - s[me] - len[lead]`.
 */

import type { IdmParams } from './idm';

export class VehicleStore {
  readonly capacity: number;
  /** Live vehicles. */
  count = 0;
  /** Monotonic counter for stable, human-readable ids. */
  private nextSerial = 1;
  private readonly free: Int32Array;
  private freeCount: number;

  readonly alive: Uint8Array;
  readonly serial: Int32Array;
  readonly klass: Uint8Array;

  readonly lane: Int32Array;
  readonly s: Float32Array;
  readonly v: Float32Array;
  readonly a: Float32Array;
  /** Previous-tick position, for render interpolation. */
  readonly sPrev: Float32Array;
  readonly lanePrev: Int32Array;
  /**
   * The lane this vehicle drove in from, kept until it leaves the current one. A
   * long vehicle's rear end is still back there, and guessing at it from the lane's
   * own predecessors picks the wrong one wherever several movements converge.
   */
  readonly cameFrom: Int32Array;

  readonly len: Float32Array;
  readonly width: Float32Array;

  // Driver parameters.
  readonly v0Factor: Float32Array;
  readonly headway: Float32Array;
  readonly aMax: Float32Array;
  readonly bComf: Float32Array;
  readonly politeness: Float32Array;
  readonly courtesy: Float32Array;
  readonly critGap: Float32Array;
  readonly seed: Int32Array;

  // Routing.
  readonly dest: Int32Array;
  readonly origin: Int32Array;

  // Lane changing.
  readonly lcCooldown: Float32Array;
  /** Countdown to the next discretionary lane-change evaluation. */
  readonly lcTimer: Float32Array;
  /** Lane we are visually sliding out of, or -1. */
  readonly lcFrom: Int32Array;
  readonly lcFromS: Float32Array;
  readonly lcProgress: Float32Array;

  // Merging.
  readonly urgency: Float32Array;
  readonly gapLead: Int32Array;
  readonly gapLag: Int32Array;
  readonly gapTimer: Float32Array;
  /** 1 when the chosen gap is big enough to take, 0 when we are still hunting. */
  readonly gapOk: Uint8Array;
  /** Vehicle this one has agreed to let in, or -1. */
  readonly cooperateWith: Int32Array;
  /** Lane this vehicle must be out of before its deadline, or -1. */
  readonly mergeLane: Int32Array;
  /** Distance still available before the merge must be complete. */
  readonly mergeRemaining: Float32Array;
  /** The deadline expressed on `mergeLane`, in that lane's own arc-length. */
  readonly mergeDeadline: Float32Array;
  /**
   * Metres *past* the point by which the change had to be made, or 0.
   *
   * `mergeRemaining` is clamped at zero, so it cannot tell a driver who is right on
   * the line — and about to change, this very tick — from one who is fifty metres
   * beyond it. That difference is the whole of "did they miss the exit".
   */
  readonly mergePast: Float32Array;
  /**
   * Seconds this driver has wanted a mandatory lane change and been refused one.
   *
   * Not "how long have I been slow" — a queue shuffling forward at 1 m/s never
   * looks stopped, and a driver cruising toward a merge four hundred metres away is
   * not waiting for anything. This counts only ticks where the change was actually
   * asked for and turned down, which is what impatience is a response to. Reset the
   * moment the change happens or the plan moves to a different lane.
   */
  readonly mergeWait: Float32Array;

  // Bookkeeping.
  /** Time this vehicle came to rest at an all-way stop line, or -1. */
  readonly stopArrival: Float32Array;
  readonly stoppedTime: Float32Array;
  /**
   * What is holding this vehicle back right now — whichever constraint produced
   * the acceleration it is actually using.
   *
   * One byte per vehicle, written only when a constraint *lowers* the target, so
   * it costs a handful of array stores a tick. Worth it: "why is this car
   * stopped" is otherwise unanswerable from outside the accel pass, and anything
   * measuring whether drivers are being held up has to guess from speeds and gaps
   * instead — which reads a queue shuffling forward at 2 m/s as a clear road,
   * because the gaps in one really are twenty metres.
   */
  readonly hold: Uint8Array;
  /**
   * Time spent crawling with a clear road ahead — held back by something other
   * than the traffic in front.
   *
   * `stoppedTime` cannot see this, because every anti-deadlock floor in the merge
   * model keeps a vehicle moving: gap alignment never asks for less than 0.8 m/s
   * and creeping is capped at 2. A driver caught in one of those is doing 0.8
   * forever, so a clock that only counts standstills never starts, and every
   * escape hatch keyed on it is unreachable by construction. Clearing the clock
   * whenever the road ahead is genuinely full is what keeps ordinary stop-and-go
   * traffic from looking like a deadlock.
   */
  readonly crawlTime: Float32Array;
  readonly waitTime: Float32Array;
  readonly age: Float32Array;
  readonly distance: Float32Array;

  // Lane list links.
  readonly ahead: Int32Array;
  readonly behind: Int32Array;

  // Lateral neighbours, refreshed each tick.
  readonly leftLead: Int32Array;
  readonly leftLag: Int32Array;
  readonly rightLead: Int32Array;
  readonly rightLag: Int32Array;

  // Per-lane lists.
  readonly laneFirst: Int32Array;
  readonly laneLast: Int32Array;
  readonly laneCount: Int32Array;

  constructor(capacity: number, laneCount: number) {
    this.capacity = capacity;
    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.freeCount = capacity;

    const f = (): Float32Array => new Float32Array(capacity);
    const i32 = (fill = 0): Int32Array => {
      const arr = new Int32Array(capacity);
      if (fill !== 0) arr.fill(fill);
      return arr;
    };

    this.alive = new Uint8Array(capacity);
    this.serial = i32();
    this.klass = new Uint8Array(capacity);
    this.lane = i32(-1);
    this.s = f();
    this.v = f();
    this.a = f();
    this.sPrev = f();
    this.lanePrev = i32(-1);
    this.cameFrom = i32(-1);
    this.len = f();
    this.width = f();
    this.v0Factor = f();
    this.headway = f();
    this.aMax = f();
    this.bComf = f();
    this.politeness = f();
    this.courtesy = f();
    this.critGap = f();
    this.seed = i32();
    this.dest = i32(-1);
    this.origin = i32(-1);
    this.lcCooldown = f();
    this.lcTimer = f();
    this.lcFrom = i32(-1);
    this.lcFromS = f();
    this.lcProgress = f();
    this.urgency = f();
    this.gapLead = i32(-1);
    this.gapLag = i32(-1);
    this.gapTimer = f();
    this.gapOk = new Uint8Array(capacity);
    this.cooperateWith = i32(-1);
    this.mergeLane = i32(-1);
    this.mergeRemaining = f();
    this.mergeDeadline = f();
    this.mergePast = f();
    this.mergeWait = f();
    this.stopArrival = f();
    this.stoppedTime = f();
    this.hold = new Uint8Array(capacity);
    this.crawlTime = f();
    this.waitTime = f();
    this.age = f();
    this.distance = f();
    this.ahead = i32(-1);
    this.behind = i32(-1);
    this.leftLead = i32(-1);
    this.leftLag = i32(-1);
    this.rightLead = i32(-1);
    this.rightLag = i32(-1);

    this.laneFirst = new Int32Array(laneCount).fill(-1);
    this.laneLast = new Int32Array(laneCount).fill(-1);
    this.laneCount = new Int32Array(laneCount);
  }

  /** Takes a free slot, or -1 when the store is full. */
  allocate(): number {
    if (this.freeCount === 0) return -1;
    const i = this.free[--this.freeCount];
    this.alive[i] = 1;
    this.serial[i] = this.nextSerial++;
    this.count++;
    this.ahead[i] = -1;
    this.behind[i] = -1;
    this.lane[i] = -1;
    this.cameFrom[i] = -1;
    this.lcFrom[i] = -1;
    this.lcProgress[i] = 0;
    this.lcCooldown[i] = 0;
    this.lcTimer[i] = 0;
    this.gapLead[i] = -1;
    this.gapLag[i] = -1;
    this.gapTimer[i] = 0;
    this.gapOk[i] = 0;
    this.cooperateWith[i] = -1;
    this.mergeLane[i] = -1;
    this.mergeRemaining[i] = Infinity;
    this.mergeDeadline[i] = 0;
    this.mergePast[i] = 0;
    this.mergeWait[i] = 0;
    this.urgency[i] = 0;
    this.stopArrival[i] = -1;
    this.stoppedTime[i] = 0;
    this.hold[i] = 0;
    this.crawlTime[i] = 0;
    this.waitTime[i] = 0;
    this.age[i] = 0;
    this.distance[i] = 0;
    this.a[i] = 0;
    return i;
  }

  release(i: number): void {
    if (!this.alive[i]) return;
    if (this.lane[i] >= 0) this.removeFromLane(i);
    this.alive[i] = 0;
    this.count--;
    this.free[this.freeCount++] = i;
  }

  /**
   * Vehicle that would be directly ahead of position `s` on `laneId`, or -1.
   * `hint` is any vehicle already known to be on that lane; with one the search
   * is O(1), without one it walks from the front of the lane.
   */
  findAhead(laneId: number, s: number, hint = -1): number {
    let cur = hint >= 0 && this.alive[hint] && this.lane[hint] === laneId ? hint : this.laneFirst[laneId];
    while (cur >= 0 && this.s[cur] < s) cur = this.ahead[cur];
    while (cur >= 0) {
      const b = this.behind[cur];
      if (b >= 0 && this.s[b] >= s) cur = b;
      else break;
    }
    return cur;
  }

  /** Splices `i` into `laneId` directly behind `aheadId` (-1 = become the leader). */
  insertAfter(i: number, laneId: number, aheadId: number): void {
    const b = aheadId >= 0 ? this.behind[aheadId] : this.laneFirst[laneId];
    this.ahead[i] = aheadId;
    this.behind[i] = b;
    if (aheadId >= 0) this.behind[aheadId] = i;
    else this.laneFirst[laneId] = i;
    if (b >= 0) this.ahead[b] = i;
    else this.laneLast[laneId] = i;
    this.lane[i] = laneId;
    this.laneCount[laneId]++;
  }

  insertIntoLane(i: number, laneId: number, s: number, hint = -1): void {
    this.s[i] = s;
    this.insertAfter(i, laneId, this.findAhead(laneId, s, hint));
  }

  removeFromLane(i: number): void {
    const l = this.lane[i];
    if (l < 0) return;
    const a = this.ahead[i];
    const b = this.behind[i];
    if (a >= 0) this.behind[a] = b;
    else this.laneFirst[l] = b;
    if (b >= 0) this.ahead[b] = a;
    else this.laneLast[l] = a;
    this.ahead[i] = -1;
    this.behind[i] = -1;
    this.laneCount[l]--;
    this.lane[i] = -1;
  }

  /** Reads driver-specific IDM parameters into `out`. */
  params(i: number, base: IdmParams, out: IdmParams): IdmParams {
    out.s0 = base.s0;
    out.T = this.headway[i];
    out.aMax = this.aMax[i];
    out.b = this.bComf[i];
    return out;
  }

  clearLanes(): void {
    this.laneFirst.fill(-1);
    this.laneLast.fill(-1);
    this.laneCount.fill(0);
  }

  reset(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.alive[i] = 0;
      this.free[i] = this.capacity - 1 - i;
    }
    this.freeCount = this.capacity;
    this.count = 0;
    this.nextSerial = 1;
    this.lane.fill(-1);
    this.ahead.fill(-1);
    this.behind.fill(-1);
    this.clearLanes();
  }
}
