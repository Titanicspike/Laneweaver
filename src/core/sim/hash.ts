/**
 * Determinism hash.
 *
 * Folds the whole vehicle population into one 32-bit value. Positions are
 * quantised to a millimetre and speeds to a millimetre per second so the hash is
 * stable across platforms with different float rounding in the last bit, while
 * still catching any real divergence.
 */

import type { Simulation } from './sim';

function mix(h: number, x: number): number {
  let v = (h ^ Math.imul(x | 0, 0x9e3779b1)) >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x21f0aaad);
  v = Math.imul(v ^ (v >>> 15), 0x735a2d97);
  return (v ^ (v >>> 15)) >>> 0;
}

export function hashSimState(sim: Simulation): number {
  const store = sim.store;
  let h = 0x811c9dc5;
  h = mix(h, sim.ticks);
  h = mix(h, store.count);
  sim.forEachVehicle((i, laneId) => {
    h = mix(h, laneId);
    h = mix(h, Math.round(store.s[i] * 1000));
    h = mix(h, Math.round(store.v[i] * 1000));
    h = mix(h, store.klass[i]);
    h = mix(h, store.dest[i]);
  });
  return h >>> 0;
}

/** Hex form, for golden-value assertions. */
export function hashHex(sim: Simulation): string {
  return hashSimState(sim).toString(16).padStart(8, '0');
}
