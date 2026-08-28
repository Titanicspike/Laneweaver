# scratch — visual verification, dev only

Not shipped, not in `npm test`. Most of the defects this project has shipped were
visual, and a screenshot at a time is not a way to find them.

- **`cases.ts`** — the scenario zoo. Every ramp shape at one and two lanes into two,
  three and four-lane freeways; weaves; lane drops; crossings straight, skew, curved,
  wide-into-narrow, five-way and pairs of junctions close together; plus the demo
  document and all five shipped example maps — those are what a user opens first, so
  a fault in one of them is a fault the user sees first. Each case carries the
  framing (`at`, `zoom`) that shows the thing it exists to show; a case with `zoom: 0`
  is asking to be fitted, which is the right answer for anything whose extent is not
  known up front.
- **`../gallery.html`** (+ `gallery.ts`) — every case drawn with the *real* renderer
  into a grid. Run `npm run dev` and open `/gallery.html`.
  Query parameters: `?only=<substring>` (one substring, not a list), `?zoom=`,
  `?at=x,y`, `?wide=1`, `?h=<px>`, `?run=<seconds>` to run the simulation first, and
  `?v=<n>` to bust the cache.

  Editing source while a tab is open triggers Vite's hot reload, which resets the
  document underneath whatever you were looking at. Hard-refresh before reading
  anything off a tab that has been open across an edit — a stale tab has reported
  numbers that sent this project chasing a bug that did not exist.
- **`audit.ts`** (`npm run audit`) — the same zoo checked numerically for the things
  that show up as visual faults. Reports zero on every case; when adding a check,
  break the compiler on purpose first and confirm the check fires.
- **`simcheck.ts`** — runs every case for four minutes and reports collisions, lost
  vehicles, missed exits and stalls. `npx tsx scratch/simcheck.ts [demandScale]`.
- **`list.ts`** — one line per case: segments, junction kinds, diagnostics.
