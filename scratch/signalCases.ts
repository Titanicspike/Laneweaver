/**
 * Signalised intersections worth stress-testing, and the helper that puts a plan on
 * them.
 *
 * Shared by `scratch/signalcheck.ts` and `test/scenarios/signals.test.ts` so the
 * numbers a run prints are the numbers the tests assert on. Every shape here exists
 * because it breaks a different assumption: a T has an arm with no opposite, a
 * five-way cannot be split into two axes at all, a skew crossing has no compass
 * directions to speak of, a one-way pair has approaches with no incoming lanes on
 * one side, and wide-into-narrow has arms of very different capacity.
 */

import { createDocument, kph } from '../src/core/network/model';
import { compile } from '../src/core/network/compiler';
import {
  movementGroups, presetPhases, type SignalPreset,
} from '../src/core/network/compiler/signals';
import type { EditModel, SignalPlanSpec } from '../src/core/network/types';
import { add, line, pts, prof } from './cases';

export interface SignalCase {
  name: string;
  /** A fresh document each time, so a plan written on one run cannot leak. */
  build(): EditModel;
}

const arterial = (m: EditModel, lanes = 2, median = 2.4) =>
  prof(m, {
    name: `art${lanes}`, lanesForward: lanes, lanesBackward: lanes, laneWidth: 3.5,
    shoulder: 0.8, median, speedLimit: kph(70),
  });
const street = (m: EditModel) =>
  prof(m, { name: 'st', lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4, speedLimit: kph(50) });
const oneWay = (m: EditModel, lanes = 2) =>
  prof(m, {
    name: `ow${lanes}`, lanesForward: lanes, lanesBackward: 0, laneWidth: 3.5,
    shoulder: 0.5, speedLimit: kph(50),
  });

export function signalCases(): SignalCase[] {
  const make = (name: string, build: (m: EditModel) => void): SignalCase => ({
    name,
    build: () => {
      const m = createDocument(7);
      build(m);
      return m;
    },
  });

  return [
    make('cross-4way', (m) => {
      const a = arterial(m);
      add(m, a, line(-500, 0, 500, 0));
      add(m, a, line(0, -500, 0, 500));
    }),
    make('cross-4way-wide', (m) => {
      add(m, arterial(m, 3, 3.6), line(-600, 0, 600, 0));
      add(m, arterial(m, 2, 2.4), line(0, -600, 0, 600));
    }),
    make('tee', (m) => {
      const a = arterial(m);
      add(m, a, line(-500, 0, 500, 0));
      add(m, a, line(0, 0, 0, 500));
    }),
    make('cross-skew', (m) => {
      const a = arterial(m);
      add(m, a, line(-500, 0, 500, 0));
      add(m, a, line(-280, -480, 280, 480));
    }),
    make('five-way', (m) => {
      const a = arterial(m);
      add(m, a, line(-500, 0, 500, 0));
      add(m, a, line(0, -500, 0, 500));
      add(m, street(m), line(0, 0, 420, -420));
    }),
    make('cross-curved', (m) => {
      const a = arterial(m);
      add(m, a, pts(-520, -140, -160, -30, 200, 20, 540, 30));
      add(m, a, pts(-60, -520, 10, -160, 30, 200, -20, 540));
    }),
    make('oneway-pair', (m) => {
      add(m, arterial(m), line(-500, 0, 500, 0));
      add(m, oneWay(m), line(0, -500, 0, 500));
    }),
    make('cross-narrow', (m) => {
      const s = street(m);
      add(m, s, line(-400, 0, 400, 0));
      add(m, s, line(0, -400, 0, 400));
    }),
  ];
}

/**
 * Signalises every crossing in the document and gives it `preset`.
 *
 * The plan is written the way the panel writes it — a position-keyed override
 * holding movement-group names — so the test drives exactly the path a user does.
 */
export function planFor(model: EditModel, preset: SignalPreset | null): EditModel {
  const net = compile(model);
  for (const junction of net.junctions) {
    if (junction.kind !== 'crossing') continue;
    const groups = movementGroups(net.lanes, net.segments, junction.approaches, junction.connectorIds);
    const signal: SignalPlanSpec | undefined = preset
      ? { offset: 0, phases: presetPhases(preset, groups, junction.approaches, net.lanes) }
      : undefined;
    model.junctions.push({ x: junction.x, y: junction.y, control: 'signal', signal });
  }
  return model;
}
