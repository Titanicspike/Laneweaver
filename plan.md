# Work plan

Living document. Each item: the symptom, what I think is wrong, and how I'll know it's fixed.
Ticked when implemented **and** covered by a test that fails without the fix.

## A. Correctness bugs

- [x] **A1. Turn-on-red delays traffic that has the right of way.** Three causes, all fixed:
      `claimant` only ever read the head of one feeding lane; a driver's *own* arrival was
      extrapolated at a 0.5 m/s floor so from a standstill they computed forty seconds to cross ten
      metres and pulled out; and the permission was granted on `TurnKind.Right`, which on an
      irregular junction can be a movement that sweeps the whole box (the five-way has one with
      eleven conflicts). Now: the movement must **cross nothing**, the driver must see room *beyond*
      the junction, and the acceptance is one-sided — clear well before anyone arrives, not merely
      non-overlapping. Green traffic blocked by a red movement on the five-way: 18.8 → 0
      vehicle-seconds.
- [x] **A2. Latent same-lane collision.** Not the urgency relaxation. The boundary look-back — the
      thing that stops a driver dropping into the head of a lane in front of traffic about to cross
      into it — looked exactly **one lane** upstream, and one lane is a count rather than a distance.
      A junction connector can be twenty metres long, so "the lane immediately upstream is clear"
      answered a question nobody asked: the driver closing at 28 m/s was one hop further back on the
      mainline, invisible. They then braked at the 6 m/s² emergency cap for the whole connector and
      still arrived inside the gap. The motorway corridor example produced it on **every seed tried**,
      two to six times in fifteen minutes. The look now carries on through *empty* lanes until it has
      covered ninety metres of road. Cost: missed exits on the off-ramp scenario went 0.09% → 0.41%,
      which is the same fact seen from the other side — thirteen drivers per ten runs who were taking
      a gap that was not there. `test/sim/boundary-lookback.test.ts`.
- [x] **A3. Lane starvation at merges.** The real cause was upstream of the merge model: a portal
      picked the entry lane by "most room", room is `Infinity` for an empty lane, and
      `Infinity > Infinity` is false — so every tie went to the first lane and **82% of traffic
      entered a three-lane freeway in the kerb lane**. Now chosen fairly among lanes with room.
      Deliberately *not* route-aware: lane costs differ by whole `LANE_CHANGE_COST` steps, so that
      turns a bias into a rule and puts every exit-bound driver in one lane from the moment they
      appear. `test/sim/spawn.test.ts`.
- [x] **A4. Nobody gives up in a jam.** Added `store.mergeWait`: seconds spent *asking for a
      mandatory change and being refused, while crawling*. Neither half alone works — a driver half a
      kilometre out is waiting for a decent gap rather than being refused one, and one moving freely
      is just being choosy — so the clock never runs in free flow and impatience can never cost an
      exit somebody would have made. Past `MERGE.patience` a driver stops aligning and takes what is
      there; past `MERGE.giveUpOnRoute`, on a lane that does not end, they give up and reroute.
      Longest stretch held by the merge model on a lane drop: 45.5 s → 14 s, throughput unchanged or
      better. Also added `store.hold` — which constraint is actually binding — because every previous
      attempt to measure this from speeds and gaps read a queue shuffling at 2 m/s as a clear road.
- [x] **A5. Intersection robustness.** Found by building the example maps, and it was not the
      junction geometry at all — it was **lane changes undoing themselves at 20 Hz**. The two halves
      of the model disagreed about the same lane: `advise` answers "which way from here", and its
      answer for a lane already on the route is "you need not move", so a discretionary drift *out*
      of that lane paid no route penalty; the mandatory half then ordered the driver back on the very
      next tick, because those are checked every tick and ignore the cooldown. On the town grid **91%
      of all lane changes were reversals and 47% undid themselves inside one second** — 415,000 lane
      changes in half an hour. Invisible in the merge scenarios, which are one segment of freeway with
      one ramp; it needs a junction to appear. A discretionary change now reads the target lane's own
      lateral plan and refuses outright inside the range where that plan would be urgent. Town: 415k
      changes → 20k, 47% → 0.3%. Merge suite unmoved. `test/sim/lane-stability.test.ts`.
- [x] **A6. Vehicles driving through each other at a crossing.** Found by the perf bench, the only
      thing in the suite with 5,000 vehicles and 300 conflict points. A committed vehicle stops
      giving way as a matter of priority — right — but it ignored an *uncommitted* rival **entirely**,
      however fast it was coming: a left-turner crawling across at 3 m/s with six metres to go and a
      through movement fifty metres out at 26 m/s, which needs fifty-five to stop. Now a kinematic
      floor rather than a yield, and it cannot freeze the junction because a vehicle that has reached
      the point returns long before that code runs. Bench: 3 collisions in forty simulated minutes →
      0, including one that predated this session. `test/sim/committed-crossing.test.ts`.
- [x] **A7. The application froze on any document with a junction.** Two `process.env` A/B switches
      left in `core/sim/junction.ts`. Under Node they are invisible; in a browser `process` does not
      exist, so the first vehicle to reach a conflict point threw, the animation frame died with it,
      and the app sat there with a network on screen and a stopped clock — with all 560 tests green.
      `test/core/portability.test.ts` reads core as text for this.
- [x] **A8. Opening a document left the old roads on screen.** The baked `Path2D` tiles were rebuilt
      only when *the frame loop's own* call to `store.flush()` returned true, and three places call
      it. So a document swap recompiled, restarted the traffic, and drew the previous document with
      the new one's vehicles over it — while the statistics panel read out the new network. Now keyed
      on `store.compileVersion`. `test/app/ui.test.ts`.

## B. Features I owed

- [x] **B1. Signal offset.** `SignalController.reset` winds each plan forward to where its offset
      says it should be, and `update` carries the overshoot so a plan cannot drift a tick a stage.
      Added `corridor()` and a **Green wave** button. Pinned by mean journey time along a
      three-signal arterial, which is the only measurement that means anything.
- [x] **B2. Actuated signals.** A green ends as soon as nobody is using it: minimum green, then gap
      out. The demand test is *routed* rather than presence — a car queued in the through lane says
      nothing about whether the left phase still has anybody to serve, and counting it makes every
      phase run to its maximum, which is a fixed plan wearing a detector. Busy road crossed by a
      quiet one: mean wait 52.1 s → 33.6 s, journeys 9% shorter, 92 more arrivals over five runs,
      zero collisions. **Off by default**, because a fixed cycle is the entire basis of a corridor
      offset and a green wave stops being true the moment the cycle depends on who turned up.
      `test/scenarios/actuated.test.ts`.
- [x] **B3. `pickStroke` ignores level.** Now prefers a road on the working level, falling back to
      any — a preference, not a filter, so clicking a lone bridge in Ground mode still selects it.
- [x] **B4. Added-lane control.** `addedLane: boolean` → `addedLanes: number`. A two-lane entrance
      has three sensible answers and a flag forced the middle one. Clicking a gore cycles 0..n.

## C. Broken UI

- [x] **C1. Road preview is wrong.** It derived lane dividers itself — "on the outer side of every
      lane but the outermost" — which holds only when a direction group sits wholly on one side of
      the centreline. A one-way road straddles it, so on **every** one-way profile the dividers were
      drawn outside the carriageway and a two-lane ramp came out a plain grey bar. Now it calls the
      same `groupSign`/`lanesOnSide` the compiler does.
- [x] **C2. UI collisions.** `input[type=range] { width: 100% }` inside a flex row resolves against
      the *row*, so the sliders demanded the full width and the labels ended up underneath them.
      Fixed, along with fixed-width text fields, 26 px stepper buttons, and a status line that
      ellipsed away the half of each tool hint explaining the modifier keys.

## D. New

- [x] **D1. Pre-made maps** — five: a **diamond interchange**, a **collector-distributor road**, a
      **signalised arterial**, a **motorway corridor** and a **town grid**. All compile with zero
      errors *and* zero warnings, run five minutes with no collisions, nothing lost and nothing
      failing to merge, and survive a save/load round trip. They are in the gallery too, so they get
      the same visual check as everything else — and they are what found A2 and A5, neither of which
      any hand-built fixture had ever shown.

      No trumpet and no cloverleaf, and it is worth saying why rather than pretending. Both are
      defined by ramps that *cross each other*; real ones settle that with a third level, and a
      hand-placed example settles it with coordinates I would be guessing at. Four ramps around a T
      took several attempts and still put two of them at grade through the mainline. The C-D road
      replaces it deliberately: four gores in two kilometres, which is the flagship manoeuvre four
      times over, in geometry that can be laid out exactly.
- [x] **D2. Spawn modes** — three, and they are different questions rather than three dials on one.
      `portals` is the old behaviour and the default. `gateways` restricts it to the ends the user
      marked, in the direction they marked them; an unmarked end is still `both`, so switching to it
      changes nothing until something is marked. `landuse` generates the town's own traffic: trips
      start *anywhere along* a residential road and finish at a commercial one, and nothing enters
      from off-map at all.

      The land-use mode needed real machinery: a **zone** is a routing destination like a portal,
      sharing the portals' id space so a destination stays one number everywhere; arriving at one is
      *reaching* one of its streets rather than driving off the end of the network; and a trip starts
      in the middle of a live lane, which is the first spawn here that has to check what is behind it
      as well as what is in front. Procedural **houses and shops** are baked beside the roads that
      carry a land use, by the same outline-walking method as the verge planting and sharing its
      "not on tarmac" test. `test/sim/spawn-modes.test.ts`, `test/render/buildings.test.ts`.

## E. Zoning, buildings and the clock

- [x] **E1. Buildings looked bad and were placed wrongly.** Rewritten as **plots**
      (`render/buildings.ts`), a pure function of the network so the audit and the tests can check
      every rectangle without a canvas. The old version scattered rectangles along the asphalt
      outline and was wrong three ways at once: the outline goes *round the end caps*, so terraces
      fanned across every junction mouth; the walk restarted its spacing on every 9 m edge of a
      flattened polyline, so two buildings could land on one vertex; and two roads at a corner knew
      nothing about each other. Corner-only road tests let a 3.5 m lane run through a 10 m building's
      middle. Now: disjoint intervals along one side of one road, held back past the junction radius,
      registered in a shared grid, and sampled across the whole footprint.
      *Looks:* varied roof palette, L-shapes and boxes, drives, front and back gardens, service yards
      behind shops, and a drop shadow cast in **one direction for the whole map** scaled by storeys.
      *Plot depth is probed*, not constant — two streets 40 m apart back onto each other, a street on
      the edge of town gets the full depth. `test/render/buildings.test.ts` (18 cases) plus two new
      audit checks over the whole zoo.
- [x] **E2. Zoning, like a city builder.** `Stroke.landUse` overrides `RoadProfile.landUse`, with a
      third state (`none`) so one street can be cleared without editing the road type everybody else
      shares. A **Zone tool (Z)**: pick Houses / Shops / Clear, drag along roads, one drag is one
      undo step. The overlay shows every road's *effective* zoning — inherited as well as painted —
      because a town built out of "residential street" has nothing painted, and showing only
      overrides would answer "nothing is zoned" when the honest answer is "all of it".
      `test/editor/zoning.test.ts`.
- [x] **E3. Time of day, and waves.** `settings.dayLength` compresses a day; two hourly curves in
      `core/sim/clock.ts` decide how much traffic there is and — in the land-use mode — which way it
      goes. Morning is 92% house-to-shop, evening 12%, so the two peaks are different pictures rather
      than the same one twice. HUD reads `07:22 · morning peak`; Day and Time steppers in the panel,
      and moving the clock does not restart the traffic. Two traps, both hit: a rate of zero is an
      interval of *infinity*, so the curve has a floor; and the first arrival must be primed from the
      rate at the starting hour, or a run beginning at 03:00 empties an hour into its first minutes
      and the busiest hour of the day is whichever one it started at. `test/sim/clock.test.ts`.
- [x] **E4. Zoning split brain.** Buildings read the *segment's* land use; zones still read the
      *profile's*. So a painted street grew houses and generated no traffic at all. Found by the new
      stress tool compiling 2,375 plots and zero zones — nothing smaller had both halves in view.

- [x] **E5. Cars appeared and vanished at the mouths of roads.** Arrivals used a fixed
      `min(30 m, half the lane)`, so **67% happened in the first fifth of the street and none past
      the middle** — a town's traffic vanishing at every corner, with the houses further down as
      scenery. The compiler now emits `Segment.frontages`, one shared list of addresses that the
      renderer puts plots on *and* the simulation starts and ends trips at. Arrivals now cover the
      whole street evenly and every one of them happens at a building that is drawn.
      `test/sim/addresses.test.ts`.
- [x] **E6. Junctions looked unfinished.** The junction "cover" painted the whole footprint over the
      markings — and a footprint reaches its own trim *plus the crossing road's width* up every
      approach, so it erased the last eight metres of every road's lane lines, median and edge lines.
      It was hiding nothing: segments are trimmed to the junction radius, so *zero* marking points
      fall inside any box across the whole zoo. Cover deleted, invariant checked in the audit
      instead. Junctions that stop their traffic — signals and all-way stops — also get **pedestrian
      crossings** now. `test/render/crossings.test.ts`.

## Measured this session

| | before | after |
|---|---|---|
| corridor example, collisions in 15 min | 2–6 every seed | 0 every seed |
| perf bench, collisions in 40 min | 3 | 0 |
| town grid, lane changes in 30 min | 414,922 | 20,388 |
| town grid, changes undone within 1 s | 47.0% | 0.3% |
| actuated junction, mean wait | 52.1 s | 33.6 s |
| sim tick at 5,000 vehicles | 3.05 ms | 2.31 ms |
| big town (9x9), buildings on roads / overlapping plots | — | 0 / 0 of 5,130 plots |
| big town, a full simulated day | — | 18,417 trips, 0 collisions, 0 lost |
| arrivals in the first fifth of a street | 67% | 22% |
| tests | 504 | 622 |

## Still open

- **Collisions at an at-grade priority crossing with a large speed mismatch.** A 110 km/h dual
  carriageway crossed by a 45 km/h street: three collisions on one seed in six over fifteen simulated
  minutes. A6 fixed the bench's version of this; this configuration still bites. Real junctions like
  it get signals or a bridge for the same reason, but the invariant here is zero.
- **Weaving-section polish** beyond the current fused auxiliary lane.
- **Roundabouts**, after the above.

## Ruled out

- **"Missed exits 5830" in the browser** was stale Vite HMR state — the tab had been running while
  source changed underneath it. Headless: 8 in 80 minutes at 250% demand, one per vehicle, no thrash.
- **Route-aware spawn entry.** Sounded better, measured worse: lane costs differ by whole
  `LANE_CHANGE_COST` steps, so it stops being a bias and becomes a rule.

## Notes

- Everything ships with a test that fails without it, self-tested by reverting the fix.
- `npm test`, `npx tsx scratch/audit.ts`, `npm run build`, `npm run bench`, `scratch/simcheck.ts`
  all green before calling anything done.
