/** Hand-wired movements on highway junctions: do the overrides take? */
import { compile } from '../src/core/network/compiler';
import { doc, addProfile, addStroke, pts, line } from '../test/helpers/build';
import { kph } from '../src/core/network/model';
import type { EditModel, LaneLinkOverride } from '../src/core/network/types';

function freeway(links: LaneLinkOverride[] = []): { m: EditModel; fw: number; rp: number } {
  const m = doc(3);
  const fw = addProfile(m, { name: 'fw', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5, speedLimit: kph(110) });
  const rp = addProfile(m, { name: 'ramp', lanesForward: 2, lanesBackward: 0, laneWidth: 4, shoulder: 1.2, speedLimit: kph(80), isRamp: true });
  const a = addStroke(m, fw, line(-1200, 0, 1200, 0, 3));
  const b = addStroke(m, rp, pts(-700, 200, -400, 90, -200, 0));
  m.laneLinks = links;
  return { m, fw: a.id, rp: b.id };
}

function report(label: string, m: EditModel): void {
  const net = compile(m);
  const conns = net.lanes.filter((l) => l.kind === 1);
  console.log(`${label}: ${conns.length} connectors ` +
    conns.map((c) => {
      const from = net.lanes[c.predecessors[0]], to = net.lanes[c.successors[0]];
      const nm = (l: any) => l ? `${net.segments[l.segmentId]?.strokeId ?? '?'}:${l.side}:${l.index}` : '?';
      return `[${nm(from)}->${nm(to)} ${c.length.toFixed(0)}m]`;
    }).join(' '));
  const errs = net.diagnostics.filter((d) => d.severity !== 'info');
  for (const d of errs) console.log(`    ${d.severity}: ${d.code} ${d.message}`);
}

// 1. What the compiler does on its own.
const base = freeway();
report('auto            ', base.m);

// 2. Hand-wire the ramp's two lanes the other way round (outer ramp lane -> inner aux).
const swapped = freeway();
swapped.m.laneLinks = [{
  x: -200, y: 0,
  links: [
    { from: `${swapped.rp}:1:0`, to: `${swapped.fw}:1:-2` },
    { from: `${swapped.rp}:1:1`, to: `${swapped.fw}:1:-1` },
  ],
}];
report('swapped by hand ', swapped.m);

// 3. Both ramp lanes into one auxiliary lane.
const funnel = freeway();
funnel.m.laneLinks = [{
  x: -200, y: 0,
  links: [
    { from: `${funnel.rp}:1:0`, to: `${funnel.fw}:1:-1` },
    { from: `${funnel.rp}:1:1`, to: `${funnel.fw}:1:-1` },
  ],
}];
report('funnelled       ', funnel.m);

// 4. A pair named backwards (road -> ramp at a merge), which must be refused.
const backwards = freeway();
backwards.m.laneLinks = [{
  x: -200, y: 0,
  links: [{ from: `${backwards.fw}:1:0`, to: `${backwards.rp}:1:0` }],
}];
report('backwards       ', backwards.m);

// 4b. A genuine reversal: both lanes belong to the gore, named the wrong way round.
const reversed = freeway();
reversed.m.laneLinks = [{
  x: -200, y: 0,
  links: [{ from: `${reversed.fw}:1:-1`, to: `${reversed.rp}:1:0` }],
}];
report('reversed        ', reversed.m);

// 5. An override placed at the wrong spot entirely.
const misplaced = freeway();
misplaced.m.laneLinks = [{
  x: 600, y: 0,
  links: [{ from: `${misplaced.rp}:1:0`, to: `${misplaced.fw}:1:-1` }],
}];
report('misplaced       ', misplaced.m);
