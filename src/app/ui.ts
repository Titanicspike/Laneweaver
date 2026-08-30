/**
 * Editor UI: plain DOM panels, no framework.
 *
 * The UI never mutates the document directly — it calls into the app, which routes
 * everything through commands so undo covers the panels as well as the canvas.
 */

import { kph, profileHalfWidth, toKph } from '../core/network/model';
import type {
  EditModel, GeoSettings, LandUse, RoadProfile, SpawnMode, ZoneChoice,  Diagnostic,
} from '../core/network/types';
import { tileStats } from '../render/underlayLayer';
import {
  drawRoadPreview, previewWidth, type PreviewBand, type PreviewOptions,
} from '../render/roadPreview';
import type { Tool } from '../editor/tool';
import type { AppStore } from './store';
import { el } from './dom';
import { SignalPanel } from './signalPanel';
import { formatClock, periodOf } from '../core/sim/clock';
import { EXAMPLES } from './examples';

export { el };

export interface AppApi {
  readonly store: AppStore;
  readonly tools: ReadonlyArray<Tool>;
  activeToolId: string;
  activeProfileId: number;
  activeGrade: number;
  showGrid: boolean;
  showDiagnostics: boolean;
  setTool(id: string): void;
  setProfile(id: number): void;
  setGrade(grade: number): void;
  newDocument(): void;
  loadExample(id: string): void;
  setSpawnMode(mode: SpawnMode): void;
  setDayLength(seconds: number): void;
  setStartHour(hour: number): void;
  setZoneChoice(choice: ZoneChoice): void;
  readonly zoneChoice: ZoneChoice;
  save(): void;
  load(file: File): void;
  loadDemo(): void;
  importOsmAt(lat: number, lon: number, miles: number): Promise<void>;
  fitView(): void;
  focusOn(x: number, y: number): void;
  addProfile(base: RoadProfile): void;
  editProfile(id: number, patch: Partial<RoadProfile>): void;
  deleteProfile(id: number): void;
  setRunning(running: boolean): void;
  setSpeed(speed: number): void;
  restartSim(): void;
  setDemandScale(value: number): void;
  setSeed(value: number): void;
  setTerrainEnabled(value: boolean): void;
  regenerateTerrain(): void;
  setUnderlayOpacity(value: number): void;
  toggleUnderlay(): void;
  removeUnderlay(): void;
  updateGeo(patch: Partial<GeoSettings>): void;
  requestRender(): void;
  renderMs(): number;
}

import { MAX_MILES } from './osmImport';
import { stepGrade } from '../editor/grade';

function clamp(v: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000;
}

function panel(id: string, title: string, body: HTMLElement): HTMLElement {
  return el('section', { class: 'panel', id }, el('h2', { text: title }), body);
}

function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field row' }, el('span', { text: label }), input);
}

function numberInput(value: number, step: number, onInput: (v: number) => void, min = 0): HTMLInputElement {
  const input = el('input', {
    type: 'number', value: String(value), step: String(step), min: String(min),
  }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onInput(v);
  });
  return input;
}

/**
 * A canvas showing the road this profile makes. Sized in CSS pixels and backed at
 * device resolution, because a road drawn at half a pixel a lane is a grey smear.
 */
function previewCanvas(
  profile: RoadProfile, width: number, height: number, options: PreviewOptions = {},
): HTMLCanvasElement {
  const canvas = el('canvas', { class: 'preview' }) as HTMLCanvasElement;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRoadPreview(ctx, profile, width, height, options);
  }
  return canvas;
}

/** A labelled stepper: two big buttons and the value between them. */
function stepper(
  label: string, value: string, onStep: (delta: number) => void, hint?: string,
): HTMLElement {
  return el('div', { class: 'stepper', title: hint ?? label },
    el('span', { class: 'label', text: label }),
    el('button', { class: 'step', text: '−', onclick: () => onStep(-1) }),
    el('span', { class: 'value', text: value }),
    el('button', { class: 'step', text: '+', onclick: () => onStep(1) }),
  );
}

const TOOL_KEYS: Record<string, string> = {
  select: 'V', draw: 'R', bulldoze: 'X', zone: 'Z', inspect: 'J', underlay: 'U',
};

/**
 * The day lengths the stepper walks, in seconds. Off, then a day in six minutes up
 * to a day in an hour — fast enough to watch a peak arrive, slow enough to sit in
 * one.
 */
const DAY_LENGTHS = [0, 360, 720, 1440, 2880, 3600];

function nextDayLength(current: number, delta: number): number {
  const i = DAY_LENGTHS.indexOf(current);
  const at = i < 0 ? 3 : i;
  return DAY_LENGTHS[Math.max(0, Math.min(DAY_LENGTHS.length - 1, at + delta))]!;
}

/** What the zone tool can paint, and what each is called on its button. */
const ZONE_CHOICES: [ZoneChoice, string][] = [
  ['residential', 'Houses'],
  ['commercial', 'Shops'],
  ['none', 'Clear'],
];

/** The three land-use choices, in the order the stepper walks them. */
const LAND_USE: (LandUse | undefined)[] = [undefined, 'residential', 'commercial'];
const LAND_USE_LABEL = ['none', 'houses', 'shops'];

function landUseIndex(use: LandUse | undefined): number {
  const i = LAND_USE.indexOf(use);
  return i < 0 ? 0 : i;
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/** The spawn modes, in the order the selector lists them. */
const SPAWN_MODES: { id: SpawnMode; label: string; hint: string }[] = [
  {
    id: 'portals', label: 'Every road end',
    hint: 'Traffic enters and leaves wherever the network stops, in proportion to '
      + 'how big the road is. Needs nothing set up',
  },
  {
    id: 'gateways', label: 'Chosen road ends',
    hint: 'Only the ends you mark, and only the way you mark them. Click an end '
      + 'with the junction tool to cycle it. Unmarked ends still do both',
  },
  {
    id: 'landuse', label: 'Houses and shops',
    hint: 'Trips start anywhere along a residential road and finish at a '
      + 'commercial one. Nothing enters from off the map',
  },
  {
    id: 'mixed', label: 'Houses, shops and through traffic',
    hint: 'Trips between the houses and shops, plus traffic passing through from '
      + 'every road end. What a town with a freeway past it sees',
  },
];

function spawnModeHint(mode: SpawnMode): string {
  return SPAWN_MODES.find((m) => m.id === mode)?.hint ?? '';
}

export class Ui {
  readonly root: HTMLElement;
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly profileList: HTMLElement;
  private readonly builderBody: HTMLElement;
  private readonly builderPanel: HTMLElement;
  private readonly palettePanel: HTMLElement;
  private readonly signals: SignalPanel;
  private readonly diagBody: HTMLElement;
  private readonly hudBody: HTMLElement;
  private readonly underlayBody: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly gradeButtons = new Map<number, HTMLButtonElement>();
  private readonly zoneButtons = new Map<ZoneChoice, HTMLButtonElement>();
  private readonly zoneRow = el('div', { class: 'row', style: { marginTop: '8px' } });
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private builderOpen = false;
  private builderBands: PreviewBand[] = [];
  private builderLane: { side: 1 | -1; index: number } | null = null;

  constructor(private readonly app: AppApi, mount: HTMLElement) {
    this.root = mount;
    this.profileList = el('div', { class: 'profile-list' });
    this.builderBody = el('div', { class: 'body' });
    this.diagBody = el('div', { class: 'body' });
    this.hudBody = el('div', { class: 'body' });
    this.underlayBody = el('div', { class: 'body' });
    this.statusEl = el('div', { id: 'status', text: 'Draw a road to begin.' });
    this.playButton = el('button', { class: 'grow', onclick: () => this.app.setRunning(!this.app.store.running) }) as HTMLButtonElement;
    this.builderPanel = panel('builder', 'Road builder', this.builderBody);
    this.signals = new SignalPanel({
      store: app.store,
      requestRender: () => app.requestRender(),
      setStatus: (text) => this.setStatus(text),
    });

    this.palettePanel = panel('palette', 'Road types', el('div', { class: 'body' },
      this.profileList,
      el('div', { class: 'row', style: { marginTop: '8px' } },
        el('button', { class: 'grow', text: 'Duplicate', onclick: () => this.duplicateActive() }),
        el('button', { class: 'grow', text: 'Edit', onclick: () => this.toggleBuilder() }),
      ),
    ));

    mount.append(
      this.buildToolbar(),
      this.palettePanel,
      this.builderPanel,
      this.signals.root,
      panel('underlay', 'Reference imagery', this.underlayBody),
      panel('inspector', 'Diagnostics', this.diagBody),
      this.buildControls(),
      panel('hud', 'Statistics', this.hudBody),
      this.statusEl,
    );

    this.refresh();
  }

  private buildToolbar(): HTMLElement {
    const tools = el('div', { class: 'tools' });
    for (const tool of this.app.tools) {
      const button = el('button', {
        onclick: () => this.app.setTool(tool.id),
        title: tool.hint,
      }, el('span', { text: tool.name }), el('kbd', { text: TOOL_KEYS[tool.id] ?? '' })) as HTMLButtonElement;
      this.toolButtons.set(tool.id, button);
      tools.append(button);
    }

    // Three buttons, but a level is not three-valued: a bridge over a bridge is
    // level 2. Ground resets, and Bridge/Tunnel step one level further in their own
    // direction each time — so the deeper stacks are reachable with the mouse as
    // well as with Tab, and the button says which level you are on.
    const grades = el('div', { class: 'row', style: { marginTop: '8px' } });
    for (const [dir, label] of [[-1, 'Tunnel'], [0, 'Ground'], [1, 'Bridge']] as [number, string][]) {
      const button = el('button', {
        class: 'grow',
        text: label,
        title: dir === 0 ? 'Back to ground level'
          : `${label} — click again to go one level further (Tab / Shift+Tab)`,
        onclick: () => {
          const now = this.app.activeGrade;
          // Coming from the other side of the ground, the first click means "make it
          // a bridge", not "one step from where the tunnel was".
          this.app.setGrade(dir === 0 ? 0
            : Math.sign(now) === dir ? stepGrade(now, dir) : dir);
        },
      }) as HTMLButtonElement;
      this.gradeButtons.set(dir, button);
      grades.append(button);
    }

    // Zoning, shown only while the zone tool is in hand. A visible picker rather
    // than three keyboard shortcuts, because "how do I put houses on this street"
    // should be answerable by looking at the screen.
    for (const [choice, label] of ZONE_CHOICES) {
      const button = el('button', {
        class: 'grow', text: label, title: `Paint roads as ${label.toLowerCase()}`,
        onclick: () => this.app.setZoneChoice(choice),
      }) as HTMLButtonElement;
      this.zoneButtons.set(choice, button);
      this.zoneRow.append(button);
    }

    const fileRow = el('div', { class: 'row', style: { marginTop: '8px' } },
      el('button', { class: 'grow ghost', text: 'New', onclick: () => this.app.newDocument() }),
      el('button', { class: 'grow ghost', text: 'Save', onclick: () => this.app.save() }),
      el('button', { class: 'grow ghost', text: 'Open', onclick: () => this.openFile() }),
    );
    const viewRow = el('div', { class: 'row', style: { marginTop: '6px' } },
      el('button', { class: 'grow ghost', text: 'Fit', onclick: () => this.app.fitView() }),
      el('button', { class: 'grow ghost', text: 'Demo', onclick: () => this.app.loadDemo() }),
    );
    // A menu rather than a button each: five example maps as five more small
    // buttons is exactly the crowding the toolbar already suffers from.
    const examples = el('select', { class: 'grow', title: 'Load an example map' }) as HTMLSelectElement;
    examples.append(el('option', { value: '' }, 'Open an example map...'));
    for (const ex of EXAMPLES) examples.append(el('option', { value: ex.id, title: ex.about }, ex.name));
    examples.addEventListener('change', () => {
      const id = examples.value;
      examples.value = '';
      if (id) this.app.loadExample(id);
    });
    const exampleRow = el('div', { class: 'row', style: { marginTop: '6px' } }, examples);

    return panel('toolbar', 'Laneweaver',
      el('div', { class: 'body' }, tools, grades, this.zoneRow, fileRow, viewRow, exampleRow,
        this.importRow()));
  }

  /**
   * Import a square of the real world.
   *
   * A coordinate and a size, because that is how somebody says where they mean —
   * and paste-able, since a coordinate copied from a map is two numbers with a
   * comma between them. The size is capped: the download is somebody else's
   * server's time, and a whole city is more road than anyone can edit.
   */
  private importRow(): HTMLElement {
    const where = el('input', {
      type: 'text', class: 'grow', value: '37.3303843, -122.0490306',
      title: 'Latitude and longitude, as you would paste them from a map',
    }) as HTMLInputElement;
    const miles = el('input', {
      type: 'number', value: '2', step: '0.5', min: '0.1', max: String(MAX_MILES),
      style: { width: '52px' }, title: 'Size of the square, in miles',
    }) as HTMLInputElement;
    const go = el('button', { class: 'ghost', text: 'Import' }) as HTMLButtonElement;
    go.addEventListener('click', () => {
      const [lat, lon] = where.value.split(/[ ,]+/).map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        this.setStatus('Give a latitude and a longitude, like 37.3304, -122.0490.');
        return;
      }
      go.disabled = true;
      void this.app.importOsmAt(lat, lon, Number(miles.value) || 2).finally(() => {
        go.disabled = false;
      });
    });
    return el('div', { class: 'row', style: { marginTop: '6px' } }, where, miles, go);
  }

  private openFile(): void {
    const input = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) this.app.load(file);
    });
    input.click();
  }

  /**
   * Where traffic comes from. Held rather than rebuilt, so changing it does not
   * rebuild the panel under the cursor that changed it.
   */
  private readonly spawnModeSelect = el('select', { class: 'grow' }) as HTMLSelectElement;
  private readonly spawnModeHint = el('div', { class: 'hint' });
  /** Time of day: how fast the day runs, and where in it we are. */
  private readonly clockRow = el('div', { class: 'row', style: { marginTop: '6px' } });

  private buildControls(): HTMLElement {
    const modes = this.spawnModeSelect;
    for (const mode of SPAWN_MODES) {
      modes.append(el('option', { value: mode.id, title: mode.hint }, mode.label));
    }
    modes.value = this.app.store.model.settings.spawnMode;
    modes.addEventListener('change', () => {
      this.app.setSpawnMode(modes.value as SpawnMode);
    });
    const speed = el('input', {
      type: 'range', min: '0', max: '3', step: '1', value: '1',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        this.app.setSpeed([0.25, 1, 4, 16][v]);
      },
    });
    const demand = el('input', {
      type: 'range', min: '0', max: '250', step: '5', value: '100',
      oninput: (e: Event) => {
        this.app.setDemandScale(Number((e.target as HTMLInputElement).value) / 100);
      },
    });
    const seed = numberInput(this.app.store.model.settings.seed, 1, (v) => this.app.setSeed(Math.round(v)));

    const body = el('div', { class: 'body' },
      el('div', { class: 'row' },
        this.playButton,
        el('button', { text: 'Restart', onclick: () => this.app.restartSim() }),
      ),
      el('div', { class: 'row' }, el('span', { class: 'field-label', text: 'Speed' }), speed),
      el('div', { class: 'row' }, el('span', { class: 'field-label', text: 'Traffic' }), demand),
      el('div', { class: 'row' },
        el('span', { class: 'field-label', text: 'Source' }),
        this.spawnModeSelect,
      ),
      this.spawnModeHint,
      this.clockRow,
      el('div', { class: 'row' },
        field('Seed', seed),
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox',
            onchange: (e: Event) => this.app.setTerrainEnabled((e.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Terrain' }),
        ),
        el('button', { class: 'ghost', text: 'Regenerate', onclick: () => this.app.regenerateTerrain() }),
      ),
      el('div', { class: 'row' },
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox', checked: 'checked',
            onchange: (e: Event) => {
              this.app.showGrid = (e.target as HTMLInputElement).checked;
              this.app.requestRender();
            },
          }),
          el('span', { text: 'Grid' }),
        ),
        el('label', { class: 'check' },
          el('input', {
            type: 'checkbox', checked: 'checked',
            onchange: (e: Event) => {
              this.app.showDiagnostics = (e.target as HTMLInputElement).checked;
              this.app.requestRender();
            },
          }),
          el('span', { text: 'Problem markers' }),
        ),
      ),
    );
    return panel('controls', 'Simulation', body);
  }

  private duplicateActive(): void {
    const profile = this.app.store.model.profiles.find((p) => p.id === this.app.activeProfileId);
    if (profile) this.app.addProfile(profile);
  }

  private toggleBuilder(): void {
    this.builderOpen = !this.builderOpen;
    this.applyPanelSlot();
    this.refresh();
  }

  /**
   * The road list, the road editor and the signal panel share one corner. Showing
   * two of them stacks one behind the other and reads as a rendering fault, so
   * exactly one is up: the signal panel while the junction tool is in hand, the
   * editor while it is open, and the road list otherwise.
   */
  private applyPanelSlot(): void {
    const signals = this.app.activeToolId === 'inspect';
    const builder = !signals && this.builderOpen;
    this.signals.root.style.display = signals ? 'block' : 'none';
    this.builderPanel.style.display = builder ? 'block' : 'none';
    this.palettePanel.style.display = signals || builder ? 'none' : 'block';
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.style.opacity = '1';
    globalThis.clearTimeout(this.statusTimer);
    this.statusTimer = globalThis.setTimeout(() => {
      this.statusEl.style.opacity = '0.45';
    }, 4000);
  }

  /** Rebuilds every panel that depends on document or network state. */
  refresh(): void {
    const { store } = this.app;
    for (const [id, button] of this.toolButtons) button.classList.toggle('active', id === this.app.activeToolId);
    const level = this.app.activeGrade;
    for (const [dir, button] of this.gradeButtons) {
      button.classList.toggle('active', dir === 0 ? level === 0 : Math.sign(level) === dir);
      // The number only appears once there is more than one level in that direction,
      // because on almost every document there is not and a "1" there is noise.
      const deep = Math.sign(level) === dir && Math.abs(level) > 1;
      button.textContent = deep
        ? `${dir > 0 ? 'Bridge' : 'Tunnel'} ${Math.abs(level)}`
        : dir > 0 ? 'Bridge' : dir < 0 ? 'Tunnel' : 'Ground';
    }
    // The grade row belongs to drawing and the zone row to zoning; showing both at
    // once asks the reader to work out which one the current tool listens to.
    const zoning = this.app.activeToolId === 'zone';
    this.zoneRow.style.display = zoning ? '' : 'none';
    for (const [choice, button] of this.zoneButtons) {
      button.classList.toggle('active', choice === this.app.zoneChoice);
    }
    this.renderClock();
    // The spawn mode belongs to the document, so opening one has to move the
    // control — otherwise the town's own traffic runs while the panel says it is
    // coming in off the map.
    this.spawnModeSelect.value = store.model.settings.spawnMode;
    this.spawnModeHint.textContent = spawnModeHint(store.model.settings.spawnMode);
    this.playButton.textContent = store.running ? 'Pause' : 'Play';
    this.playButton.classList.toggle('active', store.running);
    this.renderProfiles(store.model);
    if (this.builderOpen) this.renderBuilder(store.model);
    this.renderDiagnostics();
    this.renderUnderlay();
    this.applyPanelSlot();
    this.signals.refresh(this.app.activeToolId === 'inspect');
  }

  /**
   * The time-of-day controls.
   *
   * Rebuilt rather than updated in place, because the row's shape changes: with the
   * clock off there is nothing to say about the hour, and a stepper that reads
   * `--:--` invites the reader to work out why.
   */
  private renderClock(): void {
    const settings = this.app.store.model.settings;
    const sim = this.app.store.sim;
    const on = settings.dayLength > 0;
    this.clockRow.replaceChildren();
    this.clockRow.append(
      stepper(
        'Day',
        on ? `${Math.round(settings.dayLength / 60)} min` : 'off',
        (d) => this.app.setDayLength(nextDayLength(settings.dayLength, d)),
        'How long a whole day takes. Off generates flat demand, which is what you '
        + 'want when measuring one junction rather than watching a town',
      ),
    );
    if (on) {
      const hour = sim.timeOfDay;
      this.clockRow.append(
        stepper(
          'Time',
          hour < 0 ? '--:--' : formatClock(hour),
          (d) => this.app.setStartHour((hour < 0 ? 0 : hour) + d),
          'Move the clock. The traffic already on the road stays where it is',
        ),
      );
    }
  }

  /** Advances the panel's live phase readout; called once a frame. */
  tickSignals(): void {
    if (this.app.activeToolId === 'inspect') this.signals.tick();
  }

  private renderUnderlay(): void {
    const model = this.app.store.model;
    this.underlayBody.replaceChildren();

    if (model.underlay) {
      const opacity = el('input', {
        type: 'range', min: '5', max: '100', step: '5',
        value: String(Math.round(model.underlay.opacity * 100)),
        oninput: (e: Event) => this.app.setUnderlayOpacity(Number((e.target as HTMLInputElement).value) / 100),
      });
      this.underlayBody.append(
        el('div', { class: 'row' }, el('span', { class: 'field-label', text: 'Opacity' }), opacity),
        el('div', { class: 'row' },
          el('button', {
            class: 'grow',
            text: model.underlay.visible ? 'Hide' : 'Show',
            onclick: () => this.app.toggleUnderlay(),
          }),
          el('button', { class: 'grow', text: 'Remove', onclick: () => this.app.removeUnderlay() }),
        ),
      );
    } else {
      this.underlayBody.append(el('div', { class: 'empty', text: 'Drop an image on the canvas to trace over it.' }));
    }

    const geo = model.geo;
    const url = el('input', { type: 'text', value: geo.tileUrl, placeholder: 'https://.../{z}/{x}/{y}.jpg' }) as HTMLInputElement;
    url.addEventListener('change', () => this.app.updateGeo({ tileUrl: url.value.trim() }));

    this.underlayBody.append(
      el('hr'),
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', ...(geo.enabled ? { checked: 'checked' } : {}),
          onchange: (e: Event) => this.app.updateGeo({ enabled: (e.target as HTMLInputElement).checked }),
        }),
        el('span', { text: 'Satellite tiles' }),
      ),
      field('Latitude', numberInput(geo.lat, 0.0001, (v) => this.app.updateGeo({ lat: v }), -85)),
      field('Longitude', numberInput(geo.lon, 0.0001, (v) => this.app.updateGeo({ lon: v }), -180)),
      field('Tile URL', url),
      el('div', {
        class: 'hint',
        text: 'Supply your own XYZ tile template, and check the provider terms before using their imagery.',
      }),
    );
  }

  private renderProfiles(model: EditModel): void {
    this.profileList.replaceChildren();
    for (const profile of model.profiles) {
      const lanes = `${profile.lanesForward}+${profile.lanesBackward}`;
      const row = el('div', {
        class: `profile${profile.id === this.app.activeProfileId ? ' selected' : ''}`,
        onclick: () => this.app.setProfile(profile.id),
      },
        // A picture of the road itself, drawn by the same code the map uses. A grey
        // box tells you nothing; this tells you how many lanes, which way they run,
        // whether there is a median and whether it is planted.
        previewCanvas(profile, 64, 32),
        el('div', { class: 'grow' },
          el('div', { class: 'name', text: profile.name }),
          el('div', { class: 'meta', text: `${lanes} lanes · ${Math.round(toKph(profile.speedLimit))} km/h`
            + ` · ${(profileHalfWidth(profile) * 2).toFixed(1)} m` }),
        ),
      );
      this.profileList.append(row);
    }
  }

  /**
   * The road editor: the road itself, drawn, with the controls arranged around it.
   *
   * Everything that changes the picture is a click on or beside the picture — add a
   * lane to this side, widen the median, plant the verge — and the drawing updates
   * under the cursor. The numbers are still there, but they are a readout rather
   * than the thing you have to reason in.
   */
  private renderBuilder(model: EditModel): void {
    const profile = model.profiles.find((p) => p.id === this.app.activeProfileId);
    this.builderBody.replaceChildren();
    if (!profile) return;
    const patch = (p: Partial<RoadProfile>): void => this.app.editProfile(profile.id, p);
    const spec = profile.rampSpec ?? { accelLaneLength: 220, decelLaneLength: 160, taperLength: 75 };

    const name = el('input', { type: 'text', value: profile.name }) as HTMLInputElement;
    name.addEventListener('change', () => patch({ name: name.value || 'Road' }));

    // Wide enough to show the dashes running, tall enough for a 6-lane road.
    const WIDTH = 240;
    const height = Math.max(76, Math.min(150, previewWidth(profile, true) * 4.6));
    const canvas = previewCanvas(profile, WIDTH, height, {
      direction: true,
      trees: true,
      highlight: this.builderLane,
    });
    canvas.addEventListener('click', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const y = ((e.clientY - rect.top) / rect.height) * height;
      const band = this.builderBands.find((b) => b.kind === 'lane' && y >= b.y0 && y <= b.y1);
      this.builderLane = band && band.side !== 0 ? { side: band.side, index: band.index } : null;
      this.refresh();
    });
    {
      const ctx = canvas.getContext('2d');
      this.builderBands = ctx
        ? drawRoadPreview(ctx, profile, WIDTH, height, {
          direction: true, trees: true, highlight: this.builderLane,
        })
        : [];
    }

    // Lanes, added and removed on the side you point at.
    const laneRow = (label: string, count: number, key: 'lanesForward' | 'lanesBackward'): HTMLElement =>
      stepper(label, `${count}`, (d) => patch({ [key]: Math.max(0, Math.min(8, count + d)) }),
        'Lanes travelling this way');

    const selected = this.builderLane;
    const selectedText = selected
      ? `Lane ${selected.index + 1} of the ${selected.side === 1 ? 'forward' : 'backward'} group`
      : 'Click a lane to pick it out.';

    const parts: (Node | null)[] = [
      field('Name', name),
      el('div', { class: 'preview-frame' }, canvas),
      el('div', { class: 'hint', text: selectedText }),
      el('div', { class: 'steppers' },
        laneRow('Forward', profile.lanesForward, 'lanesForward'),
        laneRow('Backward', profile.lanesBackward, 'lanesBackward'),
        stepper('Lane width', `${profile.laneWidth.toFixed(2)} m`,
          (d) => patch({ laneWidth: clamp(profile.laneWidth + d * 0.1, 2.4, 6) })),
        stepper('Median', `${profile.median.toFixed(1)} m`,
          (d) => patch({ median: clamp(profile.median + d * 0.5, 0, 30) }),
          'A median wide enough to hold a turn bay gets one at every junction'),
        stepper('Shoulder', `${profile.shoulder.toFixed(1)} m`,
          (d) => patch({ shoulder: clamp(profile.shoulder + d * 0.2, 0, 6) })),
        stepper('Speed', `${Math.round(toKph(profile.speedLimit))} km/h`,
          (d) => patch({ speedLimit: kph(clamp(Math.round(toKph(profile.speedLimit)) + d * 5, 10, 160)) })),
        stepper('Trees', profile.verge ? `${profile.verge.toFixed(1)} m` : 'none',
          (d) => patch({ verge: clamp((profile.verge ?? 0) + d * 1, 0, 25) }),
          'Planted verge either side. Decoration only — traffic never sees it'),
        // A stepper rather than a dropdown, because everything else here is one and
        // three values do not earn a different control.
        stepper('Land use', LAND_USE_LABEL[landUseIndex(profile.landUse)],
          (d) => patch({ landUse: LAND_USE[wrap(landUseIndex(profile.landUse) + d, 3)] }),
          'Where the land-use traffic mode starts trips and ends them. '
          + 'Also what gets drawn beside the road'),
      ),
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', ...(profile.isRamp ? { checked: 'checked' } : {}),
          onchange: (e: Event) => patch({ isRamp: (e.target as HTMLInputElement).checked }),
        }),
        el('span', { text: 'Use as a ramp' }),
      ),
      profile.isRamp
        ? el('div', { class: 'steppers' },
          stepper('Accel lane', `${spec.accelLaneLength} m`,
            (d) => patch({ rampSpec: { ...spec, accelLaneLength: clamp(spec.accelLaneLength + d * 10, 40, 600) } })),
          stepper('Decel lane', `${spec.decelLaneLength} m`,
            (d) => patch({ rampSpec: { ...spec, decelLaneLength: clamp(spec.decelLaneLength + d * 10, 40, 600) } })),
          stepper('Taper', `${spec.taperLength} m`,
            (d) => patch({ rampSpec: { ...spec, taperLength: clamp(spec.taperLength + d * 5, 15, 200) } })),
        )
        : null,
      el('div', { class: 'row' },
        el('button', { class: 'grow', text: 'Close', onclick: () => this.toggleBuilder() }),
        el('button', {
          class: 'grow', text: 'Delete',
          onclick: () => this.app.deleteProfile(profile.id),
        }),
      ),
      el('div', { class: 'hint', text: 'Changes apply to every road using this type.' }),
    ];
    this.builderBody.append(...parts.filter((n): n is Node => n !== null));
  }

  private renderDiagnostics(): void {
    const diagnostics = this.app.store.diagnostics;
    this.diagBody.replaceChildren();
    if (!diagnostics.length) {
      this.diagBody.append(el('div', { class: 'empty', text: 'No problems found.' }));
      return;
    }
    const list = el('div', { class: 'diag' });
    const order = { error: 0, warning: 1, info: 2 };
    // Grouped by what the problem *is*, not listed one per occurrence. A drawn
    // document has a handful and a list is right; an imported city has six hundred,
    // four hundred of which are the same sentence, and a list of those says only
    // that something is wrong somewhere. Clicking still goes to one of them.
    const groups = new Map<string, { severity: Diagnostic['severity']; message: string; items: Diagnostic[] }>();
    for (const d of diagnostics) {
      const key = `${d.severity}|${d.code}`;
      const g = groups.get(key);
      if (g) g.items.push(d);
      else groups.set(key, { severity: d.severity, message: d.message, items: [d] });
    }
    const sorted = [...groups.values()].sort(
      (a, b) => order[a.severity] - order[b.severity] || b.items.length - a.items.length);
    let shown = 0;
    for (const g of sorted) {
      if (shown++ >= 24) break;
      let at = 0;
      list.append(el('div', {
        class: 'item',
        title: g.items.length > 1 ? 'Click to visit each one in turn' : undefined,
        onclick: () => {
          // Round the group, one per click, so a repeated problem can be walked.
          const d = g.items[at++ % g.items.length];
          if (d.x !== undefined && d.y !== undefined) this.app.focusOn(d.x, d.y);
        },
      },
      el('div', { class: `dot ${g.severity}` }),
      el('div', { class: 'msg', text: g.items.length > 1 ? `${g.message} (${g.items.length})` : g.message })));
    }
    if (sorted.length > shown) {
      list.append(el('div', { class: 'empty', text: `and ${sorted.length - shown} more kinds` }));
    }
    this.diagBody.append(list);
  }

  /** Called every frame; cheap enough to rewrite the numbers each time. */
  updateStats(): void {
    const { store } = this.app;
    const m = store.sim.metrics;
    const net = store.network.stats;
    const hour = store.sim.timeOfDay;
    const rows: [string, string][] = [
      ['Vehicles', String(m.vehicles)],
      ['Mean speed', `${(m.meanSpeed * 3.6).toFixed(0)} km/h`],
      ['Arrived', String(m.arrived)],
      ['Waiting to enter', String(m.queued)],
      ['Sim time', formatTime(store.sim.time)],
      ['Tick', `${m.simTimeMs.toFixed(2)} ms`],
      ['Frame', `${this.app.renderMs().toFixed(2)} ms`],
      ['Lanes', `${net.lanes} + ${net.connectors}`],
      ['Junctions', String(net.junctions)],
      ['Compile', `${net.compileMs.toFixed(1)} ms`],
    ];
    // The clock goes at the top, because when it is running it is the thing that
    // explains every other number on the panel.
    if (hour >= 0) rows.unshift(['Time of day', `${formatClock(hour)} · ${periodOf(hour)}`]);
    // Only worth a row once it has happened: a driver who could not get across in
    // time carries on to the next exit, which is interesting when it happens and
    // noise when it has not.
    if (m.missedExits > 0) rows.push(['Missed exits', String(m.missedExits)]);
    if (m.collisions > 0) rows.push(['Collisions', String(m.collisions)]);
    if (store.model.geo.enabled && store.model.geo.tileUrl) {
      rows.push(['Map tiles', `${tileStats.drawn}/${tileStats.requested} at z${tileStats.zoom}`]);
    }
    const table = el('table', { class: 'stats' });
    for (const [k, v] of rows) table.append(el('tr', {}, el('td', { text: k }), el('td', { text: v })));
    this.hudBody.replaceChildren(table);
  }
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
