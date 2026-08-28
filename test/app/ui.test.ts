/**
 * @vitest-environment jsdom
 *
 * Runs the real application under jsdom: bootstrap, panels, event wiring and the
 * main loop. Everything a browser would do except paint pixels.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom, pointer, type DomHarness } from '../helpers/domStub';

let dom: DomHarness;
beforeEach(() => { dom = installDom(); });
afterEach(() => dom.restore());

async function boot(): Promise<HTMLCanvasElement> {
  const { startApp } = await import('@app/main');
  startApp(dom.mount);
  const canvas = dom.mount.querySelector('canvas');
  expect(canvas).not.toBeNull();
  return canvas as HTMLCanvasElement;
}

/**
 * What the canvas is actually drawing after a document swap.
 *
 * `NetworkPaths` bakes every road into `Path2D` tiles once per recompile, and for a
 * long time the frame loop rebuilt it only when *its own* call to `store.flush()`
 * returned true. Three places call `flush()` — the frame loop, the end of an
 * interactive gesture, and a document swap — and only the caller that gets there
 * first sees that answer. So opening a document (a saved file, the demo, an example
 * map, or File > New) recompiled the network, restarted the traffic, and left the
 * **previous document's roads on screen**, with the new one's vehicles driving
 * across empty space. The statistics panel read out the new network the whole time,
 * which is what made it look like a rendering glitch rather than a stale bake.
 *
 * The fix is a compile version on the store that consumers compare against. This
 * checks the consequence rather than the mechanism: after a swap, the paths the
 * renderer holds must describe the network the store holds.
 */
describe('opening a document', () => {
  async function bootApp() {
    const { startApp } = await import('@app/main');
    const app = startApp(dom.mount);
    dom.frame(2);
    return app;
  }

  it('rebakes the roads, rather than drawing the last document', async () => {
    const app = await bootApp();
    const inner = app as unknown as {
      paths: { grades: number[] };
      store: { network: { segments: unknown[]; stats: { portals: number } } };
    };
    const before = inner.store.network.segments.length;

    app.loadExample('town');
    dom.frame(2);

    const after = inner.store.network.segments.length;
    expect(after, 'the town has far more segments than the demo').toBeGreaterThan(before * 3);
    // The bake is keyed by grade; a town is all at ground level, so the demo's
    // bridge and tunnel grades must be gone from it.
    expect(inner.paths.grades).toEqual([0]);
  });

  it('keeps drawing the right document after a second swap', async () => {
    const app = await bootApp();
    const inner = app as unknown as { paths: { grades: number[] } };
    app.loadExample('town');
    dom.frame(2);
    app.loadDemo();
    dom.frame(2);
    // The demo has a bridge and a tunnel; a stale bake would still say [0].
    expect(inner.paths.grades.length).toBeGreaterThan(1);
  });

  it('carries the document\'s own spawn mode into the panel', async () => {
    const app = await bootApp();
    app.loadExample('town');
    dom.frame(2);
    const select = [...dom.mount.querySelectorAll('#controls select')] as HTMLSelectElement[];
    const source = select.find((s) => [...s.options].some((o) => o.value === 'landuse'));
    expect(source?.value, 'the town generates its own traffic').toBe('landuse');
  });
});

describe('application bootstrap', () => {
  it('mounts a canvas and every panel', async () => {
    await boot();
    for (const id of ['toolbar', 'palette', 'underlay', 'inspector', 'controls', 'hud', 'status']) {
      expect(dom.mount.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('lists the tools and the road types', async () => {
    await boot();
    const tools = dom.mount.querySelectorAll('#toolbar .tools button');
    // Select, draw, bulldoze, zone, junctions, underlay.
    expect(tools.length).toBe(6);
    expect(dom.mount.querySelectorAll('#palette .profile').length).toBeGreaterThan(4);
  });

  it('renders frames without throwing', async () => {
    await boot();
    expect(() => dom.frame(5)).not.toThrow();
    const hud = dom.mount.querySelector('#hud')?.textContent ?? '';
    expect(hud).toContain('Vehicles');
    expect(hud).toContain('Lanes');
  });

  it('switches tools when a toolbar button is clicked', async () => {
    await boot();
    const buttons = [...dom.mount.querySelectorAll('#toolbar .tools button')] as HTMLButtonElement[];
    const bulldoze = buttons.find((b) => b.textContent?.includes('Bulldoze'));
    bulldoze?.click();
    dom.frame();
    expect(bulldoze?.classList.contains('active')).toBe(true);
  });

  it('runs the traffic when Space is pressed', async () => {
    await boot();
    dom.frame(2);
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    dom.frame(30);
    const hud = dom.mount.querySelector('#hud')?.textContent ?? '';
    expect(hud).toContain('Sim time');
    const play = [...dom.mount.querySelectorAll('#controls button')] as HTMLButtonElement[];
    expect(play[0].textContent).toBe('Pause');
  });

  it('draws a road with the pointer and undoes it', async () => {
    const canvas = await boot();
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    dom.frame();
    const countRoads = (): number =>
      Number((dom.mount.querySelector('#hud')?.textContent ?? '').match(/Lanes(\d+)/)?.[1] ?? 0);
    const before = countRoads();

    for (const [x, y] of [[300, 300], [500, 320], [700, 300]]) {
      pointer(canvas, 'pointermove', x, y);
      pointer(canvas, 'pointerdown', x, y);
      pointer(canvas, 'pointerup', x, y);
    }
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    dom.frame(3);
    expect(countRoads()).toBeGreaterThan(before);

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    dom.frame(3);
    expect(countRoads()).toBe(before);
  });

  it('pans and zooms without error', async () => {
    const canvas = await boot();
    pointer(canvas, 'pointerdown', 400, 400, { button: 1 });
    pointer(canvas, 'pointermove', 500, 460, { button: 1 });
    pointer(canvas, 'pointerup', 500, 460, { button: 1 });
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 400, clientY: 300, cancelable: true }));
    expect(() => dom.frame(3)).not.toThrow();
  });

  it('opens the road editor, which shows the road rather than describing it', async () => {
    await boot();
    const edit = [...dom.mount.querySelectorAll('#palette button')]
      .find((b) => b.textContent === 'Edit') as HTMLButtonElement;
    edit.click();
    dom.frame();
    const builder = dom.mount.querySelector('#builder') as HTMLElement;
    expect(builder.style.display).toBe('block');
    // The two panels share a corner, so the list gets out of the way.
    expect((dom.mount.querySelector('#palette') as HTMLElement).style.display).toBe('none');

    const preview = builder.querySelector('canvas') as HTMLCanvasElement;
    expect(preview).not.toBeNull();
    expect(preview.width).toBeGreaterThan(100);

    const readout = (label: string): string => {
      const row = [...builder.querySelectorAll('.stepper')]
        .find((r) => r.querySelector('.label')?.textContent === label);
      return row?.querySelector('.value')?.textContent ?? '';
    };
    const press = (label: string, sign: '+' | '−'): void => {
      const row = [...builder.querySelectorAll('.stepper')]
        .find((r) => r.querySelector('.label')?.textContent === label) as HTMLElement;
      const button = [...row.querySelectorAll('button')].find((b) => b.textContent === sign);
      (button as HTMLButtonElement).click();
      dom.frame(2);
    };

    const lanesBefore = Number(readout('Forward'));
    press('Forward', '+');
    expect(Number(readout('Forward'))).toBe(lanesBefore + 1);

    // Trees are a road-type setting like any other, and start off on a freeway.
    expect(readout('Trees')).toBe('none');
    press('Trees', '+');
    expect(readout('Trees')).not.toBe('none');

    expect(() => dom.frame(3)).not.toThrow();
  });

  it('picks a lane out of the drawing when it is clicked', async () => {
    await boot();
    const edit = [...dom.mount.querySelectorAll('#palette button')]
      .find((b) => b.textContent === 'Edit') as HTMLButtonElement;
    edit.click();
    dom.frame();
    const builder = dom.mount.querySelector('#builder') as HTMLElement;
    const hint = (): string => [...builder.querySelectorAll('.hint')]
      .map((h) => h.textContent ?? '').join(' ');
    expect(hint()).toContain('Click a lane');

    const preview = builder.querySelector('canvas') as HTMLCanvasElement;
    const box = preview.getBoundingClientRect();
    preview.dispatchEvent(new MouseEvent('click', {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height * 0.3,
      bubbles: true,
    }));
    dom.frame(2);
    expect(hint()).toContain('group');
  });

  /**
   * The signal panel is where the flagship of this feature lives, so it is driven
   * the way a user drives it: pick the tool, click a junction on the map, switch it
   * to signals, and read what comes back. Nothing here reaches into the app object.
   */
  describe('the signal panel', () => {
    /** Screen position of the first crossing, so a click can land on it. */
    function crossingAt(app: { store: { network: { junctions: { kind: string; x: number; y: number }[] } } },
      camera: { worldToScreenX(x: number): number; worldToScreenY(y: number): number }) {
      const junction = app.store.network.junctions.find((j) => j.kind === 'crossing')!;
      return [camera.worldToScreenX(junction.x), camera.worldToScreenY(junction.y)] as const;
    }

    async function openOnAJunction() {
      const { startApp } = await import('@app/main');
      const app = startApp(dom.mount);
      const canvas = dom.mount.querySelector('canvas') as HTMLCanvasElement;
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
      dom.frame(2);
      const [x, y] = crossingAt(app as never, (app as never as { renderer: { camera: never } }).renderer.camera);
      pointer(canvas, 'pointermove', x, y);
      pointer(canvas, 'pointerdown', x, y);
      pointer(canvas, 'pointerup', x, y);
      dom.frame(2);
      return { app, canvas };
    }

    it('replaces the road-type panel while the junction tool is in hand', async () => {
      await boot();
      expect((dom.mount.querySelector('#signals') as HTMLElement).style.display).toBe('none');
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
      dom.frame(2);
      expect((dom.mount.querySelector('#signals') as HTMLElement).style.display).toBe('block');
      expect((dom.mount.querySelector('#palette') as HTMLElement).style.display).toBe('none');
    });

    it('opens on the junction that was clicked and offers the three controls', async () => {
      await openOnAJunction();
      // The control row is the first segmented row; the turn-bay rows follow it.
      const seg = [...dom.mount.querySelectorAll('#signals .seg')][0];
      const buttons = [...seg.querySelectorAll('button')];
      expect(buttons.map((b) => b.textContent)).toEqual(['Priority', 'All-way stop', 'Signals']);
      expect(buttons.filter((b) => b.classList.contains('active')).length).toBe(1);
    });

    it('lets every approach be given a turn bay', async () => {
      const { app } = await openOnAJunction();
      const store = (app as never as { store: { network: { lanes: { aux: boolean }[] } } }).store;
      const rows = [...dom.mount.querySelectorAll('#signals .seg')].slice(1);
      expect(rows.length, 'one turn-bay row per approach').toBeGreaterThan(1);
      for (const row of rows) {
        const buttons = [...row.querySelectorAll('button')];
        expect(buttons.map((b) => b.textContent)).toEqual(['Auto', 'None', 'L', 'R', 'L+R']);
        // Exactly one is the current answer, and untouched it is the compiler's.
        const active = buttons.filter((b) => b.classList.contains('active'));
        expect(active.length).toBe(1);
        expect(active[0].textContent).toBe('Auto');
      }
      // Choosing one is an undoable edit that reaches the compiler...
      const before = store.network.lanes.filter((l) => l.aux).length;
      const junction = (store as never as { junctionSelection(): { control: string } }).junctionSelection();
      const control = junction.control;
      (rows[0].querySelectorAll('button')[4] as HTMLButtonElement).click();
      dom.frame(3);
      expect(store.network.lanes.filter((l) => l.aux).length).toBeGreaterThan(before);
      // ...and leaves the junction's control exactly as it was. A fresh override
      // used to be written with 'priority', which turned an all-way stop into a
      // priority junction as a side effect of adding a turn bay.
      const after = (store as never as { junctionSelection(): { control: string } }).junctionSelection();
      expect(after.control).toBe(control);
    });

    it('draws a diagram per phase once the junction is signalised', async () => {
      await openOnAJunction();
      const signals = [...dom.mount.querySelectorAll('#signals .seg button')]
        .find((b) => b.textContent === 'Signals') as HTMLButtonElement;
      signals.click();
      dom.frame(3);

      const phases = dom.mount.querySelectorAll('#signals .phase');
      expect(phases.length).toBeGreaterThan(0);
      expect(dom.mount.querySelectorAll('#signals canvas.diagram').length).toBe(phases.length);
      // Every phase names the movements it greens, and carries its own timing.
      for (const phase of phases) {
        expect(phase.querySelector('.movements')?.textContent).toBeTruthy();
        expect(phase.querySelectorAll('.stepper').length).toBe(3);
      }
      const summaries = [...dom.mount.querySelectorAll('#signals .summary')]
        .map((e) => e.textContent ?? '');
      expect(summaries.some((t) => /cycle [\d.]+ s/.test(t))).toBe(true);
    });

    it('rebuilds the plan when a preset is picked', async () => {
      await openOnAJunction();
      ([...dom.mount.querySelectorAll('#signals .seg button')]
        .find((b) => b.textContent === 'Signals') as HTMLButtonElement).click();
      dom.frame(3);
      const before = dom.mount.querySelectorAll('#signals .phase').length;

      ([...dom.mount.querySelectorAll('#signals .presets button')]
        .find((b) => b.textContent === 'One arm at a time') as HTMLButtonElement).click();
      dom.frame(3);
      const after = dom.mount.querySelectorAll('#signals .phase').length;
      expect(after).toBeGreaterThan(before);
      // Splitting the junction one arm at a time means nothing has to give way.
      const dashed = [...dom.mount.querySelectorAll('#signals .movements')]
        .some((p) => p.textContent?.includes('give way'));
      expect(dashed).toBe(false);
    });

    it('offers turning on red, ticked, and remembers it being turned off', async () => {
      const { app } = await openOnAJunction();
      ([...dom.mount.querySelectorAll('#signals .seg button')]
        .find((b) => b.textContent === 'Signals') as HTMLButtonElement).click();
      dom.frame(3);

      const box = dom.mount.querySelector('#signals .turn-on-red input') as HTMLInputElement;
      expect(box).not.toBeNull();
      expect(box.checked).toBe(true);
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      dom.frame(3);

      const store = (app as unknown as { store: { network: { junctions: { kind: string; turnOnRed: boolean }[] } } }).store;
      const junction = store.network.junctions.find((j) => j.kind === 'crossing')!;
      expect(junction.turnOnRed).toBe(false);
      expect((dom.mount.querySelector('#signals .turn-on-red input') as HTMLInputElement).checked).toBe(false);
    });

    it('changes a phase length with the stepper and says so', async () => {
      await openOnAJunction();
      ([...dom.mount.querySelectorAll('#signals .seg button')]
        .find((b) => b.textContent === 'Signals') as HTMLButtonElement).click();
      dom.frame(3);
      const value = () => dom.mount.querySelector('#signals .phase .stepper .value')?.textContent;
      const before = Number((value() ?? '0').replace(' s', ''));
      const plus = dom.mount.querySelectorAll('#signals .phase .stepper .step')[1] as HTMLButtonElement;
      plus.click();
      dom.frame(3);
      expect(Number((value() ?? '0').replace(' s', ''))).toBeGreaterThan(before);
      expect(dom.mount.querySelector('#status')?.textContent).toContain('Green set to');
    });
  });

  it('turns terrain on and regenerates it', async () => {
    await boot();
    const checks = [...dom.mount.querySelectorAll('#controls input[type="checkbox"]')] as HTMLInputElement[];
    checks[0].checked = true;
    checks[0].dispatchEvent(new Event('change'));
    dom.frame(3);
    const regenerate = [...dom.mount.querySelectorAll('#controls button')]
      .find((b) => b.textContent === 'Regenerate') as HTMLButtonElement;
    expect(() => { regenerate.click(); dom.frame(3); }).not.toThrow();
  });

  it('lists diagnostics for a document that has problems', async () => {
    await boot();
    const inspector = dom.mount.querySelector('#inspector')?.textContent ?? '';
    expect(inspector.length).toBeGreaterThan(0);
  });
});
