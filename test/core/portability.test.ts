/**
 * `src/core/**` must run unchanged in Node and in a browser.
 *
 * Half of that rule is written down as a non-negotiable — core never touches the
 * DOM, Canvas, or anything browser-only — and it holds because every core test runs
 * under Node, where reaching for `document` throws immediately.
 *
 * The other half had nothing checking it, and it broke. Two `process.env` switches
 * went into `core/sim/junction.ts` as A/B toggles while the turn-on-red behaviour
 * was being measured, and stayed. Under Node they are invisible: `process` exists,
 * the branch is false, the tests pass. In a browser `process` does not exist, so
 * **the first vehicle to reach a junction conflict point threw** — the animation
 * frame died with it, and the whole application froze with a network on screen and
 * a clock that had stopped. Every one of 560 tests was green at the time.
 *
 * So this reads the source. It is a blunt instrument and deliberately so: the thing
 * being defended is that core has no environment, and the only way to check that
 * from inside one environment is to look at the text.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src', 'core');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Globals that exist in one environment and not the other. */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\bprocess\s*\./, what: 'process (Node only)' },
  { pattern: /\b__dirname\b/, what: '__dirname (Node only)' },
  { pattern: /\brequire\s*\(/, what: 'require() (Node only)' },
  { pattern: /\bdocument\s*\./, what: 'document (browser only)' },
  { pattern: /\bwindow\s*\./, what: 'window (browser only)' },
  { pattern: /\bnavigator\s*\./, what: 'navigator (browser only)' },
  { pattern: /\blocalStorage\b/, what: 'localStorage (browser only)' },
  { pattern: /\bnew\s+Path2D\b/, what: 'Path2D (browser only)' },
  { pattern: /\bCanvasRenderingContext2D\b/, what: 'Canvas (browser only)' },
];

describe('the headless core', () => {
  const files = sources(ROOT);

  it('has sources to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('reaches for nothing that exists in only one environment', () => {
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        // Comments talk about all of these, and should be able to.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(code)) {
            found.push(`${file.slice(ROOT.length + 1)}: ${rule.what} — ${line.trim()}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('imports nothing from outside core', () => {
    // A core module that imports the renderer or the editor would compile and test
    // fine and still be wrong: the dependency only runs one way.
    const bad: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = match[1]!;
        if (spec.startsWith('.')) continue;
        if (spec.startsWith('node:')) { bad.push(`${file}: imports ${spec}`); continue; }
        // Third-party libraries the architecture names explicitly.
        if (['polygon-clipping', 'rbush', 'simplex-noise', 'd3-contour'].includes(spec)) continue;
        bad.push(`${file.slice(ROOT.length + 1)}: imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
