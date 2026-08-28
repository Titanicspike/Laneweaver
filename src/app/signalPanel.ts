/**
 * The signal panel: a junction's phase plan, edited as a picture.
 *
 * Every phase is a drawing of the junction with the movements that get a green in
 * green and everything else dark, and the way you change a phase is to click the
 * movement you want. That is the whole interaction — no list of lane numbers to
 * decode, and no way to name a movement that does not exist, because the picture is
 * the compiled connectors themselves.
 *
 * A protected left turn is not a checkbox here, because it is not a property of a
 * movement: it is what you get when a left turn is green and the traffic that
 * crosses it is not. So the panel *reports* it — solid means the movement has the
 * junction to itself, dashed means it has to find a gap — and the Protected lefts
 * preset is simply the plan that arranges for it. Nothing can then claim a turn is
 * protected while the traffic behaves otherwise.
 *
 * Timing is steppers rather than typed numbers: signal timing is adjusted by
 * feel against the queue you can see on the map, and a stepper keeps the map under
 * the cursor.
 */

import {
  corridor, crossingThroughPair, movementGroups, presetPhases, protectionOf, PRESET_LABELS,
  type MovementGroup, type SignalPreset,
} from '../core/network/compiler/signals';
import type {
  Approach, EditModel, Junction, JunctionControl, Network, SignalPhaseSpec, SignalPlanSpec,
  TurnLaneChoice,
} from '../core/network/types';
import { junctionOverrideAt } from '../core/network/model';
import {
  setAddedLanes, setJunctionControl, setOptionLane, setRightInRightOut, setSignalPlan,
  setTurnLanes, setTurnOnRed,
} from '../editor/commands';
import { drawSignalDiagram, type SignalDiagram } from '../render/signalDiagram';
import { DARK } from '../render/theme';
import type { AppStore } from './store';
import { el } from './dom';

const CONTROL_LABELS: Record<JunctionControl, string> = {
  priority: 'Priority',
  'allway-stop': 'All-way stop',
  signal: 'Signals',
};

/** Design speed a green wave is timed for: 50 km/h, an arterial's progression. */
const GREEN_WAVE_SPEED = 13.9;

const DIAGRAM_W = 252;
const DIAGRAM_H = 172;

/** Green may be nudged in bigger steps than the intergreen, which is safety timing. */
const STEP = { green: 2, amber: 0.5, allRed: 0.5 };
const LIMITS = { green: [4, 180], amber: [1, 8], allRed: [0, 8] } as const;

export interface SignalPanelHost {
  readonly store: AppStore;
  requestRender(): void;
  setStatus(text: string): void;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

export class SignalPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  /** Phase whose diagram is being hovered, and the movement under the cursor. */
  private hover: { phase: number; key: string } | null = null;
  private live: { phase: number; remaining: number } | null = null;
  private readonly canvases: { canvas: HTMLCanvasElement; diagram: SignalDiagram | null }[] = [];

  constructor(private readonly host: SignalPanelHost) {
    this.body = el('div', { class: 'body' });
    this.root = el('section', { class: 'panel', id: 'signals' },
      el('h2', { text: 'Junction' }), this.body);
  }

  /** The plan the document holds for this junction, or null when it has none. */
  private storedSpec(junction: Junction): SignalPlanSpec | null {
    const override = junctionOverrideAt(
      this.host.store.model.junctions, junction.x, junction.y, junction.radius,
    );
    return override?.signal ?? null;
  }

  /** Whatever is stored, or the compiled plan written back out as a spec. */
  private currentSpec(junction: Junction): SignalPlanSpec {
    return this.specFor(junction);
  }

  private commit(junction: Junction, spec: SignalPlanSpec | null, status: string): void {
    this.host.store.run(setSignalPlan(junction.x, junction.y, spec));
    this.host.setStatus(status);
    this.host.requestRender();
  }

  /** Called every frame while the simulation runs, to show which phase is up. */
  tick(): void {
    const store = this.host.store;
    const junction = store.junctionSelection();
    if (!junction || junction.control !== 'signal' || !junction.signal) {
      if (this.live) { this.live = null; this.refreshLive(); }
      return;
    }
    const phase = store.sim.signals.currentPhase(junction.id);
    const remaining = Math.max(0, store.sim.signals.remaining(junction.id));
    const changed = !this.live || this.live.phase !== phase
      || Math.abs(this.live.remaining - remaining) > 0.2;
    if (!changed) return;
    this.live = { phase, remaining };
    this.refreshLive();
  }

  private refreshLive(): void {
    const rows = this.body.querySelectorAll('.phase');
    rows.forEach((row, i) => {
      const on = this.live?.phase === i;
      row.classList.toggle('running', on);
      const clock = row.querySelector('.clock');
      if (clock) clock.textContent = on ? `${this.live!.remaining.toFixed(0)} s` : '';
    });
  }

  refresh(visible: boolean): void {
    if (!visible) return;
    const store = this.host.store;
    const junction = store.junctionSelection();
    this.body.replaceChildren();
    this.canvases.length = 0;

    if (!junction) {
      this.body.append(el('p', { class: 'hint', text: 'Click a junction on the map to set it up.' }));
      return;
    }

    if (junction.kind === 'merge' || junction.kind === 'diverge') {
      this.body.append(this.goreSection(junction));
      return;
    }

    if (junction.rightInRightOut) {
      this.body.append(el('p', {
        class: 'hint',
        text: 'Right-in / right-out runs on priority: nothing stops the through road, '
          + 'and the far carriageway is never touched.',
      }));
    } else {
      this.body.append(this.controlRow(junction));
    }
    if (stemOf(junction)) this.body.append(this.rightInRightOutRow(junction));
    this.body.append(this.turnLaneSection(junction));

    if (junction.control !== 'signal') {
      if (!junction.rightInRightOut) {
        this.body.append(el('p', {
          class: 'hint',
          text: `This junction runs on ${CONTROL_LABELS[junction.control].toLowerCase()}. `
            + 'Switch it to signals to give it a phase plan.',
        }));
      }
      return;
    }

    const net = store.network;
    const groups = movementGroups(net.lanes, net.segments, junction.approaches, junction.connectorIds);
    const spec = this.currentSpec(junction);
    const stored = this.storedSpec(junction) !== null;

    this.body.append(this.summaryRow(junction, spec, stored));
    this.body.append(this.offsetRow(junction, spec));
    this.body.append(this.actuatedRow(junction, spec));
    this.body.append(this.turnOnRedRow(junction));
    this.body.append(this.presetRow(junction, groups));

    for (let i = 0; i < spec.phases.length; i++) {
      this.body.append(this.phaseRow(junction, net, groups, spec, i));
    }

    this.body.append(el('div', { class: 'row', style: { marginTop: '8px' } },
      el('button', {
        class: 'grow', text: '+ Add phase',
        onclick: () => {
          const next = this.currentSpec(junction);
          next.phases.push({ groups: [], green: 12, amber: 3.5, allRed: 1.5 });
          this.commit(junction, next, 'Phase added. Click movements in it to give them a green.');
        },
      }),
    ));

    const warnings = this.warningsFor(groups, spec);
    for (const text of warnings) {
      this.body.append(el('p', { class: 'warn', text }));
    }
    this.refreshLive();
  }

  private controlRow(junction: Junction): HTMLElement {
    const row = el('div', { class: 'row seg' });
    for (const control of ['priority', 'allway-stop', 'signal'] as JunctionControl[]) {
      const button = el('button', {
        class: junction.control === control ? 'grow active' : 'grow',
        text: CONTROL_LABELS[control],
        onclick: () => {
          this.host.store.run(setJunctionControl(junction.x, junction.y, control));
          this.host.setStatus(`Junction set to ${CONTROL_LABELS[control].toLowerCase()}.`);
          this.host.requestRender();
        },
      });
      row.append(button);
    }
    return row;
  }

  /**
   * Right-in / right-out, offered at a T only.
   *
   * Only the kerb-side turns: the stem may turn onto the near carriageway and the
   * near carriageway may turn into the stem. The median stays unbroken and the far
   * carriageway is never touched, which is the point — and why it runs on priority
   * regardless of the control buttons, which are put away while it is on.
   */
  private rightInRightOutRow(junction: Junction): HTMLElement {
    const store = this.host.store;
    const on = junction.rightInRightOut === true;
    return el('div', { class: 'row' },
      el('span', { class: 'label', text: 'Right-in / right-out' }),
      el('button', {
        class: on ? 'grow active' : 'grow',
        text: on ? 'On' : 'Off',
        title: 'Only the kerb-side turns, so the median stays unbroken',
        onclick: () => {
          store.run(setRightInRightOut(junction.x, junction.y, !on, junction.control));
          this.host.setStatus(on
            ? 'Every turn is allowed at this junction again.'
            : 'Right-in / right-out: kerb-side turns only, median unbroken.');
          this.host.requestRender();
        },
      }));
  }

  /**
   * Turn bays, one row per approach.
   *
   * The compiler's own rule builds a left bay where the group has two lanes or more,
   * there is somewhere to turn left to and the block is long enough. Those are
   * judgements about a typical junction, and the point of drawing your own network is
   * that some junctions are not typical — so every approach can be told what to have.
   * `Auto` is the compiler's answer and is what an untouched junction shows.
   */
  private turnLaneSection(junction: Junction): HTMLElement {
    const store = this.host.store;
    const net = store.network;
    const wrap = el('div', { class: 'section' },
      el('div', { class: 'row summary' }, el('span', { text: 'Turn lanes' })));

    const seen = new Set<string>();
    for (const approach of junction.approaches) {
      if (!approach.incomingLanes.length) continue;
      const key = approachKey(net, approach);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const current = turnChoiceAt(store.model, junction, key);
      const row = el('div', { class: 'row' },
        el('span', { class: 'label', text: approachLabel(net, approach) }));
      const seg = el('div', { class: 'row seg grow' });
      for (const [choice, label, title] of TURN_CHOICES) {
        const button = el('button', {
          class: current === choice ? 'active' : '',
          text: label,
          title,
          onclick: () => {
            store.run(setTurnLanes(junction.x, junction.y, key, choice, junction.control));
            this.host.setStatus(`${approachLabel(net, approach)}: ${title.toLowerCase()}.`);
            this.host.requestRender();
          },
        }) as HTMLButtonElement;
        // No left turn exists at a right-in / right-out, so no bay for one.
        if (junction.rightInRightOut && (choice === 'left' || choice === 'both')) {
          button.disabled = true;
          button.title = 'No left turn at a right-in / right-out';
        }
        seg.append(button);
      }
      row.append(seg);
      wrap.append(row);
    }
    if (seen.size === 0) {
      wrap.append(el('p', { class: 'hint', text: 'No approach here can take a turn bay.' }));
    }
    return wrap;
  }

  /**
   * A gore has exactly one choice, and which one depends on which way it runs: an
   * exit can let the kerb-side through lane take it as well as carrying on, and an
   * entrance can keep some of the lanes the ramp brings in instead of tapering them
   * away. Both were only reachable by clicking the gore on the map and cycling, which
   * is fine for a flag and hopeless for a count.
   */
  private goreSection(junction: Junction): HTMLElement {
    const store = this.host.store;
    const override = store.model.junctions.find(
      (j) => Math.hypot(j.x - junction.x, j.y - junction.y) < 1);
    const wrap = el('div', { class: 'section' },
      el('div', { class: 'row summary' },
        el('span', { text: junction.kind === 'merge' ? 'Entrance' : 'Exit' })));

    if (junction.kind === 'diverge') {
      const on = override?.optionLane === true;
      wrap.append(el('div', { class: 'row' },
        el('span', { class: 'label', text: 'Option lane' }),
        el('button', {
          class: on ? 'grow active' : 'grow',
          text: on ? 'On' : 'Off',
          title: 'Let the kerb-side through lane take the exit as well as carrying on',
          onclick: () => {
            store.run(setOptionLane(junction.x, junction.y, !on));
            this.host.setStatus(on
              ? 'The exit gets its own lane again.'
              : 'The kerb-side lane can now exit or carry on.');
            this.host.requestRender();
          },
        })));
      wrap.append(el('p', {
        class: 'hint',
        text: 'Exiting traffic then slows in a through lane, which is free below '
          + 'capacity and expensive above it.',
      }));
      return wrap;
    }

    const rampLanes = Math.max(1, junction.approaches[0]?.incomingLanes.length ?? 1);
    const added = Math.max(0, Math.min(rampLanes, override?.addedLanes ?? 0));
    wrap.append(this.step2(
      'Lanes kept',
      added === 0 ? 'none (taper)' : `${added} of ${rampLanes}`,
      (delta) => {
        const next = Math.max(0, Math.min(rampLanes, added + delta));
        if (next === added) return;
        store.run(setAddedLanes(junction.x, junction.y, next));
        this.host.setStatus(next === 0
          ? 'The entrance lane tapers away as usual.'
          : `${next} lane${next === 1 ? ' stays' : 's stay'} on the highway.`);
        this.host.requestRender();
      },
    ));
    wrap.append(el('p', {
      class: 'hint',
      text: 'How many of the lanes the ramp brings in stay on the highway instead of '
        + 'tapering away. A kept lane merges out before the next junction.',
    }));
    return wrap;
  }

  private summaryRow(junction: Junction, spec: SignalPlanSpec, stored: boolean): HTMLElement {
    const cycle = spec.phases.reduce((a, p) => a + p.green + p.amber + p.allRed, 0);
    const row = el('div', { class: 'row summary' },
      el('span', { text: `${spec.phases.length} phase${spec.phases.length === 1 ? '' : 's'}` }),
      el('span', { class: 'value', text: `cycle ${round(cycle)} s` }),
    );
    if (stored) {
      row.append(el('button', {
        class: 'ghost small', text: 'Reset',
        title: 'Hand this junction back to the automatic plan.',
        onclick: () => this.commit(junction, null, 'Signal plan handed back to the compiler.'),
      }));
    }
    return row;
  }

  /**
   * Where in its cycle this junction starts, and the one thing that is for.
   *
   * On its own an offset is a number nobody can reason about. Against the junctions
   * up and down the same road it is a green wave: leave at the right moment and you
   * meet every light green. So the stepper sits beside a button that works the
   * offsets out for the whole corridor from a design speed, which is how the timing
   * is actually decided.
   */
  private offsetRow(junction: Junction, spec: SignalPlanSpec): HTMLElement {
    const cycle = spec.phases.reduce((a, p) => a + p.green + p.amber + p.allRed, 0) || 1;
    const set = (offset: number): void => {
      const next = this.currentSpec(junction);
      next.offset = round(((offset % cycle) + cycle) % cycle);
      this.commit(junction, next, `Offset set to ${next.offset} s of a ${round(cycle)} s cycle.`);
    };
    const row = el('div', { class: 'row offset' },
      this.step2('Offset', `${round(spec.offset)} s`, (d) => set(spec.offset + d * 2)),
    );
    const net = this.host.store.network;
    const stops = corridor(net, junction, GREEN_WAVE_SPEED);
    if (stops.length >= 2) {
      row.append(el('button', {
        class: 'ghost small', text: `Green wave (${stops.length})`,
        title: `Offset the ${stops.length} signals along this road so a platoon at `
          + `${Math.round(GREEN_WAVE_SPEED * 3.6)} km/h meets each one green.`,
        onclick: () => this.greenWave(junction),
      }));
    }
    return row;
  }

  /**
   * Whether a green here ends as soon as nobody is using it.
   *
   * Off by default, and the hint says why: a fixed plan has a fixed cycle, and a
   * fixed cycle is the whole basis of the green wave button directly above. Turning
   * this on at a junction that is part of a corridor breaks the corridor — every
   * offset downstream is a claim about where a platoon will be, and it stops being
   * true when the cycle length depends on who turned up.
   */
  private actuatedRow(junction: Junction, spec: SignalPlanSpec): HTMLElement {
    const on = spec.actuated === true;
    const stops = corridor(this.host.store.network, junction, GREEN_WAVE_SPEED);
    const row = el('div', { class: 'row' },
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', ...(on ? { checked: 'checked' } : {}),
          onchange: (e: Event) => {
            const next = this.currentSpec(junction);
            const want = (e.target as HTMLInputElement).checked;
            if (want) next.actuated = true;
            else delete next.actuated;
            this.commit(
              junction, next,
              want
                ? 'Greens here now end as soon as nobody is using them.'
                : 'Greens here now run their full time.',
            );
          },
        }),
        el('span', { text: 'End a green early when nothing is waiting' }),
      ),
    );
    if (stops.length >= 2) {
      row.append(el('span', {
        class: 'hint',
        text: 'This junction is on a coordinated road; actuating it breaks the wave.',
      }));
    }
    return row;
  }

  /** Offsets every signal along this road by the time it takes to drive there. */
  private greenWave(junction: Junction): void {
    const store = this.host.store;
    const stops = corridor(store.network, junction, GREEN_WAVE_SPEED);
    if (stops.length < 2) return;
    store.transaction('Set a green wave', () => {
      for (const stop of stops) {
        const at = store.network.junctions[stop.junctionId];
        if (!at) continue;
        const spec = this.specFor(at);
        spec.offset = stop.offset;
        store.run(setSignalPlan(at.x, at.y, spec));
      }
    });
    this.host.setStatus(
      `Green wave set across ${stops.length} signals at ${Math.round(GREEN_WAVE_SPEED * 3.6)} km/h.`,
    );
    this.host.requestRender();
  }

  /** The stored plan for any junction, or its compiled one written out as a spec. */
  private specFor(junction: Junction): SignalPlanSpec {
    const override = junctionOverrideAt(
      this.host.store.model.junctions, junction.x, junction.y, junction.radius,
    );
    if (override?.signal) {
      return {
        offset: override.signal.offset,
        phases: override.signal.phases.map((p) => ({ ...p, groups: [...p.groups] })),
        ...(override.signal.actuated ? { actuated: true } : {}),
      };
    }
    const plan = junction.signal;
    return {
      offset: plan?.offset ?? 0,
      phases: (plan?.phases ?? []).map((p) => ({
        groups: [...p.groups], green: p.green, amber: p.amber, allRed: p.allRed,
      })),
      ...(plan?.actuated ? { actuated: true } : {}),
    };
  }

  /** A stepper that is not tied to a phase. */
  private step2(label: string, value: string, onStep: (delta: number) => void): HTMLElement {
    return el('div', { class: 'stepper grow' },
      el('span', { class: 'label', text: label }),
      el('button', { class: 'step', text: '−', onclick: () => onStep(-1) }),
      el('span', { class: 'value', text: value }),
      el('button', { class: 'step', text: '+', onclick: () => onStep(1) }),
    );
  }

  /**
   * The kerb-side turn against a red — a right turn where traffic drives on the
   * right. On by default, because that is how the rule works where it exists:
   * permitted everywhere, forbidden by a sign at the junctions that need one. It
   * costs nothing when the movement has no gap and is worth a fifth of the
   * junction's throughput when it does.
   */
  private turnOnRedRow(junction: Junction): HTMLElement {
    const right = this.host.store.network.driveOnRight;
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = junction.turnOnRed;
    box.addEventListener('change', () => {
      this.host.store.run(setTurnOnRed(junction.x, junction.y, box.checked));
      this.host.setStatus(box.checked
        ? `${right ? 'Right' : 'Left'} turns on red allowed here.`
        : `No turn on red here.`);
      this.host.requestRender();
    });
    return el('label', { class: 'check turn-on-red' }, box,
      el('span', { text: `${right ? 'Right' : 'Left'} turn on red` }));
  }

  private presetRow(junction: Junction, groups: MovementGroup[]): HTMLElement {
    const row = el('div', { class: 'row presets' });
    for (const preset of ['permissive', 'protected', 'split'] as SignalPreset[]) {
      row.append(el('button', {
        class: 'grow small', text: PRESET_LABELS[preset],
        onclick: () => {
          const phases = presetPhases(preset, groups, junction.approaches, this.host.store.network.lanes);
          this.commit(junction, { offset: 0, phases }, `Plan set to ${PRESET_LABELS[preset].toLowerCase()}.`);
        },
      }));
    }
    return row;
  }

  private phaseRow(
    junction: Junction, net: Network, groups: MovementGroup[],
    spec: SignalPlanSpec, index: number,
  ): HTMLElement {
    const phase = spec.phases[index]!;
    const green = new Set<number>();
    for (const key of phase.groups) {
      for (const id of groups.find((g) => g.key === key)?.connectorIds ?? []) green.add(id);
    }
    // Permissive is read off the compiled conflicts, so it says what the traffic
    // will do rather than what the plan meant.
    const permissive = new Set<number>();
    const asPhase = { ...phase, greenLanes: [...green] };
    for (const id of green) {
      if (protectionOf(net.lanes, asPhase, id) === 'permissive') permissive.add(id);
    }

    const canvas = el('canvas', { class: 'diagram' }) as HTMLCanvasElement;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
    canvas.width = Math.round(DIAGRAM_W * dpr);
    canvas.height = Math.round(DIAGRAM_H * dpr);
    canvas.style.width = `${DIAGRAM_W}px`;
    canvas.style.height = `${DIAGRAM_H}px`;
    const slot = { canvas, diagram: null as SignalDiagram | null };
    this.canvases.push(slot);

    const paint = (): void => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      slot.diagram = drawSignalDiagram(ctx, net, junction, {
        width: DIAGRAM_W, height: DIAGRAM_H,
        green, permissive, groups, theme: DARK,
        highlight: this.hover?.phase === index ? this.hover.key : null,
      });
    };
    paint();

    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? DIAGRAM_W / rect.width : 1;
      const scaleY = rect.height ? DIAGRAM_H / rect.height : 1;
      const key = slot.diagram?.hitTest(
        (event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY,
      ) ?? null;
      const next = key ? { phase: index, key } : null;
      if (next?.key === this.hover?.key && next?.phase === this.hover?.phase) return;
      this.hover = next;
      canvas.style.cursor = key ? 'pointer' : 'default';
      canvas.title = key ? (groups.find((g) => g.key === key)?.label ?? '') : '';
      paint();
    });
    canvas.addEventListener('pointerleave', () => {
      if (this.hover?.phase !== index) return;
      this.hover = null;
      paint();
    });
    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? DIAGRAM_W / rect.width : 1;
      const scaleY = rect.height ? DIAGRAM_H / rect.height : 1;
      const key = slot.diagram?.hitTest(
        (event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY,
      );
      if (!key) return;
      const next = this.currentSpec(junction);
      const target = next.phases[index];
      if (!target) return;
      const at = target.groups.indexOf(key);
      if (at >= 0) target.groups.splice(at, 1);
      else target.groups.push(key);
      const label = groups.find((g) => g.key === key)?.label ?? 'movement';
      this.commit(junction, next, `${at >= 0 ? 'Stopped' : 'Gave a green to'} ${label} in phase ${index + 1}.`);
    });

    const timing = el('div', { class: 'timing' });
    const fields: [keyof typeof STEP, string, string][] = [
      ['green', 'Green', 'How long this phase runs.'],
      ['amber', 'Amber', 'The warning before the phase ends.'],
      ['allRed', 'All red', 'Clearance time before the next phase starts.'],
    ];
    for (const [field, label, hint] of fields) {
      timing.append(this.step(junction, index, field, label, hint, phase[field]));
    }

    const head = el('div', { class: 'row phase-head' },
      el('span', { class: 'name', text: `Phase ${index + 1}` }),
      el('span', { class: 'clock' }),
      el('button', {
        class: 'ghost small', text: '↑', title: 'Run this phase earlier in the cycle.',
        disabled: index === 0 ? 'disabled' : null,
        onclick: () => this.movePhase(junction, index, -1),
      }),
      el('button', {
        class: 'ghost small', text: '↓', title: 'Run this phase later in the cycle.',
        disabled: index === spec.phases.length - 1 ? 'disabled' : null,
        onclick: () => this.movePhase(junction, index, 1),
      }),
      el('button', {
        class: 'ghost small', text: '✕', title: 'Remove this phase.',
        onclick: () => {
          const next = this.currentSpec(junction);
          next.phases.splice(index, 1);
          this.commit(junction, next, `Phase ${index + 1} removed.`);
        },
      }),
    );

    const names = phase.groups
      .map((key) => groups.find((g) => g.key === key)?.label)
      .filter((x): x is string => Boolean(x));
    const yields = [...permissive].length > 0;

    return el('div', { class: 'phase' }, head, canvas, timing,
      el('p', {
        class: 'movements',
        text: names.length
          ? `${names.join(', ')}${yields ? ' — dashed movements give way' : ''}`
          : 'No movements: click one in the picture to give it a green.',
      }),
    );
  }

  private movePhase(junction: Junction, index: number, delta: number): void {
    const next = this.currentSpec(junction);
    const to = index + delta;
    if (to < 0 || to >= next.phases.length) return;
    const [moved] = next.phases.splice(index, 1);
    next.phases.splice(to, 0, moved!);
    this.commit(junction, next, `Phase moved to position ${to + 1}.`);
  }

  private step(
    junction: Junction, index: number, field: keyof typeof STEP,
    label: string, hint: string, value: number,
  ): HTMLElement {
    const apply = (delta: number): void => {
      const next = this.currentSpec(junction);
      const target = next.phases[index];
      if (!target) return;
      const [lo, hi] = LIMITS[field];
      target[field] = round(Math.max(lo, Math.min(hi, target[field] + delta * STEP[field])));
      this.commit(junction, next, `${label} set to ${target[field]} s in phase ${index + 1}.`);
    };
    return el('div', { class: 'stepper', title: hint },
      el('span', { class: 'label', text: label }),
      el('button', { class: 'step', text: '−', onclick: () => apply(-1) }),
      el('span', { class: 'value', text: `${round(value)} s` }),
      el('button', { class: 'step', text: '+', onclick: () => apply(1) }),
    );
  }

  /**
   * What is wrong with the plan, in the panel's own words. The compiler raises the
   * same things as diagnostics; saying them here as well puts them next to the
   * phase that caused them.
   */
  private warningsFor(groups: MovementGroup[], spec: SignalPlanSpec): string[] {
    const out: string[] = [];
    const served = new Set<string>();
    for (const phase of spec.phases) for (const key of phase.groups) served.add(key);
    const starved = groups.filter((g) => !served.has(g.key));
    if (starved.length) {
      out.push(`Never gets a green: ${starved.map((g) => g.label).join(', ')}.`);
    }
    for (let i = 0; i < spec.phases.length; i++) {
      if (!spec.phases[i]!.groups.length) out.push(`Phase ${i + 1} greens nothing and is skipped.`);
    }
    const net = this.host.store.network;
    const armOf = new Map<number, number>();
    for (const g of groups) for (const id of g.connectorIds) armOf.set(id, g.approachIndex);
    for (let i = 0; i < spec.phases.length; i++) {
      const green: number[] = [];
      for (const key of spec.phases[i]!.groups) {
        green.push(...(groups.find((g) => g.key === key)?.connectorIds ?? []));
      }
      if (crossingThroughPair(net.lanes, armOf, green)) {
        out.push(`Phase ${i + 1} greens two streams that drive straight through each other.`);
      }
    }
    return out;
  }
}

export type { SignalPhaseSpec };


/** The five turn-bay choices, in the order they read on a row of buttons. */
const TURN_CHOICES: [TurnLaneChoice, string, string][] = [
  ['auto', 'Auto', 'Let the compiler decide'],
  ['none', 'None', 'No turn bay on this approach'],
  ['left', 'L', 'A left-turn bay'],
  ['right', 'R', 'A right-turn bay'],
  ['both', 'L+R', 'A bay for each turn'],
];

/**
 * An approach's name, `strokeId:side` — the same form the signal groups and the
 * hand-wired movements use, and for the same reason: it survives a recompile.
 */
function approachKey(net: Network, approach: Approach): string | null {
  const seg = net.segments[approach.segmentId];
  if (!seg) return null;
  // Traffic flowing *into* the junction at the segment's high end travels along the
  // stroke; at the low end it travels against it.
  return `${seg.strokeId}:${approach.atSegmentEnd ? 1 : -1}`;
}

function approachLabel(net: Network, approach: Approach): string {
  const seg = net.segments[approach.segmentId];
  const stroke = seg ? net.segments[approach.segmentId] : null;
  const name = stroke ? `Road ${seg.strokeId}` : 'Approach';
  const bearing = ((approach.heading * 180) / Math.PI + 360 + 180) % 360;
  return `${name} ${COMPASS[Math.round(bearing / 45) % 8]}`;
}

/**
 * The stem of a T: the one arm with nothing opposite it, when there are three.
 * Null for any other shape, which is where right-in / right-out is not offered.
 */
function stemOf(junction: Junction): Approach | null {
  const live = junction.approaches.filter((a) => a.incomingLanes.length || a.outgoingLanes.length);
  if (live.length !== 3) return null;
  const opposite = (a: Approach, b: Approach): boolean => Math.cos(a.heading - b.heading) < -0.866;
  const stems = live.filter((a) => !live.some((b) => b !== a && opposite(a, b)));
  return stems.length === 1 ? stems[0] : null;
}

/** Eight points, enough to tell one arm of a junction from another at a glance. */
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

function turnChoiceAt(model: EditModel, junction: Junction, approach: string): TurnLaneChoice {
  const override = junctionOverrideAt(model.junctions, junction.x, junction.y);
  return override?.turnLanes?.find((t) => t.approach === approach)?.choice ?? 'auto';
}
