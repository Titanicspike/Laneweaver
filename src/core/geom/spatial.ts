/**
 * Spatial indexing.
 *
 * Everything that needs "what is near here?" — crossing detection, ramp snapping,
 * render culling — goes through an R-tree. Crossing detection in particular is a
 * segment-vs-segment sweep, so the primary index stores individual polyline
 * segments rather than whole strokes.
 */

import RBush from 'rbush';
import type { Bbox } from './polyline';

/** One flattened polyline segment, tagged with where it came from. */
export interface SegmentEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Owner (stroke id, lane id, ...) — interpretation is the caller's. */
  owner: number;
  /** Index of the segment within the owner's polyline. */
  index: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export class SegmentIndex {
  private readonly tree = new RBush<SegmentEntry>();
  private readonly items: SegmentEntry[] = [];

  /** Adds every segment of `poly`, tagged with `owner`. */
  addPolyline(owner: number, poly: ArrayLike<number>, pad = 0): void {
    const n = poly.length >> 1;
    for (let i = 0; i < n - 1; i++) {
      const ax = poly[i * 2];
      const ay = poly[i * 2 + 1];
      const bx = poly[i * 2 + 2];
      const by = poly[i * 2 + 3];
      this.items.push({
        minX: Math.min(ax, bx) - pad,
        minY: Math.min(ay, by) - pad,
        maxX: Math.max(ax, bx) + pad,
        maxY: Math.max(ay, by) + pad,
        owner,
        index: i,
        ax, ay, bx, by,
      });
    }
  }

  /** Bulk-loads everything added so far. Call once, then query. */
  build(): void {
    this.tree.clear();
    if (this.items.length) this.tree.load(this.items);
  }

  search(box: Bbox): SegmentEntry[] {
    return this.tree.search(box);
  }

  searchBox(minX: number, minY: number, maxX: number, maxY: number): SegmentEntry[] {
    return this.tree.search({ minX, minY, maxX, maxY });
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.tree.clear();
  }
}

/** Generic box-keyed index for whole objects (segments, junctions, vehicles-by-cell). */
export interface BoxEntry<T> extends Bbox {
  value: T;
}

export class BoxIndex<T> {
  private readonly tree = new RBush<BoxEntry<T>>();
  private readonly items: BoxEntry<T>[] = [];

  add(box: Bbox, value: T): void {
    this.items.push({ minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, value });
  }

  build(): void {
    this.tree.clear();
    if (this.items.length) this.tree.load(this.items);
  }

  search(box: Bbox, out: T[] = []): T[] {
    out.length = 0;
    const hits = this.tree.search(box);
    for (let i = 0; i < hits.length; i++) out.push(hits[i].value);
    return out;
  }

  searchBox(minX: number, minY: number, maxX: number, maxY: number, out: T[] = []): T[] {
    return this.search({ minX, minY, maxX, maxY }, out);
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.tree.clear();
  }
}
