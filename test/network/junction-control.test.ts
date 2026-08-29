/**
 * Which control a crossing gets, and the one case that was missing.
 *
 * Priority works when there is a pecking order somebody can act on: the minor road
 * waits for a gap and takes it. Above a certain speed there are no gaps to take.
 * The major stream never pauses, so the minor arm is not slow to be served but
 * *never* served — which shows up first as vehicles stopped at the line for minutes
 * and then as collisions, because a driver who has waited that long is being asked
 * to read a gap in traffic doing thirty metres a second.
 *
 * This was a documented known limitation of the model for a long time, and the
 * temptation was to fix it in the simulation — to teach gap acceptance to cope with
 * a stream that never pauses. It belongs here instead. Real networks do not leave a
 * crossing of a 110 km/h road on priority; they signalise it or grade-separate it,
 * and a model that builds one is modelling a junction nobody builds.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { autoSmoothHandles, createDocument, issueId, kph, makeControlPoint } from '@core/network/model';
import type { ControlPoint, EditModel, Junction, RoadProfile } from '@core/network/types';

function points(...coords: number[]): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(makeControlPoint(coords[i]!, coords[i + 1]!));
  autoSmoothHandles(out);
  return out;
}

/** A crossroads: one road at `majorKph`, a smaller one across it at `minorKph`. */
function crossing(majorKph: number, minorKph: number, majorLanes = 2): EditModel {
  const model = createDocument(7);
  const major: RoadProfile = {
    id: issueId(model), name: 'major', lanesForward: majorLanes, lanesBackward: majorLanes,
    laneWidth: 3.65, speedLimit: kph(majorKph), median: 2, shoulder: 1, isRamp: false,
  };
  const minor: RoadProfile = {
    id: issueId(model), name: 'minor', lanesForward: 1, lanesBackward: 1,
    laneWidth: 3.2, speedLimit: kph(minorKph), median: 0, shoulder: 0, isRamp: false,
  };
  model.profiles.push(major, minor);
  model.strokes.push({ id: issueId(model), profileId: major.id, points: points(-600, 0, 0, 0, 600, 0) });
  model.strokes.push({ id: issueId(model), profileId: minor.id, points: points(0, -400, 0, 0, 0, 400) });
  return model;
}

const crossings = (model: EditModel): Junction[] =>
  compile(model).junctions.filter((j) => j.kind === 'crossing');

describe('choosing a junction control', () => {
  it('leaves an ordinary minor road on priority', () => {
    // A 60 km/h street crossing a 50 km/h one: a driver can read those gaps, and
    // signalising it would meter traffic that was never going to conflict much.
    const found = crossings(crossing(60, 50));
    expect(found.length).toBe(1);
    expect(found[0].control).toBe('priority');
  });

  it('signalises a crossing of a road nobody can find a gap in', () => {
    // 110 km/h across 50: the same shape, and not a junction that can be negotiated.
    const found = crossings(crossing(110, 50));
    expect(found.length).toBe(1);
    expect(found[0].control).toBe('signal');
  });

  it('does it on the speed, not on the size of the road', () => {
    // A single-carriageway 100 km/h road is just as impossible to cross as a dual
    // one, so the rule cannot be a lane count wearing a speed limit.
    expect(crossings(crossing(100, 50, 1))[0].control).toBe('signal');
    // And a wide slow road is still perfectly crossable.
    expect(crossings(crossing(60, 50, 3))[0].control).not.toBe('signal');
  });

  it('still lets the document say otherwise', () => {
    // The whole point of the override is that the user outranks the heuristic.
    const model = crossing(110, 50);
    const junction = crossings(model)[0];
    model.junctions.push({ x: junction.x, y: junction.y, control: 'priority' });
    expect(crossings(model)[0].control).toBe('priority');
  });
});
