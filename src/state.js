/* The showroom's shared mutable state, as plain objects. Deliberately no
   methods yet: this is the one place the former top-level globals live, so
   every module reads and writes the same instance. Phase 4 hands each of
   these to the class that owns it. */

export const Axis   = { x:'arch', y:'sym' };
export const Filter = { sym:-1, arch:-1, field:-1 };
export const Mint   = { gen:0, density:0.25 };

/* Tier layout is global (like density), not per-cell. `levels` is
   reassigned wholesale by the presets, hence the wrapper object. */
export const Tier = {
  /** @type {import('./types.js').Level[]} */
  levels: [{ radix:3, gap:0.30 }, { radix:3, gap:0.06 }],
  symmetry: false
};

/* Sibling-district pin; see cellRecipe() in lattice/recipe.js. */
/** `params` is the pinned specimen's Recipe; `want` is the address awaiting its build. */
export const Pin = { on:false, i:0, j:0, radius:4, epoch:0, params:null, want:null };

export const State = {
  align: false, labels: true, legend: true,
  spin: 0.34, haze: 0.42, time: 0,
  colorMode: 'gamut'   // 'gamut' | 'chiral' | 'orbit' — see specimenChiral()
};
export const Bloom = { on: false };
export const Focus = { i:0, j:0 };
export const Hover = { i:0, j:0, on:false };
