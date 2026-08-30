/**
 * Draw road.
 *
 * Click to place control points, drag while placing to pull a bezier handle, and
 * leave a point alone to have it auto-smoothed against its neighbours. Ends snap
 * to other stroke endpoints (with tangent continuity) and to road edges, which is
 * how a ramp gets drawn: run a road out and drop its end on a freeway's edge.
 */

import { autoSmoothHandles, cloneControlPoint, issueId, makeControlPoint } from '../../core/network/model';
import type { ControlPoint, Stroke } from '../../core/network/types';
import { addStroke } from '../commands';
import { snap, type SnapResult } from '../snapping';
import type { PointerInfo, Tool, ToolEnv } from '../tool';
import type { Camera } from '../../render/camera';
import type { Theme } from '../../render/theme';
import { lineWidth } from '../../render/networkPaths';
import { canBuildAt } from '../../core/terrain/constraints';
import { levelName, stepGrade } from '../grade';

const DRAG_PIXELS = 4;

export class DrawTool implements Tool {
  readonly id = 'draw';
  readonly name = 'Draw road';
  readonly hint = 'Click to place points, drag to curve. Enter finishes, Esc cancels. '
    + 'Tab raises the level, Shift+Tab lowers it — press it twice for a bridge over a bridge.';
  readonly cursor = 'crosshair';

  private points: ControlPoint[] = [];
  /** Points the user did not shape by hand, which get auto-smoothed. */
  private auto: boolean[] = [];
  private dragging = false;
  private dragStart = { x: 0, y: 0 };
  private preview: SnapResult | null = null;
  private previewOk = true;

  deactivate(): void {
    this.reset();
  }

  private reset(): void {
    this.points = [];
    this.auto = [];
    this.dragging = false;
    this.preview = null;
  }

  private snapAt(p: PointerInfo, env: ToolEnv): SnapResult {
    const last = this.points[this.points.length - 1];
    return snap(env.store.geometry, p.worldX, p.worldY, {
      tolerance: env.scale * 14,
      level: env.activeGrade,
      edges: true,
      angleSnap: p.shift,
      fromX: last?.x,
      fromY: last?.y,
    });
  }

  pointerDown(p: PointerInfo, env: ToolEnv): void {
    if (p.button !== 0) return;
    const hit = this.snapAt(p, env);
    // The level is stamped on the point as it is placed, not on the stroke when it
    // is finished: Tab part way through a road is what makes it climb, and a point
    // placed on the ground has to stay on the ground when the next one is a bridge.
    const point = makeControlPoint(hit.x, hit.y, env.activeGrade);
    // Snapping to an existing end continues its tangent, so the join stays smooth.
    if (hit.kind === 'endpoint' && this.points.length === 0) {
      const reach = 12 * (hit.end === 1 ? 1 : -1);
      point.hox = hit.x + hit.tx * reach;
      point.hoy = hit.y + hit.ty * reach;
      point.hix = hit.x - hit.tx * reach;
      point.hiy = hit.y - hit.ty * reach;
    }
    this.points.push(point);
    this.auto.push(hit.kind !== 'endpoint');
    this.dragging = true;
    this.dragStart = { x: p.screenX, y: p.screenY };
    env.requestRender();
  }

  pointerMove(p: PointerInfo, env: ToolEnv): void {
    this.preview = this.snapAt(p, env);
    this.previewOk = canBuildAt(env.store.terrain, env.activeGrade, this.preview.x, this.preview.y);
    if (this.dragging && this.points.length) {
      const moved = Math.hypot(p.screenX - this.dragStart.x, p.screenY - this.dragStart.y);
      if (moved > DRAG_PIXELS) {
        const point = this.points[this.points.length - 1];
        point.hox = p.worldX;
        point.hoy = p.worldY;
        point.hix = point.x - (p.worldX - point.x);
        point.hiy = point.y - (p.worldY - point.y);
        this.auto[this.auto.length - 1] = false;
      }
    }
    env.requestRender();
  }

  pointerUp(_p: PointerInfo, env: ToolEnv): void {
    this.dragging = false;
    env.setStatus(this.points.length < 2
      ? 'Click again to continue the road.'
      : 'Enter or double-click to finish.');
    env.requestRender();
  }

  key(event: KeyboardEvent, env: ToolEnv): boolean {
    if (event.key === 'Escape') {
      this.reset();
      env.requestRender();
      return true;
    }
    if (event.key === 'Enter') {
      this.finish(env);
      return true;
    }
    if (event.key === 'Tab') {
      // Up a level, or down with Shift. Not a three-state cycle: a bridge over a
      // bridge is a level-2 bridge, and a cycle has nowhere to put it.
      const next = stepGrade(env.activeGrade, event.shiftKey ? -1 : 1);
      env.setActiveGrade(next);
      env.setStatus(levelName(next));
      env.requestRender();
      return true;
    }
    if (event.key === 'Backspace' && this.points.length) {
      this.points.pop();
      this.auto.pop();
      env.requestRender();
      return true;
    }
    return false;
  }

  finish(env: ToolEnv): void {
    if (this.points.length < 2) {
      this.reset();
      env.requestRender();
      return;
    }
    const points = this.points.map(cloneControlPoint);
    // Auto-smooth only the points the user did not shape by hand — through the
    // same function the preview draws with, so the road that lands is the road
    // that was shown.
    const smoothed = this.shaped(points);
    for (let i = 0; i < points.length; i++) {
      if (this.auto[i]) points[i] = smoothed[i];
    }
    const stroke: Stroke = {
      id: issueId(env.store.model),
      profileId: env.activeProfileId,
      points,
    };
    env.store.run(addStroke(stroke));
    this.reset();
    env.setStatus('Road added.');
    env.requestRender();
  }

  /**
   * The points as they will be built: hand-shaped ones as they are, the rest
   * auto-smoothed against their neighbours. With `cursor`, the point under the
   * pointer is included as a provisional last point, which is what makes the
   * preview honest — a point's handles depend on the point *after* it, so the
   * curve through the last placed point cannot be drawn right without knowing
   * where the next one is going.
   *
   * The preview used to draw the raw handles, which for an auto point sit on the
   * point itself: a chain of straight lines and sharp corners, which then turned
   * into a smooth curve the moment the road was finished. Nothing about the placed
   * road matched what had just been on screen.
   */
  private shaped(points: ControlPoint[], cursor?: { x: number; y: number }): ControlPoint[] {
    const out = points.map(cloneControlPoint);
    if (cursor) out.push(makeControlPoint(cursor.x, cursor.y, out[out.length - 1]?.grade ?? 0));
    autoSmoothHandles(out);
    for (let i = 0; i < points.length; i++) {
      if (!this.auto[i]) out[i] = cloneControlPoint(points[i]);
    }
    return out;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme): void {
    const points = this.points;
    if (!points.length && !this.preview) return;
    ctx.lineWidth = lineWidth(0.5, camera.zoom);
    ctx.strokeStyle = this.previewOk ? theme.preview : theme.previewBad;
    ctx.setLineDash([]);

    if (points.length) {
      const shown = this.shaped(points, this.preview ?? undefined);
      ctx.beginPath();
      ctx.moveTo(shown[0].x, shown[0].y);
      for (let i = 1; i < shown.length; i++) {
        const a = shown[i - 1];
        const b = shown[i];
        ctx.bezierCurveTo(a.hox, a.hoy, b.hix, b.hiy, b.x, b.y);
      }
      ctx.stroke();

      ctx.fillStyle = theme.handle;
      const r = Math.max(0.6, 3.5 / camera.zoom);
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.preview && this.preview.kind !== 'none') {
      ctx.strokeStyle = this.preview.kind === 'edge' ? theme.portal : theme.selection;
      ctx.lineWidth = lineWidth(0.3, camera.zoom);
      const r = Math.max(1, 6 / camera.zoom);
      ctx.beginPath();
      ctx.arc(this.preview.x, this.preview.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
