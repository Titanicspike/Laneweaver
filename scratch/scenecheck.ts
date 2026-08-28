/**
 * Dev-only: compile a saved document and run the audit over it.
 *
 * The zoo is the shapes we thought of; a user's own map is the shapes they drew.
 * `npx tsx scratch/scenecheck.ts path/to/laneweaver.json [more.json ...]` prints
 * what the compiler made of each one, every diagnostic it raised, and every audit
 * finding — the same checks `npm run audit` runs over the zoo.
 */
import { readFileSync } from 'node:fs';
import { deserialize } from '../src/core/util/serialization';
import { compile } from '../src/core/network/compiler';
import { auditModel } from './audit';

for (const f of process.argv.slice(2)) {
  const model = deserialize(readFileSync(f, "utf8"));
  const net = compile(model);
  const diags = net.diagnostics.filter((d) => d.severity !== 'info');
  console.log(`${f}: ${model.strokes.length} strokes -> ${net.segments.length} segments, ${net.junctions.length} junctions`);
  const byCode = new Map<string, number>();
  for (const d of diags) byCode.set(`${d.severity} ${d.code}`, (byCode.get(`${d.severity} ${d.code}`) ?? 0) + 1);
  console.log('  diagnostics:', byCode.size ? [...byCode].map(([k, v]) => `${k} x${v}`).join(', ') : 'none');
  const findings = auditModel('scene', model);
  console.log(`  audit: ${findings.length} findings`);
  for (const a of findings.slice(0, 6)) console.log('    ' + a.slice(0, 150));
}
