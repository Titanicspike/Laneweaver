/**
 * Performance smoke test.
 *
 * Builds a synthetic freeway corridor, fills it to the 5,000-vehicle budget from
 * CLAUDE.md, and asserts the per-tick cost. It also reports compile and render
 * times so a regression in any of the three is visible in one run.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubCanvas } from '../test/helpers/canvasStub';
installCanvasGlobals();

import { compile } from '@core/network/compiler';
import { Simulation } from '@core/sim/sim';
import { Renderer } from '@render/renderer';
import { NetworkPaths } from '@render/networkPaths';
import { autoSmoothHandles, createDocument, issueId, kph, makeControlPoint } from '@core/network/model';
import type { ControlPoint, EditModel, RoadProfile } from '@core/network/types';

const TARGET_VEHICLES = 5000;
/** Budget from CLAUDE.md: 5,000 vehicles, tick under 6 ms. */
const TICK_BUDGET_MS = 6;

function points(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i], coords[i + 1]));
  autoSmoothHandles(out);
  return out;
}

function add(model: EditModel, profile: RoadProfile, cp: ControlPoint[], grade = 0): void {
  for (const p of cp) p.grade = grade;
  model.strokes.push({ id: issueId(model), profileId: profile.id, points: cp });
}

/** Three parallel freeway corridors with ramps between them. */
function syntheticNetwork(): EditModel {
  const model = createDocument(31337);
  const freeway: RoadProfile = {
    id: issueId(model), name: 'Bench freeway', lanesForward: 3, lanesBackward: 3,
    laneWidth: 3.65, speedLimit: kph(110), median: 6, shoulder: 2.5, isRamp: false,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  };
  const ramp: RoadProfile = {
    id: issueId(model), name: 'Bench ramp', lanesForward: 1, lanesBackward: 0,
    laneWidth: 4, speedLimit: kph(85), median: 0, shoulder: 1.2, isRamp: true,
    rampSpec: { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 },
  };
  model.profiles.push(freeway, ramp);

  const LENGTH = 15000;
  for (let c = 0; c < 3; c++) {
    const y = c * 900;
    add(model, freeway, points(0, y, LENGTH / 2, y + 120, LENGTH, y));
    // An on-ramp and an off-ramp every few kilometres.
    for (let k = 1; k < 5; k++) {
      const x = (LENGTH * k) / 5;
      add(model, ramp, points(x - 500, y + 260, x - 200, y + 150, x, y + 30));
      add(model, ramp, points(x + 400, y - 30, x + 700, y - 150, x + 1000, y - 260));
    }
  }
  model.settings.demandScale = 6;
  return model;
}

function fill(sim: Simulation, target: number, limitSeconds: number): number {
  const steps = Math.round(limitSeconds / sim.dt);
  for (let i = 0; i < steps; i++) {
    sim.tick();
    if (sim.store.count >= target) break;
  }
  return sim.store.count;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe('performance', () => {
  const compileStart = performance.now();
  const model = syntheticNetwork();
  const net = compile(model);
  const compileMs = performance.now() - compileStart;

  it('compiles a large network quickly', () => {
    // eslint-disable-next-line no-console
    console.log(
      `compile: ${compileMs.toFixed(1)} ms for ${net.segments.length} segments, ` +
      `${net.stats.lanes} lanes + ${net.stats.connectors} connectors, ` +
      `${(net.stats.totalLaneLength / 1000).toFixed(1)} km of lane`,
    );
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compileMs).toBeLessThan(4000);
  });

  it('ticks 5,000 vehicles inside the budget', () => {
    const sim = new Simulation(net, { seed: 1, maxVehicles: 9000, demandScale: 6 });
    const filled = fill(sim, TARGET_VEHICLES, 2400);
    console.log(`filled to ${filled} vehicles in ${sim.time.toFixed(0)} s of simulated time`);
    expect(filled).toBeGreaterThanOrEqual(TARGET_VEHICLES * 0.9);

    // Warm up, then measure.
    for (let i = 0; i < 100; i++) sim.tick();
    const samples: number[] = [];
    for (let batch = 0; batch < 20; batch++) {
      const start = performance.now();
      for (let i = 0; i < 20; i++) sim.tick();
      samples.push((performance.now() - start) / 20);
    }
    const mid = median(samples);
    const worst = Math.max(...samples);
    console.log(
      `tick: median ${mid.toFixed(2)} ms, worst ${worst.toFixed(2)} ms ` +
      `at ${sim.store.count} vehicles (budget ${TICK_BUDGET_MS} ms)`,
    );
    expect(sim.metrics.collisions).toBe(0);
    expect(mid).toBeLessThan(TICK_BUDGET_MS);
  });

  it('renders a full frame inside a 60 fps budget', () => {
    const sim = new Simulation(net, { seed: 2, maxVehicles: 9000, demandScale: 6 });
    fill(sim, TARGET_VEHICLES, 2400);

    const canvas = new StubCanvas();
    const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
    renderer.camera.fit(net.bounds, 40);
    const paths = new NetworkPaths(net);
    const input = {
      network: net, paths, sim, alpha: 0.5, terrain: null, underlay: null, geo: null,
      showGrid: true, showDiagnostics: false, overlays: [],
    };

    for (let i = 0; i < 5; i++) renderer.render(input);
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      renderer.render(input);
      samples.push(performance.now() - start);
    }
    console.log(
      `render (whole network in view): median ${median(samples).toFixed(2)} ms, ` +
      `${renderer.stats.tiles} tiles, ${renderer.stats.vehicles} vehicles`,
    );

    // Zoomed in, which is the case that has to hit 60 fps.
    renderer.camera.zoom = 1.2;
    renderer.camera.x = 7000;
    renderer.camera.y = 900;
    for (let i = 0; i < 5; i++) renderer.render(input);
    const near: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      renderer.render(input);
      near.push(performance.now() - start);
    }
    const mid = median(near);
    console.log(
      `render (street level): median ${mid.toFixed(2)} ms, ` +
      `${renderer.stats.tiles} tiles, ${renderer.stats.vehicles} vehicles`,
    );
    expect(mid).toBeLessThan(16);
  });

  it('allocates nothing measurable per tick', () => {
    const sim = new Simulation(net, { seed: 4, maxVehicles: 9000, demandScale: 6 });
    fill(sim, 2000, 1200);
    const usage = (): number => {
      const mem = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
      return mem?.memoryUsage?.().heapUsed ?? 0;
    };
    globalThis.gc?.();
    const before = usage();
    for (let i = 0; i < 2000; i++) sim.tick();
    const growth = (usage() - before) / 1024 / 1024;
    console.log(`heap growth over 2,000 ticks: ${growth.toFixed(1)} MB`);
    // Spawning does allocate (routes, driver parameters), so this is a smoke test
    // for runaway per-tick garbage rather than a hard zero.
    expect(growth).toBeLessThan(60);
  });
});
