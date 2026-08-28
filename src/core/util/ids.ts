/**
 * Identifiers.
 *
 * Edit-model ids come from a monotonically increasing counter that is part of the
 * persisted document, so a load/save round-trip never re-issues a live id.
 * Compiled-network ids are dense array indices assigned by the compiler; they are
 * derived data and change on every recompile.
 */

export type Id = number;

export class IdGen {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  issue(): Id {
    return this.next++;
  }

  /** Called after loading a document so future ids never collide with loaded ones. */
  observe(id: Id): void {
    if (id >= this.next) this.next = id + 1;
  }

  peek(): number {
    return this.next;
  }

  reset(start = 1): void {
    this.next = start;
  }
}
