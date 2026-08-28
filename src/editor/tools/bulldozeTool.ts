/**
 * Bulldoze: click or drag over roads to remove them.
 */

import { CompositeCommand } from '../../core/util/command';
import { removeStrokes, type DocCommand } from '../commands';
import { pickStroke } from '../snapping';
import type { PointerInfo, Tool, ToolEnv } from '../tool';
import type { Camera } from '../../render/camera';
import type { Theme } from '../../render/theme';
import { lineWidth } from '../../render/networkPaths';

export class BulldozeTool implements Tool {
  readonly id = 'bulldoze';
  readonly name = 'Bulldoze';
  readonly hint = 'Click a road to remove it, or drag across several.';
  readonly cursor = 'not-allowed';

  private active = false;
  private removed: number[] = [];
  /**
   * Removals are applied as the pointer passes over each road so the user sees
   * them go, and recorded as a single command on release - one drag, one undo.
   */
  private pending: DocCommand[] = [];
  private hover = -1;

  private removeAt(p: PointerInfo, env: ToolEnv): void {
    const hit = pickStroke(env.store.geometry, p.worldX, p.worldY, env.scale * 4, env.activeGrade);
    if (!hit || this.removed.includes(hit.strokeId)) return;
    this.removed.push(hit.strokeId);
    const command = removeStrokes([hit.strokeId]);
    command.apply(env.store.model);
    this.pending.push(command);
    env.store.invalidate();
    env.requestRender();
  }

  pointerDown(p: PointerInfo, env: ToolEnv): void {
    if (p.button !== 0) return;
    this.active = true;
    this.removed = [];
    this.pending = [];
    this.removeAt(p, env);
  }

  pointerMove(p: PointerInfo, env: ToolEnv): void {
    if (this.active) {
      this.removeAt(p, env);
      return;
    }
    const hit = pickStroke(env.store.geometry, p.worldX, p.worldY, env.scale * 4, env.activeGrade);
    const next = hit ? hit.strokeId : -1;
    if (next !== this.hover) {
      this.hover = next;
      env.requestRender();
    }
  }

  pointerUp(_p: PointerInfo, env: ToolEnv): void {
    this.active = false;
    if (this.pending.length === 1) {
      env.store.undo.record(this.pending[0]);
    } else if (this.pending.length > 1) {
      env.store.undo.record(new CompositeCommand(`Bulldoze ${this.pending.length} roads`, this.pending));
    }
    if (this.removed.length) env.setStatus(`Removed ${this.removed.length} road${this.removed.length > 1 ? 's' : ''}.`);
    this.pending = [];
    this.removed = [];
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv): void {
    if (this.hover < 0) return;
    const geom = env.store.geometry.get(this.hover);
    if (!geom) return;
    ctx.strokeStyle = theme.previewBad;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = lineWidth(geom.halfWidth * 2, camera.zoom);
    ctx.beginPath();
    ctx.moveTo(geom.points[0], geom.points[1]);
    for (let i = 2; i < geom.points.length; i += 2) ctx.lineTo(geom.points[i], geom.points[i + 1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
