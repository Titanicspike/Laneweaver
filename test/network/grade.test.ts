/**
 * A road that changes level along its length.
 *
 * The level lives on the control point, so one stroke can leave the ground, cross
 * over something, and come back down. Two consequences the compiler has to get
 * right: the road is split so each segment sits on one layer, and whether two roads
 * meet depends on the level *at the crossing*, not on the roads as a whole.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '@core/network/compiler';
import { addProfile, addStroke, doc, line } from '../helpers/build';
import type { EditModel } from '@core/network/types';

function road(model: EditModel, name: string, x0: number, y0: number, x1: number, y1: number,
  grades: number[]) {
  const profile = addProfile(model, {
    name, lanesForward: 1, lanesBackward: 1, laneWidth: 3.2, shoulder: 0.4,
    median: 0, speedLimit: 14,
  });
  const points = line(x0, y0, x1, y1, grades.length);
  const stroke = addStroke(model, profile, points);
  for (let i = 0; i < grades.length; i++) stroke.points[i].grade = grades[i];
  return stroke;
}

describe('grade along a road', () => {
  it('splits the road where it changes level', () => {
    const model = doc();
    road(model, 'ramping', -400, 0, 400, 0, [0, 0, 1, 1]);
    const net = compile(model);
    const levels = net.segments.map((s) => s.grade).sort((a, b) => a - b);
    expect(levels).toEqual([0, 1]);
    // The join is where the ramp passes the halfway mark, not at a control point.
    const ground = net.segments.find((s) => s.grade === 0)!;
    const bridge = net.segments.find((s) => s.grade === 1)!;
    expect(ground.length + bridge.length).toBeCloseTo(800, 0);
    expect(ground.length).toBeGreaterThan(300);
    expect(bridge.length).toBeGreaterThan(300);
  });

  it('goes up and back down in one stroke', () => {
    const model = doc();
    road(model, 'over', -600, 0, 600, 0, [0, 1, 1, 0]);
    const net = compile(model);
    const levels = net.segments.map((s) => s.grade);
    expect(levels.filter((g) => g === 0).length).toBe(2);
    expect(levels.filter((g) => g === 1).length).toBe(1);
  });

  it('crosses what it is level with and passes over what it is not', () => {
    const model = doc();
    // Ramps up from the west, so it is on the ground at x=-300 and a bridge at x=300.
    road(model, 'ramping', -600, 0, 600, 0, [0, 0, 1, 1]);
    road(model, 'under', 300, -400, 300, 400, [0, 0]);
    road(model, 'level', -300, -400, -300, 400, [0, 0]);
    const net = compile(model);
    const crossings = net.junctions.filter((j) => j.kind === 'crossing');
    // Only the one it is still on the ground for.
    expect(crossings.length).toBe(1);
    expect(crossings[0]!.x).toBeCloseTo(-300, 0);
  });

  it('meets a road it has climbed to', () => {
    const model = doc();
    road(model, 'ramping', -600, 0, 600, 0, [0, 0, 1, 1]);
    road(model, 'raised', 300, -400, 300, 400, [1, 1]);
    const net = compile(model);
    const crossings = net.junctions.filter((j) => j.kind === 'crossing');
    expect(crossings.length).toBe(1);
    expect(crossings[0]!.x).toBeCloseTo(300, 0);
    expect(crossings[0]!.grade).toBe(1);
  });
});
