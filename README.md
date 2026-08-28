# Laneweaver

A free-form micro-traffic simulator. Draw roads as bezier strokes anywhere on an infinite canvas;
crossings, ramps and lane drops are detected and compiled into a working lane network automatically,
and a microscopic traffic model runs on top of it.

The thing it is actually built around is **merges**. On-ramps, off-ramps, lane drops and weaving
sections are where most traffic sims fall apart — cars stop dead at the end of an acceleration lane,
or teleport into the mainline, or gridlock. Here they get real acceleration lanes, seek gaps and
match speed to slot into them, and the mainline cooperates. It is measured over ten seeds of ten
simulated minutes per scenario and compared against a control run of the same road with no ramp, so
"the merge works" is a number rather than an opinion.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # 288 tests
npm run typecheck
npm run bench      # performance smoke test, ~100 s
npm run build      # production bundle
```

The app opens on a demo network: a freeway with an on-ramp and an off-ramp, an arterial crossing it
on a bridge, and a few streets. Press **Space** to start the traffic.

## Controls

| | |
|---|---|
| **V** | Select — drag points and handles, drag the body to move, box-select empty space |
| **R** | Draw a road — click to place points, drag while placing to curve |
| **X** | Bulldoze |
| **J** | Junctions — click one to cycle priority / all-way stop / signals |
| **U** | Underlay — position a dropped image |
| **Space** | Run / pause the traffic |
| **F** | Fit the view |
| **Tab** | While drawing or with a selection: cycle ground / bridge / tunnel |
| **Enter / Esc** | Finish / abandon the road being drawn |
| **Alt-click** | Add or remove a control point on a selected road |
| **Shift** | Snap to 15°, or keep the aspect ratio while scaling an underlay |
| **Ctrl+Z / Ctrl+Shift+Z** | Undo / redo |
| **Ctrl+S** | Save |

Middle-drag or Alt+Shift-drag pans; the wheel zooms about the cursor. Drop an image on the canvas to
trace over it, or a `.json` file to open it.

### Drawing a ramp

There is no ramp tool. Pick a ramp road type, draw a road out from wherever you like, and drop its
last point on a freeway's edge — the end snaps to the edge and the compiler works out whether that is
a merge or a diverge from which way the traffic flows. It then grows the freeway an acceleration or
deceleration lane, tapers it, and wires the connectors. An on-ramp followed closely by an off-ramp
fuses into a single weaving lane.

## How it fits together

```
Edit model  ──►  Network compiler  ──►  Lane graph  ──►  Simulation
(strokes,        (flatten, split,       (lanes,          (routing, IDM,
 profiles)        junctions, lanes)      connectors,      MOBIL, merges,
                                         conflicts)       signals)
                          │                                   │
                          └────────────►  Renderer  ◄─────────┘
```

One way, no back edges. Only the edit model is ever saved; everything downstream is derived and
rebuilt by `compile()`. The simulation core is headless — no DOM, no canvas — so all of it runs and
is tested under Node.

A few decisions worth knowing before reading the code:

- **Sample, don't solve.** Every geometric question is answered on flattened polylines with a 0.15 m
  tolerance. No analytic curve offsets, no bezier–bezier intersection. This is why there is no bezier
  library in `package.json`.
- **Road lanes and junction connectors are the same type.** One flat shape keeps the simulation's
  property access monomorphic.
- **Lanes of a segment share their parent's arc-length parameterisation.** That is what lets a car on
  a ramp compare itself against traffic on the mainline exactly, with no projection at run time — the
  single most useful invariant in the codebase.
- **Routing is a potential field, not a search.** One backward Dijkstra per destination; vehicles read
  the gradient each tick and carry no route.
- **Determinism is a hard requirement.** Fixed 20 Hz step, seeded RNG threaded explicitly, stable
  iteration order. Same seed in, same run out — asserted by hash.

`CLAUDE.md` is the full architecture document, including the merge model in detail, the acceptance
criteria, and a list of the tarpits that cost the most time.

## Performance

On a mid-range laptop, with 5,000 vehicles on a synthetic network of 287 km of lane:

| | |
|---|---|
| Compile | 80 ms |
| Simulation tick | 3.5 ms median (budget 6 ms) |
| Street-level frame | 1.7 ms |
| Heap growth over 2,000 ticks | none measurable |

Vehicle state is structure-of-arrays in typed arrays and the per-tick hot loops allocate nothing.
`npm run bench` asserts all of the above and prints a per-pass breakdown.

## Licence

MIT.
