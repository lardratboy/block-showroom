/* URL ADDRESS — the lattice is deterministic, so a coordinate is a
   shareable permalink into the catalogue: #i,j,height,gen[,pinI.pinJ.radius]
   The camera rig is passed in; the rest is read from state.js. */
import { CFG, clamp } from '../config.js';
import { Mint, Pin, Bloom } from '../state.js';
import { cellWorldX, cellWorldZ } from '../lattice/recipe.js';

let hashTimer = 0;
export function writeHash(){ hashTimer = 0.6; }
/* Called once per frame; commits a pending writeHash() after the debounce. */
export function tickHash(dt, rig){
  if (hashTimer > 0){ hashTimer -= dt; if (hashTimer <= 0) commitHash(rig); }
}
export function hashString(rig){
  const base = `#${Math.round(rig.x / CFG.CELL)},${Math.round(-rig.z / CFG.CELL)},${rig.h.toFixed(1)},${Mint.gen}`;
  return (Pin.on && Pin.params) ? `${base},${Pin.i}.${Pin.j}.${Pin.radius}` : base;
}
export function commitHash(rig){
  const h = hashString(rig);
  if (location.hash === h) return;
  // Some browsers refuse replaceState on file:// URLs; the lattice does not
  // care, so a refusal is noted and ignored rather than thrown.
  try { history.replaceState(null, '', h); }
  catch (err){ console.debug('address bar not writable here', err.name); }
}
/* `setFocus(i, j, announce)` and `onBloom()` are main.js callbacks: the
   latter syncs the bloom button and radius slider to the state set here. */
export function readHash({ rig, setFocus, onBloom }){
  const m = /^#(-?\d+),(-?\d+)(?:,([\d.]+))?(?:,(\d+))?(?:,(-?\d+)\.(-?\d+)\.(\d+))?$/.exec(location.hash || '');
  if (!m) return false;
  rig.x = cellWorldX(parseInt(m[1], 10));
  rig.z = cellWorldZ(parseInt(m[2], 10));
  if (m[3]) rig.h = clamp(parseFloat(m[3]), 2.6, 96);
  if (m[4]) Mint.gen = parseInt(m[4], 10);
  setFocus(parseInt(m[1], 10), parseInt(m[2], 10), false);
  if (m[5] !== undefined){
    // The pin's anchor has to exist before it can be read, so the request
    // is parked and the frame loop retries once minting reaches it.
    Pin.radius = clamp(parseInt(m[7], 10), 2, 8);
    Bloom.on = true;
    Pin.want = { i: parseInt(m[5], 10), j: parseInt(m[6], 10) };
    onBloom();
  }
  return true;
}
