/** How far each arm of every zoo crossing is set back from the meeting point, and why. */
import { compile } from '../src/core/network/compiler';
import { cases } from './cases';
const rows: { name: string; j: number; arms: number; worst: number; detail: string }[] = [];
for (const c of cases()) {
  const net = compile(c.model);
  for (const j of net.junctions) {
    if (j.kind !== 'crossing') continue;
    let worst = 0, detail = '';
    // How far the road reaches from its own centreline at the cap. Half the cap
    // chord is only that when the road is symmetric about its centreline, and a
    // left-turn bay flares one kerb and not the other: the outer extent on the
    // flared side is what an arm crossing there actually has to clear.
    const halves = j.approaches.map((a) => {
      const seg = net.segments[a.segmentId];
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const cl = seg.centerline;
      const [mx, my] = a.atSegmentEnd ? [cl[cl.length - 2], cl[cl.length - 1]] : [cl[0], cl[1]];
      return Math.max(Math.hypot(cap[0] - mx, cap[1] - my), Math.hypot(cap[2] - mx, cap[3] - my));
    });
    j.approaches.forEach((a, i) => {
      const seg = net.segments[a.segmentId];
      const cap = a.atSegmentEnd ? seg.capEnd : seg.capStart;
      const d = Math.hypot((cap[0] + cap[2]) / 2 - j.x, (cap[1] + cap[3]) / 2 - j.y);
      // What this arm needs to be set back by: to clear the edge of every road it
      // meets, at the angle it meets it, plus a kerb. Two arms leaving the same
      // side at a shallow angle overlap for a long way and need the long trim.
      const hx = Math.cos(a.heading), hy = Math.sin(a.heading);
      let need = halves[i];
      j.approaches.forEach((b, k) => {
        if (k === i) return;
        const bx = Math.cos(b.heading), by = Math.sin(b.heading);
        const dot = hx * bx + hy * by;
        if (dot < -0.866) return; // straight opposite: the same road, never crossed
        const sin = Math.max(Math.sqrt(Math.max(0, 1 - dot * dot)), 0.2);
        // Alongside at a shallow angle, an arm clears the other road as it may be
        // widened for a turn bay: one lane more.
        const bay = sin < 0.707 ? 3.5 : 0;
        need = Math.max(need, (halves[k] + bay + halves[i] * Math.abs(dot)) / sin);
      });
      need += 3;
      const excess = d - need;
      if (excess > worst) { worst = excess; detail = `arm ${i} (half ${halves[i].toFixed(1)}) set back ${d.toFixed(1)} m, needs ~${need.toFixed(1)}`; }
    });
    rows.push({ name: c.name, j: j.id, arms: j.approaches.length, worst, detail });
  }
}
rows.sort((a, b) => b.worst - a.worst);
console.log('crossings by excess setback (cap distance beyond the widest crossing road + 3 m kerb):');
for (const r of rows.slice(0, 18)) console.log(`  ${r.worst.toFixed(1).padStart(5)} m  ${r.name} j${r.j} (${r.arms} arms): ${r.detail}`);
