/**
 * Editing commands.
 *
 * Every mutation of the document goes through one of these so undo/redo works
 * everywhere, and every one is exactly reversible. Drag interactions record a
 * single command whose `coalesce` folds the whole drag into one undo step.
 */

import type { Command } from '../core/util/command';
import { cloneControlPoint, cloneStroke } from '../core/network/model';
import type {
  ControlPoint, EditModel, EditSettings, GeoSettings, ImageUnderlay, JunctionControl,
  LaneLinkOverride, RoadProfile, SignalPlanSpec, Stroke, TerrainSettings, GatewayRole,
  TurnLaneChoice, TurnLaneOverride, ZoneChoice,
} from '../core/network/types';

export type DocCommand = Command<EditModel>;

export function addStroke(stroke: Stroke): DocCommand {
  const snapshot = cloneStroke(stroke);
  return {
    label: 'Draw road',
    apply(model) {
      model.strokes.push(cloneStroke(snapshot));
      if (model.nextId <= snapshot.id) model.nextId = snapshot.id + 1;
    },
    revert(model) {
      const i = model.strokes.findIndex((s) => s.id === snapshot.id);
      if (i >= 0) model.strokes.splice(i, 1);
    },
  };
}

export function removeStrokes(ids: ReadonlyArray<number>): DocCommand {
  let removed: { index: number; stroke: Stroke }[] = [];
  const wanted = new Set(ids);
  return {
    label: ids.length > 1 ? `Delete ${ids.length} roads` : 'Delete road',
    apply(model) {
      removed = [];
      for (let i = model.strokes.length - 1; i >= 0; i--) {
        if (!wanted.has(model.strokes[i].id)) continue;
        removed.push({ index: i, stroke: cloneStroke(model.strokes[i]) });
        model.strokes.splice(i, 1);
      }
    },
    revert(model) {
      for (let i = removed.length - 1; i >= 0; i--) {
        model.strokes.splice(removed[i].index, 0, cloneStroke(removed[i].stroke));
      }
    },
  };
}

/**
 * Replaces a stroke's geometry wholesale; used by every drag interaction.
 * Consecutive reshapes of the same stroke coalesce, so a drag is one undo step.
 */
class ReshapeStroke implements DocCommand {
  readonly label: string;
  readonly strokeId: number;
  from: ControlPoint[];
  to: ControlPoint[];

  constructor(strokeId: number, before: ControlPoint[], after: ControlPoint[], label: string) {
    this.strokeId = strokeId;
    this.label = label;
    this.from = before.map(cloneControlPoint);
    this.to = after.map(cloneControlPoint);
  }

  apply(model: EditModel): void {
    const stroke = model.strokes.find((s) => s.id === this.strokeId);
    if (stroke) stroke.points = this.to.map(cloneControlPoint);
  }

  revert(model: EditModel): void {
    const stroke = model.strokes.find((s) => s.id === this.strokeId);
    if (stroke) stroke.points = this.from.map(cloneControlPoint);
  }

  coalesce(prev: DocCommand): boolean {
    if (!(prev instanceof ReshapeStroke) || prev.strokeId !== this.strokeId) return false;
    prev.to = this.to;
    return true;
  }
}

export function reshapeStroke(
  strokeId: number, before: ControlPoint[], after: ControlPoint[], label = 'Move road',
): DocCommand {
  return new ReshapeStroke(strokeId, before, after, label);
}

export function setStrokeGrade(ids: ReadonlyArray<number>, grade: number): DocCommand {
  const before = new Map<number, number[]>();
  return {
    label: grade > 0 ? 'Raise to bridge' : grade < 0 ? 'Lower to tunnel' : 'Set to ground level',
    apply(model) {
      before.clear();
      for (const stroke of model.strokes) {
        if (!ids.includes(stroke.id)) continue;
        before.set(stroke.id, stroke.points.map((p) => p.grade));
        for (const p of stroke.points) p.grade = grade;
      }
    },
    revert(model) {
      for (const stroke of model.strokes) {
        const old = before.get(stroke.id);
        if (!old) continue;
        for (let i = 0; i < stroke.points.length && i < old.length; i++) stroke.points[i].grade = old[i];
      }
    },
  };
}

/**
 * Sets the level of one control point, which is how a road is made to ramp: leave
 * the points either side where they are and the road climbs between them.
 */
export function setPointGrade(strokeId: number, index: number, grade: number): DocCommand {
  let before = 0;
  return {
    label: grade > 0 ? 'Raise this point' : grade < 0 ? 'Lower this point' : 'Level this point',
    apply(model) {
      const stroke = model.strokes.find((s) => s.id === strokeId);
      const point = stroke?.points[index];
      if (!point) return;
      before = point.grade;
      point.grade = grade;
    },
    revert(model) {
      const stroke = model.strokes.find((s) => s.id === strokeId);
      const point = stroke?.points[index];
      if (point) point.grade = before;
    },
  };
}

/**
 * Replaces the hand-made movements for one junction, or clears them so the compiler
 * lays the junction out itself again. Keyed by position, like the control choice.
 */
export function setLaneLinks(
  x: number, y: number, links: ReadonlyArray<{ from: string; to: string }>,
): DocCommand {
  let before: { index: number; value: LaneLinkOverride } | null = null;
  let added = false;
  return {
    label: links.length ? 'Wire junction movements' : 'Let the junction wire itself',
    apply(model) {
      const index = model.laneLinks.findIndex((l) => Math.hypot(l.x - x, l.y - y) < 0.5);
      before = index >= 0 ? { index, value: model.laneLinks[index] } : null;
      added = false;
      if (!links.length) {
        if (index >= 0) model.laneLinks.splice(index, 1);
        return;
      }
      const next = { x, y, links: links.map((l) => ({ ...l })) };
      if (index >= 0) model.laneLinks[index] = next;
      else { model.laneLinks.push(next); added = true; }
    },
    revert(model) {
      if (added) {
        const at = model.laneLinks.findIndex((l) => Math.hypot(l.x - x, l.y - y) < 0.5);
        if (at >= 0) model.laneLinks.splice(at, 1);
        return;
      }
      const at = model.laneLinks.findIndex((l) => Math.hypot(l.x - x, l.y - y) < 0.5);
      if (before) {
        if (at >= 0) model.laneLinks[at] = before.value;
        else model.laneLinks.splice(Math.min(before.index, model.laneLinks.length), 0, before.value);
      } else if (at >= 0) {
        model.laneLinks.splice(at, 1);
      }
    },
  };
}

export function setStrokeProfile(ids: ReadonlyArray<number>, profileId: number): DocCommand {
  const before = new Map<number, number>();
  return {
    label: 'Change road type',
    apply(model) {
      before.clear();
      for (const stroke of model.strokes) {
        if (!ids.includes(stroke.id)) continue;
        before.set(stroke.id, stroke.profileId);
        stroke.profileId = profileId;
      }
    },
    revert(model) {
      for (const stroke of model.strokes) {
        const old = before.get(stroke.id);
        if (old !== undefined) stroke.profileId = old;
      }
    },
  };
}

export function addProfile(profile: RoadProfile): DocCommand {
  const snapshot: RoadProfile = { ...profile, rampSpec: profile.rampSpec ? { ...profile.rampSpec } : undefined };
  return {
    label: 'Add road type',
    apply(model) {
      model.profiles.push({ ...snapshot, rampSpec: snapshot.rampSpec ? { ...snapshot.rampSpec } : undefined });
      if (model.nextId <= snapshot.id) model.nextId = snapshot.id + 1;
    },
    revert(model) {
      const i = model.profiles.findIndex((p) => p.id === snapshot.id);
      if (i >= 0) model.profiles.splice(i, 1);
    },
  };
}

export function updateProfile(profileId: number, patch: Partial<RoadProfile>): DocCommand {
  let before: RoadProfile | null = null;
  return {
    label: 'Edit road type',
    apply(model) {
      const p = model.profiles.find((x) => x.id === profileId);
      if (!p) return;
      before = { ...p, rampSpec: p.rampSpec ? { ...p.rampSpec } : undefined };
      Object.assign(p, patch);
      if (patch.rampSpec) p.rampSpec = { ...patch.rampSpec };
    },
    revert(model) {
      if (!before) return;
      const p = model.profiles.find((x) => x.id === profileId);
      if (!p) return;
      Object.assign(p, before);
      p.rampSpec = before.rampSpec ? { ...before.rampSpec } : undefined;
    },
  };
}

export function removeProfile(profileId: number): DocCommand {
  let index = -1;
  let removed: RoadProfile | null = null;
  let reassigned: { id: number; profileId: number }[] = [];
  return {
    label: 'Delete road type',
    apply(model) {
      index = model.profiles.findIndex((p) => p.id === profileId);
      if (index < 0 || model.profiles.length <= 1) return;
      removed = model.profiles[index];
      model.profiles.splice(index, 1);
      const fallback = model.profiles[0].id;
      reassigned = [];
      for (const stroke of model.strokes) {
        if (stroke.profileId !== profileId) continue;
        reassigned.push({ id: stroke.id, profileId: stroke.profileId });
        stroke.profileId = fallback;
      }
    },
    revert(model) {
      if (!removed || index < 0) return;
      model.profiles.splice(index, 0, removed);
      for (const r of reassigned) {
        const stroke = model.strokes.find((s) => s.id === r.id);
        if (stroke) stroke.profileId = r.profileId;
      }
    },
  };
}

export function updateSettings(patch: Partial<EditSettings>): DocCommand {
  let before: EditSettings | null = null;
  return {
    label: 'Change settings',
    apply(model) {
      before = { ...model.settings };
      Object.assign(model.settings, patch);
    },
    revert(model) {
      if (before) Object.assign(model.settings, before);
    },
  };
}

export function updateTerrain(patch: Partial<TerrainSettings>): DocCommand {
  let before: TerrainSettings | null = null;
  return {
    label: 'Change terrain',
    apply(model) {
      before = { ...model.terrain };
      Object.assign(model.terrain, patch);
    },
    revert(model) {
      if (before) Object.assign(model.terrain, before);
    },
  };
}

export function setJunctionControl(x: number, y: number, control: JunctionControl): DocCommand {
  let previous: { index: number; control: JunctionControl } | null = null;
  return {
    label: control === 'signal' ? 'Signalise junction' : 'Set junction to priority',
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      if (index >= 0) {
        previous = { index, control: model.junctions[index].control };
        model.junctions[index].control = control;
      } else {
        previous = null;
        model.junctions.push({ x, y, control });
      }
    },
    revert(model) {
      if (previous) model.junctions[previous.index].control = previous.control;
      else {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      }
    },
  };
}

/**
 * Zones one road: what stands beside it, overriding its road type's answer.
 *
 * Keyed by stroke id rather than by position, unlike the junction and gateway
 * overrides — a stroke id *is* stable, because it is part of the document rather
 * than derived from it. Setting a road back to what its road type says removes the
 * override rather than storing it, so a document nobody has zoned carries none.
 */
export function setStrokeZone(strokeId: number, choice: ZoneChoice | undefined): DocCommand {
  let before: ZoneChoice | undefined;
  let had = false;
  return {
    label: choice === undefined ? 'Clear zoning'
      : choice === 'none' ? 'Zone: nothing' : `Zone: ${choice}`,
    apply(model) {
      const stroke = model.strokes.find((st) => st.id === strokeId);
      if (!stroke) return;
      had = true;
      before = stroke.landUse;
      if (choice === undefined) delete stroke.landUse;
      else stroke.landUse = choice;
    },
    revert(model) {
      if (!had) return;
      const stroke = model.strokes.find((st) => st.id === strokeId);
      if (!stroke) return;
      if (before === undefined) delete stroke.landUse;
      else stroke.landUse = before;
    },
  };
}

/**
 * Sets what one end of the network may do in the gateway spawn mode.
 *
 * Keyed by position, like the junction control choice and for the same reason:
 * portals are derived data and their ids change on every recompile. Setting an end
 * back to `both` removes the entry rather than storing it, so a document nobody has
 * marked carries no gateway overrides at all and behaves exactly like the portal
 * mode — which is what makes switching to gateways a starting point rather than a
 * cliff.
 */
export function setGatewayRole(x: number, y: number, role: GatewayRole): DocCommand {
  let before: { index: number; role: GatewayRole } | null = null;
  let added = false;
  return {
    label: role === 'both' ? 'Clear road end' : `Road end: ${role} only`,
    apply(model) {
      const index = model.gateways.findIndex((g) => Math.hypot(g.x - x, g.y - y) < 1);
      if (index >= 0) {
        before = { index, role: model.gateways[index].role };
        if (role === 'both') model.gateways.splice(index, 1);
        else model.gateways[index].role = role;
        added = false;
      } else {
        before = null;
        added = role !== 'both';
        if (added) model.gateways.push({ x, y, role });
      }
    },
    revert(model) {
      if (before) {
        if (before.role === undefined) return;
        const at = model.gateways.findIndex((g) => Math.hypot(g.x - x, g.y - y) < 1);
        if (at >= 0) model.gateways[at].role = before.role;
        else model.gateways.splice(before.index, 0, { x, y, role: before.role });
      } else if (added) {
        const i = model.gateways.findIndex((g) => Math.hypot(g.x - x, g.y - y) < 1);
        if (i >= 0) model.gateways.splice(i, 1);
      }
    },
  };
}

/**
 * Sets a diverge's option lane on or off.
 *
 * The kerb-side through lane may take the exit as well as carrying on. Lives on the
 * same position-keyed override as the control choice, so a gore that is left alone
 * leaves no entry behind.
 */
/**
 * Sets what turn bays one approach of a junction gets.
 *
 * Keyed by position like every other junction choice, and the approach is named
 * `strokeId:side` rather than identified, because segments and lanes are rebuilt on
 * every recompile and a choice made before an edit has to survive it.
 */
export function setTurnLanes(
  x: number, y: number, approach: string, choice: TurnLaneChoice,
  control: JunctionControl = 'priority',
): DocCommand {
  let before: { index: number; value: TurnLaneOverride[] | undefined } | null = null;
  let added = false;
  const LABELS: Record<TurnLaneChoice, string> = {
    auto: 'Turn lanes: automatic',
    none: 'Remove turn lane',
    left: 'Add a left-turn lane',
    right: 'Add a right-turn lane',
    both: 'Add turn lanes both ways',
  };
  return {
    label: LABELS[choice],
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      added = index < 0;
      const next = (list: TurnLaneOverride[] | undefined): TurnLaneOverride[] | undefined => {
        const kept = (list ?? []).filter((t) => t.approach !== approach);
        // `auto` is what an absent entry already means, so it is stored as absence.
        if (choice !== 'auto') kept.push({ approach, choice });
        return kept.length ? kept : undefined;
      };
      if (added) {
        before = null;
        // A fresh override has to say *some* control, and it must be the one the
        // junction already has. Writing 'priority' here switched every all-way stop
        // to priority the moment anybody touched its turn lanes — the row lit up
        // wrong in the panel, and the stop signs disappeared from the map.
        model.junctions.push({ x, y, control, turnLanes: next(undefined) });
        return;
      }
      before = { index, value: model.junctions[index].turnLanes };
      model.junctions[index].turnLanes = next(before.value);
    },
    revert(model) {
      if (added) {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      } else if (before) {
        model.junctions[before.index].turnLanes = before.value;
      }
    },
  };
}

/**
 * Makes a T junction right-in / right-out, or puts it back.
 *
 * Keyed by position like every junction choice. A fresh override carries the
 * junction's own control so that switching this on does not also switch an
 * all-way stop to priority behind the user's back — though the compiler runs a
 * right-in / right-out on priority regardless, and says so in the panel.
 */
export function setRightInRightOut(
  x: number, y: number, on: boolean, control: JunctionControl = 'priority',
): DocCommand {
  let before: { index: number; value: boolean | undefined } | null = null;
  let added = false;
  return {
    label: on ? 'Make junction right-in / right-out' : 'Allow every turn at junction',
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      added = index < 0;
      if (added) {
        before = null;
        model.junctions.push({ x, y, control, ...(on ? { rightInRightOut: true } : {}) });
        return;
      }
      before = { index, value: model.junctions[index].rightInRightOut };
      if (on) model.junctions[index].rightInRightOut = true;
      else delete model.junctions[index].rightInRightOut;
    },
    revert(model) {
      if (added) {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      } else if (before) {
        if (before.value === undefined) delete model.junctions[before.index].rightInRightOut;
        else model.junctions[before.index].rightInRightOut = before.value;
      }
    },
  };
}

export function setOptionLane(x: number, y: number, on: boolean): DocCommand {
  let before: { index: number; value: boolean | undefined } | null = null;
  let added = false;
  return {
    label: on ? 'Let the through lane take this exit' : 'Give this exit its own lane',
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      added = index < 0;
      if (added) {
        before = null;
        model.junctions.push({ x, y, control: 'priority', optionLane: on });
        return;
      }
      before = { index, value: model.junctions[index].optionLane };
      model.junctions[index].optionLane = on;
    },
    revert(model) {
      if (added) {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      } else if (before) {
        model.junctions[before.index].optionLane = before.value;
      }
    },
  };
}

/**
 * Sets how many of a merge's lanes stay on the highway.
 *
 * A count rather than a flag: a two-lane entrance can keep both lanes, keep one and
 * merge the other into it, or keep neither. With only a flag the middle answer was
 * forced, so a two-lane entrance grew a lane and lost it again three hundred metres
 * later with nothing to say about it.
 */
export function setAddedLanes(x: number, y: number, count: number): DocCommand {
  const n = Math.max(0, Math.floor(count));
  let before: { index: number; value: number | undefined } | null = null;
  let added = false;
  return {
    label: n > 0 ? `Keep ${n} lane${n === 1 ? '' : 's'} from this entrance` : 'Taper this entrance away',
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      added = index < 0;
      if (added) {
        before = null;
        model.junctions.push({ x, y, control: 'priority', ...(n > 0 ? { addedLanes: n } : {}) });
        return;
      }
      before = { index, value: model.junctions[index].addedLanes };
      if (n > 0) model.junctions[index].addedLanes = n;
      else delete model.junctions[index].addedLanes;
    },
    revert(model) {
      if (added) {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      } else if (before) {
        if (before.value === undefined) delete model.junctions[before.index].addedLanes;
        else model.junctions[before.index].addedLanes = before.value;
      }
    },
  };
}

/**
 * Allows or forbids the kerb-side turn against a red at one junction.
 *
 * Stored only when it is *off*, because on is the default and a document should
 * not fill up with entries recording that everything is normal.
 */
export function setTurnOnRed(x: number, y: number, on: boolean): DocCommand {
  let before: { index: number; value: boolean | undefined } | null = null;
  let added = false;
  return {
    label: on ? 'Allow turns on red' : 'Forbid turns on red',
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      added = index < 0;
      if (added) {
        before = null;
        model.junctions.push({ x, y, control: 'signal', ...(on ? {} : { turnOnRed: false }) });
        return;
      }
      before = { index, value: model.junctions[index].turnOnRed };
      if (on) delete model.junctions[index].turnOnRed;
      else model.junctions[index].turnOnRed = false;
    },
    revert(model) {
      if (added) {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      } else if (before) {
        if (before.value === undefined) delete model.junctions[before.index].turnOnRed;
        else model.junctions[before.index].turnOnRed = before.value;
      }
    },
  };
}

/**
 * Stores (or clears) a junction's signal plan.
 *
 * Kept on the same position-keyed override as the control choice, so a junction
 * that has been switched off signals and back on still has the plan it was given.
 * Passing `null` hands the junction back to the compiler's own generator.
 */
export function setSignalPlan(x: number, y: number, plan: SignalPlanSpec | null): DocCommand {
  let before: { index: number; value: SignalPlanSpec | undefined } | null = null;
  let added = false;
  return {
    label: plan ? 'Edit signal timing' : 'Use the automatic signal plan',
    apply(model) {
      const index = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
      added = index < 0;
      if (added) {
        before = null;
        model.junctions.push({ x, y, control: 'signal', signal: plan ?? undefined });
        return;
      }
      before = { index, value: model.junctions[index].signal };
      model.junctions[index].signal = plan ?? undefined;
    },
    revert(model) {
      if (added) {
        const i = model.junctions.findIndex((j) => Math.hypot(j.x - x, j.y - y) < 1);
        if (i >= 0) model.junctions.splice(i, 1);
      } else if (before) {
        model.junctions[before.index].signal = before.value;
      }
    },
  };
}

/** Replaces the whole document, for load and for "new". */
export function replaceDocument(next: EditModel): DocCommand {
  let before: EditModel | null = null;
  const snapshot = structuredClone(next);
  return {
    label: 'Load',
    apply(model) {
      before = structuredClone(model);
      Object.assign(model, structuredClone(snapshot));
    },
    revert(model) {
      if (before) Object.assign(model, structuredClone(before));
    },
  };
}

export function setUnderlay(underlay: ImageUnderlay | null, label = 'Add underlay'): DocCommand {
  let before: ImageUnderlay | null = null;
  const snapshot = underlay ? { ...underlay } : null;
  return {
    label,
    apply(model) {
      before = model.underlay ? { ...model.underlay } : null;
      model.underlay = snapshot ? { ...snapshot } : null;
    },
    revert(model) {
      model.underlay = before ? { ...before } : null;
    },
  };
}

/** Moves, scales or rotates the underlay; consecutive drags coalesce. */
class TransformUnderlay implements DocCommand {
  readonly label = 'Move underlay';
  constructor(public from: ImageUnderlay, public to: ImageUnderlay) {}

  apply(model: EditModel): void {
    if (model.underlay) model.underlay = { ...this.to };
  }

  revert(model: EditModel): void {
    if (model.underlay) model.underlay = { ...this.from };
  }

  coalesce(prev: DocCommand): boolean {
    if (!(prev instanceof TransformUnderlay)) return false;
    prev.to = this.to;
    return true;
  }
}

export function transformUnderlay(from: ImageUnderlay, to: ImageUnderlay): DocCommand {
  return new TransformUnderlay({ ...from }, { ...to });
}

export function updateGeo(patch: Partial<GeoSettings>): DocCommand {
  let before: GeoSettings | null = null;
  return {
    label: 'Change map settings',
    apply(model) {
      before = { ...model.geo };
      Object.assign(model.geo, patch);
    },
    revert(model) {
      if (before) Object.assign(model.geo, before);
    },
  };
}
