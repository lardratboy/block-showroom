/* PER-FRAME LAYOUT — places every visible specimen and its pod, picks
   full or proxy geometry by projected size, meters GPU uploads, and
   dresses the scene (floor plate, fog, focus/hover rings). Deliberately a
   function, not a class: it owns no state between frames beyond the
   scratch objects below. Returns the triangle count submitted. */
import * as THREE from 'three';
import { CFG, ROLE_BY_ID, GROUP_RGB, TAU } from '../config.js';
import { Axis, Pin, State, Focus, Hover } from '../state.js';
import { specimenChiral, cellWorldX, cellWorldZ, hash32 } from '../lattice/recipe.js';
import { setInstancingUniforms } from './instancing.js';
import { Perf } from '../perf.js';

const _m4 = new THREE.Matrix4();
const _q  = new THREE.Quaternion();
const _e  = new THREE.Euler();
const _s3 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _c3 = new THREE.Color();
const renderFrustum = new THREE.Frustum();
const renderProjection = new THREE.Matrix4();

/* Every render mode of a specimen indexes one set of instance attributes, so
   residency is a property of that bundle rather than of the drawable. The
   placeholder geometry owns nothing and is never uploaded, which is what
   keeps a slot hidden until its specimen has actually reached the GPU. */
const isUploaded = g => { const o = g.userData && g.userData.owner; return !!o && o.uploaded; };

/* `forceFullGeometry` (the ?fullGeometry=1 diagnostic) disables the proxy LOD. */
export function layout(t, dt, { rig, virtualiser, stage, forceFullGeometry }){
  const camera = rig.camera, v = virtualiser;
  const { pods, floor, floorMat, scene, focusRing, hoverRing } = stage;
  let frameTris = 0;
  let podCount = 0;
  let podMatricesChanged = false, podColorsChanged = false;
  let uploadBytes = 0, uploadCount = 0;
  renderProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  renderFrustum.setFromProjectionMatrix(renderProjection);

  // CSS pixels, so the LOD threshold means the same thing on every display
  const projK = window.innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
  const hover = CFG.BLOCK_S * 0.5 + 0.42;

  for (const c of v.visible){
    const p = v.cache.get(c.key);
    if (!p) continue;
    p.seen = v.seenTick;

    let s = v.slots.get(c.key);
    if (!s){
      const hh = hash32(c.i, c.j);
      s = { mesh: v.takeMesh(), i: c.i, j: c.j, age: 0,
            ph: (hh & 1023) / 1023 * TAU,
            rate: (((hh >>> 10) & 255) / 255 - 0.5) * 1.4 };
      v.slots.set(c.key, s);
    }
    const entering = s.age < 1;
    s.age = Math.min(1, s.age + dt * 3.4);

    const wx = cellWorldX(c.i), wz = cellWorldZ(c.j);
    const dist = Math.hypot(camera.position.x - wx, camera.position.y, camera.position.z - wz);
    const px = CFG.BLOCK_S * projK / Math.max(dist, 0.001);

    // What actually gets drawn: the instance bundle of record, indexed for the
    // current render mode. viewOf() decides whether the proxy is the right
    // bundle at all and builds it only if it is — see viewOf().
    const wantLod = !forceFullGeometry && px < CFG.LOD_PX;
    const lodStarted = wantLod && !p.viewsLod ? performance.now() : null;
    const geo = v.viewOf(p, wantLod);
    if (lodStarted !== null && p.viewsLod) Perf.sample('main.proxyMesh', performance.now() - lodStarted);
    const previousGeo = s.mesh.geometry;
    if (previousGeo !== geo) s.mesh.geometry = geo;

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
    if (onScreen && !isUploaded(geo)){
      const bytes = geo.userData.owner.uploadBytes;
      if (uploadCount && uploadBytes + bytes > CFG.UPLOAD_BYTES){
        s.awaitingUpload = true;
        // Preserve the old representation during a delayed LOD transition.
        if (isUploaded(previousGeo)) s.mesh.geometry = previousGeo;
        else s.mesh.visible = false;
      } else {
        uploadBytes += bytes; uploadCount++;
      }
    }
    if (onScreen && s.mesh.visible) frameTris += s.mesh.geometry.userData.tris || 0;

    const mat = s.mesh.material;
    // Where this specimen's cubes are and how wide they are, plus which of the
    // two colourings the vertex shader should hand out. Orbit colour is a
    // per-voxel byte expanded in the shader; a geometry carrying none (the LOD
    // proxy, whose cells aggregate voxels of different orbits) stays on gamut.
    setInstancingUniforms(mat, geo, State.colorMode === 'orbit');
    mat.opacity = k;
    // Point size is in world units (sizeAttenuation) and ignores object
    // scale, so track the specimen size here. Centres get a fatter dot than
    // the (up to 3x denser) mesh-vertex cloud.
    if (mat.isPointsMaterial) mat.size = CFG.BLOCK_S * (State.renderMode === 'centers' ? 0.075 : 0.04);
    const wantTransparent = k < 0.995;
    if (mat.transparent !== wantTransparent){ mat.transparent = wantTransparent; mat.needsUpdate = true; }

    // Additive tint, not a replacement: material.color multiplies the per-vertex
    // colour the instancing shader hands out, so 'gamut' mode (white, i.e. ×1)
    // leaves it exactly as it was, and 'chiral' mode shifts the whole specimen
    // toward one of two accents without touching the geometry or the shader.
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

  return frameTris;
}
