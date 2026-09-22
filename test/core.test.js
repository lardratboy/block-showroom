import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from './load-core.js';
import { LEVELS, RECIPES, fnv } from './fixtures.js';

const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
const core = await loadCore();

test('core exposes the expected surface', () => {
  for (const k of ['GROUPS','ARCH_NAMES','FIELD_NAMES','NATIVE_FIELDS','LEGACY_FIELD_COUNT','LIFT_NAMES','levelResolution','buildBlock','meshArrays','voxelCenters','autOrder','seedWords'])
    assert.ok(k in core, `missing ${k}`);
  assert.equal(core.GROUPS.length, 10);
  assert.equal(core.GROUPS[9].order, 48);
});

for (const r of RECIPES){
  test(`golden: ${r.name}`, () => {
    const levels = LEVELS[r.levels];
    const b = core.buildBlock(r.P, levels);
    const g = golden[r.name];
    assert.ok(g, 'no golden entry — run `npm run golden`');
    assert.equal(b.R, g.R);
    assert.equal(b.filled, g.filled);
    assert.equal(b.envelopeCells, g.envelopeCells);
    assert.equal(fnv(b.occ), g.occ, 'voxel occupancy changed');
    assert.equal(fnv(b.geometry.pos), g.pos, 'mesh positions changed');
    assert.equal(fnv(b.geometry.idx), g.idx, 'mesh indices changed');
    assert.equal(core.autOrder(b.occ, b.R), g.aut);
  });
}

test('buildBlock is deterministic across calls', () => {
  const a = core.buildBlock(RECIPES[1].P, LEVELS.classic);
  const b = core.buildBlock(RECIPES[1].P, LEVELS.classic);
  assert.equal(fnv(a.occ), fnv(b.occ));
});

test('mesh arrays are internally consistent', () => {
  const b = core.buildBlock(RECIPES[2].P, LEVELS.tower3);
  const g = b.geometry;
  assert.equal(g.pos.length % 3, 0);
  assert.equal(g.pos.length, g.nrm.length);
  assert.equal(g.pos.length, g.col.length);
  assert.equal(g.idx.length % 3, 0);
  let max = 0; for (const i of g.idx) if (i > max) max = i;
  assert.ok(max < g.pos.length / 3, 'index out of range');
});

test('voxelCenters gives one centre per filled voxel, each the midpoint of a meshed cube', () => {
  const b = core.buildBlock(RECIPES[2].P, LEVELS.tower3);
  const c = core.voxelCenters(b.occ, LEVELS.tower3, b.R);
  assert.equal(c.count, b.filled);
  assert.equal(c.pos.length, b.filled * 3);
  for (const v of c.pos) assert.ok(v > -0.5 && v < 0.5, `centre ${v} outside the unit box`);
  // Every mesh vertex sits half a cell from some centre on every axis, so
  // each corner of each exposed face must be centre ± cellSize/2.
  const half = c.cellSize / 2, g = b.geometry;
  const key = (x, y, z) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
  const corners = new Set();
  for (let i = 0; i < c.pos.length; i += 3)
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
      corners.add(key(c.pos[i] + sx * half, c.pos[i+1] + sy * half, c.pos[i+2] + sz * half));
  for (let i = 0; i < g.pos.length; i += 3)
    assert.ok(corners.has(key(g.pos[i], g.pos[i+1], g.pos[i+2])), 'mesh vertex is not a corner of any centred cube');
});

test('the high 32 bits of the seed change the specimen', () => {
  // Every mode reads the seed through seedWords(), so flipping only the high
  // word must produce a different occupancy in both a hash-driven field and
  // a phase-driven one — otherwise the seed is effectively still 32-bit.
  for (const base of [RECIPES[0], RECIPES[1]]){
    const P = { ...base.P, seed: base.P.seed ^ (0x9e3779b9n << 32n) };
    const a = core.buildBlock(base.P, LEVELS.classic);
    const b = core.buildBlock(P, LEVELS.classic);
    assert.notEqual(fnv(a.occ), fnv(b.occ), `${base.name}: high seed word had no effect`);
  }
  const w = core.seedWords(0x0123456789abcdefn);
  assert.equal(w.lo, 0x89abcdef); assert.equal(w.hi, 0x01234567);
  assert.equal(core.seedWords(0x89abcdef).lo, 0x89abcdef, 'a plain integer is the low word');
});
