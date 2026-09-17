# block-showroom

Tiered voxel object generator — an endless lattice of procedurally generated
"bimoblock" specimens.

## Run it

    npm run serve

then open <http://localhost:8000/>. The app uses ES modules, so it must be
served over HTTP — opening `index.html` directly from Finder will not work.

## Test it

    npm test

Runs the Node tests for the pure generation core. Requires Node 18+.

## Refactor status

See `refactorplan.md`.
