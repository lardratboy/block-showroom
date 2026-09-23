/* ================== BIMOBLOCK CORE (JS) BEGIN ===================
   Exact mathematical representation of the 48-element Oh group,
   archetype envelopes, anisotropic scalar fields, voxel packing,
   and color gamut domain mapping.
   ================================================================ */
// Canonical numeric core. This factory is also the complete worker dependency.
// PHASE 0 build: orbit enumeration + exact quickselect. Output is byte-identical
// to the reference core; see verify-phase0.mjs.
export function createBimoblockCore(){
const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
const PERM = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
const PERM_NAME = ["XYZ","XZY","YXZ","YZX","ZXY","ZYX"];

function applyG(v, e){
  const P = PERM[e >> 3], s = e & 7;
  return [((s & 1) ? -1 : 1) * v[P[0]],
          ((s & 2) ? -1 : 1) * v[P[1]],
          ((s & 4) ? -1 : 1) * v[P[2]]];
}
const MATS = [];
for (let e = 0; e < 48; e++){
  const P = PERM[e >> 3], s = e & 7, M = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++) M[i][P[i]] = ((s >> i) & 1) ? -1 : 1;
  MATS.push(M);
}
function eOf(M){
  for (let e = 0; e < 48; e++){
    const A = MATS[e]; let ok = true;
    for (let i = 0; i < 3 && ok; i++) for (let j = 0; j < 3 && ok; j++) if (A[i][j] !== M[i][j]) ok = false;
    if (ok) return e;
  }
  return -1;
}
function mulE(e1, e2){
  const A = MATS[e1], B = MATS[e2], C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++){
    let t = 0; for (let k = 0; k < 3; k++) t += A[i][k] * B[k][j]; C[i][j] = t;
  }
  return eOf(C);
}
function detE(e){
  const M = MATS[e];
  return M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1])
       - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0])
       + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
}
function closure(gens){
  const set = new Set([0]);
  let grew = true;
  while (grew){
    grew = false;
    for (const a of [...set]) for (const g of gens){
      const c = mulE(a, g);
      if (!set.has(c)){ set.add(c); grew = true; }
    }
  }
  return [...set].sort((a, b) => a - b);
}

const GEN = {
  Mx:    eOf([[-1,0,0],[0,1,0],[0,0,1]]),
  Mz:    eOf([[1,0,0],[0,1,0],[0,0,-1]]),
  R180y: eOf([[-1,0,0],[0,1,0],[0,0,-1]]),
  R90y:  eOf([[0,0,1],[0,1,0],[-1,0,0]]),
  cyc:   eOf([[0,1,0],[0,0,1],[1,0,0]]),
  negI:  eOf([[-1,0,0],[0,-1,0],[0,0,-1]]),
  Sxy:   eOf([[0,1,0],[1,0,0],[0,0,1]]),
  MxMy:  eOf([[-1,0,0],[0,-1,0],[0,0,1]])
};

const GROUPS = [
  { name:"C1:free",      gens:[] },
  { name:"Cs:mirror-X",  gens:[GEN.Mx] },
  { name:"C2:rot180-Y",  gens:[GEN.R180y] },
  { name:"C2v:bi-axial", gens:[GEN.Mx, GEN.Mz] },
  { name:"C3:diag-3",    gens:[GEN.cyc] },
  { name:"C4:pinwheel",  gens:[GEN.R90y] },
  { name:"C4v:quad-4",   gens:[GEN.R90y, GEN.Mx] },
  { name:"S6:diag-6",    gens:[GEN.cyc, GEN.negI] },
  { name:"Td:tetra-24",  gens:[GEN.Sxy, GEN.cyc, GEN.MxMy] },
  { name:"Oh:octa-48",   gens:[GEN.Mx, GEN.Sxy, GEN.cyc] }
].map(g => {
  g.els = closure(g.gens);
  g.order = g.els.length;
  g.chiral = g.els.every(e => detE(e) > 0);
  const rep = new Int32Array(48);
  for (let e = 0; e < 48; e++){ let r = 48; for (const h of g.els) r = Math.min(r, mulE(h, e)); rep[e] = r; }
  const uniq = [...new Set([...rep])].sort((a, b) => a - b);
  g.cosetOf = Array.from(rep, r => uniq.indexOf(r));
  g.cosets = uniq.length;
  return g;
});

function foldOrbit(v, els){
  let bx = v[0], by = v[1], bz = v[2], bi = 0;
  for (let i = 1; i < els.length; i++){
    const w = applyG(v, els[i]);
    if (w[0] < bx || (w[0] === bx && (w[1] < by || (w[1] === by && w[2] < bz)))){
      bx = w[0]; by = w[1]; bz = w[2]; bi = i;
    }
  }
  return [bx, by, bz, bi]; // bi: index into els of the winning element (existing callers only read [0..2])
}
/* Deterministic hue-per-orbit palette, pure math so it works identically in
   worker threads. Evenly spaced around the wheel so |els| distinct fold
   representatives stay maximally distinguishable regardless of group order. */
function hslToRgb(h, s, l){
  const c = (1 - Math.abs(2*l - 1)) * s, hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  const t = hp < 1 ? [c,x,0] : hp < 2 ? [x,c,0] : hp < 3 ? [0,c,x]
          : hp < 4 ? [0,x,c] : hp < 5 ? [x,0,c] : [c,0,x];
  const m = l - c / 2;
  return [t[0] + m, t[1] + m, t[2] + m];
}
function orbitColor(bi, order){
  return hslToRgb((bi / Math.max(1, order)) * 360, 0.62, 0.55);
}

const ARCH_NAMES = ["starship","mech","totem","crystal","orbiter","full",
                    "hollow","spire","frame","spindle","gyroid","lens"];
const SQRT3 = 1.7320508075688772;
function envelope(sx, sy, sz, arch){
  if (arch === 0){
    const wings = 0.28 + 0.72 * (1.0 - (sz + 1.0) * 0.5);
    const thick = 0.35 + 0.65 * (1.0 - Math.abs(sz));
    return Math.abs(sx) <= wings && Math.abs(sy) <= thick;
  }
  if (arch === 1){
    if (sy > 0.25)    return Math.abs(sx) <= 0.35 && Math.abs(sz) <= 0.35;
    if (sy >= -0.25)  return Math.abs(sx) <= 0.95 && Math.abs(sz) <= 0.65;
    return Math.abs(sx) >= 0.15 && Math.abs(sx) <= 0.75 && Math.abs(sz) <= 0.55;
  }
  if (arch === 2){ const r = 0.45 + 0.38 * Math.cos(sy * 6.28318); return sx*sx + sz*sz <= r*r; }
  if (arch === 3) return Math.abs(sx) + Math.abs(sy) + Math.abs(sz) <= 1.25;
  if (arch === 4){
    const r = Math.hypot(sx, sz);
    return (Math.abs(r - 0.62) <= 0.32 && Math.abs(sy) <= 0.45) || (r <= 0.25 && Math.abs(sy) <= 0.75);
  }
  if (arch === 5) return true;
  if (arch === 6){ const r = Math.hypot(sx, sy, sz); return r >= 0.55 && r <= 1.05; }
  if (arch === 7){
    const r = Math.hypot(sx, sz);
    return (sy <= -0.6) ? r <= 1.05 : r <= 0.95 - 0.62 * (sy + 1.0) * 0.5;
  }
  if (arch === 8){
    let n = 0;
    if (Math.abs(sx) >= 0.55) n++;
    if (Math.abs(sy) >= 0.55) n++;
    if (Math.abs(sz) >= 0.55) n++;
    return n >= 2;
  }
  if (arch === 9){
    const t = (sx + sy + sz) / SQRT3;
    const d = Math.sqrt(Math.max(0, sx*sx + sy*sy + sz*sz - t*t));
    return d <= 0.78 * (1.0 - Math.abs(t) / 2.0);
  }
  if (arch === 10){
    const P = Math.PI;
    return Math.abs(Math.sin(P*sx) * Math.cos(P*sy) +
                    Math.sin(P*sy) * Math.cos(P*sz) +
                    Math.sin(P*sz) * Math.cos(P*sx)) <= 0.62;
  }
  const yy = sy / 0.5;
  return (sx*sx + sz*sz) + yy*yy <= 1.05;
}

const FIELD_NAMES = ["xor/hash","shells","diamond","popcount",
                     "p:conic","p:cubic","p:trefoil","p:mixmul","p:xor±","p:product"];
const NATIVE_FIELDS = 4;

/* =====================================================================
   GENERALIZED TIERED LEVEL CORE
   ---------------------------------------------------------------------
   Replaces the implicit "always 3x3, always R=9" assumption with a real
   `levels` list: [{radix, gap}, ...], index 0 = outermost/coarsest tier,
   last = innermost/finest. R = product of radices. This is the same
   core validated standalone in bimoblock-tiered-core.html, including the
   axisToIndex fix for even radices (round() must apply to the whole
   expression, not to s*half before adding half — that split only lands
   back on an integer when R is odd).
   The classic bimoblock default is Levels = [{radix:3,gap:.3},{radix:3,gap:.06}].
   Its R=9 generation formulas reduce exactly to what this file used to
   hardcode; the gap values are applied later, during physical voxel layout.
   [V] Generation was verified against a golden reference captured from the
   pre-port file across 384 (sym,arch,field) combos.
   ===================================================================== */


/** @param {import('../types.js').Level[]} levels */
function levelResolution(levels){ return levels.reduce((p, l) => p * l.radix, 1); }
function decomposeDigits(u, levels){
  const L = levels.length, digits = new Array(L);
  let rem = u;
  for (let i = L - 1; i >= 0; i--){
    const N = levels[i].radix;
    digits[i] = rem % N;
    rem = Math.floor(rem / N);
  }
  return digits; // digits[0]=outermost(macro) ... digits[L-1]=innermost(micro)
}
function composeDigits(digits, levels){
  let u = 0;
  for (let i = 0; i < levels.length; i++) u = u * levels[i].radix + digits[i];
  return u;
}
function axisToIndex(s, R){ const R1 = R - 1; return Math.round((s * R1 + R1) / 2); }
function foldedAxis(u, levels){
  const digits = decomposeDigits(u, levels);
  const R = levelResolution(levels);
  let n = 0;
  for (let i = 0; i < levels.length; i++){
    let innerProd = 1;
    for (let j = i + 1; j < levels.length; j++) innerProd *= levels[j].radix;
    n += (digits[i] - (levels[i].radix - 1) / 2) * innerProd;
  }
  return n / ((R - 1) / 2);
}

/* Physical placement for one axis of the mixed-radix voxel hierarchy.
   A level's gap is measured as a fraction of the child block below it:
   0 keeps siblings touching, 0.3 separates them by 30% of a child width,
   and 1 leaves one full child width between them.  The complete hierarchy
   is normalized back to a unit bounding box, so changing resolution or gaps
   changes the spacing pattern without changing the showroom footprint. */
function tierAxisLayout(levels, outerOnly){
  const L = levels.length;
  const extent = new Float64Array(L + 1);
  const stride = new Float64Array(L);
  extent[L] = 1; // one finest voxel
  for (let i = L - 1; i >= 0; i--){
    const gap = clamp(Number(levels[i].gap) || 0, 0, 1);
    stride[i] = extent[i + 1] * (1 + gap);
    extent[i] = levels[i].radix * extent[i + 1] +
                (levels[i].radix - 1) * gap * extent[i + 1];
  }

  const total = extent[0];
  if (outerOnly){
    const N = levels[0].radix;
    const centers = new Float64Array(N);
    const half = (N - 1) / 2;
    for (let u = 0; u < N; u++) centers[u] = (u - half) * stride[0] / total;
    return { centers, cellSize:extent[1] / total };
  }

  const R = levelResolution(levels);
  const centers = new Float64Array(R);
  for (let u = 0; u < R; u++){
    const digits = decomposeDigits(u, levels);
    let p = 0;
    for (let i = 0; i < L; i++)
      p += (digits[i] - (levels[i].radix - 1) / 2) * stride[i];
    centers[u] = p / total;
  }
  return { centers, cellSize:1 / total };
}
// Wrap an (already-rounded) integer into R symmetric positions centered at 0 — the
// generalized form of the old fixed wrap9, used by the "nested" lift mode.
function wrapR(x, R){
  const half = (R - 1) / 2;
  const m = (((Math.round(x) + half) % R) + R) % R;
  return m - half;
}
const PLANAR = [
  (u, v, p) => p.a*u*u + p.b*u*v + p.c*v*v + p.d*u + p.e*v,
  (u, v)    => u*u*u + v*v*v,
  (u, v)    => u*u*u - 3*u*v*v,
  (u, v)    => u*v*(u + v),
  (u, v)    => u ^ v,
  (u, v)    => u*v
];
const LIFT_NAMES = ["weighted","extrude","nested"];
const PHI = 1.6180339887498949;

/* A recipe's seed is an unsigned 64-bit BigInt (a plain integer Number is
   accepted too and treated as its low word). The field code works in 32-bit
   lanes (Math.imul), so a seed is split once per build: `lo`/`hi` are the
   two halves, and `mix` is a 32-bit digest of both for the consumers that
   only ever read a few bits (sine phases, sign codes, popcount masks), so
   every seed bit still moves every field mode. Only the per-voxel hash
   field has enough output to tell 2^64 keys apart, and it hashes both
   words in turn. */
function seedWords(seed){
  const u = BigInt.asUintN(64, BigInt(seed));
  const lo = Number(u & 0xffffffffn) >>> 0, hi = Number(u >> 32n) >>> 0;
  let m = Math.imul(lo ^ (lo >>> 16), 0x85ebca6b) >>> 0;
  m = Math.imul((m ^ hi) ^ (m >>> 13), 0xc2b2ae35) >>> 0;
  m ^= m >>> 16;
  return { lo, hi, mix: m >>> 0 };
}

function conicParams(seed){
  let h = seed >>> 0;
  const nxt = () => {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    return h;
  };
  const r = () => (nxt() % 7) - 3;
  const p = { a:r(), b:r(), c:r(), d:r(), e:r() };
  if (p.d === 0 && p.e === 0) p.d = 1;
  if (p.a === 0 && p.b === 0 && p.c === 0) p.b = 1;
  return p;
}

function planarScale(base, p, R){
  const half = (R - 1) / 2;
  let m = 0;
  for (let v = -half; v <= half; v++) for (let u = -half; u <= half; u++) m = Math.max(m, Math.abs(base(u, v, p)));
  return m || 1;
}

function liftPlanar(ix, iy, iz, sx, sy, sz, baseIdx, lift, pars, R){
  const f = PLANAR[baseIdx], p = pars.conic, s = pars.scale[baseIdx];
  const half = (R - 1) / 2;
  let F;
  if (lift === 1){
    F = f(ix, iy, p) / s + 0.37 * (iz / half);
  } else if (lift === 2){
    F = f(wrapR(f(ix, iy, p), R), iz, p) / s;
  } else {
    F = (f(ix, iy, p) + PHI * f(iy, iz, p) + PHI * PHI * f(iz, ix, p)) / (s * (1 + PHI + PHI * PHI));
  }
  return F + 0.11 * sx - 0.07 * sy + 0.19 * sz;
}

function field(sx, sy, sz, mode, seed, lift, pars, R){
  const half = (R - 1) / 2;
  if (mode >= NATIVE_FIELDS){
    return liftPlanar(axisToIndex(sx,R)-half, axisToIndex(sy,R)-half, axisToIndex(sz,R)-half,
                      sx, sy, sz, mode - NATIVE_FIELDS, lift, pars, R);
  }
  const ux = axisToIndex(sx, R), uy = axisToIndex(sy, R), uz = axisToIndex(sz, R);
  if (mode === 0){
    let h = ((ux * 73856093) ^ (uy * 19349663) ^ (uz * 83492791) ^ Math.imul(seed.lo, 0x9e3779b9)) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 16;
    h = Math.imul(h ^ seed.hi, 0xc2b2ae35) >>> 0; h ^= h >>> 15;
    return (h & 0xffff) / 65535;
  }
  if (mode === 1){
    const r = Math.sqrt(1.00*sx*sx + 1.37*sy*sy + 0.71*sz*sz);
    const tilt = 0.55*sx - 0.31*sy + 0.83*sz;
    return 0.5 + 0.5 * Math.sin(r * 9.4248 + tilt * 4.1 + (seed.mix & 0xff) * 0.1);
  }
  if (mode === 2){
    const m = Math.abs(sx) * 1.00 + Math.abs(sy) * 1.31 + Math.abs(sz) * 0.73;
    const tilt = 0.47*sx + 0.91*sy - 0.29*sz;
    return 0.5 + 0.5 * Math.sin(m * 8.0 + tilt * 3.3 + (seed.mix & 0xff) * 0.15);
  }
  let q = ((ux * 11) ^ (uy * 7 + uz * 23) ^ (uz * ux * 5) ^ (ux * uy * 3) ^ (seed.mix & 0xffff)) >>> 0;
  q = q - ((q >>> 1) & 0x55555555);
  q = (q & 0x33333333) + ((q >>> 2) & 0x33333333);
  const cnt = Math.imul((q + (q >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  const tb = Math.imul(((ux * 0x1f1f) ^ (uy * 0x0b0b) ^ (uz * 0x3d3d)) >>> 0, 0x27d4eb2d) >>> 0;
  return (cnt + ((tb >>> 27) / 32)) / 20;
}

/* ---- TIERED-COORDINATE FIELD EXTENSIONS ---------------------------------
   The shared core above deliberately stays untouched.  On the 9^3 lattice each
   folded coordinate is an exact integer g in [-4,4].  Shift to u=g+4 in [0,8]
   and decompose in base 3:

       u = 3 * macro + micro,   macro,micro in {0,1,2}

   Centering each digit gives two local 3-vectors A,B in {-1,0,1}^3.  The
   extensions below operate on the RELATION between those tiers instead of only
   on the flattened coordinate.  Since they are evaluated after foldOrbit(),
   every field still respects the selected subgroup exactly.                 */
const LEGACY_FIELD_COUNT = FIELD_NAMES.length;
const TIER_FIELD_NAMES = [
  "t:digit-swap", "t:wreath", "t:cross", "t:carry", "t:phasecell", "t:prefix-hash"
];
FIELD_NAMES.push(...TIER_FIELD_NAMES);

const TIER_PERMS = PERM; // six axis permutations already used by Oh

function tierDigits(sx, sy, sz, levels, R){
  const ux = axisToIndex(sx,R), uy = axisToIndex(sy,R), uz = axisToIndex(sz,R);
  const dx = decomposeDigits(ux, levels), dy = decomposeDigits(uy, levels), dz = decomposeDigits(uz, levels);
  const L = levels.length;
  const combined = new Array(L), centered = new Array(L), count = new Array(L);
  for (let i = 0; i < L; i++){
    const r = levels[i].radix, h = (r-1)/2;
    combined[i] = dx[i] + r*dy[i] + r*r*dz[i];
    centered[i] = [dx[i]-h, dy[i]-h, dz[i]-h];
    count[i] = r*r*r;
  }
  return {
    dx, dy, dz, L, levels, combined, centered, count,
    a: centered[0], b: centered[L-1],                 // kept for the two axis-mixing-only terms below
    macro: combined[0], micro: combined[L-1],
    r0: levels[0].radix, rL: levels[L-1].radix,
    macroCount: count[0], microCount: count[L-1]
  };
}

/* =====================================================================
   Six modes, each a genuine cascade over every level (not just outermost
   + innermost). Every mode is written so its L=2 specialization reduces
   EXACTLY to the formula this replaced — hand-verified below inline,
   then checked byte-for-byte against the golden reference again after
   editing, the same way the original port was verified.
   ===================================================================== */
function tierField(sx, sy, sz, mode, seed, levels, R){
  const T = tierDigits(sx,sy,sz,levels,R), A=T.a, B=T.b, L=T.L;
  const effSeed = seed.mix;
  const seedPhase = (effSeed & 255) / 255;

  if (mode === 0){
    // Exchange significance across the WHOLE stack: reverse both the digit order
    // and the level order, recompose. At L=2 this is exactly r0*B+A (proven
    // numerically against a heterogeneous-radix case when this was first ported);
    // at L>2 every middle level's place in the significance ordering flips too.
    const revLevels = T.levels.slice().reverse();
    const rev = a => a.slice().reverse();
    const half = (R - 1) / 2;
    const qx = composeDigits(rev(T.dx), revLevels) - half;
    const qy = composeDigits(rev(T.dy), revLevels) - half;
    const qz = composeDigits(rev(T.dz), revLevels) - half;
    return Math.sin(1.37*qx + 2.11*qy - 1.73*qz + seedPhase*6.28318);
  }

  if (mode === 1){
    // Wreath cascade: starting from the innermost centered vector, each level
    // going outward (right to left) picks a permutation+sign from its OWN
    // combined address and folds the result into the running vector; the
    // outermost level's step collapses the cascade to a scalar. At L=2 the
    // loop runs once (i=0) and reduces exactly to the old macro-picks-a-
    // permutation-of-micro formula. At L=1 there's no outer tier to cascade
    // from, so the single level folds onto itself instead (this used to
    // silently fall through to mode 5's code below — caught by testing L=1
    // explicitly rather than assuming the loop always fires).
    let V = T.centered[L-1].slice();
    if (L === 1){
      const combined_i = T.combined[0];
      const P = TIER_PERMS[combined_i % 6];
      const signCode = ((combined_i * 0x9e37) ^ effSeed) & 7;
      const perm = [0,1,2].map(k => V[P[k]] * ((signCode >> k & 1) ? -1 : 1));
      return 0.91*perm[0] - 1.27*perm[1] + 1.63*perm[2] +
             0.43*V[0] + 0.71*V[1] - 0.37*V[2] + 0.21*(perm[0]*V[1]-perm[1]*V[0]);
    }
    for (let i = L-2; i >= 0; i--){
      const combined_i = T.combined[i];
      const P = TIER_PERMS[combined_i % 6];
      const signCode = ((combined_i * 0x9e37) ^ effSeed ^ (i * 0x2545)) & 7;
      const perm = [0,1,2].map(k => V[P[k]] * ((signCode >> k & 1) ? -1 : 1));
      const Ai = T.centered[i];
      if (i === 0){
        return 0.91*perm[0] - 1.27*perm[1] + 1.63*perm[2] +
               0.43*Ai[0] + 0.71*Ai[1] - 0.37*Ai[2] + 0.21*(perm[0]*Ai[1]-perm[1]*Ai[0]);
      }
      V = [perm[0]+Ai[0], perm[1]+Ai[1], perm[2]+Ai[2]];
    }
  }

  if (mode === 2){
    // Cross cascade: every ADJACENT pair of levels contributes its own
    // dot/cross frame, summed. At L=2 there is exactly one pair (outer,inner)
    // and this is precisely the old single-pair formula; a middle level at
    // L=3 contributes via both of its adjacent relations. At L=1 there's no
    // pair at all, so the level pairs with itself (cross terms vanish, dot
    // survives) rather than silently returning a constant 0 for every cell.
    if (L === 1){
      const V = T.centered[0];
      return V[0]*V[0] + V[1]*V[1] + V[2]*V[2];
    }
    let total = 0;
    for (let i = 0; i < L-1; i++){
      const Vi = T.centered[i], Vj = T.centered[i+1];
      const dot = Vi[0]*Vj[0] + Vi[1]*Vj[1] + Vi[2]*Vj[2];
      const cx = Vi[1]*Vj[2]-Vi[2]*Vj[1];
      const cy = Vi[2]*Vj[0]-Vi[0]*Vj[2];
      const cz = Vi[0]*Vj[1]-Vi[1]*Vj[0];
      total += dot + 0.73*cx - 0.41*cy + 0.59*cz + 0.17*(T.combined[i]-T.combined[i+1]);
    }
    return total;
  }

  if (mode === 3){
    // Carry cascade: the same mixed-radix odometer/fold formula applied to
    // every adjacent (outer,inner) pair of levels and summed, rather than
    // only the outermost/innermost pair. At L=1, self-pair for the same
    // reason as mode 2 above.
    if (L === 1){
      const rA = T.levels[0].radix, combinedA = T.combined[0], mod2 = rA*rA;
      const n = combinedA * (1 + T.count[0]);
      const carry = Math.floor((combinedA + (combinedA % mod2)) / mod2);
      return Math.sin(n*0.173 + carry*1.91 + seedPhase*4.0) + 0.35;
    }
    let total = 0;
    for (let i = 0; i < L-1; i++){
      const rA = T.levels[i].radix;
      const combinedA = T.combined[i], combinedB = T.combined[i+1], countB = T.count[i+1];
      const mod2 = rA*rA;
      const n = combinedB + countB*combinedA;
      const carry = Math.floor((combinedB + (combinedA % mod2)) / mod2);
      total += Math.sin(n*0.173 + carry*1.91 + seedPhase*4.0) + 0.35*Math.cos((combinedB-combinedA)*0.67);
    }
    return total;
  }

  if (mode === 4){
    // Phasecell cascade: every non-innermost level contributes its own phase
    // term (chained with a per-depth salt so levels don't alias each other),
    // summed before driving the same local/radius wave on the innermost tier.
    let phase = 0;
    for (let i = 0; i < L-1; i++){
      const combined_i = T.combined[i], count_i = T.count[i];
      phase += ((combined_i*7 + (effSeed & 31) + i*13) % count_i) / count_i * 6.28318530718;
    }
    const r = Math.hypot(B[0],B[1],B[2]);
    const local = B[0] + 1.7*B[1] - 1.3*B[2];
    return Math.sin(local*1.55 + r*2.4 + phase) + 0.18*(A[0]-A[1]+A[2]);
  }

  // Prefix hash cascade: chain-hash through every non-innermost level (so a
  // middle level's address perturbs the hash the same way the outermost
  // level used to alone), then use the final hash as coefficients on the
  // innermost tier exactly as before.
  let h = effSeed >>> 0;
  for (let i = 0; i < L-1; i++){
    const combined_i = T.combined[i];
    h = Math.imul((combined_i + 1) ^ h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  }
  const c0 = ((h      ) & 255) / 127.5 - 1;
  const c1 = ((h >>  8) & 255) / 127.5 - 1;
  const c2 = ((h >> 16) & 255) / 127.5 - 1;
  return c0*B[0] + c1*B[1] + c2*B[2] + 0.28*(A[0]*B[1] + A[1]*B[2] + A[2]*B[0]);
}

/* =====================================================================
   PHASE 0 — ORBIT ENUMERATION
   ---------------------------------------------------------------------
   The old inner loop called foldOrbit() once per cell: |G| matrix applies
   to find the lexicographic minimum of the orbit. That is |G| times more
   work than the information content, because the field is constant on
   orbits by construction.

   Instead: walk cells in scan order; the first unvisited cell begins a new
   orbit. Generate the orbit once (|G| applies), evaluate envelope+field ONCE
   at its canonical representative, and scatter the result to every member.
   Cost falls from |G|*R^3 to |G|*(number of orbits) — measured 46x fewer
   orbits than cells at R=243 under Oh.

   The only delicate part is `orbit[]`, which stores per-cell the index of
   the group element that wins the fold — different for each orbit member.
   For w = els[j]·v it is derived, not searched:

       els[i]·w = canon   <=>   els[i]els[j]·v = canon
                          <=>   MUL[i][j] ∈ W        (W = winners for v)
                          <=>   i = MUL[p][INV[j]],  p ∈ W

   so one table lookup per member per winner reproduces foldOrbit's choice
   exactly, including its lowest-index tie-break.
   ===================================================================== */
function groupTables(els){
  const n = els.length;
  const MUL = new Uint8Array(n * n), INV = new Uint8Array(n);
  const where = new Map();
  for (let i = 0; i < n; i++) where.set(els[i], i);
  for (let a = 0; a < n; a++){
    for (let b = 0; b < n; b++){
      const c = where.get(mulE(els[a], els[b]));
      MUL[a * n + b] = c;
      if (els[c] === 0) INV[a] = b;      // els[a]·els[b] = identity
    }
  }
  return { MUL, INV, n };
}

/* Exact k-th smallest, in place, O(n) average. Replaces a full sort whose
   only output was one order statistic. Returns the same value the sort did,
   so the >= comparison downstream selects byte-identically. */
function quickSelect(a, k){
  let lo = 0, hi = a.length - 1;
  while (lo < hi){
    const mid = (lo + hi) >> 1;
    // median of three, to avoid the sorted-input worst case
    let p = a[mid];
    if ((a[lo] < p) !== (p < a[hi])) p = (a[lo] < a[hi]) === (a[lo] < p) ? a[hi] : a[lo];
    let i = lo, j = hi;
    while (i <= j){
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j){ const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[lo];
}

/** Number of the 48 Oh elements that map the occupancy onto itself.
 *  @param {Uint8Array} occ @param {number} R @returns {number} */
function autOrder(occ, R){
  const half = (R - 1) / 2;
  let n = 0;
  for (let e = 0; e < 48; e++){
    let ok = true;
    for (let z = 0; z < R && ok; z++) for (let y = 0; y < R && ok; y++) for (let x = 0; x < R && ok; x++){
      const w = applyG([x-half, y-half, z-half], e);
      if (occ[x + R*y + R*R*z] !== occ[(w[0]+half) + R*(w[1]+half) + R*R*(w[2]+half)]) ok = false;
    }
    if (ok) n++;
  }
  return n;
}

/* =====================================================================
   BIMOBLOCK GEOMETRY & LOCAL GAMUT COLOR SPACE
   ---------------------------------------------------------------------
   Every vertex is assigned its pure normalized local bounding box RGB:
     R = (local_X + 0.5)
     G = (local_Y + 0.5)
     B = (local_Z + 0.5)
   ===================================================================== */
/* Cube face templates, in the fixed order +X -X +Y -Y +Z -Z.  Flat typed
   arrays rather than per-face objects holding arrays of arrays: the emit
   loop below runs once per exposed face and indexes straight into these
   instead of walking a pointer chain per corner.
     FACE_D   - outward normal, and the logical neighbour step, 6 x 3
     FACE_OFF - corner offsets from the cube centre in cell units,
                6 faces x 4 corners x 3, always +/- 0.5.  Winding is
                counter-clockwise seen from outside, unchanged.
   The neighbour test is a table too — see `touch` in meshArrays(). */
const FACE_D = new Float64Array([
   1,0,0,  -1,0,0,   0,1,0,   0,-1,0,   0,0,1,   0,0,-1 ]);
const FACE_OFF = new Float64Array([
  // +X                     -X
   .5,-.5,-.5,  .5,.5,-.5,  .5,.5,.5,  .5,-.5,.5,
  -.5,-.5,.5,  -.5,.5,.5,  -.5,.5,-.5, -.5,-.5,-.5,
  // +Y                     -Y
  -.5,.5,-.5,  -.5,.5,.5,   .5,.5,.5,  .5,.5,-.5,
  -.5,-.5,.5,  -.5,-.5,-.5, .5,-.5,-.5, .5,-.5,.5,
  // +Z                     -Z
   .5,-.5,.5,   .5,.5,.5,  -.5,.5,.5, -.5,-.5,.5,
  -.5,-.5,-.5, -.5,.5,-.5,  .5,.5,-.5, .5,-.5,-.5 ]);

function siteTier(occ, filled, levels, R){
  const r0 = levels[0].radix, macroCells = r0*r0*r0;
  // Which macro cell (levels[0]'s own digit) does each axis value belong to?
  const macroOf = new Int32Array(R);
  for (let v = 0; v < R; v++) macroOf[v] = decomposeDigits(v, levels)[0];

  const pc = new Int32Array(macroCells);
  for (let z = 0; z < R; z++){ const mz = macroOf[z];
    for (let y = 0; y < R; y++){ const my = macroOf[y];
      for (let x = 0; x < R; x++){
        if (!occ[x + R*y + R*R*z]) continue;
        pc[macroOf[x] + r0*my + r0*r0*mz]++;
      }
    }
  }
  const p = filled / (R*R*R);
  const want = Math.max(1, Math.round((1 - Math.pow(1 - p, 3)) * macroCells));
  let cut = 1;
  for (let T = 1; T <= macroCells; T++){
    let n = 0;
    for (let j = 0; j < macroCells; j++) if (pc[j] >= T) n++;
    if (n === 0 || n < want) break;
    cut = T;
  }
  const out = new Uint8Array(macroCells);
  for (let j = 0; j < macroCells; j++) out[j] = pc[j] >= cut ? 1 : 0;
  return out;
}

/* Which of a cube's six faces meet each of its eight corners, as face-mask
   bits in the FACE_D order (+X -X +Y -Y +Z -Z).  Corner c is indexed
   ((sx>0)<<2) | ((sy>0)<<1) | (sz>0); a corner is carried by the mesh iff
   any of its three faces survived occlusion, which is what makes the
   bounding radius computable without expanding a single vertex. */
const CORNER_FACES = new Uint8Array(8);
for (let c = 0; c < 8; c++)
  CORNER_FACES[c] = (c & 4 ? 1 : 2) | (c & 2 ? 4 : 8) | (c & 1 ? 16 : 32);

/* ---------------------------------------------------------------------
   THE INSTANCE RECORD
   ---------------------------------------------------------------------
   The occupancy walk is the only place face occlusion is decided, and what
   it produces is the specimen in full: which cells are occupied, which of
   their faces survive, and the axis table their coordinates come from.
   Every representation the app draws or exports is a function of that
   record, so it — not a baked vertex buffer — is what a build returns and
   what the cache holds.

     cells   flat grid index per occupied cell, in walk order (Uint32)
     masks   the six-bit surviving-face set for that cell (Uint8)
     orbitIdx  per-cell fold-element index, full resolution only (Uint8)
     centers   the f64 axis centre table, shared by all three axes
     cellSize  physical cube width, in the same unit-box coordinates

   `centers` stays double precision deliberately.  A centre rounded to f32
   and then offset by half a cell lands up to one f32 ulp away from the
   same vertex computed in double and rounded once, so keeping the table
   exact is what lets expandInstances() reproduce a baked mesh bit for bit
   while the GPU still gets the compact f32 centres it wants.
   @param {Uint8Array} occ @param {number} tier 0 = full mesh, 1 = outer-tier proxy
   @param {number} filled @param {import('../types.js').Level[]} levels @param {number} R
   @param {Uint8Array} [orbit] @param {number} [orbitOrder]
   @returns {import('../types.js').InstanceArrays} */
function instanceArrays(occ, tier, filled, levels, R, orbit, orbitOrder){
  const started = performance.now();
  const r0 = levels[0].radix;
  const N = tier ? r0 : R;
  const sites = tier ? siteTier(occ, filled, levels, R) : null;
  const cell = tier ? sites : occ;          // occupancy the mesh is built from
  const axis = tierAxisLayout(levels, tier);
  const centers = axis.centers, cellSize = axis.cellSize;
  const half = cellSize / 2;
  // Orbit-index coloring only has a well-defined meaning at full resolution —
  // the LOD proxy's cells are aggregates of several voxels that may carry
  // different orbit indices, so it always stays on the gamut attribute.
  const wantOrbit = !tier && !!orbit && orbitOrder > 0;

  // Occupied logical neighbours hide a face only when their physical cubes
  // still touch.  That test depends only on the pair of indices along one
  // axis, never on the other two, so it collapses to a table: touch[u] is
  // set when cells u and u+1 are close enough to hide the face between them.
  // A non-zero gap at any crossed tier boundary leaves the pair apart and
  // exposes both sides of the resulting opening.
  const touch = new Uint8Array(N);
  for (let u = 0; u + 1 < N; u++)
    touch[u] = (centers[u+1] - centers[u]) <= cellSize * (1 + 1e-9) ? 1 : 0;

  // One walk over the grid records the occupied cells and, for each, which of
  // its six faces survive.  Everything downstream iterates those `count`
  // cells instead of N^3 ones and never probes a neighbour again.
  // `filled` sizes the lists, but the walk never trusts it: a caller passing
  // a stale count would otherwise silently drop cells off the end.
  let cells = new Uint32Array(tier ? N*N*N : Math.max(filled, 1));
  let masks = new Uint8Array(cells.length);  // bit f set = face f survives
  let orbitIdx = wantOrbit ? new Uint8Array(cells.length) : null;
  let count = 0, quads = 0;
  // Occupied extent per axis: the bounding box is analytic from these, since
  // a cell at an axis extreme always has an unoccupied neighbour beyond it
  // and so always keeps the face that carries the extreme vertex.
  let minX = N, minY = N, minZ = N, maxX = -1, maxY = -1, maxZ = -1;
  const NN = N*N;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++){
    const row = N*y + NN*z;
    for (let x = 0; x < N; x++){
      if (!cell[x + row]) continue;
      let m = 0;
      if (!(x + 1 <  N && touch[x]     && cell[x+1 + row])) { m |= 1;  quads++; }
      if (!(x - 1 >= 0 && touch[x-1]   && cell[x-1 + row])) { m |= 2;  quads++; }
      if (!(y + 1 <  N && touch[y]     && cell[x + row + N]))  { m |= 4;  quads++; }
      if (!(y - 1 >= 0 && touch[y-1]   && cell[x + row - N]))  { m |= 8;  quads++; }
      if (!(z + 1 <  N && touch[z]     && cell[x + row + NN])) { m |= 16; quads++; }
      if (!(z - 1 >= 0 && touch[z-1]   && cell[x + row - NN])) { m |= 32; quads++; }
      if (count === cells.length){
        const c2 = new Uint32Array(count * 2); c2.set(cells); cells = c2;
        const m2 = new Uint8Array(count * 2); m2.set(masks); masks = m2;
        if (orbitIdx){ const o2 = new Uint8Array(count * 2); o2.set(orbitIdx); orbitIdx = o2; }
      }
      const li = x + row;
      cells[count] = li; masks[count] = m;
      if (orbitIdx) orbitIdx[count] = orbit[li];
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  // The walk over-allocates whenever `filled` was an upper bound (always, for
  // the tier proxy). The record is retained for the specimen's whole life and
  // shipped across a worker boundary, so trim rather than carry the slack.
  if (count !== cells.length){
    cells = cells.slice(0, count);
    masks = masks.slice(0, count);
    if (orbitIdx) orbitIdx = orbitIdx.slice(0, count);
  }

  /* Bounds, without touching a vertex. The centre is the analytic box
     midpoint; the radius is the farthest *surviving* corner, which the
     face mask names directly — an enclosed cell contributes nothing, and
     a cell at an extreme always contributes its extreme corner. Rounding
     each corner with fround reproduces the figure a pass over the f32
     vertex buffer would have produced, to the bit. */
  const f32 = Math.fround;
  const empty = count === 0;
  const cx = empty ? 0 : (f32(centers[minX] - half) + f32(centers[maxX] + half)) / 2;
  const cy = empty ? 0 : (f32(centers[minY] - half) + f32(centers[maxY] + half)) / 2;
  const cz = empty ? 0 : (f32(centers[minZ] - half) + f32(centers[maxZ] + half)) / 2;
  let radiusSq = 0;
  for (let c = 0; c < count; c++){
    const m = masks[c];
    if (!m) continue;
    const li = cells[c];
    const x = li % N, y = ((li / N) | 0) % N, z = (li / NN) | 0;
    const xl = f32(centers[x] - half) - cx, xh = f32(centers[x] + half) - cx;
    const yl = f32(centers[y] - half) - cy, yh = f32(centers[y] + half) - cy;
    const zl = f32(centers[z] - half) - cz, zh = f32(centers[z] + half) - cz;
    for (let k = 0; k < 8; k++){
      if (!(m & CORNER_FACES[k])) continue;
      const qx = k & 4 ? xh : xl, qy = k & 2 ? yh : yl, qz = k & 1 ? zh : zl;
      const d = qx*qx + qy*qy + qz*qz;
      if (d > radiusSq) radiusSq = d;
    }
  }

  const done = performance.now();
  return { cells, masks, orbitIdx, orbitOrder: wantOrbit ? orbitOrder : 0,
    count, N, centers, cellSize, quads, tris: quads * 2,
    bounds: { center: [cx, cy, cz], radius: Math.sqrt(radiusSq) },
    bytes: cells.byteLength + masks.byteLength + (orbitIdx ? orbitIdx.byteLength : 0)
         + centers.byteLength,
    timings: { mesh: done - started, bounds: 0 } };
}

/** Expand an instance record into the independent-quad vertex buffers the
 *  OBJ exporters and the golden tests read. This is the only place the
 *  baked form is still built, and it is built on demand rather than kept.
 *  @param {import('../types.js').InstanceArrays} rec
 *  @returns {import('../types.js').MeshArrays} */
function expandInstances(rec){
  const started = performance.now();
  const { cells, masks, orbitIdx, orbitOrder, count, N, centers, cellSize, quads } = rec;
  const wantOrbit = !!orbitIdx && orbitOrder > 0;
  const NN = N*N;

  const pos = new Float32Array(quads * 12);
  const col = new Float32Array(quads * 12);
  const colOrbit = wantOrbit ? new Float32Array(quads * 12) : null;
  const nrm = new Float32Array(quads * 12);
  const idx = new (quads * 4 > 65535 ? Uint32Array : Uint16Array)(quads * 6);

  let v = 0, o = 0, io = 0;
  for (let c = 0; c < count; c++){
    const m = masks[c];
    const li = cells[c];
    const x = li % N, y = ((li / N) | 0) % N, z = (li / NN) | 0;
    const ox = centers[x], oy = centers[y], oz = centers[z];
    // One flat orbit color per voxel, not per vertex — every corner of every
    // face on this cube shares it, so orbit boundaries land exactly on cube
    // faces rather than fading like the gamut gradient does.
    let ocR = 0, ocG = 0, ocB = 0;
    if (wantOrbit){
      const oc = orbitColor(orbitIdx[c], orbitOrder);
      ocR = oc[0]; ocG = oc[1]; ocB = oc[2];
    }
    for (let f = 0; f < 6; f++){
      if (!(m & (1 << f))) continue;
      const nb = f * 3, vb = f * 12;
      const dx = FACE_D[nb], dy = FACE_D[nb+1], dz = FACE_D[nb+2];
      for (let k = vb; k < vb + 12; k += 3){
        const px = ox + FACE_OFF[k]   * cellSize;
        const py = oy + FACE_OFF[k+1] * cellSize;
        const pz = oz + FACE_OFF[k+2] * cellSize;

        pos[o]   = px; pos[o+1] = py; pos[o+2] = pz;
        // Pure normalized local gamut color
        col[o]   = px + 0.5;
        col[o+1] = py + 0.5;
        col[o+2] = pz + 0.5;
        if (wantOrbit){ colOrbit[o] = ocR; colOrbit[o+1] = ocG; colOrbit[o+2] = ocB; }

        nrm[o] = dx; nrm[o+1] = dy; nrm[o+2] = dz;
        o += 3;
      }
      idx[io] = v; idx[io+1] = v+1; idx[io+2] = v+2;
      idx[io+3] = v; idx[io+4] = v+2; idx[io+5] = v+3;
      v += 4; io += 6;
    }
  }

  return { pos, col, colOrbit, nrm, idx, quads, tris: quads * 2,
    bounds: { center: rec.bounds.center.slice(), radius: rec.bounds.radius },
    bytes: pos.byteLength + col.byteLength + (colOrbit ? colOrbit.byteLength : 0) + nrm.byteLength + idx.byteLength,
    timings: { mesh: performance.now() - started, bounds: 0 } };
}

/** The baked mesh for an occupancy grid: the instance record, expanded.
 *  Kept because the OBJ exporters and the golden hashes are defined on it;
 *  nothing on the render path calls it any more.
 *  @param {Uint8Array} occ @param {number} tier 0 = full mesh, 1 = outer-tier proxy
 *  @param {number} filled @param {import('../types.js').Level[]} levels @param {number} R
 *  @param {Uint8Array} [orbit] @param {number} [orbitOrder]
 *  @returns {import('../types.js').MeshArrays} */
function meshArrays(occ, tier, filled, levels, R, orbit, orbitOrder){
  const rec = instanceArrays(occ, tier, filled, levels, R, orbit, orbitOrder);
  const out = expandInstances(rec);
  out.timings = { mesh: rec.timings.mesh + out.timings.mesh, bounds: 0 };
  return out;
}

/* One point per occupied voxel, at the centre of its physical cube, in the
   same unit-box coordinates meshArrays() uses.  The showroom's "box centers"
   display mode draws these as a point cloud; the gamut colour of a centre is
   simply centre + 0.5, exactly as it is for mesh vertices.
   @param {Uint8Array} occ @param {import('../types.js').Level[]} levels @param {number} R
   @returns {{ pos: Float32Array, count: number, cellSize: number }} */
function voxelCenters(occ, levels, R){
  const { centers, cellSize } = tierAxisLayout(levels, false);
  let count = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i]) count++;
  const pos = new Float32Array(count * 3);
  let o = 0;
  for (let z = 0; z < R; z++) for (let y = 0; y < R; y++) for (let x = 0; x < R; x++){
    if (!occ[x + R*y + R*R*z]) continue;
    pos[o] = centers[x]; pos[o+1] = centers[y]; pos[o+2] = centers[z];
    o += 3;
  }
  return { pos, count, cellSize };
}

// Canonicalize each mixed-radix digit triple independently. Lookup tables avoid
// a product-group expansion and keep group operations outside the voxel loop.
function tierFolder(P, levels, R){
  const axes = Array.from({length:R}, (_,u)=>foldedAxis(u, levels));
  const digits = Array.from({length:R}, (_,u)=>decomposeDigits(u, levels));
  const orbitTables = [];
  const tables = levels.map(l=>{
    const r=l.radix, h=(r-1)/2, table=new Uint16Array(r*r*r), orbitTable=new Uint8Array(r*r*r);
    const group=GROUPS[l.sym == null || l.sym < 0 ? P.sym : l.sym];
    for(let z=0;z<r;z++) for(let y=0;y<r;y++) for(let x=0;x<r;x++){
      const v=foldOrbit([x-h,y-h,z-h],group.els);
      const idx=x+r*y+r*r*z;
      table[idx]=(v[0]+h)+r*(v[1]+h)+r*r*(v[2]+h);
      orbitTable[idx]=v[3];
    }
    orbitTables.push(orbitTable);
    return table;
  });
  const fold = (x,y,z)=>{
    let a=0,b=0,c=0;
    for(let i=0;i<levels.length;i++){
      const r=levels[i].radix, v=tables[i][digits[x][i]+r*digits[y][i]+r*r*digits[z][i]];
      a=a*r+v%r; b=b*r+Math.floor(v/r)%r; c=c*r+Math.floor(v/(r*r));
    }
    return [axes[a],axes[b],axes[c]];
  };
  // Per-voxel orbit index for the OUTER tier only — the same tier
  // specimenChiral() treats as the specimen's macro identity when tiers
  // disagree. A composite index across every independent tier is future work.
  const r0 = levels[0].radix;
  fold.outerOrbit = (x,y,z) => orbitTables[0][digits[x][0] + r0*digits[y][0] + r0*r0*digits[z][0]];
  fold.outerOrder = GROUPS[levels[0].sym == null || levels[0].sym < 0 ? P.sym : levels[0].sym].order;
  return fold;
}

/** @param {import('../types.js').Recipe} P @param {import('../types.js').Level[]} levels
 *  @returns {import('../types.js').BuildResult} */
function buildBlock(P, levels){
  const started = performance.now();
  const G = GROUPS[P.sym];
  const fmode = P.field;
  const R = levelResolution(levels);
  const foldTier = P.tierSymmetry ? tierFolder(P, levels, R) : null;
  const orbitOrder = foldTier ? foldTier.outerOrder : G.order;
  const S = seedWords(P.seed);
  const pars = { conic: conicParams(S.mix), scale: [] };
  if (fmode >= NATIVE_FIELDS && fmode < LEGACY_FIELD_COUNT)
    pars.scale[fmode - NATIVE_FIELDS] = planarScale(PLANAR[fmode - NATIVE_FIELDS], pars.conic, R);

  // Envelope cells are collected into preallocated typed arrays rather than
  // grown JS arrays: at R=243 that is 7.3M pushes avoided. Falls back to plain
  // arrays past 32M cells, where an R^3-sized Float64Array stops being sane.
  const NCELL = R*R*R, typed = NCELL <= 33554432;
  const idxArr = typed ? new Int32Array(NCELL) : [];
  const vals   = typed ? new Float64Array(NCELL) : [];
  let nVals = 0;
  const orbit = new Uint8Array(R*R*R); // winning fold-element index per cell (only meaningful where occ ends up 1)
  const evalOne = (s0, s1, s2) => fmode < LEGACY_FIELD_COUNT
    ? field(s0, s1, s2, fmode, S, P.lift, pars, R)
    : tierField(s0, s1, s2, fmode - LEGACY_FIELD_COUNT, S, levels, R);

  if (foldTier){
    // tierFolder already works from per-level lookup tables, so the per-cell
    // cost is a handful of array reads; this path is left exactly as it was.
    for (let z = 0; z < R; z++){
      for (let y = 0; y < R; y++){
        for (let x = 0; x < R; x++){
          const s = foldTier(x,y,z), bi = foldTier.outerOrbit(x,y,z);
          if (!envelope(s[0], s[1], s[2], P.arch)) continue;
          const flat = x + R*y + R*R*z;
          orbit[flat] = bi;
          const v = evalOne(s[0], s[1], s[2]);
          if (typed){ idxArr[nVals] = flat; vals[nVals] = v; } else { idxArr.push(flat); vals.push(v); }
          nVals++;
        }
      }
    }
  } else {
    const half = (R - 1) / 2;
    const ax = new Float64Array(R);
    for (let u = 0; u < R; u++) ax[u] = foldedAxis(u, levels);
    const els = G.els, nE = els.length;
    const { MUL, INV } = groupTables(els);
    const visited = new Uint8Array(R*R*R);
    // NOTE: half is a half-integer when R is even, so orbit members carry
    // half-integer coordinates. These must stay floats — an Int32Array here
    // truncates and silently corrupts every even-radix lattice.
    const mX = new Float64Array(nE), mY = new Float64Array(nE), mZ = new Float64Array(nE);
    const W = new Int32Array(nE);

    for (let z = 0; z < R; z++){
      for (let y = 0; y < R; y++){
        for (let x = 0; x < R; x++){
          const flat = x + R*y + R*R*z;
          if (visited[flat]) continue;

          // generate the orbit, and record which elements win the fold
          const v = [x - half, y - half, z - half];
          let bx = v[0], by = v[1], bz = v[2], nW = 0;
          for (let j = 0; j < nE; j++){
            const w = applyG(v, els[j]);
            mX[j] = w[0]; mY[j] = w[1]; mZ[j] = w[2];
            if (w[0] < bx || (w[0] === bx && (w[1] < by || (w[1] === by && w[2] < bz)))){
              bx = w[0]; by = w[1]; bz = w[2]; nW = 0; W[nW++] = j;
            } else if (w[0] === bx && w[1] === by && w[2] === bz){
              W[nW++] = j;
            }
          }

          // one envelope test and one field evaluation for the whole orbit
          const s0 = ax[Math.round(bx + half)], s1 = ax[Math.round(by + half)],
                s2 = ax[Math.round(bz + half)];
          const inEnv = envelope(s0, s1, s2, P.arch);
          const val = inEnv ? evalOne(s0, s1, s2) : 0;

          for (let j = 0; j < nE; j++){
            const fj = Math.round(mX[j] + half) + R*Math.round(mY[j] + half)
                     + R*R*Math.round(mZ[j] + half);
            if (visited[fj]) continue;
            visited[fj] = 1;
            if (!inEnv) continue;
            const ij = INV[j] * 1;
            let best = nE;
            for (let p = 0; p < nW; p++){
              const i = MUL[W[p] * nE + ij];
              if (i < best) best = i;
            }
            orbit[fj] = best;
            if (typed){ idxArr[nVals] = fj; vals[nVals] = val; } else { idxArr.push(fj); vals.push(val); }
            nVals++;
          }
        }
      }
    }
  }

  const evaluated = performance.now();
  const occ = new Uint8Array(R*R*R);
  let filled = 0;
  if (nVals){
    const scratch = typed ? vals.slice(0, nVals) : Float64Array.from(vals);
    const want = Math.max(1, Math.round(P.density * nVals));
    const cut = quickSelect(scratch, Math.max(0, nVals - want));
    for (let k = 0; k < nVals; k++)
      if (vals[k] >= cut){ occ[idxArr[k]] = 1; filled++; }
  }

  const selected = performance.now();
  const instances = instanceArrays(occ, 0, filled, levels, R, orbit, orbitOrder);
  return { occ, R, filled, envelopeCells: nVals, instances,
    timings: { evaluate: evaluated - started, select: selected - evaluated,
      mesh: instances.timings.mesh, bounds: instances.timings.bounds,
      total: performance.now() - started } };
}

/* The cube face templates, published so the renderer's instanced template
   geometry is cut from the same table the CPU expansion uses: same face
   order, same corner order, same winding. */
const FACE_TEMPLATE = { dir: FACE_D, off: FACE_OFF };

return { GROUPS, ARCH_NAMES, FIELD_NAMES, NATIVE_FIELDS, LEGACY_FIELD_COUNT, LIFT_NAMES, levelResolution, buildBlock, instanceArrays, expandInstances, meshArrays, voxelCenters, autOrder, seedWords, orbitColor, FACE_TEMPLATE };
}
// Main-thread instance. The worker builds its own via createBimoblockCore().
export const Core = createBimoblockCore();