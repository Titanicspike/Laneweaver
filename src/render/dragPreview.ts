/**
 * The roads being dragged, drawn straight from their flattened centrelines.
 *
 * Compiling the network and baking it into `Path2D` are both whole-network jobs, and
 * together they run to tens of milliseconds on a town and hundreds on anything
 * larger. Doing that on every frame of a drag *is* the frame, which is what made
 * building roads on a big document feel like five frames a second. So the store
 * gives the rebuild a duty cycle mid-gesture and this draws the difference: a band
 * the width of the road, following the cursor exactly, over the last compiled
 * picture.
 *
 * It is deliberately not a small renderer. No markings, no junctions, no casing —
 * those are what the compiler is for, and guessing at them here would mean two
 * places that decide what a road looks like. What this promises is only where the
 * asphalt is going, which is the question somebody dragging a road is asking.
 */

import type { Camera } from './camera';
import type { Theme } from './theme';
import type { StrokeGeometry } from '../app/store';

/** Minimum on-screen width, so a road being dragged never thins to nothing. */
const MIN_PIXELS = 2;

export function drawDragPreview(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  theme: Theme,
  strokes: StrokeGeometry[],
): void {
  if (!strokes.length) return;
  // `camera.scale` is metres per pixel.
  const scale = camera.scale;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // The asphalt band first, then a centreline over it, so a road being dragged
  // reads the same way as one that has been compiled: a surface with a line down it.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? theme.asphalt : theme.preview;
    ctx.globalAlpha = pass === 0 ? 0.85 : 0.9;
    for (const geom of strokes) {
      const p = geom.points;
      if (p.length < 4) continue;
      ctx.lineWidth = pass === 0
        ? Math.max(geom.halfWidth * 2, MIN_PIXELS * scale)
        : Math.max(0.25, scale);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
    }
  }
  ctx.restore();
}
