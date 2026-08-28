/** Dev-only: how do drivers behave as a function of distance from a junction? */
import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import { autoSmoothHandles, createDocument, kph, makeControlPoint } from '../src/core/network/model';
import type { ControlPoint, EditModel, RoadProfile } from '../src/core/network/types';
import { Hold } from '../src/core/sim/params';

function pts(...c: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < c.length; i += 2) out.push(makeControlPoint(c[i]!, c[i + 1]!));
  autoSmoothHandles(out);
  return out;
}
// A 3+3 arterial running east, crossed by two side roads. Traffic must sort itself
// into the right lane for its turn well before each junction.
const m: EditModel = createDocument(9);
const big: RoadProfile = {
  id: m.nextId++, name: 'Main', lanesForward: 3, lanesBackward: 3, laneWidth: 3.5,
  speedLimit: kph(80), median: 3, shoulder: 1, isRamp: false,
};
const side: RoadProfile = {
  id: m.nextId++, name: 'Side', lanesForward: 1, lanesBackward: 1, laneWidth: 3.4,
  speedLimit: kph(50), median: 0, shoulder: 0.5, isRamp: false,
};
m.profiles.push(big, side);
m.strokes.push({ id: m.nextId++, profileId: big.id, points: pts(-2000, 0, 2000, 0) });
m.strokes.push({ id: m.nextId++, profileId: side.id, points: pts(0, -600, 0, 600) });
m.strokes.push({ id: m.nextId++, profileId: side.id, points: pts(900, -600, 900, 600) });
const net = compile(m);
console.log('junctions', net.junctions.map((j) => `${j.kind}/${j.control}`).join(' '));

const SCALE = Number(process.argv[2] ?? 1);
const sim = new Simulation(net, { seed: 4, demandScale: SCALE }) as never as {
  tick(): void; store: Record<string, Float32Array & Int32Array>; observer: unknown;
  metrics: { arrived: number; meanSpeed: number };
};
// Bucket by distance to the next junction along the main road (x = 0 and x = 900).
const BUCKETS = 12;
const BUCKET_M = 60;
const speed = new Array(BUCKETS).fill(0);
const count = new Array(BUCKETS).fill(0);
const changes = new Array(BUCKETS).fill(0);
const holds = new Array(BUCKETS).fill(null).map(() => new Array(7).fill(0));
const bucketOf = (x: number, y: number): number => {
  if (Math.abs(y) > 12) return -1;
  let best = Infinity;
  for (const jx of [0, 900]) if (jx > x) best = Math.min(best, jx - x);
  if (!Number.isFinite(best)) return -1;
  return best < BUCKETS * BUCKET_M ? Math.floor(best / BUCKET_M) : -1;
};
(sim as { observer: unknown }).observer = {
  onLaneChange: (s: never, i: number) => {
    const b = bucketOf(sim.store.x?.[i] ?? 0, 0);
    void b;
  },
};
// Positions are not in the store; sample via the lane geometry instead.
const { samplePosition } = await import('../src/core/geom/polyline');
const p = { x: 0, y: 0 };
let lastLane = new Int32Array(20000).fill(-1);
for (let k = 0; k < 1200 / 0.05; k++) {
  sim.tick();
  if (k % 4) continue;
  for (let laneId = 0; laneId < net.lanes.length; laneId++) {
    const lane = net.lanes[laneId]!;
    if (lane.kind !== 0 || lane.side !== 1) continue;
    for (let i = sim.store.laneFirst[laneId]!; i >= 0; i = sim.store.behind[i]!) {
      samplePosition(lane.centerline, lane.arclength, sim.store.s[i]!, p);
      const b = bucketOf(p.x, p.y);
      if (b < 0) continue;
      speed[b] += sim.store.v[i]!;
      count[b]++;
      holds[b]![sim.store.hold[i]!]++;
      if (lastLane[i] !== laneId && lastLane[i] !== -1) changes[b]++;
      lastLane[i] = laneId;
    }
  }
}
const HOLD = ['free', 'leader', 'limit', 'wall', 'gap', 'coop', 'junction'];
console.log('distance to junction | mean speed | lane changes | what is holding them');
for (let b = BUCKETS - 1; b >= 0; b--) {
  if (!count[b]) continue;
  const hs = holds[b]!.map((n, i) => [HOLD[i], n / count[b]] as const)
    .filter(([, f]) => f > 0.06).map(([n, f]) => `${n} ${(f * 100).toFixed(0)}%`).join(' ');
  console.log(`${String(b * BUCKET_M).padStart(5)}-${String((b + 1) * BUCKET_M).padEnd(5)} m `
    + `${(speed[b] / count[b]).toFixed(1).padStart(5)} m/s  `
    + `${String(changes[b]).padStart(5)}   ${hs}`);
}
console.log(`speed limit ${(kph(80)).toFixed(1)} m/s, arrived ${sim.metrics.arrived}`);
