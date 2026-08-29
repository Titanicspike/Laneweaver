/**
 * A minimal Canvas 2D stub so the renderer can be exercised under Node.
 *
 * It records the calls it receives rather than drawing anything, which is enough
 * to prove the render path runs end to end, that geometry reaches the context, and
 * that no layer throws — the things that would otherwise only fail in a browser.
 */

export interface DrawCall {
  op: string;
  args: unknown[];
  /** The context's style when the call was made; absent on a path's own ops. */
  strokeStyle?: string;
  fillStyle?: string;
  lineWidth?: number;
  globalAlpha?: number;
}

export class StubPath2D {
  readonly ops: DrawCall[] = [];
  moveTo(...args: unknown[]): void { this.ops.push({ op: 'moveTo', args }); }
  lineTo(...args: unknown[]): void { this.ops.push({ op: 'lineTo', args }); }
  closePath(): void { this.ops.push({ op: 'closePath', args: [] }); }
  rect(...args: unknown[]): void { this.ops.push({ op: 'rect', args }); }
  arc(...args: unknown[]): void { this.ops.push({ op: 'arc', args }); }
  bezierCurveTo(...args: unknown[]): void { this.ops.push({ op: 'bezierCurveTo', args }); }
  quadraticCurveTo(...args: unknown[]): void { this.ops.push({ op: 'quadraticCurveTo', args }); }
  get length(): number { return this.ops.length; }
}

export class StubContext {
  readonly calls: DrawCall[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineJoin = '';
  lineCap = '';
  globalAlpha = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  private readonly stack: unknown[] = [];

  private record(op: string, args: unknown[]): void {
    // The style at the moment of the call, not at the end of the frame: a renderer
    // sets `strokeStyle` and then strokes, over and over, and only the pairing says
    // which colour drew which path.
    this.calls.push({
      op, args,
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
    });
  }

  setTransform(...a: unknown[]): void { this.record('setTransform', a); }
  translate(...a: unknown[]): void { this.record('translate', a); }
  rotate(...a: unknown[]): void { this.record('rotate', a); }
  save(): void { this.stack.push(1); this.record('save', []); }
  restore(): void { this.stack.pop(); this.record('restore', []); }
  beginPath(): void { this.record('beginPath', []); }
  moveTo(...a: unknown[]): void { this.record('moveTo', a); }
  lineTo(...a: unknown[]): void { this.record('lineTo', a); }
  arc(...a: unknown[]): void { this.record('arc', a); }
  bezierCurveTo(...a: unknown[]): void { this.record('bezierCurveTo', a); }
  quadraticCurveTo(...a: unknown[]): void { this.record('quadraticCurveTo', a); }
  closePath(): void { this.record('closePath', []); }
  fill(...a: unknown[]): void { this.record('fill', a); }
  stroke(...a: unknown[]): void { this.record('stroke', a); }
  fillRect(...a: unknown[]): void { this.record('fillRect', a); }
  clearRect(...a: unknown[]): void { this.record('clearRect', a); }
  strokeRect(...a: unknown[]): void { this.record('strokeRect', a); }
  setLineDash(...a: unknown[]): void { this.record('setLineDash', a); }
  rect(...a: unknown[]): void { this.record('rect', a); }
  clip(...a: unknown[]): void { this.record('clip', a); }
  scale(...a: unknown[]): void { this.record('scale', a); }
  fillText(...a: unknown[]): void { this.record('fillText', a); }
  strokeText(...a: unknown[]): void { this.record('strokeText', a); }
  // Real canvases measure; returning a plausible width keeps the layout path honest.
  measureText(text: string): { width: number } {
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10');
    return { width: text.length * size * 0.6 };
  }

  get balanced(): boolean { return this.stack.length === 0; }
  count(op: string): number { return this.calls.filter((c) => c.op === op).length; }
}

export class StubCanvas {
  width = 1200;
  height = 800;
  style: Record<string, string> = {};
  readonly context = new StubContext();
  getContext(): StubContext { return this.context; }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 1200, height: 800, left: 0, top: 0 };
  }
  addEventListener(): void { /* no input in tests */ }
  setPointerCapture(): void { /* no input in tests */ }
}

/** Installs the browser globals the renderer needs. Returns a restore function. */
export function installCanvasGlobals(): () => void {
  const g = globalThis as Record<string, unknown>;
  const before = { Path2D: g.Path2D, devicePixelRatio: g.devicePixelRatio };
  g.Path2D = StubPath2D;
  g.devicePixelRatio = 1;
  return () => {
    g.Path2D = before.Path2D;
    g.devicePixelRatio = before.devicePixelRatio;
  };
}
