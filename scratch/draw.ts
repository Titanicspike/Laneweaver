/**
 * Draws a compiled network to a PNG so it can be looked at without a browser.
 *
 * Usage: npx tsx scratch/draw.ts <case> [out.png] [size] [at=x,y] [span=metres]
 */
import { compile } from '../src/core/network/compiler';
import { cases } from './cases';
import { Raster } from './png';
import { LaneKind, type Network } from '../src/core/network/types';

const COLOUR = {
  asphalt: [56, 58, 64] as [number, number, number],
  junction: [70, 60, 62] as [number, number, number],  // tinted, to see the box
  gore: [58, 66, 60] as [number, number, number],
  white: [225, 228, 232] as [number, number, number],
  yellow: [214, 178, 74] as [number, number, number],
  centre: [110, 170, 230] as [number, number, number],
  connector: [120, 220, 160] as [number, number, number],
};

export function drawNetwork(net: Network, opts: {
  size?: number; at?: [number, number]; span?: number; lanes?: boolean;
} = {}): Raster {
  const size = opts.size ?? 900;
  const r = new Raster(size, size);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const seg of net.segments) {
    const s = seg.surface;
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
    }
  }
  if (opts.at) {
    const h = (opts.span ?? 120) / 2;
    x0 = opts.at[0] - h; x1 = opts.at[0] + h; y0 = opts.at[1] - h; y1 = opts.at[1] + h;
  }
  r.fit(x0, y0, x1, y1);

  for (const j of net.junctions) {
    if (j.footprint?.length) {
      r.fillPoly(j.footprint, j.kind === 'crossing' ? COLOUR.junction : COLOUR.gore);
    }
  }
  for (const seg of net.segments) r.fillPoly(seg.surface, COLOUR.asphalt);
  // Junction boxes again, at low alpha, so the overlap is visible as a tint.
  for (const j of net.junctions) {
    if (j.footprint?.length) {
      r.fillPoly(j.footprint, j.kind === 'crossing' ? COLOUR.junction : COLOUR.gore, 0.5);
    }
  }
  if (opts.lanes) {
    for (const lane of net.lanes) {
      if (lane.kind === LaneKind.Connector) r.stroke(lane.centerline, COLOUR.connector, 1, 0.9);
      else r.stroke(lane.centerline, COLOUR.centre, 1, 0.5);
    }
  }
  const paint = (m: { style: string; points: ArrayLike<number> }): void => {
    const c = m.style === 'centre' || m.style === 'median' ? COLOUR.yellow : COLOUR.white;
    r.stroke(m.points, c, m.style === 'zebra' ? 2 : 1.4, 1);
  };
  for (const seg of net.segments) for (const m of seg.markings) paint(m);
  for (const j of net.junctions) for (const m of j.markings ?? []) paint(m);
  return r;
}

const name = process.argv[2] ?? 'cross-arterial-arterial';
const out = process.argv[3] ?? 'net.png';
const size = Number(process.argv[4] ?? 900);
const atArg = process.argv.find((a) => a.startsWith('at='));
const spanArg = process.argv.find((a) => a.startsWith('span='));
const c = cases().find((x) => x.name === name);
if (!c) { console.log('cases:', cases().map((x) => x.name).join(', ')); process.exit(1); }
const net = compile(c.model);
const r = drawNetwork(net, {
  size,
  at: atArg ? (atArg.slice(3).split(',').map(Number) as [number, number]) : undefined,
  span: spanArg ? Number(spanArg.slice(5)) : undefined,
  lanes: process.argv.includes('lanes'),
});
r.save(out);
console.log('wrote', out, `(${name}, ${net.segments.length} segments, ${net.junctions.length} junctions)`);
