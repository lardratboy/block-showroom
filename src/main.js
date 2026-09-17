import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import { Core } from './core/bimoblock-core.js';
import { CFG, ROLE_BY_ID, GROUP_RGB, TAU } from './config.js';
import { Axis, Pin, State, Bloom, Focus, Hover } from './state.js';
import { symmetryLabel, specimenChiral, cellWorldX, cellWorldZ, hash32 } from './lattice/recipe.js';
import { readHash, writeHash, tickHash } from './ui/permalink.js';
import { Perf, installPerformanceDiagnostics } from './perf.js';
import { ShowroomScene } from './scene/scene.js';
import { CameraRig } from './scene/rig.js';
import { Virtualiser } from './scene/virtualiser.js';
import { LabelOverlay } from './scene/labels.js';
import { Hud } from './ui/hud.js';
import { Navigation } from './ui/input.js';
import { Controls } from './ui/controls.js';
import { LevelsEditor } from './ui/levels-editor.js';
import { GenerationPool } from './lattice/generation.js';

"use strict";

const { ARCH_NAMES } = Core;
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
   ===================================================================== */

/* =====================================================================
   SCENE (scene/scene.js) and CAMERA RIG (scene/rig.js)
   ===================================================================== */
const stage = new ShowroomScene(document.getElementById('stage'));
const { renderer, scene, camera, floor, floorMat, pods, focusRing, hoverRing, blocksG } = stage;
const rig = new CameraRig(camera, renderer.domElement);

const _p3  = new THREE.Vector3();

/* =====================================================================
   VIRTUALISATION — scene/virtualiser.js
   ===================================================================== */
const virtualiser = new Virtualiser(rig, blocksG);
let frameTris = 0;


// Console diagnostics (perf.js); the probe supplies this app's live fields.
installPerformanceDiagnostics(() => ({
  pendingUploads:[...virtualiser.slots.values()].filter(s => s.awaitingUpload).length,
  workers:pool.liveWorkers, mode:pool.mode,
  pending:pool.pending.size, readyResults:pool.results.length,
  readyBytes:pool.results.reduce((n,r) => n + r.bytes, 0),
  reservedBytes:pool.pool.reduce((n,s) => n + (s.job ? s.job.estimate : 0), 0),
  residentBytes:virtualiser.cacheBytes, cacheOverBudget:virtualiser.cacheBytes > CFG.CACHE_BYTES,
  visible:virtualiser.visible.length, missing:virtualiser.visible.filter(c => !virtualiser.cache.has(c.key)).length,
  drawCalls:renderer.info.render.calls, triangles:renderer.info.render.triangles
}));
const perfOptions = new URLSearchParams(location.search);
const forceFullGeometry = perfOptions.get('fullGeometry') === '1';
const requestedWorkers = perfOptions.has('workers') ? Number(perfOptions.get('workers')) : null;
const workerCount = [0,1,2,4].includes(requestedWorkers) ? requestedWorkers
  : (navigator.hardwareConcurrency >= 4 ? 2 : 1);
const pool = new GenerationPool(virtualiser, rig, { workerCount });

function flushLattice(){
  pool.invalidate(false);
  virtualiser.flush();
  refreshInspector();
}

/* =====================================================================
   PER-FRAME LAYOUT
   ===================================================================== */
const _m4 = new THREE.Matrix4();
const _q  = new THREE.Quaternion();
const _e  = new THREE.Euler();
const _s3 = new THREE.Vector3();
const _c3 = new THREE.Color();

let podCount = 0;
const renderFrustum = new THREE.Frustum();
const renderProjection = new THREE.Matrix4();

function layout(t, dt){
  frameTris = 0;
  podCount = 0;
  let podMatricesChanged = false, podColorsChanged = false;
  let uploadBytes = 0, uploadCount = 0;
  renderProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  renderFrustum.setFromProjectionMatrix(renderProjection);

  // CSS pixels, so the LOD threshold means the same thing on every display
  const projK = window.innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
  const hover = CFG.BLOCK_S * 0.5 + 0.42;

  for (const c of virtualiser.visible){
    const p = virtualiser.cache.get(c.key);
    if (!p) continue;
    p.seen = virtualiser.seenTick;

    let s = virtualiser.slots.get(c.key);
    if (!s){
      const hh = hash32(c.i, c.j);
      s = { mesh: virtualiser.takeMesh(), i: c.i, j: c.j, age: 0,
            ph: (hh & 1023) / 1023 * TAU,
            rate: (((hh >>> 10) & 255) / 255 - 0.5) * 1.4 };
      virtualiser.slots.set(c.key, s);
    }
    const entering = s.age < 1;
    s.age = Math.min(1, s.age + dt * 3.4);

    const wx = cellWorldX(c.i), wz = cellWorldZ(c.j);
    const dist = Math.hypot(camera.position.x - wx, camera.position.y, camera.position.z - wz);
    const px = CFG.BLOCK_S * projK / Math.max(dist, 0.001);

    const useLod = !forceFullGeometry && px < CFG.LOD_PX;
    const lodStarted = useLod && !p.geoLod ? performance.now() : null;
    const geo = useLod ? virtualiser.lodOf(p) : p.geo;
    if (lodStarted !== null) Perf.sample('main.proxyMesh', performance.now() - lodStarted);
    const previousGeo = s.mesh.geometry;
    if (previousGeo !== geo) s.mesh.geometry = geo;

    // Orbit-index coloring lives on a second attribute (colorOrbit) rather than
    // overwriting colorGamut, so this only swaps which one the material reads
    // as 'color' — cheap, and a no-op once every visible geometry has caught up
    // to the current mode. Geometries without colorOrbit (LOD proxies, or any
    // specimen generated before this mode existed) simply stay on gamut.
    const wantAttr = (State.colorMode === 'orbit' && geo.attributes.colorOrbit) ? 'orbit' : 'gamut';
    if (geo.userData.colorBound !== wantAttr){
      geo.setAttribute('color', wantAttr === 'orbit' ? geo.attributes.colorOrbit : geo.attributes.colorGamut);
      geo.userData.colorBound = wantAttr;
    }

    const k = s.age * s.age * (3 - 2 * s.age);
    const bob = 0.10 * Math.sin(t * 0.7 + c.i * 0.9 - c.j * 0.6);
    s.mesh.position.set(wx, hover + bob + (1 - k) * 1.4, wz);
    s.mesh.scale.setScalar(CFG.BLOCK_S * (0.35 + 0.65 * k));

    if (State.align){
      _e.set(0, 0, 0);
    } else {
      const a = s.ph + t * s.rate * State.spin;
      _e.set(Math.sin(t * 0.31 + s.ph) * 0.20 * State.spin, a, Math.cos(t * 0.23 + s.ph) * 0.12 * State.spin);
    }
    s.mesh.quaternion.setFromEuler(_e);

    // Cached geometry may never have reached the GPU while offscreen. Bound
    // first draws too, rather than assuming that cache installation uploaded it.
    s.mesh.updateMatrixWorld(true);
    const onScreen = renderFrustum.intersectsObject(s.mesh);
    s.mesh.visible = true; s.awaitingUpload = false;
    if (onScreen && !geo.userData.uploaded){
      if (uploadCount && uploadBytes + geo.userData.bytes > CFG.UPLOAD_BYTES){
        s.awaitingUpload = true;
        // Preserve the old representation during a delayed LOD transition.
        if (previousGeo.userData.uploaded) s.mesh.geometry = previousGeo;
        else s.mesh.visible = false;
      } else {
        uploadBytes += geo.userData.bytes; uploadCount++;
      }
    }
    if (onScreen && s.mesh.visible) frameTris += s.mesh.geometry.userData.tris || 0;

    const mat = s.mesh.material;
    mat.opacity = k;
    const wantTransparent = k < 0.995;
    if (mat.transparent !== wantTransparent){ mat.transparent = wantTransparent; mat.needsUpdate = true; }

    // Additive tint, not a replacement: material.color multiplies the baked-in
    // gamut vertex colors, so 'gamut' mode (white, i.e. ×1) leaves them exactly
    // as before, and 'chiral' mode shifts the whole specimen toward one of two
    // accents without touching the underlying geometry or its color attribute.
    if (State.colorMode === 'chiral'){
      const chiral = specimenChiral(p);
      mat.color.setRGB(chiral ? 1.00 : 0.62, chiral ? 0.82 : 0.72, chiral ? 0.42 : 0.88);
    } else {
      mat.color.setRGB(1, 1, 1);
    }

    if (podCount < CFG.POD_MAX){
      const movedIndex = s.podIndex !== podCount;
      if (movedIndex || s.podCell !== CFG.CELL){
        _s3.setScalar(CFG.CELL * 0.42);
        _q.identity(); _p3.set(wx, 0.012, wz);
        _m4.compose(_p3, _q, _s3);
        pods.setMatrixAt(podCount, _m4);
        podMatricesChanged = true;
      }
      if (movedIndex || entering || s.podSym !== p.sym){
        _c3.copy(GROUP_RGB[p.sym % GROUP_RGB.length]).multiplyScalar(0.55 + 0.45 * k);
        pods.setColorAt(podCount, _c3);
        podColorsChanged = true;
      }
      s.podIndex = podCount; s.podCell = CFG.CELL; s.podSym = p.sym;
      podCount++;
    }
  }

  Perf.maxUploadBytes = Math.max(Perf.maxUploadBytes, uploadBytes);
  pods.count = podCount;
  if (podMatricesChanged) pods.instanceMatrix.needsUpdate = true;
  if (podColorsChanged && pods.instanceColor) pods.instanceColor.needsUpdate = true;

  // Floor plate rides the target; the grid stays welded to world space.
  const reach = 34 + rig.h * 4.2;
  floor.position.set(rig.x, 0, rig.z);
  floor.scale.set(reach * 2.6, reach * 2.6, 1);
  floorMat.uniforms.uCenter.value.set(rig.x, rig.z);
  floorMat.uniforms.uCell.value = CFG.CELL;
  floorMat.uniforms.uFade.value = reach;
  floorMat.uniforms.uPeriod.value.set(
    ROLE_BY_ID[Axis.x].count || 8,
    ROLE_BY_ID[Axis.y].count || 8
  );
  floorMat.uniforms.uPinOn.value = (Pin.on && Pin.params) ? 1 : 0;
  floorMat.uniforms.uPinC.value.set(cellWorldX(Pin.i), cellWorldZ(Pin.j));
  floorMat.uniforms.uPinR.value = (Pin.radius + 0.5) * CFG.CELL;

  scene.fog.density = State.haze * 1.35 / (16 + rig.h * 3.4);

  const fr = 0.62 + 0.05 * Math.sin(t * 2.4);
  focusRing.position.set(cellWorldX(Focus.i), 0.02, cellWorldZ(Focus.j));
  focusRing.scale.setScalar(CFG.CELL * 0.44 * fr / 0.62);
  hoverRing.position.set(cellWorldX(Hover.i), 0.016, cellWorldZ(Hover.j));
  hoverRing.scale.setScalar(CFG.CELL * 0.46);
  hoverRing.visible = Hover.on && !(Hover.i === Focus.i && Hover.j === Focus.j);
}

/* =====================================================================
   FLOOR LABELS — scene/labels.js
   ===================================================================== */
const labels = new LabelOverlay(document.getElementById('labels'), rig, virtualiser);

/* =====================================================================
   STATE, FOCUS, HUD
   ===================================================================== */
const hud = new Hud(virtualiser, pool, rig);
const setStatus = text => hud.setStatus(text);
const showToast = msg => hud.showToast(msg);
const refreshInspector = () => hud.refreshInspector();
function focusedData(){ return virtualiser.at(Focus.i, Focus.j); }

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
  refreshInspector();
  return true;
}

function unpin(){
  if (!Pin.on) return;
  Pin.on = false; Pin.want = null; Pin.epoch++;
  virtualiser.invalidate();
  refreshInspector();
}

function setFocus(i, j, announce){
  labels.markDirty();
  Focus.i = i; Focus.j = j;
  if (Bloom.on) pinAt(i, j);
  refreshInspector();
  if (announce){
    const p = focusedData();
    showToast(p ? `${i}, ${j} · ${ARCH_NAMES[p.arch]} · ${symmetryLabel(p)}` : `${i}, ${j}`);
  }
  writeHash();
}

/* =====================================================================
   NAVIGATION INPUT — ui/input.js
   ===================================================================== */
const nav = new Navigation(rig, {
  onFocus: (i, j) => setFocus(i, j, true),
  onOrbit: () => setTiltSlider()
});

/* =====================================================================
   SETTINGS THAT REBUILD THE LATTICE
   ===================================================================== */
function debounce(fn, ms){
  let h = 0;
  return (...a) => { if (h) clearTimeout(h); h = setTimeout(() => { h = 0; fn(...a); }, ms); };
}
/* A slider or the levels editor changed the recipe: stop generation now,
   and rebuild once the input settles. */
const commitConfiguration = debounce(() => flushLattice(), 200);
function applyConfiguration(){ pool.invalidate(true); commitConfiguration(); }

/* =====================================================================
   CONTROLS (ui/controls.js) and LEVELS EDITOR (ui/levels-editor.js)
   ===================================================================== */
const controls = new Controls({ rig, virtualiser, hud, labels,
  actions: { setFocus, pinAt, unpin, flushLattice, applyConfiguration } });
new LevelsEditor({ setStatus, onChange: applyConfiguration });
const setTiltSlider = () => controls.setTiltSlider();

window.addEventListener('resize', () => {
  stage.resize();
  labels.resize();
  virtualiser.invalidate();
});

/* =====================================================================
   MAIN LOOP
   ===================================================================== */
const clock = new THREE.Clock();

if (!readHash({ rig, setFocus, onBloom: () => controls.syncBloomUI() })) setFocus(0, 0, false);
rig.apply();
virtualiser.computeVisible();
pool.start();

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
  layout(State.time, dt);
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
