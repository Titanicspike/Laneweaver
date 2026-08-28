/**
 * Browser stubs that jsdom does not provide: a 2D canvas context, `Path2D`, and
 * the animation-frame and file APIs the app touches. With these in place the whole
 * application — panels, event wiring, main loop — runs under Node, which is as
 * close to "I opened it in a browser" as a test can get.
 */

import { StubContext, StubPath2D } from './canvasStub';

export interface DomHarness {
  mount: HTMLElement;
  /** Runs the pending animation frames. */
  frame(times?: number): void;
  restore(): void;
}

export function installDom(): DomHarness {
  const g = globalThis as unknown as Record<string, unknown>;
  const before = {
    Path2D: g.Path2D,
    raf: g.requestAnimationFrame,
    caf: g.cancelAnimationFrame,
    dpr: g.devicePixelRatio,
    getContext: HTMLCanvasElement.prototype.getContext,
    rect: HTMLCanvasElement.prototype.getBoundingClientRect,
  };

  g.Path2D = StubPath2D;
  g.devicePixelRatio = 1;

  const contexts = new WeakMap<HTMLCanvasElement, StubContext>();
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new StubContext();
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // A canvas that was given an explicit CSS size reports it. Handing every canvas
  // the viewport size is exactly the kind of over-generous stub that hides the bug
  // it was meant to catch — the map canvas is laid out, but a preview is not.
  HTMLCanvasElement.prototype.getBoundingClientRect = function rect(this: HTMLCanvasElement) {
    const w = parseFloat(this.style.width) || 1200;
    const h = parseFloat(this.style.height) || 800;
    return { width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0,
      toJSON: () => ({}) } as DOMRect;
  };

  // jsdom has no Pointer Events; the app only uses capture, which is a no-op here.
  const el = Element.prototype as unknown as Record<string, unknown>;
  const beforeCapture = { set: el.setPointerCapture, release: el.releasePointerCapture };
  el.setPointerCapture = (): void => {};
  el.releasePointerCapture = (): void => {};

  const pending: FrameRequestCallback[] = [];
  g.requestAnimationFrame = (cb: FrameRequestCallback): number => pending.push(cb);
  g.cancelAnimationFrame = (): void => { pending.length = 0; };

  const mount = document.createElement('div');
  mount.id = 'app';
  document.body.append(mount);

  let now = 0;
  return {
    mount,
    frame(times = 1) {
      for (let i = 0; i < times; i++) {
        const due = pending.splice(0, pending.length);
        now += 16.7;
        for (const cb of due) cb(now);
      }
    },
    restore() {
      g.Path2D = before.Path2D;
      g.requestAnimationFrame = before.raf;
      g.cancelAnimationFrame = before.caf;
      g.devicePixelRatio = before.dpr;
      HTMLCanvasElement.prototype.getContext = before.getContext;
      HTMLCanvasElement.prototype.getBoundingClientRect = before.rect;
      el.setPointerCapture = beforeCapture.set;
      el.releasePointerCapture = beforeCapture.release;
      mount.remove();
    },
  };
}

/** Dispatches a pointer event jsdom can build without the PointerEvent class. */
export function pointer(target: Element, type: string, x: number, y: number, init: Record<string, unknown> = {}): void {
  const event = new MouseEvent(type, {
    clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, ...init,
  }) as MouseEvent & { pointerId: number };
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}
