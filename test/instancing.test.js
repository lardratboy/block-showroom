/* The instance record is what a build ships and what the renderer draws, so
   these pin its own invariants — the golden hashes in core.test.js only cover
   it via expandInstances(). The last test is the important one: it runs a CPU
   model of the vertex shader over the record and asserts it lands on the same
   vertices, in the same order, with the same colours as the baked mesh. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './load-core.js';
import { LEVELS, RECIPES } from './fixtures.js';

const core = await loadCore();
const popcount = m => { let n = 0; while (m){ n += m & 1; m >>>= 1; } return n; };
const builds = RECIPES.map(r => ({ r, levels: LEVELS[r.levels], b: core.buildBlock(r.P, LEVELS[r.levels]) }));

test('a record holds exactly the occupied cells, and its masks account for every quad', () => {
  for (const { r, b } of builds){
    const rec = b.instances;
    assert.equal(rec.count, b.filled, `${r.name}: one instance per filled voxel`);
    assert.equal(rec.cells.length, rec.count, `${r.name}: buffers trimmed to count`);
    assert.equal(rec.masks.length, rec.count);
    assert.equal(rec.orbitIdx.length, rec.count);

    let quads = 0, seen = new Set();
    for (let c = 0; c < rec.count; c++){
      const li = rec.cells[c];
      assert.equal(b.occ[li], 1, `${r.name}: cell ${li} is not occupied`);
      assert.ok(!seen.has(li), `${r.name}: cell ${li} listed twice`);
      seen.add(li);
      quads += popcount(rec.masks[c]);
    }
    assert.equal(quads, rec.quads, `${r.name}: mask popcount is the quad total`);
    assert.equal(rec.tris, rec.quads * 2);
  }
});

test('the zero-gap fixture really does cull, and the separated ones really do not', () => {
  const solid = builds.find(x => x.r.name === 'solid-core').b.instances;
  assert.ok(solid.quads / solid.count < 4,
    `solid-core should cull heavily, got ${(solid.quads / solid.count).toFixed(3)} quads/voxel`);
  for (const { r, b } of builds){
    if (r.levels === 'solidcore') continue;
    assert.equal(b.instances.quads, b.instances.count * 6,
      `${r.name}: every sibling is separated here, so no face can be hidden`);
  }
});

test('record bounds match a scan over the expanded vertices, to the bit', () => {
  for (const { r, b } of builds){
    const rec = b.instances, mesh = core.expandInstances(rec);
    const [cx, cy, cz] = rec.bounds.center;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], r2 = 0;
    for (let i = 0; i < mesh.pos.length; i += 3){
      for (let a = 0; a < 3; a++){
        if (mesh.pos[i+a] < lo[a]) lo[a] = mesh.pos[i+a];
        if (mesh.pos[i+a] > hi[a]) hi[a] = mesh.pos[i+a];
      }
      const qx = mesh.pos[i] - cx, qy = mesh.pos[i+1] - cy, qz = mesh.pos[i+2] - cz;
      const d = qx*qx + qy*qy + qz*qz;
      if (d > r2) r2 = d;
    }
    assert.equal(rec.bounds.radius, Math.sqrt(r2), `${r.name}: bounding radius`);
    for (let a = 0; a < 3; a++)
      assert.ok(Math.abs((lo[a] + hi[a]) / 2 - rec.bounds.center[a]) < 1e-12,
        `${r.name}: analytic centre is the box midpoint on axis ${a}`);
  }
});

test('the LOD proxy is a record over the outer tier alone', () => {
  for (const { r, levels, b } of builds){
    const lod = core.instanceArrays(b.occ, 1, b.filled, levels, b.R);
    const r0 = levels[0].radix;
    assert.ok(lod.count <= r0 * r0 * r0, `${r.name}: proxy fits the outer tier`);
    assert.equal(lod.N, r0);
    assert.equal(lod.orbitIdx, null, `${r.name}: aggregate cells carry no single orbit`);
    assert.equal(lod.orbitOrder, 0);
    // Same expansion path, so the proxy is drawable and exportable like the rest.
    assert.equal(core.expandInstances(lod).pos.length, lod.quads * 12);
  }
});

/* A CPU model of scene/instancing.js: the same cube template cut from the
   core's face table, the same `centre + corner * cellSize`, the same gamut
   and orbit colours, and the same per-face mask test.

   `gpu` picks which arithmetic to model. The record keeps its axis table in
   double precision, so the exact path reproduces the baked buffers the
   exporters and goldens are defined on. The GPU only has f32 centres, so it
   rounds once more, and the test below bounds how far that can move a vertex. */
function drawInstanced(rec, gpu){
  const { off, dir } = core.FACE_TEMPLATE;
  const f32 = Math.fround;
  const pos = [], col = [], colOrbit = [], nrm = [];
  const { cells, masks, orbitIdx, orbitOrder, count, N, centers, cellSize } = rec;
  const NN = N * N;
  const size = gpu ? f32(cellSize) : cellSize;
  for (let c = 0; c < count; c++){
    const li = cells[c];
    const centre = [centers[li % N], centers[((li / N) | 0) % N], centers[(li / NN) | 0]];
    if (gpu) for (let a = 0; a < 3; a++) centre[a] = f32(centre[a]);
    const oc = orbitIdx ? core.orbitColor(orbitIdx[c], orbitOrder) : null;
    for (let f = 0; f < 6; f++){
      // The shader's test: a template corner carries its face's bit, and a
      // corner whose bit is clear is pushed out of the clip volume.
      const faceBit = 1 << f;
      if (Math.floor(masks[c] / faceBit) % 2 < 0.5) continue;
      for (let k = 0; k < 4; k++){
        const t = f * 12 + k * 3;
        for (let a = 0; a < 3; a++){
          const px = gpu ? f32(centre[a] + f32(off[t+a] * size)) : centre[a] + off[t+a] * size;
          pos.push(f32(px));
          col.push(f32(gpu ? f32(px) + 0.5 : px + 0.5));
          nrm.push(dir[f*3+a]);
          if (oc) colOrbit.push(f32(oc[a]));
        }
      }
    }
  }
  return { pos, col, colOrbit, nrm };
}

test('the instanced draw reproduces the baked mesh vertex for vertex', () => {
  for (const { r, b } of builds){
    const rec = b.instances;
    const baked = core.expandInstances(rec);
    const drawn = drawInstanced(rec, false);
    assert.equal(drawn.pos.length, baked.pos.length, `${r.name}: vertex count`);
    for (let i = 0; i < baked.pos.length; i++){
      assert.equal(drawn.pos[i], baked.pos[i], `${r.name}: position ${i}`);
      assert.equal(drawn.col[i], baked.col[i], `${r.name}: gamut colour ${i}`);
      assert.equal(drawn.nrm[i], baked.nrm[i], `${r.name}: normal ${i}`);
      assert.equal(drawn.colOrbit[i], baked.colOrbit[i], `${r.name}: orbit colour ${i}`);
    }
  }
});

/* The one thing instancing cannot keep bit-identical: the GPU is handed f32
   centres and offsets them in f32, where the baked mesher worked in double
   and rounded once at the end. Both are unit-box coordinates, so this bounds
   the drift in units of a specimen's own width — a few parts in 10^8, which
   is nanometres at the size these are drawn and far below one step of an
   8-bit colour channel. It is asserted rather than assumed. */
test('the f32 path the GPU takes stays within an ulp of the baked mesh', () => {
  const LIMIT = 1e-7;
  for (const { r, b } of builds){
    const baked = core.expandInstances(b.instances);
    const drawn = drawInstanced(b.instances, true);
    let worstPos = 0, worstCol = 0;
    for (let i = 0; i < baked.pos.length; i++){
      worstPos = Math.max(worstPos, Math.abs(drawn.pos[i] - baked.pos[i]));
      worstCol = Math.max(worstCol, Math.abs(drawn.col[i] - baked.col[i]));
    }
    assert.ok(worstPos < LIMIT, `${r.name}: position drift ${worstPos}`);
    assert.ok(worstCol < LIMIT, `${r.name}: gamut colour drift ${worstCol}`);
    // An 8-bit channel steps by 1/255; the drift must not be able to change one.
    assert.ok(worstCol * 255 < 0.5, `${r.name}: colour drift is visible`);
  }
});

test('an empty specimen yields an empty, drawable record', () => {
  const levels = LEVELS.classic, R = core.levelResolution(levels);
  const rec = core.instanceArrays(new Uint8Array(R*R*R), 0, 0, levels, R);
  assert.equal(rec.count, 0);
  assert.equal(rec.quads, 0);
  assert.equal(rec.bounds.radius, 0);
  assert.deepEqual(rec.bounds.center, [0, 0, 0]);
  assert.equal(core.expandInstances(rec).pos.length, 0);
});
