// Regenerates test/golden.json. Run ONLY when you intend to change specimen
// output; otherwise the existing file is the contract the refactor must keep.
import { writeFileSync } from 'node:fs';
import { loadCore } from './load-core.js';
import { LEVELS, RECIPES, fnv } from './fixtures.js';

const core = await loadCore();
const golden = {};
for (const r of RECIPES){
  const levels = LEVELS[r.levels];
  const b = core.buildBlock(r.P, levels);
  golden[r.name] = {
    R: b.R, filled: b.filled, envelopeCells: b.envelopeCells,
    occ: fnv(b.occ), pos: fnv(b.geometry.pos), idx: fnv(b.geometry.idx),
    aut: core.autOrder(b.occ, b.R),
  };
}
writeFileSync(new URL('./golden.json', import.meta.url), JSON.stringify(golden, null, 2) + '\n');
console.log(JSON.stringify(golden, null, 2));
