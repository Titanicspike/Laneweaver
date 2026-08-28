/**
 * Time of day, and the traffic that comes with it.
 *
 * A simulator that generates the same flow at 03:00 as at 08:30 is measuring a
 * hypothetical hour that never happens. Real networks are built for the peak and
 * spend most of the day nowhere near it, and the interesting question — does this
 * junction cope — is a question about the shape of the day rather than about a
 * single number.
 *
 * Two curves, and they do different jobs:
 *
 * - `flowAt` is *how much* traffic there is, and it is the classic camel back: a
 *   sharp morning peak, a broader and slightly later evening one, a midday plateau
 *   around half of peak, and a trough overnight that is low but never zero.
 * - `homeToWorkAt` is *which way it goes*, and it only means anything in the
 *   land-use mode. In the morning almost every trip runs from a house to a shop or
 *   an office; in the evening almost every one runs back. Without it the morning
 *   peak and the evening peak are the same picture twice, which is exactly the thing
 *   a rush hour is not.
 *
 * Both are sampled hourly and interpolated, because a step change on the hour puts a
 * visible seam in the traffic every sixty minutes.
 */

/** Relative flow for each hour of the day, 0..23. 1 is the morning peak. */
const FLOW = [
  0.06, 0.04, 0.03, 0.04, 0.09, 0.24, 0.58, 0.92,
  1.00, 0.78, 0.60, 0.58, 0.62, 0.60, 0.62, 0.72,
  0.90, 1.00, 0.94, 0.72, 0.52, 0.38, 0.24, 0.12,
];

/** Share of land-use trips running house -> shop, for each hour. */
const OUTBOUND = [
  0.50, 0.50, 0.50, 0.55, 0.70, 0.86, 0.92, 0.94,
  0.92, 0.84, 0.70, 0.58, 0.50, 0.46, 0.42, 0.34,
  0.22, 0.12, 0.10, 0.14, 0.22, 0.32, 0.42, 0.48,
];

/**
 * Never quite zero.
 *
 * Not for realism — though there *is* traffic at four in the morning — but because
 * the spawner draws its next arrival from an exponential with the rate as its
 * parameter, and a rate of zero gives an interval of infinity. A pair that goes to
 * sleep at 03:00 with an infinite timer never wakes up again, and the morning peak
 * arrives with nobody in it.
 */
const FLOOR = 0.03;

function sampleHourly(table: number[], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const t = h - i;
  const a = table[i]!;
  const b = table[(i + 1) % 24]!;
  return a + (b - a) * t;
}

/** How busy the network is at this hour, as a fraction of the morning peak. */
export function flowAt(hour: number): number {
  return Math.max(FLOOR, sampleHourly(FLOW, hour));
}

/** What share of land-use trips run from a house to a shop at this hour. */
export function homeToWorkAt(hour: number): number {
  return sampleHourly(OUTBOUND, hour);
}

/** `13.75` -> `"13:45"`. */
export function formatClock(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const whole = Math.floor(h);
  const minutes = Math.floor((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Names for the part of the day, for anything that wants to say where it is. */
export function periodOf(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5) return 'night';
  if (h < 7) return 'early';
  if (h < 10) return 'morning peak';
  if (h < 16) return 'midday';
  if (h < 19) return 'evening peak';
  if (h < 22) return 'evening';
  return 'night';
}
