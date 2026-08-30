/**
 * Camera: world metres to canvas pixels.
 *
 * The world is y-down like the canvas, so the transform is a plain scale plus
 * translate with no flip. `zoom` is pixels per metre, which makes it the single
 * number every LOD decision keys off.
 */

import type { Bbox } from '../core/geom/polyline';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 24;

export class Camera {
  /** World coordinates at the centre of the viewport. */
  x = 0;
  y = 0;
  /** Pixels per metre. */
  zoom = 1;
  /** Viewport size in CSS pixels. */
  width = 800;
  height = 600;
  devicePixelRatio = 1;

  clone(): Camera {
    const c = new Camera();
    c.x = this.x;
    c.y = this.y;
    c.zoom = this.zoom;
    c.width = this.width;
    c.height = this.height;
    c.devicePixelRatio = this.devicePixelRatio;
    return c;
  }

  worldToScreenX(x: number): number {
    return (x - this.x) * this.zoom + this.width / 2;
  }

  worldToScreenY(y: number): number {
    return (y - this.y) * this.zoom + this.height / 2;
  }

  screenToWorldX(px: number): number {
    return (px - this.width / 2) / this.zoom + this.x;
  }

  screenToWorldY(py: number): number {
    return (py - this.height / 2) / this.zoom + this.y;
  }

  /**
   * Sets the canvas transform so drawing can happen in world units.
   *
   * The translation is snapped to whole device pixels. Half a pixel of pan is not
   * something anybody can see, and the snapping is what lets a cached bitmap of the
   * static picture be blitted at an integer offset — unsnapped, every pan frame
   * would resample the whole thing and the map would go soft as it moved.
   */
  applyTo(ctx: CanvasRenderingContext2D): void {
    const s = this.zoom * this.devicePixelRatio;
    ctx.setTransform(s, 0, 0, s, this.originX(), this.originY());
  }

  /** Device-pixel position of world (0, 0), snapped. */
  originX(): number {
    return Math.round((this.width / 2 - this.x * this.zoom) * this.devicePixelRatio);
  }

  originY(): number {
    return Math.round((this.height / 2 - this.y * this.zoom) * this.devicePixelRatio);
  }

  /** World-space rectangle currently visible, optionally padded in metres. */
  visibleRect(pad = 0, out: Bbox = { minX: 0, minY: 0, maxX: 0, maxY: 0 }): Bbox {
    const halfW = this.width / (2 * this.zoom) + pad;
    const halfH = this.height / (2 * this.zoom) + pad;
    out.minX = this.x - halfW;
    out.maxX = this.x + halfW;
    out.minY = this.y - halfH;
    out.maxY = this.y + halfH;
    return out;
  }

  /** Metres per pixel — the natural unit for hit-test tolerances. */
  get scale(): number {
    return 1 / this.zoom;
  }

  panByPixels(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Zooms about a fixed screen point, so the world under the cursor stays put. */
  zoomAt(px: number, py: number, factor: number): void {
    const wx = this.screenToWorldX(px);
    const wy = this.screenToWorldY(py);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.x = wx - (px - this.width / 2) / this.zoom;
    this.y = wy - (py - this.height / 2) / this.zoom;
  }

  fit(bounds: Bbox, padding = 60): void {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const zx = (this.width - padding * 2) / w;
    const zy = (this.height - padding * 2) / h;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zx, zy)));
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
  }
}
