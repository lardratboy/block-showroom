/* Showroom constants: tuning knobs, axis roles, palette, small integer
   helpers and the levels-editor preset table. No state lives here except
   CFG, whose fields the sliders adjust at runtime. */
import * as THREE from 'three';
import { Core } from './core/bimoblock-core.js';

const { GROUPS, ARCH_NAMES, FIELD_NAMES, LIFT_NAMES } = Core;

export const TAU = Math.PI * 2;

export const CFG = {
  CELL:        2.6,     // lattice pitch, world units
  BLOCK_S:     1.18,    // specimen scale (geometry is a unit cube)
  MAX_VISIBLE: 336,     // horizon depth: specimens drawn at once, live
  POD_MAX:     480,     // pod instance allocation, and the ceiling on the above
  CACHE_MAX:   760,     // retained generated blocks (each owns geometry)
  MAX_SPAN:    62,      // clamp on the cell box scanned per rebuild
  LOD_PX:      30,      // projected CSS-pixel size below which the 3^3 proxy is used
  INSTALL_MS:  1.0,     // soft CPU budget for accepting worker results
  UPLOAD_BYTES: 8 * 1048576, // newly admitted geometry per frame (one oversize allowed)
  RESULT_BYTES: 96 * 1048576,
  CACHE_BYTES: 256 * 1048576
};

/* ---- axis roles -------------------------------------------------------
   A role is an enumeration plus its period.  'free' means the axis does
   not enumerate anything, so its coordinate feeds the seed directly. */
export const ROLES = [
  { id:'free',  label:'free roam',  count:0 },
  { id:'arch',  label:'archetype',  count:ARCH_NAMES.length  },
  { id:'sym',   label:'symmetry',   count:GROUPS.length      },
  { id:'field', label:'field',      count:FIELD_NAMES.length },
  { id:'lift',  label:'lift',       count:LIFT_NAMES.length  },
  { id:'dens',  label:'density',    count:9                  }
];
export const ROLE_BY_ID = {};
for (const r of ROLES) ROLE_BY_ID[r.id] = r;

export const GROUP_COLORS = ['#ff3ea5','#ff8a3d','#ffd23d','#9bff3d','#3dff8a',
                             '#00f5d4','#3dc9ff','#6f7dff','#b46cff','#ff5edb'];
export const GROUP_RGB = GROUP_COLORS.map(h => new THREE.Color(h));

export const imod = (a, n) => ((a % n) + n) % n;
export const idiv = (a, n) => Math.floor(a / n);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---- levels editor ----------------------------------------------------
   MAX_R guards against a runaway per-specimen cell count: unlike the
   standalone prototype (one specimen at a time), the lattice keeps up to
   CFG.POD_MAX specimens live at once, so the safe ceiling here is much
   lower. It covers every shipped preset (tower3=27, tower4=16, hetero=24)
   with headroom. */
export const MAX_R = 64;

export const PRESETS = {
  classic: [{radix:3,gap:0.30},{radix:3,gap:0.06}],
  tower3:  [{radix:3,gap:0.35},{radix:3,gap:0.12},{radix:3,gap:0.04}],
  tower4:  [{radix:2,gap:0.35},{radix:2,gap:0.20},{radix:2,gap:0.10},{radix:2,gap:0.04}],
  hetero:  [{radix:4,gap:0.30},{radix:3,gap:0.14},{radix:2,gap:0.05}],
  n4:      [{radix:4,gap:0.30},{radix:4,gap:0.08}],
  n5:      [{radix:5,gap:0.20}]
};
