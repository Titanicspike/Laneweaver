# Laneweaver — free-form micro-traffic simulator

This file is the source of truth for architecture, conventions, and priorities. Read it before making
changes. Update it when a decision here changes — stale docs are worse than no docs.

## What we're building

A 2D top-down traffic simulator where roads are drawn free-form (no grid). Crossings are detected
automatically and compiled into working intersections. Bridges and tunnels let roads pass over/under
each other. All rendering is vector art. Users can design custom road profiles (lanes per direction,
widths, speed limits) or use presets. On top of the drawn network runs a realistic, performant
microscopic traffic simulation.

**Flagship feature: highway merges that work flawlessly.** On-ramps, off-ramps, and lane drops must
produce smooth, cooperative, deadlock-free merging — this is where most traffic sims fall apart, and
it is our differentiator. Merge quality is tested, measured, and never regressed.

## Tech stack

- TypeScript (strict mode), Vite, Vitest.
- Rendering: Canvas 2D with cached `Path2D` geometry. Migrate hot paths to PixiJS/WebGL only if
  profiling proves the need — at 5,000 vehicles a street-level frame currently costs ~0.6 ms.
  That number lives in one place: whatever `npm run bench` last reported. Quoting it twice is how
  it goes stale, and a stale frame cost is exactly the number a decision to rewrite the renderer
  would be argued from.
- UI: plain DOM panels. No framework until panels get complex.
- Libraries: `polygon-clipping` (junction footprints), `rbush` (spatial index), `simplex-noise` +
  `d3-contour` (terrain module only).
- **No bezier library.** "Sample, don't solve" (below) means we never need analytic curve offsets or
  bezier–bezier intersection, and the two things we *do* need — adaptive flattening and de Casteljau
  splitting — are ~30 lines each in `core/geom/flatten.ts` with exactly the tolerance semantics the
  compiler wants. A dependency that is only decorative is a liability.

Commands:

```bash
npm run dev          # Vite dev server
npm test             # Vitest, single run
npm run test:watch   # Vitest watch mode
npm run typecheck    # tsc --noEmit
npm run bench        # performance smoke benchmarks (~30 s)
npm run audit        # geometric audit of the scenario zoo (see Testing strategy)
```

With the dev server up, `/gallery.html` draws every scenario in the zoo through the real renderer;
that plus `npm run audit` is how visual work gets checked.

## Non-negotiables

1. **Headless core.** `src/core/**` never imports DOM, Canvas, or anything browser-only. Everything
   in core must be runnable and testable under Vitest in Node.
2. **Sample, don't solve.** All geometry operates on adaptively flattened polylines (tolerance
   ~0.15 m). No exact bezier–bezier intersection, no analytic curve offsets. Crossings = segment
   tests against an R-tree; lane geometry = polyline offsets; positions = arc-length table lookups.
3. **Determinism.** Fixed sim timestep `dt = 0.05 s` (20 Hz). Seeded RNG (mulberry32) threaded
   explicitly — `Math.random` is banned in core. Stable iteration order everywhere (lanes by id,
   vehicles front-to-back within a lane; ties break on id). Same seed + same inputs = identical run,
   always.
4. **Units.** 1 world unit = 1 metre. Time in seconds, speed in m/s. Default lane width 3.5 m;
   default car 4.6 × 1.8 m. Profiles are authored in km/h because that is how humans think.
5. **Performance.** Sim state is structure-of-arrays in typed arrays (`Float32Array`/`Int32Array`).
   Zero allocations inside per-tick hot loops. Budget: 5,000 vehicles, sim tick ≤ 6 ms, 60 fps
   rendering on a mid-range laptop. `npm run bench` asserts all three.

   **Editing has a budget too, and it is the one users notice first.** `compile()` is whole-network
   and so is the renderer's bake of it; running both on every frame of a drag *is* the frame, and it
   got worse linearly with the size of the map — 86 ms per frame on a 421-segment town, which is
   exactly the five frames a second it felt like. During an interactive gesture the rebuild gets a
   duty cycle (at most one part in `REBUILD_DUTY` of the clock) and the editor draws the roads being
   dragged itself, straight from their flattened centrelines. A small document still rebuilds every
   frame, because a two-millisecond compile clears the budget every time. Which roads to draw is
   answered by a cheap fingerprint of each stroke's control points recorded at compile time: commands
   go through the undo stack, so the store is told only that *something* changed, and a fingerprint
   stays right whichever tool did the editing and whether or not it thought to say so.

   **The bake counts, and decoration is not on the editing path.** The duty cycle bills the compile
   *and* the `Path2D` bake, because on a town the bake was the larger half. What made it large was
   the buildings: laying out fifteen thousand plots cost over a second, 85% of it in one point test
   (see Rendering). Roads are baked in `NetworkPaths`'s constructor; houses and trees are baked by
   `decorate(budgetMs)`, which the frame loop calls with six milliseconds a frame until it is done, a
   road at a time, so a large town's decoration fills in over a few dozen frames instead of freezing
   the end of every edit. Tests, the gallery and the audit leave `decorate` on and get the whole
   picture at once. Measured in Firefox on a 1,012-segment town: drag frames 17 ms median, 34 ms
   worst; gesture end 310 ms, of which the road bake is 21 ms and the rest is the compile — now the
   wall at that size, and flat in the profiler (nothing above 8%), so the next step there is
   compiling incrementally rather than shaving constants.

   **An edit refills its own surroundings, not the whole town.** Taking decoration off the editing
   path had a side effect the first time round: the new picture started empty, so every edit emptied
   the map of houses and refilled it over forty frames — "changing one road reloads the entire
   town". Only the road changed, and a plot depends on nothing further away than a house-depth. So
   the store records the area round each edit (the changed strokes' old and new bounds plus
   `EDIT_HALO`), the new `NetworkPaths` carries the previous one, and `decorationTiles` serves the
   old picture's houses everywhere else until the new ones are ready. A document swap has no
   surroundings — everything changed — so nothing old shows through.

   Compile timings differ a lot by harness: the town example compiles in **6 ms warm in Firefox**
   and 69 ms under Node with `tsx`. Trust the browser number for editing decisions; the Node one is
   what the tests and `npm run bench` see.
6. **Only the edit model persists.** The compiled network is derived data — always rebuildable,
   never saved.
7. **Undo/redo from milestone 1**, via the command pattern. Every edit is a command with
   `apply`/`revert`. One drag is one undo step (commands coalesce).
8. **Geometry code ships with tests.** The compiler is where all the subtle bugs live. New geometry
   behaviour = new unit cases, written first or alongside.

## Architecture

One-way pipeline. Data flows down; nothing reaches back up.

```
Edit model  ──►  Network compiler  ──►  Lane graph  ──►  Simulation
(strokes,        (flatten, split,       (lanes,          (routing, IDM,
 profiles)        junctions, lanes)      connectors,      MOBIL, merges,
                                         conflicts)       signals)
                          │                                   │
                          └────────────►  Renderer  ◄─────────┘
                                     (vector layers, LOD)
```

- **Edit model**: what the user manipulates and what gets saved. Bezier strokes + road profiles +
  settings + junction control overrides + reference imagery.
- **Network compiler**: pure function `compile(editModel) -> Network`.
- **Lane graph**: the sim's world. Road lanes and junction connectors are the same kind of thing —
  see below.
- **Simulation**: fixed-timestep vehicle update on the lane graph. Knows nothing about beziers or
  pixels.
- **Renderer**: draws network + interpolated sim state. Read-only consumer, enforced by a test.

```
src/
  core/
    geom/       # vec2, polyline ops, flattening, offsetting, arclength, polygon booleans, rbush
    geo/        # web mercator, for tracing over satellite imagery
    osm/        # OpenStreetMap import: tags to road types, ways to strokes
    network/    # edit model types, compiler, lane graph helpers, validation
    sim/        # vehicle state (SoA), idm, mobil, merge, junctions, signals, router, spawner
    terrain/    # heightfield generation and build constraints
    util/       # rng, ids, command pattern, serialization
  render/       # canvas renderer, cached path layers, terrain/underlay layers, camera, theme
  editor/       # tools, snapping, curve editing, commands
  app/          # entry point, bootstrap, main loop, store, DOM panels, demo document
test/
  geom/  network/  sim/  editor/  render/
  scenarios/    # merge + junction scenario fixtures and regression metrics
bench/          # performance smoke benchmarks
```

## Data model

```ts
// ---- Edit model (persisted) ----
interface RoadProfile {
  id: Id;
  name: string;                    // "2-lane residential", "3-lane freeway", ...
  lanesForward: number;
  lanesBackward: number;           // 0 = one-way
  laneWidth: number;               // m
  speedLimit: number;              // m/s
  median: number;                  // m, 0 = none
  shoulder: number;                // m, widens the asphalt only
  isRamp: boolean;                 // changes junction classification thresholds
  rampSpec?: { accelLaneLength; decelLaneLength; taperLength };  // 220 / 160 / 75 m
  verge?: number;                  // m of planted verge either side; decoration only
  landUse?: LandUse;               // 'residential' | 'commercial'; see spawn modes
}

interface Stroke {
  id: Id;
  profileId: Id;
  landUse?: ZoneChoice;            // zoning painted on this road; overrides the profile
  points: ControlPoint[];          // bezier control points w/ absolute handle positions
}                                  // ...each carrying its own `grade`

interface ControlPoint {
  x; y; hix; hiy; hox; hoy;
  grade: number;                   // -1 tunnel, 0 ground, +1 bridge, ...
}

interface EditModel {
  version; profiles; strokes; settings; terrain; demand;
  junctions: JunctionOverride[];   // control-type choices, keyed by position
  laneLinks: LaneLinkOverride[];   // hand-wired junction movements, keyed by position
  gateways: GatewayOverride[];     // what each end of the network may do, by position
  underlay: ImageUnderlay | null;  // dropped image to trace over
  geo: GeoSettings;                // lat/lon anchor + XYZ tile template
  nextId: number;
}
```

### Importing OpenStreetMap

`core/osm` reads an Overpass extract into an edit model: tags to road profiles, surveyed
polylines back to bezier control points (`core/geom/fit.ts`, the inverse of flattening), `layer` /
`bridge` / `tunnel` to per-point grade, and a `gateways` spawn mode with the interior road ends
closed so traffic enters only where the extract was cut.

**Two ways that cross without sharing a node do not connect.** That is the one piece of topology a
survey has and a hand-drawn document does not, and ignoring it was the largest single source of
wrong network in an import: the compiler can only see geometry, so it wired every untagged flyover
into the street beneath it — **752 junctions OSM does not have** across twenty imported squares, 229
of them with a motorway or trunk road as an arm. A freeway with traffic lights on it, drivers
leaving it in the middle of a span, and on the worst square almost no traffic completing its trip.
`core/osm/flyovers.ts` finds those crossings and puts the roads on different levels — which is what
the compiler already understands, because grade lives on control points. The spans are fitted to the
road available: ways between junctions are often eighty metres and a fixed span needs seventy-four,
so a fixed one refused most of the bridges that most needed building. A span is still refused where
it would reach a way's end, because the ends are where the junctions are.

**Which road goes over is a colouring, not a pairwise choice.** At an interchange four ramps crossing
in the same hundred metres have six crossings between them, and "the bigger road goes over" applied
to each in turn puts three of them on level 1 — where they cross each other again and the compiler
joins them straight back up. `assignLevels` colours the whole crossing graph at once, greedily in
ascending order of road class, so the street keeps the ground, the arterial over it goes to 1 and
the motorway over both to 2. Four levels is the cap: a road that would need more is left where it
is, because one wrong junction beats a road hanging in the sky.

**A road changes level over a fixed thirty metres, and that is load-bearing twice over.** The level
used to be written onto whatever control points the fit had already produced, so the ramp was however
far apart its last two points happened to be — on a way whose final span was two hundred metres, a
hundred metres of bridge rounded to ground level, and the compiler joined it to whatever passed
underneath. Forcing a control point at the ramp distance cut the invented junctions involving a road
over 85 km/h from 49 to 5. It is also what the transition *looks* like, and an arbitrary one looks
arbitrary.

**A tunnel comes up to meet the road, as a bridge comes down.** The end level was `Math.min` of the
way's own level and the node's, which ramps a bridge down to the street it lands on and leaves a
tunnel at the bottom of its shaft: `min(-2, 0)` is -2, so the mouth never rose and the compiler —
for which roads at different levels do not meet — left the whole tunnel connected to nothing at
either end. Moscow has 543 tunnel strokes and London 140; fixing it removed 1,325 dangling portals
from Moscow alone and took its mean speed from 16 km/h to 24.

A way that *ends* near another it shares no node with is left alone: that is a T, no amount of
raising makes it anything else, and a mapper forgetting a node on a service road is commoner than an
untagged residential flyover. Those are most of what the measurement still counts.

`settings.spawnMode` decides where traffic comes from, and the three answers are
genuinely different questions rather than three dials on one:

```ts
type SpawnMode =
  | 'portals'    // every place the network stops, weighted by road size. The default,
                 // because it needs nothing set up — every scenario uses it.
  | 'gateways'   // only the ends the user marked, only the direction they marked them.
                 // How you ask "what if everything came in from the north".
  | 'landuse'    // trips start *along* residential roads and finish at commercial ones.
                 // Nothing enters from off-map: the traffic is the town's own.
  | 'mixed';     // both: the town's own trips plus through traffic from every road end.
                 // What a town with a freeway past it sees — see below for why it exists.
```

A **zone** is the land-use half of that, and it is compiled rather than authored:
every lane of every road carrying one land use, taken together. Zones continue the
portals' id space — a zone's id starts where the portals' ids stop — so a
destination stays a single number in the store, the router and the spawner, and none
of them had to learn about a second kind of thing. Arriving at a zone is not driving
off the end of the network the way arriving at a portal is; it is *reaching* one of
its streets and stopping at a **frontage** — a driver pulling onto their own road and
parking outside a house that is actually drawn there.

Which house is chosen uniformly among the addresses far enough into the street, seeded
per driver and per lane. It used to be a fixed `min(30 m, half the lane)`, and the
symptom was unmistakable once looked at: **67% of arrivals in the first fifth of the
lane and none at all past the middle**, so a town's traffic appeared to vanish at the
mouth of every road and the houses further down were scenery nobody drove to. Picking
"the first address past a random distance" is not the fix either — it loads the near
end of the street, because the far addresses are only reachable by the few drivers who
drew a long offset.

**One zone per street**, not per use — every segment of one zoned stroke. It was one
zone per use, on the argument that a trip is "to the shops" rather than to a
particular shop and that one cost table per use is cheaper than one per street. The
consequence was measured on a real network: with "the commercial zone" as the
destination, the routing field sends every driver to the *nearest* commercial lane,
so 12 of 83 shop streets received every arrival on the map, the median trip was
400 m, and the freeway carried nothing. Per street, a trip has a destination
somewhere in particular; the spawner spreads a home's trips over shop streets by a
gravity rule (`TRIP_DISTANCE_SCALE`, 2 km to halve a street's pull), and the router's
cost tables are built lazily per destination, so a street nobody is heading for
costs nothing. Same network afterwards: median trip 800 m, 50 shop streets served.
Trips still run only house-to-shop and back — one from one residential street to
another is one nobody makes on purpose.

**A driver leaves in the direction that gets them there.** The spawner draws a lane
along the origin street by length, among the lanes from which the destination is
reachable. It used to draw first and give up when the lane could not get there — and
a street at the map's edge has a whole direction that leads only off it. On that
network 12% of residential frontage faced the wrong way, and every trip that drew it
was thrown away.

**The town's own trips never leave the map, and a freeway is a through route.** On
that same network not one of 2,464 house-to-shop pairs was faster by the freeway; it
runs from one edge to the other and nobody in town was going that way. That is what
the `mixed` mode is for: the land-use trips plus the `portals` demand from every road
end, weighted by road size as usual, so a freeway past a town carries the traffic
that is not the town's. The land-use mode falls back to `portals` when a document has
no land use at all, because a mode that silently generates nothing is
indistinguishable from a broken one.

**A road's frontages are where its buildings are, and they are compiled**
(`core/network/frontage.ts` -> `Segment.frontages`). One rule, in one place, read
twice: the renderer lays a plot on every frontage, and the simulation starts and ends
land-use trips on the same ones. That is why it is in core rather than in the
renderer — a car that pulls out where no house stands, or vanishes in the middle of a
block, is what gives away that the houses are wallpaper. Frontages are positions along
the *segment centreline* rather than the asphalt edge, because equal pitch on the
centreline is what real plots have on a curve: wider at the kerb on the outside of a
bend, narrower on the inside, with one shared boundary between neighbours rather than
two that disagree.

**Zoning is painted, and the road type is the default.** Land use began as a property
of the profile alone, on the theory that "residential street" is already a road type.
That is right for drawing a town and wrong for the next thing anybody wants: take
*this* stretch of street and put shops on it. So `Stroke.landUse` overrides
`RoadProfile.landUse`, with a third state — `'none'` — that says "this particular
street has nothing along it" without editing the road type everybody else is using.
The **segment** carries the resolved answer, and everything downstream reads it from
there: the zones the router uses, and the buildings the renderer draws. Reading the
*profile* in one of those two and the segment in the other is a split brain, and it
shipped once — a painted street grew houses and generated no traffic at all, which a
six-by-six stress town found by compiling 2,375 plots and zero zones.

### Cul-de-sacs

A street that stops can be a **turning head**: a bulb of asphalt at the end, a U-turn from the lane
coming in to the lane going out, and the houses standing round the circle instead of along a street.

**It is asked for, never assumed.** Every road that stops is a *portal* — where trips begin and end —
so turning every dead end into a head would take the traffic out of half the scenarios in the suite
and out of whatever the user had already drawn. It is the fifth value on the same position-keyed
override that already says what each end of the network lets traffic do (`GatewayRole` gains
`'culdesac'`), because to the person clicking the end it is the same question asked once: what
happens here. The junction tool cycles both ways → in only → out only → closed → cul-de-sac.

**The U-turn is the load-bearing part.** It is what makes the end stop being a portal, and it does so
without anything having to say it: the portal rule is "a lane with somewhere to go is not an exit",
and now it has somewhere. It is also what makes the head a place rather than a wall — a driver can
reach a house at the end and get out again. A one-way street has nothing to turn into, so it is
refused with a diagnostic rather than built into a road nobody can leave.

**The road is cut back by the bulb's radius**, which is the same shape of cut a ramp makes and goes
in the same list. Draw a hundred metres of street and get ninety metres of street with a turning head
on the end, rather than a hundred and ten metres of road: the whole thing lands inside the stroke that
was drawn. The radius comes from the road's own width, floored at 9 m — what a car can actually turn
in, and what real residential heads are built to.

**The head flares into the road, and its paint carries the road's across.** A plain circle at the end
of a street is a lollipop — and it does not even meet the road: at the kerb the circle has already
curved away, so there is a wedge of bare ground either side of the mouth, and the whole thing reads as
a disc parked next to a street rather than the end of one. Real heads are built with kerb returns, and
so is this: an arc tangent to the road's edge at one end and to the bulb at the other, so the kerb
runs from the street round the head and back with no corner in it. The same outline, inset by one
shoulder, is the head's **edge line** (`Junction.markings`, exactly as a gore carries the ramp's paint
across the blend) — without it the road's paint stops dead across the carriageway and nothing but
adjacency says the two are one road. The returns **follow the stroke's curve** rather than running
straight out of the mouth: they reach twenty metres back up the road, and over that a residential bend
moves the kerb a metre and a half sideways, which is a metre and a half of daylight in exactly the
place the two lines have to meet.

**The loop is sized from the kerb it has to clear, not from a fraction of the radius.** A cubic's
apex sits at exactly three quarters of its handle (both control points are pushed the same distance
in along the road, so the curve runs 3h·u(1−u) up that axis), and the mouth is one radius from the
centre — so there are two radii of depth to spend, and the handle is whatever puts the apex a car's
width short of the far kerb. Guessed as a ratio instead it is either a hairpin down the middle of a
circle three times wider than it needs, which nothing longer than a car could use, or — half a step
further — a path two metres outside the asphalt.

**A head's houses are reached from the way out, and that is what makes the traffic turn round.** The
driveways open onto the turning circle, so a driver goes round it to reach one and is on the lane
leaving the head by the time they stop (`HeadPlot.fromSide`, checked by the traffic model against the
lane's own side). Without that the U-turn was scenery: a driver bound for the street parked at the
first address they passed on the way in, and nothing ever drove the connector — the same trap as an
escape hatch no state can reach. Ordinary frontages are still served by both directions, because you
park at your own house whichever way you came down the street.

**The ring is sized where the houses stand, not at the kerb.** A plot on the outside of a circle is a
wedge, so counting by its kerb width gives three vast gardens on a bulb that in reality holds five or
six houses. `Frontage.head` carries the bulb and the angle; the renderer takes the plot's frame from
the circle rather than from the segment centreline, and everything downstream — the trapezium of
ground, the probe for depth, the building laid square to the road — works unchanged.

**To the person clicking it, a head is an end of the road rather than a junction.** One movement, no
control to choose, no phases to edit — so the click cycles the end instead of opening the panel, and
the overlay draws it even though it is no longer a portal. Being picked as a junction first is what
made a cul-de-sac impossible to turn back off.

### Time of day

`settings.dayLength` compresses a day into that many simulated seconds (0 switches the
clock off and generates flat demand, which is what every scenario test wants).
`core/sim/clock.ts` holds two hourly curves, and they do different jobs:

- **How much** traffic there is: the classic camel back, a sharp morning peak, a
  broader evening one, a midday plateau at about half, and an overnight trough that is
  low but *never zero*. Never zero is not decoration — the spawner draws its next
  arrival from an exponential with the rate as its parameter, so a rate of zero gives
  an interval of infinity, and a pair that goes quiet at 03:00 never wakes up again.
- **Which way it goes**, which only means anything in the land-use mode. The morning
  is almost entirely house-to-shop and the evening almost entirely the reverse. Both
  directions are built at half rate each and the clock hands the hour to one of them;
  without that the morning peak and the evening peak are the same picture twice, which
  is exactly what a rush hour is not.

Both are sampled hourly and interpolated, because a step change on the hour puts a
visible seam in the traffic every sixty minutes. The first arrival is primed from the
rate *at the starting hour* rather than the base rate — otherwise a run beginning at
03:00 empties a whole hour's traffic into its first few minutes, and the busiest hour
of the day appears to be whichever one the simulation happened to start at.

### The lane graph

**Road lanes and junction connectors are the same type.** The simulation's hot loops touch these
constantly and a single hidden class keeps property access monomorphic, so `Lane` is one flat shape
with a `kind` discriminant; fields that do not apply to a kind hold `-1` / `Infinity`.

```ts
interface Lane {
  id: Id;
  kind: LaneKind;                  // Road | Connector
  segmentId: Id;                   // Road lanes; -1 for connectors
  junctionId: Id;                  // Connectors; -1 for road lanes
  index: number;                   // 0 = rightmost *through* lane of its direction group;
                                   // positive runs toward the median, auxiliary lanes take
                                   // negative slots. -1 for connectors.
  side: 1 | -1;                    // +1 travels along the parent stroke, -1 against it
  centerline: Float32Array;
  arclength: Float32Array;
  parentS: Float32Array;           // arc-length on the parent *segment* per centreline point
  length; width; offset; speedLimit;
  successors: Id[]; predecessors: Id[];
  left: Id; right: Id;             // lateral neighbours in the same direction group
  aux: boolean;                    // accel / decel / weaving lane
  startsAt: number;                // usable range in this lane's own arc-length
  endsAt: number;                  // Infinity for lanes that run through
  mergeTarget: Id;                 // lane to merge into before `endsAt`
  conflicts: ConflictPoint[];      // connectors only
  priorityRank: number;            // strict total order within the junction
  turn: TurnKind; signalGroup: number; yields: boolean;
}
```

**A connector's speed limit comes from the curvature it sustains, not from its worst vertex.**
`maxCurvatureOver` measures over a fixed arc-length baseline of about a vehicle length, because that
is the distance over which a car actually leans into a bend. Three adjacent samples of a flattened
curve measure the *flattening*: the points sit centimetres apart where it once had to subdivide and
metres apart where it did not, and a circumcircle through three nearly coincident points is
numerically meaningless. One imported connector reported a **0.13 m radius at a single vertex out of
fourteen whose median radius was 34 m**, and 138 straight-ahead movements in that one city were
limited to 13 km/h by exactly that. Three points on a circle give back that circle whatever their
spacing, so the baseline is exact where the geometry is real and rejects it where it is not.

`parentS` is the load-bearing field. Lanes of a segment share their parent centreline's arc-length
parameterisation, so `mapS(from, s, to)` converts a position on one lane to the exact equivalent
cross-section on a neighbour. The merge model leans on this constantly — it is what lets a car on a
ramp compare itself against traffic on the mainline with no geometric projection at run time.

```ts
type JunctionKind = "crossing" | "merge" | "diverge" | "link" | "culdesac";

// Paint that is a picture rather than a line, emitted per segment by the compiler.
interface RoadSymbol {
  kind: "arrow" | "stop";
  x; y; heading;                   // where it is painted and which way the lane runs
  turns: TurnKind[];               // the movements this lane can actually make
  width: number;                   // the lane's width, which is what sizes the paint
}
```

`link` is a junction kind the original sketch did not have: two roads meeting end to end at a shallow
angle. It has no footprint and no connectors — lane successors wire up directly — and it is where
lane drops happen (below).

`culdesac` is the turning head at the closed end of a street: a bulb, and one U-turn connector inside
it. See **Cul-de-sacs** below.

Vehicle state lives in SoA typed arrays keyed by a dense slot: `lane, s, v, a, urgency, gapLead,
gapLag, cooperateWith, ...`. `s` is the **front bumper** position, so the gap to a leader is
`s[lead] - s[me] - len[lead]`. Per-lane membership is a doubly linked list sorted by descending `s`;
cars cannot pass within a lane, so the order stays sorted for free.

## Network compiler

Compile steps, in order:

1. Flatten every stroke to a polyline (adaptive, tolerance 0.15 m, plus a 20 m cap on segment length
   so R-tree boxes stay tight); build arc-length tables; insert into an R-tree.
2. Find crossings between strokes **at the same level** (segment–segment tests via R-tree), plus
   stroke endpoints that land on or near another stroke. Level is a property of the point on each
   road, not of the road: grade lives on the control point and ramps between them, so a stroke that
   climbs crosses *under* what it later crosses *over*. Roads at different levels never intersect.
   Segments are split where a stroke passes each half-level, so every segment sits on one layer and
   the join lands where the abutment would.
   Hits are clustered into junctions by where they are **along the roads they share**, not by the
   distance between the hit points. Two stubs meeting a road from opposite sides, each stopping a few
   metres short of its centreline the way hand-drawn roads do, put their hit points twelve metres
   apart while being one place on the road — and compiled as two T-junctions back to back. Hits that
   share no road fuse when they lie within a junction's radius of each other, which is what four
   separate roads all ending near one point produce: each half of the through road pairs off with
   the stub whose end is nearest, and nothing ties the pairs together except the place (an end that
   projects past the other stroke's start is no hit at all, so the two halves never meet directly).
   Two genuinely unrelated junctions that close are already a `junctions-too-close` warning.
3. Cluster raw hits into junctions and classify each:
   - **Crossing**: paths cross at ≥ ~30°, or any T-junction.
   - **Merge / diverge**: a stroke *endpoint* meets another road at a shallow angle (< 30°, or < 45°
     for a profile marked `isRamp`). Merge if traffic flows in, diverge if out; a two-way ramp emits
     one of each.
   - **Link**: two stroke *ends* meeting at < 60°.
   - Near-parallel overlaps (< 8° without an endpoint) are invalid — rejected with an editor warning,
     no sliver junction.
4. Split strokes into segments at crossing junctions only. **Merges and diverges do not split the
   road they join** — that is the whole point; the mainline stays continuous and the ramp is trimmed
   back to its gore instead. The single exception is an **option lane** (step 7), which needs the
   kerb-side through lane to *end* at the gore so it has somewhere to branch from; that split is a
   plain joint, and it happens only where the document asks for one.
5. Generate junction footprints: trim each road back by a radius derived from road widths and the
   crossing angle. Three things about that trim were learned the hard way, all on junctions built
   from more than two strokes, which is how a real network is drawn:
   - **Arms that face each other across the meeting do not trim each other.** They are one road
     carrying on as a second stroke, or a stub either side of a through road, and nothing crosses
     them. The pair's angle folds to zero, where the formula clamps its sine at twenty degrees and
     trims both as if they crossed at that angle: a four-lane arterial drawn as two strokes meeting
     at a point was set back 52 m where 14 would do, and the junction was a fifty-metre slab.
   - **Of a shallow pair, one arm yields.** Two corridors at a shallow angle overlap for a long way
     along both, and trimming either past the overlap is enough — the other's corridor is paved by
     the junction there. The arm that ends at the meeting yields (failing that, the narrower), taking
     the long trim against the road *as it may be widened*, a lane more for a turn bay; the other is
     set back only as far as a stub meeting it square on would ask. A slip road joining an arterial
     at twenty degrees had set the arterial back 35 m to clear a road merely alongside it.
   - **Bays flare the approach, and the arms crossing it are re-trimmed once bays are known.** Bays
     are planned from the segments the trims define, so the first pass cannot see them; a street's
     cap corner then sat a metre inside the arterial's flare, and at a skew crossing its zebra was
     drawn over the arterial's kerb. After the bays are planned, every arm crossing a flared approach
     moves out by the flare over the sine of the angle between them, and the segments are planned
     again — once, because a bay's own length changes by a couple of metres at most.
     **An arm pays for the flare it meets, not for every flare at the junction.** A bay widens its
     approach's own kerb (see below), and the two approaches of a through road flare *opposite*
     kerbs — so a road crossing it has one arm against each, and each clears one. Charged the sum,
     every arm of every bayed junction stood a bay's widening too far back: the four-way priority
     crossing in `test/scenarios/junctions.test.ts` starved, backed up and stopped discharging, which
     is what a side road does when its own stop line is two metres past the traffic it must read.
   Measured across the zoo, no arm is now set back more than 5 m beyond what clearing the roads it
   meets requires (`scratch/setback.ts`), against 39 m before; footprint = union of the trimmed corridor ends (`polygon-clipping`), lightly
   corner-rounded. Each approach corridor reaches **across** the junction and no further — its length
   is its own trim plus the widest road it *crosses*, measured perpendicular to itself (so a skew
   crossing gets the longer span it needs). **Crossed** is doing the work: only a road that carries
   on out the other side is crossed. An arm with nothing opposite it is a road that stops here —
   traffic turns onto it, nobody drives over it — so there is no width to span. Without that, a Y
   junction, where all three roads end at one point and none is opposite another, had every arm
   reaching across every other: on one measured shape a four-metre-wide arm was told to reach 21.5 m
   past the junction because a 14.5 m road sat 31 degrees away, which puts a spur of asphalt into a
   sector with no road in it. An arm that stops at the junction reaches only to its own cap; it used
   to run on to the meeting point with a square end the full width of the road, and on a Y the
   corners of that end are two spikes either side of a V. The middle of the box is a **fan**
   instead: a wedge from each cap to the meeting point, and a triangle between the facing corners of
   every neighbouring pair of arms — the paved corner a real junction has. *Every* pair, including
   the two either side of a Y's empty sector: leaving that one out looked like the obvious economy
   and the audit refused it at once, because the turn between those arms swings round the empty
   side of the centre, and a connector over bare ground is a car on grass. Where the two corners
   are nearly opposite, the chord between them passes through the centre and paves nothing, so
   **any connector that leaves the box gets a corridor of its own width added** — a channelised
   corner, which is what a real junction of that shape builds. Reaching further leaves a
   rectangular bump of asphalt sticking out the far side of every T-junction. The arm opposite is the same road continuing, not a
   road to cross: its sine is about zero, and dividing by a clamped one made it the widest thing in
   the junction — which stretched the box, and the marking cover with it, far down a road nothing
   crosses. Anything shallower than 30 degrees compiles as a merge or a diverge, so a genuine
   crossing arm never has a small sine. A merge or diverge has no junction box, but its blend connector
   still covers real road, so it gets a **gore footprint**: a corridor around the blend connector,
   carrying the ramp's full width at the ramp end and matching the road's outer extent beside its
   auxiliary lane at the other, with both end caps buried in the surfaces they meet. Anything
   narrower leaves the wedge between the two edges — the gore itself — unpaved, and the ramp reads as
   a detached strip laid beside the freeway.

   An approach corridor is grown from the road's own **end cap** (`Segment.capStart` / `capEnd`), so
   it is exactly as wide as the road it continues and flush with both its edges, and it **follows the
   parent stroke's curve** rather than shooting a straight quad off the end of it. A shallow crossing
   needs an arm tens of metres long; a straight corridor wanders right off a curving road over that
   distance, and the union of four of them comes out as a lumpy blob with asphalt where no road goes.
   Past the end of the stroke the corridor carries straight on, because an arm still has to reach
   across the box even when the road it continues stops there. Corners are then filleted at a kerb radius scaled to the narrowest road; the
   corridor's tail reaches past that radius so filleting cannot nibble the joint. Chaikin corner
   *cutting* is the wrong tool here — it shortens every straight run, including the arm ends.
6. Offset lane centrelines from segment centrelines, culling cusps and self-intersection loops where
   curvature is too tight for the half-width, and recording the source parameter of every surviving
   point so `parentS` stays exact.
7. **Ramp synthesis.** At a merge, find the gore by intersecting the ramp centreline with the
   *auxiliary lane's* centreline — exactly where the two carriageways become one. The ramp's own
   segment stops a blend short of the gore, and the blend is the longer of a heuristic in the angle
   and the distance at which the ramp's near edge clears the road's outer edge, auxiliary lanes and
   shoulder included — a two-lane ramp joining at ten degrees was otherwise cut with its edge line
   three and a half metres inside the freeway. Grow the road an
   acceleration lane from there for `accelLaneLength`, then a taper of `taperLength` where the lane's
   outer edge closes in and the lane ends (`endsAt` set, `mergeTarget` = the adjacent through lane).
   Diverges mirror this upstream. An on-ramp lane and a following off-ramp lane that overlap **fuse
   into a single weaving lane**, which runs exactly **gore to gore** — it begins where the entrance
   joins and ends where the exit leaves — so through traffic must either exit or merge left. The
   union of the two lanes' extents is the same answer whenever there is room between the ramps and
   wrong at *both* ends when there is not, because connectors run lane-end to lane-start: a lane
   reaching past the exit makes the diverge connector swing back upstream to find the ramp, and one
   starting before the entrance makes the merge connector reach forward to find the lane.

   **Fusing is a decision about the whole stack, not about one lane in it.** A two-lane ramp brings
   in a stack whose lanes are deliberately staggered, so a merge stack and a following diverge stack
   can overlap at one depth and fall short at the next. Fusing only the depth that happens to overlap
   leaves a cross-section no road has — one continuous weaving lane beside two separate ones — and
   the road then asks to be split straight through the fused lane. If any depth of a pair of stacks
   overlaps, every matching depth fuses.

   Two arrangements are available per gore, both off by default because both trade something.
   An **option lane** at a diverge lets the kerb-side through lane take the exit as well as carrying
   on, so one lane on the highway both continues and branches off: the mainline is split at the gore
   to give it an end to branch from, and it becomes one of the exit's feeders rather than an extra
   one — the ramp gets an auxiliary lane fewer, floored at one so a single-lane exit keeps its
   deceleration lane. The trade is that exiting traffic then decelerates in a through lane, which is
   free below capacity and expensive above it. An **added lane** at a merge keeps the innermost lane
   the ramp brings in: it runs to the end of the road instead of tapering away, so the freeway simply
   gets wider, and only the innermost one — on a two-lane entrance the outer lane still merges into
   it, as a real one does. A lane that never ends carries no `mergeTarget`; a deceleration lane does
   not end with a merge either but still wants one, for a driver who changes their mind. An added
   lane only stays on the highway for as long as the highway is one uninterrupted stretch: it merges
   away before a crossing, a link, or an option lane's split, because an auxiliary lane cannot cross
   a joint and one left to run into a joint anyway stops with nowhere to go — which makes it an exit
   portal, a hole in the middle of the road that traffic vanishes into. Where an added lane reaches a
   later off-ramp it fuses with its deceleration lane by the ordinary weaving rule, which is exactly
   the auxiliary lane a real pair of ramps that close together would be given.

   A ramp gets **one auxiliary lane per lane it carries**, stacked outward and paired off lane for
   lane. Two lanes of ramp funnelling through one auxiliary lane leaves the road a lane too narrow
   and the ramp appears to double out of nothing at the gore. The outer lanes are staggered a taper's
   worth toward the gore, so the road grows a lane at a time instead of jumping two lanes wide at a
   single taper — which is both what a two-lane exit looks like and the only way the lane that has
   not appeared yet cannot be driven in. Which ramp lane takes which auxiliary lane depends on the
   side the ramp came in from: the ramp lane nearest the carriageway takes the innermost.
8. **Split a road that carries two separate auxiliary lanes on the same side.** A lane that could
   not be given the length it wanted raises `aux-lane-clipped`, but only past ten metres of overrun
   and with the metres in the message: junction trims move by a couple of metres as bays are planned,
   and a taper ending just inside a trim looks exactly like one ending just outside it, so warning on
   every one of those is a warning that means nothing. The split is a plain
   joint with no junction id, which makes it the one place a segment end is neither a junction nor
   the end of the road — see the portal rule below. A lane has one
   lateral neighbour each way, so two auxiliary lanes sharing a slot would have to share those
   links — and the acceleration lane's merge target would end up being the deceleration lane 500 m
   downstream, which nobody can reach. The road is split in the gap between them so each gets its
   own cross-section; the split is a plain joint with the through lanes wired straight across.
9. **Lane drops** compile through the same machinery. At a link junction with mismatched
   cross-sections, the wider road morphs into the narrower one over a taper: lanes with no
   counterpart converge onto their inner neighbour and get `endsAt`/`mergeTarget`, and every other
   lane slides to its new offset. Lanes align from the median outward, so a road that loses a lane
   loses its kerb-side one — which is what real lane drops do.
10. **Turn bays, chosen per approach.** A left turn made from a through lane stops the whole lane
   behind it, so any junction worth the name gets a bay. Of its own accord the compiler builds a left
   bay where the junction is a crossing with three or more arms, the turning group has at least two
   lanes, there is somewhere to turn left to, and the segment is long enough.

   **All of that is a default, not a verdict.** Every approach carries a `TurnLaneChoice` on the
   position-keyed junction override — `auto`, `none`, `left`, `right` or `both` — named
   `strokeId:side` like every other user choice, because segments and lanes are rebuilt on each
   recompile. Forcing overrides the *policy* tests (lane count, worth-it) and never the physical
   ones: a bay pointing where nothing can be turned into is paint no connector will ever leave from,
   so it is refused whatever the document asks for. A **kerb-side bay** is only ever built on
   request — it opens against the kerb rather than the median, takes nothing from the median and
   moves no through lane, which is why it works on a one-way street and on an undivided road where a
   left bay has nothing to use. The kerb edge it opens from is where the through lanes have been
   pushed *to*, not where they started: read the unshifted edge and an approach with both bays stacks
   the kerb-side one straight on top of its own outermost through lane. Over a taper the group's through lanes slide **outward** by one
   lane and the bay opens against the group's median edge.

   **A bay widens one kerb, and it is its own.** Only the turning group moves: its through lanes
   slide out toward its kerb and the bay opens in the median behind them. The asphalt used to grow
   by the same amount on *both* sides, on the argument that the departing side is a receiving flare —
   which laid a bay's widening down the side of the road where nothing had moved, for the whole
   length of the bay: a two-metre ledge 85 m long at every approach that has one, and most of what
   "the roads are set back oddly and there is extra road everywhere" turns out to be made of. It also
   made every arm crossing the road ask to be trimmed for a flare that was not there. The two
   approaches of a through road flare opposite kerbs, so the kerb line steps as it passes the
   junction, which is what a real one does; the corner radius takes the step.

   **A median is there to be used.** The bay takes all of it but a 0.45 m sliver and widens the road
   by only the remainder, which is what a real arterial does — the sliver is what carries the double
   yellow between the bay and opposing traffic, so the two directions still read as separated. Two
   junctions close together give the same block a bay at *each* end, reaching into the same median
   from opposite directions; let both take all of it and their median edge lines swap sides and paint
   a yellow X down the middle of the road. Overlapping bays get half the median each instead. The bay is a
   part-length lane like an acceleration lane, `startsAt` set past the taper, and because it sorts
   innermost it lands at the top of the approach's lane order, where the movement allocation below
   hands it the left turn and nothing else. Nobody has to be told to use it: it is the only lane the
   left-turn connector leaves from, so the routing field does the rest.
11. Build connectors for every legal in-lane → out-lane movement, **unless the junction was wired by
   hand**, in which case the override replaces the whole allocation. A T can also be made
   **right-in / right-out** (`JunctionOverride.rightInRightOut`): every approach then keeps only its
   straight-on and its kerb-side turn, so the stem may only turn onto the near carriageway and only
   the near carriageway may turn into the stem. Nothing crosses the median, no left-turn bay is
   built, the junction runs on priority whatever control the document asks for — a signal would stop
   the very traffic the arrangement exists to leave alone — and the far carriageway ends up with
   through movements that have **no conflict points at all**. It needs a T (three arms, one with
   nothing opposite it) and a carriageway the stem can turn onto; anything else gets the ordinary
   allocation and a `right-in-right-out-shape` diagnostic. Left-in / left-out where traffic drives
   on the left: the option is named for the common case and implemented as the kerb-side turn. Gores take an override too, and it covers **every lane of the road**, not just
   the auxiliary ones: which lane of a multi-lane ramp joins which is a real choice, and so is
   whether a through lane exits, carries on, or does both. That last pair is what an option lane and
   an exit-only lane *are*, made per lane instead of per gore. A through lane runs straight past a
   gore — the mainline is deliberately not split at one — so it has no end to branch from until the
   road is split there, and that split is made exactly where the document wires one. The wiring then
   owns that carriageway completely: through movements are named in it alongside the ramp's, written
   road-to-road, and since the two halves of a split share a name they are told apart by which side
   of the override they appear on. Leave one out and that lane is exit-only; leave a lane out of
   everything and `lane-link-dead-end` says so rather than the compiler quietly filling it back in.
   The editor seeds the set from the compiler's own answer, through movements included — without them
   the first movement anybody added would take the through movements with it, and one shift-click
   would end the motorway. A merge runs ramp to road and a diverge road to
   ramp, so a pair named the other way round is refused rather than built into a connector nobody
   can drive. Half a set would be worse than
   either, because the layout below assumes it owns every lane. Overrides name lanes
   `strokeId:side:index` rather than by id — lane ids are derived data and change on every
   recompile — and a pair may repeat a lane on either side, which is how one lane branches to
   several and several converge on one. A hand-wired junction also loses the "nothing dead-ends
   inside a junction" backstop, since filling the gaps back in would quietly undo the edit; a lane
   with no way out becomes a warning instead. Movement blocks **overlap** the way
   real lane markings do: right turns hug the kerb lane, left turns the median lane, through traffic
   gets everything in between *plus* whatever it can share. Compute conflict points
   (connector–connector crossings, and shared destinations), then assign `priorityRank` by sorting
   with a unique final tie-break — a strict total order, so priority cycles are structurally
   impossible.
12. Choose junction control. Priority only works when there is a clear pecking order — the strict
    total order means the lowest-ranked approach yields to everyone, which starves it if the roads
    are actually comparable. So: a minor road joining a major one keeps **priority**; comparable
    roads at arterial scale get **signals**; comparable roads too small for signals get an
    **all-way stop**, which is what those junctions have in the real world. The user's choice
    overrides all of it and is persisted by position.

    **And priority needs gaps somebody can judge.** Above `PRIORITY_MAX_SPEED` (90 km/h) there are
    none: the major stream never pauses, so the minor arm is not slow to be served but never
    served. That shows up first as vehicles stopped at the line for minutes and then as collisions,
    because a driver who has waited that long is being asked to read a gap in traffic doing thirty
    metres a second. Such a crossing is signalised whatever the pecking order looks like — it
    outranks the all-way stop too, since a stop line across a motorway is not a control anybody
    obeys. Real networks signalise or grade-separate these, and the compiler cannot build a bridge.
13. Emit the road surface polygon, the marking polylines and the **road symbols** per segment, tapers
    included, so the renderer never re-derives road geometry. Symbols are paint that is a picture
    rather than a line: a lane-use arrow showing the movements each approach lane can actually make,
    and the word STOP where the control is an all-way stop. They are derived from the compiled
    connectors and are emitted *after* the junction-control override is applied, so rewiring a
    junction by hand repaints its arrows and switching it off a stop erases the word.
14. Build **zones** from land use, and apply the gateway roles to portals. Both are
    keyed the way every other user choice is — land use by profile, gateway role by
    position — because zone and portal ids are derived data.
15. Validate: every lane reachable, no orphan connectors, no NaNs, no duplicate priority ranks;
    surface problems as editor diagnostics, never silent.

## Traffic simulation

Per-tick order (stable, deterministic): signals → spawn → route/lateral indices → merge planning →
lane-change decisions → longitudinal accelerations → integrate → lane advance → despawn → metrics.
`sim.timings` carries a per-pass breakdown in milliseconds; eight clock reads a tick is nothing next
to the work being measured, and having the breakdown to hand is what makes a performance regression
obvious instead of mysterious.

**Car-following: IDM.** `a = a_max · [1 − (v/v0)^4 − (sStar/gap)²]` with
`sStar = s0 + vT + vΔv / (2√(a_max·b))`. Defaults: `s0 = 2 m`, `T = 1.4 s`, `a_max = 1.4 m/s²`,
`b = 2.0 m/s²`, hard cap 6 m/s² (emergency only). Per-driver variation: seeded ±10% on `T`, `v0`,
acceleration and politeness. Leader lookahead crosses lane boundaries — without it every queue that
starts just past a junction is invisible until it is too late.

**A driver holds the limit and brakes late.** Slowing for a lower limit on the lane ahead — which is
every turn, and on a curved crossing every movement — engages only once the remaining distance is
inside about 1.5x the distance a comfortable deceleration actually needs. Spreading the same speed
loss over the *whole* remaining lane is arithmetically equivalent and behaviourally nothing like a
driver: on a 700 m approach it works out at a quarter of a metre per second squared sustained the
entire way, so half the traffic on a 22 m/s arterial cruised at 10 m/s from four hundred metres out
and the rest wove around them. "The cars change lanes constantly and never get up to speed" was one
defect, not two — the lane changes were the symptom.

That rule was also **metering every junction**, and removing it exposed what the metering had been
hiding: see the box-blocking rule below, which had to be fixed at the same time.

**Two clocks, not one.** `store.stoppedTime` counts time below 0.3 m/s and means what it says.
`store.crawlTime` counts time below `MERGE.crawlSpeed` **with a clear road ahead** — a driver held by
the merge model rather than by the queue in front. Every anti-deadlock timeout in the merge code
reads the second; reading the first is why none of them could fire (see the tarpits).

**Discretionary lane changes: MOBIL.** `Δa_self + p·(Δa_newFollower + Δa_oldFollower) > a_thr`,
subject to safety. Defaults: politeness `p = 0.3`, `a_thr = 0.15 m/s²`, `b_safe = 4 m/s²`, cooldown
3 s. Two additions that matter:

- **Downstream speed.** The incentive includes the mean speed of each lane over the next ~260 m, not
  just the car directly in front. Without it nobody moves out of a lane until they are already in its
  queue, and traffic piles into one lane while the next runs empty.
- **Evaluated every 0.4 s, not every tick.** Drivers do not reconsider twenty times a second, and
  pretending they do cost roughly half the tick budget for no behavioural gain. Mandatory changes are
  still checked every tick, because those are the time-critical ones.
- **Drifting off the route is not free.** `advise` answers "which way from here", and its answer for
  a lane already on the route is "you need not move" — so a discretionary change *out* of that lane
  used to pay no route penalty at all, and the mandatory rules pulled the driver straight back on the
  very next tick. A discretionary change now reads the *target* lane's own lateral plan: inside the
  range where that plan would be urgent it is refused outright, because going there is choosing to be
  thrown back, and outside it, it costs something proportionate to how soon it would have to be
  undone. Overtaking with a kilometre in hand is still nearly free.
- **A deadline a kilometre away is a plan, not an emergency.** The mandatory path ignores the
  cooldown and takes the first safe gap, which it has to for a lane that runs out of tarmac. Applied
  to a driver merely in the wrong lane for a junction 1.4 km ahead it throws them back the tick after
  they drifted out, and the moment the cooldown expires they drift out again. Below the point where
  urgency starts to bite, the change goes through the ordinary discretionary path instead.

Together those two were worth more than any other change to lane behaviour: on the town grid, **91%
of all lane changes were reversals and 47% undid themselves inside one second** — 415,000 lane
changes in half an hour, now 20,000 and 0.3%. Both are invisible in the merge scenarios, which are
one segment of freeway with one ramp; the pathology needs a junction to appear, which is why the
example maps found it and nothing else had.

**Demand is a quota spent at the current rate, not an interval counted down.** The spawner draws
from Exp(1) and subtracts `rate * dt` each tick, firing when it runs out. Drawing an *interval* from
the rate that applied when the last vehicle left is the obvious thing and is wrong the moment the
rate moves: an interval drawn at three in the morning is minutes long, so it swallows the whole dawn
ramp before it next looks, and one drawn at the evening peak keeps firing long after the peak has
gone. Over a simulated day that lost **58% of all demand** and put the busiest hour at 20:00, at half
the peak flow — a clock whose waves arrive whenever the traffic happens to allow is not a clock.

**A driver is placed at a speed the road ahead allows.** A driver who has been travelling arrives
at a queue, or at slower road, with the whole approach behind them to slow down in; one *created* at
the edge of the network does not, and no car-following model can undo a vehicle put somewhere it
could never have reached at that speed — it is at the emergency cap from its first tick and stays
there until it hits something. On an imported freeway interchange that was almost every rear-end
collision. Three things bound the entry speed, all with *this driver's* comfortable braking rather
than the global one, because a truck stops at 1.5 m/s² where a car manages 2.0:

- **What is queued past the end of the lane.** A road end in a city is metres from the junction it
  feeds, so the queue a new arrival joins is usually on the *next* lane.
- **How fast the road ahead is.** A five-metre entry lane onto a five-arm junction offers a 60 km/h
  movement beside a 13 km/h one, so the walk is breadth-first over **every** way out — which one
  this driver takes is not decided until the routing pass, and following the first successor spawns
  them at the limit in front of the turn they are about to make.
- **The gap being joined.** Matching the leader's speed is not enough: IDM asks for a *headway*, and
  ten metres behind traffic doing 18 m/s is four seconds short of it however well the speeds agree.

Requiring the *room* instead — a speed-aware minimum gap before the trip is placed at all — was
tried and reverted. Turning a busy lane away changes when every later vehicle arrives, and the
scenarios felt it as bunching: a 92 s wait at a four-way, a lost turn-on-red throughput win, and a
collision through a peak. Demand that cannot be delivered on time is a real cost; a driver joining
slowly and accelerating out of it is not. `npx tsx scratch/spawncheck.ts` prints, per document, how
many vehicles are at the emergency cap on their first tick and which rule put them there.

**Routing is a potential field, not a search.** For each destination portal we run one backward
Dijkstra over the lane graph — lane changes are edges too — and keep `cost[laneId]`. Vehicles carry
no materialised route: each tick they read the gradient, which answers "which connector", "which way
to change lanes" and "can I get there from this lane at all" in one lookup, and recovers
automatically when a driver ends up somewhere unplanned. A driver whose destination falls out of
reach is re-targeted to the nearest reachable exit *other than the one they just failed to make*,
rather than stopping dead or vanishing — see **Highway merges** for why that exclusion is what makes
missing an exit possible at all. That search runs **forwards, from the driver** (`nearestExit`), and
stops at the first exit it settles. Asking it backwards — "which of the network's exits is cheapest
from here" — is the same question and costs one whole-graph search *per portal*: on a four-mile
import, 2,549 searches and most of a gigabyte of cost tables, all set off by the first driver to
miss an exit.

**A red you cannot stop for is one you were never offered.** Where two junctions sit a few metres
apart — which imported data is full of, and which the compiler itself produces when it pulls two
overlapping footprints apart — the road between them is shorter than a stopping distance. The signal
rules first look at the second junction when the driver is already a metre from it doing thirteen
metres a second: `mustStop` says yes, they brake at the cap, and they cross on red anyway into the
traffic that has the green. So the entry decision at a junction also asks what is immediately beyond
it: if the road out is too short for this driver to stop in and the movement past it requires a stop,
they wait *here*, at the last stop line anybody offered them. It only bites where the road really is
that short — a normal exit lane gives a driver at 14 m/s the fifty metres they need — and across the
imported cities it was worth more than any other single change to the junction model.

**Junctions.** Decisions are made on the *approach*, and how far out that starts is derived from the
driver's own stopping distance rather than being a fixed number — what the range has to cover is the
distance this driver needs to stop, and that goes as the square of their speed. Ninety metres is a
comfortable stop at 19 m/s and nothing like one at 30, so on a fast road a driver first considered
the red light some way after the last moment they could have acted on it.

The order is: signals, then **"don't block the box"** — the test is whether the way out is *jammed*
rather than merely occupied, because a vehicle still moving through the first few metres of the exit
lane will be gone by the time we get there and refusing to follow it would serialise every junction
to one vehicle at a time. But the way out **starts with the connector itself**: something stopped on
the connector we are about to enter is as final an obstruction as a full exit lane, and following it
in parks a second body inside the box. Checking only the exit lane let drivers keep entering a
junction that already held seven stopped vehicles with every exit lane empty in front of them, and
by then the ring was permanent. Then conflict points resolved by
`priorityRank` and gap acceptance with a seeded critical gap. Once a vehicle has entered a connector
it is committed and will not stop for priority any more — only for a vehicle physically occupying its
path, **or for one that cannot physically stop short of the point they share**. That last clause is
not a yield, it is a kinematic floor, and the difference is what keeps it from freezing the junction:
a vehicle that has *reached* the conflict point returns long before that code runs, so nobody is ever
asked to stop on top of one. Without it a left-turner crawling across at 3 m/s with six metres to go
ignored a through movement fifty metres out doing 26 m/s — which needs fifty-five to stop — because
it had not entered the junction yet. Conflict points already driven past are skipped, which is the
difference between a working junction and six cars frozen mid-crossing.

Four rules decide whether a rival counts as *coming*, and each exists because of a way a junction
fails without it:

- **A rival held at a red is not coming.** This is what makes a protected turn protected: during its
  phase the movements crossing it are red, so the turner has the junction rather than hunting for a
  gap in traffic that is about to stop anyway. A rival already on a connector is exempt — it is
  committed, whatever its aspect says.
- **A rival already in the junction outranks everybody.** Priority means nothing against a vehicle
  that cannot give way any more, so a committed rival goes to the gap test rather than being skipped
  on rank.
- **Do not enter a junction you might not get out of.** A committed rival that is barely moving and
  has not cleared the point you share holds you at the stop line. Without it a saturated crossing
  deadlocks permanently: the opposing queue stalls, a turner reads the stall as an invitation and
  enters the box, the two block each other, the next driver reads *their* stall the same way, and
  within two cycles thirty vehicles are frozen mid-junction with every exit lane empty in front of
  them. By then the bodies overlap the conflict points, so no relaxation can unwind it — the only
  cure is not to start. `test/scenarios/signals.test.ts` drives every intersection shape at 1.3x
  capacity and asserts the junction is still discharging at the end.
- **A rival arrives at the speed it could be doing, and leaves at the speed it is doing.** Gap
  acceptance used to extrapolate a rival at its current speed, which is the one prediction guaranteed
  to be wrong in stop-and-go traffic: a vehicle crawling into a junction at 1 m/s is accelerating, so
  predicting from the crawl says it is fifteen seconds away, you take the gap, and it arrives in
  four. Arrival is now a kinematic estimate — accelerate at `JUNCTION.arrivalAccel` toward the road's
  own limit — while clearing is still predicted from the speed the rival actually has. Arrives early,
  leaves late.

**The safety floor is predictive, and it applies inside the junction too.** Reacting to a rival that
is *currently* over the shared point is too late: by the time it is there, so are you. Two vehicles
both committed on crossing paths run the same overlap test the entry decision uses, and the lower-
ranked one brakes — the strict total order means exactly one does, so a mutual standstill is
impossible. Without it they slide through each other, and it shows up worst with a bus, which needs
three times as long to clear the point it is standing on.

**Signals** are phase tables gating movement groups; amber uses the comfortable-stop rule. See the
next section — the plan is a first-class, editable, persisted thing rather than something the
compiler decides on your behalf.

**Actuation is opt-in per junction.** With it on, a green ends as soon as nobody is using it: a
minimum green first, then gap out. The demand test is *routed* rather than a presence sensor — a car
queued in the through lane says nothing about whether the left-turn phase still has anybody to serve,
and counting it makes every phase run to its maximum, which is a fixed plan wearing a detector. On a
busy road crossed by a quiet one it is worth a third of the delay: mean wait 52 s → 34 s, journeys
9% shorter, more traffic through.

It is off by default and that is not laziness. A fixed plan has a fixed cycle, and a fixed cycle is
the entire basis of a corridor offset: a green wave is a claim about where a platoon will be N
seconds from now, and it stops being true the moment the cycle length depends on who turned up.
Actuate an isolated junction; leave a coordinated one alone. The panel says so where it matters.

**Turning on red.** The kerb-side turn — right where traffic drives on the right, left where it
drives on the left — may be taken against a red, from a standstill, giving way to everything. It is
**on by default and stored only when switched off**, which is how the rule works where it exists:
permitted everywhere, forbidden by a sign at the junctions that need one. Amber is deliberately
excluded — a green is a second away and creeping out on it takes a gap from traffic that still has
the junction. It is the only movement a signalised junction does not meter, which is why it is worth
having: across the intersection zoo it buys throughput at every shape and up to a quarter of it at a
five-way, and it never costs any.

**All-way stops** work the way the real ones do: every approach must actually come to rest at the
line, and conflicts are then resolved by who got there first rather than by the fixed priority rank,
with the vehicle serial as a stable tie-break. This is the only control that shares a small four-way
fairly.

## Traffic signals

A junction's phase plan is part of the document, not something the compiler decides for you. It is
stored on the same position-keyed `JunctionOverride` as the control choice, so a junction switched
off signals and back on still has the plan it was given.

**A phase greens movement *groups*, not lanes.** A group is every connector leaving one approach and
making one kind of turn, named `strokeId:side:turn` with turn in `L S R U`. Connector and lane ids
are derived data and change on every recompile; a group name does not, and it is also the unit a
traffic engineer thinks in — "the left turn off the northbound arm" is one thing however many lanes
feed it, and it stays that thing when a lane is added. A name that stops matching anything simply
contributes no connectors, which shortens the phase instead of collapsing the plan, and validation
says so.

**Protected is computed, never declared.** A movement is *protected* in a phase when nothing else
green at the same time crosses it, and *permissive* when something does and the driver has to find a
gap. `protectionOf` reads that off the compiled conflict points, so the label cannot disagree with
what the traffic does. There is deliberately no "protected" checkbox: the Protected lefts preset is
simply the plan that arranges for it.

Three presets, all generated from the junction's own geometry, all working on any number of arms:

- **Permissive lefts** — one phase per opposing-axis pair, left turns included. Two arms more than
  150° apart share an axis; an arm with nothing opposite it (a T's stem, a five-way's fifth leg) is
  an axis of its own.
- **Protected lefts** — the lefts lead on their own, then the through movements. An arm earns that
  only if it has a **left-turn bay** *and* something to be protected from. Without a bay the left
  shares its lane with the through traffic, and a left-only phase is then stopped by the first driver
  who wanted to go straight while the through phase is stopped by the first who wanted to turn —
  that arrangement cut throughput by half on a single-lane crossing, which is why the rule exists.
  With nothing green that would cross it — a T's stem, a one-way arm — a left phase buys nothing and
  only lengthens the cycle. Arms that fail either test keep their lefts with the through phase, which
  is a protected-permissive plan and exactly what those junctions should get.
- **One arm at a time** — split phasing. The slowest plan and the only one that is safe on any
  geometry whatever, which is what an awkward junction should fall back to.

**Intergreen is sized from the junction, not fixed.** All-red is `(longest connector + 5 m) / 9 m/s`,
clamped to 1.5–5 s. A wide or skew crossing has connectors two or three times the length of a small
one, and a clearance that suits the small one leaves the big one with traffic still inside the box
when the next phase starts. Generated cycles are also capped at 120 s, scaling greens together if a
junction with many arms would otherwise run past two minutes.

A junction also carries `turnOnRed` (see **Turning on red** above), which the panel exposes as a
checkbox next to the plan.

**Validation** raises two things as diagnostics, and the panel repeats them next to the phase that
caused them: a movement that never gets a green anywhere in the cycle, and a phase that greens two
*through* streams which genuinely cross. "Genuinely" is doing work there — connectors are sampled
polylines, so on a curved crossing the two directions of one road brush against each other at 155°
and two lanes of the same stream cross at 16°. The check requires different arms and a crossing angle
between 30° and 150°, or it fires on the compiler's own default plan.

### The signal panel

`app/signalPanel.ts`, shown while the Junctions tool is in hand — it shares its corner with the road
list and the road builder, and exactly one of the three is ever up.

The panel belongs to the junction rather than to its signals: a crossing gets its control buttons
and a **turn-bay row per approach** whatever control it is on, and a gore gets its own single choice
instead. Only a signalised crossing goes on to show a phase plan.

**Every phase is a picture of the junction, and you edit it by clicking the movements.** The picture
is `render/signalDiagram.ts` drawing the compiled connector centrelines themselves — the same splines
the traffic follows — so it needs no special cases (a five-way, a skew crossing and a T all draw
themselves) and it cannot offer a movement that does not exist. Green movements are drawn in green,
dashed when they are permissive; everything else is dark. Click one to give it a green or take it
away; hovering names it.

Everything else is a stepper rather than a number to type — signal timing is adjusted by feel against
the queue you can see on the map, and a stepper keeps the map under the cursor. The phase that is
running right now is outlined and counts down, and at the selected junction the **map** paints every
movement in the aspect it is currently showing, so the panel and the road agree.

Clicking a junction with the Junctions tool *selects* it — that is how you open it here. **C** cycles
the selected junction between priority, all-way stop and signals, which is the quick way round; the
panel's three buttons are the precise one.

## Highway merges — flagship spec

Why merges fail in other sims: point-merge geometry (no acceleration lane), no anticipation (cars hit
the lane end then panic-brake), gap-*waiting* instead of gap-*seeking*, and zero cooperation from
mainline traffic. We fix all four.

1. **Real geometry.** Every merge has an acceleration lane + taper from the compiler (step 7).
2. **Anticipation via a soft wall.** A lane with `endsAt` presents a virtual standing obstacle at its
   end, engaged only within ~1.5x stopping distance — and **ignored entirely while the driver has a
   gap lined up and room to stop**, because a driver with somewhere to go accelerates into it rather
   than braking for a line on the road. Outside the creep zone the wall may only ask for comfortable
   braking: a merger that slams to a halt and then forces its way in is exactly the behaviour this
   model exists to avoid.
3. **Gap seeking with speed synchronisation.** A merger scores candidate gaps on the target lane by
   alignment distance and by the resulting IDM accelerations for itself and the gap's follower — the
   follower term weighted heavily, because taking a gap someone has to brake for is the worst thing a
   merger can do and easing off to take the next one is nearly free. It then regulates speed against
   the chosen gap's leader projected into its own coordinates, re-evaluating every 0.5 s. With road
   left it will **keep accelerating rather than slot in more than ~3 m/s below the lane it is
   joining**; urgency relaxes that, so it can never be a reason to get stuck.
4. **Cooperation.** The chosen gap's follower adopts the merger as a virtual leader and opens up
   (courtesy roll per driver, ~70% base; mandatory above urgency 0.85). Crucially the commitment is
   **sticky** — re-deciding it every tick means the gap never actually opens, because a different
   driver inherits the job each time the queue shuffles forward. Mainline traffic also gets a MOBIL
   bias to vacate the kerb lane near an active on-ramp, but only while still moving freely: shuffling
   lanes inside a queue helps nobody and costs discharge rate.
5. **Urgency escalation — the no-deadlock guarantee.** `urgency = clamp01(1 − sRemaining / 250 m)`,
   scaled by how many lane changes the route still needs. As urgency rises the accepted gap shrinks
   from the full IDM value toward `s0`, politeness goes to zero, and courtesy becomes mandatory. At
   the taper end, creep-in at ≤ 2 m/s is permitted; in stop-and-go traffic that relaxation applies
   **anywhere along the lane**, because that is what drivers do and without it every merger queues to
   the taper and the whole auxiliary lane goes to waste.
6. **A driver who has run out of both road and speed is looking the wrong way.** Two rules keep a
   merger from wanting a gap they cannot get to — do not drop back once dropping back has stopped
   working, and do not want a gap further off than the runway left — and both are written for a
   driver who is still moving. For one stopped on the last metre of an acceleration lane they are
   exactly inverted: that driver cannot drive to a gap at all, so the only reachable one is the one
   still coming, and the gap alongside is the worst choice available. Together they left the
   alongside gap as the only candidate, and it slides past at the speed of the mainline — so the
   choice advanced by one vehicle every couple of seconds indefinitely, handing the cooperation job
   to whichever driver happened to be level at that moment, and nobody ever held it long enough to
   open anything. The chosen gap also carries a little **hysteresis**, for the same reason the
   mainline's commitment is sticky: whoever is choosing has to hold the choice long enough for it to
   mean something.
7. **Congestion zipper.** When traffic within 150 m upstream of a taper drops below ~35% of the free
   speed, a taper arbiter enforces alternating admission. The gate may make a driver wait its turn
   but may never be the reason someone is stuck: high urgency or a long wait lifts it.

Off-ramps reuse the same machinery in reverse: exiting vehicles get a mandatory-change deadline keyed
to the gore, propagated back through however many lane changes the route needs. Through traffic will
not drift into a deceleration lane it would then have to fight its way back out of.

**But an exit is not a lane end, and the difference is load-bearing.** A driver on an acceleration
lane has nowhere else to be, so the model may compel the traffic beside them to make room and, at the
very end, may accept a gap the follower can only *physically* survive. A driver trying to reach an
exit has an alternative — carry on and come back — so both of those are reserved for a lane that runs
out of tarmac. Reaching an exit is a favour being asked, and a favour can be refused.

That is what makes **missing an exit** possible at all, and it is emergent rather than modelled: the
deadline passes, the driver is `MERGE.missedBy` metres beyond it, and `retarget` hands them the
nearest destination they can still reach. It costs a detour and nothing else — never a stop in a live
lane, never a vehicle written off. Rates are a few tenths of a percent in free flow and rise with
congestion; the HUD shows a *Missed exits* row once it has happened.

Two things had to be right for the reroute to fire at all, and neither was:

- **Route costs are per lane, and a diverge does not split the road it leaves.** The mainline is one
  continuous lane through the gore, so `cost[lane]` says the ramp is reachable whether you are a
  kilometre short of it or a kilometre past it. Retargeting therefore has to *exclude the destination
  just missed* — asking for the cheapest exit hands back the one behind you, and nobody ever
  reroutes. It is only ever called because the current destination has stopped being achievable, so
  ruling it out is exactly right.
- **`mergeRemaining` is clamped at zero**, so it cannot tell a driver sitting on the line — about to
  change, this very tick — from one fifty metres past it. `store.mergePast` carries the overshoot,
  and the reroute waits for a few metres of it; merge planning runs before lane changes within a
  tick, so retargeting at zero writes off drivers who were about to make it.

### The collision floor

`b_safe` is never relaxed, but *what it measures* matters. The floor is **kinematic**: at the current
closing speed, can the follower stop in the gap available — allowing for `MERGE.insertReaction`
seconds of still closing before its braking bites, because nobody brakes in zero time and least of
all a driver who is still accelerating? It is deliberately not IDM's acceleration,
because IDM reports a huge deceleration for a stopped car sitting a metre behind another stopped car
— a comfort complaint, not a hazard — and treating that as unsafe makes zipper merging impossible in
a jam. On top of the floor sits a *comfort* criterion (no lane change may make the driver behind
brake harder than 3 m/s²), which is what keeps a merge from showing up as a shockwave in the
mainline.

One documented exception: a driver stationary at a lane end for longer than 12 s drops from "the
follower can cope comfortably" to "the follower can physically stop", using emergency braking. That
is the line this model draws — nobody is ever permanently stuck, and nobody is ever asked to do the
impossible.

### Merge acceptance criteria (regression-tested, never waived)

`test/scenarios/merge.test.ts`, ten seeds x ten simulated minutes each. Where an absolute number
would be arbitrary, the assertion is made against a **control run** — the same road carrying the same
demand with no ramp at all — which measures exactly what the merge cost.

Invariants, every scenario, no exceptions: **zero collisions; zero vehicles that reach a lane end
without merging; zero mergers stuck with room beside them; zero vehicles lost at a dead end.**

- `onramp-light` (3-lane mainline at ~30% capacity): at least 85% of ramp vehicles merge in the first
  60% of the auxiliary lane (72% on the worst seed); median speed difference against nearby traffic
  under 4.5 m/s, p90 under 8 m/s; hard braking near the merge within 8 events of the no-ramp control
  across all ten runs; throughput at least 95% of control; mean speed above 24 m/s and nobody stopped
  for more than 20 s.
- `onramp-heavy` (2 lanes plus a busy ramp, at capacity): no gridlock, downstream throughput at least
  90% of the no-ramp control (currently ~92%).
- `onramp-zipper` (both streams queued): the taper must actually congest, and admission alternates —
  auxiliary share between 0.4 and 0.6 (currently ~0.44), measured only while congested, because in
  free flow the ratio just reflects demand.
- `lanedrop-3to2`: throughput at least 90% of the no-drop control (currently ~97%); at least 75%
  merge before the taper ends.
- `offramp`: fewer than 0.2% of drivers miss the exit in free flow, zero vehicles stopping on the
  mainline to exit, throughput at least 93% of demand. This asked for *zero* missed exits until the
  mainline stopped being compelled to let exiting traffic in; the number it got was a consequence of
  that compulsion, not of the drivers doing well.
- `weaving` (on-ramp then off-ramp sharing one auxiliary lane): throughput at least 90% of demand,
  under 0.5% missing the exit and no more than two seeds in ten where anybody does.
- `missed-exit` (a three-lane freeway whose exit comes up 700 m after the entry, carrying more than
  the off-ramp scenario): drivers *do* miss it, and every one of them reroutes and arrives — zero
  lost, zero collisions, zero that run off a lane end. A model where nobody ever misses an exit is
  one that is forcing them across.

Two of the original targets were adjusted after measurement, and it is worth saying why. "95% merge
in the first 60% of the accel lane" and "speed difference under 3 m/s" are in direct tension: an
on-ramp is designed for a lower speed than the freeway, so merging *earlier* necessarily means
merging at a larger speed difference. Turning the speed-match gate off pushes 96% of merges into the
first 10% of the lane at a p90 difference of 18 m/s; turning it up pushes the difference down and
merges later. The model is tuned to the physically honest middle — accelerate on the ramp, then slot
in — and the thresholds above are what that produces with margin. **The invariants were not
relaxed.**

## Rendering

Vector layers, drawn in order: satellite tiles → terrain fills → water → contour lines → image
underlay → per-grade road stacks from lowest to highest (each stack: casing → asphalt → lane markings
→ verge planting → junction cover polygons, which hide marking overlaps → stop bars → arrows and word
markings → signals) → vehicles (per grade) → editor overlays.

- Geometry is baked into `Path2D` once per recompile and bucketed into 800 m tiles, so a large
  network only pays for what is on screen. Everything draws in world units with the camera transform
  applied, so line weights scale with zoom, with a pixel floor so nothing vanishes.
- Tunnels (grade < 0): dashed casing, fill and vehicles at ~40% alpha. Bridges (grade > 0): a
  **parapet** — lighter than the casing and wider — plus a two-layer drop shadow.
  - **Occlusion says which road is on top and nothing about why.** Without a shadow a stacked
    interchange is flat: every deck the same colour, the only cue being which one covers which.
    The shadow is what carries the order, so it has to be big enough to read — a third of the
    current offset was a metre and a half on an eighteen-metre carriageway, and on a road running
    the same way as the light it was hidden under the road itself. The parapet is the second cue,
    and a different one: that the road on top is *carried on something*. It runs along the deck
    edges and stops at the abutments, because `Tile.casing` already leaves out any cap the road
    drives through — which is exactly where a real parapet ends.
  - **Two layers, the outer fainter.** One hard-edged copy of the deck offset sideways reads as a
    second road lying alongside it; a pair reads as a falloff, which reads as air.
  - **The offset is compressed above the first level.** A real shadow scales with height and a
    four-level interchange cannot afford it: linearly, a level-three deck throws its shadow twenty
    metres clear of the road casting it, where it stops being a shadow and becomes another dark
    road. What has to survive is the *order*, not the arithmetic.
- **A road that changes level is one road, and the joint is not an edge.** Grade lives on control
  points, so a bridge's ends are ramps and a segment boundary lands where the road passes each
  half-level; both sides are at the *same* height there. Two things have to respect that or the
  bridge reads as a slab dropped next to the road it continues into.
  - The shadow is grown from `Segment.surfaceHeight` — the real fractional height at every vertex of
    the surface ring, not the integer layer the segment draws on — with each vertex pushed by its own
    height. So it opens up as the road climbs and closes again as it comes down, and it matches
    across the joint. Translating the whole shape by the segment's layer instead runs the offset copy
    straight past the end cap and lays a solid block of shadow across the road at every abutment.
    Ground-level segments therefore draw the shadow pass too: that is where a ramp's half of it is.
  - The casing is stroked along `Tile.casing`, the surface outline **minus any end cap the road
    drives straight through** (the portal test — a lane with somewhere to go — not "is there a
    junction id here"). `Segment.surfaceSplit` says where the ring turns the corner from the right
    edge to the left, which is what makes dropping a cap possible at all. Within one grade stack a
    cap casing never showed, because every casing in a stack is stroked before any of its asphalt is
    filled; across two stacks the upper road's lands on the finished lower one as a black bar right
    across the carriageway. The stroke uses a butt cap while it is at it — the default round one
    leaves a half-disc of casing sitting on the road at each corner of the open joint.
- Markings come from the compiler as polylines with a style, so the renderer never re-derives road
  geometry — including tapers, which are variable-offset curves. `median` is its own style: the left
  edge of a carriageway on a divided road is yellow, the same way the centre line of an undivided one
  is, because it is the boundary you never cross. Drawing it white leaves a divided arterial with no
  visual difference between its two directions.
- The edge line marks the edge of the **carriageway**; the shoulder is asphalt outside it. Painting
  it on the asphalt boundary instead makes the kerbside lane read a shoulder-width wider than every
  lane inside it — 6.15 m against 3.65 m on a freeway with a 2.5 m shoulder, which looks exactly like
  a compiler bug in the lane layout even though the lane offsets are perfectly even.
- **Paint does not follow the surface through a gore.** An auxiliary lane that starts without a
  taper — which is every on-ramp, because the gore *is* where the two carriageways become one —
  steps the asphalt by a whole lane at one arc-length. The surface is allowed to: the gore footprint
  covers the wedge either side, so it reads as continuous. The edge line is not, or it is drawn
  diagonally across the gore the ramp is arriving on. Upstream of the gore there is no acceleration
  lane yet, so the edge line runs straight to the gore point and stops — the marking is emitted in
  **pieces**, split wherever an auxiliary lane begins or ends without a taper. One polyline through
  the step would be a bar straight across the carriageway.
- **A gore's paint marks the exit-only corridor**, so it is drawn around the movements that leave an
  *auxiliary* lane. An option lane is a through lane that happens to be able to exit, and a solid
  line down its inner edge would say the opposite of what an option lane means; its boundaries are
  painted by the segment like any other lane's. Where another movement runs inboard of the corridor —
  an option lane joining the same ramp — the inner line divides two lanes rather than marking the
  edge of the carriageway, and is dashed.
- **A right-in / right-out carries the through road's paint across the box.** The segments are
  still trimmed back to the junction like any crossing's, so their markings stop at the caps — and a
  box with no lines across it reads as a crossing where every turn is possible, which is exactly
  what this is not. Every boundary of every through lane is continued along the lane's own through
  connector: the dashed line between lanes, the median line on the inner edge, the edge line on the
  outer one — except on the near carriageway, whose kerb opens for the stem. The connector is the
  lane's continuation, so offsetting it by half a lane lands exactly on the line it meets at each
  cap; the audit checks that hand-over like a gore's, yellow against yellow.
- **Stop bars at a priority junction go on the approaches that give way** — those whose every
  movement yields to something — and nowhere else. Painting them across every incoming lane said
  the major road stops here, which is the one thing a priority junction promises it does not.
- **A gore carries its own paint** (`Junction.markings`, plus a right-in / right-out's). A
  ramp's edge lines stop where its segment stops, a connector's length short of the carriageway it is
  joining, so the compiler continues them across: from the ramp's carriageway edges at one end to the
  auxiliary lane's at the other, where the road's edge line and the auxiliary lane's dashed boundary
  take over. The nose forms itself, because the connector converges on the auxiliary lane as it goes.
  At the ramp end the offset is half the **ramp lane**, not half the connector — a connector is as
  wide as the auxiliary lane it blends into, and ramps are usually built wider than a freeway lane,
  so sizing the gore paint off the connector puts a visible jog in both edge lines at the hand-over.
- **One asphalt colour.** Ramps used to be tinted a shade lighter, which put a hard tonal boundary
  somewhere in every gore — and a gore is precisely the place where two carriageways become one, so
  there is no honest place to put it. Every position tried (at the gore, at the ramp's cap, tapered)
  read as a bar painted across the road.
- Every polygon added to a fill path is wound the same way first. Canvas fills with the nonzero rule,
  so an overlapping ring of the opposite winding cancels and punches a hole through to the
  background — and junction footprints come back from `polygon-clipping` with its winding, not ours.
- **No junction cover.** It used to be the junction's whole footprint, painted over the markings to
  hide overlaps inside the box. But a footprint reaches its own trim *plus the width of the road it
  crosses* up every approach — eight metres on a town arterial — so what it actually hid was the last
  eight metres of every road's lane lines, median and edge lines. Paint that stops a car's length
  short of the stop bar is the single thing that made every junction look unfinished. It was also
  hiding nothing: segments are trimmed back to the junction radius, so their markings cannot reach
  the box. Measured across the whole zoo, *zero* marking points fall inside any crossing's box, and
  `npm run audit` now checks that rather than assuming it.
- **Pedestrian crossings** are painted across every arm of a junction whose traffic is stopped by
  something other than a gap — a signal or an all-way stop. At a priority junction the major road
  never stops, so a crossing there would be a promise the junction does not keep. The bars run
  *along* the traffic direction and repeat across the carriageway, which is what makes a zebra read
  as a zebra from above rather than as a ladder lying the wrong way; they are emitted on the junction
  rather than the segment because they sit past the segment's trimmed end, and because the control
  they depend on is only settled once the overrides have been applied.
- Stop bars are painted at crossings only; a gore is not a place anybody stops, and a bar there lands
  straight across the middle of the carriageway. Junction covers likewise: a gore blends two
  carriageways whose markings both run through it, so only a crossing box hides what is underneath.
- The dash pattern is in world units, so zooming out shrinks the dashes themselves; below a couple of
  pixels each one antialiases away and the lane line vanishes while the road is still plainly wide.
  The whole pattern is stretched to hold a legible dash instead. The double centre line has the same
  problem from the other side: its yellow stroke and the thin asphalt core that splits it both hit
  the minimum pixel width at once, and then the core erases the line — below that it is drawn as one
  plain line.
- **Road symbols.** Lane-use arrows are baked into a fill path like every other bit of paint;
  proportions are roughly MUTCD (a 0.4 m stem about 4.6 m long, turn branches on a tight quarter-arc)
  and the whole shape's *bounding box*, not its stem, is centred in the lane — a turn-only arrow is
  lopsided, with the stem on one side and the head on the other. A left-and-right arrow is symmetric
  and cannot be shifted, so its sideways reach is what has to fit inside half a lane. Which way an
  arrow bends is easy to get backwards and impossible to see at map zoom, so it is pinned by a test
  instead: pointing along +x, a right turn reaches into +y.
- **Word markings read square-on to the driver.** The baseline runs *across* the carriageway and the
  letters are stretched *along* it, which is why STOP on a real road looks impossibly tall from
  above: the elongation cancels the foreshortening a driver sees at a shallow angle. Getting this
  backwards writes the word along the lane, which reads as a mistake even though nobody can say why.
- **Land-use buildings: plots, not scattered rectangles** (`render/buildings.ts`). `layoutBuildings`
  is a *pure function of the network* — no canvas, no `Path2D` — which is what lets the audit and the
  tests check every rectangle it produces. That matters more here than anywhere else in the renderer,
  because every failure mode is visual and silent: a house standing in the road, two houses in the
  same place, a terrace fanned round the mouth of a junction. None of them throw.

  Plots sit on the compiler's `Segment.frontages`, which is also what the simulation drives to — so
  the driveway a car pulls out of is a driveway that is drawn. The plot's ground is built from its
  two *boundary* points projected out to the kerb rather than from a centre and a width, so on a
  curve it is the trapezium a real plot is and two neighbours share one boundary line.

  The first version scattered rectangles along the asphalt outline, and was wrong in three ways at
  once. The outline goes **round the end caps**, so a street's buildings fanned across every junction
  mouth and interleaved with the next street's. The walk restarted its spacing on every edge of a
  flattened polyline whose longest edge is nine metres, so two buildings could land on one vertex.
  And two roads meeting at a corner knew nothing about each other. Frontages fix the first three by
  construction — disjoint intervals, held clear of both ends — and every plot is still registered in
  a shared grid so a plot from another road cannot land inside one.

  **Depth comes from the land, not from a constant.** Each plot probes outward — down its centre and
  both edges, because a road cutting a corner off is invisible to a single centre probe — until
  something paved is in the way. Two streets forty metres apart back onto each other with
  twenty-metre gardens; a street on the edge of town gets the full depth. It is what stops the whole
  thing looking stamped.

  **Nothing is tested by its corners.** A ten-metre building clears a corner test happily with a
  three-and-a-half-metre lane through its middle, which is how houses in the road shipped. Footprints
  are tested *exactly* against the pavement — edge crossings and vertex containment — which is both
  stricter than sampling and cheaper, because of how the pavement is indexed: every road surface and
  junction box is **clipped to each grid cell it touches**, so a probe walks six or eight edges
  instead of the three hundred a long street's ring has. Storing whole rings per cell was 85% of
  the bake on a big town. The one index serves the trees as well as the houses: a tree in the
  carriageway and a house in the carriageway are the same mistake, and testing for it twice in two
  ways is how one of them survives.

  Houses stand back behind a garden, take an L or a box, and get a drive from the kerb; shops come up
  to the footway, run together into a terrace, and stand on a service yard rather than a lawn.
  Roofs come from a small palette, because from above a street *is* its roofs and a row of identical
  grey rectangles reads as a diagram. Height is a **drop shadow cast in one direction for the whole
  map**, scaled by storeys — a per-building highlight keyed to the road looks wrong the moment two
  streets meet at an angle, because the same terrace ends up lit from two directions at once.
- **Verge planting.** A profile with a `verge` gets trees down both sides, baked once per recompile
  like everything else. They are placed by walking the segment's own asphalt *outline* and stepping
  outward, so a road that widens for a turn bay pushes its trees out with it rather than growing them
  through the new lane; anything that still lands on pavement — a neighbouring road, a junction box —
  is dropped. Blockers are bucketed into a coarse grid so a city's worth of streets does not turn the
  bake into a quadratic sweep. Seeded per segment, so the planting never shuffles between recompiles.
- LOD: below zoom 0.16 hide markings and buildings; below 0.3 skip verge planting; below 0.5 skip
  junction detail and building outlines;
  below 0.55 draw vehicles as dots; below 0.9 hide signal heads; below 1.1 skip arrows and word
  markings, which are too small to read; below 0.12 skip vehicles entirely.
- The render loop interpolates vehicle positions between sim ticks, including the lateral slide
  across a lane change. Lateral progress advances at a fixed rate, so its between-tick value is
  computed rather than guessed — without that the slide steps once per tick and judders.
- **Interpolate across a lane boundary too.** On the tick a vehicle is handed to the next lane its
  travel spans two of them, and falling back to the end-of-tick position there makes it jump forward
  and then stall for the rest of the tick. That is a snap at the mouth of every junction, which is
  exactly where the eye is already following it round a turn.
- **A car is a rigid body, not a point with a tangent.** Its heading is the direction from its rear
  to its front, with both ends placed on the path it is actually on. Using the lane tangent under the
  nose instead swings the tail out of the lane on anything that curves — a car turning through a
  junction points where the road is *going* rather than where the car is — and makes a lane change a
  pure sideways slide, because two parallel lanes share a tangent and nothing ever yaws. The rear's
  share of the lateral blend is the one the front had a car's length ago; that lag *is* the yaw.
  It is capped at 22° from the path heading, because the model moves a car across in a fixed time
  whatever its speed, and a car crawling over a lane line would otherwise crab almost sideways — and
  worked out at a reference speed when the driver is slower than that, or the angle jitters on the
  speed rather than on anything the vehicle is doing. The lag is squeezed *into* the manoeuvre rather
  than trailing off the end of it, so the body is straight when the change starts, angled in the
  middle, and straight again when it finishes; letting it trail leaves the vehicle still angled at
  the moment the change is declared over, and the yaw then vanishes in a single frame.
- **The rear end follows the road, not a straight line off the end of it.** Where the vehicle is
  longer than the distance it has travelled along its lane, the rear is taken from the lane it drove
  in from (`Vehicle.cameFrom`, tracked for exactly this). Running back along the entry tangent instead
  is fine for a car leaving a gentle curve, but a bus coming off a junction connector has its back end
  several metres from where that line puts it — the error goes as length squared over the radius, and
  it vanishes the moment the whole vehicle is on one lane, which is what makes it read as a snap.
  Guessing from the lane's own predecessors is no good either: wherever several movements converge it
  picks the wrong one. The reference has to be checked against the lane it is being used on, though —
  after a sideways move it names the lane behind the one just *left*, which would put the rear a
  lane's width out and flick the heading round the moment the tail cleared the boundary.

## Editor

- Tools: select/move, draw road, bulldoze, junction inspector, underlay transform.
- **Draw**: click to place points, drag while placing to pull a bezier handle, leave a point alone to
  have it auto-smoothed. Enter finishes, Esc cancels, Backspace takes back a point, Tab cycles
  ground/bridge/tunnel, Shift snaps to 15°. **The preview is the road that will be built**: it shapes
  its points through the same function `finish` does, with the cursor as a provisional last point,
  because a point's handles depend on the point after it. It used to draw the raw handles — for an
  untouched point, the point itself — so the user drew a chain of straight lines with sharp corners
  and got a smooth curve the moment they pressed Enter.
- **Ramps are drawn, not configured**: run a road out and drop its end on a freeway's edge. Endpoint
  snapping carries tangent continuity so extensions stay smooth; edge snapping is what the compiler
  then classifies as a merge or a diverge.
- **Select**: drag points and handles (Alt breaks the mirror), drag the body to move, drag empty
  space to box-select, Delete removes, Tab cycles grade.

  **Alt-click adds a point, and where you click decides which kind.** There are two different things
  people mean by it. *On* the road it means "give me another handle here": de Casteljau, so the shape
  does not move at all — anything else would shift the road while you were only trying to get hold of
  it. *Off* the road it means "go through here as well", and the road has to move, because the point
  was not on it before: past an end it carries the road on, beside the middle it bends the nearest
  span through the click. Alt-clicking an existing point removes it.

  Past an end means past it **along the road**, not merely nearest to it — the end's own tangent
  tells them apart, so standing off to one side of the last few metres is a bend in that span while
  the same distance further on is the road carrying on. Only the two points either side of the new
  one are re-smoothed, so shaping the rest of a road by hand is not undone by adding a point
  somewhere else on it. And the off-road click only ever edits the **selected** road: a click in open
  space is otherwise a guess at which of the roads around it was meant, and a wrong guess reshapes
  one you were not even looking at.
- **A T can be made right-in / right-out from the junction panel** — one switch, offered only where
  the junction is a T. While it is on the control buttons are put away (it runs on priority) and the
  left-bay choices are disabled, because the movement they would serve does not exist.
- **Clicking a gore opens it in the junction panel**, where its one choice lives: at an exit,
  whether the kerb-side through lane may take it as well as carrying on; at an entrance, how many of
  the lanes the ramp brings in stay on the highway. It used to cycle the value on each click, which
  was fine while the value was a flag and hopeless once an entrance had a count — and a click that
  changes something is not a click you can use to look. Both are stored on the same position-keyed
  override as a crossing's control choice.
- **Junction inspector — the lane graph made visible.** It works on gores as well as crossings: the
  two halves of a merge or a diverge live on *different roads* (the ramp is the junction's only
  approach, and its auxiliary lanes belong to the mainline), so the candidate sets come from the ramp
  approach plus the mainline's auxiliary lanes rather than from the approaches alone. Reading them
  off the connectors would work right up until you unwired the last movement to a lane, at which
  point it would vanish and you could never wire it back. Every movement is drawn as a spline: the
  connector centrelines themselves, so nothing is re-derived and the picture cannot disagree with
  what the traffic drives. Colour reinforces the shape rather than carrying it alone — blue straight
  on, green right, amber left, cyan a ramp blend — so it reads without a legend, and a head where
  each movement arrives settles the direction. Pointing at a lane picks *its* movements out of the
  rest instead of hiding the rest, which is what makes "where can I go from here" answerable at a
  glance; a link or a plain split has no connector, so those are drawn only for the hovered lane or
  a lane drop would scribble over every joint in the network. A second, dashed ring means the
  junction was wired by hand. Click a junction to select it, which opens it in the signal
  panel; C cycles priority / all-way stop / signals.
  Shift-click a lane running in, then one running out, to wire that movement by hand — the first
  edit seeds from what the compiler had, then each pair toggles. At a **gore** the lanes on offer are
  the ramp's *and every lane of the road*: a through lane appears on both sides at once, because
  until something is wired it is one lane that both arrives and leaves, and the movement joining
  those two is "carries on". That is what makes an option lane, an exit-only lane and two lanes
  funnelling into one expressible per lane rather than as a flag on the whole gore. While wiring, the candidate lanes
  light up at the **junction end only**: a lane runs the length of its road, and stroking the whole
  thing paints every street in view solid amber, which says nothing about a choice that is only
  about the junction. The arm the movement arrived on is left out, because the compiler refuses a
  movement that leaves by the road it came in on and offering one would be offering something that
  gets thrown away. Escape drops a half-made movement, and again hands the junction back to the
  compiler.
- **Hit tolerance is in pixels, not metres, but a lane is metres wide.** Ten pixels' worth of world
  is right when zoomed out and useless when zoomed in: at street level it is half a metre, so
  pointing anywhere but the exact middle of a 3.5 m lane picks nothing at all. Half a lane with a
  pixel floor is what the eye expects.
- **Grade is per control point.** Tab over a control point cycles that point between ground, bridge
  and tunnel; Tab anywhere else cycles the whole selection. Leaving the neighbours where they are is
  what makes the road ramp, so one stroke can rise, cross something and come back down. While
  drawing, the active level is stamped on each point **as it is placed**, so Tab part way along a
  road is what makes that road climb — a stroke built entirely by the toolbar's Ground/Bridge/Tunnel
  buttons has one level throughout, and those buttons only ever set the level for what comes next.
- **Snapping is level-aware, and the level belongs to the place, not the road.** A road being drawn
  only snaps to another where that other road is on the same layer *at the point being snapped to*.
  A stroke that climbs is at ground level at its ends and a bridge in the middle, so it offers its
  ends to a road drawn on the ground and its flanks to one drawn as a bridge — which is the same
  rule the compiler uses to decide what crosses what. Asking the stroke instead of the point makes
  an overpass a ground road everywhere: drawing on the ground then snaps to the middle of a bridge,
  and drawing a bridge snaps to nothing at all.
- **The road editor draws the road.** Both the swatch beside each road type and the canvas at the top
  of the editor are the same picture, produced by `render/roadPreview.ts` from the profile alone: a
  short plan-view piece of road with real lane widths, real markings, direction arrows and its
  verge planting, drawn in the map's own palette at the map's own marking widths. A grey box tells
  you nothing; this tells you how many lanes, which way they run, whether there is a median and
  whether it is planted — and because the preview reads the same `layoutProfile` the compiler does,
  the swatch cannot disagree with what gets built. Clicking a lane in the drawing picks it out.
  Everything else is a stepper beside the picture rather than a number to type, and the drawing
  updates under the cursor. The editor and the road-type list share a corner, so opening one hides
  the other — both visible stacks them and reads as a rendering fault.
- **Example maps.** Five shipped documents in a menu: a **diamond interchange**, a
  **collector-distributor road**, a **signalised arterial**, a **motorway corridor** and a **town
  grid**. A menu rather than a button each, because five more small buttons is exactly the crowding
  the toolbar already had. They open through the same `replaceDocument` as everything else, so
  opening one is a single undo step rather than a trapdoor out of the edit history. No trumpet and no
  cloverleaf: both are defined by ramps that *cross each other*, real ones settle that with a third
  level, and a hand-placed one settles it with coordinates that have to be guessed. The C-D road
  replaces it deliberately — four gores in two kilometres is the flagship manoeuvre four times over,
  in geometry that can be laid out exactly.
- **Zoning (Z) is painted, like a city builder.** Pick Houses, Shops or Clear and drag along roads;
  one drag is one undo step, and the overlay shows every road's **effective** zoning — what it
  inherits from its road type as well as what has been painted over it. Effective, not painted, is
  the whole usefulness of it: a town built entirely out of "residential street" has nothing painted,
  and an overlay showing only overrides would answer "nothing is zoned" when the honest answer is
  "all of it". The road type still supplies the default, so drawing with a residential profile still
  zones as you go.
- **Marking the ends of the network.** Clicking an end with the junction tool cycles what it lets
  traffic do — both ways, in only, out only, closed, **cul-de-sac** — and the overlay draws each one
  as an arrow rather than a ring, because the whole choice is directional. The last one is not about
  demand at all: it builds a turning head (see **Cul-de-sacs**), which stops being a portal, so the
  overlay draws it as a loop and the click that made it is the click that undoes it. Available whatever the spawn mode is:
  refusing the click outside the gateway mode would mean discovering the control only after you
  already needed it. An end nobody has marked stays `both`, so switching to the gateway mode is a
  starting point rather than a cliff.
- **Underlay**: drop any image on the canvas to trace over it; drag to move, corners to scale, the
  top handle to rotate, Shift keeps the aspect ratio. Satellite tiles need a lat/lon anchor and an
  XYZ template you supply.
- Every mutation is a command. Ctrl+Z / Ctrl+Shift+Z from day one; one drag is one undo step.
- Keys: V select, R draw, X bulldoze, J junctions, U underlay, Space run/pause, F fit, Ctrl+S save.

## Save format

Versioned JSON of the edit model only:

```json
{ "version": 3, "profiles": [...], "strokes": [...], "settings": {...},
  "terrain": {...}, "demand": [...], "junctions": [...], "laneLinks": [...],
  "gateways": [...], "underlay": {...}, "geo": {...}, "nextId": 42 }
```

A `junctions` entry carries the control choice, a gore's lane arrangement, a T's right-in /
right-out switch, the per-approach turn-bay choices, and — for a signal — its whole phase plan. Plans are read defensively: timings clamp rather than fail, a group name that no
longer matches anything is left alone (the compiler resolves names to connectors and finds none), and
a plan with no usable phase is dropped so the junction falls back to the automatic one rather than
sitting on all-red.

Control points are written as flat seven-number arrays rather than objects, which roughly halves the
file: position, both handles, and the level the point sits at. Version 2 moved that level off the
stroke and onto its points; the migration copies the stroke's level onto every one of them. A gateway role of `culdesac` is what makes an end a turning head; older code
refuses a file carrying one rather than opening it as a plain dead end, which is the point of the
version gate. Version 3
added land use on profiles, a spawn mode on settings and gateway roles — all optional with defaults
that are the old behaviour, so its migration rewrites nothing. It exists to record that the format
grew, and so that a v3 file carrying gateways is *refused* by older code rather than half-loaded
without them. Migrations live in `core/util/serialization.ts` and run in order; loading is defensive
(unusable strokes are dropped, missing settings default, out-of-range values clamp, a stroke whose
profile went missing is repointed) and a file from a newer format is refused with a clear message
rather than half-loaded. Never break old saves silently.

## Importing OpenStreetMap

A square of the real world, by coordinate: type a latitude and longitude into the
toolbar, pick a size, and get a working network. Two miles square is what it is built
for — Cupertino's two miles are 1,976 roads, and they download, import and compile in
about nine seconds in Firefox.

**The compiler already wants what OSM has.** A way *is* a centreline and a tag list is
a cross-section, junctions are found geometrically, so the import supplies no
junctions, no lanes and no connectors — it supplies strokes and profiles, and the rest
of the pipeline runs unchanged. That is why this is a small module rather than a
second compiler. `core/geo/mercator.ts` was already there for satellite tracing and
does the lat/lon → metres with the 1/cos(latitude) distortion divided out at one
anchor, so a two-mile square is two miles across in Reykjavík as well as in Lagos.

**Fitting is what makes it a road rather than a polygon** (`core/geom/fit.ts`, the
inverse of `flatten.ts`). A surveyed way is a vertex every few metres carrying the
noise of however it was traced; kept as control points it is faceted at any zoom, the
offsetter spends its time repairing cusps that exist only because two vertices
disagree by a degree, and nobody can edit it. Douglas–Peucker to drop the vertices
that say nothing, then Schneider's fit — least squares, Newton reparameterisation,
split at the worst point — which comes out around 2.4 vertices per control point. Two
rules are not negotiable: the **ends never move**, because a junction is found
geometrically and an endpoint that drifts half a metre is a T-junction that silently
stops being one; and the **handles are capped at 1.5 chords**, because the
least-squares optimum for nearly-collinear data with nearly-parallel end tangents is
unbounded. On the first city that imported it produced a handle 239 km long on a 40 m
road, which became a junction connector 156 km long, and the compiler spent **five
minutes** of a five-minute compile testing it for conflicts. One bad handle cost 137x.

**Tags supply the exceptions; the class supplies everything else** (`core/osm/tags.ts`).
`lanes` is missing from most residential streets on earth and `width` from nearly
everything, but `highway` is always there and carries most of the information. So the
road class gives the defaults and the tags override them, which is also what makes an
import look coherent: a city drawn from eighty road types reads as a city, and one
drawn from a thousand slightly different ones reads as noise. Four readings earned
their place by being wrong first:

- **A `motorway_link` is a ramp; every other `*_link` is a slip road.** A gore, an
  acceleration lane and a taper belong on a motorway. A `primary_link` is the hundred
  metres that cuts the corner at an ordinary junction, and asking the compiler for a
  gore there was most of the errors in the first city.
- **A gore needs a road worth one** (`goreWorthBuilding` in the compiler): a shallow
  endpoint join is a merge only where the road is fast or wide enough to need an
  acceleration lane. Drawn by hand nobody puts a driveway on a freeway at twenty
  degrees; imported, a supermarket entrance meeting a residential street does exactly
  that, and it was one junction in twenty.
- **A gore whose road runs the wrong way is a junction, not an error.** One-way pairs
  meet the wrong one of the two constantly. Refusing to connect left the ramp's lanes
  with nowhere to go; building the plain crossing lets the allocation decide, and the
  movements that cannot exist simply are not built.
- **A roundabout is taken at roundabout speed** whatever the road it interrupts is
  signed at. OSM carries the parent road's `maxspeed` round the circle, so Milton
  Keynes' grid roundabouts arrive at 95 km/h — and a circulating carriageway at
  ninety-five is a very fast bend that traffic queues on. Every collision in that city
  was two cars on a roundabout connector; capping it at 35 km/h took 34 to 2.

**Roundabouts** are `Stroke.roundabout`, set by the importer from `junction=roundabout`
and carried onto the segment. A circulating approach's weight is multiplied by a
thousand, which says the whole thing at once: entering traffic yields to it, and the
arms are then nothing like comparable, so the junction keeps priority control instead
of being handed signals or an all-way stop. Before that, 483 of Milton Keynes' 730
roundabout junctions compiled as all-way stops and 277 circulating movements gave way
to traffic entering — which is exactly backwards and deadlocks as soon as it fills.
A roundabout drawn as **one closed way** is a road whose two ends are each other, and
the compiler rightly refuses a movement that leaves by the road it came in on, so it
never circulated: a third of Milton Keynes' are drawn that way. Closed ways are cut
into arcs at the nodes they share with other ways — spaced by *metres*, because two
entries four metres apart are one place on the ring and cutting at both makes a
four-metre stroke with a junction at each end.

**The two kinds of end.** A road the extract's boundary cut carries on in the real
world, so traffic comes in and out of it; a road that ends in the middle of the square
ends in the middle of the real world too. Told apart, the import marks the interior
ones closed and sets the spawn mode to `gateways`, so the traffic enters where a
city's traffic enters. Left undistinguished, two miles of suburb spawns from nine
hundred places at once and gridlocks in five minutes at four thousand vehicles and
nine kilometres an hour.

**Where the data comes from.** Overpass, by coordinate from the toolbar, or an export
dropped on the canvas — told from a saved document by what is inside it (`elements`
against `strokes`) rather than by its name. The endpoints are a free service run by
volunteers: they are tried in turn, and a 429 from one is not a reason to tell somebody
their coordinates are wrong. Data is © OpenStreetMap contributors, ODbL.

**What it is checked against.** `scratch/osmPlaces.ts` is eighteen places chosen to
break different things — a suburban US grid, Manhattan's one-way grid, mediaeval
London, the Étoile, Tokyo's stacked expressways, a city built on roundabouts, a
four-level stack, both hemispheres, the equator, and 64°N where Mercator distortion is
largest. `npx tsx scratch/osmfetch.ts` caches them; `npx tsx scratch/osmcheck.ts`
imports, compiles, audits and drives every one; `scratch/osmcollide.ts` says where a
city collides and what kind of junction it is.

## Terrain and underlays

- **Image underlay** — drop any image, position it by hand, saved with the document. Zero
  dependencies.
- **Satellite tiles** — standard Web Mercator z/x/y. The canvas is georeferenced by pinning world
  (0, 0) to a latitude and longitude; Mercator's 1/cos(latitude) distortion is divided out at the
  anchor so a traced network comes out at true scale. The tile URL template is supplied by the user,
  who is responsible for their provider's terms.
- **Procgen** — fBm simplex heightfield with a ridged component, ocean below sea level, rivers from
  downhill flow accumulation, cliff bands where slope exceeds a threshold, all vectorised with
  marching squares (`d3-contour`) to match the flat vector look. Constraints are checked *outside*
  the compiler (`core/terrain/constraints.ts`) because terrain is optional and `compile()` must not
  depend on it: road over water or a river requires grade > 0, road through a cliff band requires
  grade < 0, surfaced as live diagnostics.

## Milestones

All twelve are implemented and covered by tests.

1. ✅ **Canvas + camera + first road** — pan/zoom, draw, undo/redo.
2. ✅ **Bezier roads** — control handles, multi-lane rendering with markings, profiles/presets.
3. ✅ **Crossings** — detection, splitting, junction footprints and covers.
4. ✅ **Lane graph + one car** — compiler emits lanes/connectors; routing drives a car through.
5. ✅ **Traffic** — IDM, spawning/despawning, thousands of cars, determinism hashes.
6. ✅ **Junction control** — priority + gap acceptance; signal phases; per-junction override.
7. ✅ **Lane changes** — MOBIL with hysteresis, downstream-speed awareness, per-driver variation.
8. ✅ **Highway merges (flagship)** — ramp drawing, compiler ramp synthesis, full merge model, all
   acceptance scenarios green.
9. ✅ **Grades** — bridges/tunnels, Tab to cycle while drawing, stacked rendering.
10. ✅ **Builder + persistence** — road builder UI, save/load, versioning and migrations.
11. ✅ **Underlays** — image underlay, then georeferenced satellite tiles.
12. ✅ **Procgen terrain** — generation, vectorisation, build constraints.

Two things are known to be imperfect and are the next work, in this order:

1. **Junction boxes on the fuzzer's odder shapes.** `scratch/junctionfuzz.ts` still reports 2
   shapes in 420 where the box reaches past the roads' caps by more than the kerb allowance, worst
   7.1 m, down from 25 at 17.1 m — most of the rest went with the facing-arm trim rule and the
   one-sided bay flare. It also reports 30 places where one road's paint lies inside another's
   asphalt, nearly all of them five-arm shapes with two arms a few degrees apart. The zoo audits
   clean. `scratch/crossfuzz.ts` has 31 shapes in 300 with something to say, down from 86: stubs
   ending short of a *curved* road by more than the compiler's tolerance simply do not join it
   (which is what was drawn), two eight-metre roads whose ends are twelve metres apart are two
   things, and the rest is paint on those same near-parallel five-arm shapes.
2. **Weaving-section polish** beyond the current fused auxiliary lane.

Also outstanding: the outer lane of a **two-lane auxiliary stack on a curve** leaves its own asphalt
at its first and last vertex — 1.0 m and 0.6 m outside, on a 322 m fused weaving lane on a 180 m
radius, found by `scratch/scenecheck.ts` on a hand-drawn map and reproduced on no zoo case. The
surface's extent for a stacked lane grows from zero across the taper while the lane's centreline is
at its full offset from its first point, so the two disagree at exactly the ends. Nothing in the zoo
has that combination, which is why it wants a case before it wants a fix.

**Two long-standing defects were closed together, and how is worth keeping.** Both were in the
*junction*, and in both cases the fix that suggested itself was in the simulation and the right one
was in the compiler.

- **An at-grade priority crossing with a large speed or width mismatch** produced collisions *and*
  starved the minor arm, which then spilled back and gridlocked. It was the top known limitation for
  a long time, and it made two assertions in `test/sim/committed-crossing.test.ts` red. Priority
  control needs gaps somebody can judge; above about 90 km/h there are none, because the major
  stream never pauses. The minor arm is then not slow to be served but never served, and a driver
  who has waited minutes is being asked to read a gap in traffic doing thirty metres a second. The
  compiler no longer builds one (`PRIORITY_MAX_SPEED`, step 12): it signalises, which is what a real
  network does with the shape it cannot grade-separate.

  The simulation-side fix was tried first and is recorded in `core/sim/junction.ts` rather than
  taken. Extending the "a rival that cannot physically stop is coming" floor to *committed* rivals
  removes the same collisions — and saturated, nearly every committed driver is near its conflict
  point at speed, so all of them brake for each other: the four-way in `test/sim/approach.test.ts`
  went from discharging 12 vehicles in its final minute to 8. A safety floor that fires on most of
  the traffic is a control strategy wearing a safety floor's clothes.
- **The compiler's own generated signal plan tripped its own validation** on about 1.4% of fuzzed
  shapes — `signal-phase-conflict`, an error on a plan nobody authored. The generator paired arms
  more than 150° apart into one phase and took facing each other as proof they did not conflict.
  Where a two-way road is drawn as a one-way pair — most of a city centre, and most of an OSM
  import — the two arms *do* face each other and their through movements still cross inside the box.
  `axesOf` now verifies what it greens, using the same test the validator uses, against every arm
  already in the group rather than only the one that started it. Zero in 420 fuzzed shapes and zero
  across the eighteen imported cities.

Roundabouts are the obvious next feature. None of it before merges are flawless.

## Testing strategy

`npm test` runs 760 tests in about 140 s; the merge suite is most of that and is worth every
second. Two of them are red, both in `test/sim/committed-crossing.test.ts`, and they are the
at-grade priority crossing under **Milestones** — not a flake and not something to re-run away.

- **Geometry units** (`test/geom/`): crossing cases, flattening within tolerance, offset cusp and
  loop repair, arc-length correctness, polygon booleans, taper geometry.
- **Compiler units** (`test/network/`): grade along a road — where it splits, going up and back down
  in one stroke, and meeting only what it is level with — hand-wired junction movements, left-turn
  pockets — where they are built and where they are
  not, that the bay is the only lane a left turn leaves from, and that opening one moves the through
  lanes without moving the median — cross-section layout — including the *painted* cross-section,
  because evenly spaced lane offsets do not by themselves make evenly spaced lanes on screen — crossings and classification, ramp
  synthesis dimensions, lane drops, junction connectors and priority, portals, serialization
  round-trips, terrain and Mercator maths.
- **Approach and box** (`test/sim/approach.test.ts`): traffic well clear of a junction runs at the
  limit rather than at half of it, it does not weave its way down the road, and — the invariant the
  ring deadlock violates — no vehicle ever joins a connector that already has something stationary on
  it. Plus `test/sim/stranded.test.ts`: a merger at the end of an acceleration lane gets in rather
  than chasing a gap that keeps moving away. Which seed shows that worst moves whenever anything
  upstream changes the arrival pattern, so it asserts the worst of a handful rather than one number.
- **Placement** (`test/sim/spawn-speed.test.ts`): a driver is never *put* somewhere they could not
  have reached at that speed — asserted on the spawn tick itself, where nothing has happened to them
  except being placed, and restricted to the holds the entry speed actually governs (a merger
  regulating against a gap is the merge model's business). One synthetic fixture built to be nasty —
  a short fast stub whose ways out are one fast and several slow — plus all five shipped example
  maps in the spawn mode each of them actually uses, where this used to happen to one spawn in
  twenty.
- **Closely-spaced junctions** (`test/sim/short-approach.test.ts`): two signalised crossings twenty
  metres apart, which is the shape imports produce constantly and the zoo never had. It guards the
  invariants — the compiler really does build it, nobody collides, nobody is lost, it still
  discharges — and it deliberately does *not* claim to isolate the rule above: a synthetic pair will
  not reproduce that failure however it is posed, because free-flowing the two signals never conflict
  for long enough and congested the queue reaches back through the first junction, whose box-blocking
  rule then stops anybody arriving at speed. Measured across eight seeds with the rule and without
  it, the fixture gives the same number. The evidence for the rule is `scratch/osmcheck.ts`, which
  needs a real network.
- **Junction control** (`test/network/junction-control.test.ts`): which control a crossing gets, and
  in particular that a crossing of a road nobody can find a gap in is not left on priority — on the
  speed rather than on the size of the road, and never over the document's own choice.
- **Sim units** (`test/sim/`): IDM and MOBIL against hand-computed values, the safety floor, vehicle
  pose — the body stays on the lane through a turn, yaws into a lane change, settles out of it, and
  moves continuously across a lane boundary, and turns continuously whatever length it is —
  determinism (same seed → same hash; different seeds diverge; chunked stepping matches).
- **Editor** (`test/editor/`): every tool driven headlessly through the same interface the canvas
  uses — drawing, snapping, dragging, undo coalescing, ramp creation end to end. Adding a point gets
  its own file, because the gesture means two different things: on the road the shape must not move,
  off it the road must reach the click, and a click past an end has to be told from one beside the
  last span at the same distance. Levels get their
  own cases, because both halves of "draw a bridge" were broken independently: a road takes the
  level Tab left it on, one stroke climbs and comes back down, and a climbing road offers its ends
  to the ground and its flanks to the air. The junction
  inspector's overlay is checked against the connectors it claims to draw: a spline started at every
  movement's own first point, the hovered lane lighting up a strict subset, and no mutation of the
  lane graph while drawing. Hand-wiring is driven the way a user does it — two shift-clicks add a
  movement, the same pair again removes it, and a movement back down the road it came from is
  refused rather than silently discarded at compile time.
- **Render** (`test/render/`): the whole pipeline under a stub canvas — layers run, culling and LOD
  actually change what is drawn, and the renderer never mutates sim state. Plus the gore
  regressions: the corridor between a ramp and its auxiliary lane is paved, a junction footprint is
  flush with the roads rather than a collar around them, the ramp's edge lines carry across the gore
  and the road's stays off the auxiliary lane until it exists, every filled ring is wound the same
  way, and stop bars appear only where traffic has to stop. Lane-use arrows are checked as geometry —
  which way each branch reaches, and that a combined arrow still fits inside its lane. Verge planting
  is checked for the one thing that must never happen: a tree standing on a road or in a junction,
  and buildings for the four: nothing on a road, nothing inside anything else, nothing overhanging
  its own plot, and enough variation in size, shape and colour that a street does not read as a
  stamped pattern.
  The road preview is checked against the compiler's own cross-section, because the whole point of
  drawing it is that picking a road type stops being guesswork. Grade transitions get their own file:
  the two sides of an abutment agree on how high they are, the shadow is displaced by that height
  rather than by the layer, the casing draws no cap where the road carries on — and still draws one
  where it stops — and the renderer strokes the outline rather than the surface. Bridge and tunnel
  both.
- **Scenario regressions** (`test/scenarios/`): the merge suite above, a four-way priority junction,
  an all-way stop, a signalised arterial grid, and a five-way — where some destinations are simply
  not reachable from some approaches, and no vehicle may drive through another however busy it gets.
- **Collisions mean *any* two bodies overlapping.** `metrics.collisions` counted a vehicle
  overlapping its leader and nothing else, so "zero collisions" meant zero rear-end overlaps and said
  nothing about a junction — which is exactly where vehicles visibly drive through each other. It now
  also walks the compiler's conflict points and asks whether somebody's body is over both ends of one
  at once, and it counts **events over the run** rather than pairs overlapping right now: a snapshot
  only reports what happens to be true on the tick somebody looks, and every scenario suite reads the
  number once, at the end.
- **Nobody is held at walking pace** (`test/scenarios/merge.test.ts`): across four merge scenarios,
  the longest a vehicle spends below `MERGE.crawlSpeed` *with a clear road in front of it* is bounded
  at 20 s. Creeping to the end of an acceleration lane is legitimate and takes a few seconds; a
  minute of it is two drivers waiting for each other. These scenarios have no junctions, so there is
  nothing else a stationary driver could be waiting for — which is what makes the observable clean.
- **Signal stress** (`test/scenarios/signals.test.ts`): eight intersection shapes, each chosen
  because it defeats a generator that only knows about four-arm crossroads, crossed with all three
  presets. Every combination is driven for eight minutes below capacity and again at 1.3x it. What is
  asserted is what must hold whatever plan is running — zero collisions, zero lost, still discharging
  in the final minute, no movement group left unserved, and no wait longer than three cycles — rather
  than a throughput number, because protected phasing legitimately *costs* capacity and that is the
  deal it offers. Plus the one thing "protected" actually claims: with a protected plan, the number
  of ticks a left-turner spends stopped inside the junction is exactly zero, against hundreds under a
  permissive one. Turning on red gets its own cases: that it is on unless the document says
  otherwise, that it actually moves kerb-side vehicles through a red and only kerb-side ones, that
  the driver comes to a stop first, and that it buys throughput at every shape rather than costing
  it. What that measures is a vehicle **joining** a connector against a red, not one sitting on a
  connector that has gone red: the second catches a driver who entered on green and is still
  clearing, which is exactly what the intergreen is for and which a slow one does legitimately —
  3.4 m/s across a 10 m connector takes 3 s against a 1.7 s clearance, and the control run then
  reads one turn on red that never happened. `npx tsx scratch/signalcheck.ts [case] [minutes] [demand]` prints the same numbers the
  assertions are built from.
- **Cul-de-sacs** (`test/network/culdesac.test.ts`, `test/sim/culdesac.test.ts`): built only where
  the document asks, no portal left at the end, the bulb inside the road that was drawn, the U-turn
  on the tarmac and past the centre of the circle, the ring of houses clear of the mouth and served
  from the lane leaving the head — and, in the sim, that traffic really does drive round it, that
  nobody is lost in there, and that through traffic never enters one at all.
- **Application** (`test/app/`): the demo document compiles clean and runs clean; a full
  edit-run-render cycle through every tool stays consistent; and the whole editor boots under jsdom
  with a stub canvas, so drawing a road with the pointer, panning, the road builder, the terrain
  toggle and undo are all exercised without a browser. Every **example map** compiles with zero
  errors *and* zero warnings, runs five minutes with nothing lost and nothing colliding, and survives
  a save/load round trip — the warnings are the interesting half, because they are how the compiler
  says "I built something, but not what you drew". Opening a document also has to *rebake the roads*,
  which is checked because it did not.
- **Portability** (`test/core/portability.test.ts`): `src/core/**` is read as text and must not
  mention `process`, `document`, `window`, `Path2D` or anything else that exists in one environment
  and not the other. Blunt on purpose — the thing being defended is that core has no environment, and
  the only way to check that from inside one is to look at the source.
- **OSM import** (`test/geom/fit.test.ts`, `test/osm/import.test.ts`): the fit keeps
  its ends and its tolerance, splits at a corner rather than rounding it off, and
  never returns a handle longer than its chord allows — the one that cost 137x on a
  city compile. The importer reads the tags the way they are meant, cuts a closed way
  into arcs, closes the ends inside the extract and leaves the boundary open, and
  compiles a roundabout whose circulating traffic has priority and whose junctions are
  never all-way stops.
- **Perf smoke** (`npm run bench`): 5,000 vehicles on a synthetic 287 km-of-lane freeway network.
  Currently compile 68 ms, tick 2.3 ms median under Vitest (budget 6, see the harness note below),
  street-level frame 0.6 ms. That network is a fixed size, which is the one thing it cannot measure —
  see `scratch/simscale.ts` under the tarpits.
  Compiling was 117 ms until the offsetter stopped allocating four typed arrays per call, stopped
  using `Math.hypot` where a `sqrt` does — V8's guards against overflow, and world coordinates are
  metres — and stopped hunting for self-intersections in offsets that cannot have folded. It is the
  most-called geometry in the compiler by a wide margin: a town-sized document runs it four thousand
  times over a hundred and fifty thousand vertices.

  That tick number carries a harness cost worth knowing about: the identical network in the identical
  state measures **1.3 ms** run under `tsx` and 2.3 ms under Vitest, and a raw arithmetic loop is the
  same speed in both. The difference is Vitest's module transform, which wraps every import and
  blocks cross-module inlining — and the hot loop calls into `idm`, `merge` and `junction` constantly.
  The budget is asserted against the pessimistic number on purpose, but do not quote the Vitest
  figure as the cost of a frame in a browser. It asserts **zero collisions** as well as the timings, and that assertion has earned its
  place: it is the only thing in the suite with three hundred conflict points, and it is what found
  the committed-crossing hole in the junction model.
- **Stress** (`npx tsx scratch/townstress.ts [blocks] [demand]`, dev-only): builds a town far larger
  than any example, zones all of it, and checks the two things that are silent when they go wrong —
  the geometry (nothing on a road, nothing inside anything else) and a full simulated day of its own
  traffic. A 9x9 town is 684 segments, 361 junctions, 5,130 plots and 18,417 trips in a day, and it
  is what found the zoning split brain.
- **Visual verification** (`scratch/`, dev-only, not in `npm test`). Most defects this project has
  shipped were visual, and a screenshot at a time is not a way to find them. Three tools:
  `scratch/cases.ts` is a zoo of ~38 documents — the five example maps included, because those are
  the documents a user actually opens, so a fault in one of them is a fault the user sees first — — every ramp shape at one and two lanes into two,
  three and four-lane freeways, weaves, lane drops, a road that bridges over another and one that
  tunnels under it, crossings straight, skew, curved, wide-into-narrow and five-way, plus the demo
  document itself. `gallery.html` renders every case through the *real*
  renderer into a grid (`?only=` filters on a comma-separated list of name substrings, `?zoom=`,
  `?at=x,y`, `?wide=1`, `?h=`, `?run=` to run the sim first). `npm run audit` (`scratch/audit.ts`) checks the same zoo numerically for the things
  that show up as visual faults: markings off their own asphalt, lane centrelines off it, connectors
  crossing bare ground, an edge line that is not exactly one shoulder inside the kerb, **carriageway
  edge with no edge line painted along it**, **two adjacent lanes with no divider between them**,
  **a junction box outside the convex hull of the roads' own end caps** — which is exactly what "a
  road pokes out of the intersection" is — **median lines that swap sides**, **a junction's own paint
  ending short of the road marking it continues**, and surfaces
  whose area or winding is wrong. It reports zero on all cases; when adding a check, break the
  compiler on purpose first and confirm the check fires.

  `scratch/goreWiring.ts` compiles, audits and drives every sensible way to wire a two-lane gore by
  hand — the default pairing, an option lane, an exit-only lane, two lanes funnelling into one, the
  same for an entrance, and one deliberately left with a hole to prove the warning fires.

  **A tolerance has to be derived, not guessed.** The junction-box check compares against the convex
  hull of the caps that touch *that* junction, plus the junction itself. Taking every cap of every
  approaching segment instead — including the one at the road's far end — makes the hull a triangle
  hundreds of metres wide that catches nothing, and when every arm leaves within a half-plane that
  hull does not contain the junction at all, so a perfectly good box reads as entirely outside it.
  What it allows past the hull is the kerb radius plus the corridor tail, because both are deliberate
  and a junction *does* have paved corners; a flat 1.2 m flagged 173 well-formed boxes across the
  zoo. And a point outside the hull is fine if a road is under it, which is what "asphalt with no
  road behind it" actually means.

  `scratch/osmcheck.ts` and `scratch/osmaudit.ts` do the same for the imported cities, which is where
  the compiler's geometry is actually tested: the zoo has the shapes somebody thought of, a city has
  the ones nobody did. The audit reports zero on the zoo and 149 on a two-mile square of Cupertino,
  and the difference is the point — most of them are one road's paint lying inside another's asphalt,
  where the roads genuinely do overlap (a ramp beside its motorway, parking aisles) rather than where
  the compiler put them wrong.

  Twenty cached squares, five simulated minutes each — a hundred simulated minutes of somebody
  else's road network — currently give **2,583 completed trips, 6 collisions, nothing lost** and 35
  errors, all of them either a sliver junction the compiler is right to refuse or a ramp with no
  room for an auxiliary lane.

  **Count the trips, not the arrivals.** An earlier version of the flyover pass reported 19,687
  arrivals against today's 2,583, and it was measuring its own damage: raising roads that were
  already separated left their ends in mid-air, which cut the network into fragments, and every
  fragment end is a portal. The mean *trip* was 15.6 seconds — cars appearing and vanishing a few
  metres later. It is 144 s now. Any metric that rewards disconnecting the network needs a
  companion that does not, and mean trip time is the one. Compile runs from 285 ms on a small square to 3.1 s on four miles of
  Cupertino, and the tick scales with the traffic rather than the map (`scratch/simscale.ts`).
  Numbers, not adjectives: when one of them moves the wrong way, that is the regression.

  `scratch/junctionfuzz.ts` runs those same checks over several hundred generated junction shapes —
  three to six arms at awkward bearings, mismatched widths, curved approaches. The zoo has the shapes
  somebody thought of; this has the ones nobody did, and it is what found the three-arm spur above.
  `scratch/crossfuzz.ts` builds crossings *the way a user draws them* — stubs ending a few metres off
  the road they meet, opposite stubs that do not line up, a continuous road met by two separate
  roads, four roads ending at a point, slip roads on a crossing, one-way arms, two T's close together
  — and asks how many junctions and arms came out, what was refused, and how far each arm was set
  back beyond what it needs. It found the two-strokes-versus-four-strokes difference and the
  clustering that split a hand-drawn crossing into two. `scratch/setback.ts` prints the excess setback
  for every crossing in the zoo — measuring each road's reach from its own *centreline* at the cap,
  because half the cap chord is only that on a road symmetric about its centreline, and a bay flares
  one kerb and not the other. Read the chord instead and the same unmoved arm scores two metres
  worse than it did the day before. `scratch/scenecheck.ts <file.json>` runs the compiler and the
  whole audit over a saved document, which is how a map somebody actually drew gets checked. The audit also checks that **no road's paint lies inside another
  road's asphalt** on the same grade, joints excepted — which is how the bay flare and the ramp cut
  were caught, since neither shows up as paint off its *own* road.

## Known tarpits — read before touching related code

- **Offset cusps.** Tight curvature + wide roads makes offset polylines self-intersect. The offsetter
  drops folded vertices then repairs remaining loops by splicing in the crossing point; it also
  reports the worst curvature-to-width ratio so the editor can warn.
- **Sliver junctions** from near-parallel crossings — rejected at classify time, never built.
- **MOBIL oscillation** — the 3 s cooldown, the `a_thr` hysteresis and the 0.4 s evaluation period
  are what keep lanes stable. Don't remove them to make merges "snappier"; raise gap-scoring quality
  instead.
- **A level is a property of a point, not of a road.** The compiler already knows this — grade lives
  on control points and ramps between them, so a stroke that climbs crosses *under* what it later
  crosses *over*. Anything outside the compiler that reduces a stroke to one level (the editor's
  snapping did, from its first control point) disagrees with what gets built, and the disagreement
  shows up as an editor that will not let you draw the thing the compiler would happily compile.
- **A movement nothing drives is scenery.** The cul-de-sac's U-turn compiled, rendered and was never
  once used: a driver bound for a house on the street parked at the first address they passed on the
  way in, so the turning head was decoration and the feature looked finished from every angle except
  a running simulation. Whenever something is added for traffic to *do*, count how often traffic
  actually does it before believing it works — `test/sim/culdesac.test.ts` exists for that reason.
- **The ranges of one stroke must be disjoint and in order.** Two junction footprints that overlap
  along a road get pushed apart so a segment fits between them; unclamped, that inverts the near one
  — `hi` ends up behind `lo` — and the cursor then never advances past it, so the next segment starts
  where the previous one did. One piece of road is emitted twice, lying exactly on top of itself,
  with two sets of lanes, two sets of paint and traffic on both. Every imported city had a handful
  (92 across sixteen) and no hand-drawn document had any, which is why it survived so long.
- **No road lane may simply stop.** The end of the road is a portal and a fine way to leave; a lane
  that runs *into a junction* and gets no movement out of it is not. There is no way on, no way back
  and nothing marks it — the dead-end check only looks at lanes that already know they end — so
  traffic drives to the end and is retired as lost. Real data produces it two ways: a junction whose
  every arm is one-way *inward* (a broken roundabout ring, or a one-way pair the data has back to
  front), and an auxiliary lane given a `mergeTarget` with no `endsAt` to go with it. `tieOffDeadEnds`
  ends the lane and merges it into its neighbour where there is one, and where there is not — the
  whole junction being a sink — the lane becomes an exit portal, because a lane with nowhere to go
  *is* where the network stops. Across the imported cities that was 200-odd stranded lanes and every
  lost vehicle; both are now zero, and a third more traffic completes its trip.
- **A portal is where the network stops, not where no junction was recorded.** A plain split (step 8)
  wires its lanes straight across without a junction id, so reading "no junction at this end" as "the
  road ends here" drops an entry *and* an exit portal into the middle of a running carriageway.
  Vehicles then spawn on top of traffic crossing the boundary and the ones behind stop dead, while
  others despawn mid-motorway. The test is whether the lanes have anywhere to go: a lane with
  successors is not an exit, a lane with predecessors is not an entry.
- **A junction deadlocks from the inside, and it is permanent.** Not spillback — every exit lane can
  be empty. Vehicles that entered the box each end up held at a conflict point by the next one round
  a ring of three or four arms, and by then their bodies physically cover the points, so nothing can
  be relaxed to unwind it. It is prevented, never cured: adequate intergreen, and the three
  "is that rival coming" rules under **Junctions** above. Any change to those rules must be re-run
  against `test/scenarios/signals.test.ts` at 1.3x capacity, which is where it shows up.
- **A metric that measures the wrong thing is worse than none.** `collisions` counted only same-lane
  overlaps for a long time, so every suite reported zero while vehicles drove through each other at
  junctions — and it was a *snapshot*, so even a run that collided throughout could finish clean.
  Both are fixed; when adding a metric, ask what a passing value would fail to notice.
- **A signal plan's names outlive its ids.** Phases green movement *groups* (`strokeId:side:turn`),
  never connector or lane ids, which are rebuilt from scratch on every recompile. A plan authored
  against a two-lane road still applies after it is widened to three.
- **Priority cycles** cause frozen intersections — `priorityRank` is produced by a sort with a unique
  final tie-break, so it is a total order by construction. There is a validation check; keep it.
- **A cost that scales with the network, not the traffic.** `npm run bench` runs one synthetic
  network of a fixed size, so it cannot see one: the tick was 0.4 ms on a two-mile import and 47 ms
  on a four-mile one, with the same few hundred vehicles on it. It was `retarget` asking every portal
  in turn how far away it was, each answer a whole-graph Dijkstra. `npx tsx scratch/simscale.ts`
  prints the per-pass breakdown at two, three and four miles for exactly this: a pass whose number
  grows faster than the vehicle count is doing something per-lane or per-portal.
- **Float32 in cost tables.** Route costs are `Float64Array` and lateral moves need to beat staying
  put by half a second. With float32 and a zero epsilon, two identical lanes differ by ~2e-6 and
  every vehicle decides it should change lanes, forever. This cost an afternoon.
- **Half-open arc-length intervals.** `segmentIndexForS` maps a vertex to its *outgoing* segment, so
  the answer never depends on the caller's search hint. Without that, two vehicles at the same
  position can disagree about their heading.
- **A lane change that reverses.** A mandatory change can interrupt a discretionary one going the
  other way, and restarting the lateral blend from zero re-anchors it on a lane the car never
  reached — it teleports a full lane width sideways. Carry the progress over mirrored instead;
  smoothstep is symmetric, so `1 - progress` lands exactly where the car already was. Interrupting a
  change with one in a *third* direction cannot be made continuous without a signed lateral offset,
  and a change is cancelled outright at a lane boundary; both are rare enough to live with, and
  `test/sim/pose.test.ts` bounds how often they may happen.
- **A route decision made at the boundary was never looked down.** Where the destination is not
  reachable from a lane at all, the routing field has nothing to say and `advise` returns no
  successor. Falling back to "the way the lane goes" only when the driver reaches the end means the
  leader look-ahead spent the whole approach seeing an empty road: the driver arrives at the
  connector at full speed, into whatever is queued on it, with nothing like enough road left to stop.
  They then drive straight through it — a 25 m overlap on a 30 m connector, on a lane whose list is
  correctly linked the whole time. Resolve the fallback in the routing pass instead, so the look-ahead
  can see down the connector the driver will actually take. `test/scenarios/junctions.test.ts` pins
  it on a five-way, where some destinations genuinely are unreachable from some approaches.
- **Stale state after a lane change.** Merge plan, chosen gap and cached next-edge all belong to the
  lane you were on. Clear them in `performChange` or a car that has just merged will brake for a lane
  end it is no longer on — and then be retired as "lost" at the end of a lane it could have driven
  off.
- **Cross-boundary neighbours.** A lane change near a lane boundary must look upstream *and*
  downstream past it. The lane's own linked list cannot see the car about to cross into it, and
  dropping in front of that car is exactly how a merge causes a collision.
- **The lag when you would be the leader.** With no vehicle ahead of your insertion point, the car
  behind you is the target lane's *head*, not its tail. Getting this backwards silently permits
  merges into occupied space.
- **Mutual standstill, and the clock that could not see it.** Two vehicles side by side, each easing
  off to let the other in, will hold each other forever. Gap alignment therefore never asks for less
  than a crawl — but a floor cannot break a symmetry, because both drivers get the same floor, and
  every escape hatch was keyed on `stoppedTime`, which only counts time below 0.3 m/s. Alignment
  holds at 0.8 and creeping at 2, so a deadlocked driver never registered as stopped and *none of the
  hatches could ever fire*. They crawled side by side for the best part of a minute with an empty
  road in front of them. `store.crawlTime` is the clock that sees it: time below `MERGE.crawlSpeed`
  **with a clear road ahead**, which is what distinguishes a driver held by the merge model from one
  held by the queue in front. It drives the give-ups, and the gap scorer stops preferring gaps
  *behind* once dropping back has stopped working — falling back needs you to be slower than the
  traffic beside you, while taking the gap in front is something you can do on your own, which is
  what actually breaks the tie. `test/scenarios/merge.test.ts` bounds the longest crawl-with-a-clear-
  road at 20 s; it was 45–80 s.
- **A rule written for a moving driver is often inverted for a stopped one.** Two of them here: the
  merge scorer's "don't drop back" and "don't want a gap you can't reach" both assume the driver can
  still choose their speed, and together they trap a driver who cannot. Whenever a rule reasons about
  what a driver will *do* to reach something, ask what it says to one who can no longer do anything.
- **A rule that is quietly doing a second job.** The speed-limit look-ahead used to bleed everybody's
  speed off over the whole approach to a junction, which was wrong on its own terms — and was also
  metering every junction in the network. Fixing it exposed a box-blocking hole that had been there
  all along and had never once been reached. Expect a fix to a pacing rule to surface whatever the
  pacing was hiding, and re-run `test/scenarios/signals.test.ts` at 1.3x when you touch one.
- **An escape hatch you cannot reach is not an escape hatch.** Three separate ones here were dead
  code for the same reason. When adding a timeout, check that the state it waits for is one the
  system can actually enter — and in particular that no floor elsewhere prevents it.
- **Cooperation must be sticky.** Re-deciding every tick which mainline driver yields to a merger
  means the gap never opens: the queue shuffles forward and a fresh driver inherits the job, over and
  over. Hold the commitment until the merger is in, gone, or already past.
- **A hand-wired gore owns its carriageway, through movements and all.** An override replaces the
  whole set — that rule is older than gores — so the moment the road's own lanes are on offer, the
  through movements have to be in the set too, and in the seed. They are written road-to-road, and
  the two halves of a split share a name, so which end is which comes from the side of the override
  they appear on rather than from the key. Leave them out of the seed and the first movement anybody
  adds deletes them: one shift-click, and the motorway stops at the gore.
- **Auxiliary lanes do not cross a joint.** Wiring lanes across a link or a split must filter them
  out first, or the cross-section mapping shifts by the number of auxiliary lanes and connects the
  wrong lanes — the failure looks like a downstream segment with no traffic at all.
- **Curvature from adjacent samples measures the sampling.** An adaptively flattened curve has wildly
  uneven point spacing, and the circumcircle through three nearly coincident points is numerically
  meaningless — one vertex out of fourteen claimed a 0.13 m radius on a connector whose median was
  34 m, and set the speed limit for all 27 m of it. Anything reading curvature off a sampled
  polyline to make a *decision* wants `maxCurvatureOver` and a baseline; `curvatureAt` is still
  right for the offsetter, which is asking about the samples themselves.
- **A vehicle placed too fast is not a following-model failure.** Every rule in `core/sim` assumes a
  driver arrived where they are by driving there. A spawned one did not, so the entry speed has to
  do the work the approach would have done: see the spawn rules above. And when you bound it, bound
  it against **every** successor — a short entry lane at a multi-arm junction has a fast way out and
  a slow one, and the driver takes the one the router picks, not the one that happens to be first.
- **A safety floor that fires on most of the traffic is a control strategy.** The "a rival that
  cannot physically stop is coming" rule reads as if it should obviously apply to committed rivals
  too. It does remove a class of collision, and saturated it costs a third of a junction's discharge
  rate, because nearly every committed driver is near its conflict point at speed. When a floor
  starts binding routinely, the thing that needs fixing is upstream of it — here, a junction the
  compiler should never have put on priority control.
- **GC churn**: any per-tick allocation in `core/sim` will eventually show up as frame hitches.
  Preallocate; reuse scratch buffers; note that a shared scratch object aliases if two call sites use
  it at once (`paramsOf` takes an `out` parameter for exactly this reason).
- **Float ordering**: never iterate over unordered maps in sim code; determinism dies quietly.
- **Two abutting fills leave a hairline.** Antialiasing gives each a half-covered pixel along the
  shared edge, and two half-covered pixels do not add up to one — the dark casing underneath shows
  through as a thin line across the road at every link and every split. Each segment's surface is
  pushed 0.1 m past its end cap so the two overlap instead of abutting.
- **Offsetting a polyline whose first two points coincide.** A zero-length opening segment has no
  normal, and the offsetter propagates the garbage into a long spike. Build extension points
  conditionally rather than writing a duplicate vertex and hoping.
- **A bay's flare belongs to one kerb, and one arm pays for one flare.** Both halves of that shipped
  wrong at once and they hid each other: the asphalt widened on both sides of the road while only
  one side's lanes moved, and the trim rule then charged every crossing arm for both flares. The
  measurements to make when touching this are the ones that found it — where the lane centrelines
  actually sit near the junction against where the asphalt edge sits (`scratch/scenecheck.ts` on a
  bayed junction), and the four-way priority scenario, which starves if its side road is trimmed
  two metres too far.
- **One runaway control point costs the whole compile.** A least-squares curve fit is
  unbounded on degenerate input, and the compiler believes what it is given: a 239 km
  handle became a 156 km junction connector, flattened to 39,169 points, and
  `addConflicts` spent five minutes on it. Compile went 82 s → 0.6 s from capping the
  handle. When a compile is inexplicably slow, look for one absurd piece of geometry
  before looking for an algorithm.
- **Every road end to every other is a square.** Portal demand was built pairwise, so
  an imported city's 3,289 ends made 1.4 million pairs — each asked whether it was
  reachable, each counted down every tick, nine milliseconds of a fourteen millisecond
  tick spent on pairs that never fire. Each end now takes a bounded set of
  destinations; the outflow is unchanged and a hand-drawn document is untouched,
  because its whole square already fits under the cap.
- **A driver placed behind a queue is not a following model failing.** Spawning
  matched the speed of the car in front *on the spawn lane* — and in a city the queue
  is usually on the next lane, a few metres past the junction. So drivers appeared at
  a hundred kilometres an hour forty metres behind a stationary car. That was almost
  every rear-end collision in an imported interchange: 70 → 18 from making the spawn
  look across the boundary.
- **A look-ahead bounded by lanes is not bounded by distance.** The leader search
  stopped after four lanes, which is 260 m on a drawn document and *seventy-five
  metres* on an imported city where a road is cut at every junction. The bound that
  means anything is the distance a driver needs to stop.
- **Two auxiliary lanes look symmetric and are not.** A stack from one ramp pairs off lane for lane;
  a stack from two *different* ramps overlapping is the case step 8 splits the road for. Fusion and
  outward stacking both have to compare like depth with like depth, or a two-lane on-ramp followed by
  a two-lane off-ramp fuses the wrong pair. And whether to fuse at all is a decision about the
  **stack**, taken once: the lanes in a stack are staggered, so a merge stack and a diverge stack can
  overlap at one depth and not the next, and fusing half a stack is worse than fusing neither. It
  produced a 282 m "blend" where every sibling was 36 m, and traffic that never recovered — mean
  speed 9 m/s with vehicles stopped for five minutes.
- **A junction's paint has to hand over to the road's, not merely end near it.** The gore's edge
  lines *are* the ramp's edge lines over the length of the blend, so the two must meet to well under
  a marking width. Half the connector width instead of half the ramp lane leaves an 18 cm step on
  stock profiles — more than a whole line width, on every ramp in the network, and it reads as one
  line jogging sideways rather than as two lines that do not meet.
- **A gore's two edge lines are mirror images.** Offsetting is relative to the direction the
  centreline is *stored* in, and a diverge connector is stored road-to-ramp while a merge connector
  is stored ramp-to-road. Read the direction backwards and both lines land down the middle of the
  ramp — invisible with a one-lane ramp, whose two lines sit symmetrically either side of the single
  movement anyway, and glaring the moment there are two.
- **A fresh override has to say some control, and it must be the junction's own.** Every command
  that creates a junction override on first touch writes a `control`, and the turn-lane command
  wrote `'priority'` — which switched an all-way stop to priority as a side effect of adding a turn
  bay. The panel lit the wrong button and the stop signs vanished from the map; a browser check
  found it, not the test suite, because the test junction happened to be priority already. Pass the
  compiled junction's control through, and pin it.
- **A canvas is a replaced element.** `position: absolute; inset: 0` leaves it at its intrinsic
  300x150 — the size has to be stated. This shipped once because the jsdom stub returned a
  1200x800 `getBoundingClientRect` regardless, so every test passed against a canvas the browser was
  actually drawing at 300x150. A stub that is more generous than the real thing hides exactly the
  bugs it was meant to catch. The jsdom stub now reports whatever CSS size a canvas was given and
  only falls back to the viewport for one that was laid out — the road previews state theirs.
- **`setPointerCapture` throws** for a pointer the browser is not tracking, and an exception in
  `pointerdown` takes the pan branch down with it. It is wrapped in a `try`.
- **The renderer must never mutate sim or network state.** If you need derived data, compute it in a
  compile step or a sim-side cache. There is a test.
- **Core has no environment, and Node is not the browser.** The non-negotiable says core never
  touches the DOM, and that half enforces itself: every core test runs under Node, where reaching for
  `document` throws. The other half does not. Two `process.env` switches went into `core/sim/junction.ts`
  as A/B toggles while a behaviour was being measured, and stayed. Under Node they are invisible —
  `process` exists, the branch is false, the tests pass. In a browser `process` does not exist, so
  **the first vehicle to reach a junction conflict point threw**, the animation frame died with it,
  and the whole application froze with a network on screen and a clock that had stopped. All 560
  tests were green. `test/core/portability.test.ts` now reads the source for this.
- **`flush()` tells only whoever called it.** Recompiling is a side effect the renderer depends on,
  and the baked `Path2D` tiles used to be rebuilt when *the frame loop's own* call to `store.flush()`
  returned true. Three places call it — the frame loop, the end of an interactive gesture, and a
  document swap — and only the first one there sees that answer. So opening a document recompiled the
  network, restarted the traffic, and left the **previous document's roads on screen** with the new
  one's vehicles driving over empty space, while the statistics panel read out the new network the
  whole time. Anything holding data baked from the network compares `store.compileVersion` instead.
- **A cover is not a fix, it is a place to hide one.** The junction "cover" painted the whole
  footprint over the markings to hide overlaps in the box — and a footprint reaches eight metres up
  every approach, so what it hid was the end of every road's paint. It was hiding nothing real: the
  segments are trimmed back, so nothing can reach the box. When something looks wrong under a layer
  of paint, measure what is under the paint before adding more of it.
- **Anything placed beside a road must be tested against its whole area, and against everything
  already placed.** Buildings shipped three ways wrong at once: corner-only road tests let a lane run
  through a building's middle; walking the asphalt outline fanned a terrace round every junction
  mouth, because the outline goes round the end caps; and two roads at a corner knew nothing about
  each other. The plot is the fix — disjoint intervals along one side of one road, held back past the
  junction radius, registered in a shared grid — and it is why nothing else needs to be careful.
- **Zoning is resolved once, onto the segment.** `Stroke.landUse` overrides `RoadProfile.landUse`,
  and the *segment* carries the answer. Read the profile in one consumer and the segment in another
  and you get a split brain: it shipped as a painted street that grew houses (the renderer read the
  segment) and generated no traffic at all (the zones read the profile). Nothing smaller than a
  stress town had both halves in view at once.
- **A rate of zero is an interval of infinity.** The spawner draws its next arrival from an
  exponential with the rate as its parameter, so a demand pair scaled to zero by the clock never
  wakes up again. The diurnal curve has a floor for exactly this reason, and the first arrival is
  primed from the rate *at the starting hour* — priming from the base rate empties an hour's traffic
  into the first minutes of a run that starts at 03:00, and the busiest hour of the day then appears
  to be whichever one the simulation began at.
- **A left-turner part-way across is not somebody else's problem.** A committed vehicle stops giving
  way as a matter of priority, which is right, but ignoring an *uncommitted* rival entirely is not:
  a driver still short of the conflict point has a choice, and one closing at 26 m/s with fifty
  metres to go has none. See the junction section. Still imperfect — an at-grade *priority* crossing
  with a big speed mismatch (110 km/h dual carriageway, 45 km/h street) still produces the odd
  collision, three on one seed in six over fifteen minutes, and that is the next thing to fix.
