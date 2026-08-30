/**
 * Editor behaviour, driven headlessly through the same tool interface the canvas
 * uses. These are the tests that would otherwise need a browser and a mouse.
 */

import { describe, expect, it } from 'vitest';
import { installCanvasGlobals, StubContext } from '../helpers/canvasStub';
installCanvasGlobals();

import { harness } from '../helpers/editor';
import { MAX_GRADE } from '@editor/grade';
import { DrawTool } from '@editor/tools/drawTool';
import { SelectTool } from '@editor/tools/selectTool';
import { BulldozeTool } from '@editor/tools/bulldozeTool';
import { InspectTool } from '@editor/tools/inspectTool';
import { createDocument } from '@core/network/model';
import { DARK } from '@render/theme';
import { addStroke, line, profileNamed } from '../helpers/build';

function docWithFreeway() {
  const model = createDocument();
  const freeway = model.profiles.find((p) => p.name === 'Freeway 3-lane (one-way)')!;
  return { model, freeway };
}

describe('draw tool', () => {
  it('creates a road and undo removes it', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, 0, 0);
    h.click(tool, 200, 0);
    h.key(tool, 'Enter');

    expect(h.store.model.strokes.length).toBe(1);
    expect(h.store.model.strokes[0].points.length).toBe(2);
    h.settle();
    expect(h.store.network.segments.length).toBe(1);

    h.store.undo.undo();
    expect(h.store.model.strokes.length).toBe(0);
    h.store.undo.redo();
    expect(h.store.model.strokes.length).toBe(1);
  });

  it('needs at least two points', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, 0, 0);
    h.key(tool, 'Enter');
    expect(h.store.model.strokes.length).toBe(0);
  });

  it('abandons the road on Escape', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, 0, 0);
    h.click(tool, 100, 0);
    h.key(tool, 'Escape');
    h.key(tool, 'Enter');
    expect(h.store.model.strokes.length).toBe(0);
  });

  it('takes back the last point on Backspace', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, 0, 0);
    h.click(tool, 100, 0);
    h.click(tool, 200, 80);
    h.key(tool, 'Backspace');
    h.key(tool, 'Enter');
    expect(h.store.model.strokes[0].points.length).toBe(2);
  });

  it('pulls a bezier handle when the placing click is dragged', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, 0, 0);
    h.drag(tool, [200, 0], [260, 60]);
    h.key(tool, 'Enter');
    const last = h.store.model.strokes[0].points[1];
    expect(last.hox).toBeCloseTo(260, 3);
    expect(last.hoy).toBeCloseTo(60, 3);
    // The opposite handle mirrors, so the curve stays smooth through the point.
    expect(last.hix).toBeCloseTo(140, 3);
    expect(last.hiy).toBeCloseTo(-60, 3);
  });

  it('raises the level with Tab and lowers it with Shift+Tab', () => {
    // A level is not three-valued: a bridge over a bridge is level 2, and the old
    // ground/bridge/tunnel cycle had nowhere to put it.
    const h = harness();
    const tool = new DrawTool();
    expect(h.env.activeGrade).toBe(0);
    h.key(tool, 'Tab');
    expect(h.env.activeGrade).toBe(1);
    h.key(tool, 'Tab');
    expect(h.env.activeGrade, 'a bridge over a bridge').toBe(2);
    h.key(tool, 'Tab', { shiftKey: true });
    h.key(tool, 'Tab', { shiftKey: true });
    expect(h.env.activeGrade).toBe(0);
    h.key(tool, 'Tab', { shiftKey: true });
    expect(h.env.activeGrade, 'and down into a tunnel').toBe(-1);
  });

  it('stops at the deepest level rather than wrapping round', () => {
    // Wrapping would put a road that was meant to climb into a tunnel, silently.
    const h = harness();
    const tool = new DrawTool();
    for (let i = 0; i < 8; i++) h.key(tool, 'Tab');
    expect(h.env.activeGrade).toBe(MAX_GRADE);
    for (let i = 0; i < 16; i++) h.key(tool, 'Tab', { shiftKey: true });
    expect(h.env.activeGrade).toBe(-MAX_GRADE);
  });

  it('builds a road at a level above the first', () => {
    const h = harness();
    const tool = new DrawTool();
    h.key(tool, 'Tab');
    h.key(tool, 'Tab');
    h.click(tool, 0, 0);
    h.click(tool, 300, 0);
    h.key(tool, 'Enter');
    h.settle();
    expect(h.store.model.strokes[0].points.every((p) => p.grade === 2)).toBe(true);
    expect(h.store.network.segments.every((seg) => seg.grade === 2)).toBe(true);
  });

  it('builds the road at the level Tab left it on', () => {
    const h = harness();
    const tool = new DrawTool();
    h.key(tool, 'Tab');
    expect(h.env.activeGrade).toBe(1);
    h.click(tool, 0, 0);
    h.click(tool, 300, 0);
    h.key(tool, 'Enter');
    h.settle();
    expect(h.store.model.strokes[0].points.every((p) => p.grade === 1)).toBe(true);
    expect(h.store.network.segments.every((seg) => seg.grade === 1)).toBe(true);
  });

  it('lets one road climb, span and come back down', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, -300, 0);
    h.key(tool, 'Tab');
    h.click(tool, -100, 0);
    h.click(tool, 100, 0);
    h.key(tool, 'Tab', { shiftKey: true });
    h.click(tool, 300, 0);
    h.key(tool, 'Enter');
    h.settle();
    // Tab moves the points placed after it, which is what makes the road ramp.
    expect(h.store.model.strokes[0].points.map((p) => p.grade)).toEqual([0, 1, 1, 0]);
    expect([...new Set(h.store.network.segments.map((s) => s.grade))].sort()).toEqual([0, 1]);
  });

  it('snaps a new road to an existing road end', () => {
    const h = harness();
    const tool = new DrawTool();
    h.click(tool, 0, 0);
    h.click(tool, 300, 0);
    h.key(tool, 'Enter');
    h.settle();

    // Start the next road a few metres away from the first one's end.
    h.click(tool, 304, 3);
    h.click(tool, 600, 0);
    h.key(tool, 'Enter');
    h.settle();

    const second = h.store.model.strokes[1];
    expect(second.points[0].x).toBeCloseTo(300, 3);
    expect(second.points[0].y).toBeCloseTo(0, 3);
    // Two roads meeting end to end compile into a link, not a crossing.
    expect(h.store.network.junctions.length).toBe(1);
    expect(h.store.network.junctions[0].kind).toBe('link');
  });

  /**
   * Level is a property of the point on a road, not of the road. Reading it once
   * per stroke — from its first control point — made an overpass a ground road
   * everywhere, so drawing on the ground snapped to the middle of a bridge and
   * drawing a bridge snapped to nothing at all.
   */
  describe('snapping across levels', () => {
    /** A road that leaves the ground, spans, and comes back down. */
    function withOverpass() {
      const h = harness();
      const tool = new DrawTool();
      h.click(tool, -300, 0);
      h.click(tool, -100, 0);
      h.click(tool, 100, 0);
      h.click(tool, 300, 0);
      h.key(tool, 'Enter');
      const stroke = h.store.model.strokes[0];
      [0, 1, 1, 0].forEach((g, i) => { stroke.points[i].grade = g; });
      h.settle();
      return h;
    }

    /** Where a road drawn at `level` starting near (x, y) actually begins. */
    function startNear(h: ReturnType<typeof harness>, level: number, x: number, y: number) {
      h.env.setActiveGrade(level);
      const tool = new DrawTool();
      h.click(tool, x, y);
      h.click(tool, x, y + 400);
      h.key(tool, 'Enter');
      h.settle();
      return h.store.model.strokes[h.store.model.strokes.length - 1].points[0];
    }

    it('offers a climbing road its ends on the ground and its flanks in the air', () => {
      const h = withOverpass();
      // The far end of the span is at ground level, so a ground road joins it.
      const onGround = startNear(h, 0, 297, 3);
      expect(onGround.x).toBeCloseTo(300, 3);
      expect(onGround.y).toBeCloseTo(0, 3);

      // The same end is not a bridge, so a road drawn as one is left where it was.
      const inAir = startNear(withOverpass(), 1, 297, 3);
      expect(inAir.x).toBeCloseTo(297, 3);
      expect(inAir.y).toBeCloseTo(3, 3);
    });

    it('snaps a bridge to the deck and leaves the ground road alone', () => {
      // Just outside the kerb halfway along, where the road is fully up.
      const deck = startNear(withOverpass(), 1, 0, 8);
      expect(Math.abs(deck.y)).toBeLessThan(8);
      expect(deck.y).not.toBe(8);

      const beneath = startNear(withOverpass(), 0, 0, 8);
      expect(beneath.y).toBeCloseTo(8, 3);
    });
  });
});

describe('drawing a ramp onto a freeway edge', () => {
  it('snaps to the edge and compiles into a merge', () => {
    const { model, freeway } = docWithFreeway();
    const h = harness(model);
    h.env.activeProfileId = freeway.id;
    const draw = new DrawTool();

    h.click(draw, 0, 0);
    h.click(draw, 2000, 0);
    h.key(draw, 'Enter');
    h.settle();

    // Now a ramp, ending near the freeway's kerb-side edge.
    const ramp = h.store.model.profiles.find((p) => p.isRamp)!;
    h.env.activeProfileId = ramp.id;
    h.click(draw, 600, 120);
    h.click(draw, 1000, 9);
    h.key(draw, 'Enter');
    h.settle();

    const net = h.store.network;
    expect(net.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(net.junctions.length).toBe(1);
    expect(net.junctions[0].kind).toBe('merge');
    const aux = net.lanes.find((l) => l.aux);
    expect(aux).toBeDefined();
    expect(aux!.endsAt).toBeLessThan(Infinity);
    expect(aux!.mergeTarget).toBeGreaterThanOrEqual(0);
  });
});

describe('select tool', () => {
  function withRoad() {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, 0, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.settle();
    return h;
  }

  it('selects a road by clicking it', () => {
    const h = withRoad();
    const select = new SelectTool();
    h.click(select, 150, 0);
    expect(h.store.selection.size).toBe(1);
  });

  it('clears the selection when clicking empty space', () => {
    const h = withRoad();
    const select = new SelectTool();
    h.click(select, 150, 0);
    h.click(select, 150, 400);
    expect(h.store.selection.size).toBe(0);
  });

  it('moves a road and folds the drag into one undo step', () => {
    const h = withRoad();
    const select = new SelectTool();
    h.click(select, 150, 0);
    const undosBefore = h.store.undo.depth;
    h.drag(select, [150, 0], [150, 60]);
    h.settle();
    expect(h.store.model.strokes[0].points[0].y).toBeCloseTo(60, 3);
    expect(h.store.undo.depth - undosBefore).toBe(1);

    h.store.undo.undo();
    expect(h.store.model.strokes[0].points[0].y).toBeCloseTo(0, 3);
  });

  it('reshapes a road by dragging a control point', () => {
    const h = withRoad();
    const select = new SelectTool();
    h.click(select, 150, 0);
    h.drag(select, [300, 0], [340, 90]);
    h.settle();
    const last = h.store.model.strokes[0].points[1];
    expect(last.x).toBeCloseTo(340, 3);
    expect(last.y).toBeCloseTo(90, 3);
  });

  it('deletes the selection', () => {
    const h = withRoad();
    const select = new SelectTool();
    h.click(select, 150, 0);
    h.key(select, 'Delete');
    expect(h.store.model.strokes.length).toBe(0);
    h.store.undo.undo();
    expect(h.store.model.strokes.length).toBe(1);
  });

  it('raises and lowers the selection a level at a time', () => {
    const h = withRoad();
    const select = new SelectTool();
    h.click(select, 150, 0);
    h.key(select, 'Tab');
    expect(h.store.model.strokes[0].points.every((p) => p.grade === 1)).toBe(true);
    h.key(select, 'Tab');
    expect(h.store.model.strokes[0].points.every((p) => p.grade === 2)).toBe(true);
    h.key(select, 'Tab', { shiftKey: true });
    h.key(select, 'Tab', { shiftKey: true });
    h.key(select, 'Tab', { shiftKey: true });
    expect(h.store.model.strokes[0].points.every((p) => p.grade === -1)).toBe(true);
  });

  it('box-selects several roads', () => {
    const h = withRoad();
    const draw = new DrawTool();
    h.click(draw, 0, 100);
    h.click(draw, 300, 100);
    h.key(draw, 'Enter');
    h.settle();

    const select = new SelectTool();
    h.drag(select, [-50, -50], [350, 150]);
    expect(h.store.selection.size).toBe(2);
  });
});

/**
 * Where a bridge crosses a road, both are under the cursor. Picking whichever
 * centreline happens to be nearer is a coin flip, and it makes stacked roads
 * unusable: you go to delete the road underneath and take the bridge instead.
 */
describe('picking a road where two are stacked', () => {
  function crossing() {
    const h = harness();
    const draw = new DrawTool();
    // A ground road east–west, and a bridge north–south over it.
    h.click(draw, -300, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.env.setActiveGrade(1);
    h.click(draw, 0, -300);
    h.click(draw, 0, 300);
    h.key(draw, 'Enter');
    h.settle();
    expect(h.store.model.strokes.length).toBe(2);
    return h;
  }

  /** Which stroke a click at the crossing point selects, at a given level. */
  function pickedAt(h: ReturnType<typeof harness>, level: number): number | undefined {
    h.env.setActiveGrade(level);
    const select = new SelectTool();
    h.store.selection.clear();
    // A few metres off centre, so neither is exactly under the cursor.
    h.click(select, 2, 2);
    return [...h.store.selection][0];
  }

  it('takes the road on the level being worked on', () => {
    const h = crossing();
    const ground = h.store.model.strokes[0].id;
    const bridge = h.store.model.strokes[1].id;
    expect(pickedAt(h, 0)).toBe(ground);
    expect(pickedAt(h, 1)).toBe(bridge);
  });

  it('still picks a lone road on another level rather than nothing', () => {
    // A preference, not a filter: refusing to select the only thing there would
    // just be baffling.
    const h = harness();
    const draw = new DrawTool();
    h.env.setActiveGrade(1);
    h.click(draw, -300, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.settle();
    expect(pickedAt(h, 0)).toBe(h.store.model.strokes[0].id);
  });

  it('bulldozes the one on the working level', () => {
    const h = crossing();
    const ground = h.store.model.strokes[0].id;
    h.env.setActiveGrade(1);
    const bulldoze = new BulldozeTool();
    h.click(bulldoze, 2, 2);
    h.settle();
    expect(h.store.model.strokes.map((s) => s.id)).toEqual([ground]);
  });
});

describe('bulldoze tool', () => {
  it('removes the road under the cursor', () => {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, 0, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.settle();

    const bulldoze = new BulldozeTool();
    h.click(bulldoze, 150, 0);
    expect(h.store.model.strokes.length).toBe(0);
    h.store.undo.undo();
    expect(h.store.model.strokes.length).toBe(1);
  });

  it('ignores clicks that miss', () => {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, 0, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.settle();

    const bulldoze = new BulldozeTool();
    h.click(bulldoze, 150, 300);
    expect(h.store.model.strokes.length).toBe(1);
  });

  it('removes several roads in one drag, as one undo step', () => {
    const h = harness();
    const draw = new DrawTool();
    for (const y of [0, 40]) {
      h.click(draw, 0, y);
      h.click(draw, 300, y);
      h.key(draw, 'Enter');
    }
    h.settle();

    const bulldoze = new BulldozeTool();
    const before = h.store.undo.depth;
    h.drag(bulldoze, [150, 0], [150, 40]);
    expect(h.store.model.strokes.length).toBe(0);
    expect(h.store.undo.depth - before).toBe(1);
    h.store.undo.undo();
    expect(h.store.model.strokes.length).toBe(2);
  });
});

describe('marking the ends of the network', () => {
  /**
   * The gateway spawn mode is "only the ends I marked, only the way I marked
   * them", and the ends are compiled data with no other home in the UI — so the
   * junction tool owns them, and a click that lands on nothing else lands on one.
   *
   * Marking is available whatever the spawn mode is. Refusing the click outside the
   * gateway mode would mean discovering the control only after you already needed
   * it.
   */
  function road() {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, -300, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.settle();
    return h;
  }

  it('cycles one end through all five roles and back', () => {
    const h = road();
    const inspect = new InspectTool();
    const portal = h.store.network.portals[0]!;
    const seen: string[] = [portal.role];
    for (let i = 0; i < 5; i++) {
      h.click(inspect, portal.x, portal.y);
      h.settle();
      // The last step builds a turning head, and a turning head is not a portal —
      // that is the point of it. It has to stay clickable all the same, or the one
      // state you cannot see is the one you need in order to undo it.
      const again = h.store.network.portals.find(
        (p) => Math.hypot(p.x - portal.x, p.y - portal.y) < 1,
      );
      const head = h.store.network.junctions.find(
        (j) => j.kind === 'culdesac' && Math.hypot(j.x - portal.x, j.y - portal.y) < 1,
      );
      seen.push(again ? again.role : head ? 'culdesac' : 'gone');
    }
    expect(seen).toEqual(['both', 'entry', 'exit', 'off', 'culdesac', 'both']);
  });

  it('leaves no override behind when an end is set back to both', () => {
    // A document nobody has marked must carry no gateway entries at all, or the
    // gateway mode stops being the same thing as the portal mode by default.
    const h = road();
    const inspect = new InspectTool();
    const portal = h.store.network.portals[0]!;
    h.click(inspect, portal.x, portal.y);
    h.settle();
    expect(h.store.model.gateways.length).toBe(1);
    for (let i = 0; i < 4; i++) {
      h.click(inspect, portal.x, portal.y);
      h.settle();
    }
    expect(h.store.model.gateways.length).toBe(0);
  });

  it('marks only the end that was clicked', () => {
    const h = road();
    const inspect = new InspectTool();
    const first = h.store.network.portals[0]!;
    h.click(inspect, first.x, first.y);
    h.settle();
    const marked = h.store.network.portals.filter((p) => p.role !== 'both');
    expect(marked.length).toBe(1);
    expect(Math.hypot(marked[0]!.x - first.x, marked[0]!.y - first.y)).toBeLessThan(1);
  });

  it('undoes like any other edit', () => {
    const h = road();
    const inspect = new InspectTool();
    const portal = h.store.network.portals[0]!;
    h.click(inspect, portal.x, portal.y);
    h.settle();
    expect(h.store.model.gateways.length).toBe(1);
    h.store.undo.undo();
    h.settle();
    expect(h.store.model.gateways.length).toBe(0);
    expect(h.store.network.portals.every((p) => p.role === 'both')).toBe(true);
  });
});

describe('junction inspector', () => {
  function crossing() {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, -300, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.click(draw, 0, -300);
    h.click(draw, 0, 300);
    h.key(draw, 'Enter');
    h.settle();
    return h;
  }

  it('selects the junction a click landed on, without changing it', () => {
    const h = crossing();
    const before = h.store.network.junctions[0].control;
    const inspect = new InspectTool();
    h.click(inspect, 0, 0);
    h.settle();
    // A click opens the junction; it is the panel and C that change it, because
    // flipping a signalised junction to priority on the way in is the opposite of
    // what clicking it meant.
    expect(h.store.selectedJunction).not.toBeNull();
    expect(h.store.junctionSelection()?.id).toBe(h.store.network.junctions[0].id);
    expect(h.store.network.junctions[0].control).toBe(before);
    expect(h.store.model.junctions.length).toBe(0);
  });

  it('cycles a junction through all three control types on C', () => {
    const h = crossing();
    expect(h.store.network.junctions.length).toBe(1);
    const inspect = new InspectTool();
    h.click(inspect, 0, 0);
    const seen: string[] = [h.store.network.junctions[0].control];

    for (let i = 0; i < 3; i++) {
      h.key(inspect, 'c');
      h.settle();
      seen.push(h.store.network.junctions[0].control);
    }
    // Three presses return to where it started, having visited each control once.
    expect(seen[3]).toBe(seen[0]);
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set(['priority', 'allway-stop', 'signal']));
  });

  it('records the choice in the document so it survives a save', () => {
    const h = crossing();
    const inspect = new InspectTool();
    h.click(inspect, 0, 0);
    h.key(inspect, 'c');
    expect(h.store.model.junctions.length).toBe(1);
    expect(h.store.model.junctions[0].control).toBeDefined();
  });

  it('ignores clicks away from any junction', () => {
    const h = crossing();
    const inspect = new InspectTool();
    h.click(inspect, 250, 250);
    expect(h.store.model.junctions.length).toBe(0);
  });

  // The overlay is the lane graph made visible, so what it draws has to be the
  // connector centrelines themselves — not a redrawn approximation that could
  // disagree with what the simulation actually follows.
  it('draws a spline for every movement, from the connectors themselves', () => {
    const h = crossing();
    const inspect = new InspectTool();
    const net = h.store.network;
    const junction = net.junctions[0];
    expect(junction.connectorIds.length).toBeGreaterThan(4);

    const ctx = new StubContext();
    inspect.draw(ctx as unknown as CanvasRenderingContext2D, h.camera, DARK, h.env);

    // Every connector's first point should have been moved to at least once.
    const moves = ctx.calls.filter((c) => c.op === 'moveTo')
      .map((c) => `${(c.args[0] as number).toFixed(2)},${(c.args[1] as number).toFixed(2)}`);
    for (const id of junction.connectorIds) {
      const line = net.lanes[id].centerline;
      expect(moves, `connector ${id}`).toContain(`${line[0].toFixed(2)},${line[1].toFixed(2)}`);
    }
  });

  it('picks out the movements of the lane under the cursor', () => {
    const h = crossing();
    const inspect = new InspectTool();
    const net = h.store.network;
    const junction = net.junctions[0];
    const laneId = junction.approaches.find((a) => a.incomingLanes.length)!.incomingLanes[0];
    const lane = net.lanes[laneId];

    const paint = (): Set<string> => {
      const ctx = new StubContext();
      inspect.draw(ctx as unknown as CanvasRenderingContext2D, h.camera, DARK, h.env);
      // An arrowhead is only drawn on a highlighted movement.
      return new Set(ctx.calls.filter((c) => c.op === 'fill').map((_, i) => String(i)));
    };
    const idle = paint().size;

    // Point at the middle of that lane; its own movements light up.
    const mid = lane.centerline.length >> 1 & ~1;
    h.move(inspect, lane.centerline[mid], lane.centerline[mid + 1]);
    const lit = paint().size;
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(junction.connectorIds.length);
    expect(idle).not.toBe(lit);
  });

  // Wiring is two shift-clicks: the lane going in, then the lane coming out.
  it('wires a movement by hand, and clicking the same pair again removes it', () => {
    const h = crossing();
    const inspect = new InspectTool();
    const net = h.store.network;
    const junction = net.junctions[0];
    const before = junction.connectorIds.length;

    const arm = junction.approaches.find((a) => a.incomingLanes.length)!;
    const other = junction.approaches.find((a) => a !== arm && a.outgoingLanes.length)!;
    const inLane = net.lanes[arm.incomingLanes[0]];
    const outLane = net.lanes[other.outgoingLanes[0]];
    const at = (lane: typeof inLane, s: number): [number, number] => {
      const i = Math.min(lane.centerline.length - 2, Math.max(0, Math.round(s) * 2));
      return [lane.centerline[i], lane.centerline[i + 1]];
    };

    // Wiring by hand replaces the compiler's whole allocation, so the first pair
    // seeds from what it had and then toggles: this pair already exists, so the
    // first round trip removes it.
    h.click(inspect, ...at(inLane, (inLane.centerline.length >> 2)), { shift: true });
    h.click(inspect, ...at(outLane, (outLane.centerline.length >> 2)), { shift: true });
    h.settle();
    expect(h.store.model.laneLinks.length).toBe(1);
    const after = h.store.network.junctions[0].connectorIds.length;
    expect(Math.abs(after - before)).toBe(1);

    // The same pair again puts it back.
    h.click(inspect, ...at(inLane, (inLane.centerline.length >> 2)), { shift: true });
    h.click(inspect, ...at(outLane, (outLane.centerline.length >> 2)), { shift: true });
    h.settle();
    expect(h.store.network.junctions[0].connectorIds.length).toBe(before);
  });

  it('will not offer a movement that leaves by the road it arrived on', () => {
    const h = crossing();
    const inspect = new InspectTool();
    const net = h.store.network;
    const junction = net.junctions[0];
    const arm = junction.approaches.find((a) => a.incomingLanes.length && a.outgoingLanes.length)!;
    const inLane = net.lanes[arm.incomingLanes[0]];
    const backLane = net.lanes[arm.outgoingLanes[0]];
    const at = (lane: typeof inLane): [number, number] => {
      const i = (lane.centerline.length >> 2) * 2;
      return [lane.centerline[i], lane.centerline[i + 1]];
    };

    h.click(inspect, ...at(inLane), { shift: true });
    h.click(inspect, ...at(backLane), { shift: true });
    expect(h.status[h.status.length - 1]).toContain('back the way');
    expect(h.store.model.laneLinks.length).toBe(0);
  });

  it('never mutates the network while drawing', () => {
    const h = crossing();
    const inspect = new InspectTool();
    const before = networkSignature(h.store.network);
    const ctx = new StubContext();
    h.move(inspect, 0, 0);
    inspect.draw(ctx as unknown as CanvasRenderingContext2D, h.camera, DARK, h.env);
    expect(networkSignature(h.store.network)).toBe(before);
  });
});

/** Enough of the lane graph to notice any change to it. */
function networkSignature(
  net: { lanes: ReadonlyArray<{ successors: number[]; predecessors: number[]; centerline: Float32Array }> },
): string {
  return net.lanes
    .map((l) => `${l.successors.join('.')}|${l.predecessors.join('.')}|${l.centerline.length}`)
    .join(';');
}

describe('store', () => {
  it('recompiles only once no matter how many edits are queued', () => {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, 0, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    expect(h.store.isDirty).toBe(true);
    expect(h.store.flush()).toBe(true);
    expect(h.store.flush()).toBe(false);
  });

  it('keeps flattened geometry in step with the document', () => {
    const h = harness();
    const draw = new DrawTool();
    h.click(draw, 0, 0);
    h.click(draw, 300, 0);
    h.key(draw, 'Enter');
    h.settle();
    const id = h.store.model.strokes[0].id;
    expect(h.store.geometry.get(id)?.length).toBeCloseTo(300, 1);

    const select = new SelectTool();
    h.click(select, 150, 0);
    h.drag(select, [300, 0], [600, 0]);
    h.settle();
    expect(h.store.geometry.get(id)?.length).toBeCloseTo(600, 1);
  });
});

describe('wiring junction movements by hand', () => {
  function withCrossing() {
    const h = harness();
    const profile = profileNamed(h.store.model, 'Arterial 4-lane');
    addStroke(h.store.model, profile, line(-300, 0, 300, 0));
    addStroke(h.store.model, profile, line(0, -300, 0, 300));
    h.store.invalidate();
    h.settle();
    return h;
  }

  it('shift-clicking a lane in and a lane out records one movement', () => {
    const h = withCrossing();
    const tool = new InspectTool();
    const net = h.store.network;
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const approach = junction.approaches.find((a) => a.incomingLanes.length)!;
    const target = junction.approaches.find((a) => a !== approach && a.outgoingLanes.length)!;
    const inLane = net.lanes[approach.incomingLanes[0]!]!;
    const outLane = net.lanes[target.outgoingLanes[0]!]!;
    const mid = (l: typeof inLane): { x: number; y: number } => {
      const i = (l.centerline.length >> 2) * 2;
      return { x: l.centerline[i]!, y: l.centerline[i + 1]! };
    };

    const a = mid(inLane);
    const b = mid(outLane);
    h.click(tool, a.x, a.y, { shift: true });
    expect(h.store.model.laneLinks.length).toBe(0);
    h.click(tool, b.x, b.y, { shift: true });

    expect(h.store.model.laneLinks.length).toBe(1);
    const wired = h.store.model.laneLinks[0]!;
    // It starts from what the compiler had, minus or plus the one that was clicked.
    expect(wired.links.length).toBeGreaterThan(0);
    expect(h.store.network.junctions.find((j) => j.kind === 'crossing')!.connectorIds.length)
      .toBe(wired.links.length);
  });

  it('undoes back to the compiler’s own layout', () => {
    const h = withCrossing();
    const tool = new InspectTool();
    const before = h.store.network.junctions.find((j) => j.kind === 'crossing')!.connectorIds.length;
    const net = h.store.network;
    const junction = net.junctions.find((j) => j.kind === 'crossing')!;
    const approach = junction.approaches.find((a) => a.incomingLanes.length)!;
    const target = junction.approaches.find((a) => a !== approach && a.outgoingLanes.length)!;
    const pick = (l: { centerline: Float32Array }): { x: number; y: number } => {
      const i = (l.centerline.length >> 2) * 2;
      return { x: l.centerline[i]!, y: l.centerline[i + 1]! };
    };
    const a = pick(net.lanes[approach.incomingLanes[0]!]!);
    const b = pick(net.lanes[target.outgoingLanes[0]!]!);
    h.click(tool, a.x, a.y, { shift: true });
    h.click(tool, b.x, b.y, { shift: true });
    expect(h.store.model.laneLinks.length).toBe(1);

    h.store.undo.undo();
    h.store.invalidate();
    h.settle();
    expect(h.store.model.laneLinks.length).toBe(0);
    expect(h.store.network.junctions.find((j) => j.kind === 'crossing')!.connectorIds.length)
      .toBe(before);
  });
});
