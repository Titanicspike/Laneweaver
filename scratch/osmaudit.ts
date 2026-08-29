/**
 * Dev-only: the geometric audit, run over the imported cities.
 *
 *   npx tsx scratch/osmaudit.ts            # every cached place, by finding kind
 *   npx tsx scratch/osmaudit.ts cupertino  # one place, with examples
 *
 * `npm run audit` reports zero on the hand-drawn zoo. The zoo has the shapes
 * somebody thought of; a city has the ones nobody did, so this is where the
 * compiler's geometry is actually tested. The kinds are the same checks — markings
 * off their own asphalt, connectors over bare ground, a junction box outside the
 * hull of the roads' caps — and each one is a thing somebody would see.
 */
import { readFileSync, existsSync } from 'node:fs';
import { importOsm } from '../src/core/osm/import';
import { PLACES } from './osmPlaces';
import { auditModel } from './audit';

const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const verbose = process.argv.includes('--examples');
const wanted = named.length ? PLACES.filter((p) => named.includes(p.id)) : PLACES;

const overall = new Map<string, number>();
for (const place of wanted) {
  const f = new URL(`./osm/${place.id}.json`, import.meta.url);
  if (!existsSync(f)) continue;
  const { model } = importOsm(JSON.parse(readFileSync(f, 'utf8')));
  const findings = auditModel(place.id, model);
  const by = new Map<string, number>();
  for (const f2 of findings) {
    // Findings are prose. Strip the numbers and the place name so that "seg 930
    // double marking has 2/25 points off the asphalt" groups with its 177 friends.
    const kind = String(f2)
      .replace(/^[a-z-]+: /, '')
      .replace(/-?\d+(\.\d+)?/g, '#')
      .replace(/\(#,#\)/g, '(x,y)')
      .trim();
    by.set(kind, (by.get(kind) ?? 0) + 1);
    overall.set(kind, (overall.get(kind) ?? 0) + 1);
  }
  console.log(`${place.id.padEnd(16)} ${String(findings.length).padStart(5)} findings  `
    + [...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  if (verbose) {
    const nums = findings.map((f2) => {
      const m = /runs (-?[\d.]+) m inside|sticks out (-?[\d.]+) m/.exec(String(f2));
      return m ? Number(m[1] ?? m[2]) : NaN;
    }).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    if (nums.length) {
      const q = (f: number): string => nums[Math.floor((nums.length - 1) * f)].toFixed(2);
      console.log(`    depth m: min ${q(0)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} max ${q(1)}  (n=${nums.length})`);
    }
  }
}
console.log(`\nacross ${wanted.length} places:`);
for (const [k, v] of [...overall].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}
