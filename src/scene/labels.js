/* FLOOR LABELS — a 2D overlay rather than sprites, so the type stays
   crisp at any zoom and costs one canvas pass instead of N textures.
   Redrawn only when something it shows has changed: the rig's pose, the
   virtualiser's revision (visible list / cache), or an explicit
   markDirty() from whoever changed the focus or the labels toggle. */
import * as THREE from 'three';
import { Core } from '../core/bimoblock-core.js';
import { CFG } from '../config.js';
import { State, Focus } from '../state.js';
import { symmetryLabel, cellWorldX, cellWorldZ } from '../lattice/recipe.js';

const { ARCH_NAMES } = Core;

export class LabelOverlay {
  constructor(canvas, rig, virtualiser){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rig = rig;
    this.virtualiser = virtualiser;
    this.dirty = true;
    this._pose = { x:NaN, z:NaN, h:NaN, tilt:NaN, yaw:NaN };
    this._revision = -1;
    this._p3 = new THREE.Vector3();
    this.resize();
  }

  markDirty(){ this.dirty = true; }

  resize(){
    this.dirty = true;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const c = this.canvas;
    c.width  = Math.floor(window.innerWidth  * dpr);
    c.height = Math.floor(window.innerHeight * dpr);
    c.style.width  = window.innerWidth  + 'px';
    c.style.height = window.innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(){
    const rig = this.rig, pose = this._pose, v = this.virtualiser;
    if (pose.x !== rig.x || pose.z !== rig.z || pose.h !== rig.h
        || pose.tilt !== rig.tilt || pose.yaw !== rig.yaw){
      this.dirty = true;
      pose.x=rig.x; pose.z=rig.z; pose.h=rig.h; pose.tilt=rig.tilt; pose.yaw=rig.yaw;
    }
    if (this._revision !== v.revision){ this.dirty = true; this._revision = v.revision; }
    if (!this.dirty) return;
    this.dirty = false;
    const lctx = this.ctx;
    lctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!State.labels || rig.h > 30) return;

    const detail = rig.h < 13;
    lctx.textAlign = 'center';
    lctx.textBaseline = 'middle';
    lctx.font = '9px ui-monospace, Menlo, Consolas, monospace';

    const _p3 = this._p3, camera = rig.camera;
    let n = 0;
    for (const c of v.visible){
      if (n > 220) break;
      const p = v.cache.get(c.key);
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
}
