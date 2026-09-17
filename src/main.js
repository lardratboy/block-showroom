/* =====================================================================
   SHOWROOM — AN ENDLESS 2D LATTICE OF BIMOBLOCKS
   ---------------------------------------------------------------------
   The Droste ladder made depth the axis of exploration: one strip of
   specimens, seen again and again at every scale.  This layout trades
   that for breadth.  Every integer pair (i,j) in Z^2 names exactly one
   bimoblock, forever, and the viewer walks around inside the catalogue.

   Three properties make the roaming worth doing:

   1. ADDRESS IS IDENTITY.  A cell's parameters are a pure function of
      its coordinate and the master generation counter.  Nothing is
      stored, nothing drifts; leave a district and come back an hour
      later and the same specimen is standing on the same pod.

   2. THE AXES MEAN SOMETHING.  Each axis is assigned a role -- an
      enumeration it walks through cell by cell.  With X=archetype and
      Y=symmetry the lattice becomes a contact sheet twelve wide and ten
      tall, and the *page* you are standing on (the quotient of the
      coordinate by the role's period) supplies the shared seed.  So a
      row is one field realisation sculpted by ten different subgroups,
      and stepping one page right hands you a fresh seed and the whole
      table again.  Set both axes to 'free' and it is pure roam.

   3. ONLY THE NEIGHBOURHOOD EXISTS.  Cells are generated on demand
      by a bounded worker pool, nearest first, cached with LRU
      eviction, and drawn from a recycled mesh pool.  The lattice is
      unbounded; the working set is a couple of hundred blocks.

   This file is the composition root: it constructs every object, wires
   the few operations that span several owners, and runs the frame loop.
   Shared settings live in state.js; each stateful piece is a class in
   scene/, lattice/ or ui/.
   ===================================================================== */
import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import { Core } from './core/bimoblock-core.js';
import { CFG } from './config.js';
import { Pin, State, Bloom, Focus } from './state.js';
import { symmetryLabel } from './lattice/recipe.js';
import { GenerationPool } from './lattice/generation.js';
import { ShowroomScene } from './scene/scene.js';
import { CameraRig } from './scene/rig.js';
import { Virtualiser } from './scene/virtualiser.js';
import { LabelOverlay } from './scene/labels.js';
import { layout } from './scene/layout.js';
import { Hud } from './ui/hud.js';
import { Navigation } from './ui/input.js';
import { Controls } from './ui/controls.js';
import { LevelsEditor } from './ui/levels-editor.js';
import { readHash, writeHash, tickHash } from './ui/permalink.js';
import { Perf, installPerformanceDiagnostics } from './perf.js';

const { ARCH_NAMES } = Core;

/* ---- diagnostics switches (public surface, see README) --------------- */
const perfOptions = new URLSearchParams(location.search);
const forceFullGeometry = perfOptions.get('fullGeometry') === '1';
const requestedWorkers = perfOptions.has('workers') ? Number(perfOptions.get('workers')) : null;
const workerCount = [0,1,2,4].includes(requestedWorkers) ? requestedWorkers
  : (navigator.hardwareConcurrency >= 4 ? 2 : 1);

/* ---- construction ------------------------------------------------------ */
const stage = new ShowroomScene(document.getElementById('stage'));
const rig = new CameraRig(stage.camera, stage.domElement);
const virtualiser = new Virtualiser(rig, stage.blocksG);
const pool = new GenerationPool(virtualiser, rig, { workerCount });
const labels = new LabelOverlay(document.getElementById('labels'), rig, virtualiser);
const hud = new Hud(virtualiser, pool, rig);

/* ---- operations that span several owners ------------------------------ */

/* The recipe for every cell changed (axes, filters, generation, tiers…):
   drop everything and mint again. */
function flushLattice(){
  pool.invalidate(false);
  virtualiser.flush();
  hud.refreshInspector();
}

function debounce(fn, ms){
  let h = 0;
  return (...a) => { if (h) clearTimeout(h); h = setTimeout(() => { h = 0; fn(...a); }, ms); };
}
/* A slider or the levels editor changed the recipe: stop generation now,
   and rebuild once the input settles. */
const commitConfiguration = debounce(() => flushLattice(), 200);
function applyConfiguration(){ pool.invalidate(true); commitConfiguration(); }

/* Pinning reads the anchor's traits out of the cache, so what blooms is
   the specimen actually on screen -- including one that is itself a
   cousin from an earlier bloom.  If the cell has not been minted yet the
   request is parked and retried, which is what makes 'warp then bloom'
   work without a stall. */
function pinAt(i, j){
  const p = virtualiser.at(i, j);
  if (!p){ Pin.want = { i, j }; return false; }
  Pin.params = { sym:p.sym, arch:p.arch, field:p.field,
                 lift:p.lift, density:p.density, seed:p.seed };
  Pin.i = i; Pin.j = j; Pin.on = true; Pin.epoch++;
  Pin.want = null;
  virtualiser.invalidate();
  hud.refreshInspector();
  return true;
}

function unpin(){
  if (!Pin.on) return;
  Pin.on = false; Pin.want = null; Pin.epoch++;
  virtualiser.invalidate();
  hud.refreshInspector();
}

function setFocus(i, j, announce){
  labels.markDirty();
  Focus.i = i; Focus.j = j;
  if (Bloom.on) pinAt(i, j);
  hud.refreshInspector();
  if (announce){
    const p = virtualiser.at(i, j);
    hud.showToast(p ? `${i}, ${j} · ${ARCH_NAMES[p.arch]} · ${symmetryLabel(p)}` : `${i}, ${j}`);
  }
  writeHash();
}

/* ---- input ----------------------------------------------------------- */
const controls = new Controls({ rig, virtualiser, hud, labels,
  actions: { setFocus, pinAt, unpin, flushLattice, applyConfiguration } });
new LevelsEditor({ setStatus: text => hud.setStatus(text), onChange: applyConfiguration });
const nav = new Navigation(rig, {
  onFocus: (i, j) => setFocus(i, j, true),
  onOrbit: () => controls.setTiltSlider()
});

window.addEventListener('resize', () => {
  stage.resize();
  labels.resize();
  virtualiser.invalidate();
});

// Console diagnostics (perf.js); the probe supplies this app's live fields.
installPerformanceDiagnostics(() => ({
  pendingUploads:[...virtualiser.slots.values()].filter(s => s.awaitingUpload).length,
  workers:pool.liveWorkers, mode:pool.mode,
  pending:pool.pending.size, readyResults:pool.results.length,
  readyBytes:pool.results.reduce((n,r) => n + r.bytes, 0),
  reservedBytes:pool.pool.reduce((n,s) => n + (s.job ? s.job.estimate : 0), 0),
  residentBytes:virtualiser.cacheBytes, cacheOverBudget:virtualiser.cacheBytes > CFG.CACHE_BYTES,
  visible:virtualiser.visible.length, missing:virtualiser.visible.filter(c => !virtualiser.cache.has(c.key)).length,
  drawCalls:stage.renderer.info.render.calls, triangles:stage.renderer.info.render.triangles
}));

/* ---- start ----------------------------------------------------------- */
if (!readHash({ rig, setFocus, onBloom: () => controls.syncBloomUI() })) setFocus(0, 0, false);
rig.apply();
virtualiser.computeVisible();
pool.start();

const clock = new THREE.Clock();
function frame(){
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  Perf.frame(rawDt * 1000);
  const dt = Math.min(rawDt, 0.05);
  State.time += dt;

  // Inertial glide after a flick.
  if (!nav.dragging) rig.coast(dt);

  if (virtualiser.needsRefresh()){
    const visibilityStarted = performance.now();
    virtualiser.computeVisible();
    Perf.sample('main.visibility', performance.now() - visibilityStarted);
  } else {
    rig.apply();
  }

  pool.service();

  // A parked pin (from a permalink, or a bloom requested before its
  // anchor had been minted) retries until the anchor exists.
  if (Pin.want) pinAt(Pin.want.i, Pin.want.j);

  const layoutStarted = performance.now();
  const frameTris = layout(State.time, dt, { rig, virtualiser, stage, forceFullGeometry });
  Perf.sample('main.layout', performance.now() - layoutStarted);

  tickHash(dt, rig);
  hud.tick(rawDt, dt, frameTris);

  TWEEN.update();
  const renderStarted = performance.now();
  stage.render();
  Perf.sample('main.renderSubmission', performance.now() - renderStarted);
  const labelStarted = performance.now();
  labels.draw();
  Perf.sample('main.labels', performance.now() - labelStarted);
}

frame();
