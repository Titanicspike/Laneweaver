/** Geometric audit: things that would look wrong on screen, found numerically. */
import { compile } from '../src/core/network/compiler';
import { layoutBuildings } from '../src/render/buildings';
import { cases } from './cases';
import type { EditModel, Network, Segment } from '../src/core/network/types';
import { LaneKind } from '../src/core/network/types';
import {
  bboxOfPolyline, buildArclength, closestOnPolyline, makeClosestHit, samplePosition, sampleTangent,
} from '../src/core/geom/polyline';

function ringArea(p: ArrayLike<number>): number {
  const n = p.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2]! * p[i * 2 + 1]! - p[i * 2]! * p[j * 2 + 1]!;
  return a / 2;
}
function inPoly(p: ArrayLike<number>, x: number, y: number): boolean {
  const n = p.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!, yi = p[i * 2 + 1]!, xj = p[j * 2]!, yj = p[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Distance from a point to a polyline. */
function distTo(p: ArrayLike<number>, x: number, y: number): number {
  const n = p.length >> 1;
  let best = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = p[i * 2]!, ay = p[i * 2 + 1]!, bx = p[i * 2 + 2]!, by = p[i * 2 + 3]!;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

/**
 * Distance from a point to a polyline whose two end segments are treated as
 * continuing past their ends by `reach` metres.
 *
 * This is what "does this line hand over to that one" actually asks. The clamped
 * distance answers a different question, and answers it wrongly at exactly the
 * place that matters: a gore's edge line and the road's are collinear and meet end
 * to end, so a seventeen-centimetre gap *along* them reads as seventeen centimetres
 * of error, indistinguishable from a seventeen-centimetre jog sideways. One is
 * invisible on the road and the other is the defect being hunted.
 */
function lateralTo(p: ArrayLike<number>, x: number, y: number, reach: number): number {
  const n = p.length >> 1;
  if (n < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < n - 1; i++) {
    let ax = p[i * 2]!, ay = p[i * 2 + 1]!, bx = p[i * 2 + 2]!, by = p[i * 2 + 3]!;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    if (i === 0) { ax -= (dx / len) * reach; ay -= (dy / len) * reach; }
    if (i === n - 2) { bx += (dx / len) * reach; by += (dy / len) * reach; }
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
    best = Math.min(best, Math.hypot(x - (ax + ex * t), y - (ay + ey * t)));
  }
  return best;
}

/** Andrew's monotone chain. */
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (input: Array<[number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function auditOne(name: string, net: Network, profiles: Map<number, { shoulder: number }>): string[] {
  const bad: string[] = [];
  const say = (s: string) => bad.push(`${name}: ${s}`);

  for (const d of net.diagnostics) {
    if (d.severity === 'error') say(`ERROR diagnostic ${d.code}: ${d.message}`);
  }

  // 1. Markings must lie on their own segment's asphalt.
  for (const seg of net.segments) {
    if (seg.surface.length < 6) { say(`seg ${seg.id} has no surface`); continue; }
    for (const m of seg.markings) {
      const n = m.points.length >> 1;
      let outside = 0;
      for (let i = 0; i < n; i++) {
        const x = m.points[i * 2]!, y = m.points[i * 2 + 1]!;
        if (!inPoly(seg.surface, x, y) && distTo(seg.surface, x, y) > 0.35) outside++;
      }
      if (outside > 1) say(`seg ${seg.id} ${m.style} marking has ${outside}/${n} points off the asphalt`);
    }
  }

  // 2. Lane centrelines must lie on their segment's asphalt.
  for (const lane of net.lanes) {
    if (lane.kind !== LaneKind.Road) continue;
    const seg = net.segments[lane.segmentId];
    if (!seg) continue;
    const n = lane.centerline.length >> 1;
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const x = lane.centerline[i * 2]!, y = lane.centerline[i * 2 + 1]!;
      if (!inPoly(seg.surface, x, y) && distTo(seg.surface, x, y) > 0.3) outside++;
    }
    if (outside > 1) say(`lane ${lane.id} (seg ${seg.id}) runs off its own asphalt at ${outside}/${n} points`);
  }

  // 3. A connector must be paved: on its junction footprint, or on a road surface.
  const surfaces: Segment[] = net.segments;
  for (const j of net.junctions) {
    for (const cid of j.connectorIds) {
      const c = net.lanes[cid]!;
      const n = c.centerline.length >> 1;
      let bare = 0;
      for (let i = 0; i < n; i++) {
        const x = c.centerline[i * 2]!, y = c.centerline[i * 2 + 1]!;
        if (j.footprint.length >= 6 && inPoly(j.footprint, x, y)) continue;
        if (surfaces.some((s) => s.surface.length >= 6 && inPoly(s.surface, x, y))) continue;
        bare++;
      }
      if (bare > 1) say(`junction ${j.id} (${j.kind}) connector ${cid} crosses bare ground at ${bare}/${n} points`);
    }
  }

  // 4. Every edge line sits exactly one shoulder inside the asphalt boundary.
  for (const seg of net.segments) {
    if (seg.surface.length < 6) continue;
    const profile = profiles.get(seg.profileId);
    if (!profile) continue;
    for (const m of seg.markings) {
      if (m.style !== 'edge') continue;
      const n = m.points.length >> 1;
      let worst = 0;
      let at = -1;
      // Skip the ends: there the nearest boundary is the cap, not the kerb.
      for (let i = 2; i < n - 2; i++) {
        const x = m.points[i * 2]!, y = m.points[i * 2 + 1]!;
        const d = Math.abs(distTo(seg.surface, x, y) - profile.shoulder);
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > 0.45) {
        say(`seg ${seg.id} edge line is ${worst.toFixed(2)} m off the shoulder line `
          + `at point ${at}/${n} (${m.points[at * 2]!.toFixed(0)},${m.points[at * 2 + 1]!.toFixed(1)})`);
      }
    }
  }

  // 5. The carriageway edge must be painted for the whole length of every road.
  // "The markings disappear too early" is the single most reported defect, and it is
  // exactly this: asphalt with no edge line one shoulder inside it.
  {
    const edges: Float32Array[] = [];
    for (const seg of net.segments) {
      for (const m of seg.markings) if (m.style === 'edge') edges.push(m.points);
    }
    for (const j of net.junctions) {
      for (const m of j.markings ?? []) if (m.style === 'edge') edges.push(m.points);
    }

    for (const seg of net.segments) {
      if (seg.surface.length < 6) continue;
      const profile = profiles.get(seg.profileId);
      if (!profile) continue;
      const p = { x: 0, y: 0 };
      const t = { x: 1, y: 0 };
      let worst = 0;
      let where = -1;
      // An auxiliary lane that starts without a taper steps the asphalt by a whole
      // lane, and a ray cast right at the step exits through its face rather than
      // the kerb. Only a run of bad samples is a real hole in the paint.
      const run = new Map<number, number>();
      // Skip the last few metres at each end: there the boundary is the cap.
      for (let s2 = 4; s2 < seg.length - 4; s2 += 3) {
        samplePosition(seg.centerline, seg.arclength, s2, p);
        sampleTangent(seg.centerline, seg.arclength, s2, t);
        for (const sign of [1, -1]) {
          const nx = -t.y * sign, ny = t.x * sign;
          // March across this segment's own asphalt only. Junction footprints are
          // paved too, but their outer boundary belongs to the box or the gore.
          let d = 0;
          while (d < 60 && inPoly(seg.surface, p.x + nx * (d + 0.25), p.y + ny * (d + 0.25))) d += 0.25;
          if (d < 1) continue; // nothing paved this way
          // A junction mouth is deliberately unpainted: the corner fillet is asphalt
          // that belongs to the box, not to any lane, and no edge line runs through it.
          const bx = p.x + nx * d, by = p.y + ny * d;
          if (net.junctions.some((j) => j.kind === 'crossing' && j.footprint.length >= 6
            && (inPoly(j.footprint, bx, by) || distTo(j.footprint, bx, by) < 1))) continue;
          const ex = p.x + nx * (d - profile.shoulder);
          const ey = p.y + ny * (d - profile.shoulder);
          let best = Infinity;
          for (const e of edges) best = Math.min(best, distTo(e, ex, ey));
          const streak = best > 1.1 ? (run.get(sign) ?? 0) + 1 : 0;
          run.set(sign, streak);
          if (streak >= 2 && best > worst) { worst = best; where = s2; }
        }
      }
      if (worst > 1.1) {
        say(`seg ${seg.id} carriageway edge is unpainted at s=${where.toFixed(0)}`
          + ` (nearest edge line ${worst.toFixed(2)} m away)`);
      }
    }
  }

  // 6. Every boundary between two side-by-side lanes must be painted. A missing
  // divider reads as one impossibly wide lane, which is how a stacked auxiliary
  // lane or a turn bay goes wrong without anything else looking off.
  {
    const lines: Float32Array[] = [];
    for (const seg of net.segments) {
      for (const m of seg.markings) if (m.style !== 'edge') lines.push(m.points);
    }
    for (const j of net.junctions) {
      for (const m of j.markings ?? []) lines.push(m.points);
    }
    const hit = makeClosestHit();
    for (const lane of net.lanes) {
      if (lane.kind !== LaneKind.Road || lane.left < 0) continue;
      const other = net.lanes[lane.left]!;
      if (other.kind !== LaneKind.Road) continue;
      const arcB = buildArclength(other.centerline);
      let worst = 0;
      let where = 0;
      let streak = 0;
      const lo = Math.max(lane.startsAt, 0) + 3;
      const hi = Math.min(lane.endsAt, lane.length) - 3;
      const p = { x: 0, y: 0 };
      for (let s2 = lo; s2 < hi; s2 += 4) {
        samplePosition(lane.centerline, lane.arclength, s2, p);
        closestOnPolyline(other.centerline, arcB, p.x, p.y, hit);
        // Only where both lanes are at their full width: inside a taper the two
        // centres converge and the midpoint is no longer the boundary.
        const nominal = (lane.width + other.width) / 2;
        if (Math.abs(hit.distance - nominal) > 0.35) { streak = 0; continue; }
        const mx = (p.x + hit.x) / 2, my = (p.y + hit.y) / 2;
        let best = Infinity;
        for (const e of lines) best = Math.min(best, distTo(e, mx, my));
        streak = best > 0.5 ? streak + 1 : 0;
        if (streak >= 2 && best > worst) { worst = best; where = s2; }
      }
      if (worst > 0.5) {
        say(`lane ${lane.id}/${lane.left} (seg ${lane.segmentId}) share an unpainted`
          + ` boundary at s=${where.toFixed(0)} (nearest line ${worst.toFixed(2)} m)`);
      }
    }
  }

  // 7. A junction box may not stick out past the roads that made it.
  //
  // "A road pokes out of the intersection" is a bump of asphalt beyond the far kerb
  // of a through road, on a side no approach reaches — an arm grown longer than the
  // junction it belongs to, or wide enough that its far corner clears the far kerb.
  // The junction region is the convex hull of the caps that *touch this junction*,
  // together with the junction itself, which is inside its own box by definition.
  //
  // Both of those matter. Taking every cap of every approaching segment — including
  // the one at the road's far end, hundreds of metres away — makes the hull a huge
  // triangle that catches nothing; worse, when every arm leaves within a half-plane
  // the hull does not contain the junction at all, and then a perfectly good box is
  // entirely "outside" it. That fired on 36 of 420 fuzzed junction shapes, reporting
  // overhangs of up to 17 m that were nothing of the sort.
  //
  // And a point outside the hull is still fine if a road is under it: an approach
  // corridor deliberately runs a few metres back up its own road, past the cap, so
  // that filleting the corners cannot nibble the joint. What is being looked for is
  // asphalt with *no road behind it*, so that is what is asked.
  for (const j of net.junctions) {
    if (j.kind !== 'crossing' || j.footprint.length < 6) continue;
    const corners: Array<[number, number]> = [[j.x, j.y]];
    for (const a2 of j.approaches) {
      const seg = net.segments[a2.segmentId];
      if (!seg) continue;
      const cap = a2.atSegmentEnd ? seg.capEnd : seg.capStart;
      if (cap.length < 4) continue;
      corners.push([cap[0]!, cap[1]!], [cap[2]!, cap[3]!]);
    }
    if (corners.length < 3) continue;
    const hull = convexHull(corners);
    const ring = new Float32Array(hull.length * 2 + 2);
    for (let i = 0; i < hull.length; i++) { ring[i * 2] = hull[i]![0]; ring[i * 2 + 1] = hull[i]![1]; }
    ring[hull.length * 2] = hull[0]![0];
    ring[hull.length * 2 + 1] = hull[0]![1];

    // Corner rounding only ever cuts *into* the box, and the hull's edges already
    // run across the corners, so a well-formed footprint sits inside it to within a
    // flattening tolerance. Anything past that is a road grown too long or too wide.
    // How far past the hull the box may legitimately reach.
    //
    // Two things put it there and both are deliberate. Corners are filleted at a
    // kerb radius scaled to the narrowest road, and a junction *has* paved corners.
    // And each approach corridor runs a little way back up its own road past the cap
    // — `radius + 2` in the compiler — so that filleting cannot nibble the joint.
    // Together those are the most a well-formed box can stick out; anything beyond
    // is an arm grown too long or too wide, which is the thing being looked for.
    let narrowest = Infinity;
    for (const a2 of j.approaches) {
      const seg = net.segments[a2.segmentId];
      if (!seg) continue;
      const cap = a2.atSegmentEnd ? seg.capEnd : seg.capStart;
      if (cap.length < 4) continue;
      narrowest = Math.min(narrowest, Math.hypot(cap[0]! - cap[2]!, cap[1]! - cap[3]!) / 2);
    }
    const kerb = Number.isFinite(narrowest) ? Math.min(6, Math.max(1.5, narrowest * 0.9)) : 6;
    const FILLET = kerb + 2 + 1.2;
    let worst = 0;
    let at = '';
    // ...or a movement: a junction whose arms all leave within a half-plane has
    // turns that swing round the empty side of the centre, and the box is built out
    // to cover them. Asphalt with a connector on it is asphalt with a reason.
    const onSomeRoad = (px: number, py: number): boolean => {
      for (const seg of net.segments) {
        if (seg.surface.length >= 6 && inPoly(seg.surface, px, py)) return true;
      }
      for (const id of j.connectorIds) {
        const c = net.lanes[id]!;
        if (distTo(c.centerline, px, py) <= c.width * 0.5 + 1.0) return true;
      }
      return false;
    };
    for (let p = 0; p < j.footprint.length; p += 2) {
      const px = j.footprint[p]!, py = j.footprint[p + 1]!;
      if (inPoly(ring, px, py)) continue;
      const d = distTo(ring, px, py);
      if (d <= worst) continue;
      if (onSomeRoad(px, py)) continue;
      worst = d;
      at = `(${px.toFixed(0)},${py.toFixed(0)})`;
    }
    if (worst > FILLET) {
      say(`junction ${j.id} (${j.kind}) sticks out ${worst.toFixed(1)} m past the roads`
        + ` that made it, at ${at}`);
    }
  }

  // 8. The two median edge lines must never swap sides.
  //
  // A short block with a left-turn bay at each end has both bays reaching into the
  // same median from opposite directions; let both take all of it and the lines
  // cross, painting a yellow X down the middle of the road.
  for (const seg of net.segments) {
    const medians = seg.markings.filter((m) => m.style === 'median' && m.points.length >= 4);
    if (medians.length !== 2) continue;
    const hit = makeClosestHit();
    const p = { x: 0, y: 0 };
    const t = { x: 1, y: 0 };
    const arcs = medians.map((m) => buildArclength(m.points));
    let flips = 0;
    let sign = 0;
    let where = 0;
    for (let s2 = 2; s2 < seg.length - 2; s2 += 3) {
      samplePosition(seg.centerline, seg.arclength, s2, p);
      sampleTangent(seg.centerline, seg.arclength, s2, t);
      const lat = medians.map((m, i) => {
        closestOnPolyline(m.points, arcs[i]!, p.x, p.y, hit);
        return (hit.x - p.x) * -t.y + (hit.y - p.y) * t.x;
      });
      const d = lat[0]! - lat[1]!;
      if (Math.abs(d) < 0.05) continue;
      const now = Math.sign(d);
      if (sign !== 0 && now !== sign) { flips++; where = s2; }
      sign = now;
    }
    if (flips > 0) {
      say(`seg ${seg.id} median lines cross each other ${flips}x (first at s=${where.toFixed(0)})`);
    }
  }

  // 8b. One road's paint may not lie on another road's asphalt.
  //
  // Segments are trimmed back so their surfaces do not overlap, and a marking
  // inside a neighbour's surface is a lane line drawn across somebody else's
  // lanes. It happened where a slip road met an arterial at twenty degrees: the
  // trim cleared the arterial's profile width, and the arterial's approach was a
  // lane wider than that for its turn bay. A point on the shared boundary rounds
  // either way, so only a point clearly inside counts.
  {
    const boxes = net.segments.map((seg) => seg.surface.length >= 6 ? bboxOfPolyline(seg.surface) : null);
    // Segments joined end to end — a link, a plain split, a lane drop — overlap by
    // a tenth of a metre on purpose so no hairline shows, and their paint runs
    // straight across the joint. Those pairs are not two roads.
    const joined = new Set<string>();
    for (const lane of net.lanes) {
      if (lane.segmentId < 0) continue;
      for (const next of lane.successors) {
        const other = net.lanes[next]!;
        if (other.segmentId >= 0 && other.segmentId !== lane.segmentId) {
          joined.add(`${lane.segmentId}|${other.segmentId}`);
          joined.add(`${other.segmentId}|${lane.segmentId}`);
        }
      }
    }
    for (const seg of net.segments) {
      for (const m of seg.markings) {
        let worst = 0;
        let where = '';
        for (let i = 0; i < m.points.length; i += 2) {
          const x = m.points[i]!, y = m.points[i + 1]!;
          for (let k = 0; k < net.segments.length; k++) {
            const other = net.segments[k]!;
            const box = boxes[k];
            if (other === seg || !box || x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
            if (joined.has(`${seg.id}|${other.id}`)) continue;
            // A bridge over a road shares its plan and nothing else.
            if (other.grade !== seg.grade) continue;
            if (!inPoly(other.surface, x, y)) continue;
            const d = distTo(other.surface, x, y);
            if (d > worst) { worst = d; where = `seg ${other.id} at (${x.toFixed(0)},${y.toFixed(0)})`; }
          }
        }
        if (worst > 0.3) say(`seg ${seg.id} ${m.style} marking runs ${worst.toFixed(2)} m inside ${where}`);
      }
    }
  }

  // 9. A junction's own paint has to hand over cleanly to the road's.
  //
  // A gore's edge lines continue the ramp's, and where they meet the two must be
  // the same line. Size the gore paint off the connector rather than the ramp lane
  // and each end lands a few centimetres beside the line it continues — a visible
  // jog in both edge lines at the hand-over, on every ramp in the network.
  for (const j of net.junctions) {
    for (const m of j.markings ?? []) {
      const n = m.points.length >> 1;
      if (n < 2) continue;
      // A gore's edge lines *continue* the ramp's, which is what this checks. A
      // pedestrian crossing continues nothing — it lies across the road on the
      // junction's own asphalt — so it has no hand-over to get wrong.
      if (m.style === 'zebra') continue;
      for (const i of [0, n - 1]) {
        const x = m.points[i * 2]!, y = m.points[i * 2 + 1]!;
        let best = Infinity;
        for (const seg of net.segments) {
          for (const other of seg.markings) {
            // Either white longitudinal style will do. A gore's inner line is the
            // ramp's carriageway edge where it leaves the ramp and the boundary
            // between two auxiliary lanes where it meets the road, so demanding one
            // style at both ends demands something no single polyline can be.
            // A yellow line — a median edge, an undivided centre — continues only
            // its own kind: a right-in / right-out carries the through road's median
            // lines across the box, and those must land on the median lines.
            const white = (style: string): boolean => style === 'edge' || style === 'dashed';
            if (white(m.style) ? !white(other.style) : other.style !== m.style) continue;
            if (other.points.length < 4) continue;
            best = Math.min(best, lateralTo(other.points, x, y, 1.5));
          }
        }
        if (best > 0.15) {
          say(`junction ${j.id} (${j.kind}) ${m.style} marking ends ${best.toFixed(2)} m`
            + ` from the road marking it continues, at (${x.toFixed(0)},${y.toFixed(0)})`);
        }
      }
    }
  }

  // 10b. No road marking may fall inside a crossing's box.
  //
  // This used to be enforced by painting the whole junction footprint over the top,
  // which "worked" the way a bucket of paint works: the footprint reaches its own
  // trim *plus the width of the road it crosses* up every approach, so what it
  // actually hid was the last eight metres of every road's lane lines, median and
  // edge lines. Paint that stops a car's length short of the stop bar is what made
  // every junction in the network look unfinished.
  //
  // Segments are trimmed back to the junction radius, so their markings cannot reach
  // the box in the first place. That is the invariant; this is the check that keeps
  // it true, and it replaced the cover rather than joining it.
  for (const j of net.junctions) {
    if (j.kind !== 'crossing' || j.footprint.length < 6) continue;
    let inside = 0;
    let where = '';
    for (const seg of net.segments) {
      for (const m of seg.markings) {
        for (let i = 0; i < m.points.length; i += 2) {
          const x = m.points[i]!, y = m.points[i + 1]!;
          if (Math.hypot(x - j.x, y - j.y) > j.radius) continue;
          if (!inPoly(j.footprint, x, y)) continue;
          // Paint on the approach's own asphalt belongs to the approach.
          if (inPoly(seg.surface, x, y)) continue;
          if (!inside) where = `(${x.toFixed(0)},${y.toFixed(0)})`;
          inside++;
        }
      }
    }
    if (inside) {
      say(`junction ${j.id} has road marking inside its box, ${inside} points from ${where}`);
    }
  }

  // 11. Nothing built may stand on a road, in a junction, or inside anything else.
  //
  // Every failure mode of building placement is visual and silent — a house in the
  // carriageway, two houses in the same place, a terrace fanned round the mouth of a
  // junction — so it gets checked here rather than looked at. Sampled across each
  // footprint rather than at its corners: a ten-metre building clears a corner test
  // happily with a lane running through its middle, which is how the first version
  // shipped with houses in the road.
  {
    const plots = layoutBuildings(net);
    const CELL = 80;
    const cells = new Map<string, Float32Array[]>();
    const put = (ring: Float32Array): void => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        minX = Math.min(minX, ring[i]!); maxX = Math.max(maxX, ring[i]!);
        minY = Math.min(minY, ring[i + 1]!); maxY = Math.max(maxY, ring[i + 1]!);
      }
      for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
        for (let gy = Math.floor(minY / CELL); gy <= Math.floor(maxY / CELL); gy++) {
          const key = `${gx}|${gy}`;
          const list = cells.get(key);
          if (list) list.push(ring);
          else cells.set(key, [ring]);
        }
      }
    };
    for (const seg of net.segments) if (seg.surface.length >= 6) put(seg.surface);
    for (const j of net.junctions) if (j.footprint.length >= 6) put(j.footprint);

    const samples = function* (poly: Float32Array): Generator<[number, number]> {
      const n = poly.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = poly[i * 2]!, ay = poly[i * 2 + 1]!;
        const dx = poly[j * 2]! - ax, dy = poly[j * 2 + 1]! - ay;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 1.2));
        for (let k = 0; k < steps; k++) yield [ax + (dx * k) / steps, ay + (dy * k) / steps];
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i]!); maxX = Math.max(maxX, poly[i]!);
        minY = Math.min(minY, poly[i + 1]!); maxY = Math.max(maxY, poly[i + 1]!);
      }
      for (let x = minX; x <= maxX; x += 1.2) {
        for (let y = minY; y <= maxY; y += 1.2) if (inPoly(poly, x, y)) yield [x, y];
      }
    };

    let onRoad = 0;
    for (const plot of plots) {
      let found: [number, number] | null = null;
      for (const [x, y] of samples(plot.footprint)) {
        for (const ring of cells.get(`${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`) ?? []) {
          if (inPoly(ring, x, y)) { found = [x, y]; break; }
        }
        if (found) break;
      }
      if (found && onRoad++ < 3) {
        say(`a building stands on the road at (${found[0].toFixed(0)},${found[1].toFixed(0)})`);
      }
    }

    // Plots against each other. Reserving the whole plot rather than the building is
    // what keeps two roads' properties from interleaving at a corner, so that is what
    // gets checked.
    const box = (poly: Float32Array): [number, number, number, number] => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i]!); maxX = Math.max(maxX, poly[i]!);
        minY = Math.min(minY, poly[i + 1]!); maxY = Math.max(maxY, poly[i + 1]!);
      }
      return [minX, minY, maxX, maxY];
    };
    const sat = (a: Float32Array, b: Float32Array): boolean => {
      for (const poly of [a, b]) {
        const n = poly.length >> 1;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const nx = -(poly[j * 2 + 1]! - poly[i * 2 + 1]!);
          const ny = poly[j * 2]! - poly[i * 2]!;
          const len = Math.hypot(nx, ny) || 1;
          let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
          for (let k = 0; k < a.length; k += 2) {
            const d = (a[k]! * nx + a[k + 1]! * ny) / len;
            if (d < aMin) aMin = d; if (d > aMax) aMax = d;
          }
          for (let k = 0; k < b.length; k += 2) {
            const d = (b[k]! * nx + b[k + 1]! * ny) / len;
            if (d < bMin) bMin = d; if (d > bMax) bMax = d;
          }
          if (aMax <= bMin + 0.05 || bMax <= aMin + 0.05) return false;
        }
      }
      return true;
    };
    const boxes = plots.map((pl) => box(pl.ground));
    let clashes = 0;
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) continue;
        if (!sat(plots[i]!.ground, plots[j]!.ground)) continue;
        if (clashes++ < 3) {
          say(`two plots overlap near (${a[0].toFixed(0)},${a[1].toFixed(0)})`);
        }
      }
    }
  }

  // 10. Surfaces must be simple: consistent winding, sane area.
  for (const seg of net.segments) {
    if (seg.surface.length < 6) continue;
    const area = Math.abs(ringArea(seg.surface));
    // The widest cross-section may only apply over a short stretch (an auxiliary
    // lane, a turn bay), so the ceiling is the max width and the floor is the
    // carriageway without any of it.
    let through = 0;
    for (const lane of net.lanes) {
      if (lane.kind !== LaneKind.Road || lane.segmentId !== seg.id || lane.aux) continue;
      through += lane.width;
    }
    const rough = seg.length * seg.maxHalfWidth * 2;
    const floor = seg.length * Math.max(through, seg.maxHalfWidth * 0.6);
    if (area < floor * 0.85 || area > rough * 1.6) {
      say(`seg ${seg.id} surface area ${area.toFixed(0)} vs expected ~${rough.toFixed(0)}`);
    }
  }
  return bad;
}

/** Audit one document, for checking something the zoo does not cover. */
export function auditModel(name: string, model: EditModel): string[] {
  const net = compile(model);
  return auditOne(name, net, new Map(model.profiles.map((p) => [p.id, p])));
}

let total = 0;
for (const c of cases()) {
  const net = compile(c.model);
  const profiles = new Map(c.model.profiles.map((p) => [p.id, p]));
  const bad = auditOne(c.name, net, profiles);
  total += bad.length;
  for (const b of bad) console.log(b);
}
console.log(`--- ${total} findings ---`);
