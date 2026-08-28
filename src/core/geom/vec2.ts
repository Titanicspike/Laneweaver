/**
 * 2D vector helpers.
 *
 * Two styles live here on purpose:
 *  - object form (`Vec2`) for editor/compiler code where clarity wins;
 *  - scalar form (`dist2`, `dot2`, ...) for hot loops where allocation is banned.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const EPS = 1e-9;

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function scale(out: Vec2, a: Vec2, k: number): Vec2 {
  out.x = a.x * k;
  out.y = a.y * k;
  return out;
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Rotate 90° clockwise: the *right* side of a vehicle travelling along `a`. */
export function perpRight(out: Vec2, a: Vec2): Vec2 {
  const { x, y } = a;
  out.x = -y;
  out.y = x;
  return out;
}

export function rotate(out: Vec2, a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const { x, y } = a;
  out.x = x * c - y * s;
  out.y = x * s + y * c;
  return out;
}

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

// --- scalar forms for hot loops -------------------------------------------------

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function cross3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
