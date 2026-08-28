/** Compiles a freeway with an on-ramp then an off-ramp at decreasing spacing. */
import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import { doc, addProfile, addStroke, pts, line } from '../test/helpers/build';
import { kph } from '../src/core/network/model';

for (const gap of [900, 700, 500, 390, 300, 220, 150, 100, 60, 30]) {
  const m = doc(3);
  const fw = addProfile(m, { name: 'fw', lanesForward: 3, lanesBackward: 0, laneWidth: 3.6, shoulder: 2.5, speedLimit: kph(110) });
  const rp = addProfile(m, { name: 'ramp', lanesForward: 1, lanesBackward: 0, laneWidth: 4.2, shoulder: 1.5, speedLimit: kph(60), isRamp: true,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 } });
  addStroke(m, fw, line(0, 0, 3000, 0));
  const onGore = 1000;
  addStroke(m, rp, pts(onGore - 430, 110, onGore, 0));
  addStroke(m, rp, pts(onGore + gap, 0, onGore + gap + 430, 110));
  let net;
  try { net = compile(m); } catch (e) { console.log(`gap ${String(gap).padStart(4)}  COMPILE THREW: ${(e as Error).message}`); continue; }
  const aux = net.lanes.filter((l) => l.aux);
  const warn = net.diagnostics ?? [];
  let simNote = '';
  try {
    const sim = new Simulation(net, { seed: 1, demandScale: 0.6 });
    sim.run(300);
    simNote = `arrived=${sim.metrics.arrived} lost=${sim.metrics.lost} coll=${sim.metrics.collisions} missed=${sim.metrics.missedExits}`;
  } catch (e) { simNote = `SIM THREW: ${(e as Error).message}`; }
  console.log(`gap ${String(gap).padStart(4)}  aux=${aux.length} [${aux.map((l) => `${l.id}:${l.length.toFixed(0)}m idx${l.index}${l.endsAt<Infinity?` end@${l.endsAt.toFixed(0)}->${l.mergeTarget}`:''}${l.startsAt>0?` start@${l.startsAt.toFixed(0)}`:''}`).join(' | ')}]`);
  console.log(`          segs=${net.segments.length} junctions=${net.junctions.map((j)=>j.kind).join(',')} diag=${warn.length ? warn.map((d:any)=>d.severity+':'+d.message).slice(0,2).join('; ') : 'none'}`);
  console.log(`          ${simNote}`);
}
