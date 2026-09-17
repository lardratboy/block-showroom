# block-showroom

Procedural "bimoblock" voxel specimens laid out on an endless 2D lattice,
rendered with Three.js. Entry is `index.html` → `src/main.js` (ES module);
being refactored into smaller modules per `refactorplan.md`.

## Commands

- `npm test` — Node unit tests for the pure core (`test/*.test.js`). Golden
  hashes in `test/golden.json` are the behavioural contract; they must stay
  green through every refactor step.
- `npm run test:browser` — headless-Chrome test (`test/browser/`): loads
  `#0,0,15.0,0` and `?workers=0#7,-3,12.0,3,7.-3.4`, waits for
  `showroomPerformance().installed > 0`, asserts the inspector text. ~20 s,
  Node 22+, no dependencies (DevTools protocol over built-in WebSocket).
  Skips if Chrome isn't installed. Its expected values are the reference
  values in `refactorplan.md`; change them only with an intended change.
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

- `createBimoblockCore()` is pure (no THREE, no DOM) and is shared with the
  module worker `src/core/worker.js`; keep it free of DOM/THREE imports.
- `src/types.js` holds JSDoc typedefs (`Recipe`, `Level`, `BlockData`,
  `Job`, …) with no runtime code; reference them with
  `@type {import('../types.js').X}` rather than duplicating shapes.
- Console diagnostics `showroomPerformance()` / `resetShowroomPerformance()`
  and URL params `?workers=0|1|2|4`, `?fullGeometry=1` are public surface.
- The URL hash is a permalink: `#i,j,height,gen[,pinI.pinJ.radius]`.
