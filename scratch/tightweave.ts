/** Tight weaving sections under real demand: does the traffic break? */
import { compile } from '../src/core/network/compiler';
import { Simulation } from '../src/core/sim/sim';
import { doc, addProfile, addStroke, pts, line } from '../test/helpers/build';
import { kph } from '../src/core/network/model';
import { findPortal } from '../test/helpers/scenarios';

function build(gap: number, rampLanes: number) {
  const m = doc(3);
  const fw = addProfile(m, { name: 'fw', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5, speedLimit: kph(110) });
  const rp = addProfile(m, { name: 'ramp', lanesForward: rampLanes, lanesBackward: 0, laneWidth: 4, shoulder: 1.2, speedLimit: kph(80), isRamp: true });
  addStroke(m, fw, line(-1500, 0, 1500, 0, 3));
  addStroke(m, rp, pts(-500 - 430, 200, -500 - 200, 90, -500, 0));
  addStroke(m, rp, pts(-500 + gap, 0, -500 + gap + 200, 90, -500 + gap + 430, 200));
  const net = compile(m);
  const mainIn = findPortal(net, -1500, 0), mainOut = findPortal(net, 1500, 0);
  const rIn = findPortal(net, -930, 200), rOut = findPortal(net, -500 + gap + 430, 200);
  m.demand = [
    { fromPortal: mainIn, toPortal: mainOut, rate: 3600 },
    { fromPortal: rIn, toPortal: mainOut, rate: 900 },
    { fromPortal: mainIn, toPortal: rOut, rate: 900 },
  ];
  return { m, net };
}
console.log('gap  rampLn | arrived  lost  coll  missed  meanV  worstStop  spawned');
for (const rampLanes of [1, 2]) {
  for (const gap of [900, 600, 400, 250, 150, 80, 40]) {
   for (const seedX of [4]) {
    const { m, net } = build(gap, rampLanes);
    const sim = new Simulation(net, { seed: seedX, demand: m.demand });
    const S = sim.store as any;
    sim.run(200);
    let worst = 0, vs = 0, n = 0;
    for (let t = 0; t < 8000; t++) {
      sim.tick();
      if (t % 10 === 0) for (let i = 0; i < S.count; i++) {
        if (S.stoppedTime[i] > worst) worst = S.stoppedTime[i];
        vs += S.v[i]; n++;
      }
    }
    console.log(`${String(gap).padStart(4)} ${String(rampLanes).padStart(6)} | ${String(sim.metrics.arrived).padStart(7)}`
      + ` ${String(sim.metrics.lost).padStart(5)} ${String(sim.metrics.collisions).padStart(5)}`
      + ` ${String(sim.metrics.missedExits).padStart(7)} ${(vs/Math.max(1,n)).toFixed(1).padStart(6)}`
      + ` ${worst.toFixed(0).padStart(10)} ${String(sim.metrics.spawned).padStart(8)} seed${seedX}`);
   }
  }
}
