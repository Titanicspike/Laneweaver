/**
 * Canvas renderer.
 *
 * Read-only: it never mutates the network or the simulation. Everything is drawn
 * in world units with the camera transform applied, so line weights scale with
 * zoom (with a pixel floor so nothing vanishes). Layers go down in the order
 * terrain, water, contours, then one stack per grade from lowest to highest, then
 * vehicles, then editor overlays.
 */

import type { Network } from '../core/network/types';
import { LaneKind } from '../core/network/types';
import { samplePosition, type Bbox } from '../core/geom/polyline';
import type { Simulation } from '../core/sim/sim';
import { Camera } from './camera';
import { DARK, LOD, WIDTHS, type Theme } from './theme';
import { NetworkPaths, lineWidth, type Tile } from './networkPaths';
import type { TerrainField } from '../core/terrain/terrain';
import { drawTerrain } from './terrainLayer';
import { drawImageUnderlay, drawSatelliteTiles } from './underlayLayer';
import type { GeoSettings, ImageUnderlay } from '../core/network/types';

export interface Overlay {
  draw(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme): void;
}

export interface RenderInput {
  network: Network;
  paths: NetworkPaths;
  sim: Simulation | null;
  /** Interpolation between the previous and current simulation tick, 0..1. */
  alpha: number;
  terrain: TerrainField | null;
  underlay: ImageUnderlay | null;
  geo: GeoSettings | null;
  showGrid: boolean;
  showDiagnostics: boolean;
  overlays: ReadonlyArray<Overlay>;
}

export interface RenderStats {
  drawMs: number;
  tiles: number;
  vehicles: number;
}

const _pose = { x: 0, y: 0, heading: 0 };
const _pt = { x: 0, y: 0 };

export class Renderer {
  readonly camera = new Camera();
  theme: Theme = DARK;
  readonly stats: RenderStats = { drawMs: 0, tiles: 0, vehicles: 0 };

  private readonly ctx: CanvasRenderingContext2D;
  private gradeOfLane = new Int8Array(0);
  private network: Network | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser does not support the 2D canvas context.');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.camera.width = w;
    this.camera.height = h;
    this.camera.devicePixelRatio = dpr;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
  }

  /** Caches per-lane grade lookups; call whenever the network is recompiled. */
  setNetwork(net: Network): void {
    this.network = net;
    this.gradeOfLane = new Int8Array(net.lanes.length);
    for (const lane of net.lanes) {
      const grade = lane.kind === LaneKind.Connector
        ? net.junctions[lane.junctionId]?.grade ?? 0
        : net.segments[lane.segmentId]?.grade ?? 0;
      this.gradeOfLane[lane.id] = grade;
    }
  }

  render(input: RenderInput): void {
    const started = performance.now();
    const { ctx, camera, theme } = this;
    if (this.network !== input.network) this.setNetwork(input.network);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    camera.applyTo(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const view = camera.visibleRect(40);
    this.stats.tiles = 0;
    this.stats.vehicles = 0;

    if (input.geo) drawSatelliteTiles(ctx, camera, input.geo, view);
    if (input.terrain) drawTerrain(ctx, camera, theme, input.terrain, view);
    drawImageUnderlay(ctx, input.underlay);
    if (input.showGrid && camera.zoom >= LOD.grid) this.drawGrid(view);

    for (const grade of input.paths.grades) {
      this.drawGradeStack(input, grade, view);
    }

    if (input.showDiagnostics) this.drawDiagnostics(input.network);
    for (const overlay of input.overlays) overlay.draw(ctx, camera, theme);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.stats.drawMs = performance.now() - started;
  }

  private drawGradeStack(input: RenderInput, grade: number, view: Bbox): void {
    const { ctx, camera, theme } = this;
    const tiles = input.paths.query(grade, view);
    if (!tiles.length) {
      this.drawVehicles(input, grade, view);
      return;
    }
    this.stats.tiles += tiles.length;

    const tunnel = grade < 0;
    const bridge = grade > 0;
    ctx.globalAlpha = tunnel ? theme.tunnelAlpha : 1;

    // A raised road throws a shadow, so the stacking order reads at a glance. The
    // shape is baked from the road's own height rather than translated wholesale,
    // or a bridge lays a block of shadow across the road at its abutment.
    if (bridge || grade === 0) {
      ctx.fillStyle = theme.bridgeShadow;
      ctx.globalAlpha = 0.55;
      for (const tile of tiles) ctx.fill(tile.shadow);
      ctx.globalAlpha = tunnel ? theme.tunnelAlpha : 1;
    }

    // Casing: stroke the road's edges, then fill over the inner half of the stroke.
    // The outline used here leaves out any end cap the road drives straight through,
    // because a cap is only an edge where the road actually stops.
    ctx.strokeStyle = theme.casing;
    ctx.lineWidth = lineWidth(WIDTHS.casing * 2, camera.zoom);
    if (tunnel) ctx.setLineDash([WIDTHS.tunnelDash[0], WIDTHS.tunnelDash[1]]);
    // Butt ends, because an outline left open at a joint would otherwise finish with
    // a round cap: a half-disc of casing sitting on the road at every abutment.
    ctx.lineCap = 'butt';
    for (const tile of tiles) ctx.stroke(tile.casing);
    ctx.lineCap = 'round';
    ctx.setLineDash([]);

    ctx.fillStyle = theme.asphalt;
    for (const tile of tiles) ctx.fill(tile.asphalt);

    if (camera.zoom >= LOD.markings) {
      ctx.strokeStyle = theme.markingEdge;
      ctx.lineWidth = lineWidth(WIDTHS.edgeMarking, camera.zoom);
      for (const tile of tiles) ctx.stroke(tile.edge);

      ctx.strokeStyle = theme.markingWhite;
      ctx.lineWidth = lineWidth(WIDTHS.laneMarking, camera.zoom);
      // The dash pattern is in world units, so zooming out shrinks the dashes
      // themselves. Below a couple of pixels each one antialiases away to nothing
      // and the lane line vanishes while the road is still plainly wide. Stretch the
      // whole pattern to hold a legible dash instead.
      const dashScale = Math.max(1, WIDTHS.minDashPixels / (WIDTHS.dash[0] * camera.zoom));
      ctx.setLineDash([WIDTHS.dash[0] * dashScale, WIDTHS.dash[1] * dashScale]);
      for (const tile of tiles) ctx.stroke(tile.dashed);
      ctx.setLineDash([]);
      for (const tile of tiles) ctx.stroke(tile.solid);

      // The left edge of a carriageway on a divided road is yellow, the same way
      // the centre line of an undivided one is: it is the boundary you never cross.
      ctx.strokeStyle = theme.markingYellow;
      for (const tile of tiles) ctx.stroke(tile.median);

      // Double centre line: one thick yellow stroke split by a thin asphalt core.
      const doubleWidth = lineWidth(WIDTHS.laneMarking * 2 + WIDTHS.doubleGap, camera.zoom);
      const coreWidth = lineWidth(WIDTHS.doubleGap, camera.zoom);
      ctx.strokeStyle = theme.markingYellow;
      ctx.lineWidth = doubleWidth;
      for (const tile of tiles) ctx.stroke(tile.double);
      // Both widths hit the same pixel floor when zoomed out, and then the core
      // erases the line it is supposed to split. Below that, one plain line.
      if (coreWidth < doubleWidth * 0.6) {
        ctx.strokeStyle = theme.asphalt;
        ctx.lineWidth = coreWidth;
        for (const tile of tiles) ctx.stroke(tile.double);
      }
    }

    // Buildings go under the planting: a street tree stands in front of the house
    // behind it, and drawing them the other way round puts the house over the tree.
    // Within the group the order is what you would see from above — ground, then
    // what is paved on it, then the roof, then its lit face and its edge.
    // Decoration may come from the previous picture while this one fills in, so
    // that an edit refills only its own surroundings rather than the whole map.
    const deco = input.paths.decorationTiles(grade, view);
    const built = camera.zoom >= LOD.buildings && deco.some((t) => t.built);
    if (built) {
      ctx.fillStyle = theme.plotGround;
      for (const tile of deco) ctx.fill(tile.plotGround);
      ctx.fillStyle = theme.plotYard;
      for (const tile of deco) ctx.fill(tile.plotYard);
      ctx.fillStyle = theme.plotPaving;
      for (const tile of deco) ctx.fill(tile.plotPaving);

      // Shadows before the roofs, so a building sits on top of its own.
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = theme.buildingShadow;
      for (const tile of deco) ctx.fill(tile.roofShadow);
      ctx.globalAlpha = 1;

      const roofs = [...theme.roofHouse, ...theme.roofShop];
      for (let i = 0; i < roofs.length; i++) {
        ctx.fillStyle = roofs[i];
        for (const tile of deco) {
          const path = tile.roofs[i];
          if (path) ctx.fill(path);
        }
      }

      // An outline, so neighbouring roofs of the same colour stay separate houses
      // rather than merging into one block.
      if (camera.zoom >= LOD.buildingEdge) {
        ctx.strokeStyle = theme.buildingEdge;
        ctx.lineWidth = lineWidth(0.35, camera.zoom);
        ctx.lineJoin = 'round';
        for (const tile of deco) ctx.stroke(tile.roofEdge);
      }
    }

    // Verge planting sits beside the road, so it goes down after the paint and
    // before anything that has to be read over the top of it.
    if (camera.zoom >= LOD.trees) {
      ctx.fillStyle = theme.treeCrown;
      for (const tile of deco) ctx.fill(tile.trees);
      ctx.fillStyle = theme.treeHighlight;
      for (const tile of deco) ctx.fill(tile.treeTops);
    }


    if (camera.zoom >= LOD.junctionDetail) {
      // Crossings before stop bars: the bar is the nearer of the two to the driver
      // and reads as the harder line, so it goes on top where they touch.
      ctx.strokeStyle = theme.markingWhite;
      ctx.lineWidth = lineWidth(WIDTHS.zebra, camera.zoom);
      ctx.lineCap = 'butt';
      for (const tile of tiles) ctx.stroke(tile.zebra);

      ctx.strokeStyle = theme.stopBar;
      ctx.lineWidth = lineWidth(WIDTHS.stopBar, camera.zoom);
      ctx.lineCap = 'butt';
      for (const tile of tiles) ctx.stroke(tile.stopBars);
      ctx.lineCap = 'round';
    }

    // Arrows and word markings. Both are read at a glance rather than followed, so
    // they only earn their keep once a lane is a few pixels wide.
    if (camera.zoom >= LOD.symbols) {
      ctx.fillStyle = theme.markingWhite;
      for (const tile of tiles) ctx.fill(tile.arrows);
      this.drawWords(tiles);
    }

    if (camera.zoom >= LOD.signals) this.drawSignals(input.network, grade, view);

    this.drawVehicles(input, grade, view);
    ctx.globalAlpha = 1;
  }

  /**
   * Word markings. Road lettering reads square-on to the driver — the baseline runs
   * across the carriageway and the letters are stretched along it, which is why STOP
   * on a real road looks impossibly tall from above.
   */
  private drawWords(tiles: ReadonlyArray<Tile>): void {
    const { ctx, theme } = this;
    let any = false;
    for (const tile of tiles) {
      for (const word of tile.words) {
        if (!any) {
          ctx.fillStyle = theme.markingWhite;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          any = true;
        }
        const text = 'STOP';
        const REF = 100;
        ctx.font = `700 ${REF}px ui-sans-serif, system-ui, sans-serif`;
        // A stub canvas need not measure; the fallback is this font's own ratio.
        const measured = ctx.measureText?.(text)?.width;
        const natural = measured && measured > 1 ? measured : REF * 2.35;
        const across = Math.min(word.width * 0.8, 3.4);
        const tall = Math.min(word.width * 0.75, 2.45);
        ctx.save();
        ctx.translate(word.x, word.y);
        // +x of the text now runs to the driver's right, so its top faces away.
        ctx.rotate(word.heading + Math.PI / 2);
        ctx.scale(across / natural, tall / (REF * 0.72));
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
    if (any) {
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  private drawSignals(net: Network, grade: number, view: Bbox): void {
    const { ctx, theme, camera } = this;
    const r = Math.max(0.9, 5 / camera.zoom);
    for (const junction of net.junctions) {
      if (junction.grade !== grade || junction.control !== 'signal' || !junction.signal) continue;
      if (junction.x < view.minX || junction.x > view.maxX) continue;
      if (junction.y < view.minY || junction.y > view.maxY) continue;
      for (const approach of junction.approaches) {
        const first = approach.incomingLanes[0];
        if (first === undefined) continue;
        const lane = net.lanes[first];
        samplePosition(lane.centerline, lane.arclength, Math.max(0, lane.length - 2), _pt);
        const connector = junction.connectorIds.find((id) => net.lanes[id].predecessors[0] === first);
        const state = connector === undefined || !this.signalLookup ? 0 : this.signalLookup(connector);
        ctx.fillStyle = state === 1 ? theme.signalGreen : state === 2 ? theme.signalAmber : theme.signalRed;
        ctx.beginPath();
        ctx.arc(_pt.x, _pt.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Signal colour comes from the live controller when one is attached. */
  private signalLookup: ((connectorId: number) => number) | null = null;

  setSignalLookup(fn: ((connectorId: number) => number) | null): void {
    this.signalLookup = fn;
  }


  private drawVehicles(input: RenderInput, grade: number, view: Bbox): void {
    const sim = input.sim;
    if (!sim || this.camera.zoom < LOD.vehicles) return;
    const { ctx, camera, theme } = this;
    const store = sim.store;
    const bodies = camera.zoom >= LOD.vehicleBodies;
    const dot = Math.max(0.6, 2 / camera.zoom);
    const pad = 12;

    ctx.strokeStyle = theme.vehicleOutline;
    ctx.lineWidth = lineWidth(0.12, camera.zoom);

    sim.forEachVehicle((i, laneId) => {
      if (this.gradeOfLane[laneId] !== grade) return;
      sim.sampleVehicle(i, input.alpha, _pose);
      if (_pose.x < view.minX - pad || _pose.x > view.maxX + pad) return;
      if (_pose.y < view.minY - pad || _pose.y > view.maxY + pad) return;
      this.stats.vehicles++;

      const braking = store.a[i] < -2.5;
      ctx.fillStyle = braking
        ? theme.vehicleBraking
        : theme.vehicle[store.serial[i] % theme.vehicle.length];

      if (!bodies) {
        ctx.beginPath();
        ctx.arc(_pose.x, _pose.y, dot, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      const len = store.len[i];
      const wid = store.width[i];
      ctx.save();
      ctx.translate(_pose.x, _pose.y);
      ctx.rotate(_pose.heading);
      // `s` is the front bumper, so the body runs backwards from the origin.
      roundRect(ctx, -len, -wid / 2, len, wid, Math.min(0.6, wid * 0.3));
      ctx.fill();
      if (camera.zoom > 1.2) ctx.stroke();
      ctx.restore();
    });
  }

  private drawGrid(view: Bbox): void {
    const { ctx, camera, theme } = this;
    // Step up through 10/50/100/500... so roughly 40 px separates the lines.
    const target = 60 / camera.zoom;
    const steps = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (s >= target) {
        step = s;
        break;
      }
    }
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = lineWidth(0, camera.zoom);
    ctx.beginPath();
    const x0 = Math.floor(view.minX / step) * step;
    const y0 = Math.floor(view.minY / step) * step;
    for (let x = x0; x <= view.maxX; x += step) {
      ctx.moveTo(x, view.minY);
      ctx.lineTo(x, view.maxY);
    }
    for (let y = y0; y <= view.maxY; y += step) {
      ctx.moveTo(view.minX, y);
      ctx.lineTo(view.maxX, y);
    }
    ctx.stroke();
  }

  private drawDiagnostics(net: Network): void {
    const { ctx, camera, theme } = this;
    const r = Math.max(1.5, 7 / camera.zoom);
    for (const d of net.diagnostics) {
      if (d.x === undefined || d.y === undefined) continue;
      ctx.fillStyle = d.severity === 'error' ? theme.errorMark
        : d.severity === 'warning' ? theme.warnMark : theme.infoMark;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.background;
      ctx.lineWidth = lineWidth(0.25, camera.zoom);
      ctx.stroke();
    }
  }
}

export function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
