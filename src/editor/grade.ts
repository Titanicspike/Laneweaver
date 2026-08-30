/**
 * Levels, as the editor lets you set them.
 *
 * `Grade` is a plain number on a control point and the compiler treats every level
 * the same way: roads only meet what they are level with, and a stroke that changes
 * grade between two points ramps between them. So a bridge over a bridge has always
 * been *compilable* — an OSM import builds four-level stacks routinely — and was
 * simply not reachable by hand, because Tab cycled ground, bridge, tunnel and back.
 * One level up was the only bridge you could draw.
 *
 * Tab now means "up one" and Shift+Tab "down one", which is what a level control
 * should be and is the only way to say "over that other bridge".
 */

/**
 * How far a stack may go either way.
 *
 * Four levels each side of the ground, matching the cap the OSM importer colours
 * crossings up to: past that the shadow offsets have been compressed so far that
 * the order stops reading, and a road that needs a fifth level is better drawn
 * somewhere else.
 */
export const MAX_GRADE = 3;

/** One step up (`dir` +1) or down, stopping at the cap rather than wrapping. */
export function stepGrade(grade: number, dir: number): number {
  const next = Math.round(grade) + (dir > 0 ? 1 : -1);
  return Math.max(-MAX_GRADE, Math.min(MAX_GRADE, next));
}

/**
 * What to call a level in the status line and on an undo entry.
 *
 * The first level up is "Bridge" rather than "Bridge 1", because on almost every
 * document that is the only one there is and a number there is noise.
 */
export function levelName(grade: number): string {
  const g = Math.round(grade);
  if (g === 0) return 'Ground level';
  const kind = g > 0 ? 'Bridge' : 'Tunnel';
  return Math.abs(g) === 1 ? kind : `${kind} level ${Math.abs(g)}`;
}
