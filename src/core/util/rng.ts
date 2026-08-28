/**
 * Deterministic randomness.
 *
 * `Math.random` is banned in `src/core`. Every stochastic decision draws from a
 * seeded stream that is threaded explicitly through the call graph, so the same
 * seed plus the same inputs always produces an identical run.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Current internal state — enough to clone or hash the stream. */
  state(): number;
}

/** Mulberry32: tiny, fast, good enough statistically for driver variation. */
export class Mulberry32 implements Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  state(): number {
    return this.s;
  }

  clone(): Mulberry32 {
    return new Mulberry32(this.s);
  }
}

/**
 * Stateless integer hash (splitmix32 finalizer). Used to derive per-entity seeds
 * from (runSeed, entityId) without consuming the shared stream — which keeps
 * per-driver parameters stable no matter what order entities are created in.
 */
export function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

export function mixSeed(a: number, b: number): number {
  return hash32((hash32(a) ^ Math.imul(b | 0, 0x9e3779b1)) >>> 0);
}

/** Symmetric multiplicative jitter: 1 ± amount, uniform. */
export function jitter(rng: Rng, amount: number): number {
  return 1 + (rng.next() * 2 - 1) * amount;
}

/** Uniform in [lo, hi). */
export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng.next() * (hi - lo);
}

/** Interval until the next event of a Poisson process of the given rate (per second). */
export function expInterval(rng: Rng, ratePerSecond: number): number {
  if (ratePerSecond <= 0) return Infinity;
  return expUnit(rng) / ratePerSecond;
}

/**
 * One draw from Exp(1) — the *quota* of a Poisson process rather than a duration.
 *
 * Dividing this by a rate gives an interval, which is right only while the rate
 * holds still. When the rate varies — as it does under a clock — the correct
 * method is to spend the quota at whatever rate currently applies: subtract
 * `rate * dt` each step and fire when it runs out. That is exact for a
 * non-homogeneous Poisson process, needs no rejection loop, and responds to a
 * change in rate on the tick it happens rather than after the interval already in
 * flight has elapsed.
 */
export function expUnit(rng: Rng): number {
  // Guard against log(0).
  return -Math.log(1 - rng.next());
}
