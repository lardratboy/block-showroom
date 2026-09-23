/* Address → specimen. Everything here is a pure function of a lattice
   coordinate and the shared state in state.js (axis roles, filters, the
   mint generation, the district pin); nothing here is cached or owned. */
import { Core } from '../core/bimoblock-core.js';
import { CFG, ROLE_BY_ID, clamp, imod, idiv } from '../config.js';
import { Axis, Filter, Mint, Pin } from '../state.js';

const { GROUPS, ARCH_NAMES, FIELD_NAMES, LIFT_NAMES } = Core;

export function symmetryLabel(p, short=false){
  const name=i=>short ? GROUPS[i].name.split(':')[0] : GROUPS[i].name;
  return p.tierSymmetry ? p.levels.map(l=>name(l.sym == null || l.sym < 0 ? p.sym : l.sym)).join(' / ') : name(p.sym);
}
/* Chirality is a property of a whole subgroup (every element has det>0 or it
   doesn't), never a per-voxel quantity, so this resolves to one flag per
   specimen. In independent-tier mode that's the OUTER tier's group, since the
   outer tier sets the macro silhouette a glance at the specimen actually
   shows — the same "inherit specimen group" sentinel used by symmetryLabel. */
export function specimenChiral(p){
  if (p.tierSymmetry && p.levels && p.levels.length){
    const l0 = p.levels[0];
    const gi = (l0.sym == null || l0.sym < 0) ? p.sym : l0.sym;
    return GROUPS[gi].chiral;
  }
  return GROUPS[p.sym].chiral;
}

/* Lattice address → world position on the floor plane. */
export function cellWorldX(i){ return i * CFG.CELL; }
export function cellWorldZ(j){ return -j * CFG.CELL; }

export function hash32(a, b){
  let h = ((a | 0) ^ Math.imul((b | 0) + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/* Seeds are unsigned 64-bit BigInts, assembled from and split into two
   uint32 words because everything that hashes here works in 32-bit lanes.
   The split is Core.seedWords(); this is its inverse and the display form. */
export function seedFromWords(lo, hi){
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}
export function seedHex(seed){
  return BigInt.asUintN(64, BigInt(seed)).toString(16).padStart(16, '0');
}

/* Parameters of the specimen standing at (i,j).  Pure; no state beyond
   the axis assignment, the filters, the density and Mint.gen.
   @param {number} i @param {number} j @returns {import('../types.js').Recipe} */
export function cellParams(i, j){
  let pageX = i, pageY = j;
  const got = {};
  for (const role of ['arch','sym','field','lift','dens']){
    const n = ROLE_BY_ID[role].count;
    if (Axis.x === role){ got[role] = imod(i, n); pageX = idiv(i, n); }
    else if (Axis.y === role){ got[role] = imod(j, n); pageY = idiv(j, n); }
  }

  const h = hash32(hash32(pageX, 0x51ed270b ^ Math.imul(Mint.gen, 0x9e3779b1)), pageY * 31 + 7);

  const sym   = got.sym   != null ? got.sym   : (Filter.sym   >= 0 ? Filter.sym   :  h         % GROUPS.length);
  const arch  = got.arch  != null ? got.arch  : (Filter.arch  >= 0 ? Filter.arch  : (h >>>  8) % ARCH_NAMES.length);
  const fmode = got.field != null ? got.field : (Filter.field >= 0 ? Filter.field : (h >>> 16) % FIELD_NAMES.length);
  const lift  = got.lift  != null ? got.lift  : (h >>> 24) % LIFT_NAMES.length;
  const density = got.dens != null ? 0.10 + got.dens * 0.055 : Mint.density;

  /* One seed per page, deliberately: within a page the family
     resemblance across archetypes and subgroups is the whole point.
     The seed is 64 bits: its low word comes off the page hash above, its
     high word off a second, independently salted hash of the same (page,
     generation) so it carries entropy the traits did not already use. */
  const h2 = hash32(hash32(pageY, 0x2545f491 ^ Math.imul(Mint.gen, 0x85ebca6b)), pageX * 37 + 11);
  const seed = seedFromWords(hash32(h, 0x2545f491), hash32(h2, 0x9e3779b1));
  return { sym, arch, field:fmode, lift, density, seed };
}


/* =====================================================================
   SIBLING DISTRICTS
   ---------------------------------------------------------------------
   Pinning a specimen turns its surroundings into its relatives without
   giving up the property that makes the lattice worth roaming: content
   is still a pure function of (address, generation, pin), so a district
   is reproducible and reversible, and the plain lattice resumes intact
   outside its rim.

   Inside a district the pin is the origin of its own contact sheet.
   Traits an axis enumerates are re-centred on the anchor -- one step
   right is the next archetype *relative to this specimen* rather than
   relative to the page -- and the traits no axis owns start out simply
   inherited.  So ring 1 is eight near relatives.

   Further out, drift sets in.  Each unowned trait is mutated with
   probability (ring-1)/(radius-1) and by a step that widens with the
   same ratio, seed last of all since it is the trait that destroys the
   family resemblance outright.  The result is a genealogy laid on the
   floor: cousins at the rim, siblings by the door.  Pin a cousin and
   the whole thing re-centres on it, which is the actual exploration
   loop -- pick the one that looks interesting, bloom around it, repeat.
   ===================================================================== */
export const TRAIT_N = { sym:GROUPS.length, arch:ARCH_NAMES.length,
                  field:FIELD_NAMES.length, lift:LIFT_NAMES.length };

export function axisDelta(role, di, dj){
  if (Axis.x === role) return di;
  if (Axis.y === role) return dj;
  return null;
}
export function inDistrict(i, j){
  return Pin.on && Pin.params &&
         Math.max(Math.abs(i - Pin.i), Math.abs(j - Pin.j)) <= Pin.radius;
}

/** @param {number} i @param {number} j @returns {import('../types.js').CellRecipe} */
export function cellRecipe(i, j){
  if (!inDistrict(i, j)) return { P: cellParams(i, j), kin: null };

  const di = i - Pin.i, dj = j - Pin.j;
  const ring = Math.max(Math.abs(di), Math.abs(dj));
  const A = Pin.params;
  const P = { sym:A.sym, arch:A.arch, field:A.field, lift:A.lift,
              density:A.density, seed:A.seed };
  if (ring === 0) return { P, kin:{ ring:0, drift:[] } };

  for (const t of ['sym','arch','field','lift']){
    const d = axisDelta(t, di, dj);
    if (d !== null) P[t] = imod(A[t] + d, TRAIT_N[t]);
  }
  const dDens = axisDelta('dens', di, dj);
  if (dDens !== null) P.density = clamp(A.density + dDens * 0.055, 0.06, 0.72);

  const t01 = Pin.radius > 1 ? (ring - 1) / (Pin.radius - 1) : 1;
  const W = Core.seedWords(A.seed);
  let rs = hash32(hash32(W.lo ^ Pin.epoch, W.hi ^ (di * 73856093)), dj * 19349663 + ring) || 1;
  const rnd = () => {
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
    return rs / 4294967296;
  };
  const sgn = () => rnd() < 0.5 ? -1 : 1;

  const drift = [];
  for (const t of ['sym','arch','field','lift']){
    if (axisDelta(t, di, dj) !== null) continue;
    if (rnd() >= t01) continue;
    const n = TRAIT_N[t];
    const span = 1 + Math.floor(t01 * n / 3);
    P[t] = imod(A[t] + sgn() * (1 + Math.floor(rnd() * span)), n);
    drift.push(t === 'field' ? 'field' : t);
  }
  if (dDens === null && rnd() < t01 * 0.8){
    P.density = clamp(A.density + sgn() * 0.05 * (1 + Math.floor(rnd() * 3)), 0.06, 0.72);
    drift.push('density');
  }
  if (rnd() < t01 * t01){
    const k = di * 7919 + dj * 104729 + ring;
    P.seed = seedFromWords(hash32(W.lo, k), hash32(W.hi, k ^ 0x5bd1e995));
    drift.push('seed');
  }
  return { P, kin: { ring, drift } };
}

