import { Camera } from '@render/camera';
import { AppStore } from '@app/store';
import type { PointerInfo, Tool, ToolEnv } from '@editor/tool';
import type { EditModel } from '@core/network/types';

export interface Harness {
  store: AppStore;
  env: ToolEnv;
  camera: Camera;
  status: string[];
  /** Drives a full click (or drag) through a tool. */
  click(tool: Tool, x: number, y: number, opts?: Partial<PointerInfo>): void;
  drag(tool: Tool, from: [number, number], to: [number, number], opts?: Partial<PointerInfo>): void;
  /** A drag that visits every point in turn, for tools that paint along a path. */
  paint(tool: Tool, points: [number, number][], opts?: Partial<PointerInfo>): void;
  move(tool: Tool, x: number, y: number, opts?: Partial<PointerInfo>): void;
  key(tool: Tool, key: string): boolean;
  /** Applies pending edits so the network and geometry are up to date. */
  settle(): void;
}

export function harness(model?: EditModel): Harness {
  const store = new AppStore(model);
  const camera = new Camera();
  camera.width = 1200;
  camera.height = 800;
  camera.zoom = 1;
  const status: string[] = [];

  const env: ToolEnv = {
    store,
    camera,
    scale: 1,
    activeProfileId: store.model.profiles[0].id,
    activeGrade: 0,
    setActiveGrade(grade) { (env as { activeGrade: number }).activeGrade = grade; },
    setStatus(text) { status.push(text); },
    requestRender() { /* no canvas in tests */ },
  };

  const info = (x: number, y: number, opts: Partial<PointerInfo> = {}): PointerInfo => ({
    worldX: x, worldY: y,
    screenX: camera.worldToScreenX(x), screenY: camera.worldToScreenY(y),
    button: 0, shift: false, alt: false, ctrl: false,
    ...opts,
  });

  const settle = (): void => {
    store.invalidate();
    store.flush();
  };

  return {
    store, env, camera, status, settle,
    move(tool, x, y, opts) { tool.pointerMove?.(info(x, y, opts), env); },
    click(tool, x, y, opts) {
      tool.pointerMove?.(info(x, y, opts), env);
      store.beginEdit();
      tool.pointerDown?.(info(x, y, opts), env);
      tool.pointerUp?.(info(x, y, opts), env);
      store.endEdit();
    },
    drag(tool, from, to, opts) {
      tool.pointerMove?.(info(from[0], from[1], opts), env);
      store.beginEdit();
      tool.pointerDown?.(info(from[0], from[1], opts), env);
      tool.pointerMove?.(info(to[0], to[1], opts), env);
      tool.pointerUp?.(info(to[0], to[1], opts), env);
      store.endEdit();
    },
    paint(tool, points, opts) {
      if (!points.length) return;
      tool.pointerMove?.(info(points[0][0], points[0][1], opts), env);
      store.beginEdit();
      tool.pointerDown?.(info(points[0][0], points[0][1], opts), env);
      for (const [x, y] of points.slice(1)) tool.pointerMove?.(info(x, y, opts), env);
      const last = points[points.length - 1];
      tool.pointerUp?.(info(last[0], last[1], opts), env);
      store.endEdit();
    },
    key(tool, key) {
      const event = { key, preventDefault(): void {} } as KeyboardEvent;
      return tool.key?.(event, env) ?? false;
    },
  };
}
