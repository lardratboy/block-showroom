import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import { Core } from './core/bimoblock-core.js';
import { CFG, ROLES, ROLE_BY_ID, GROUP_COLORS, GROUP_RGB, TAU, MAX_R, PRESETS, clamp, idiv } from './config.js';
import { Axis, Filter, Mint, Tier, Pin, State, Bloom, Focus, Hover } from './state.js';
import { symmetryLabel, specimenChiral, cellWorldX, cellWorldZ, hash32 } from './lattice/recipe.js';
import { exportSpecimenOBJ, exportSheetOBJ } from './export/obj.js';
import { readHash, writeHash, commitHash, hashString, tickHash } from './ui/permalink.js';
import { Perf, installPerformanceDiagnostics } from './perf.js';
import { ShowroomScene } from './scene/scene.js';
import { CameraRig } from './scene/rig.js';
import { Virtualiser } from './scene/virtualiser.js';
import { LabelOverlay } from './scene/labels.js';
import { GenerationPool } from './lattice/generation.js';

"use strict";

const { GROUPS, ARCH_NAMES, FIELD_NAMES, NATIVE_FIELDS, LEGACY_FIELD_COUNT, LIFT_NAMES, levelResolution } = Core;
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

const _v2  = new THREE.Vector2();
const _hit = new THREE.Vector3();
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
const elCoord   = document.getElementById('coord');
const elStatus  = document.getElementById('status');
const elInspect = document.getElementById('inspect');
const elToast   = document.getElementById('toast');
const elLegend  = document.getElementById('legend');

let statusTimer = 0;
function setStatus(text){ elStatus.textContent = text; statusTimer = 3.4; }
function defaultStatus(){
  const axes = 'X → ' + ROLE_BY_ID[Axis.x].label + '   ·   Y → ' + ROLE_BY_ID[Axis.y].label;
  return (Pin.on && Pin.params)
    ? 'district of ' + Pin.i + ', ' + Pin.j + '   ·   radius ' + Pin.radius + '   ·   ' + axes
    : axes;
}
let toastTimer = 0;
function showToast(msg){ elToast.textContent = msg; elToast.style.opacity = '1'; toastTimer = 2.4; }

function focusedData(){ return virtualiser.at(Focus.i, Focus.j); }

function refreshInspector(){
  const p = focusedData();
  if (!p){
    elInspect.innerHTML = `<span class="k">cell</span> <b>${Focus.i}, ${Focus.j}</b>\n<span class="k">${pool.failed('build', Focus.i, Focus.j) ? 'generation failed — shuffle to retry' : 'minting…'}</span>`;
    return;
  }

  const g = GROUPS[p.sym];
  const px = ROLE_BY_ID[Axis.x].count ? idiv(Focus.i, ROLE_BY_ID[Axis.x].count) : Focus.i;
  const py = ROLE_BY_ID[Axis.y].count ? idiv(Focus.j, ROLE_BY_ID[Axis.y].count) : Focus.j;

  elInspect.innerHTML =
    `<span class="k">cell</span> <b>${Focus.i}, ${Focus.j}</b> <span class="k">· page ${px}, ${py}</span>\n` +
    `<span class="k">${p.tierSymmetry ? 'tiers out → in' : 'group'}</span> <b>${symmetryLabel(p)}</b>\n` +
    `<span class="k">archetype</span> <b>${ARCH_NAMES[p.arch]}</b>\n` +
    `<span class="k">field</span> <b>${FIELD_NAMES[p.field]}</b>` +
      (p.field >= NATIVE_FIELDS && p.field < LEGACY_FIELD_COUNT ? ` <span class="k">/</span> <b>${LIFT_NAMES[p.lift]}</b>` : '') + `\n` +
    `<span class="k">resolution</span> <b>${p.R}</b> <span class="k">[${p.levels.map(l=>l.radix).join('×')}]</span>\n` +
    `<span class="k">${p.tierSymmetry ? 'whole-grid order' : 'aut-order'}</span> <b>${p.aut < 0 ? (pool.failed('analyze', Focus.i, Focus.j) ? 'unavailable' : 'calculating…') : p.aut}</b> <span class="k">${p.tierSymmetry ? 'rigid transforms' : 'of '+g.order}</span>\n` +
    `<span class="k">voxels</span> <b>${p.filled}</b> <span class="k">/ ${p.envelopeCells}</span>\n` +
    `<span class="k">density</span> <b>${(p.density * 100).toFixed(0)}%</b>\n` +
    `<span class="k">seed</span> <b>#${(p.seed >>> 0).toString(16).padStart(8,'0')}</b>\n` +
    (p.kin
      ? `<span class="k">kin</span> <b>ring ${p.kin.ring}</b> <span class="k">of ${Pin.radius} · ${p.kin.drift.length ? 'drift ' + p.kin.drift.join(' ') : 'pure inheritance'}</span>\n`
      : '') +
    `<span class="k">resident</span> <b>${virtualiser.cache.size}</b> <span class="k">blocks · ${(virtualiser.cacheBytes/1048576).toFixed(0)} MB · ${virtualiser.visible.length} nearby</span>\n` +
    `<span class="k">stream tris</span> <b>${(frameTris / 1000).toFixed(0)}k</b> <span class="k">· ${fps.toFixed(0)} fps</span>\n` +
    `<span class="k">generation</span> <b>${pool.mode === 'workers' ? pool.liveWorkers + ' workers' : pool.mode}</b> <span class="k">· ${pool.pending.size} pending${virtualiser.cacheBytes > CFG.CACHE_BYTES ? ' · visible set over cache target' : ''}</span>`;
}

function buildLegend(){
  let html = '<div class="hd">symmetry key</div>';
  GROUPS.forEach((g, i) => {
    html += `<div class="row"><i style="background:${GROUP_COLORS[i]}"></i>${g.name}</div>`;
  });
  elLegend.innerHTML = html;
}
buildLegend();

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
   NAVIGATION INPUT
   ===================================================================== */

const pointers = new Map();
let dragMode = null;         // 'pan' | 'orbit'
let dragAnchor = null;
let dragStart = null;
let pinchDist = 0;

renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

renderer.domElement.addEventListener('pointerdown', (e) => {
  renderer.domElement.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

  if (pointers.size === 2){
    const pts = [...pointers.values()];
    pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    dragMode = 'pinch';
    return;
  }

  dragStart = { x:e.clientX, y:e.clientY, t:performance.now() };
  rig.vx = rig.vz = 0;
  if (e.shiftKey || e.button === 2 || e.button === 1){
    dragMode = 'orbit';
  } else {
    dragMode = 'pan';
    rig.apply();
    rig.ndcOf(e, _v2);
    rig.groundAt(_v2.x, _v2.y, _hit);
    dragAnchor = _hit.clone();
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (prev){ prev.x = e.clientX; prev.y = e.clientY; }

  if (dragMode === 'pinch' && pointers.size === 2){
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchDist > 1 && d > 1){
      rig.zoomBy(pinchDist / d, 0, 0);
      pinchDist = d;
    }
    return;
  }

  if (dragMode === 'orbit' && prev){
    rig.yaw  -= (e.movementX || 0) * 0.005;
    rig.tilt = clamp(rig.tilt + (e.movementY || 0) * 0.004, 0.52, 1.535);
    setTiltSlider();
    rig.apply();
    return;
  }

  if (dragMode === 'pan' && dragAnchor){
    rig.ndcOf(e, _v2);
    rig.groundAt(_v2.x, _v2.y, _hit);
    const dx = _hit.x - dragAnchor.x, dz = _hit.z - dragAnchor.z;
    rig.x -= dx; rig.z -= dz;
    rig.vx = -dx * 14; rig.vz = -dz * 14;
    rig.apply();
    return;
  }

  // Idle hover: the cell under the cursor, straight from the plane.
  rig.ndcOf(e, _v2);
  if (rig.groundAt(_v2.x, _v2.y, _hit)){
    Hover.i = Math.round(_hit.x / CFG.CELL);
    Hover.j = Math.round(-_hit.z / CFG.CELL);
    Hover.on = true;
  } else Hover.on = false;
});

function endPointer(e){
  pointers.delete(e.pointerId);
  if (dragMode === 'pan' && dragStart){
    const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
    if (moved < 5){
      rig.vx = rig.vz = 0;
      rig.ndcOf(e, _v2);
      if (rig.groundAt(_v2.x, _v2.y, _hit))
        setFocus(Math.round(_hit.x / CFG.CELL), Math.round(-_hit.z / CFG.CELL), true);
    }
  }
  if (pointers.size < 2){ dragMode = null; dragAnchor = null; dragStart = null; }
}
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  rig.ndcOf(e, _v2);
  rig.zoomBy(Math.exp(clamp(e.deltaY, -160, 160) * 0.0013), _v2.x, _v2.y);
}, { passive: false });

/* =====================================================================
   CONTROLS
   ===================================================================== */
function opt(sel, value, label, selected){
  const o = document.createElement('option');
  o.value = value; o.textContent = label;
  if (selected) o.selected = true;
  sel.appendChild(o);
}

const selAxX  = document.getElementById('axX');
const selAxY  = document.getElementById('axY');
const selSym  = document.getElementById('sym');
const selArch = document.getElementById('arch');
const selFld  = document.getElementById('field');
const selColor = document.getElementById('colorMode');

ROLES.forEach(r => opt(selAxX, r.id, 'x axis: ' + r.label, r.id === Axis.x));
ROLES.forEach(r => opt(selAxY, r.id, 'y axis: ' + r.label, r.id === Axis.y));

opt(selSym, '-1', 'symmetry: roam', true);
GROUPS.forEach((g, i) => opt(selSym, String(i), 'symmetry: ' + g.name));
opt(selArch, '-1', 'archetype: roam', true);
ARCH_NAMES.forEach((n, i) => opt(selArch, String(i), 'archetype: ' + n));
opt(selFld, '-1', 'field: roam', true);
FIELD_NAMES.forEach((n, i) => opt(selFld, String(i), 'field: ' + n));

// Additive display modes only — never touch generation, so switching never
// invalidates the cache or needs flushLattice(). Specimens built before this
// mode existed (or LOD proxies, which never carry orbit data) just have no
// colorOrbit attribute and layout() below falls back to gamut for them.
opt(selColor, 'gamut', 'color: gamut position', true);
opt(selColor, 'chiral', 'color: chirality');
opt(selColor, 'orbit', 'color: orbit index');

function syncFilterEnablement(){
  selSym.disabled  = (Axis.x === 'sym'   || Axis.y === 'sym');
  selArch.disabled = (Axis.x === 'arch'  || Axis.y === 'arch');
  selFld.disabled  = (Axis.x === 'field' || Axis.y === 'field');
  inDens.disabled  = (Axis.x === 'dens'  || Axis.y === 'dens');
}

function setAxis(which, id){
  const other = which === 'x' ? 'y' : 'x';
  // Two axes may not enumerate the same thing; the loser falls back to roam.
  if (id !== 'free' && Axis[other] === id){
    Axis[other] = 'free';
    (other === 'x' ? selAxX : selAxY).value = 'free';
  }
  Axis[which] = id;
  syncFilterEnablement();
  elStatus.textContent = defaultStatus();
  flushLattice();
}

selAxX.addEventListener('change', () => setAxis('x', selAxX.value));
selAxY.addEventListener('change', () => setAxis('y', selAxY.value));
selSym.addEventListener('change',  () => { Filter.sym   = parseInt(selSym.value, 10);  flushLattice(); });
selArch.addEventListener('change', () => { Filter.arch  = parseInt(selArch.value, 10); flushLattice(); });
selFld.addEventListener('change',  () => { Filter.field = parseInt(selFld.value, 10);  flushLattice(); });
selColor.addEventListener('change', () => {
  State.colorMode = selColor.value;
  const label = State.colorMode === 'chiral' ? 'chirality (amber = chiral, blue = achiral)'
    : State.colorMode === 'orbit' ? 'orbit index (hue = which symmetric copy folded here)'
    : 'gamut position';
  setStatus('color mode: ' + label);
});

const inDens  = document.getElementById('dens');
const inPitch = document.getElementById('pitch');
const inSize  = document.getElementById('size');
const inTilt  = document.getElementById('tilt');
const inSpin  = document.getElementById('spin');
const inHaze  = document.getElementById('haze');
const inKin   = document.getElementById('kin');
const inHoriz = document.getElementById('horizon');

function debounce(fn, ms){
  let h = 0;
  return (...a) => { if (h) clearTimeout(h); h = setTimeout(() => { h = 0; fn(...a); }, ms); };
}
const commitConfiguration = debounce(() => flushLattice(), 200);
function applyConfiguration(){ pool.invalidate(true); commitConfiguration(); }
const applyDensity = applyConfiguration;
inDens.addEventListener('input', () => {
  Mint.density = parseInt(inDens.value, 10) / 100;
  setStatus('generation density ' + inDens.value + '%');
  applyDensity();
});

/* =====================================================================
   LEVELS EDITOR — arbitrary {radix,gap} tier list, global (like density),
   not per-cell. Editing it invalidates every cached specimen since it
   changes their resolution. MAX_R (config.js) caps the per-specimen
   cell count.
   ===================================================================== */
const applyLevels = applyConfiguration;
const lvRows = document.getElementById('lvrows'), resLine = document.getElementById('resLine');

document.getElementById('tierSymmetry').onchange=e=>{ Tier.symmetry=e.target.checked; renderLevelRows(); applyLevels(); };
function tierExample(outer,inner){
  if(Tier.levels.length<2) Tier.levels=[{radix:3,gap:.30},{radix:3,gap:.06}];
  Tier.levels=Tier.levels.map((l,i)=>({...l,sym:i===0?outer:inner}));
  Tier.symmetry=true; document.getElementById('tierSymmetry').checked=true;
  renderLevelRows(); applyLevels();
}
document.getElementById('tierMirrorSpin').onclick=()=>tierExample(1,5);
document.getElementById('tierCubeFree').onclick=()=>tierExample(9,0);

function renderLevelRows(){
  lvRows.innerHTML = '';
  Tier.levels.forEach((lv, i) => {
    const row = document.createElement('div'); row.className = 'lvrow';
    row.innerHTML =
      `<span class="idx">${i===0?'out':(i===Tier.levels.length-1?'in':i)}</span>` +
      `<input type="number" min="2" max="12" value="${lv.radix}" data-i="${i}" class="radixIn">` +
      `<input type="range" min="0" max="100" value="${Math.round(lv.gap*100)}" data-i="${i}" class="gapIn" title="Sibling spacing at this tier (% of child width)">` +
      `<span class="gapv">${lv.gap.toFixed(2)}</span>` +
      `<button data-i="${i}" class="delBtn" title="remove this level">×</button>`;
    const select=document.createElement('select');
    select.className='tierGroup'; select.disabled=!Tier.symmetry;
    select.setAttribute('aria-label',`Tier ${i+1} symmetry`);
    select.add(new Option('inherit specimen group', '-1'));
    GROUPS.forEach((g,j)=>select.add(new Option(g.name+' ('+g.order+')',String(j))));
    select.value=String(lv.sym ?? -1);
    select.onchange=()=>{ lv.sym=+select.value; applyLevels(); };
    row.appendChild(select);
    lvRows.appendChild(row);
  });
  const R = levelResolution(Tier.levels);
  resLine.textContent = `R=${R} · ${(R*R*R).toLocaleString()} cells`;

  lvRows.querySelectorAll('.radixIn').forEach(el => el.onchange = e => {
    const i = +e.target.dataset.i, want = Math.max(2, Math.min(12, parseInt(e.target.value) || 2));
    const trial = Tier.levels.map((l,k) => k===i ? { ...l, radix:want } : l);
    if (levelResolution(trial) > MAX_R){
      console.warn(`[bimoblock] radix change rejected: R would exceed MAX_R=${MAX_R}`);
      setStatus(`too large — R capped at ${MAX_R}`);
      e.target.value = Tier.levels[i].radix;
      return;
    }
    Tier.levels[i].radix = want;
    renderLevelRows();
    setStatus(`levels [${Tier.levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Tier.levels)}`);
    applyLevels();
  });
  lvRows.querySelectorAll('.gapIn').forEach(el => el.oninput = e => {
    const i = +e.target.dataset.i;
    Tier.levels[i].gap = (+e.target.value) / 100;
    e.target.parentElement.querySelector('.gapv').textContent = Tier.levels[i].gap.toFixed(2);
    setStatus(`${i===0?'outer':i===Tier.levels.length-1?'inner':'level '+i} tier gap ${Math.round(Tier.levels[i].gap*100)}%`);
    applyLevels();
  });
  lvRows.querySelectorAll('.delBtn').forEach(el => el.onclick = e => {
    if (Tier.levels.length <= 1) return;
    Tier.levels.splice(+e.target.dataset.i, 1);
    renderLevelRows();
    setStatus(`levels [${Tier.levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Tier.levels)}`);
    applyLevels();
  });
}
document.getElementById('btnAddLevel').addEventListener('click', () => {
  const trial = [...Tier.levels, { radix:3, gap:0.1 }];
  if (levelResolution(trial) > MAX_R){
    console.warn(`[bimoblock] add-level rejected: R would exceed MAX_R=${MAX_R}`);
    setStatus(`too large — R capped at ${MAX_R}`);
    return;
  }
  Tier.levels.push({ radix:3, gap:0.1 });
  renderLevelRows();
  setStatus(`levels [${Tier.levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Tier.levels)}`);
  applyLevels();
});
document.getElementById('btnDelLevel').addEventListener('click', () => {
  if (Tier.levels.length <= 1) return;
  Tier.levels.pop();
  renderLevelRows();
  setStatus(`levels [${Tier.levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Tier.levels)}`);
  applyLevels();
});
document.querySelectorAll('#levelsPanel .presets button').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset;
  const next = PRESETS[p] || Tier.levels;
  if (levelResolution(next) > MAX_R){
    console.warn(`[bimoblock] preset '${p}' rejected: R=${levelResolution(next)} exceeds MAX_R=${MAX_R}`);
    setStatus(`preset too large — R capped at ${MAX_R}`);
    return;
  }
  Tier.levels = next.map((l,i)=>({...l,sym:Tier.levels[i]?.sym ?? -1}));
  renderLevelRows();
  setStatus(`levels [${Tier.levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Tier.levels)}`);
  applyLevels();
}));
renderLevelRows();

inPitch.addEventListener('input', () => {
  CFG.CELL = parseInt(inPitch.value, 10) / 10;
  virtualiser.invalidate();
  setStatus('lattice pitch ' + CFG.CELL.toFixed(1));
});
inSize.addEventListener('input', () => {
  CFG.BLOCK_S = parseInt(inSize.value, 10) / 100;
  setStatus('specimen size ' + CFG.BLOCK_S.toFixed(2));
});
inTilt.addEventListener('input', () => {
  rig.tilt = parseInt(inTilt.value, 10) * Math.PI / 180;
  rig.tilt = clamp(rig.tilt, 0.52, 1.535);
  rig.apply(); virtualiser.invalidate();
});
function setTiltSlider(){ inTilt.value = String(Math.round(rig.tilt * 180 / Math.PI)); }
inSpin.addEventListener('input', () => { State.spin = parseInt(inSpin.value, 10) / 100; });
inHaze.addEventListener('input', () => { State.haze = parseInt(inHaze.value, 10) / 100; });

inKin.addEventListener('input', () => {
  Pin.radius = parseInt(inKin.value, 10);
  const n = 2 * Pin.radius + 1;
  setStatus('district radius ' + Pin.radius + '  ·  ' + (n * n) + ' relatives');
  if (Pin.on){ Pin.epoch++; virtualiser.invalidate(); }
});

inHoriz.addEventListener('input', () => {
  CFG.MAX_VISIBLE = Math.min(CFG.POD_MAX, parseInt(inHoriz.value, 10));
  virtualiser.invalidate();
  setStatus('horizon holds ' + CFG.MAX_VISIBLE + ' specimens');
});

const btnHome   = document.getElementById('home');
const btnWarp   = document.getElementById('warp');
const btnAlign  = document.getElementById('align');
const btnBloom  = document.getElementById('bloom');
const btnLabels = document.getElementById('labelsBtn');
const btnKey    = document.getElementById('keyBtn');
const btnShuf   = document.getElementById('shuffle');
const btnSheet  = document.getElementById('expSheet');
const btnObj    = document.getElementById('expObj');
const inGoto    = document.getElementById('goto');

btnHome.addEventListener('click', () => { rig.glideTo(0, 0, 15); setFocus(0, 0, false); setStatus('returned to origin'); });
btnWarp.addEventListener('click', () => {
  const i = (Math.random() * 2000 - 1000) | 0, j = (Math.random() * 2000 - 1000) | 0;
  rig.x = cellWorldX(i); rig.z = cellWorldZ(j);
  rig.vx = rig.vz = 0;
  virtualiser.invalidate();
  setFocus(i, j, false);
  showToast(`warped to district ${i}, ${j}`);
});
btnAlign.addEventListener('click', () => {
  State.align = !State.align;
  btnAlign.classList.toggle('on', State.align);
  setStatus(State.align ? 'specimens aligned for comparison' : 'idle rotation resumed');
});
function syncBloomUI(){
  inKin.value = String(Pin.radius);
  btnBloom.classList.toggle('on', Bloom.on);
}
btnBloom.addEventListener('click', () => {
  Bloom.on = !Bloom.on;
  btnBloom.classList.toggle('on', Bloom.on);
  if (Bloom.on){
    pinAt(Focus.i, Focus.j);
    const p = focusedData();
    showToast(p ? `blooming ${Focus.i}, ${Focus.j} · ${ARCH_NAMES[p.arch]} · ${symmetryLabel(p)}`
                : `blooming ${Focus.i}, ${Focus.j}`);
  } else {
    unpin();
    setStatus('district released — lattice restored');
  }
});
btnLabels.addEventListener('click', () => {
  State.labels = !State.labels;
  labels.markDirty();
  btnLabels.classList.toggle('on', State.labels);
});
btnKey.addEventListener('click', () => {
  State.legend = !State.legend;
  btnKey.classList.toggle('on', State.legend);
  elLegend.style.display = State.legend ? '' : 'none';
});
btnShuf.addEventListener('click', () => {
  Mint.gen++;
  flushLattice();
  writeHash();
  showToast('lattice re-minted — generation ' + Mint.gen);
});

inGoto.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key !== 'Enter') return;
  const m = /^\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*$/.exec(inGoto.value);
  if (!m){ setStatus('address must look like  12, -7'); return; }
  const i = parseInt(m[1], 10), j = parseInt(m[2], 10);
  const far = Math.hypot(cellWorldX(i) - rig.x, cellWorldZ(j) - rig.z) > CFG.CELL * 26;
  if (far){ rig.x = cellWorldX(i); rig.z = cellWorldZ(j); virtualiser.invalidate(); }
  else rig.glideTo(i, j);
  setFocus(i, j, false);
  inGoto.blur();
  showToast(`cell ${i}, ${j}`);
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const step = e.shiftKey ? 5 : 1;
  switch (e.key){
    case 'ArrowLeft':  rig.glideTo(Focus.i - step, Focus.j); setFocus(Focus.i - step, Focus.j, false); e.preventDefault(); break;
    case 'ArrowRight': rig.glideTo(Focus.i + step, Focus.j); setFocus(Focus.i + step, Focus.j, false); e.preventDefault(); break;
    case 'ArrowUp':    rig.glideTo(Focus.i, Focus.j + step); setFocus(Focus.i, Focus.j + step, false); e.preventDefault(); break;
    case 'ArrowDown':  rig.glideTo(Focus.i, Focus.j - step); setFocus(Focus.i, Focus.j - step, false); e.preventDefault(); break;
    case '[': setFocus(Focus.i - 1, Focus.j, true); break;
    case ']': setFocus(Focus.i + 1, Focus.j, true); break;
    case 'a': case 'A': btnAlign.click(); break;
    case 'b': case 'B': btnBloom.click(); break;
    case 'l': case 'L': btnLabels.click(); break;
    case 'k': case 'K': btnKey.click(); break;
    case 'g': case 'G': btnShuf.click(); break;
    case 'h': case 'H': btnHome.click(); break;
    case 'w': case 'W': btnWarp.click(); break;
    case 'o': case 'O': exportSpecimen(); break;
    case 'e': case 'E': exportSheet(); break;
    case 'c': case 'C': copyAddress(); break;
  }
});

window.addEventListener('resize', () => {
  stage.resize();
  labels.resize();
  virtualiser.invalidate();
});

function copyAddress(){
  commitHash(rig);
  const text = location.href.split('#')[0] + hashString(rig);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text)
      .then(() => showToast('address copied — ' + Focus.i + ', ' + Focus.j))
      .catch(err => { console.warn('clipboard refused', err); showToast('copy blocked; see console'); console.log(text); });
  } else {
    console.log(text);
    showToast('address logged to console');
  }
}

/* =====================================================================
   EXPORTERS
   ===================================================================== */
const exportSpecimen = () => exportSpecimenOBJ({ specimen: focusedData(), toast: showToast });
const exportSheet    = () => exportSheetOBJ({ rig, visible: virtualiser.visible, cache: virtualiser.cache, toast: showToast });
btnSheet.addEventListener('click', exportSheet);
btnObj.addEventListener('click', exportSpecimen);

/* =====================================================================
   MAIN LOOP
   ===================================================================== */
const clock = new THREE.Clock();
let fps = 60, hudT = 0;

syncFilterEnablement();
setTiltSlider();
elStatus.textContent = defaultStatus();
if (!readHash({ rig, setFocus, onBloom: syncBloomUI })) setFocus(0, 0, false);
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
  if (!dragMode) rig.coast(dt);

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

  fps += (1 / Math.max(rawDt, 1e-4) - fps) * Math.min(1, dt * 3);
  hudT += dt;
  if (hudT >= 0.4){
    hudT = 0;
    refreshInspector();
    elCoord.textContent = rig.cellI + ', ' + rig.cellJ;
  }
  if (statusTimer > 0){
    statusTimer -= dt;
    if (statusTimer <= 0) elStatus.textContent = defaultStatus();
  }
  if (toastTimer > 0){
    toastTimer -= dt;
    if (toastTimer <= 0) elToast.style.opacity = '0';
  }

  TWEEN.update();
  const renderStarted = performance.now();
  stage.render();
  Perf.sample('main.renderSubmission', performance.now() - renderStarted);
  const labelStarted = performance.now();
  labels.draw();
  Perf.sample('main.labels', performance.now() - labelStarted);
}

frame();
