# block-showroom

Procedural "bimoblock" voxel specimens laid out on an endless 2D lattice,
rendered with Three.js. Currently a single file (`block-showroom.html`);
being refactored into ES modules per `refactorplan.md`.

## Commands

- `npm test` — Node unit tests for the pure core (`test/*.test.js`). Golden
  hashes in `test/golden.json` are the behavioural contract; they must stay
  green through every refactor step.
- `npm run golden` — regenerates `test/golden.json`. Only run this when a
  change to specimen output is *intended*, and say so in the commit message.
- `npm run serve` — `python3 -m http.server 8000`; open http://localhost:8000/
  Required once the app uses ES modules (file:// will not work).

No bundler, no `node_modules`. Three.js r128 and Tween.js 18.6.4 come from cdnjs.

## Workflow rules

- Work on branch `refactor/modules`; never commit directly to `main`.
- One refactor phase per session. Read `refactorplan.md`, do the phase,
  run `npm test`, tick the boxes in the plan, then commit.
- Behaviour must not change during the refactor. If a golden test fails,
  the refactor step is wrong — fix the step, do not regenerate the goldens.
- The user is new to local development: explain what a command does before
  running it when it's non-obvious, and give exact browser URLs to check.
- Verification the user does in the browser: `test/smoke.md`.

## Architecture notes

- `createBimoblockCore()` is pure (no THREE, no DOM) and is shared with a
  Web Worker. Until Phase 2 the worker is built from `Function.toString()`
  of the core, so the core must stay a single self-contained function until
  the worker is converted to a module worker in the same commit.
- Console diagnostics `showroomPerformance()` / `resetShowroomPerformance()`
  and URL params `?workers=0|1|2|4`, `?fullGeometry=1` are public surface.
- The URL hash is a permalink: `#i,j,height,gen[,pinI.pinJ.radius]`.
