/**
 * A short piece of road, drawn straight, from a profile alone.
 *
 * The same picture serves the swatch beside each road type and the canvas at the
 * top of the road editor, so what you pick in the list is exactly what you get on
 * the map — same palette, same marking widths, same lane order. It is deliberately
 * a plan view rather than a cross-section: it uses the visual language the user is
 * already reading everywhere else.
 *
 * Nothing here touches the compiler. It reads a `RoadProfile` and draws; the hit
 * regions it returns are what makes the editor's picture clickable.
 */

import {
  groupSign, halfCarriageway, lanesOnSide, layoutProfile, medianOf,
} from '../core/network/compiler/layout';
import type { RoadProfile } from '../core/network/types';
import { DARK, WIDTHS, type Theme } from './theme';
import { Mulberry32 } from '../core/util/rng';

export interface PreviewBand {
  kind: 'lane' | 'median' | 'shoulder' | 'verge';
  /** Direction group for lanes; 0 for everything else. */
  side: 1 | -1 | 0;
  /** Lane index within its group; -1 for everything else. */
  index: number;
  /** Screen-space band, top to bottom. */
  y0: number;
  y1: number;
}

export interface PreviewOptions {
  theme?: Theme;
  /** Draw an arrow per lane showing which way it runs. */
  direction?: boolean;
  /** Plant the verges. Defaults to whatever the profile asks for. */
  trees?: boolean;
  /** Band to pick out, matched on `side` and `index`. */
  highlight?: { side: 1 | -1; index: number } | null;
  /** Right-hand traffic. */
  driveOnRight?: boolean;
  /** Metres per pixel is chosen to fit unless this is given. */
  scale?: number;
}

/** Everything the profile occupies, verges included. */
export function previewWidth(profile: RoadProfile, trees: boolean): number {
  const verge = trees ? Math.max(profile.verge ?? 0, 0) : 0;
  return halfCarriageway(profile) * 2 + profile.shoulder * 2 + verge * 2;
}

/**
 * Draws into `ctx` over the box `(0, 0, width, height)` and returns the bands, so a
 * caller can turn a click into "the second lane of the forward group".
 */
export function drawRoadPreview(
  ctx: CanvasRenderingContext2D,
  profile: RoadProfile,
  width: number,
  height: number,
  options: PreviewOptions = {},
): PreviewBand[] {
  const theme = options.theme ?? DARK;
  const driveOnRight = options.driveOnRight ?? true;
  const trees = options.trees ?? (profile.verge ?? 0) > 0;
  const verge = trees ? Math.max(profile.verge ?? 0, 0) : 0;
  const total = previewWidth(profile, trees);
  // A hair of ground top and bottom, so the road reads as sitting in something.
  const scale = options.scale ?? (height - 6) / Math.max(total, 1);
  const mid = height / 2;
  // Offsets run positive to the right of travel, which is down the screen here.
  const y = (offset: number): number => mid + offset * scale;
  const bands: PreviewBand[] = [];

  const half = halfCarriageway(profile);
  const median = medianOf(profile);
  const asphalt0 = y(-half - profile.shoulder);
  const asphalt1 = y(half + profile.shoulder);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  // Ground, then the planted verges over it.
  ctx.fillStyle = theme.land;
  ctx.fillRect(0, 0, width, height);
  if (verge > 0) {
    for (const sign of [-1, 1] as const) {
      const a = y(sign * (half + profile.shoulder));
      const b = y(sign * (half + profile.shoulder + verge));
      bands.push({ kind: 'verge', side: 0, index: -1, y0: Math.min(a, b), y1: Math.max(a, b) });
    }
    drawTrees(ctx, theme, width, y, half + profile.shoulder, verge, scale, profile.id);
  }

  // Casing, then asphalt over it, so the casing reads as a thin outline.
  const casing = Math.max(1, WIDTHS.casing * scale);
  ctx.fillStyle = theme.casing;
  ctx.fillRect(0, asphalt0 - casing, width, asphalt1 - asphalt0 + casing * 2);
  ctx.fillStyle = profile.color ?? theme.asphalt;
  ctx.fillRect(0, asphalt0, width, asphalt1 - asphalt0);

  bands.push({ kind: 'shoulder', side: 0, index: -1, y0: asphalt0, y1: y(-half) });
  bands.push({ kind: 'shoulder', side: 0, index: -1, y0: y(half), y1: asphalt1 });

  const line = (offset: number, style: string, w: number, dash?: [number, number]): void => {
    ctx.strokeStyle = style;
    ctx.lineWidth = Math.max(0.9, w * scale);
    ctx.setLineDash(dash ? [dash[0] * scale, dash[1] * scale] : []);
    ctx.beginPath();
    ctx.moveTo(0, y(offset));
    ctx.lineTo(width, y(offset));
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Carriageway edges, one shoulder inside the asphalt — the same rule the
  // compiler follows, so the swatch cannot disagree with the map.
  line(-half, theme.markingEdge, WIDTHS.edgeMarking);
  line(half, theme.markingEdge, WIDTHS.edgeMarking);

  const slots = layoutProfile(profile, driveOnRight);
  for (const slot of slots) {
    const a = y(slot.offset - slot.width / 2);
    const b = y(slot.offset + slot.width / 2);
    bands.push({
      kind: 'lane', side: slot.side, index: slot.index,
      y0: Math.min(a, b), y1: Math.max(a, b),
    });
  }

  // Lane dividers, written out the way `buildSegments` writes them rather than
  // rederived. The rederivation was "a divider on the outer side of every lane but
  // the outermost, outer being `sign(offset)`" — which is only true when a
  // direction group sits wholly on one side of the centreline. A one-way road
  // straddles it, so on every one-way profile the dividers were drawn on the
  // *outside* of the carriageway instead of between the lanes, and a two-lane ramp
  // came out as a plain grey bar.
  for (const side of [1, -1] as const) {
    const count = lanesOnSide(profile, side);
    const g = groupSign(side, driveOnRight);
    for (let k = 1; k < count; k++) {
      line(g * (half - k * profile.laneWidth), theme.markingWhite, WIDTHS.laneMarking, WIDTHS.dash);
    }
  }

  if (profile.lanesForward > 0 && profile.lanesBackward > 0) {
    if (median > 0) {
      // The median is asphalt — the compiler never raises one — and its edges are
      // the boundary you never cross, so they are yellow. Nothing is shaded: the
      // map does not shade it either, and a swatch that adds something the road
      // does not have is the one way this picture can mislead.
      line(-median / 2, theme.markingYellow, WIDTHS.laneMarking);
      line(median / 2, theme.markingYellow, WIDTHS.laneMarking);
    } else {
      // One thick yellow stroke split by a thin core of asphalt, exactly as the
      // renderer draws the `double` style — including its rule for giving up on the
      // core when both widths hit the same pixel floor.
      const doubleWidth = Math.max(0.9, (WIDTHS.laneMarking * 2 + WIDTHS.doubleGap) * scale);
      const coreWidth = Math.max(0.9, WIDTHS.doubleGap * scale);
      ctx.strokeStyle = theme.markingYellow;
      ctx.lineWidth = doubleWidth;
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      ctx.lineTo(width, y(0));
      ctx.stroke();
      if (coreWidth < doubleWidth * 0.6) {
        ctx.strokeStyle = profile.color ?? theme.asphalt;
        ctx.lineWidth = coreWidth;
        ctx.stroke();
      }
    }
  }

  if (options.highlight) {
    const band = bands.find((b) => b.kind === 'lane'
      && b.side === options.highlight!.side && b.index === options.highlight!.index);
    if (band) {
      ctx.strokeStyle = theme.selection;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, band.y0 + 1, width - 2, band.y1 - band.y0 - 2);
    }
  }

  if (options.direction) {
    for (const slot of slots) {
      const along = slot.side === 1 ? 1 : -1;
      drawLaneArrow(ctx, theme, width, y(slot.offset), slot.width * scale, along);
    }
  }

  ctx.restore();
  return bands;
}

/** A single chevron down the middle of a lane, pointing the way traffic runs. */
function drawLaneArrow(
  ctx: CanvasRenderingContext2D, theme: Theme,
  width: number, cy: number, laneHeight: number, along: 1 | -1,
): void {
  const len = Math.min(width * 0.22, 34);
  const size = Math.max(3, Math.min(laneHeight * 0.3, 7));
  const cx = width / 2;
  const tip = cx + (along * len) / 2;
  const tail = cx - (along * len) / 2;
  ctx.fillStyle = theme.markingWhite;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(tail, cy - size * 0.3);
  ctx.lineTo(tip - along * size, cy - size * 0.3);
  ctx.lineTo(tip - along * size, cy - size);
  ctx.lineTo(tip, cy);
  ctx.lineTo(tip - along * size, cy + size);
  ctx.lineTo(tip - along * size, cy + size * 0.3);
  ctx.lineTo(tail, cy + size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Verge planting. Seeded on the profile so the picture never shuffles. */
function drawTrees(
  ctx: CanvasRenderingContext2D, theme: Theme, width: number,
  y: (offset: number) => number, inner: number, verge: number, scale: number, seed: number,
): void {
  const rng = new Mulberry32(Math.imul(seed, 2654435761) + 17);
  const spacing = Math.max(16, 13 * scale);
  for (const sign of [-1, 1] as const) {
    for (let x = spacing * 0.5; x < width + spacing; x += spacing) {
      // Same sizing rule as the map: crowns scaled to the verge and centred in it,
      // so a narrow verge gets small trees rather than trees over the carriageway.
      const r = Math.min(2.6, verge * 0.6) * (0.72 + rng.next() * 0.5);
      const off = verge * 0.55 + 0.6 + (rng.next() - 0.5) * verge * 0.3;
      const cx = x + (rng.next() - 0.5) * spacing * 0.4;
      paintTree(ctx, theme, cx, y(sign * (inner + off)), Math.max(1.5, r * scale));
    }
  }
}

/** One tree: a crown with a darker rim, flat like everything else. */
export function paintTree(
  ctx: CanvasRenderingContext2D, theme: Theme, x: number, y: number, r: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = theme.treeCrown;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.22, y - r * 0.22, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = theme.treeHighlight;
  ctx.fill();
}
