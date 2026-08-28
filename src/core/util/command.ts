/**
 * Command pattern + undo stack.
 *
 * Every mutation of the edit model goes through a `Command` so undo/redo works
 * from milestone 1. Commands are applied against a context (the document); they
 * must be exactly reversible — `undo` restores the state `do` was called on.
 */

export interface Command<Ctx> {
  /** Short human label, shown in the UI ("Draw road", "Move handle"). */
  readonly label: string;
  apply(ctx: Ctx): void;
  revert(ctx: Ctx): void;
  /**
   * Optional merge with the immediately-preceding command, so a drag becomes one
   * undo step. Return `true` if `this` was absorbed into `prev`.
   */
  coalesce?(prev: Command<Ctx>): boolean;
}

export class CompositeCommand<Ctx> implements Command<Ctx> {
  constructor(
    readonly label: string,
    readonly children: ReadonlyArray<Command<Ctx>>,
  ) {}

  apply(ctx: Ctx): void {
    for (let i = 0; i < this.children.length; i++) this.children[i].apply(ctx);
  }

  revert(ctx: Ctx): void {
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i].revert(ctx);
  }
}

export type UndoListener = () => void;

export class UndoStack<Ctx> {
  private readonly done: Command<Ctx>[] = [];
  private readonly undone: Command<Ctx>[] = [];
  private readonly listeners = new Set<UndoListener>();
  private group: { label: string; cmds: Command<Ctx>[] } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly limit = 500,
  ) {}

  /** Number of undoable steps recorded. */
  get depth(): number {
    return this.done.length;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoLabel(): string | null {
    return this.done.length ? this.done[this.done.length - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.undone.length ? this.undone[this.undone.length - 1].label : null;
  }

  /** Applies `cmd` and records it. */
  run(cmd: Command<Ctx>): void {
    cmd.apply(this.ctx);
    this.record(cmd);
  }

  /** Records an already-applied command (for interactions that apply as they drag). */
  record(cmd: Command<Ctx>): void {
    if (this.group) {
      this.group.cmds.push(cmd);
      return;
    }
    this.undone.length = 0;
    const prev = this.done[this.done.length - 1];
    if (prev && cmd.coalesce && cmd.coalesce(prev)) {
      this.emit();
      return;
    }
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.emit();
  }

  /** Groups every command recorded inside `fn` into a single undo step. */
  transaction<T>(label: string, fn: () => T): T {
    if (this.group) return fn(); // nested groups fold into the outer one
    this.group = { label, cmds: [] };
    let result: T;
    try {
      result = fn();
    } catch (err) {
      const partial = this.group.cmds;
      this.group = null;
      for (let i = partial.length - 1; i >= 0; i--) partial[i].revert(this.ctx);
      throw err;
    }
    const { cmds } = this.group;
    this.group = null;
    if (cmds.length === 1) this.record(cmds[0]);
    else if (cmds.length > 1) this.record(new CompositeCommand(label, cmds));
    return result;
  }

  undo(): boolean {
    const cmd = this.done.pop();
    if (!cmd) return false;
    cmd.revert(this.ctx);
    this.undone.push(cmd);
    this.emit();
    return true;
  }

  redo(): boolean {
    const cmd = this.undone.pop();
    if (!cmd) return false;
    cmd.apply(this.ctx);
    this.done.push(cmd);
    this.emit();
    return true;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.emit();
  }

  onChange(fn: UndoListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Builds a one-off command from closures; handy for small editor mutations. */
export function command<Ctx>(
  label: string,
  apply: (ctx: Ctx) => void,
  revert: (ctx: Ctx) => void,
): Command<Ctx> {
  return { label, apply, revert };
}
