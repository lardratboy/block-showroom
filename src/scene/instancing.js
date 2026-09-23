/* INSTANCED SPECIMEN GEOMETRY
   ---------------------------------------------------------------------
   A specimen is `filled` identical cubes at known centres, so that is what
   the GPU is given: one shared 24-vertex cube template, and one centre per
   occupied voxel.  Everything the old baked vertex buffer carried is
   recovered in the vertex shader —

     position   instance centre + template corner x cellSize
     normal     a template attribute; a translation does not rotate it
     gamut      the local position + 0.5, which is what it always was
     orbit      one byte per voxel, expanded by the same hue ramp the CPU uses
     occlusion  a six-bit face mask per voxel; a hidden face's corners are
                pushed outside the clip volume, so nothing of it rasterises

   The four render modes are four indexings of that same instance data, not
   four copies of it: solid takes the 36-index cube, wire the 48-index edge
   list, points the bare 24 corners, and centres a one-vertex template. A
   specimen therefore pays for its GPU residency once however many modes the
   viewer flips through — where the baked path had to cut, hold and account
   for a separate buffer per view.

   Per voxel that is 14 bytes (12 centre + 1 mask + 1 orbit) against 1 128 for
   six baked quads.  See discussion.md section 3B. */
import * as THREE from 'three';
import { Core } from '../core/bimoblock-core.js';

const { FACE_TEMPLATE } = Core;

/* ---- shared templates --------------------------------------------------
   Built once, on first use, and referenced by every specimen's geometry for
   the life of the page. Cut straight from the core's face table so the
   instanced corners are the corners expandInstances() would have written. */
let TEMPLATES = null;
function templates(){
  if (TEMPLATES) return TEMPLATES;
  const { off, dir } = FACE_TEMPLATE;
  const position = new Float32Array(72), normal = new Float32Array(72);
  const faceBit  = new Float32Array(24);
  for (let f = 0; f < 6; f++){
    for (let c = 0; c < 4; c++){
      const v = f * 4 + c, o = v * 3, k = f * 12 + c * 3;
      position[o] = off[k]; position[o+1] = off[k+1]; position[o+2] = off[k+2];
      normal[o] = dir[f*3]; normal[o+1] = dir[f*3+1]; normal[o+2] = dir[f*3+2];
      faceBit[v] = 1 << f;   // the bit this corner's face occupies in the mask
    }
  }
  // Two triangles per face, and the four edges of each face: the same
  // windings wireGeometryOf() and the baked index buffer used.
  const solid = new Uint16Array(36), wire = new Uint16Array(48);
  for (let f = 0; f < 6; f++){
    const b = f * 4;
    solid.set([b, b+1, b+2, b, b+2, b+3], f * 6);
    wire.set([b, b+1, b+1, b+2, b+2, b+3, b+3, b], f * 8);
  }
  TEMPLATES = {
    cube: {
      position: new THREE.BufferAttribute(position, 3),
      normal:   new THREE.BufferAttribute(normal, 3),
      faceBit:  new THREE.BufferAttribute(faceBit, 1)
    },
    /* 'centres' draws one point per voxel: a single vertex at the cube's
       own centre, with faceBit 0 so the mask never hides it. */
    centre: {
      position: new THREE.BufferAttribute(new Float32Array(3), 3),
      normal:   new THREE.BufferAttribute(new Float32Array([0, 1, 0]), 3),
      faceBit:  new THREE.BufferAttribute(new Float32Array(1), 1)
    },
    solidIndex: new THREE.BufferAttribute(solid, 1),
    wireIndex:  new THREE.BufferAttribute(wire, 1)
  };
  return TEMPLATES;
}

const TEMPLATE_NAMES = ['position', 'normal', 'faceBit'];

/** The GPU-side form of one instance record: the three per-voxel attributes,
 *  plus a lazily built geometry per render mode that indexes them. */
export class InstancedSpecimen {
  /** @param {import('../types.js').InstanceArrays} rec */
  constructor(rec){
    this.rec = rec;
    const n = rec.count;
    const { cells, masks, orbitIdx, N, centers } = rec, NN = N * N;

    /* The record keeps the axis table in double precision so the CPU
       expansion stays bit-exact; the GPU wants f32 centres, and this is the
       one place the two meet. A centre rounded here rather than a vertex
       rounded there moves a corner by at most one f32 ulp of the unit box. */
    const centre = new Float32Array(n * 3);
    for (let c = 0; c < n; c++){
      const li = cells[c], o = c * 3;
      centre[o]   = centers[li % N];
      centre[o+1] = centers[((li / N) | 0) % N];
      centre[o+2] = centers[(li / NN) | 0];
    }
    this.instCenter = new THREE.InstancedBufferAttribute(centre, 3);
    // Byte attributes, read as plain floats 0..255 — not normalised.
    this.instMask  = new THREE.InstancedBufferAttribute(masks, 1);
    this.instOrbit = new THREE.InstancedBufferAttribute(
      orbitIdx || new Uint8Array(n), 1);

    /* Two different questions, so two numbers. `bytes` is what the cache is
       charged: only what this bundle allocated, since the mask and orbit
       arrays are the record's own and it is already counted for them.
       `uploadBytes` is what a first draw pushes to the GPU, which is all
       three attributes however they came to exist. */
    this.bytes = centre.byteLength + (orbitIdx ? 0 : n);
    this.uploadBytes = centre.byteLength + masks.byteLength + n;
    this.uploaded = n === 0;
    this.instCenter.onUpload(() => { this.uploaded = true; });
    /** @type {Object<string, THREE.InstancedBufferGeometry>} */
    this.geometries = {};
  }

  /** The geometry for one render mode. Built on first use, then kept; all of
   *  them share this specimen's instance attributes and the page's templates,
   *  so the second mode a viewer tries costs nothing on the GPU. */
  geometryFor(mode){
    const held = this.geometries[mode];
    if (held) return held;
    const T = templates();
    const src = mode === 'centers' ? T.centre : T.cube;
    const rec = this.rec;

    const g = new THREE.InstancedBufferGeometry();
    for (const name of TEMPLATE_NAMES) g.setAttribute(name, src[name]);
    g.setAttribute('instCenter', this.instCenter);
    g.setAttribute('instMask', this.instMask);
    g.setAttribute('instOrbit', this.instOrbit);
    if (mode === 'solid') g.setIndex(T.solidIndex);
    else if (mode === 'wire') g.setIndex(T.wireIndex);
    g.instanceCount = rec.count;

    const b = rec.bounds;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...b.center), b.radius);
    g.userData = {
      // Submitted triangles, which is what the GPU actually processes: the
      // whole cube per instance, hidden faces included. The `quads` the mask
      // leaves standing are what survives to the rasteriser.
      tris: mode === 'solid' ? rec.count * 12 : 0,
      quads: rec.quads,
      cellSize: rec.cellSize,
      orbitOrder: rec.orbitOrder,
      owner: this
    };
    this.geometries[mode] = g;
    return g;
  }

  /** Free this specimen's instance buffers, leaving the shared templates
   *  alone: disposing a geometry frees *every* attribute on it, so the
   *  borrowed ones are handed back before the event goes out. */
  dispose(){
    for (const mode of Object.keys(this.geometries)){
      const g = this.geometries[mode];
      for (const name of TEMPLATE_NAMES) g.deleteAttribute(name);
      g.setIndex(null);
      g.dispose();
    }
    this.geometries = {};
  }
}

/* ---- the shader patch --------------------------------------------------
   One injection, shared verbatim by the solid, wire and points materials, so
   three's default customProgramCacheKey (the patch function's own source)
   keys them together and every specimen mesh of a given class compiles once.
   The per-specimen and per-mode differences are uniforms, never GLSL. */
const INSTANCING_PARS = `
attribute vec3 instCenter;
attribute float instMask;
attribute float instOrbit;
attribute float faceBit;
uniform float uCellSize;
uniform float uOrbitMix;
uniform float uOrbitOrder;

// Mirrors orbitColor()/hslToRgb() in the core, at its fixed saturation and
// lightness. Continuous across the sextant boundaries, so a hue that lands
// on one in f32 but not in f64 still resolves to the same colour.
vec3 bimoblockOrbitColor(float bi, float order){
  const float S = 0.62, L = 0.55;
  float c = (1.0 - abs(2.0 * L - 1.0)) * S;
  float hp = fract(bi / max(1.0, order)) * 6.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 t = hp < 1.0 ? vec3(c, x, 0.0)
         : hp < 2.0 ? vec3(x, c, 0.0)
         : hp < 3.0 ? vec3(0.0, c, x)
         : hp < 4.0 ? vec3(0.0, x, c)
         : hp < 5.0 ? vec3(x, 0.0, c)
         :            vec3(c, 0.0, x);
  return t + (L - c * 0.5);
}
`;

/* `position` is the template corner in cell units (+/- 0.5), so this is the
   baked emit loop's `ox + FACE_OFF[k] * cellSize`, one vertex at a time. The
   gamut colour is the same local position + 0.5 it always was; uOrbitMix
   picks the orbit ramp instead, per object, with no second attribute and no
   recompile. */
const INSTANCING_BEGIN = `
	vec3 transformed = instCenter + position * uCellSize;
	vColor = mix(transformed + 0.5, bimoblockOrbitColor(instOrbit, uOrbitOrder), uOrbitMix);
`;

/* A face the occlusion pass dropped is not drawn: its four corners go to a
   point outside the clip volume, which discards its triangles, its edges and
   its points alike. faceBit 0 marks a template vertex no face owns (the
   centres cloud), which is never masked. */
const INSTANCING_MASK = `
	if (faceBit > 0.5 && mod(floor(instMask / faceBit), 2.0) < 0.5)
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

function patchInstancing(shader){
  shader.uniforms.uCellSize   = this.userData.instancing.uCellSize;
  shader.uniforms.uOrbitMix   = this.userData.instancing.uOrbitMix;
  shader.uniforms.uOrbitOrder = this.userData.instancing.uOrbitOrder;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', INSTANCING_PARS + '\n#include <common>')
    // vColor is assigned from the instanced position instead, below, once
    // `transformed` exists; the stock chunk would read a `color` attribute
    // that no longer has to exist.
    .replace('#include <color_vertex>', '')
    .replace('#include <begin_vertex>', INSTANCING_BEGIN)
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + INSTANCING_MASK);
}

/** Teach a stock material to draw instanced specimens. Lighting, tone
 *  mapping, fog and the material's own colour/opacity are untouched — this
 *  only changes where a vertex is and what colour it carries.
 *  @param {THREE.Material} material */
export function applyInstancing(material){
  material.userData.instancing = {
    uCellSize:   { value: 1 },
    uOrbitMix:   { value: 0 },
    uOrbitOrder: { value: 1 }
  };
  material.onBeforeCompile = patchInstancing;
  return material;
}

/** Point a mesh's material at the specimen and colour mode it is drawing.
 *  Cheap and idempotent: three uploads a uniform only when it changed.
 *  @param {THREE.Material} material @param {THREE.BufferGeometry} geo
 *  @param {boolean} orbit */
export function setInstancingUniforms(material, geo, orbit){
  const u = material.userData.instancing;
  if (!u) return;
  u.uCellSize.value = geo.userData.cellSize;
  // A specimen with no orbit data (the LOD proxy, whose cells aggregate
  // voxels of different orbits) stays on the gamut colouring, as before.
  const order = geo.userData.orbitOrder || 0;
  u.uOrbitMix.value = orbit && order > 0 ? 1 : 0;
  u.uOrbitOrder.value = Math.max(1, order);
}
