/**
 * Application state.
 *
 * Owns the one-way pipeline: the document is the source of truth, the network is
 * compiled from it, and the simulation runs on the network. Editing marks the
 * document dirty; the main loop recompiles at most once per frame so a drag does
 * not pay for a rebuild per pointer event.
 */

import { UndoStack } from '../core/util/command';
import type { DocCommand } from '../editor/commands';
import { compile } from '../core/network/compiler';
import { createDocument, flattenStroke, gradeAtS, profileHalfWidth, requireProfile } from '../core/network/model';
import type { ControlPoint, EditModel, Junction, Network, Stroke } from '../core/network/types';
import { LaneIndex } from '../core/network/laneGraph';
import { Simulation } from '../core/sim/sim';
import { generateTerrain, type TerrainField } from '../core/terrain/terrain';
import { checkTerrainConstraints } from '../core/terrain/constraints';
import type { Diagnostic } from '../core/network/types';
import { bboxOfPolyline, expandBbox, type Bbox } from '../core/geom/polyline';

/** Flattened geometry for one stroke, cached for snapping and picking. */
export interface StrokeGeometry {
  points: Float32Array;
  arclength: Float32Array;
  length: number;
  halfWidth: number;
  /** Of the flattened centreline: what an edit's surroundings are measured from. */
  bounds: Bbox;
  /**
   * The stroke itself and where each of its control points falls along the
   * flattened polyline, which together answer how high the road is at any arc
   * length. Level is a property of the *point* on a road, not of the road: a
   * stroke that climbs is at ground level at its ends and a bridge in the middle,
   * so anything that asks "are these two at the same height" has to ask about a
   * place rather than about the stroke.
   */
  stroke: Stroke;
  cpArc: Float32Array;
}

/** Which layer a stroke is on at arc-length `s` — the same rounding the compiler does. */
export function levelOf(geom: StrokeGeometry, s: number): number {
  return Math.round(gradeAtS(geom.stroke, geom.cpArc, s));
}

export type StoreListener = () => void;

/**
 * How much of the clock a mid-gesture rebuild may take: at most one part in this
 * many.
 *
 * Eight rather than something tighter because the preview makes the rebuild rate
 * nearly free: the road under the cursor is drawn every frame from its own
 * centreline, and the rest of the map is not moving. What the rebuild buys is the
 * *junctions* catching up, which nobody needs sixty times a second. Measured on the
 * town grid, a rebuild is about 95 ms of compile and bake, so a duty of three spent a
 * third of every drag inside the compiler — a 150 ms frame at the ninetieth
 * percentile, which is a visible stutter three times a second.
 */
const REBUILD_DUTY = 8;

/**
 * How far round an edit the decoration is redone, in metres: a plot reaches a
 * house-depth back from its road, and a road a little further away than that
 * cannot have changed what stands beside another.
 */
const EDIT_HALO = 60;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/**
 * A cheap fingerprint of a stroke's shape — its control points and its profile.
 *
 * Only ever compared against another fingerprint of the same stroke, so collisions
 * cost a preview that is not drawn for one frame, not a wrong picture.
 */
function shapeOf(stroke: Stroke): number {
  let h = (stroke.profileId * 2654435761) >>> 0;
  for (const p of stroke.points) {
    h = (Math.imul(h ^ (p.x * 64) | 0, 2246822519)) >>> 0;
    h = (Math.imul(h ^ (p.y * 64) | 0, 3266489917)) >>> 0;
    h = (Math.imul(h ^ (p.hix * 64) | 0, 668265263)) >>> 0;
    h = (Math.imul(h ^ (p.hiy * 64) | 0, 374761393)) >>> 0;
    h = (Math.imul(h ^ (p.hox * 64) | 0, 2246822519)) >>> 0;
    h = (Math.imul(h ^ (p.hoy * 64) | 0, 3266489917)) >>> 0;
    h = (Math.imul(h ^ (p.grade * 8) | 0, 668265263)) >>> 0;
  }
  return h;
}

export class AppStore {
  model: EditModel;
  network: Network;
  laneIndex: LaneIndex;
  sim: Simulation;
  terrain: TerrainField | null = null;
  readonly undo: UndoStack<EditModel>;

  /** Stroke id to flattened geometry, rebuilt with the network. */
  readonly geometry = new Map<number, StrokeGeometry>();
  /** Compile diagnostics plus terrain constraint violations. */
  diagnostics: Diagnostic[] = [];

  running = false;
  /** Simulated seconds per real second. */
  speed = 1;
  selection = new Set<number>();
  /**
   * The junction the signal panel is looking at, by position — junctions are
   * derived data with no stable identity, so a recompile has to be able to find it
   * again the same way an override does.
   */
  selectedJunction: { x: number; y: number } | null = null;

  private dirty = false;
  private editing = false;
  /**
   * A cheap fingerprint of each stroke as the current network was compiled from it.
   *
   * What it answers is "which roads has the user moved since the picture on screen
   * was made", which is the question the drag preview needs and the one nothing else
   * can answer: commands go through the undo stack, and the store is told only that
   * *something* changed. A fingerprint costs a pass over the control points, which
   * is nothing next to a compile, and it stays right no matter which tool did the
   * editing or whether it thought to say so.
   */
  private readonly compiledShape = new Map<number, number>();
  /** Each stroke's control points as compiled, for finding *which* of them moved. */
  private readonly compiledPoints = new Map<number, ControlPoint[]>();
  /**
   * Where the last recompile's edit was: the roads whose shape changed, old and
   * new positions both, plus a house-depth either side. Null when no road moved —
   * a control choice, a turn bay, a zoning stroke — so the renderer keeps every
   * house until the new ones are ready. What it is for is the opposite question
   * to `staleStrokes`: not "what must I draw myself" but "what may I keep".
   */
  private lastEditBounds: Bbox | null = null;

  /** The area round the last edit, or null if no road changed shape. */
  get editBounds(): Bbox | null {
    return this.lastEditBounds;
  }
  /** When the last recompile finished, and how long it took, in milliseconds. */
  private lastCompileAt = -Infinity;
  private lastCompileMs = 0;
  /**
   * What the renderer spent baking the last network into `Path2D`, reported back by
   * whoever did it. The compile is only half of what a rebuild costs the frame — on
   * a town the bake is the larger half — and a duty cycle that counted the compile
   * alone rebuilt every couple of frames on a document where each rebuild was a
   * visible stutter.
   */
  private lastBakeMs = 0;

  /** Tells the store what its consumers spent on the last rebuild. */
  noteBakeMs(ms: number): void {
    this.lastBakeMs = Math.max(0, ms);
  }
  /**
   * True when the network has been rebuilt but the simulation has not caught up.
   * During a drag the geometry changes every frame; allocating a fresh vehicle
   * store that often would churn the heap for no benefit, so the rebuild is
   * deferred to the end of the gesture and the traffic simply pauses.
   */
  simStale = false;
  private readonly listeners = new Set<StoreListener>();

  constructor(model = createDocument()) {
    this.model = model;
    this.undo = new UndoStack<EditModel>(this.model, 400);
    this.network = compile(this.model);
    this.laneIndex = new LaneIndex(this.network);
    this.sim = new Simulation(this.network, this.simOptions());
    this.rebuildGeometry();
    // Record what was compiled, or the first edit of the session compares against
    // nothing, reports every road as changed, and refills the whole town.
    this.recordCompiled();
    this.rebuildTerrain();
    this.undo.onChange(() => this.invalidate());
  }

  private simOptions() {
    return {
      seed: this.model.settings.seed,
      demandScale: this.model.settings.demandScale,
      demand: this.model.demand.length ? this.model.demand : undefined,
      spawnMode: this.model.settings.spawnMode,
      dayLength: this.model.settings.dayLength,
      startHour: this.model.settings.startHour,
    };
  }

  /** The selected junction as it exists in the network right now, if it still does. */
  junctionSelection(): Junction | null {
    const at = this.selectedJunction;
    if (!at) return null;
    let best: Junction | null = null;
    let bestD = Infinity;
    for (const junction of this.network.junctions) {
      // Crossings and gores alike: a gore has one choice, and the panel is where
      // it lives now that an entrance's choice is a count rather than a flag.
      if (junction.kind === 'link') continue;
      const d = Math.hypot(junction.x - at.x, junction.y - at.y);
      if (d > Math.max(8, junction.radius * 1.5) || d >= bestD) continue;
      bestD = d;
      best = junction;
    }
    return best;
  }

  selectJunction(at: { x: number; y: number } | null): void {
    this.selectedJunction = at;
    this.emit();
  }

  onChange(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Runs a command through the undo stack and schedules a recompile. */
  run(command: DocCommand): void {
    this.undo.run(command);
  }

  transaction<T>(label: string, fn: () => T): T {
    return this.undo.transaction(label, fn);
  }

  /**
   * Bumped on every recompile.
   *
   * Anything holding data baked from the network — the renderer's `Path2D` tiles
   * above all — compares this against the version it baked, rather than watching
   * for `flush()` to return true. The return value only tells *the caller that
   * happened to call it*, and `flush()` is called from three places: the frame
   * loop, the end of an interactive gesture, and a document swap. For a long time
   * only the first of those rebuilt the paths, so opening a document left the
   * previous one's roads on screen with the new one's traffic driving over them.
   */
  compileVersion = 0;

  /** Marks the network stale; the main loop rebuilds before the next frame. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Roads the user has moved since the network on screen was compiled.
   *
   * Empty except during a drag on a document big enough for the recompile to be
   * deferred, which is exactly when the editor needs to draw them itself.
   */
  staleStrokes(): StrokeGeometry[] {
    if (!this.dirty) return [];
    const out: StrokeGeometry[] = [];
    for (const stroke of this.model.strokes) {
      if (this.compiledShape.get(stroke.id) === shapeOf(stroke)) continue;
      const geom = this.geometry.get(stroke.id);
      if (geom) out.push(geom);
    }
    return out;
  }

  /** Brackets an interactive gesture so the simulation is rebuilt only once. */
  beginEdit(): void {
    this.editing = true;
  }

  endEdit(): void {
    if (!this.editing) return;
    this.editing = false;
    this.flush();
    if (this.simStale) this.restartSim();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Remembers each stroke's shape as compiled, for the next edit to diff against. */
  private recordCompiled(): void {
    this.compiledShape.clear();
    this.compiledPoints.clear();
    for (const stroke of this.model.strokes) {
      this.compiledShape.set(stroke.id, shapeOf(stroke));
      this.compiledPoints.set(stroke.id, stroke.points.map((p) => ({ ...p })));
    }
  }

  /** Bounds of every road whose shape changed since the last compile, before and after. */
  private editArea(): Bbox | null {
    let box: Bbox | null = null;
    const grow = (b: Bbox | null): void => {
      if (!b) return;
      box = box
        ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY),
            maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
        : { ...b };
    };
    // A control point and its handles, as a box.
    const ofPoint = (p: ControlPoint): Bbox => ({
      minX: Math.min(p.x, p.hix, p.hox), minY: Math.min(p.y, p.hiy, p.hoy),
      maxX: Math.max(p.x, p.hix, p.hox), maxY: Math.max(p.y, p.hiy, p.hoy),
    });
    const same = (a: ControlPoint, b: ControlPoint): boolean =>
      a.x === b.x && a.y === b.y && a.hix === b.hix && a.hiy === b.hiy
      && a.hox === b.hox && a.hoy === b.hoy && a.grade === b.grade;
    const seen = new Set<number>();
    for (const stroke of this.model.strokes) {
      seen.add(stroke.id);
      if (this.compiledShape.get(stroke.id) === shapeOf(stroke)) continue;
      const old = this.compiledPoints.get(stroke.id);
      if (!old || old.length !== stroke.points.length) {
        // New, or a point added or removed: the whole road, before and after.
        grow(this.geometry.get(stroke.id)?.bounds ?? null);
        const { points } = flattenStroke(stroke, this.model.settings.flattenTolerance);
        if (points.length >= 4) grow(bboxOfPolyline(points));
        continue;
      }
      // A moved control point moves the two bezier spans beside it and nothing
      // else, and a span lies within the hull of its two points and their handles.
      // Answering with the whole stroke instead was a four-kilometre edit for one
      // point on a grid town's street, which refilled the entire row of houses.
      for (let i = 0; i < old.length; i++) {
        if (same(old[i], stroke.points[i])) continue;
        for (let k = Math.max(0, i - 1); k <= Math.min(old.length - 1, i + 1); k++) {
          grow(ofPoint(old[k]));
          grow(ofPoint(stroke.points[k]));
        }
      }
    }
    // Roads that are gone leave their houses behind too.
    for (const id of this.compiledShape.keys()) {
      if (!seen.has(id)) grow(this.geometry.get(id)?.bounds ?? null);
    }
    return box ? expandBbox(box, EDIT_HALO) : null;
  }

  /** Rebuilds the network if the document changed. Returns true if it did. */
  flush(): boolean {
    if (!this.dirty) return false;

    // Mid-gesture, a recompile is worth having but not at any price.
    //
    // Compiling is whole-network and so is the renderer's bake of it, and together
    // they run to tens of milliseconds on a town and hundreds on anything larger.
    // Doing that on every frame of a drag is what made building roads on a big
    // document feel like five frames a second: the work is the frame. So during a
    // gesture the rebuild gets a duty cycle — it may occupy at most a fixed share of
    // wall-clock time — and the editor draws the roads being dragged itself in the
    // meantime, which costs a polyline each and tracks the cursor exactly.
    //
    // A small document is unaffected: a two-millisecond compile clears the budget
    // every frame, so it still rebuilds every frame, as it always did.
    if (this.editing) {
      const now = nowMs();
      if (now - this.lastCompileAt < (this.lastCompileMs + this.lastBakeMs) * REBUILD_DUTY) {
        // Still keep the flattened geometry current: it is what the preview draws
        // and what every hit test in the editor reads.
        this.rebuildGeometry();
        return false;
      }
    }

    this.dirty = false;
    this.lastEditBounds = this.editArea();
    const startedAt = nowMs();
    this.network = compile(this.model);
    this.lastCompileMs = nowMs() - startedAt;
    this.lastCompileAt = nowMs();
    this.compileVersion++;
    this.laneIndex = new LaneIndex(this.network);
    this.rebuildGeometry();
    this.recordCompiled();
    this.refreshDiagnostics();
    // The lane graph the vehicles were driving on no longer exists.
    if (this.editing) this.simStale = true;
    else this.restartSim();
    this.emit();
    return true;
  }

  /**
   * Pushes the document's clock settings into the running simulation.
   *
   * Moving the clock must not restart the traffic — the whole point of dragging the
   * hour is to watch the network you already have run into its peak.
   */
  applyClock(): void {
    this.sim.setClock(this.model.settings.dayLength, this.model.settings.startHour);
    this.emit();
  }

  restartSim(): void {
    this.sim = new Simulation(this.network, this.simOptions());
    this.simStale = false;
    this.emit();
  }

  rebuildGeometry(): void {
    this.geometry.clear();
    for (const stroke of this.model.strokes) {
      const profile = requireProfile(this.model, stroke.profileId);
      const { points, arclength, cpArc } = flattenStroke(stroke, this.model.settings.flattenTolerance);
      if (points.length < 4) continue;
      this.geometry.set(stroke.id, {
        points,
        arclength,
        length: arclength[arclength.length - 1],
        halfWidth: profileHalfWidth(profile),
        stroke,
        cpArc,
        bounds: bboxOfPolyline(points),
      });
    }
  }

  rebuildTerrain(): void {
    if (!this.model.terrain.enabled) {
      this.terrain = null;
      this.refreshDiagnostics();
      return;
    }
    const bounds = this.worldBounds(1500);
    this.terrain = generateTerrain(this.model.terrain, bounds);
    this.refreshDiagnostics();
  }

  refreshDiagnostics(): void {
    this.diagnostics = [
      ...this.network.diagnostics,
      ...checkTerrainConstraints(this.model, this.terrain),
    ];
  }

  /** Network extent padded outward, with a sane minimum for an empty document. */
  worldBounds(pad = 200): Bbox {
    const b = { ...this.network.bounds };
    if (!Number.isFinite(b.minX) || b.maxX - b.minX < 10) {
      return { minX: -600, minY: -400, maxX: 600, maxY: 400 };
    }
    return expandBbox(b, pad);
  }
}
