/**
 * Zoning: painting what stands beside a road.
 *
 * Land use started life as a property of the *road type*, on the theory that
 * "residential street" is already a road type and making it a second thing to set
 * per road would mean drawing a town twice. That is true as far as it goes, and it
 * is still how a new road gets its zoning — but it makes the one thing a person
 * actually wants to do impossible: take *this* stretch of street and put shops on
 * it. Changing the road type changes every road that shares it.
 *
 * So zoning is painted, the way a city builder does it, and the road type supplies
 * the default. The third state matters as much as the other two: `none` is how you
 * say "this particular street has nothing along it" without editing the road type
 * everybody else is using.
 *
 * Drag to paint a run of roads. One drag is one undo step, because painting six
 * streets and then wanting five of them back is not a thing anybody means.
 */

import type { PointerInfo, Tool, ToolEnv } from '../tool';
import type { Camera } from '../../render/camera';
import type { Theme } from '../../render/theme';
import type { ZoneChoice } from '../../core/network/types';
import { setStrokeZone } from '../commands';
import { pickStroke } from '../snapping';
import { lineWidth } from '../../render/networkPaths';

const LABEL: Record<ZoneChoice, string> = {
  residential: 'Houses',
  commercial: 'Shops',
  none: 'Nothing',
};

/** How far from a centreline a click still counts, in pixels. */
const REACH_PX = 26;

export class ZoneTool implements Tool {
  readonly id = 'zone';
  readonly name = 'Zone';
  readonly hint = 'Drag along roads to zone them. 1 houses, 2 shops, 3 clear, Tab cycles.';
  readonly cursor = 'crosshair';

  /** What the next click paints. Held across activations, like the draw tool's grade. */
  private choice: ZoneChoice = 'residential';
  private painting = false;
  /**
   * Roads the current drag has swept over.
   *
   * Held rather than applied, because a drag arrives as a stream of pointer events
   * and `transaction` wraps a synchronous call — so the only way to make one drag
   * one undo step is to collect the strokes and commit them together on release.
   * The overlay draws everything in here as though it were already painted, so the
   * road still changes colour under the cursor.
   */
  private readonly pending = new Set<number>();
  private hover = -1;

  setChoice(choice: ZoneChoice): void {
    this.choice = choice;
  }

  get zoneChoice(): ZoneChoice {
    return this.choice;
  }

  activate(env: ToolEnv): void {
    env.setStatus(`Zoning: ${LABEL[this.choice]}. Drag along roads to paint them.`);
  }

  deactivate(env: ToolEnv): void {
    this.finish(env);
    this.hover = -1;
  }

  pointerDown(p: PointerInfo, env: ToolEnv): void {
    if (p.button !== 0) return;
    this.painting = true;
    this.pending.clear();
    this.paintAt(p, env);
  }

  pointerMove(p: PointerInfo, env: ToolEnv): void {
    const hit = pickStroke(env.store.geometry, p.worldX, p.worldY, env.scale * REACH_PX);
    const next = hit ? hit.strokeId : -1;
    if (next !== this.hover) {
      this.hover = next;
      env.requestRender();
    }
    if (this.painting) this.paintAt(p, env);
  }

  pointerUp(_p: PointerInfo, env: ToolEnv): void {
    this.finish(env);
  }

  private finish(env: ToolEnv): void {
    if (!this.painting) return;
    this.painting = false;
    const ids = [...this.pending];
    this.pending.clear();
    if (!ids.length) return;
    const choice = this.choice;
    env.store.transaction(
      ids.length > 1 ? `Zone ${ids.length} roads` : `Zone: ${LABEL[choice]}`,
      () => {
        for (const id of ids) env.store.run(setStrokeZone(id, choice));
      },
    );
    env.setStatus(
      ids.length > 1
        ? `Zoned ${ids.length} roads as ${LABEL[choice].toLowerCase()}.`
        : `Zoned ${LABEL[choice].toLowerCase()}.`,
    );
    env.requestRender();
  }

  private paintAt(p: PointerInfo, env: ToolEnv): void {
    const hit = pickStroke(env.store.geometry, p.worldX, p.worldY, env.scale * REACH_PX);
    if (!hit || this.pending.has(hit.strokeId)) return;
    const stroke = env.store.model.strokes.find((s) => s.id === hit.strokeId);
    if (!stroke) return;
    // Painting a road with the zoning it already has is not an edit. Without this a
    // drag across an already-zoned street costs one undo per road to get back out of.
    if ((stroke.landUse ?? undefined) === this.choice) return;
    this.pending.add(hit.strokeId);
    env.requestRender();
  }

  key(event: KeyboardEvent, env: ToolEnv): boolean {
    const order: ZoneChoice[] = ['residential', 'commercial', 'none'];
    if (event.key === '1') this.choice = 'residential';
    else if (event.key === '2') this.choice = 'commercial';
    else if (event.key === '3') this.choice = 'none';
    else if (event.key === 'Tab') this.choice = order[(order.indexOf(this.choice) + 1) % 3]!;
    else return false;
    event.preventDefault();
    env.setStatus(`Zoning: ${LABEL[this.choice]}.`);
    env.requestRender();
    return true;
  }

  /**
   * Every road's *effective* zoning, drawn along its centreline.
   *
   * Effective, not painted — and the difference is the whole usefulness of the
   * overlay. A road inherits its zoning from its road type unless something has been
   * painted over it, so drawing only the painted ones shows an empty map for a town
   * built entirely out of "residential street", which is the commonest case there
   * is. Somebody switching to this mode to find out what is zoned would be told
   * "nothing", and the honest answer is "all of it".
   *
   * The road under the pointer, and every road the current drag has swept, is drawn
   * as what the click *would* make it, so the preview and the result are the same
   * picture.
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv): void {
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const profiles = new Map(env.store.model.profiles.map((pr) => [pr.id, pr]));
    for (const [strokeId, geom] of env.store.geometry) {
      const stroke = env.store.model.strokes.find((s) => s.id === strokeId);
      if (!stroke) continue;
      const inherited = profiles.get(stroke.profileId)?.landUse;
      const effective: ZoneChoice | undefined = stroke.landUse ?? inherited;
      // A road the drag has swept over is drawn as though it were already zoned:
      // it will be, the moment the button comes up.
      const claimed = this.pending.has(strokeId) || strokeId === this.hover;
      const shown: ZoneChoice | undefined = claimed ? this.choice : effective;
      if (!claimed && (shown === undefined || shown === 'none')) continue;

      ctx.strokeStyle = shown === 'residential' ? theme.zoneHouses
        : shown === 'commercial' ? theme.zoneShops : theme.zoneNone;
      // A painted road reads stronger than one that merely inherits, because the
      // difference is exactly what "have I done anything here" asks.
      const painted = stroke.landUse !== undefined;
      ctx.globalAlpha = claimed ? 0.9 : painted ? 0.5 : 0.3;
      ctx.lineWidth = lineWidth(
        Math.max(2.2, geom.halfWidth * (claimed ? 2.4 : 1.9)), camera.zoom,
      );
      ctx.beginPath();
      const pts = geom.points;
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
