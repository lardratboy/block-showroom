import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from './load-core.js';
import { LEVELS, RECIPES, fnv } from './fixtures.js';

const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
const core = await loadCore();

test('core exposes the expected surface', () => {
  for (const k of ['GROUPS','ARCH_NAMES','FIELD_NAMES','NATIVE_FIELDS','LEGACY_FIELD_COUNT','LIFT_NAMES','levelResolution','buildBlock','meshArrays','autOrder'])
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
