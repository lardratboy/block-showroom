/* CAMERA RIG — a target on the lattice plane, a height and a pitch.
   The rig owns the camera's pose and nothing else: it does not know who
   depends on where it is. Consumers that care (the virtualiser, the label
   overlay) compare its pose against the one they last used. */
import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import { CFG, clamp } from '../config.js';
import { cellWorldX, cellWorldZ } from '../lattice/recipe.js';

export class CameraRig {
  constructor(camera, domElement){
    this.camera = camera;
    this.domElement = domElement;   // for ndcOf(): pointer events → NDC
    this.x = 0; this.z = 0; this.h = 15;
    this.tilt = 0.91; this.yaw = 0;
    this.vx = 0; this.vz = 0;       // inertial velocity after a flick
    this._ray = new THREE.Raycaster();
    this._v2  = new THREE.Vector2();
    this._a3  = new THREE.Vector3();
    this._b3  = new THREE.Vector3();
  }

  /* The lattice cell under the target. */
  get cellI(){ return Math.round(this.x / CFG.CELL); }
  get cellJ(){ return Math.round(-this.z / CFG.CELL); }

  apply(){
    const horiz = this.h / Math.tan(this.tilt);
    const cam = this.camera;
    cam.position.set(this.x + Math.sin(this.yaw) * horiz, this.h, this.z + Math.cos(this.yaw) * horiz);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.x, 0, this.z);
    cam.updateMatrixWorld();
  }

  /* Where a screen point lands on the lattice plane.  Rays aimed at or
     above the horizon cannot land anywhere, so they are answered with a
     capped point along the projected direction; the visible-set scan
     clamps to MAX_SPAN anyway. */
  groundAt(ndcx, ndcy, out){
    this._v2.set(ndcx, ndcy);
    this._ray.setFromCamera(this._v2, this.camera);
    const r = this._ray.ray;
    if (r.direction.y > -1e-4){
      out.copy(r.origin).addScaledVector(r.direction, CFG.MAX_SPAN * CFG.CELL * 1.6);
      out.y = 0;
      return false;
    }
    out.copy(r.origin).addScaledVector(r.direction, -r.origin.y / r.direction.y);
    return true;
  }

  ndcOf(e, out){
    const rect = this.domElement.getBoundingClientRect();
    out.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    out.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    return out;
  }

  /* Zooming keeps whatever sits under the cursor pinned in place: the rig
     translates only, so one correction pass is exact. */
  zoomBy(factor, ndcx, ndcy){
    this.apply();
    this.groundAt(ndcx, ndcy, this._a3);
    this.h = clamp(this.h * factor, 2.6, 96);
    this.apply();
    this.groundAt(ndcx, ndcy, this._b3);
    this.x += this._a3.x - this._b3.x;
    this.z += this._a3.z - this._b3.z;
    this.apply();
  }

  glideTo(i, j, height){
    const from = { x: this.x, z: this.z, h: this.h };
    const to = { x: cellWorldX(i), z: cellWorldZ(j), h: height != null ? height : this.h };
    this.vx = this.vz = 0;
    new TWEEN.Tween(from).to(to, 900).easing(TWEEN.Easing.Cubic.InOut)
      .onUpdate(() => { this.x = from.x; this.z = from.z; this.h = from.h; })
      .start();
  }

  /* Inertial glide after a flick; returns whether the target moved. */
  coast(dt){
    if (Math.abs(this.vx) <= 1e-4 && Math.abs(this.vz) <= 1e-4) return false;
    this.x += this.vx * dt; this.z += this.vz * dt;
    const decay = Math.exp(-3.4 * dt);
    this.vx *= decay; this.vz *= decay;
    if (Math.abs(this.vx) < 1e-3 && Math.abs(this.vz) < 1e-3) this.vx = this.vz = 0;
    this.apply();
    return true;
  }
}
