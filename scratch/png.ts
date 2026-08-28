/**
 * A minimal PNG writer and polygon rasteriser, for looking at compiled geometry
 * without a browser.
 *
 * Dev-only. The real renderer is Canvas 2D and cannot run under Node, but most of
 * the defects this project ships are visual, and "compile it and look at it" is a
 * much shorter loop than a screenshot of a live app. This draws the same polygons
 * and polylines the renderer draws, so a fault in the *geometry* shows up here;
 * a fault in the renderer itself will not.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

export class Raster {
  readonly w: number;
  readonly h: number;
  private px: Uint8Array;
  /** World-to-pixel transform. */
  private sx = 1; private sy = 1; private ox = 0; private oy = 0;

  constructor(w: number, h: number, bg: [number, number, number] = [24, 26, 30]) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2];
    }
  }

  /** Fits world box [x0,y0]-[x1,y1] into the image, y flipped so north is up. */
  fit(x0: number, y0: number, x1: number, y1: number, pad = 12): void {
    const s = Math.min((this.w - pad * 2) / Math.max(1e-6, x1 - x0),
                       (this.h - pad * 2) / Math.max(1e-6, y1 - y0));
    this.sx = s; this.sy = -s;
    this.ox = pad + (this.w - pad * 2 - (x1 - x0) * s) / 2 - x0 * s;
    this.oy = this.h - pad - (this.h - pad * 2 - (y1 - y0) * s) / 2 + y0 * s;
  }
  toPx(x: number, y: number): [number, number] {
    return [x * this.sx + this.ox, y * this.sy + this.oy];
  }
  /** Pixels per world unit. */
  get scale(): number { return this.sx; }

  private blend(x: number, y: number, c: [number, number, number], a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = ((y | 0) * this.w + (x | 0)) * 3;
    const k = Math.min(1, a);
    this.px[i] = this.px[i] * (1 - k) + c[0] * k;
    this.px[i + 1] = this.px[i + 1] * (1 - k) + c[1] * k;
    this.px[i + 2] = this.px[i + 2] * (1 - k) + c[2] * k;
  }

  /** Fills a closed ring given as flat world coordinates, nonzero rule. */
  fillPoly(pts: ArrayLike<number>, c: [number, number, number], alpha = 1): void {
    const n = pts.length >> 1;
    if (n < 3) return;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const [px, py] = this.toPx(pts[i * 2], pts[i * 2 + 1]);
      xs[i] = px; ys[i] = py;
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const hits: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      hits.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ys[i], yj = ys[j];
        if ((yi > cy) !== (yj > cy)) {
          hits.push(xs[j] + ((cy - yj) / (yi - yj)) * (xs[i] - xs[j]));
        }
      }
      hits.sort((a, b) => a - b);
      for (let k = 0; k + 1 < hits.length; k += 2) {
        const a = Math.max(0, Math.ceil(hits[k] - 0.5));
        const b = Math.min(this.w - 1, Math.floor(hits[k + 1] - 0.5));
        for (let x = a; x <= b; x++) this.blend(x, y, c, alpha);
      }
    }
  }

  /** Strokes a polyline of flat world coordinates, width in pixels. */
  stroke(pts: ArrayLike<number>, c: [number, number, number], wpx = 1, alpha = 1): void {
    const n = pts.length >> 1;
    for (let i = 0; i + 1 < n; i++) {
      const [ax, ay] = this.toPx(pts[i * 2], pts[i * 2 + 1]);
      const [bx, by] = this.toPx(pts[i * 2 + 2], pts[i * 2 + 3]);
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      const r = Math.max(0.5, wpx / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
          for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
            const d = Math.hypot(dx, dy);
            if (d <= r + 0.5) this.blend(x + dx, y + dy, c, alpha * Math.min(1, r + 0.5 - d));
          }
        }
      }
    }
  }

  dot(x: number, y: number, c: [number, number, number], r = 2): void {
    const [px, py] = this.toPx(x, y);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.hypot(dx, dy) <= r) this.blend(px + dx, py + dy, c, 1);
    }
  }

  save(path: string): void {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.px.buffer, y * this.w * 3, this.w * 3)
        .copy(raw, y * (this.w * 3 + 1) + 1);
    }
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    writeFileSync(path, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
  }
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
