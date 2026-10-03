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

    npm run test:browser

Loads the app in headless Chrome and checks that the specimen at a fixed
address builds with the expected inspector values — with workers and on
the `?workers=0` fallback path. Takes about 20 s. Needs Node 22+ and an
installed Google Chrome (set `SHOWROOM_CHROME=/path/to/chrome` if it is
somewhere unusual); it skips itself if none is found. No `npm install`.

## Screenshot

![Screenshot](https://github.com/lardratboy/block-showroom/blob/main/images/window.jpg?raw=true)
![Screenshot](https://github.com/lardratboy/block-showroom/blob/main/images/window2.jpg?raw=true)
