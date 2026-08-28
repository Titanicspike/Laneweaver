/** How far does each junction box reach up each approach, beyond what it must cover? */
import { compile } from '../src/core/network/compiler';
import { cases } from './cases';
import { LaneKind } from '../src/core/network/types';

for (const c of cases()) {
  let net;
  try { net = compile(c.model); } catch { continue; }
  for (const j of net.junctions) {
    if (j.kind !== 'crossing' || !j.footprint?.length) continue;
    // The widest road meeting here, and the box's own extent.
    let widest = 0;
    for (const a of j.approaches) {
      const seg = net.segments[a.segmentId];
      if (seg) widest = Math.max(widest, seg.maxHalfWidth * 2);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const ring = j.footprint;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]);
    }
    const w = maxX - minX, h = maxY - minY;
    const diag = Math.hypot(w, h);
    // A box should be roughly the size of the widest road plus a kerb radius on
    // each side. Much more than that up one axis is a bump sticking out.
    const ratio = diag / Math.max(1, widest);
    if (ratio > 2.0) {
      console.log(`${c.name.padEnd(26)} j${j.id} arms=${j.approaches.length}`
        + ` box ${w.toFixed(0)}x${h.toFixed(0)} m, widest road ${widest.toFixed(0)} m, ratio ${ratio.toFixed(2)}`);
    }
  }
}
console.log('done');
