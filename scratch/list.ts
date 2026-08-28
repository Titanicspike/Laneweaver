import { cases } from './cases';
import { compile } from '../src/core/network/compiler';
for (const c of cases()) {
  const net = compile(c.model);
  const d = net.diagnostics.filter((x) => x.severity !== 'info');
  console.log(c.name.padEnd(26), String(net.segments.length).padStart(2), 'seg',
    (net.junctions.map((j) => j.kind).join(',') || '-').padEnd(22),
    d.map((x) => `${x.severity}:${x.code}`).join(' '));
}
