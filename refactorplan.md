# Refactor plan: `block-showroom.html` → ES modules + classes

Goal: turn the single 2,894-line file into a small set of ES modules with clear
ownership, **without changing behaviour**. The lattice is deterministic
(same address + generation ⇒ same specimen), so "no behaviour change" is
checkable, not just hoped for.

Guiding rules for every step:

1. The app runs and looks identical at the end of every step. No step leaves
   it broken overnight.
2. One step = one commit on a branch (`refactor/modules`). Small diffs, easy
   to bisect.
3. Cut along the seams the file already has (its `/* ===== SECTION ===== */`
   headers). Don't redesign while moving. Redesign is Phase 4, after the
   pieces are separated.
4. Pure code stays functions; stateful code becomes classes. Don't wrap
   `clamp()` in a class just because.

---

## 0. What's in the file today

| Lines | Section | Depends on | Owns mutable state |
|---|---|---|---|
| 7–189 | CSS | – | – |
| 190–266 | HTML markup (HUD, panels, sliders) | – | – |
| 279–1021 | **`createBimoblockCore()`** — Oh group, envelopes, fields, tier cascade, voxel packing, `meshArrays`, `buildBlock`, `autOrder` | nothing (no `THREE`, no DOM) | none — pure |
| 1022–1063 | Core consumption, `symmetryLabel`, `geometryFromArrays`, `Levels`, `TierSymmetry` | Core, THREE | `Levels`, `TierSymmetry` |
| 1064–1166 | Showroom constants: `CFG`, `ROLES`, `Axis`, `Filter`, `Mint`, `hash32`, `cellParams` | Core | `Axis`, `Filter`, `Mint` |
| 1167–1261 | Sibling districts: `Pin`, `cellRecipe`, `lodOf` | above | `Pin` |
| 1262–1406 | Scene: renderer, camera, lights, floor shader, pods, rings | THREE, CFG | scene objects |
| 1407–1458 | Camera rig: `Rig`, `applyRig`, `groundAt`, `ndcOf` | camera, CFG | `Rig` |
| 1459–1653 | Virtualisation: `cache`, `slots`, `spare`, `computeVisible`, `evict` | Rig, CFG, Pin | `cache`, `slots`, `visible` |
| 1584–1873 | Generation: `runNumericJob`, `bimoblockWorkerMain`, `Perf`, `Generation` pool, worker lifecycle, `serviceGeneration`, `flushLattice` | core source text (!), cache | `Generation`, `Perf` |
| 1874–2031 | Per-frame `layout()` — instancing, frustum, tweens | everything above | `podCount` |
| 2032–2085 | Floor labels (2D canvas overlay) | Rig, visible | `labelsDirty`, `labelPose` |
| 2086–2191 | State / focus / HUD: `State`, `Bloom`, `Focus`, `Hover`, toast, inspector, legend, `pinAt`, `setFocus` | cache, DOM | `Focus`, `Hover`, `State`, `Bloom` |
| 2192–2325 | Pointer/wheel/keyboard navigation, `zoomBy`, `glideTo` | Rig, Focus | `pointers`, `dragMode` |
| 2326–2363 | URL hash permalink | Rig, Mint, Pin, Bloom | `hashTimer` |
| 2364–2453 | Controls: selects, sliders, `setAxis`, `applyConfiguration` | Axis, Filter, CFG | – |
| 2454–2711 | Levels editor (tier rows, presets) | Levels, TierSymmetry | – |
| 2712–2810 | OBJ exporters | cache, Focus, visible | – |
| 2811–2892 | Main loop `frame()` | everything | `clock`, `fps` |

Diagnostics exposed on `window`: `showroomPerformance()`,
`resetShowroomPerformance()`. Query params: `?fullGeometry=1`, `?workers=0|1|2|4`.
These are part of the public surface — keep them working.

### The one structural hazard

`startGeneration()` (line 1738) builds the worker script by concatenating
`createBimoblockCore.toString()`, `runNumericJob.toString()` and
`bimoblockWorkerMain.toString()` into a Blob URL. This only works because the
core is a single self-contained function with no free variables. The moment
the core becomes a module with `import`/`export`, `toString()` stops
producing runnable code. **Phase 2 must convert the core and the worker in the
same commit.**

### Decision: buildless ES modules + import map (recommended)

Options:

- **A. Buildless ESM + `<script type="importmap">`** for `three` and
  `@tweenjs/tween.js` from cdnjs. Zero tooling, matches the current
  "one folder, open it" feel. Cost: must be served over HTTP (`file://`
  blocks module scripts and module workers in Chrome). `python3 -m http.server`
  or `npx serve` is enough.
- **B. Vite.** Adds `package.json`, `node_modules`, a build step, but gives
  HMR, npm `three`, and a single-file production bundle if you want to keep
  shipping one `.html`.

Plan assumes **A**. Every module is written so that switching to B later is
just adding `package.json` and changing the import map to npm specifiers —
no source changes.

---

## 1. Target layout

```
block-showroom/
├── index.html                # markup + importmap + <script type="module" src="src/main.js">
├── styles.css
├── src/
│   ├── main.js               # composition root: builds every object, starts the loop
│   ├── config.js             # CFG, ROLES, ROLE_BY_ID, GROUP_COLORS, TAU, PRESETS, MAX_R
│   ├── core/
│   │   ├── bimoblock-core.js # createBimoblockCore() verbatim, plus `export default` and named exports
│   │   ├── worker.js         # module worker: imports core, runs runNumericJob
│   │   └── jobs.js           # runNumericJob (shared by worker and main-thread fallback)
│   ├── lattice/
│   │   ├── recipe.js         # hash32, cellParams, cellRecipe, lodOf, symmetryLabel, specimenChiral
│   │   ├── district.js       # Pin state + pinAt/unpin/inDistrict/axisDelta
│   │   └── generation.js     # class GenerationPool — worker pool, queue, Perf hooks, flushLattice
│   ├── scene/
│   │   ├── scene.js          # class Showroom Scene: renderer, camera, lights, floor, pods, rings
│   │   ├── floor-shader.js   # FLOOR_VERT / FLOOR_FRAG strings
│   │   ├── rig.js            # class CameraRig: x,z,h,tilt,yaw,vx,vz + applyRig, groundAt, ndcOf, glideTo, zoomBy
│   │   ├── virtualiser.js    # class Virtualiser: cache, slots, spare, computeVisible, evict, takeMesh
│   │   ├── layout.js         # layout(t, dt) — per-frame instancing
│   │   └── labels.js         # class LabelOverlay
│   ├── ui/
│   │   ├── hud.js            # class Hud: status, toast, inspector, legend, coord readout
│   │   ├── controls.js       # class Controls: selects, sliders, buttons, keyboard
│   │   ├── levels-editor.js  # class LevelsEditor
│   │   ├── input.js          # class Navigation: pointer/wheel/pinch/drag
│   │   └── permalink.js      # readHash/writeHash/commitHash
│   ├── export/
│   │   └── obj.js            # exportSpecimenOBJ, exportSheetOBJ, download
│   ├── state.js              # ShowroomState: Axis, Filter, Mint, Levels, TierSymmetry, Focus, Hover, Bloom, State
│   └── perf.js               # Perf diagnostics; installs window.showroomPerformance
├── test/
│   └── core.test.js          # node --test: determinism + geometry invariants
└── refactorplan.md
```

Not every leaf needs to exist on day one. `state.js` is deliberately a plain
object at first — a single place the globals live — and only grows methods
where they earn it.

---

## 2. Phases

### Phase 0 — Safety net (before touching any code)

- [x] `git checkout -b refactor/modules`
- [x] Decide how the app is served locally and write it down (README):
      `python3 -m http.server 8000` → `http://localhost:8000/`.
- [ ] Capture a **baseline**: open the app, note the default permalink hash,
      take screenshots at 2–3 addresses (`#0,0`, `#7,-3`, one with a bloom pin),
      and run `showroomPerformance()` in the console; save the JSON to
      `test/baseline-perf.json`.
- [x] Write `test/core.test.js` **against the monolith** by extracting
      `createBimoblockCore` with a script (or temporarily copying it). Tests:
      - `buildBlock(recipe, levels)` for 5 fixed recipes produces a fixed
        `filled` count and a fixed FNV hash of `occ`. Record the hashes now;
        they are the golden values for the whole refactor.
      - `meshArrays` output lengths are consistent (`pos.length/3 === nrm.length/3`, `idx` max < vertex count).
      - `autOrder` matches known values for a symmetric and an asymmetric specimen.
- [x] Add `test/smoke.md`: a 10-line manual checklist (drag, wheel, shift-orbit,
      click focus, `[ ]`, A/B/L/K/G/H/C/O/E, preset buttons, permalink reload,
      `?workers=0`).

Exit criterion: golden hashes committed; smoke checklist passes on `main`.

### Phase 1 — Split the file, no logic change

- [x] `index.html`: markup only. Move CSS to `styles.css`.
- [x] Replace the two CDN `<script>` tags with an import map:
      ```html
      <script type="importmap">
      { "imports": {
          "three": "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js",
          "@tweenjs/tween.js": "https://cdnjs.cloudflare.com/ajax/libs/tween.js/18.6.4/tween.esm.js"
      } }
      </script>
      <script type="module" src="src/main.js"></script>
      ```
- [x] `src/main.js`: the whole `<script>` body verbatim, with
      `import * as THREE from 'three'` and `import TWEEN from '@tweenjs/tween.js'`
      at the top. Fix the only thing that breaks: module scope means
      top-level `function`/`const` are no longer on `window`; anything the
      HTML or console relied on being global (`showroomPerformance`) is
      already assigned to `window` explicitly — verify nothing else was.
- [x] Verify: smoke checklist, `showroomPerformance()` still works,
      `?workers=0` and default both work. (The Blob worker still works here
      because the core is still a plain function inside `main.js`.)

Exit criterion: three files, identical behaviour, one commit.

### Phase 2 — Extract the pure core and convert the worker (one commit)

- [x] `src/core/bimoblock-core.js`: move `createBimoblockCore` verbatim.
      `export function createBimoblockCore(){…}` and
      `export const Core = createBimoblockCore()` for the main thread.
- [x] `src/core/jobs.js`: `export function runNumericJob(core, job)`.
- [x] `src/core/worker.js`:
      ```js
      import { createBimoblockCore } from './bimoblock-core.js';
      import { runNumericJob } from './jobs.js';
      const core = createBimoblockCore();
      self.onmessage = ({ data: job }) => { /* body of bimoblockWorkerMain */ };
      self.postMessage({ ready: true });
      ```
- [x] In `startGeneration()`: delete the Blob/`toString` construction; replace
      `new Worker(Generation.sourceURL)` with
      `new Worker(new URL('./core/worker.js', import.meta.url), { type: 'module' })`.
      Keep the try/catch and the `'compatibility'` fallback — it now covers
      browsers without module workers.
- [x] Point `test/core.test.js` at the real module; delete the extraction
      hack. `node --test test/` must pass with the golden hashes.
- [ ] Verify: worker path (default) and main-thread path (`?workers=0`) both
      produce identical specimens at the same address (compare inspector
      `aut` and `filled`).

Exit criterion: core tested in Node; worker is a real file; Blob code gone.

### Phase 3 — Extract stateless / leaf modules (one commit each)

Order chosen so each extraction only imports things already extracted.

- [x] `config.js` — `CFG`, `ROLES`, `ROLE_BY_ID`, `GROUP_COLORS`, `GROUP_RGB`,
      `TAU`, `MAX_R`, the preset table from the levels editor, `clamp/imod/idiv`.
- [x] `state.js` — export the plain objects `Axis`, `Filter`, `Mint`, `Pin`,
      `Focus`, `Hover`, `Bloom`, `State`, and `let`-bindings `Levels`,
      `TierSymmetry` wrapped in an object so they can be reassigned across
      modules (`export const Tier = { levels: [...], symmetry: false }`).
      This commit is mostly a find-and-replace of `Levels` → `Tier.levels`.
- [x] `lattice/recipe.js` — `hash32`, `cellParams`, `cellRecipe`,
      `symmetryLabel`, `specimenChiral`, `geometryFromArrays`, `blockGeometry`,
      plus `cellWorldX/Z`. `lodOf` stayed in `main.js`: it books `cacheBytes`,
      so it belongs to the virtualiser (Phase 4), not to a stateless module.
- [x] `scene/floor-shader.js` — the two GLSL strings.
- [x] `export/obj.js` — exporters. They need `cache`, `Focus`, `visible`;
      pass them as parameters for now (`exportSpecimenOBJ({ cache, focus })`).
- [x] `ui/permalink.js` — `readHash/writeHash/commitHash/hashString`. Same
      parameter-passing approach.
- [x] `perf.js` — `Perf` object and the `window.*` install. `snapshot()`
      merges an app-state probe that `main.js` registers; output shape unchanged.

Exit criterion: `main.js` is down to scene, rig, virtualiser, generation,
layout, labels, HUD, input, controls, levels editor, loop.

### Phase 4 — Introduce classes for the stateful pieces

This is where design happens. Each class gets the state it owns as fields and
receives its collaborators through the constructor. No class reaches for
another via a global.

- [ ] `scene/rig.js` — `class CameraRig { constructor(camera, cfg) … apply(), groundAt(), ndcOf(), glideTo(), zoomBy(), get cellI/cellJ }`.
      Replaces the `Rig` object and the `_ray/_v2/_hit` scratch vectors.
- [ ] `scene/scene.js` — `class ShowroomScene` owning renderer, scene, camera,
      lights, floor, pods, rings, `blocksG`, `resize()`.
- [ ] `scene/virtualiser.js` — `class Virtualiser { cache, slots, spare, visible, visKeys; computeVisible(rig), evict(), takeMesh(), releaseSlot(), keyOf() }`.
- [ ] `lattice/generation.js` — `class GenerationPool { constructor(virtualiser, perf, { workerCount, forceFullGeometry }) ; start(), suspend(), resume(), invalidate(paused), service(), flush() }`.
      Also owns the `pagehide/pageshow` listeners.
- [ ] `scene/labels.js` — `class LabelOverlay { constructor(canvas, rig, virtualiser) ; markDirty(), resize(), draw() }`.
- [ ] `ui/hud.js` — `class Hud` for status/toast/inspector/legend/coord, with
      timers ticked from the loop (`hud.tick(dt)`).
- [ ] `ui/input.js` — `class Navigation` for pointer map, drag modes, pinch,
      keyboard; emits nothing, just mutates the rig and calls `onMoved()`.
- [ ] `ui/controls.js` and `ui/levels-editor.js` — classes that bind DOM
      elements in the constructor and take callbacks (`onConfigurationChange`).
- [ ] `scene/layout.js` — stays a function: `layout(t, dt, { rig, virtualiser, scene, state })`.
- [ ] `main.js` becomes a ~120-line composition root: construct everything,
      wire callbacks, `readHash()`, start `frame()`.

Rule of thumb for what goes in a constructor vs. a method parameter:
long-lived collaborators (scene, rig, virtualiser) → constructor; per-frame
values (`t`, `dt`) → parameters.

Exit criterion: no top-level `let` in `main.js` except the loop's clock; every
mutable object has exactly one owner; smoke checklist and Node tests pass.

### Phase 5 — Optional hardening (only if wanted)

- [ ] JSDoc `@typedef` for `Recipe`, `Level`, `BlockData`, `Job` so editors
      give completion without a TypeScript build.
- [ ] Move `three` / tween to npm + Vite; add `vite build` to produce a
      single-file bundle if a one-file deliverable still matters.
- [ ] Browser-level test with Playwright: load `#0,0`, wait for
      `showroomPerformance().installed > 0`, assert inspector text.

---

## 3. Verification after every step

1. `node --test test/` — golden hashes unchanged.
2. Serve, open `http://localhost:8000/#0,0,15.0,0` — compare inspector text
   (`aut`, `filled`, group) against the baseline screenshot.
3. Walk `test/smoke.md`.
4. `?workers=0` vs default — same specimen at the same address.
5. `showroomPerformance()` — `installed` grows, `discarded` stays near
   baseline, no long-frame regression > 2×.

---

## 4. Known risks

| Risk | Mitigation |
|---|---|
| `file://` no longer works after Phase 1 | Document the HTTP server in README; Phase 5 bundle restores a single file if needed |
| A `toString()`-serialised function silently references an outer variable once the core moves | Phase 2 Node tests run the core outside the browser — any free variable throws immediately |
| `let Levels` reassignments scattered across sections | Phase 3 wraps in `Tier.levels`; grep for `Levels =` to find every write |
| Module scope hides a global the HTML relied on | Phase 1 explicitly audits `window.` / inline handlers (there are none in the markup today — all binding is via `getElementById`) |
| Worker fails to load as a module on an old browser | Existing `'compatibility'` fallback path already runs jobs on the main thread |
| Import-map CDN goes down | Phase 5 npm move; or vendor `three.module.js` into `vendor/` |

---

## 5. Working this plan with Claude

- One phase per session. Start with: "Do Phase 2 of @refactorplan.md. Stop and
  show me the diff before committing." Then `/clear` before the next phase.
- Ask for verification, not just changes: "run the Node tests and serve the
  app and confirm the inspector shows the same values at #0,0".
- Tick boxes in this file as steps land so the next session picks up where the
  last one stopped.
