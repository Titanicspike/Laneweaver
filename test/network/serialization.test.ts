import { describe, expect, it } from 'vitest';
import { deserialize, serialize, SaveError, fromSaveFile, toSaveFile } from '@core/util/serialization';
import { compile } from '@core/network/compiler';
import { createDocument, SAVE_VERSION } from '@core/network/model';
import { addProfile, addStroke, doc, line, pts, smooth } from '../helpers/build';

function sampleDoc() {
  const model = doc(4242);
  const freeway = addProfile(model, {
    name: 'Freeway', lanesForward: 3, lanesBackward: 0, laneWidth: 3.65, shoulder: 2.5,
    rampSpec: { accelLaneLength: 210, decelLaneLength: 150, taperLength: 70 },
  });
  const ramp = addProfile(model, { name: 'Ramp', lanesForward: 1, lanesBackward: 0, isRamp: true });
  addStroke(model, freeway, line(0, 0, 2000, 0));
  addStroke(model, ramp, smooth(pts(600, 120, 800, 60, 1000, 0)));
  addStroke(model, freeway, line(-100, -400, -100, 400), 1);
  model.settings.demandScale = 1.7;
  model.terrain.enabled = true;
  model.demand = [{ fromPortal: 0, toPortal: 1, rate: 1200 }];
  model.junctions = [{ x: 12, y: -4, control: 'signal' }];
  model.underlay = {
    src: 'data:image/png;base64,iVBORw0KGgo=',
    x: 10, y: -20, width: 800, height: 600, rotation: 0.3, opacity: 0.55, visible: true,
  };
  model.geo = {
    enabled: true, lat: 51.5074, lon: -0.1278,
    tileUrl: 'https://example.invalid/{z}/{x}/{y}.jpg', attribution: 'Example', opacity: 0.8,
  };
  return model;
}

describe('save round-trip', () => {
  it('preserves everything the editor can change', () => {
    const before = sampleDoc();
    const after = deserialize(serialize(before));
    expect(after.version).toBe(SAVE_VERSION);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.strokes).toEqual(before.strokes);
    expect(after.settings).toEqual(before.settings);
    expect(after.terrain).toEqual(before.terrain);
    expect(after.demand).toEqual(before.demand);
    expect(after.junctions).toEqual(before.junctions);
    expect(after.underlay).toEqual(before.underlay);
    expect(after.geo).toEqual(before.geo);
    expect(after.nextId).toBe(before.nextId);
  });

  it('compiles to an identical network after a round-trip', () => {
    const before = compile(sampleDoc());
    const after = compile(deserialize(serialize(sampleDoc())));
    expect(after.lanes.length).toBe(before.lanes.length);
    expect(after.junctions.length).toBe(before.junctions.length);
    for (let i = 0; i < before.lanes.length; i++) {
      expect(Array.from(after.lanes[i].centerline)).toEqual(Array.from(before.lanes[i].centerline));
    }
  });

  it('writes control points compactly', () => {
    const file = toSaveFile(sampleDoc());
    const stroke = file.strokes[0] as { points: number[][] };
    expect(Array.isArray(stroke.points[0])).toBe(true);
    // Six for the point and its handles, plus the level it sits at.
    expect(stroke.points[0].length).toBe(7);
  });

  it('stays small', () => {
    expect(serialize(sampleDoc()).length).toBeLessThan(5000);
  });

  it('drops an underlay with no image data', () => {
    const file = toSaveFile(sampleDoc());
    (file.underlay as { src: string }).src = '';
    expect(fromSaveFile(file).underlay).toBeNull();
  });

  it('clamps out-of-range georeferences', () => {
    const file = toSaveFile(sampleDoc());
    Object.assign(file.geo as Record<string, unknown>, { lat: 999, lon: -999, opacity: 5 });
    const model = fromSaveFile(file);
    expect(model.geo.lat).toBeLessThanOrEqual(85);
    expect(model.geo.lon).toBeGreaterThanOrEqual(-180);
    expect(model.geo.opacity).toBeLessThanOrEqual(1);
  });
});

describe('loading imperfect files', () => {
  it('rejects nonsense', () => {
    expect(() => deserialize('not json')).toThrow(SaveError);
    expect(() => deserialize('null')).toThrow(SaveError);
    expect(() => deserialize('{"version":1,"profiles":[],"strokes":[]}')).toThrow(SaveError);
  });

  it('refuses files from a newer format', () => {
    const file = toSaveFile(sampleDoc());
    file.version = SAVE_VERSION + 5;
    expect(() => fromSaveFile(file)).toThrow(/newer version/);
  });

  it('drops strokes with too few points instead of failing', () => {
    const file = toSaveFile(sampleDoc());
    (file.strokes as { points: number[][] }[])[0].points = [[0, 0]];
    const model = fromSaveFile(file);
    expect(model.strokes.length).toBe(2);
  });

  it('repoints strokes whose profile went missing', () => {
    const file = toSaveFile(sampleDoc());
    file.profiles = [file.profiles[0]];
    const model = fromSaveFile(file);
    const kept = (file.profiles[0] as { id: number }).id;
    for (const s of model.strokes) expect(s.profileId).toBe(kept);
  });

  it('fills in missing settings with defaults', () => {
    const file = toSaveFile(sampleDoc());
    file.settings = {};
    delete file.terrain;
    const model = fromSaveFile(file);
    expect(model.settings.driveOnRight).toBe(true);
    expect(model.terrain.enabled).toBe(false);
  });

  it('accepts object-form control points from an older writer', () => {
    const file = toSaveFile(sampleDoc());
    (file.strokes as { points: unknown[] }[])[0].points = [
      { x: 0, y: 0 }, { x: 100, y: 0 },
    ];
    const model = fromSaveFile(file);
    expect(model.strokes[0].points[1])
      .toEqual({ x: 100, y: 0, hix: 100, hiy: 0, hox: 100, hoy: 0, grade: 0 });
  });

  it('keeps ids from colliding after a load', () => {
    const file = toSaveFile(sampleDoc());
    file.nextId = 1;
    const model = fromSaveFile(file);
    for (const p of model.profiles) expect(model.nextId).toBeGreaterThan(p.id);
    for (const s of model.strokes) expect(model.nextId).toBeGreaterThan(s.id);
  });
});

describe('a fresh document', () => {
  it('round-trips', () => {
    const model = createDocument();
    expect(deserialize(serialize(model))).toEqual(model);
  });
});

describe('migrating a v1 file', () => {
  it('moves the stroke level onto every control point', () => {
    // v1 kept one level per stroke. Loading one must not silently flatten the road
    // to ground level, and must not leave the old field lying around either.
    const v1 = {
      version: 1,
      profiles: toSaveFile(sampleDoc()).profiles,
      strokes: [
        {
          id: 900,
          profileId: (toSaveFile(sampleDoc()).profiles[0] as { id: number }).id,
          grade: 1,
          points: [[0, 0, 0, 0, 0, 0], [200, 0, 200, 0, 200, 0]],
        },
      ],
      settings: toSaveFile(sampleDoc()).settings,
      nextId: 1000,
    };
    const model = fromSaveFile(v1 as never);
    expect(model.strokes.length).toBe(1);
    expect(model.strokes[0].points.every((p) => p.grade === 1)).toBe(true);
    expect((model.strokes[0] as unknown as { grade?: number }).grade).toBeUndefined();
  });
});
