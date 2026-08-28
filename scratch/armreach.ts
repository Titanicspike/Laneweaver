/**
 * How far up each approach does the junction's asphalt reach, past the far edge of
 * the road it crosses? Anything much beyond a kerb radius is a stub of tarmac
 * sticking out of the intersection.
 */
import { compile } from '../src/core/network/compiler';
import { cases } from './cases';
import { samplePosition, sampleTangent } from '../src/core/geom/polyline';

function inPoly(p: ArrayLike<number>, x: number, y: number): boolean {
  const n = p.length >> 1; let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i*2]!, yi = p[i*2+1]!, xj = p[j*2]!, yj = p[j*2+1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const worst = new Map<string, string>();
for (const c of cases()) {
  let net; try { net = compile(c.model); } catch { continue; }
  for (const j of net.junctions) {
    if (j.kind !== 'crossing' || !j.footprint?.length) continue;
    // Half-width of the widest road crossing this junction.
    let halfCross = 0;
    for (const a of j.approaches) {
      const seg = net.segments[a.segmentId];
      if (seg) halfCross = Math.max(halfCross, seg.maxHalfWidth);
    }
    for (const a of j.approaches) {
      const seg = net.segments[a.segmentId];
      if (!seg) continue;
      // Walk outward from the junction centre along this approach's own direction.
      const end = a.atEnd ? seg.arclength[seg.arclength.length - 1] : 0;
      const pos = { x: 0, y: 0 }, tan = { x: 0, y: 0 };
      samplePosition(seg.centerline, seg.arclength, end, pos);
      sampleTangent(seg.centerline, seg.arclength, end, tan);
      const dir = a.atEnd ? 1 : -1;
      let reach = 0;
      for (let d = 0; d < 60; d += 0.25) {
        if (inPoly(j.footprint, pos.x + tan.x * dir * d, pos.y + tan.y * dir * d)) reach = d;
      }
      // The road stops at its trim point; the box legitimately covers the crossing
      // road plus a kerb fillet. Anything past that is a bump.
      const excess = reach - halfCross;
      const key = c.name;
      const prev = Number(worst.get(key)?.split('|')[0] ?? -Infinity);
      if (excess > prev) worst.set(key, `${excess.toFixed(1)}|j${j.id} reach ${reach.toFixed(1)} m past the cap, crossing half-width ${halfCross.toFixed(1)} m`);
    }
  }
}
for (const [name, v] of [...worst].sort((a, b) => Number(b[1].split('|')[0]) - Number(a[1].split('|')[0])).slice(0, 14)) {
  console.log(`${name.padEnd(26)} excess ${v.split('|')[0].padStart(6)} m  ${v.split('|')[1]}`);
}
