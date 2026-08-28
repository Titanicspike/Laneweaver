/**
 * Bootstrap and main loop.
 *
 * The loop keeps two clocks: the simulation advances in fixed 0.05 s steps (the
 * only rate the model is defined at), and rendering runs on `requestAnimationFrame`
 * interpolating between the last two ticks. A recompile happens at most once per
 * frame, so dragging a road does not pay for a rebuild per pointer event.
 */

import './style.css';
import { Renderer } from '../render/renderer';
import { NetworkPaths } from '../render/networkPaths';
import { drawDragPreview } from '../render/dragPreview';
import { invalidateTerrainCache } from '../render/terrainLayer';
import { AppStore } from './store';
import { Ui, type AppApi } from './ui';
import { createDemoDocument } from './demo';
import { exampleById } from './examples';
import { DrawTool } from '../editor/tools/drawTool';
import { SelectTool } from '../editor/tools/selectTool';
import { BulldozeTool } from '../editor/tools/bulldozeTool';
import { InspectTool } from '../editor/tools/inspectTool';
import { UnderlayTool } from '../editor/tools/underlayTool';
import { ZoneTool } from '../editor/tools/zoneTool';
import type { PointerInfo, Tool, ToolEnv } from '../editor/tool';
import { cloneProfile, createDocument, issueId } from '../core/network/model';
import type { RoadProfile } from '../core/network/types';
import {
  addProfile as addProfileCommand, removeProfile, replaceDocument, setStrokeProfile,
  setUnderlay, updateGeo, updateProfile, updateSettings, updateTerrain,
} from '../editor/commands';
import { clearImageCache } from '../render/underlayLayer';
import type { GeoSettings, ImageUnderlay, SpawnMode, ZoneChoice } from '../core/network/types';
import { deserialize, serialize } from '../core/util/serialization';


const TOOL_KEYS: Record<string, string> = {
  v: 'select', r: 'draw', x: 'bulldoze', z: 'zone', j: 'inspect', u: 'underlay',
};

export class App implements AppApi {
  readonly store: AppStore;
  readonly tools: Tool[] = [
    new SelectTool(), new DrawTool(), new BulldozeTool(), new ZoneTool(), new InspectTool(),
    new UnderlayTool(),
  ];
  activeToolId = 'draw';
  activeProfileId: number;
  activeGrade = 0;
  showGrid = true;
  showDiagnostics = true;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly ui: Ui;
  private paths: NetworkPaths;
  /** The compile version `paths` was baked from; -1 until the first bake. */
  private pathsVersion = -1;
  private lastFrame = 0;
  private simCarry = 0;
  private needsRender = true;
  private panning = false;
  private panPointer = -1;
  private lastPointer = { x: 0, y: 0 };
  private frameMs = 0;

  constructor(mount: HTMLElement) {
    this.store = new AppStore(createDemoDocument());
    this.activeProfileId = this.store.model.profiles[0].id;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'viewport';
    mount.append(this.canvas);

    this.renderer = new Renderer(this.canvas);
    this.renderer.setSignalLookup((id) => this.store.sim.signals.stateOf(id) as number);
    this.paths = new NetworkPaths(this.store.network);
    this.ui = new Ui(this, mount);

    this.store.onChange(() => {
      this.ui.refresh();
      this.needsRender = true;
    });

    this.bindInput();
    this.fitView();
    this.setTool('draw');
    this.setProfile(this.store.model.profiles.find((p) => p.name.startsWith('Freeway'))?.id ?? this.activeProfileId);
    this.ui.setStatus('Press R to draw, V to select, Space to run the traffic.');
    requestAnimationFrame(this.frame);
  }

  // --- api used by the UI --------------------------------------------------

  setTool(id: string): void {
    const current = this.tools.find((t) => t.id === this.activeToolId);
    const env = this.env();
    current?.deactivate?.(env);
    this.activeToolId = id;
    const next = this.tools.find((t) => t.id === id);
    next?.activate?.(env);
    this.canvas.style.cursor = next?.cursor ?? 'default';
    this.ui.setStatus(next?.hint ?? '');
    this.ui.refresh();
    this.needsRender = true;
  }

  setProfile(id: number): void {
    this.activeProfileId = id;
    // Picking a road type with roads selected reassigns them, which is what you
    // almost always mean by clicking a type while something is highlighted.
    if (this.store.selection.size) {
      this.store.run(setStrokeProfile([...this.store.selection], id));
      this.ui.setStatus(`Changed ${this.store.selection.size} road(s) to this type.`);
    }
    this.ui.refresh();
  }

  /** What the zone tool paints next. Lives on the app so the panel can show it. */
  get zoneChoice(): ZoneChoice {
    const tool = this.tools.find((t) => t.id === 'zone') as ZoneTool | undefined;
    return tool?.zoneChoice ?? 'residential';
  }

  setZoneChoice(choice: ZoneChoice): void {
    const tool = this.tools.find((t) => t.id === 'zone') as ZoneTool | undefined;
    tool?.setChoice(choice);
    if (this.activeToolId !== 'zone') this.setTool('zone');
    this.ui.refresh();
    this.needsRender = true;
  }

  setGrade(grade: number): void {
    this.activeGrade = grade;
    this.ui.refresh();
    this.needsRender = true;
  }

  newDocument(): void {
    this.store.run(replaceDocument(createDocument()));
    this.store.selection.clear();
    this.afterDocumentSwap();
  }

  loadDemo(): void {
    this.store.run(replaceDocument(createDemoDocument()));
    this.store.selection.clear();
    this.afterDocumentSwap();
  }

  /**
   * Swaps in one of the shipped example maps. It goes through `replaceDocument`
   * like every other document swap, so it is a single undo step rather than a
   * trapdoor out of the edit history.
   */
  loadExample(id: string): void {
    const example = exampleById(id);
    if (!example) return;
    this.store.run(replaceDocument(example.build()));
    this.store.selection.clear();
    this.afterDocumentSwap();
    this.ui.setStatus(`${example.name} — ${example.about}.`);
  }

  private afterDocumentSwap(): void {
    this.activeProfileId = this.store.model.profiles[0].id;
    this.store.rebuildTerrain();
    this.store.invalidate();
    this.store.flush();
    this.fitView();
    this.ui.refresh();
  }

  save(): void {
    const blob = new Blob([serialize(this.store.model)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'laneweaver.json';
    link.click();
    URL.revokeObjectURL(url);
    this.ui.setStatus('Saved.');
  }

  load(file: File): void {
    void file.text().then((text) => {
      try {
        this.store.run(replaceDocument(deserialize(text)));
        this.store.selection.clear();
        this.afterDocumentSwap();
        this.ui.setStatus(`Loaded ${file.name}.`);
      } catch (err) {
        this.ui.setStatus((err as Error).message);
      }
    });
  }

  fitView(): void {
    this.renderer.camera.fit(this.store.worldBounds(120));
    this.needsRender = true;
  }

  focusOn(x: number, y: number): void {
    const camera = this.renderer.camera;
    camera.x = x;
    camera.y = y;
    camera.zoom = Math.max(camera.zoom, 1.2);
    this.needsRender = true;
  }

  addProfile(base: RoadProfile): void {
    const profile = cloneProfile(base, issueId(this.store.model));
    this.store.run(addProfileCommand(profile));
    this.setProfile(profile.id);
  }

  editProfile(id: number, patch: Partial<RoadProfile>): void {
    this.store.run(updateProfile(id, patch));
    this.ui.refresh();
  }

  deleteProfile(id: number): void {
    if (this.store.model.profiles.length <= 1) {
      this.ui.setStatus('Keep at least one road type.');
      return;
    }
    this.store.run(removeProfile(id));
    this.activeProfileId = this.store.model.profiles[0].id;
    this.ui.refresh();
  }

  setRunning(running: boolean): void {
    this.store.running = running;
    this.simCarry = 0;
    this.ui.refresh();
  }

  setSpeed(speed: number): void {
    this.store.speed = speed;
  }

  restartSim(): void {
    this.store.restartSim();
    this.ui.setStatus('Simulation restarted.');
  }

  setDemandScale(value: number): void {
    this.store.run(updateSettings({ demandScale: value }));
    this.store.restartSim();
  }

  /**
   * Where traffic comes from. A settings edit like any other, so it undoes — and it
   * restarts the run, because the demand table is built once when the simulation is
   * created and a half-changed one would be neither mode.
   */
  setSpawnMode(mode: SpawnMode): void {
    this.store.run(updateSettings({ spawnMode: mode }));
    this.store.restartSim();
    this.ui.refresh();
  }

  /**
   * How fast the day runs, in simulated seconds per 24 hours. Zero is no clock at
   * all, which generates flat demand — the right answer when you are measuring one
   * junction rather than watching a town.
   */
  setDayLength(seconds: number): void {
    this.store.run(updateSettings({ dayLength: Math.max(0, seconds) }));
    this.store.restartSim();
    this.ui.refresh();
  }

  /**
   * Moves the clock. Not a restart: the hour is derived from `startHour` plus
   * elapsed time, so shifting it just slides the whole day under the traffic that is
   * already on the road, which is what you want when you are hunting for the peak.
   */
  setStartHour(hour: number): void {
    const now = this.store.sim.timeOfDay;
    const shift = now < 0 ? 0 : hour - now;
    const next = ((this.store.model.settings.startHour + shift) % 24 + 24) % 24;
    this.store.run(updateSettings({ startHour: next }));
    // The simulation reads its own copy, so it has to be told.
    this.store.applyClock();
    this.ui.refresh();
    this.needsRender = true;
  }

  setSeed(value: number): void {
    this.store.run(updateSettings({ seed: value }));
    this.store.restartSim();
  }

  setTerrainEnabled(value: boolean): void {
    this.store.run(updateTerrain({ enabled: value }));
    invalidateTerrainCache();
    this.store.rebuildTerrain();
    this.needsRender = true;
    this.ui.refresh();
  }

  regenerateTerrain(): void {
    this.store.run(updateTerrain({ enabled: true, seed: (this.store.model.terrain.seed + 1) | 0 }));
    invalidateTerrainCache();
    this.store.rebuildTerrain();
    this.needsRender = true;
    this.ui.refresh();
  }

  requestRender(): void {
    this.needsRender = true;
  }

  setUnderlayOpacity(value: number): void {
    const u = this.store.model.underlay;
    if (!u) return;
    this.store.run(setUnderlay({ ...u, opacity: value }, 'Underlay opacity'));
    this.needsRender = true;
  }

  toggleUnderlay(): void {
    const u = this.store.model.underlay;
    if (!u) return;
    this.store.run(setUnderlay({ ...u, visible: !u.visible }, 'Show underlay'));
    this.needsRender = true;
  }

  removeUnderlay(): void {
    this.store.run(setUnderlay(null, 'Remove underlay'));
    clearImageCache();
    this.ui.refresh();
    this.needsRender = true;
  }

  updateGeo(patch: Partial<GeoSettings>): void {
    this.store.run(updateGeo(patch));
    this.needsRender = true;
    this.ui.refresh();
  }

  /** Reads a dropped image and places it centred on the current view. */
  private acceptImage(file: File): void {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const src = String(reader.result);
      const probe = new Image();
      probe.addEventListener('load', () => {
        const camera = this.renderer.camera;
        // Size it to about two-thirds of the viewport, preserving the aspect ratio.
        const targetWidth = (camera.width / camera.zoom) * 0.66;
        const scale = targetWidth / probe.width;
        const underlay: ImageUnderlay = {
          src,
          x: camera.x,
          y: camera.y,
          width: probe.width * scale,
          height: probe.height * scale,
          rotation: 0,
          opacity: 0.7,
          visible: true,
        };
        this.store.run(setUnderlay(underlay));
        this.setTool('underlay');
        this.ui.setStatus('Underlay placed. Drag to move, corners to scale, Shift keeps the aspect ratio.');
        this.needsRender = true;
      });
      probe.src = src;
    });
    reader.readAsDataURL(file);
  }

  renderMs(): number {
    return this.frameMs;
  }

  // --- input ----------------------------------------------------------------

  private env(): ToolEnv {
    return {
      store: this.store,
      camera: this.renderer.camera,
      scale: this.renderer.camera.scale,
      activeProfileId: this.activeProfileId,
      activeGrade: this.activeGrade,
      setActiveGrade: (g) => this.setGrade(g),
      setStatus: (text) => this.ui.setStatus(text),
      requestRender: () => { this.needsRender = true; },
    };
  }

  private pointerInfo(event: PointerEvent): PointerInfo {
    const rect = this.canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return {
      screenX: sx,
      screenY: sy,
      worldX: this.renderer.camera.screenToWorldX(sx),
      worldY: this.renderer.camera.screenToWorldY(sy),
      button: event.button,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
    };
  }

  private get tool(): Tool | undefined {
    return this.tools.find((t) => t.id === this.activeToolId);
  }

  private bindInput(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      // Capture keeps a drag alive outside the canvas. It throws for a pointer the
      // browser is not actually tracking (synthetic events, a pointer already
      // released), and letting that escape would kill the whole handler — including
      // the pan check below.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
      const p = this.pointerInfo(event);
      // Middle button, or space-drag, pans regardless of the active tool.
      if (event.button === 1 || (event.button === 0 && event.altKey && event.shiftKey)) {
        this.panning = true;
        this.panPointer = event.pointerId;
        this.lastPointer = { x: p.screenX, y: p.screenY };
        return;
      }
      if (event.button === 2) return;
      this.store.beginEdit();
      this.tool?.pointerDown?.(p, this.env());
    });

    canvas.addEventListener('pointermove', (event) => {
      const p = this.pointerInfo(event);
      if (this.panning && event.pointerId === this.panPointer) {
        this.renderer.camera.panByPixels(p.screenX - this.lastPointer.x, p.screenY - this.lastPointer.y);
        this.lastPointer = { x: p.screenX, y: p.screenY };
        this.needsRender = true;
        return;
      }
      this.tool?.pointerMove?.(p, this.env());
    });

    const endPointer = (event: PointerEvent): void => {
      if (this.panning && event.pointerId === this.panPointer) {
        this.panning = false;
        this.panPointer = -1;
        return;
      }
      this.tool?.pointerUp?.(this.pointerInfo(event), this.env());
      this.store.endEdit();
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('dblclick', () => {
      const tool = this.tool;
      if (tool instanceof DrawTool) tool.finish(this.env());
    });

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      this.renderer.camera.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
      this.needsRender = true;
    }, { passive: false });

    globalThis.addEventListener('resize', () => {
      this.renderer.resize();
      this.needsRender = true;
    });

    globalThis.addEventListener('keydown', (event) => this.onKey(event));

    // Dropping an image anywhere on the canvas places it as a tracing underlay.
    for (const type of ['dragover', 'dragenter'] as const) {
      canvas.addEventListener(type, (event) => event.preventDefault());
    }
    canvas.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.type.startsWith('image/')) this.acceptImage(file);
      else if (file.name.endsWith('.json')) this.load(file);
    });
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;

    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.store.undo.redo();
      else this.store.undo.undo();
      this.store.invalidate();
      this.needsRender = true;
      return;
    }
    if (ctrl && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.store.undo.redo();
      this.store.invalidate();
      this.needsRender = true;
      return;
    }
    if (ctrl && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.save();
      return;
    }

    if (this.tool?.key?.(event, this.env())) {
      event.preventDefault();
      return;
    }

    const key = event.key.toLowerCase();
    if (TOOL_KEYS[key]) {
      this.setTool(TOOL_KEYS[key]);
      event.preventDefault();
      return;
    }
    if (event.code === 'Space') {
      this.setRunning(!this.store.running);
      event.preventDefault();
      return;
    }
    if (key === 'f') {
      this.fitView();
      event.preventDefault();
    }
  }

  // --- main loop ------------------------------------------------------------

  private readonly frame = (now: number): void => {
    const dt = this.lastFrame ? Math.min(0.25, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;

    this.store.flush();
    // Driven by the store's compile version rather than by what `flush()` returned,
    // because whoever called `flush()` first is the only one who sees that answer.
    if (this.pathsVersion !== this.store.compileVersion) {
      this.pathsVersion = this.store.compileVersion;
      const bakeStart = performance.now();
      // Roads now; houses and trees over the next frames, a slice at a time — and
      // the previous picture's houses stay up meanwhile, everywhere but round the
      // edit, so the town does not empty and refill for the sake of one road.
      this.paths = new NetworkPaths(this.store.network, {
        decorate: false, carryFrom: this.paths, carryExcept: this.store.editBounds,
      });
      // The store budgets mid-gesture rebuilds, and the bake is part of the bill.
      this.store.noteBakeMs(performance.now() - bakeStart);
      this.renderer.setNetwork(this.store.network);
      this.renderer.setSignalLookup((id) => this.store.sim.signals.stateOf(id) as number);
      this.needsRender = true;
    }

    // Decoration is not on the editing path: it fills in behind the cursor.
    if (this.paths && !this.paths.decorated) {
      this.paths.decorate(DECORATE_BUDGET_MS);
      this.needsRender = true;
    }

    if (this.store.running && !this.store.simStale) {
      // Fixed-step integration with a carry, so the rate is independent of frame rate.
      this.simCarry += dt * this.store.speed;
      const step = this.store.sim.dt;
      let steps = Math.floor(this.simCarry / step);
      this.simCarry -= steps * step;
      // Never spend more than a frame's worth of budget catching up.
      steps = Math.min(steps, 600);
      for (let i = 0; i < steps; i++) this.store.sim.tick();
      if (steps > 0) this.needsRender = true;
    }

    if (this.needsRender) {
      this.needsRender = false;
      const alpha = this.store.running
        ? Math.min(1, this.simCarry / this.store.sim.dt)
        : 1;
      this.renderer.render({
        network: this.store.network,
        paths: this.paths,
        // A stale simulation belongs to the network before this edit; drawing its
        // vehicles would put them on roads that no longer exist.
        sim: this.store.simStale ? null : this.store.sim,
        alpha,
        terrain: this.store.terrain,
        underlay: this.store.model.underlay,
        geo: this.store.model.geo,
        showGrid: this.showGrid,
        showDiagnostics: this.showDiagnostics,
        overlays: [{
          // Roads the user has moved since this picture was compiled. Empty unless
          // the document is big enough for the rebuild to have been deferred.
          draw: (ctx, camera, theme) =>
            drawDragPreview(ctx, camera, theme, this.store.staleStrokes()),
        }, {
          draw: (ctx, camera, theme) => this.tool?.draw?.(ctx, camera, theme, this.env()),
        }],
      });
      this.frameMs = this.renderer.stats.drawMs;
    }

    this.ui.updateStats();
    this.ui.tickSignals();
    requestAnimationFrame(this.frame);
  };
}

/**
 * Milliseconds per frame given to baking buildings and trees after a rebuild.
 * Six leaves most of a 60 Hz frame for everything else; a large town's decoration
 * takes a few dozen frames to fill in, which reads as the map settling rather than
 * as a freeze.
 */
const DECORATE_BUDGET_MS = 6;

/** Boots the editor into `mount`. The browser entry point is `index.ts`. */
export function startApp(mount: HTMLElement): App {
  return new App(mount);
}
