/* VIRTUALISATION — which cells exist right now.
   The lattice is unbounded; this class keeps the working set: a cache of
   generated block data (LRU by last-seen), a pool of recycled meshes bound
   to the cells currently on screen, and the nearest-first `visible` list
   that generation and layout both walk. */
import * as THREE from 'three';
import { CFG } from '../config.js';
import { Pin, Focus } from '../state.js';
import { blockGeometry, cellWorldX, cellWorldZ, inDistrict } from '../lattice/recipe.js';

export class Virtualiser {
  constructor(rig, blocksG){
    this.rig = rig;
    this.blocksG = blocksG;      // scene group the specimen meshes live in
    /** @type {Map<string, import('../types.js').BlockData>} */
    this.cache = new Map();      // key -> block data
    this.slots = new Map();      // key -> { mesh, i, j, age, ph, rate }
    this.spare = [];             // recycled meshes
    this.visible = [];           // [{i,j,key}] nearest first
    this.visKeys = new Set();
    this.seenTick = 0;
    this.cacheBytes = 0;
    /* Bumps whenever the visible list or the resident cache changes, so a
       consumer (the label overlay) can tell it has something new to draw. */
    this.revision = 0;
    this.dirty = true;           // a visibility pass is owed
    this._lastVis = { x:1e9, z:1e9, h:0, yaw:0, tilt:0 };
    this._hit = new THREE.Vector3();
    this.placeholder = new THREE.BufferGeometry();
    this.placeholder.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  }

  /* A district's content depends on the pin, so its cells are keyed by pin
     epoch as well as address.  Re-pinning therefore does not invalidate
     anything explicitly: the old district's entries simply stop being
     referenced and fall out under LRU, and unpinning re-exposes the plain
     keys that were already cached before the bloom. */
  keyOf(i, j){
    return inDistrict(i, j) ? i + ',' + j + '@' + Pin.epoch : i + ',' + j;
  }
  /* The cached block at an address, or null while it is still minting.
     @returns {import('../types.js').BlockData|null} */
  at(i, j){ return this.cache.get(this.keyOf(i, j)) || null; }

  invalidate(){ this.dirty = true; }
  /* Owed a pass, either explicitly or because the rig has moved far
     enough since the last one. Polled once per frame. */
  needsRefresh(){
    const r = this.rig, l = this._lastVis;
    return this.dirty ||
      Math.abs(r.x - l.x) > CFG.CELL * 0.34 ||
      Math.abs(r.z - l.z) > CFG.CELL * 0.34 ||
      Math.abs(r.h - l.h) > l.h * 0.03 ||
      Math.abs(r.yaw - l.yaw) > 0.03 ||
      Math.abs(r.tilt - l.tilt) > 0.03;
  }

  takeMesh(){
    const m = this.spare.pop();
    if (m){ m.visible = true; return m; }
    const mesh = new THREE.Mesh(this.placeholder, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.22, metalness: 0.08
    }));
    mesh.frustumCulled = true;
    this.blocksG.add(mesh);
    return mesh;
  }

  releaseSlot(s){
    s.mesh.visible = false;
    s.mesh.geometry = this.placeholder;
    this.spare.push(s.mesh);
  }

  computeVisible(){
    const rig = this.rig, camera = rig.camera, _hit = this._hit;
    rig.apply();

    let iMin = 1e9, iMax = -1e9, jMin = 1e9, jMax = -1e9;
    const corners = [[-1,-1],[1,-1],[-1,1],[1,1],[0,0]];
    for (const c of corners){
      rig.groundAt(c[0], c[1], _hit);
      const ii = _hit.x / CFG.CELL, jj = -_hit.z / CFG.CELL;
      if (ii < iMin) iMin = ii; if (ii > iMax) iMax = ii;
      if (jj < jMin) jMin = jj; if (jj > jMax) jMax = jj;
    }

    const ci = rig.cellI, cj = rig.cellJ;
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

    this.visible = list;
    this.visKeys = new Set();
    this.seenTick++;
    this.revision++;

    for (const c of list){
      c.key = this.keyOf(c.i, c.j);
      this.visKeys.add(c.key);
      const p = this.cache.get(c.key);
      if (p) p.seen = this.seenTick;
    }

    for (const [k, s] of this.slots){
      if (!this.visKeys.has(k)){ this.releaseSlot(s); this.slots.delete(k); }
    }
    this.evict();

    this.dirty = false;
    const l = this._lastVis;
    l.x = rig.x; l.z = rig.z; l.h = rig.h; l.yaw = rig.yaw; l.tilt = rig.tilt;
  }

  /* Nothing currently on screen is ever evicted; among the rest the least
     recently seen goes first, so backtracking over ground already walked
     is free while a long straight run steadily recycles. */
  evict(){
    if (this.cache.size <= CFG.CACHE_MAX && this.cacheBytes <= CFG.CACHE_BYTES) return;
    const cold = [];
    for (const [k, p] of this.cache)
      if (!this.visKeys.has(k) && k !== this.keyOf(Focus.i, Focus.j)
          && !(Pin.want && k === this.keyOf(Pin.want.i, Pin.want.j))) cold.push([k, p]);
    cold.sort((a, b) => a[1].seen - b[1].seen);
    for (const [k, p] of cold){
      if (this.cache.size <= CFG.CACHE_MAX && this.cacheBytes <= CFG.CACHE_BYTES) break;
      p.geo.dispose();
      if (p.geoLod) p.geoLod.dispose();
      this.cacheBytes -= p.bytes;
      this.cache.delete(k);
    }
  }

  /* A freshly generated block enters the cache. */
  /** @param {string} key @param {import('../types.js').BlockData} p */
  install(key, p){
    this.cache.set(key, p);
    this.cacheBytes += p.bytes;
    this.revision++;
    this.evict();
  }

  /* The outer-level proxy (r0^3 cells) is only meshed if something actually
     asks to draw one, which for a lattice this shallow is a minority of cells. */
  lodOf(p){
    if (!p.geoLod){
      p.geoLod = blockGeometry(p.occ, 1, p.filled, p.levels, p.R);
      p.lodTris = p.geoLod.userData.tris;
      const add = p.geoLod.userData.bytes;
      p.bytes += add; this.cacheBytes += add;
    }
    return p.geoLod;
  }

  /* Forget everything: every cached block is disposed and every slot
     released. Used when the recipe for the whole lattice changes. */
  flush(){
    for (const [, s] of this.slots){ this.releaseSlot(s); }
    this.slots.clear();
    for (const p of this.cache.values()){
      p.geo.dispose();
      if (p.geoLod) p.geoLod.dispose();
    }
    this.cache.clear();
    this.cacheBytes = 0;
    this.revision++;
    this.dirty = true;
  }
}
