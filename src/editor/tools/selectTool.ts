/**
 * Select and move.
 *
 * Click a road to select it, drag a control point or its handles to reshape,
 * drag the body to move the whole road, or drag empty space for a box select.
 * Every drag records one coalesced command, so one drag is one undo step.
 */

import { cloneControlPoint } from '../../core/network/model';
import type { ControlPoint } from '../../core/network/types';
import { removeStrokes, reshapeStroke, setPointGrade, setStrokeGrade } from '../commands';
import { pickStroke, snap } from '../snapping';
import { addControlPointAt, addPlacement, insertControlPoint, removeControlPoint } from '../curveEdit';
import type { PointerInfo, Tool, ToolEnv } from '../tool';
import type { Camera } from '../../render/camera';
import type { Theme } from '../../render/theme';
import { lineWidth } from '../../render/networkPaths';
import { levelName, stepGrade } from '../grade';

type Grab =
  | { kind: 'none' }
  | { kind: 'point' | 'handleIn' | 'handleOut'; strokeId: number; index: number; before: ControlPoint[] }
  | { kind: 'body'; strokeIds: number[]; before: Map<number, ControlPoint[]>; originX: number; originY: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number };

type HandleHit = { strokeId: number; index: number; part: 'point' | 'in' | 'out' } | null;

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly name = 'Select';
  readonly hint =
    'Click to select, drag points or handles to reshape. Alt-click adds a point — on the road to '
    + 'get another handle, off it to take the road there. Alt-click a point to remove it. ' +
    'Delete removes the road; Tab raises the level and Shift+Tab lowers it, for the road or for '
    + 'one point under the cursor.';
  readonly cursor = 'default';

  private grab: Grab = { kind: 'none' };
  private hover: HandleHit = null;

  /** Nearest control point or handle of a selected stroke. */
  private hitHandle(p: PointerInfo, env: ToolEnv): HandleHit {
    const r = env.scale * 7;
    for (const strokeId of env.store.selection) {
      const stroke = env.store.model.strokes.find((s) => s.id === strokeId);
      if (!stroke) continue;
      for (let i = 0; i < stroke.points.length; i++) {
        const cp = stroke.points[i];
        if (Math.hypot(cp.x - p.worldX, cp.y - p.worldY) <= r) return { strokeId, index: i, part: 'point' };
        if (Math.hypot(cp.hix - p.worldX, cp.hiy - p.worldY) <= r) return { strokeId, index: i, part: 'in' };
        if (Math.hypot(cp.hox - p.worldX, cp.hoy - p.worldY) <= r) return { strokeId, index: i, part: 'out' };
      }
    }
    return null;
  }

  pointerDown(p: PointerInfo, env: ToolEnv): void {
    if (p.button !== 0) return;
    const store = env.store;
    const handle = this.hitHandle(p, env);

    // Alt-click edits the point list rather than dragging it.
    if (p.alt) {
      if (handle?.part === 'point') {
        const stroke = store.model.strokes.find((s) => s.id === handle.strokeId);
        const next = stroke ? removeControlPoint(stroke.points, handle.index) : null;
        if (stroke && next) {
          store.run(reshapeStroke(stroke.id, stroke.points, next, 'Remove point'));
          env.requestRender();
        }
        return;
      }
      const hit = pickStroke(store.geometry, p.worldX, p.worldY, env.scale * 6, env.activeGrade);
      const stroke = hit ? store.model.strokes.find((s) => s.id === hit.strokeId) : undefined;
      const next = stroke
        ? insertControlPoint(stroke.points, p.worldX, p.worldY, env.scale * 12)
        : null;
      if (stroke && next) {
        store.run(reshapeStroke(stroke.id, stroke.points, next, 'Add point'));
        store.selection.clear();
        store.selection.add(stroke.id);
        env.requestRender();
        return;
      }
      // Off the road: add a point where the click actually is, which means the road
      // has to move to reach it — carrying on past an end, or bending through it.
      // Only ever the selected road: a click in open space is otherwise a guess at
      // which of the roads around it was meant, and a wrong guess reshapes one you
      // were not even looking at.
      if (stroke) return;
      const only = store.selection.size === 1 ? [...store.selection][0] : -1;
      const chosen = store.model.strokes.find((s) => s.id === only);
      if (!chosen) {
        env.setStatus('Select one road first, then Alt-click to add a point to it.');
        return;
      }
      const grown = addControlPointAt(chosen.points, p.worldX, p.worldY);
      if (!grown) return;
      const where = addPlacement(chosen.points, p.worldX, p.worldY);
      store.run(reshapeStroke(chosen.id, chosen.points, grown, 'Add point'));
      env.setStatus(where?.kind === 'extend' ? 'Road extended.' : 'Point added; the road now bends through it.');
      env.requestRender();
      return;
    }

    if (handle) {
      const stroke = store.model.strokes.find((s) => s.id === handle.strokeId);
      if (!stroke) return;
      const before = stroke.points.map(cloneControlPoint);
      const kind = handle.part === 'point' ? 'point' : handle.part === 'in' ? 'handleIn' : 'handleOut';
      this.grab = { kind, strokeId: handle.strokeId, index: handle.index, before };
      return;
    }

    const hit = pickStroke(store.geometry, p.worldX, p.worldY, env.scale * 6, env.activeGrade);
    if (!hit) {
      if (!p.shift) store.selection.clear();
      this.grab = { kind: 'box', x0: p.worldX, y0: p.worldY, x1: p.worldX, y1: p.worldY };
      store.emit();
      env.requestRender();
      return;
    }

    if (p.shift) {
      if (store.selection.has(hit.strokeId)) store.selection.delete(hit.strokeId);
      else store.selection.add(hit.strokeId);
    } else if (!store.selection.has(hit.strokeId)) {
      store.selection.clear();
      store.selection.add(hit.strokeId);
    }

    const before = new Map<number, ControlPoint[]>();
    for (const id of store.selection) {
      const stroke = store.model.strokes.find((s) => s.id === id);
      if (stroke) before.set(id, stroke.points.map(cloneControlPoint));
    }
    this.grab = {
      kind: 'body', strokeIds: [...store.selection], before,
      originX: p.worldX, originY: p.worldY,
    };
    store.emit();
    env.requestRender();
  }

  pointerMove(p: PointerInfo, env: ToolEnv): void {
    const store = env.store;
    const grab = this.grab;

    if (grab.kind === 'none') {
      const next = this.hitHandle(p, env);
      if (next?.strokeId !== this.hover?.strokeId || next?.index !== this.hover?.index ||
          next?.part !== this.hover?.part) {
        this.hover = next;
        env.requestRender();
      }
      return;
    }

    if (grab.kind === 'box') {
      grab.x1 = p.worldX;
      grab.y1 = p.worldY;
      env.requestRender();
      return;
    }

    if (grab.kind === 'body') {
      const dx = p.worldX - grab.originX;
      const dy = p.worldY - grab.originY;
      for (const id of grab.strokeIds) {
        const stroke = store.model.strokes.find((s) => s.id === id);
        const before = grab.before.get(id);
        if (!stroke || !before) continue;
        stroke.points = before.map((cp) => ({
          x: cp.x + dx, y: cp.y + dy,
          hix: cp.hix + dx, hiy: cp.hiy + dy,
          hox: cp.hox + dx, hoy: cp.hoy + dy,
          grade: cp.grade,
        }));
      }
      store.invalidate();
      env.requestRender();
      return;
    }

    const stroke = store.model.strokes.find((s) => s.id === grab.strokeId);
    if (!stroke) return;
    const cp = stroke.points[grab.index];
    if (grab.kind === 'point') {
      const hit = snap(store.geometry, p.worldX, p.worldY, {
        tolerance: env.scale * 12,
        level: Math.round(cp.grade),
        exclude: new Set([stroke.id]),
        edges: true,
      });
      const dx = hit.x - cp.x;
      const dy = hit.y - cp.y;
      cp.x += dx; cp.y += dy;
      cp.hix += dx; cp.hiy += dy;
      cp.hox += dx; cp.hoy += dy;
    } else if (grab.kind === 'handleOut') {
      cp.hox = p.worldX;
      cp.hoy = p.worldY;
      // Alt breaks the handles apart; otherwise they stay mirrored for a smooth curve.
      if (!p.alt) {
        cp.hix = cp.x - (p.worldX - cp.x);
        cp.hiy = cp.y - (p.worldY - cp.y);
      }
    } else {
      cp.hix = p.worldX;
      cp.hiy = p.worldY;
      if (!p.alt) {
        cp.hox = cp.x - (p.worldX - cp.x);
        cp.hoy = cp.y - (p.worldY - cp.y);
      }
    }
    store.invalidate();
    env.requestRender();
  }

  pointerUp(_p: PointerInfo, env: ToolEnv): void {
    const store = env.store;
    const grab = this.grab;
    this.grab = { kind: 'none' };

    if (grab.kind === 'box') {
      const minX = Math.min(grab.x0, grab.x1);
      const maxX = Math.max(grab.x0, grab.x1);
      const minY = Math.min(grab.y0, grab.y1);
      const maxY = Math.max(grab.y0, grab.y1);
      if (maxX - minX > env.scale * 3 || maxY - minY > env.scale * 3) {
        for (const [id, geom] of store.geometry) {
          for (let i = 0; i < geom.points.length; i += 2) {
            const x = geom.points[i];
            const y = geom.points[i + 1];
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              store.selection.add(id);
              break;
            }
          }
        }
      }
      store.emit();
      env.requestRender();
      return;
    }

    if (grab.kind === 'body') {
      store.transaction('Move road', () => {
        for (const id of grab.strokeIds) {
          const stroke = store.model.strokes.find((s) => s.id === id);
          const before = grab.before.get(id);
          if (!stroke || !before) continue;
          if (before.every((cp, i) => cp.x === stroke.points[i].x && cp.y === stroke.points[i].y)) continue;
          store.undo.record(reshapeStroke(id, before, stroke.points, 'Move road'));
        }
      });
      env.requestRender();
      return;
    }

    if (grab.kind !== 'none') {
      const stroke = store.model.strokes.find((s) => s.id === grab.strokeId);
      if (stroke) store.undo.record(reshapeStroke(grab.strokeId, grab.before, stroke.points, 'Reshape road'));
      env.requestRender();
    }
  }

  key(event: KeyboardEvent, env: ToolEnv): boolean {
    const store = env.store;
    if (!store.selection.size) return false;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      store.run(removeStrokes([...store.selection]));
      store.selection.clear();
      env.requestRender();
      return true;
    }
    if (event.key === 'Tab') {
      // Up a level, or down with Shift, rather than a three-state cycle: a bridge
      // over a bridge is level 2, and a cycle has nowhere to put it.
      const dir = event.shiftKey ? -1 : 1;
      // Over a control point, Tab moves that point: leave its neighbours where they
      // are and the road ramps between them. Otherwise it moves the whole road.
      const at = this.hover?.part === 'point' ? this.hover : null;
      if (at) {
        const stroke = store.model.strokes.find((s) => s.id === at.strokeId);
        const point = stroke?.points[at.index];
        if (point) {
          const next = stepGrade(point.grade, dir);
          store.run(setPointGrade(at.strokeId, at.index, next));
          env.setStatus(levelName(next));
          env.requestRender();
          return true;
        }
      }
      const first = store.model.strokes.find((s) => store.selection.has(s.id));
      const grade = first ? stepGrade(first.points[0]?.grade ?? 0, dir) : 0;
      store.run(setStrokeGrade([...store.selection], grade));
      env.setStatus(levelName(grade));
      env.requestRender();
      return true;
    }
    if (event.key === 'Escape') {
      store.selection.clear();
      store.emit();
      env.requestRender();
      return true;
    }
    return false;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv): void {
    const store = env.store;
    ctx.setLineDash([]);

    for (const id of store.selection) {
      const geom = store.geometry.get(id);
      if (!geom) continue;
      ctx.strokeStyle = theme.selection;
      ctx.lineWidth = lineWidth(geom.halfWidth * 2 + 0.6, camera.zoom);
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(geom.points[0], geom.points[1]);
      for (let i = 2; i < geom.points.length; i += 2) ctx.lineTo(geom.points[i], geom.points[i + 1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const r = Math.max(0.6, 4 / camera.zoom);
    for (const id of store.selection) {
      const stroke = store.model.strokes.find((s) => s.id === id);
      if (!stroke) continue;
      ctx.strokeStyle = theme.handleLine;
      ctx.lineWidth = lineWidth(0.15, camera.zoom);
      ctx.beginPath();
      for (const cp of stroke.points) {
        ctx.moveTo(cp.hix, cp.hiy);
        ctx.lineTo(cp.x, cp.y);
        ctx.lineTo(cp.hox, cp.hoy);
      }
      ctx.stroke();
      for (const cp of stroke.points) {
        ctx.fillStyle = theme.handle;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.preview;
        ctx.beginPath();
        ctx.arc(cp.hix, cp.hiy, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cp.hox, cp.hoy, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.grab.kind === 'box') {
      ctx.strokeStyle = theme.selection;
      ctx.lineWidth = lineWidth(0, camera.zoom);
      ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
      ctx.strokeRect(
        Math.min(this.grab.x0, this.grab.x1), Math.min(this.grab.y0, this.grab.y1),
        Math.abs(this.grab.x1 - this.grab.x0), Math.abs(this.grab.y1 - this.grab.y0),
      );
      ctx.setLineDash([]);
    }
  }
}
