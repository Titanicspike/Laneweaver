/**
 * Position the traced image.
 *
 * Drag the middle to move it, a corner to scale it about its centre, and the
 * handle above it to rotate. One drag is one undo step.
 */

import { transformUnderlay } from '../commands';
import type { ImageUnderlay } from '../../core/network/types';
import type { PointerInfo, Tool, ToolEnv } from '../tool';
import type { Camera } from '../../render/camera';
import type { Theme } from '../../render/theme';
import { lineWidth } from '../../render/networkPaths';

type Mode = 'none' | 'move' | 'scale' | 'rotate';

/** Corner offsets in the underlay's own frame, as fractions of its size. */
const CORNERS: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

export class UnderlayTool implements Tool {
  readonly id = 'underlay';
  readonly name = 'Underlay';
  readonly hint = 'Drop an image on the canvas, then drag to move, corners to scale, the top handle to rotate.';
  readonly cursor = 'move';

  private mode: Mode = 'none';
  private start: ImageUnderlay | null = null;
  private grabX = 0;
  private grabY = 0;

  /** World point to the underlay's local frame. */
  private toLocal(u: ImageUnderlay, x: number, y: number): { x: number; y: number } {
    const dx = x - u.x;
    const dy = y - u.y;
    const c = Math.cos(-u.rotation);
    const s = Math.sin(-u.rotation);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  private handles(u: ImageUnderlay): { x: number; y: number; kind: Mode; index: number }[] {
    const c = Math.cos(u.rotation);
    const s = Math.sin(u.rotation);
    const place = (lx: number, ly: number) => ({ x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c });
    const out = CORNERS.map((corner, index) => ({
      ...place(corner[0] * u.width, corner[1] * u.height),
      kind: 'scale' as Mode,
      index,
    }));
    out.push({ ...place(0, -u.height / 2 - 24), kind: 'rotate', index: -1 });
    return out;
  }

  pointerDown(p: PointerInfo, env: ToolEnv): void {
    const u = env.store.model.underlay;
    if (!u || p.button !== 0) return;
    this.start = { ...u };
    this.grabX = p.worldX;
    this.grabY = p.worldY;

    const reach = env.scale * 9;
    for (const handle of this.handles(u)) {
      if (Math.hypot(handle.x - p.worldX, handle.y - p.worldY) <= reach) {
        this.mode = handle.kind;
        return;
      }
    }
    const local = this.toLocal(u, p.worldX, p.worldY);
    this.mode = Math.abs(local.x) <= u.width / 2 && Math.abs(local.y) <= u.height / 2 ? 'move' : 'none';
  }

  pointerMove(p: PointerInfo, env: ToolEnv): void {
    const u = env.store.model.underlay;
    if (!u || !this.start || this.mode === 'none') return;

    if (this.mode === 'move') {
      u.x = this.start.x + (p.worldX - this.grabX);
      u.y = this.start.y + (p.worldY - this.grabY);
    } else if (this.mode === 'rotate') {
      const angle = Math.atan2(p.worldY - u.y, p.worldX - u.x) + Math.PI / 2;
      u.rotation = p.shift ? Math.round(angle / (Math.PI / 12)) * (Math.PI / 12) : angle;
    } else {
      const before = this.toLocal(this.start, this.grabX, this.grabY);
      const now = this.toLocal(this.start, p.worldX, p.worldY);
      const fx = Math.abs(before.x) > 1e-3 ? now.x / before.x : 1;
      const fy = Math.abs(before.y) > 1e-3 ? now.y / before.y : 1;
      // Shift keeps the aspect ratio, which is what tracing usually wants.
      const factor = p.shift ? Math.max(0.02, (fx + fy) / 2) : 0;
      u.width = Math.max(5, this.start.width * (p.shift ? factor : Math.max(0.02, fx)));
      u.height = Math.max(5, this.start.height * (p.shift ? factor : Math.max(0.02, fy)));
    }
    env.requestRender();
  }

  pointerUp(_p: PointerInfo, env: ToolEnv): void {
    const u = env.store.model.underlay;
    if (u && this.start && this.mode !== 'none') {
      env.store.undo.record(transformUnderlay(this.start, u));
    }
    this.mode = 'none';
    this.start = null;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv): void {
    const u = env.store.model.underlay;
    if (!u) return;
    ctx.save();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = lineWidth(0.3, camera.zoom);
    ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
    ctx.translate(u.x, u.y);
    ctx.rotate(u.rotation);
    ctx.strokeRect(-u.width / 2, -u.height / 2, u.width, u.height);
    ctx.restore();

    ctx.setLineDash([]);
    ctx.fillStyle = theme.handle;
    const r = Math.max(0.8, 5 / camera.zoom);
    for (const handle of this.handles(u)) {
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, handle.kind === 'rotate' ? r * 0.9 : r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
