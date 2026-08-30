/**
 * A cached bitmap of the part of the picture that does not move.
 *
 * Panning a large map was the slowest thing this renderer did, and almost none of it
 * was work that needed doing twice: on a two-mile import a frame at zoom 0.3 spent
 * 202 ms, of which 163 was stroking the same road casings and lane markings it had
 * stroked the frame before, in the same place, in the same colours. Only the camera
 * had moved.
 *
 * So the static passes are rendered once into an offscreen canvas covering rather
 * more than the viewport, and a pan inside that margin is one `drawImage`.
 *
 * **And when the margin runs out, only the new edge is drawn.** A full re-render is
 * the whole 200 ms back again, once every time a drag crosses the margin — about
 * twice a second, which is exactly the stutter the cache was meant to remove. So the
 * old bitmap is copied into the new one at its new offset and only the strip that
 * has come into view is drawn, against a clip and with the tiles culled to it. A
 * pan pays for the edge it uncovers rather than for the whole map.
 *
 * **Only one grade is cached.** A stack has to interleave — a vehicle on the ground
 * belongs *under* the bridge above it — so a single bitmap of everything would draw
 * cars through flyovers, and one per level would be a hundred megabytes at four
 * levels on a machine that is already struggling. The ground carries essentially all
 * of the picture, so the busiest grade is cached and the rest are drawn live, which
 * costs almost nothing and keeps the order right.
 */

import { Camera } from './camera';
import type { Bbox } from '../core/geom/polyline';

/** How much bigger than the viewport the cached bitmap is, on each axis. */
const MARGIN = 1.4;

/**
 * Beyond this many device pixels the cache is not worth its memory: a small canvas
 * redraws quickly anyway, and a very large one costs more to allocate and blit than
 * the drawing it saves. One bitmap is held, not two — a canvas may be drawn onto
 * itself, and the specification requires the source to read as it was before the
 * call, so the old picture is scrolled in place rather than copied to a partner
 * buffer. On the machine this was written for that is thirty megabytes saved, and
 * the machines this is *for* have less.
 */
const MAX_PIXELS = 14e6;

/** A rectangle of the offscreen, in its own device pixels. */
interface PixelRect { x: number; y: number; w: number; h: number }

export interface StaticDraw {
  (target: CanvasRenderingContext2D, cam: Camera, only: Bbox | null): void;
}

export class StaticLayer {
  private front: HTMLCanvasElement | null = null;
  /** The camera the front bitmap was drawn with: centre, zoom, and its larger size. */
  private at = new Camera();
  private spare = new Camera();
  private valid = false;
  private grade = Number.NaN;

  /** Drops the bitmap: the next frame renders the lot and re-captures. */
  invalidate(): void {
    this.valid = false;
  }

  /** Whether the cached bitmap covers `camera`'s view, and if so blits it. */
  blit(ctx: CanvasRenderingContext2D, camera: Camera, grade: number): boolean {
    if (!this.valid || !this.front || this.grade !== grade) return false;
    if (typeof ctx.drawImage !== 'function') return false;
    const dx = camera.originX() - this.at.originX();
    const dy = camera.originY() - this.at.originY();
    if (!this.covers(dx, dy, camera)) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.front, dx, dy);
    return true;
  }

  /** Whether a bitmap placed at (dx, dy) would fill the viewport. */
  private covers(dx: number, dy: number, camera: Camera): boolean {
    if (!this.front) return false;
    if (this.at.zoom !== camera.zoom || this.at.devicePixelRatio !== camera.devicePixelRatio) {
      return false;
    }
    const w = camera.width * camera.devicePixelRatio;
    const h = camera.height * camera.devicePixelRatio;
    return dx <= 0 && dy <= 0
      && dx + this.front.width >= w && dy + this.front.height >= h;
  }

  /**
   * Brings the cache up to date for `camera` and blits it.
   *
   * `draw` is handed a context already transformed for the *cached* camera — which
   * is centred where the real one is but is larger — and the world rectangle it is
   * allowed to touch, or null for all of it. Every culling and level-of-detail
   * decision has to be made against that camera, or the margin comes out empty.
   */
  capture(
    ctx: CanvasRenderingContext2D, camera: Camera, grade: number, draw: StaticDraw,
  ): boolean {
    if (typeof ctx.drawImage !== 'function') return false;
    const w = Math.ceil(camera.width * MARGIN);
    const h = Math.ceil(camera.height * MARGIN);
    const px = Math.ceil(w * camera.devicePixelRatio);
    const py = Math.ceil(h * camera.devicePixelRatio);
    if (px * py > MAX_PIXELS) return false;
    if (!this.size(px, py)) return false;

    const target = this.front?.getContext('2d');
    if (!target || !this.front) return false;

    // Where the old picture lands in the new bitmap. Reusable only if the two share
    // a zoom and a grade and actually overlap.
    const next = this.spare;
    next.x = camera.x;
    next.y = camera.y;
    next.zoom = camera.zoom;
    next.width = w;
    next.height = h;
    next.devicePixelRatio = camera.devicePixelRatio;
    const shiftX = next.originX() - this.at.originX();
    const shiftY = next.originY() - this.at.originY();
    const reusable = this.valid && this.grade === grade
      && this.at.zoom === camera.zoom && this.at.devicePixelRatio === camera.devicePixelRatio
      && this.at.width === w && this.at.height === h
      && Math.abs(shiftX) < px && Math.abs(shiftY) < py;

    target.setTransform(1, 0, 0, 1, 0, 0);
    // Scroll what is still good into its new place, then clear and redraw only what
    // has come into view. Drawing a canvas onto itself is defined to read the source
    // as it was, so this needs no second buffer.
    const rects = reusable ? exposed(shiftX, shiftY, px, py) : [{ x: 0, y: 0, w: px, h: py }];
    if (reusable) target.drawImage(this.front, shiftX, shiftY);
    for (const rect of rects) target.clearRect(rect.x, rect.y, rect.w, rect.h);

    target.lineJoin = 'round';
    target.lineCap = 'round';
    for (const rect of rects) {
      if (rect.w <= 0 || rect.h <= 0) continue;
      target.save();
      next.applyTo(target);
      const world = toWorld(rect, next);
      target.beginPath();
      target.rect(world.minX, world.minY, world.maxX - world.minX, world.maxY - world.minY);
      target.clip();
      draw(target, next, reusable ? world : null);
      target.restore();
    }

    const was = this.at;
    this.at = next;
    this.spare = was;
    this.grade = grade;
    this.valid = true;
    return this.blit(ctx, camera, grade);
  }

  /** Allocates or resizes the bitmap; false if this environment has no canvas. */
  private size(px: number, py: number): boolean {
    if (this.front && this.front.width === px && this.front.height === py) return true;
    if (typeof document === 'undefined') return false;
    const made = document.createElement('canvas');
    if (!made) return false;
    made.width = px;
    made.height = py;
    this.front = made;
    this.valid = false;
    return true;
  }
}

/**
 * The parts of a `w` by `h` bitmap that the old one, shifted by (sx, sy), does not
 * cover: a vertical strip down the leading edge and a horizontal one across it, cut
 * so they do not overlap and the corner is not drawn twice.
 */
function exposed(sx: number, sy: number, w: number, h: number): PixelRect[] {
  const out: PixelRect[] = [];
  const vx = sx > 0 ? 0 : w + sx;
  const vw = Math.abs(sx);
  if (vw > 0) out.push({ x: vx, y: 0, w: vw, h });
  const hh = Math.abs(sy);
  if (hh > 0) {
    const hx = sx > 0 ? vw : 0;
    out.push({ x: hx, y: sy > 0 ? 0 : h + sy, w: w - vw, h: hh });
  }
  return out;
}

/** A pixel rectangle of the offscreen as world coordinates, with a little margin. */
function toWorld(rect: PixelRect, cam: Camera): Bbox {
  const s = cam.zoom * cam.devicePixelRatio;
  const ox = cam.originX();
  const oy = cam.originY();
  // A road is wide and its paint is drawn from a centreline that may sit outside the
  // strip, so the query has to reach further than the clip does.
  const pad = 40;
  return {
    minX: (rect.x - ox) / s - pad,
    minY: (rect.y - oy) / s - pad,
    maxX: (rect.x + rect.w - ox) / s + pad,
    maxY: (rect.y + rect.h - oy) / s + pad,
  };
}
