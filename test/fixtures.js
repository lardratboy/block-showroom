// Fixed recipes and tier layouts. Seeds are 64-bit BigInts (both words
// non-zero so the high word is exercised). Adding to this list is fine; changing an
// existing entry invalidates its golden hash in golden.json.
export const LEVELS = {
  classic: [{ radix:3, gap:0.30 }, { radix:3, gap:0.06 }],
  tower3:  [{ radix:3, gap:0.30 }, { radix:3, gap:0.10 }, { radix:3, gap:0.04 }],
  hetero:  [{ radix:4, gap:0.30 }, { radix:3, gap:0.10 }, { radix:2, gap:0.04 }],
  n5:      [{ radix:5, gap:0.30 }],
  // A zero innermost gap makes adjacent voxels physically touch, so face
  // occlusion actually fires here. Every other layout above separates all
  // siblings, where the mesher can never cull. Keep both covered.
  solidcore: [{ radix:3, gap:0.50 }, { radix:5, gap:0.00 }],
};

export const RECIPES = [
  { name:'origin-classic',  levels:'classic', P:{ sym:0, arch:0, field:0, lift:0, density:0.25, seed:0x2545f4919e3779b9n } },
  { name:'mech-shells',     levels:'classic', P:{ sym:3, arch:1, field:1, lift:1, density:0.40, seed:0x1234abcd85ebca6bn } },
  { name:'crystal-diamond', levels:'tower3',  P:{ sym:7, arch:3, field:2, lift:2, density:0.18, seed:0xdeadbeefc2b2ae35n } },
  { name:'orbiter-hetero',  levels:'hetero',  P:{ sym:8, arch:4, field:5, lift:0, density:0.33, seed:0x0badf00d27d4eb2dn } },
  { name:'full-n5',         levels:'n5',      P:{ sym:9, arch:11, field:13, lift:1, density:0.55, seed:0x00c0ffee165667b1n } },
  { name:'solid-core',      levels:'solidcore', P:{ sym:3, arch:1, field:1, lift:1, density:0.40, seed:0x1234abcd85ebca6bn } },
  { name:'tier-symmetry',   levels:'classic', P:{ sym:5, arch:7, field:12, lift:1, density:0.30, seed:0x8badf00d9e3779b1n, tierSymmetry:true } },
];

// FNV-1a over a typed array's bytes; stable across platforms.
export function fnv(arr){
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++){ h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
