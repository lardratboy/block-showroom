/* NAVIGATION INPUT — pointer, pinch and wheel on the render canvas.
   Drags move the rig directly (pan keeps the grabbed floor point under
   the cursor; shift/right/middle-drag orbits); a click that barely moved
   is reported through onFocus. Idle motion updates the Hover cell. */
import * as THREE from 'three';
import { CFG, clamp } from '../config.js';
import { Hover } from '../state.js';

export class Navigation {
  /* `onFocus(i, j)` — a cell was clicked; `onOrbit()` — the tilt changed
     by dragging, so any slider mirroring it can follow. */
  constructor(rig, { onFocus, onOrbit }){
    this.rig = rig;
    this.onFocus = onFocus;
    this.onOrbit = onOrbit;
    this.pointers = new Map();
    this.dragMode = null;         // 'pan' | 'orbit' | 'pinch'
    this.dragAnchor = null;
    this.dragStart = null;
    this.pinchDist = 0;
    this._v2  = new THREE.Vector2();
    this._hit = new THREE.Vector3();

    const el = rig.domElement;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => this._down(e));
    el.addEventListener('pointermove', e => this._move(e));
    el.addEventListener('pointerup', e => this._up(e));
    el.addEventListener('pointercancel', e => this._up(e));
    el.addEventListener('wheel', e => {
      e.preventDefault();
      rig.ndcOf(e, this._v2);
      rig.zoomBy(Math.exp(clamp(e.deltaY, -160, 160) * 0.0013), this._v2.x, this._v2.y);
    }, { passive: false });
  }

  /* True while a drag is in progress, when inertia must not run. */
  get dragging(){ return this.dragMode !== null; }

  _down(e){
    const rig = this.rig;
    rig.domElement.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

    if (this.pointers.size === 2){
      const pts = [...this.pointers.values()];
      this.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.dragMode = 'pinch';
      return;
    }

    this.dragStart = { x:e.clientX, y:e.clientY, t:performance.now() };
    rig.vx = rig.vz = 0;
    if (e.shiftKey || e.button === 2 || e.button === 1){
      this.dragMode = 'orbit';
    } else {
      this.dragMode = 'pan';
      rig.apply();
      rig.ndcOf(e, this._v2);
      rig.groundAt(this._v2.x, this._v2.y, this._hit);
      this.dragAnchor = this._hit.clone();
    }
  }

  _move(e){
    const rig = this.rig, _v2 = this._v2, _hit = this._hit;
    const prev = this.pointers.get(e.pointerId);
    if (prev){ prev.x = e.clientX; prev.y = e.clientY; }

    if (this.dragMode === 'pinch' && this.pointers.size === 2){
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinchDist > 1 && d > 1){
        rig.zoomBy(this.pinchDist / d, 0, 0);
        this.pinchDist = d;
      }
      return;
    }

    if (this.dragMode === 'orbit' && prev){
      rig.yaw  -= (e.movementX || 0) * 0.005;
      rig.tilt = clamp(rig.tilt + (e.movementY || 0) * 0.004, 0.52, 1.535);
      this.onOrbit();
      rig.apply();
      return;
    }

    if (this.dragMode === 'pan' && this.dragAnchor){
      rig.ndcOf(e, _v2);
      rig.groundAt(_v2.x, _v2.y, _hit);
      const dx = _hit.x - this.dragAnchor.x, dz = _hit.z - this.dragAnchor.z;
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
  }

  _up(e){
    const rig = this.rig, _v2 = this._v2, _hit = this._hit;
    this.pointers.delete(e.pointerId);
    if (this.dragMode === 'pan' && this.dragStart){
      const moved = Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y);
      if (moved < 5){
        rig.vx = rig.vz = 0;
        rig.ndcOf(e, _v2);
        if (rig.groundAt(_v2.x, _v2.y, _hit))
          this.onFocus(Math.round(_hit.x / CFG.CELL), Math.round(-_hit.z / CFG.CELL));
      }
    }
    if (this.pointers.size < 2){ this.dragMode = null; this.dragAnchor = null; this.dragStart = null; }
  }
}
