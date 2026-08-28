/** Turn-bay overrides: what each choice builds. */
import { compile } from '../src/core/network/compiler';
import { doc, addProfile, addStroke, line } from '../test/helpers/build';
import { kph } from '../src/core/network/model';
import type { TurnLaneChoice } from '../src/core/network/types';

function build(choice: TurnLaneChoice, lanes = 2, median = 2.4) {
  const m = doc(5);
  const art = addProfile(m, { name: 'art', lanesForward: lanes, lanesBackward: lanes, laneWidth: 3.5, shoulder: 0.6, median, speedLimit: kph(60) });
  const st = addProfile(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, speedLimit: kph(40) });
  const a = addStroke(m, art, line(-400, 0, 400, 0));
  addStroke(m, st, line(0, -400, 0, 400));
  if (choice !== 'auto') m.junctions.push({ x: 0, y: 0, control: 'priority', turnLanes: [{ approach: `${a.id}:1`, choice }] });
  return compile(m);
}
console.log('choice   lanes median | bays on the tested approach (idx, offset, width, startsAt)');
for (const [choice, lanes, median] of [
  ['auto', 2, 2.4], ['none', 2, 2.4], ['left', 2, 2.4], ['right', 2, 2.4], ['both', 2, 2.4],
  ['auto', 1, 0], ['left', 1, 0], ['right', 1, 0], ['both', 1, 0],
] as [TurnLaneChoice, number, number][]) {
  const net = build(choice, lanes, median);
  const bays = net.lanes.filter((l) => l.aux && l.kind === 0 && l.side === 1 && l.startsAt > 0);
  // Which lanes does each turn actually leave from?
  const from = (turn: number): string => {
    const ids = new Set<number>();
    for (const l of net.lanes) {
      if (l.kind !== 1 || l.turn !== turn) continue;
      const src = net.lanes[l.predecessors[0]];
      if (src && src.side === 1 && src.segmentId >= 0 && net.segments[src.segmentId]?.strokeId === net.segments[bays[0]?.segmentId ?? -1]?.strokeId) ids.add(src.index);
    }
    return ids.size ? [...ids].sort().join(',') : '-';
  };
  console.log(`${choice.padEnd(8)} ${lanes}     ${median}    | `
    + (bays.length
      ? bays.map((l) => `idx${String(l.index).padStart(2)} off=${l.offset.toFixed(1)} w=${l.width.toFixed(1)} s@${l.startsAt.toFixed(0)}`).join('  ')
      : '(none)')
    + (bays.length ? `   | L from idx ${from(1)}  R from idx ${from(2)}` : ''));
}
