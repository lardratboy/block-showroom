import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import { Core } from './core/bimoblock-core.js';
import { runNumericJob } from './core/jobs.js';
import { CFG, ROLES, ROLE_BY_ID, GROUP_COLORS, GROUP_RGB, TAU, MAX_R, PRESETS, clamp, imod, idiv } from './config.js';

"use strict";

const { GROUPS, ARCH_NAMES, FIELD_NAMES, NATIVE_FIELDS, LEGACY_FIELD_COUNT, LIFT_NAMES, levelResolution } = Core;
let TierSymmetry = false;
function symmetryLabel(p, short=false){
  const name=i=>short ? GROUPS[i].name.split(':')[0] : GROUPS[i].name;
  return p.tierSymmetry ? p.levels.map(l=>name(l.sym == null || l.sym < 0 ? p.sym : l.sym)).join(' / ') : name(p.sym);
}
/* Chirality is a property of a whole subgroup (every element has det>0 or it
   doesn't), never a per-voxel quantity, so this resolves to one flag per
   specimen. In independent-tier mode that's the OUTER tier's group, since the
   outer tier sets the macro silhouette a glance at the specimen actually
   shows — the same "inherit specimen group" sentinel used by symmetryLabel. */
function specimenChiral(p){
  if (p.tierSymmetry && p.levels && p.levels.length){
    const l0 = p.levels[0];
    const gi = (l0.sym == null || l0.sym < 0) ? p.sym : l0.sym;
    return GROUPS[gi].chiral;
  }
  return GROUPS[p.sym].chiral;
}
let Levels = [{ radix:3, gap:0.30 }, { radix:3, gap:0.06 }];

function geometryFromArrays(data){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
  const colGamut = new THREE.BufferAttribute(data.col, 3);
  g.setAttribute('colorGamut', colGamut);
  g.setAttribute('color', colGamut); // default binding — identical to prior behavior
  if (data.colOrbit) g.setAttribute('colorOrbit', new THREE.BufferAttribute(data.colOrbit, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.nrm, 3));
  g.setIndex(new THREE.BufferAttribute(data.idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...data.bounds.center), data.bounds.radius);
  g.userData.quads = data.quads;
  g.userData.tris = data.tris;
  g.userData.bytes = data.bytes;
  g.userData.uploaded = data.pos.length === 0;
  g.userData.colorBound = 'gamut';
  g.attributes.position.onUpload(() => { g.userData.uploaded = true; });
  return g;
}
function blockGeometry(occ, tier, filled, levels, R){
  return geometryFromArrays(Core.meshArrays(occ, tier, filled, levels, R));
}

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

const Axis   = { x:'arch', y:'sym' };
const Filter = { sym:-1, arch:-1, field:-1 };
const Mint   = { gen:0, density:0.25 };

function hash32(a, b){
  let h = ((a | 0) ^ Math.imul((b | 0) + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/* Parameters of the specimen standing at (i,j).  Pure; no state beyond
   the axis assignment, the filters, the density and Mint.gen. */
function cellParams(i, j){
  let pageX = i, pageY = j;
  const got = {};
  for (const role of ['arch','sym','field','lift','dens']){
    const n = ROLE_BY_ID[role].count;
    if (Axis.x === role){ got[role] = imod(i, n); pageX = idiv(i, n); }
    else if (Axis.y === role){ got[role] = imod(j, n); pageY = idiv(j, n); }
  }

  const h = hash32(hash32(pageX, 0x51ed270b ^ Math.imul(Mint.gen, 0x9e3779b1)), pageY * 31 + 7);

  const sym   = got.sym   != null ? got.sym   : (Filter.sym   >= 0 ? Filter.sym   :  h         % GROUPS.length);
  const arch  = got.arch  != null ? got.arch  : (Filter.arch  >= 0 ? Filter.arch  : (h >>>  8) % ARCH_NAMES.length);
  const fmode = got.field != null ? got.field : (Filter.field >= 0 ? Filter.field : (h >>> 16) % FIELD_NAMES.length);
  const lift  = got.lift  != null ? got.lift  : (h >>> 24) % LIFT_NAMES.length;
  const density = got.dens != null ? 0.10 + got.dens * 0.055 : Mint.density;

  /* One seed per page, deliberately: within a page the family
     resemblance across archetypes and subgroups is the whole point. */
  const seed = hash32(h, 0x2545f491);
  return { sym, arch, field:fmode, lift, density, seed };
}

/* =====================================================================
   SIBLING DISTRICTS
   ---------------------------------------------------------------------
   Pinning a specimen turns its surroundings into its relatives without
   giving up the property that makes the lattice worth roaming: content
   is still a pure function of (address, generation, pin), so a district
   is reproducible and reversible, and the plain lattice resumes intact
   outside its rim.

   Inside a district the pin is the origin of its own contact sheet.
   Traits an axis enumerates are re-centred on the anchor -- one step
   right is the next archetype *relative to this specimen* rather than
   relative to the page -- and the traits no axis owns start out simply
   inherited.  So ring 1 is eight near relatives.

   Further out, drift sets in.  Each unowned trait is mutated with
   probability (ring-1)/(radius-1) and by a step that widens with the
   same ratio, seed last of all since it is the trait that destroys the
   family resemblance outright.  The result is a genealogy laid on the
   floor: cousins at the rim, siblings by the door.  Pin a cousin and
   the whole thing re-centres on it, which is the actual exploration
   loop -- pick the one that looks interesting, bloom around it, repeat.
   ===================================================================== */
const TRAIT_N = { sym:GROUPS.length, arch:ARCH_NAMES.length,
                  field:FIELD_NAMES.length, lift:LIFT_NAMES.length };

const Pin = { on:false, i:0, j:0, radius:4, epoch:0, params:null, want:null };

function axisDelta(role, di, dj){
  if (Axis.x === role) return di;
  if (Axis.y === role) return dj;
  return null;
}
function inDistrict(i, j){
  return Pin.on && Pin.params &&
         Math.max(Math.abs(i - Pin.i), Math.abs(j - Pin.j)) <= Pin.radius;
}

function cellRecipe(i, j){
  if (!inDistrict(i, j)) return { P: cellParams(i, j), kin: null };

  const di = i - Pin.i, dj = j - Pin.j;
  const ring = Math.max(Math.abs(di), Math.abs(dj));
  const A = Pin.params;
  const P = { sym:A.sym, arch:A.arch, field:A.field, lift:A.lift,
              density:A.density, seed:A.seed };
  if (ring === 0) return { P, kin:{ ring:0, drift:[] } };

  for (const t of ['sym','arch','field','lift']){
    const d = axisDelta(t, di, dj);
    if (d !== null) P[t] = imod(A[t] + d, TRAIT_N[t]);
  }
  const dDens = axisDelta('dens', di, dj);
  if (dDens !== null) P.density = clamp(A.density + dDens * 0.055, 0.06, 0.72);

  const t01 = Pin.radius > 1 ? (ring - 1) / (Pin.radius - 1) : 1;
  let rs = hash32(hash32(A.seed ^ Pin.epoch, di * 73856093), dj * 19349663 + ring) || 1;
  const rnd = () => {
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
    return rs / 4294967296;
  };
  const sgn = () => rnd() < 0.5 ? -1 : 1;

  const drift = [];
  for (const t of ['sym','arch','field','lift']){
    if (axisDelta(t, di, dj) !== null) continue;
    if (rnd() >= t01) continue;
    const n = TRAIT_N[t];
    const span = 1 + Math.floor(t01 * n / 3);
    P[t] = imod(A[t] + sgn() * (1 + Math.floor(rnd() * span)), n);
    drift.push(t === 'field' ? 'field' : t);
  }
  if (dDens === null && rnd() < t01 * 0.8){
    P.density = clamp(A.density + sgn() * 0.05 * (1 + Math.floor(rnd() * 3)), 0.06, 0.72);
    drift.push('density');
  }
  if (rnd() < t01 * t01){
    P.seed = hash32(A.seed, di * 7919 + dj * 104729 + ring);
    drift.push('seed');
  }
  return { P, kin: { ring, drift } };
}

/* The outer-level proxy (r0^3 cells) is only meshed if something actually asks
   to draw one, which for a lattice this shallow is a minority of cells. */
function lodOf(p){
  if (!p.geoLod){
    p.geoLod = blockGeometry(p.occ, 1, p.filled, p.levels, p.R);
    p.lodTris = p.geoLod.userData.tris;
    const add = p.geoLod.userData.bytes;
    p.bytes += add; cacheBytes += add;
  }
  return p.geoLod;
}

/* =====================================================================
   SCENE
   ===================================================================== */
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x06021a, 0.016);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 900);

scene.add(new THREE.AmbientLight(0xffffff, 0.62));
const key1 = new THREE.DirectionalLight(0xfff0e8, 0.62); key1.position.set(6, 10, 8);
const key2 = new THREE.DirectionalLight(0x8ae0ff, 0.42); key2.position.set(-7, 5, -6);
scene.add(key1, key2);

const placeholder = new THREE.BufferGeometry();
placeholder.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));

/* ---- infinite floor ---------------------------------------------------
   Drawn as a plate that rides along under the camera target while the
   grid itself is evaluated in world coordinates, so the lines belong to
   the lattice and not to the plate.  Page boundaries -- the multiples of
   each axis role's period -- get a second, brighter rule, which is what
   makes the catalogue's pagination legible from the air. */
const FLOOR_VERT = `
varying vec3 vW;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FLOOR_FRAG = `
uniform vec2  uCenter;
uniform float uCell;
uniform vec2  uPeriod;
uniform float uFade;
uniform vec3  uColA;
uniform vec3  uColB;
uniform vec2  uPinC;
uniform float uPinR;
uniform float uPinOn;
varying vec3 vW;

float rule(float x, float s){
  float q = x / s;
  float d = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), 1e-5);
  return 1.0 - min(d, 1.0);
}

void main(){
  vec2 p = vW.xz;
  float cellL = max(rule(p.x, uCell), rule(p.y, uCell));
  float pageL = max(rule(p.x, uCell * uPeriod.x), rule(p.y, uCell * uPeriod.y));

  float r = length(p - uCenter);
  float fade = 1.0 - smoothstep(uFade * 0.30, uFade, r);

  vec3 col = uColA * cellL * 0.55 + uColB * pageL * 1.15;
  float a = (cellL * 0.34 + pageL * 0.72) * fade;

  // District rim: a Chebyshev square, so the boundary the recipe actually
  // uses is the boundary you see.
  if (uPinOn > 0.5){
    vec2 q = abs(p - uPinC) - vec2(uPinR);
    float sd = max(q.x, q.y);
    float w = max(fwidth(sd), 1e-5);
    float rim = 1.0 - smoothstep(0.0, w * 1.7, abs(sd));
    float in0 = 1.0 - smoothstep(-w, 0.0, sd);
    col += vec3(1.0, 0.24, 0.65) * rim * 1.7 + vec3(0.42, 0.06, 0.62) * in0 * 0.34;
    a = max(a, (rim * 0.9 + in0 * 0.09) * fade);
  }

  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

const floorMat = new THREE.ShaderMaterial({
  uniforms: {
    uCenter: { value: new THREE.Vector2() },
    uCell:   { value: CFG.CELL },
    uPeriod: { value: new THREE.Vector2(12, 10) },
    uFade:   { value: 60 },
    uColA:   { value: new THREE.Color(0x2c6bff) },
    uColB:   { value: new THREE.Color(0x00f5d4) },
    uPinC:   { value: new THREE.Vector2() },
    uPinR:   { value: 0 },
    uPinOn:  { value: 0 }
  },
  vertexShader: FLOOR_VERT,
  fragmentShader: FLOOR_FRAG,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  extensions: { derivatives: true }
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.frustumCulled = false;
floor.renderOrder = -10;
scene.add(floor);

/* ---- pods -------------------------------------------------------------
   One instanced ring per occupied cell, tinted by the specimen's
   symmetry group.  When an axis enumerates the subgroups the floor reads
   as coloured bands, which is a surprisingly good navigational aid. */
const ringGeo = new THREE.RingGeometry(0.70, 0.99, 44);
ringGeo.rotateX(-Math.PI / 2);
{
  const n = ringGeo.attributes.position.count;
  const rc = new Float32Array(n * 3).fill(1);
  ringGeo.setAttribute('color', new THREE.BufferAttribute(rc, 3));
}
const podMat = new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false,
  side: THREE.DoubleSide, fog: false
});
const pods = new THREE.InstancedMesh(ringGeo, podMat, CFG.POD_MAX);
pods.frustumCulled = false;
pods.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pods.setColorAt(0, GROUP_RGB[0]);
scene.add(pods);

function makeRing(inner, outer, color, opacity){
  const g = new THREE.RingGeometry(inner, outer, 64);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
const focusRing = makeRing(1.02, 1.16, 0x00f5d4, 0.95);
const hoverRing = makeRing(1.02, 1.09, 0xff3ea5, 0.5);

/* =====================================================================
   CAMERA RIG — a target on the lattice plane, a height and a pitch
   ===================================================================== */
const Rig = { x:0, z:0, h:15, tilt:0.91, yaw:0, vx:0, vz:0 };

function cellWorldX(i){ return i * CFG.CELL; }
function cellWorldZ(j){ return -j * CFG.CELL; }

function applyRig(){
  if (labelPose.x !== Rig.x || labelPose.z !== Rig.z || labelPose.h !== Rig.h
      || labelPose.tilt !== Rig.tilt || labelPose.yaw !== Rig.yaw){
    labelsDirty = true;
    labelPose.x=Rig.x; labelPose.z=Rig.z; labelPose.h=Rig.h; labelPose.tilt=Rig.tilt; labelPose.yaw=Rig.yaw;
  }
  const horiz = Rig.h / Math.tan(Rig.tilt);
  camera.position.set(Rig.x + Math.sin(Rig.yaw) * horiz, Rig.h, Rig.z + Math.cos(Rig.yaw) * horiz);
  camera.up.set(0, 1, 0);
  camera.lookAt(Rig.x, 0, Rig.z);
  camera.updateMatrixWorld();
}

const _ray = new THREE.Raycaster();
const _v2  = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _a3  = new THREE.Vector3();
const _b3  = new THREE.Vector3();
const _p3  = new THREE.Vector3();

/* Where a screen point lands on the lattice plane.  Rays aimed at or
   above the horizon cannot land anywhere, so they are answered with a
   capped point along the projected direction; the visible-set scan
   clamps to MAX_SPAN anyway. */
function groundAt(ndcx, ndcy, out){
  _v2.set(ndcx, ndcy);
  _ray.setFromCamera(_v2, camera);
  const r = _ray.ray;
  if (r.direction.y > -1e-4){
    out.copy(r.origin).addScaledVector(r.direction, CFG.MAX_SPAN * CFG.CELL * 1.6);
    out.y = 0;
    return false;
  }
  out.copy(r.origin).addScaledVector(r.direction, -r.origin.y / r.direction.y);
  return true;
}

function ndcOf(e, out){
  const rect = renderer.domElement.getBoundingClientRect();
  out.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  out.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  return out;
}

/* =====================================================================
   VIRTUALISATION — cache, generation queue, mesh pool
   ===================================================================== */
const cache   = new Map();   // "i,j" -> block data
const slots   = new Map();   // "i,j" -> { mesh, i, j, age, ph, rate }
const spare   = [];          // recycled meshes
const blocksG = new THREE.Group();
scene.add(blocksG);

let visible = [];            // [{i,j,key}] nearest first
let visKeys = new Set();
let seenTick = 0;
let frameTris = 0;

/* A district's content depends on the pin, so its cells are keyed by pin
   epoch as well as address.  Re-pinning therefore does not invalidate
   anything explicitly: the old district's entries simply stop being
   referenced and fall out under LRU, and unpinning re-exposes the plain
   keys that were already cached before the bloom. */
function keyOf(i, j){
  return inDistrict(i, j) ? i + ',' + j + '@' + Pin.epoch : i + ',' + j;
}
let cacheBytes = 0;

function takeMesh(){
  const m = spare.pop();
  if (m){ m.visible = true; return m; }
  const mesh = new THREE.Mesh(placeholder, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.22, metalness: 0.08
  }));
  mesh.frustumCulled = true;
  blocksG.add(mesh);
  return mesh;
}

function releaseSlot(s){
  s.mesh.visible = false;
  s.mesh.geometry = placeholder;
  spare.push(s.mesh);
}

function computeVisible(){
  labelsDirty = true;
  applyRig();

  let iMin = 1e9, iMax = -1e9, jMin = 1e9, jMax = -1e9;
  const corners = [[-1,-1],[1,-1],[-1,1],[1,1],[0,0]];
  for (const c of corners){
    groundAt(c[0], c[1], _hit);
    const ii = _hit.x / CFG.CELL, jj = -_hit.z / CFG.CELL;
    if (ii < iMin) iMin = ii; if (ii > iMax) iMax = ii;
    if (jj < jMin) jMin = jj; if (jj > jMax) jMax = jj;
  }

  const ci = Math.round(Rig.x / CFG.CELL), cj = Math.round(-Rig.z / CFG.CELL);
  const i0 = Math.max(Math.floor(iMin) - 1, ci - CFG.MAX_SPAN);
  const i1 = Math.min(Math.ceil(iMax)  + 1, ci + CFG.MAX_SPAN);
  const j0 = Math.max(Math.floor(jMin) - 1, cj - CFG.MAX_SPAN);
  const j1 = Math.min(Math.ceil(jMax)  + 1, cj + CFG.MAX_SPAN);

  /* At a doubled horizon the scanned box can hold fifteen thousand cells
     and sorting all of them every time the view slides half a cell is
     wasteful, since only the nearest few hundred can ever survive. A disc
     of area N*CELL^2 has radius CELL*sqrt(N/pi); take that with headroom
     as a pre-filter, and widen it only if the box turns out to be sparser
     than the estimate (which happens at the lattice's grazing angles). */
  const cx = camera.position.x, cz = camera.position.z;
  const N = CFG.MAX_VISIBLE;
  let radius = CFG.CELL * Math.sqrt(N / Math.PI) * 1.45;
  let list = [];
  for (let pass = 0; pass < 3; pass++){
    const r2 = radius * radius;
    let cut = 0;
    list = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++){
      const dx = cellWorldX(i) - cx, dz = cellWorldZ(j) - cz;
      const d = dx*dx + dz*dz;
      if (d <= r2) list.push({ i, j, d }); else cut++;
    }
    // Widen only if the pre-filter is what is short-changing us; if it
    // rejected nothing then the box itself is the limit and a second
    // pass would scan the same cells for the same answer.
    if (cut === 0 || list.length >= N) break;
    radius *= 1.7;
  }
  list.sort((a, b) => a.d - b.d);
  if (list.length > N) list.length = N;

  visible = list;
  visKeys = new Set();
  seenTick++;

  for (const c of list){
    c.key = keyOf(c.i, c.j);
    visKeys.add(c.key);
    const p = cache.get(c.key);
    if (p) p.seen = seenTick;
  }

  for (const [k, s] of slots){
    if (!visKeys.has(k)){ releaseSlot(s); slots.delete(k); }
  }
  evict();
}

/* Nothing currently on screen is ever evicted; among the rest the least
   recently seen goes first, so backtracking over ground already walked
   is free while a long straight run steadily recycles. */
function evict(){
  if (cache.size <= CFG.CACHE_MAX && cacheBytes <= CFG.CACHE_BYTES) return;
  const cold = [];
  for (const [k, p] of cache)
    if (!visKeys.has(k) && k !== keyOf(Focus.i, Focus.j)
        && !(Pin.want && k === keyOf(Pin.want.i, Pin.want.j))) cold.push([k, p]);
  cold.sort((a, b) => a[1].seen - b[1].seen);
  for (const [k, p] of cold){
    if (cache.size <= CFG.CACHE_MAX && cacheBytes <= CFG.CACHE_BYTES) break;
    p.geo.dispose();
    if (p.geoLod) p.geoLod.dispose();
    cacheBytes -= p.bytes;
    cache.delete(k);
  }
}


// Bounded diagnostics, available from the console as showroomPerformance().
const Perf = {
  frames: new Float64Array(2048), count: 0, cursor: 0, longFrames: 0,
  phases: {}, discarded: 0, installed: 0, maxUploadBytes:0, epochStarted: performance.now(), populationMs: null,
  sample(name, ms){
    const p = this.phases[name] || (this.phases[name] = { count:0, total:0, max:0 });
    p.count++; p.total += ms; p.max = Math.max(p.max, ms);
  },
  frame(ms){
    this.frames[this.cursor++ % this.frames.length] = ms;
    this.count = Math.min(this.count + 1, this.frames.length);
    if (ms > 50) this.longFrames++;
  },
  reset(){
    this.count = this.cursor = this.longFrames = this.discarded = this.installed = this.maxUploadBytes = 0;
    this.phases = {}; this.epochStarted = performance.now(); this.populationMs = null;
  },
  snapshot(){
    const f = Array.from(this.frames.subarray(0, this.count)).sort((a,b) => a-b);
    const phases = {};
    for (const [name,p] of Object.entries(this.phases))
      phases[name] = { count:p.count, meanMs:p.total/p.count, maxMs:p.max };
    return { frames:f.length, medianMs:f[Math.floor(f.length*.5)] || 0,
      p95Ms:f[Math.min(f.length-1, Math.floor(f.length*.95))] || 0,
      longFrames:this.longFrames, populationMs:this.populationMs, phases,
      discarded:this.discarded, installed:this.installed, maxUploadBytes:this.maxUploadBytes,
      pendingUploads:[...slots.values()].filter(s => s.awaitingUpload).length,
      workers:Generation.pool.filter(s => !s.dead).length, mode:Generation.mode,
      pending:Generation.pending.size, readyResults:Generation.results.length,
      readyBytes:Generation.results.reduce((n,r) => n + r.bytes, 0),
      reservedBytes:Generation.pool.reduce((n,s) => n + (s.job ? s.job.estimate : 0), 0),
      residentBytes:cacheBytes, cacheOverBudget:cacheBytes > CFG.CACHE_BYTES,
      visible:visible.length, missing:visible.filter(c => !cache.has(c.key)).length,
      drawCalls:renderer.info.render.calls, triangles:renderer.info.render.triangles };
  }
};
window.showroomPerformance = () => Perf.snapshot();
window.resetShowroomPerformance = () => Perf.reset();
const perfOptions = new URLSearchParams(location.search);
const forceFullGeometry = perfOptions.get('fullGeometry') === '1';
const requestedWorkers = perfOptions.has('workers') ? Number(perfOptions.get('workers')) : null;
const workerCount = [0,1,2,4].includes(requestedWorkers) ? requestedWorkers
  : (navigator.hardwareConcurrency >= 4 ? 2 : 1);
const Generation = {
  revision:0, serial:0, paused:false, suspended:false, pool:[], pending:new Map(), results:[], failures:new Map(),
  mode:workerCount ? 'starting workers' : 'compatibility', dispatches:0,
  resultLimit:Math.max(4, workerCount * 16)
};

function generationToken(type, key){ return Generation.revision + '/' + type + '/' + key; }
function jobIsCurrent(job){
  return !Generation.paused && job.revision === Generation.revision && job.key === keyOf(job.i, job.j)
    && (job.type !== 'analyze' || cache.get(job.key) === job.specimen);
}
function isDemanded(job){
  return visKeys.has(job.key) || (job.i === Focus.i && job.j === Focus.j)
    || (Pin.want && job.i === Pin.want.i && job.j === Pin.want.j);
}
function invalidateGeneration(paused){
  Generation.revision++;
  Generation.paused = paused;
  Generation.pending.clear(); Generation.results.length = 0; Generation.failures.clear();
  Perf.populationMs = null; Perf.epochStarted = performance.now();
  // Active workers finish their one job. Revision checks discard the obsolete result.
}
function generationFailure(job, error){
  if (!job) return;
  Generation.pending.delete(job.token);
  if (!jobIsCurrent(job)) return;
  const tries = (Generation.failures.get(job.token)?.tries || 0) + 1;
  Generation.failures.set(job.token, { tries, message:String(error) });
  if (tries >= 2) console.warn('Specimen generation failed', job.key, error);
}
function finishGeneration(slot, message){
  const job = slot.job;
  if (!job || message.jobId !== job.jobId) return;
  clearTimeout(slot.timer); slot.timer = null; slot.job = null;
  if (message.error){
    generationFailure(job, message.error);
    if (slot.worker) restartGenerationWorker(slot);
    return;
  }
  if (!jobIsCurrent(job) || !isDemanded(job)){
    Generation.pending.delete(job.token); Perf.discarded++; return;
  }
  const result = message.result;
  const bytes = job.type === 'build' ? result.geometry.bytes + result.occ.byteLength : 0;
  Generation.results.push({ job, result, bytes });
  const source = slot.worker ? 'worker.' : 'compatibility.';
  if (result.timings) for (const [name,ms] of Object.entries(result.timings)) Perf.sample(source+name, ms);
  if (result.analysisMs != null) Perf.sample(source+'analysis', result.analysisMs);
}
function restartGenerationWorker(slot){
  clearTimeout(slot.timer);
  if (slot.worker){ slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null; slot.worker.terminate(); }
  slot.worker = null; slot.ready = false;
  if (slot.restarts++ < 1) startGenerationWorker(slot);
  else slot.dead = true;
  if (Generation.pool.every(s => s.dead)){
    Generation.mode = 'compatibility';
    console.warn('Workers unavailable; using conservative main-thread generation.');
  }
}
function startGenerationWorker(slot){
  const fail = error => {
    const job = slot.job; slot.job = null;
    generationFailure(job, error);
    restartGenerationWorker(slot);
  };
  try {
    // Module worker; browsers without module-worker support throw here and
    // fall through to the main-thread 'compatibility' path.
    const worker = slot.worker = new Worker(new URL('./core/worker.js', import.meta.url), {type:'module'});
    slot.timer = setTimeout(() => fail('Worker startup timed out'), 10000);
    worker.onerror = event => { event.preventDefault(); fail(event.message || 'Worker error'); };
    worker.onmessageerror = () => fail('Invalid worker message');
    worker.onmessage = ({data}) => {
      if (data.ready){
        clearTimeout(slot.timer); slot.timer = null; slot.ready = true;
        Generation.mode = 'workers';
      } else finishGeneration(slot, data);
      dispatchGeneration();
    };
    slot.fail = fail;
  } catch (error){ fail(error.message); }
}
function startGeneration(){
  if (!workerCount) return;
  // Allocate slots first: startup failures must see the complete pool.
  Generation.pool = Array.from({length:workerCount}, () => ({worker:null, job:null, ready:false, dead:false, restarts:0}));
  try {
    for (const slot of Generation.pool) startGenerationWorker(slot);
  } catch (error){
    for (const slot of Generation.pool) slot.dead = true;
    Generation.mode = 'compatibility'; console.warn('Worker setup failed', error);
  }
}
window.addEventListener('pagehide', () => {
  Generation.suspended = true;
  for (const slot of Generation.pool){
    clearTimeout(slot.timer);
    if (slot.worker){
      slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
      slot.worker.terminate();
    }
  }
  Generation.pool = []; Generation.pending.clear(); Generation.results.length = 0;
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  // Resume a back/forward-cached page without losing its unsaved catalogue settings.
  Generation.suspended = false;
  Generation.mode = workerCount ? 'starting workers' : 'compatibility';
  startGeneration();
});

function nextGenerationJob(){
  const analyze = () => {
    const key = keyOf(Focus.i, Focus.j), p = cache.get(key), token = generationToken('analyze', key);
    if (!p || p.aut >= 0 || Generation.pending.has(token) || (Generation.failures.get(token)?.tries || 0) >= 2) return null;
    return { type:'analyze', i:Focus.i, j:Focus.j, key, token, specimen:p, estimate:p.occ.byteLength,
      // Structured cloning copies this small occupancy buffer; never detach the cached original.
      payload:{ occ:p.occ, R:p.R } };
  };
  const priority = [];
  if (Pin.want) priority.push(Pin.want);
  priority.push(Focus);
  const makeBuild = c => {
    const key = keyOf(c.i,c.j), token = generationToken('build', key);
    if (cache.has(key) || Generation.pending.has(token) || (Generation.failures.get(token)?.tries || 0) >= 2) return null;
    const rec = cellRecipe(c.i,c.j), levels = Levels.map(l => ({...l})), R = levelResolution(levels);
    rec.P.tierSymmetry = TierSymmetry;
    return { type:'build', i:c.i, j:c.j, key, token, rec, levels,
      // Six independent quads per cell, 32-bit indices, occupancy, plus the
      // colOrbit buffer alongside the existing gamut one: conservative reservation.
      estimate:R*R*R*(6*216+1), payload:{recipe:rec.P, levels} };
  };
  for (const c of priority){ const job = makeBuild(c); if (job) return job; }
  if (Generation.dispatches % 4 === 3){ const job = analyze(); if (job) return job; }
  for (const c of visible){ const job = makeBuild(c); if (job) return job; }
  return analyze();
}
function serviceGeneration(){
  if (Generation.paused) return;
  const started = performance.now();
  // Re-check demand even after a result was queued, since the camera/settings can change meanwhile.
  Generation.results = Generation.results.filter(item => {
    if (jobIsCurrent(item.job) && isDemanded(item.job)) return true;
    Generation.pending.delete(item.job.token); Perf.discarded++; return false;
  });
  const rank = item => item.job.i === Focus.i && item.job.j === Focus.j ? -2
    : Pin.want && item.job.i === Pin.want.i && item.job.j === Pin.want.j ? -1
    : (cellWorldX(item.job.i)-camera.position.x)**2 + (cellWorldZ(item.job.j)-camera.position.z)**2;
  Generation.results.sort((a,b) => rank(a)-rank(b));
  let accepted = 0, admittedBytes = 0;
  while (Generation.results.length && accepted < 32){
    const item = Generation.results[0], {job,result} = item;
    if (accepted && (performance.now()-started >= CFG.INSTALL_MS || admittedBytes+item.bytes > CFG.UPLOAD_BYTES)) break;
    Generation.results.shift(); Generation.pending.delete(job.token); Generation.failures.delete(job.token);
    if (job.type === 'build'){
      const p = { ...job.rec.P, occ:result.occ, R:result.R, levels:job.levels,
        filled:result.filled, envelopeCells:result.envelopeCells,
        geo:geometryFromArrays(result.geometry), geoLod:null, tris:result.geometry.tris,
        aut:-1, seen:seenTick, kin:job.rec.kin, bytes:item.bytes, revision:job.revision };
      cache.set(job.key,p); cacheBytes += p.bytes; Perf.installed++;
      labelsDirty = true;
      evict();
    } else job.specimen.aut = result.aut;
    accepted++; admittedBytes += item.bytes;
  }
  Perf.sample('main.install', performance.now()-started);
  dispatchGeneration();
  if (Perf.populationMs === null && visible.every(c => cache.has(c.key)))
    Perf.populationMs = performance.now() - Perf.epochStarted;
}


// Refill idle workers on completion, not just at RAF cadence. The bounded ready
// queue absorbs bursts; install time and upload bytes determine admission per frame.
function dispatchGeneration(){
  if (Generation.paused || Generation.suspended || document.hidden) return;
  const available = Generation.mode === 'compatibility' ? [{job:null,worker:null}]
    : Generation.pool.filter(s => s.ready && !s.dead && !s.job);
  for (const slot of available){
    const active = Generation.pool.filter(s => s.job);
    if (Generation.results.length + active.length >= Generation.resultLimit) break;
    const reserved = active.reduce((n,s) => n+s.job.estimate, 0)
      + Generation.results.reduce((n,r) => n+r.bytes, 0);
    const job = nextGenerationJob();
    if (!job) break;
    if (reserved && reserved+job.estimate > CFG.RESULT_BYTES) break;
    job.revision = Generation.revision; job.jobId = ++Generation.serial;
    const message = {type:job.type, jobId:job.jobId, ...job.payload};
    Generation.pending.set(job.token,job); Generation.dispatches++; slot.job = job;
    if (slot.worker){
      slot.timer = setTimeout(() => slot.fail('Worker job timed out'), 30000);
      try { slot.worker.postMessage(message); } catch (error){ slot.fail(error.message); }
    } else {
      // At most one complete job per compatibility frame. A single build cannot be preempted.
      const t0 = performance.now();
      try { finishGeneration(slot, {jobId:job.jobId, result:runNumericJob(Core,message)}); }
      catch (error){ finishGeneration(slot, {jobId:job.jobId,error:error.message}); }
      Perf.sample('main.compatibility', performance.now()-t0);
    }
  }
}

function flushLattice(){
  invalidateGeneration(false);
  labelsDirty = true;
  for (const [k, s] of slots){ releaseSlot(s); }
  slots.clear();
  for (const p of cache.values()){
    p.geo.dispose();
    if (p.geoLod) p.geoLod.dispose();
  }
  cache.clear();
  cacheBytes = 0;
  needVis = true;
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

  for (const c of visible){
    const p = cache.get(c.key);
    if (!p) continue;
    p.seen = seenTick;

    let s = slots.get(c.key);
    if (!s){
      const hh = hash32(c.i, c.j);
      s = { mesh: takeMesh(), i: c.i, j: c.j, age: 0,
            ph: (hh & 1023) / 1023 * TAU,
            rate: (((hh >>> 10) & 255) / 255 - 0.5) * 1.4 };
      slots.set(c.key, s);
    }
    const entering = s.age < 1;
    s.age = Math.min(1, s.age + dt * 3.4);

    const wx = cellWorldX(c.i), wz = cellWorldZ(c.j);
    const dist = Math.hypot(camera.position.x - wx, camera.position.y, camera.position.z - wz);
    const px = CFG.BLOCK_S * projK / Math.max(dist, 0.001);

    const useLod = !forceFullGeometry && px < CFG.LOD_PX;
    const lodStarted = useLod && !p.geoLod ? performance.now() : null;
    const geo = useLod ? lodOf(p) : p.geo;
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
  const reach = 34 + Rig.h * 4.2;
  floor.position.set(Rig.x, 0, Rig.z);
  floor.scale.set(reach * 2.6, reach * 2.6, 1);
  floorMat.uniforms.uCenter.value.set(Rig.x, Rig.z);
  floorMat.uniforms.uCell.value = CFG.CELL;
  floorMat.uniforms.uFade.value = reach;
  floorMat.uniforms.uPeriod.value.set(
    ROLE_BY_ID[Axis.x].count || 8,
    ROLE_BY_ID[Axis.y].count || 8
  );
  floorMat.uniforms.uPinOn.value = (Pin.on && Pin.params) ? 1 : 0;
  floorMat.uniforms.uPinC.value.set(cellWorldX(Pin.i), cellWorldZ(Pin.j));
  floorMat.uniforms.uPinR.value = (Pin.radius + 0.5) * CFG.CELL;

  scene.fog.density = State.haze * 1.35 / (16 + Rig.h * 3.4);

  const fr = 0.62 + 0.05 * Math.sin(t * 2.4);
  focusRing.position.set(cellWorldX(Focus.i), 0.02, cellWorldZ(Focus.j));
  focusRing.scale.setScalar(CFG.CELL * 0.44 * fr / 0.62);
  hoverRing.position.set(cellWorldX(Hover.i), 0.016, cellWorldZ(Hover.j));
  hoverRing.scale.setScalar(CFG.CELL * 0.46);
  hoverRing.visible = Hover.on && !(Hover.i === Focus.i && Hover.j === Focus.j);
}

/* =====================================================================
   FLOOR LABELS — a 2D overlay rather than sprites, so the type stays
   crisp at any zoom and costs one canvas pass instead of N textures.
   ===================================================================== */
const labelCanvas = document.getElementById('labels');
const lctx = labelCanvas.getContext('2d');
let labelsDirty = true;
const labelPose = { x:NaN, z:NaN, h:NaN, tilt:NaN, yaw:NaN };

function sizeLabels(){
  labelsDirty = true;
  const dpr = Math.min(window.devicePixelRatio, 2);
  labelCanvas.width  = Math.floor(window.innerWidth  * dpr);
  labelCanvas.height = Math.floor(window.innerHeight * dpr);
  labelCanvas.style.width  = window.innerWidth  + 'px';
  labelCanvas.style.height = window.innerHeight + 'px';
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeLabels();

function drawLabels(){
  if (!labelsDirty) return;
  labelsDirty = false;
  lctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (!State.labels || Rig.h > 30) return;

  const detail = Rig.h < 13;
  lctx.textAlign = 'center';
  lctx.textBaseline = 'middle';
  lctx.font = '9px ui-monospace, Menlo, Consolas, monospace';

  let n = 0;
  for (const c of visible){
    if (n > 220) break;
    const p = cache.get(c.key);
    if (!p) continue;
    _p3.set(cellWorldX(c.i), 0.02, cellWorldZ(c.j) + CFG.CELL * 0.46);
    _p3.project(camera);
    if (_p3.z > 1) continue;
    const sx = (_p3.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_p3.y * 0.5 + 0.5) * window.innerHeight;
    if (sx < -60 || sy < -20 || sx > window.innerWidth + 60 || sy > window.innerHeight + 20) continue;

    const isFocus = (c.i === Focus.i && c.j === Focus.j);
    lctx.fillStyle = isFocus ? 'rgba(0,245,212,0.92)' : 'rgba(170,198,255,0.36)';
    lctx.fillText(c.i + ',' + c.j, sx, sy);
    if (detail){
      lctx.fillStyle = isFocus ? 'rgba(255,62,165,0.85)' : 'rgba(150,178,240,0.22)';
      lctx.fillText(ARCH_NAMES[p.arch] + ' · ' + symmetryLabel(p,true), sx, sy + 11);
    }
    n++;
  }
}

/* =====================================================================
   STATE, FOCUS, HUD
   ===================================================================== */
const State = {
  align: false, labels: true, legend: true,
  spin: 0.34, haze: 0.42, time: 0,
  colorMode: 'gamut'   // 'gamut' | 'chiral' — see specimenChiral() below
};
const Bloom = { on: false };
const Focus = { i:0, j:0 };
const Hover = { i:0, j:0, on:false };

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

function focusedData(){ return cache.get(keyOf(Focus.i, Focus.j)) || null; }

function refreshInspector(){
  const p = focusedData();
  if (!p){
    elInspect.innerHTML = `<span class="k">cell</span> <b>${Focus.i}, ${Focus.j}</b>\n<span class="k">${(Generation.failures.get(generationToken('build', keyOf(Focus.i,Focus.j)))?.tries || 0) >= 2 ? 'generation failed — shuffle to retry' : 'minting…'}</span>`;
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
    `<span class="k">${p.tierSymmetry ? 'whole-grid order' : 'aut-order'}</span> <b>${p.aut < 0 ? ((Generation.failures.get(generationToken('analyze', keyOf(Focus.i,Focus.j)))?.tries || 0) >= 2 ? 'unavailable' : 'calculating…') : p.aut}</b> <span class="k">${p.tierSymmetry ? 'rigid transforms' : 'of '+g.order}</span>\n` +
    `<span class="k">voxels</span> <b>${p.filled}</b> <span class="k">/ ${p.envelopeCells}</span>\n` +
    `<span class="k">density</span> <b>${(p.density * 100).toFixed(0)}%</b>\n` +
    `<span class="k">seed</span> <b>#${(p.seed >>> 0).toString(16).padStart(8,'0')}</b>\n` +
    (p.kin
      ? `<span class="k">kin</span> <b>ring ${p.kin.ring}</b> <span class="k">of ${Pin.radius} · ${p.kin.drift.length ? 'drift ' + p.kin.drift.join(' ') : 'pure inheritance'}</span>\n`
      : '') +
    `<span class="k">resident</span> <b>${cache.size}</b> <span class="k">blocks · ${(cacheBytes/1048576).toFixed(0)} MB · ${visible.length} nearby</span>\n` +
    `<span class="k">stream tris</span> <b>${(frameTris / 1000).toFixed(0)}k</b> <span class="k">· ${fps.toFixed(0)} fps</span>\n` +
    `<span class="k">generation</span> <b>${Generation.mode === 'workers' ? Generation.pool.filter(s => !s.dead).length + ' workers' : Generation.mode}</b> <span class="k">· ${Generation.pending.size} pending${cacheBytes > CFG.CACHE_BYTES ? ' · visible set over cache target' : ''}</span>`;
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
  const p = cache.get(keyOf(i, j));
  if (!p){ Pin.want = { i, j }; return false; }
  Pin.params = { sym:p.sym, arch:p.arch, field:p.field,
                 lift:p.lift, density:p.density, seed:p.seed };
  Pin.i = i; Pin.j = j; Pin.on = true; Pin.epoch++;
  Pin.want = null;
  needVis = true;
  refreshInspector();
  return true;
}

function unpin(){
  if (!Pin.on) return;
  Pin.on = false; Pin.want = null; Pin.epoch++;
  needVis = true;
  refreshInspector();
}

function setFocus(i, j, announce){
  labelsDirty = true;
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
let needVis = true;
let lastVisX = 1e9, lastVisZ = 1e9, lastVisH = 0, lastVisYaw = 0, lastVisTilt = 0;

function markMoved(){
  labelsDirty = true;
  if (Math.abs(Rig.x - lastVisX) > CFG.CELL * 0.34 ||
      Math.abs(Rig.z - lastVisZ) > CFG.CELL * 0.34 ||
      Math.abs(Rig.h - lastVisH) > lastVisH * 0.03 ||
      Math.abs(Rig.yaw - lastVisYaw) > 0.03 ||
      Math.abs(Rig.tilt - lastVisTilt) > 0.03) needVis = true;
}

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
  Rig.vx = Rig.vz = 0;
  if (e.shiftKey || e.button === 2 || e.button === 1){
    dragMode = 'orbit';
  } else {
    dragMode = 'pan';
    applyRig();
    ndcOf(e, _v2);
    groundAt(_v2.x, _v2.y, _hit);
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
      zoomBy(pinchDist / d, 0, 0);
      pinchDist = d;
    }
    return;
  }

  if (dragMode === 'orbit' && prev){
    const rect = renderer.domElement.getBoundingClientRect();
    Rig.yaw  -= (e.movementX || 0) * 0.005;
    Rig.tilt = clamp(Rig.tilt + (e.movementY || 0) * 0.004, 0.52, 1.535);
    setTiltSlider();
    applyRig(); markMoved();
    return;
  }

  if (dragMode === 'pan' && dragAnchor){
    ndcOf(e, _v2);
    groundAt(_v2.x, _v2.y, _hit);
    const dx = _hit.x - dragAnchor.x, dz = _hit.z - dragAnchor.z;
    Rig.x -= dx; Rig.z -= dz;
    Rig.vx = -dx * 14; Rig.vz = -dz * 14;
    applyRig(); markMoved();
    return;
  }

  // Idle hover: the cell under the cursor, straight from the plane.
  ndcOf(e, _v2);
  if (groundAt(_v2.x, _v2.y, _hit)){
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
      Rig.vx = Rig.vz = 0;
      ndcOf(e, _v2);
      if (groundAt(_v2.x, _v2.y, _hit))
        setFocus(Math.round(_hit.x / CFG.CELL), Math.round(-_hit.z / CFG.CELL), true);
    }
  }
  if (pointers.size < 2){ dragMode = null; dragAnchor = null; dragStart = null; }
}
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

/* Zooming keeps whatever sits under the cursor pinned in place: the rig
   translates only, so one correction pass is exact. */
function zoomBy(factor, ndcx, ndcy){
  applyRig();
  groundAt(ndcx, ndcy, _a3);
  Rig.h = clamp(Rig.h * factor, 2.6, 96);
  applyRig();
  groundAt(ndcx, ndcy, _b3);
  Rig.x += _a3.x - _b3.x;
  Rig.z += _a3.z - _b3.z;
  applyRig();
  markMoved();
}

renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  ndcOf(e, _v2);
  zoomBy(Math.exp(clamp(e.deltaY, -160, 160) * 0.0013), _v2.x, _v2.y);
}, { passive: false });

function glideTo(i, j, height){
  const from = { x: Rig.x, z: Rig.z, h: Rig.h };
  const to = { x: cellWorldX(i), z: cellWorldZ(j), h: height != null ? height : Rig.h };
  Rig.vx = Rig.vz = 0;
  new TWEEN.Tween(from).to(to, 900).easing(TWEEN.Easing.Cubic.InOut)
    .onUpdate(() => { Rig.x = from.x; Rig.z = from.z; Rig.h = from.h; markMoved(); })
    .start();
}

/* =====================================================================
   URL ADDRESS — the lattice is deterministic, so a coordinate is a
   shareable permalink into the catalogue.
   ===================================================================== */
let hashTimer = 0;
function writeHash(){ hashTimer = 0.6; }
function hashString(){
  const base = `#${Math.round(Rig.x / CFG.CELL)},${Math.round(-Rig.z / CFG.CELL)},${Rig.h.toFixed(1)},${Mint.gen}`;
  return (Pin.on && Pin.params) ? `${base},${Pin.i}.${Pin.j}.${Pin.radius}` : base;
}
function commitHash(){
  const h = hashString();
  if (location.hash === h) return;
  // Some browsers refuse replaceState on file:// URLs; the lattice does not
  // care, so a refusal is noted and ignored rather than thrown.
  try { history.replaceState(null, '', h); }
  catch (err){ console.debug('address bar not writable here', err.name); }
}
function readHash(){
  const m = /^#(-?\d+),(-?\d+)(?:,([\d.]+))?(?:,(\d+))?(?:,(-?\d+)\.(-?\d+)\.(\d+))?$/.exec(location.hash || '');
  if (!m) return false;
  Rig.x = cellWorldX(parseInt(m[1], 10));
  Rig.z = cellWorldZ(parseInt(m[2], 10));
  if (m[3]) Rig.h = clamp(parseFloat(m[3]), 2.6, 96);
  if (m[4]) Mint.gen = parseInt(m[4], 10);
  setFocus(parseInt(m[1], 10), parseInt(m[2], 10), false);
  if (m[5] !== undefined){
    // The pin's anchor has to exist before it can be read, so the request
    // is parked and the frame loop retries once minting reaches it.
    Pin.radius = clamp(parseInt(m[7], 10), 2, 8);
    inKin.value = String(Pin.radius);
    Bloom.on = true;
    btnBloom.classList.add('on');
    Pin.want = { i: parseInt(m[5], 10), j: parseInt(m[6], 10) };
  }
  return true;
}

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
function applyConfiguration(){ invalidateGeneration(true); commitConfiguration(); }
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

document.getElementById('tierSymmetry').onchange=e=>{ TierSymmetry=e.target.checked; renderLevelRows(); applyLevels(); };
function tierExample(outer,inner){
  if(Levels.length<2) Levels=[{radix:3,gap:.30},{radix:3,gap:.06}];
  Levels=Levels.map((l,i)=>({...l,sym:i===0?outer:inner}));
  TierSymmetry=true; document.getElementById('tierSymmetry').checked=true;
  renderLevelRows(); applyLevels();
}
document.getElementById('tierMirrorSpin').onclick=()=>tierExample(1,5);
document.getElementById('tierCubeFree').onclick=()=>tierExample(9,0);

function renderLevelRows(){
  lvRows.innerHTML = '';
  Levels.forEach((lv, i) => {
    const row = document.createElement('div'); row.className = 'lvrow';
    row.innerHTML =
      `<span class="idx">${i===0?'out':(i===Levels.length-1?'in':i)}</span>` +
      `<input type="number" min="2" max="12" value="${lv.radix}" data-i="${i}" class="radixIn">` +
      `<input type="range" min="0" max="100" value="${Math.round(lv.gap*100)}" data-i="${i}" class="gapIn" title="Sibling spacing at this tier (% of child width)">` +
      `<span class="gapv">${lv.gap.toFixed(2)}</span>` +
      `<button data-i="${i}" class="delBtn" title="remove this level">×</button>`;
    const select=document.createElement('select');
    select.className='tierGroup'; select.disabled=!TierSymmetry;
    select.setAttribute('aria-label',`Tier ${i+1} symmetry`);
    select.add(new Option('inherit specimen group', '-1'));
    GROUPS.forEach((g,j)=>select.add(new Option(g.name+' ('+g.order+')',String(j))));
    select.value=String(lv.sym ?? -1);
    select.onchange=()=>{ lv.sym=+select.value; applyLevels(); };
    row.appendChild(select);
    lvRows.appendChild(row);
  });
  const R = levelResolution(Levels);
  resLine.textContent = `R=${R} · ${(R*R*R).toLocaleString()} cells`;

  lvRows.querySelectorAll('.radixIn').forEach(el => el.onchange = e => {
    const i = +e.target.dataset.i, want = Math.max(2, Math.min(12, parseInt(e.target.value) || 2));
    const trial = Levels.map((l,k) => k===i ? { ...l, radix:want } : l);
    if (levelResolution(trial) > MAX_R){
      console.warn(`[bimoblock] radix change rejected: R would exceed MAX_R=${MAX_R}`);
      setStatus(`too large — R capped at ${MAX_R}`);
      e.target.value = Levels[i].radix;
      return;
    }
    Levels[i].radix = want;
    renderLevelRows();
    setStatus(`levels [${Levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Levels)}`);
    applyLevels();
  });
  lvRows.querySelectorAll('.gapIn').forEach(el => el.oninput = e => {
    const i = +e.target.dataset.i;
    Levels[i].gap = (+e.target.value) / 100;
    e.target.parentElement.querySelector('.gapv').textContent = Levels[i].gap.toFixed(2);
    setStatus(`${i===0?'outer':i===Levels.length-1?'inner':'level '+i} tier gap ${Math.round(Levels[i].gap*100)}%`);
    applyLevels();
  });
  lvRows.querySelectorAll('.delBtn').forEach(el => el.onclick = e => {
    if (Levels.length <= 1) return;
    Levels.splice(+e.target.dataset.i, 1);
    renderLevelRows();
    setStatus(`levels [${Levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Levels)}`);
    applyLevels();
  });
}
document.getElementById('btnAddLevel').addEventListener('click', () => {
  const trial = [...Levels, { radix:3, gap:0.1 }];
  if (levelResolution(trial) > MAX_R){
    console.warn(`[bimoblock] add-level rejected: R would exceed MAX_R=${MAX_R}`);
    setStatus(`too large — R capped at ${MAX_R}`);
    return;
  }
  Levels.push({ radix:3, gap:0.1 });
  renderLevelRows();
  setStatus(`levels [${Levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Levels)}`);
  applyLevels();
});
document.getElementById('btnDelLevel').addEventListener('click', () => {
  if (Levels.length <= 1) return;
  Levels.pop();
  renderLevelRows();
  setStatus(`levels [${Levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Levels)}`);
  applyLevels();
});
document.querySelectorAll('#levelsPanel .presets button').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset;
  const next = PRESETS[p] || Levels;
  if (levelResolution(next) > MAX_R){
    console.warn(`[bimoblock] preset '${p}' rejected: R=${levelResolution(next)} exceeds MAX_R=${MAX_R}`);
    setStatus(`preset too large — R capped at ${MAX_R}`);
    return;
  }
  Levels = next.map((l,i)=>({...l,sym:Levels[i]?.sym ?? -1}));
  renderLevelRows();
  setStatus(`levels [${Levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Levels)}`);
  applyLevels();
}));
renderLevelRows();

inPitch.addEventListener('input', () => {
  CFG.CELL = parseInt(inPitch.value, 10) / 10;
  needVis = true;
  setStatus('lattice pitch ' + CFG.CELL.toFixed(1));
});
inSize.addEventListener('input', () => {
  CFG.BLOCK_S = parseInt(inSize.value, 10) / 100;
  setStatus('specimen size ' + CFG.BLOCK_S.toFixed(2));
});
inTilt.addEventListener('input', () => {
  Rig.tilt = parseInt(inTilt.value, 10) * Math.PI / 180;
  Rig.tilt = clamp(Rig.tilt, 0.52, 1.535);
  applyRig(); needVis = true;
});
function setTiltSlider(){ inTilt.value = String(Math.round(Rig.tilt * 180 / Math.PI)); }
inSpin.addEventListener('input', () => { State.spin = parseInt(inSpin.value, 10) / 100; });
inHaze.addEventListener('input', () => { State.haze = parseInt(inHaze.value, 10) / 100; });

inKin.addEventListener('input', () => {
  Pin.radius = parseInt(inKin.value, 10);
  const n = 2 * Pin.radius + 1;
  setStatus('district radius ' + Pin.radius + '  ·  ' + (n * n) + ' relatives');
  if (Pin.on){ Pin.epoch++; needVis = true; }
});

inHoriz.addEventListener('input', () => {
  CFG.MAX_VISIBLE = Math.min(CFG.POD_MAX, parseInt(inHoriz.value, 10));
  needVis = true;
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

btnHome.addEventListener('click', () => { glideTo(0, 0, 15); setFocus(0, 0, false); setStatus('returned to origin'); });
btnWarp.addEventListener('click', () => {
  const i = (Math.random() * 2000 - 1000) | 0, j = (Math.random() * 2000 - 1000) | 0;
  Rig.x = cellWorldX(i); Rig.z = cellWorldZ(j);
  Rig.vx = Rig.vz = 0;
  needVis = true;
  setFocus(i, j, false);
  showToast(`warped to district ${i}, ${j}`);
});
btnAlign.addEventListener('click', () => {
  State.align = !State.align;
  btnAlign.classList.toggle('on', State.align);
  setStatus(State.align ? 'specimens aligned for comparison' : 'idle rotation resumed');
});
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
  labelsDirty = true;
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
  const far = Math.hypot(cellWorldX(i) - Rig.x, cellWorldZ(j) - Rig.z) > CFG.CELL * 26;
  if (far){ Rig.x = cellWorldX(i); Rig.z = cellWorldZ(j); needVis = true; }
  else glideTo(i, j);
  setFocus(i, j, false);
  inGoto.blur();
  showToast(`cell ${i}, ${j}`);
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const step = e.shiftKey ? 5 : 1;
  switch (e.key){
    case 'ArrowLeft':  glideTo(Focus.i - step, Focus.j); setFocus(Focus.i - step, Focus.j, false); e.preventDefault(); break;
    case 'ArrowRight': glideTo(Focus.i + step, Focus.j); setFocus(Focus.i + step, Focus.j, false); e.preventDefault(); break;
    case 'ArrowUp':    glideTo(Focus.i, Focus.j + step); setFocus(Focus.i, Focus.j + step, false); e.preventDefault(); break;
    case 'ArrowDown':  glideTo(Focus.i, Focus.j - step); setFocus(Focus.i, Focus.j - step, false); e.preventDefault(); break;
    case '[': setFocus(Focus.i - 1, Focus.j, true); break;
    case ']': setFocus(Focus.i + 1, Focus.j, true); break;
    case 'a': case 'A': btnAlign.click(); break;
    case 'b': case 'B': btnBloom.click(); break;
    case 'l': case 'L': btnLabels.click(); break;
    case 'k': case 'K': btnKey.click(); break;
    case 'g': case 'G': btnShuf.click(); break;
    case 'h': case 'H': btnHome.click(); break;
    case 'w': case 'W': btnWarp.click(); break;
    case 'o': case 'O': exportSpecimenOBJ(); break;
    case 'e': case 'E': exportSheetOBJ(); break;
    case 'c': case 'C': copyAddress(); break;
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizeLabels();
  needVis = true;
});

function copyAddress(){
  commitHash();
  const text = location.href.split('#')[0] + hashString();
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
function download(blob, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function specimenName(p){
  return `bimoblock_${p.tierSymmetry?'tiers_':''}${symmetryLabel(p,true).replaceAll(' / ','-')}_${ARCH_NAMES[p.arch]}_${(p.seed >>> 0).toString(16).padStart(8,'0')}`;
}

function exportSpecimenOBJ(){
  const p = focusedData();
  if (!p) return;
  const R = p.R;
  const lines = [
    `# bimoblock specimen — ${specimenName(p)}`,
    `# lattice cell: ${Focus.i}, ${Focus.j}   generation: ${Mint.gen}`,
    `# group: ${symmetryLabel(p)}  archetype: ${ARCH_NAMES[p.arch]}  field: ${FIELD_NAMES[p.field]}`,
    `# symmetry mode: ${p.tierSymmetry ? 'independent address tiers (outer to inner)' : 'coupled whole-grid'}`,
    `# levels: [${p.levels.map(l=>l.radix).join('×')}]  resolution: ${R}`,
    `# gaps: [${p.levels.map(l=>l.gap.toFixed(2)).join(', ')}] (fraction of child width)`,
    `# format: v X Y Z R G B (normalized local gamut colors), vn NX NY NZ, f v1//vn1 v2//vn2 v3//vn3`,
    ""
  ];
  const pos = p.geo.getAttribute('position');
  const col = p.geo.getAttribute('color');
  const nrm = p.geo.getAttribute('normal');
  let vi = 1;
  for (let k = 0; k < pos.count; k += 4){
    for (let q = 0; q < 4; q++){
      const n = k + q;
      lines.push(`v ${pos.getX(n).toFixed(4)} ${pos.getY(n).toFixed(4)} ${pos.getZ(n).toFixed(4)} ` +
                 `${col.getX(n).toFixed(4)} ${col.getY(n).toFixed(4)} ${col.getZ(n).toFixed(4)}`);
      lines.push(`vn ${nrm.getX(n).toFixed(4)} ${nrm.getY(n).toFixed(4)} ${nrm.getZ(n).toFixed(4)}`);
    }
    lines.push(`f ${vi}//${vi} ${vi+1}//${vi+1} ${vi+2}//${vi+2} ${vi+3}//${vi+3}`);
    vi += 4;
  }
  const quads = pos.count / 4;
  download(new Blob([lines.join("\n")], { type:'text/plain' }), specimenName(p) + '.obj');
  showToast(`${specimenName(p)}.obj exported (${quads} quads)`);
}

/* Everything currently standing in the showroom, exported flat on the
   lattice at full resolution regardless of the LOD used on screen. */
function exportSheetOBJ(){
  const lines = [
    `# bimoblock showroom — visible lattice sheet`,
    `# generated: ${new Date().toISOString()}`,
    `# centre cell: ${Math.round(Rig.x / CFG.CELL)}, ${Math.round(-Rig.z / CFG.CELL)}   generation: ${Mint.gen}`,
    `# axes: x → ${ROLE_BY_ID[Axis.x].label}   y → ${ROLE_BY_ID[Axis.y].label}`,
    `# levels: [${Levels.map(l=>l.radix).join('×')}]  gaps: [${Levels.map(l=>l.gap.toFixed(2)).join(', ')}]`,
    `# format: v X Y Z R G B (normalized local gamut colors), vn NX NY NZ, f v1//vn1 v2//vn2 v3//vn3`,
    ""
  ];

  let vCount = 1, tris = 0, blocks = 0;
  const S = CFG.BLOCK_S;

  for (const c of visible){
    const p = cache.get(c.key);
    if (!p) continue;
    const geo = p.geo;
    const posAttr = geo.getAttribute('position');
    const colAttr = geo.getAttribute('color');
    const nrmAttr = geo.getAttribute('normal');
    const idxAttr = geo.getIndex();
    if (!posAttr || posAttr.count === 0) continue;

    const ox = cellWorldX(c.i), oz = cellWorldZ(c.j), oy = S * 0.5 + 0.42;
    lines.push(`# symmetry mode: ${p.tierSymmetry ? 'independent address tiers' : 'coupled whole-grid'}; groups: ${symmetryLabel(p)}; radices: ${p.levels.map(l=>l.radix).join(',')}`);
    lines.push(`o cell_${c.i}_${c.j}_${symmetryLabel(p,true).replaceAll(' / ','-')}_${ARCH_NAMES[p.arch]}`);
    for (let k = 0; k < posAttr.count; k++){
      lines.push(`v ${(posAttr.getX(k)*S+ox).toFixed(4)} ${(posAttr.getY(k)*S+oy).toFixed(4)} ${(posAttr.getZ(k)*S+oz).toFixed(4)} ` +
                 `${colAttr.getX(k).toFixed(4)} ${colAttr.getY(k).toFixed(4)} ${colAttr.getZ(k).toFixed(4)}`);
      lines.push(`vn ${nrmAttr.getX(k).toFixed(4)} ${nrmAttr.getY(k).toFixed(4)} ${nrmAttr.getZ(k).toFixed(4)}`);
    }
    for (let k = 0; k < idxAttr.count; k += 3){
      const a = idxAttr.getX(k) + vCount, b = idxAttr.getX(k+1) + vCount, d = idxAttr.getX(k+2) + vCount;
      lines.push(`f ${a}//${a} ${b}//${b} ${d}//${d}`);
    }
    tris += idxAttr.count / 3;
    vCount += posAttr.count;
    blocks++;
  }

  const filename = `bimoblock_sheet_${Math.round(Rig.x / CFG.CELL)}_${Math.round(-Rig.z / CFG.CELL)}_g${Mint.gen}.obj`;
  download(new Blob([lines.join("\n")], { type:'text/plain' }), filename);
  showToast(`${filename} — ${blocks} specimens, ${tris.toLocaleString()} triangles`);
}

btnSheet.addEventListener('click', exportSheetOBJ);
btnObj.addEventListener('click', exportSpecimenOBJ);

/* =====================================================================
   MAIN LOOP
   ===================================================================== */
const clock = new THREE.Clock();
let fps = 60, hudT = 0;

syncFilterEnablement();
setTiltSlider();
elStatus.textContent = defaultStatus();
if (!readHash()) setFocus(0, 0, false);
applyRig();
computeVisible();
needVis = false;
lastVisX = Rig.x; lastVisZ = Rig.z; lastVisH = Rig.h; lastVisYaw = Rig.yaw; lastVisTilt = Rig.tilt;
startGeneration();

function frame(){
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  Perf.frame(rawDt * 1000);
  const dt = Math.min(rawDt, 0.05);
  State.time += dt;

  // Inertial glide after a flick.
  if (!dragMode && (Math.abs(Rig.vx) > 1e-4 || Math.abs(Rig.vz) > 1e-4)){
    Rig.x += Rig.vx * dt; Rig.z += Rig.vz * dt;
    const decay = Math.exp(-3.4 * dt);
    Rig.vx *= decay; Rig.vz *= decay;
    if (Math.abs(Rig.vx) < 1e-3 && Math.abs(Rig.vz) < 1e-3) Rig.vx = Rig.vz = 0;
    applyRig(); markMoved();
  }

  if (needVis){
    const visibilityStarted = performance.now();
    computeVisible();
    Perf.sample('main.visibility', performance.now() - visibilityStarted);
    needVis = false;
    lastVisX = Rig.x; lastVisZ = Rig.z; lastVisH = Rig.h;
    lastVisYaw = Rig.yaw; lastVisTilt = Rig.tilt;
  } else {
    applyRig();
  }

  serviceGeneration();

  // A parked pin (from a permalink, or a bloom requested before its
  // anchor had been minted) retries until the anchor exists.
  if (Pin.want) pinAt(Pin.want.i, Pin.want.j);

  const layoutStarted = performance.now();
  layout(State.time, dt);
  Perf.sample('main.layout', performance.now() - layoutStarted);

  if (hashTimer > 0){ hashTimer -= dt; if (hashTimer <= 0) commitHash(); }

  fps += (1 / Math.max(rawDt, 1e-4) - fps) * Math.min(1, dt * 3);
  hudT += dt;
  if (hudT >= 0.4){
    hudT = 0;
    refreshInspector();
    elCoord.textContent = Math.round(Rig.x / CFG.CELL) + ', ' + Math.round(-Rig.z / CFG.CELL);
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
  renderer.render(scene, camera);
  Perf.sample('main.renderSubmission', performance.now() - renderStarted);
  const labelStarted = performance.now();
  drawLabels();
  Perf.sample('main.labels', performance.now() - labelStarted);
}

frame();
