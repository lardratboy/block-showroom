/* CONTROLS — the bottom panel (selects, sliders, buttons, goto box) and
   the global keyboard map. Binds every element in the constructor. Simple
   settings are written straight into state.js / CFG; anything that has to
   coordinate several owners (focus, pins, flushing the lattice) goes
   through the `actions` the composition root supplies. */
import { Core } from '../core/bimoblock-core.js';
import { CFG, ROLES, clamp } from '../config.js';
import { Axis, Filter, Mint, Pin, State, Bloom, Focus } from '../state.js';
import { symmetryLabel, cellWorldX, cellWorldZ } from '../lattice/recipe.js';
import { exportSpecimenOBJ, exportSheetOBJ } from '../export/obj.js';
import { writeHash, commitHash, hashString } from './permalink.js';

const { GROUPS, ARCH_NAMES, FIELD_NAMES } = Core;

function opt(sel, value, label, selected){
  const o = document.createElement('option');
  o.value = value; o.textContent = label;
  if (selected) o.selected = true;
  sel.appendChild(o);
}

export class Controls {
  /* actions: { setFocus(i,j,announce), pinAt(i,j), unpin(),
                flushLattice(), applyConfiguration() } */
  constructor({ rig, virtualiser, hud, labels, actions }){
    this.rig = rig; this.virtualiser = virtualiser; this.hud = hud; this.labels = labels;
    this.actions = actions;
    const $ = id => document.getElementById(id);
    const setStatus = text => hud.setStatus(text);
    const showToast = msg => hud.showToast(msg);

    /* ---- selects ---------------------------------------------------- */
    const selAxX  = this.selAxX  = $('axX');
    const selAxY  = this.selAxY  = $('axY');
    const selSym  = this.selSym  = $('sym');
    const selArch = this.selArch = $('arch');
    const selFld  = this.selFld  = $('field');
    const selColor = $('colorMode');
    const selRender = $('renderMode');

    ROLES.forEach(r => opt(selAxX, r.id, 'x axis: ' + r.label, r.id === Axis.x));
    ROLES.forEach(r => opt(selAxY, r.id, 'y axis: ' + r.label, r.id === Axis.y));

    opt(selSym, '-1', 'symmetry: roam', true);
    GROUPS.forEach((g, i) => opt(selSym, String(i), 'symmetry: ' + g.name));
    opt(selArch, '-1', 'archetype: roam', true);
    ARCH_NAMES.forEach((n, i) => opt(selArch, String(i), 'archetype: ' + n));
    opt(selFld, '-1', 'field: roam', true);
    FIELD_NAMES.forEach((n, i) => opt(selFld, String(i), 'field: ' + n));

    // Additive display modes only — never touch generation, so switching never
    // invalidates the cache or needs flushLattice(). Specimens built before this
    // mode existed (or LOD proxies, which never carry orbit data) just have no
    // colorOrbit attribute and layout() falls back to gamut for them.
    opt(selColor, 'gamut', 'color: gamut position', true);
    opt(selColor, 'chiral', 'color: chirality');
    opt(selColor, 'orbit', 'color: orbit index');

    // Likewise display-only: the views are cut from the cached mesh on demand.
    opt(selRender, 'solid',   'display: solid', true);
    opt(selRender, 'wire',    'display: wireframe');
    opt(selRender, 'points',  'display: vertices');
    opt(selRender, 'centers', 'display: box centers');

    selAxX.addEventListener('change', () => this.setAxis('x', selAxX.value));
    selAxY.addEventListener('change', () => this.setAxis('y', selAxY.value));
    selSym.addEventListener('change',  () => { Filter.sym   = parseInt(selSym.value, 10);  actions.flushLattice(); });
    selArch.addEventListener('change', () => { Filter.arch  = parseInt(selArch.value, 10); actions.flushLattice(); });
    selFld.addEventListener('change',  () => { Filter.field = parseInt(selFld.value, 10);  actions.flushLattice(); });
    selColor.addEventListener('change', () => {
      State.colorMode = selColor.value;
      const label = State.colorMode === 'chiral' ? 'chirality (amber = chiral, blue = achiral)'
        : State.colorMode === 'orbit' ? 'orbit index (hue = which symmetric copy folded here)'
        : 'gamut position';
      setStatus('color mode: ' + label);
    });
    selRender.addEventListener('change', () => {
      State.renderMode = selRender.value;
      virtualiser.resetSlots();   // the drawable class changes with the mode
      const label = { solid:'solid boxes', wire:'wireframe (box edges)',
                      points:'mesh vertices', centers:'box centers (one point per voxel)' }[State.renderMode];
      setStatus('display: ' + label);
    });

    /* ---- sliders ---------------------------------------------------- */
    const inDens  = this.inDens = $('dens');
    const inPitch = $('pitch');
    const inSize  = $('size');
    const inTilt  = this.inTilt = $('tilt');
    const inSpin  = $('spin');
    const inHaze  = $('haze');
    const inKin   = this.inKin = $('kin');
    const inHoriz = $('horizon');

    inDens.addEventListener('input', () => {
      Mint.density = parseInt(inDens.value, 10) / 100;
      setStatus('generation density ' + inDens.value + '%');
      actions.applyConfiguration();
    });
    inPitch.addEventListener('input', () => {
      CFG.CELL = parseInt(inPitch.value, 10) / 10;
      virtualiser.invalidate();
      setStatus('lattice pitch ' + CFG.CELL.toFixed(1));
    });
    inSize.addEventListener('input', () => {
      CFG.BLOCK_S = parseInt(inSize.value, 10) / 100;
      setStatus('specimen size ' + CFG.BLOCK_S.toFixed(2));
    });
    inTilt.addEventListener('input', () => {
      rig.tilt = parseInt(inTilt.value, 10) * Math.PI / 180;
      rig.tilt = clamp(rig.tilt, 0.52, 1.535);
      rig.apply(); virtualiser.invalidate();
    });
    inSpin.addEventListener('input', () => { State.spin = parseInt(inSpin.value, 10) / 100; });
    inHaze.addEventListener('input', () => { State.haze = parseInt(inHaze.value, 10) / 100; });
    inKin.addEventListener('input', () => {
      Pin.radius = parseInt(inKin.value, 10);
      const n = 2 * Pin.radius + 1;
      setStatus('district radius ' + Pin.radius + '  ·  ' + (n * n) + ' relatives');
      if (Pin.on){ Pin.epoch++; virtualiser.invalidate(); }
    });
    inHoriz.addEventListener('input', () => {
      CFG.MAX_VISIBLE = Math.min(CFG.POD_MAX, parseInt(inHoriz.value, 10));
      virtualiser.invalidate();
      setStatus('horizon holds ' + CFG.MAX_VISIBLE + ' specimens');
    });

    /* ---- buttons ---------------------------------------------------- */
    const btnHome   = $('home');
    const btnWarp   = $('warp');
    const btnAlign  = $('align');
    const btnBloom  = this.btnBloom = $('bloom');
    const btnLabels = $('labelsBtn');
    const btnKey    = $('keyBtn');
    const btnShuf   = $('shuffle');
    const inGoto    = $('goto');

    btnHome.addEventListener('click', () => { rig.glideTo(0, 0, 15); actions.setFocus(0, 0, false); setStatus('returned to origin'); });
    btnWarp.addEventListener('click', () => {
      const i = (Math.random() * 2000 - 1000) | 0, j = (Math.random() * 2000 - 1000) | 0;
      rig.x = cellWorldX(i); rig.z = cellWorldZ(j);
      rig.vx = rig.vz = 0;
      virtualiser.invalidate();
      actions.setFocus(i, j, false);
      showToast(`warped to district ${i}, ${j}`);
    });
    btnAlign.addEventListener('click', () => {
      State.align = !State.align;
      btnAlign.classList.toggle('on', State.align);
      setStatus(State.align ? 'specimens aligned for comparison' : 'idle rotation resumed');
    });
    btnBloom.addEventListener('click', () => {
      Bloom.on = !Bloom.on;
      btnBloom.classList.toggle('on', Bloom.on);
      if (Bloom.on){
        actions.pinAt(Focus.i, Focus.j);
        const p = virtualiser.at(Focus.i, Focus.j);
        showToast(p ? `blooming ${Focus.i}, ${Focus.j} · ${ARCH_NAMES[p.arch]} · ${symmetryLabel(p)}`
                    : `blooming ${Focus.i}, ${Focus.j}`);
      } else {
        actions.unpin();
        setStatus('district released — lattice restored');
      }
    });
    btnLabels.addEventListener('click', () => {
      State.labels = !State.labels;
      labels.markDirty();
      btnLabels.classList.toggle('on', State.labels);
    });
    btnKey.addEventListener('click', () => {
      State.legend = !State.legend;
      btnKey.classList.toggle('on', State.legend);
      hud.setLegendVisible(State.legend);
    });
    btnShuf.addEventListener('click', () => {
      Mint.gen++;
      actions.flushLattice();
      writeHash();
      showToast('lattice re-minted — generation ' + Mint.gen);
    });
    $('expSheet').addEventListener('click', () => this.exportSheet());
    $('expObj').addEventListener('click', () => this.exportSpecimen());

    inGoto.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const m = /^\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*$/.exec(inGoto.value);
      if (!m){ setStatus('address must look like  12, -7'); return; }
      const i = parseInt(m[1], 10), j = parseInt(m[2], 10);
      const far = Math.hypot(cellWorldX(i) - rig.x, cellWorldZ(j) - rig.z) > CFG.CELL * 26;
      if (far){ rig.x = cellWorldX(i); rig.z = cellWorldZ(j); virtualiser.invalidate(); }
      else rig.glideTo(i, j);
      actions.setFocus(i, j, false);
      inGoto.blur();
      showToast(`cell ${i}, ${j}`);
    });

    /* ---- keyboard --------------------------------------------------- */
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      const step = e.shiftKey ? 5 : 1;
      switch (e.key){
        case 'ArrowLeft':  rig.glideTo(Focus.i - step, Focus.j); actions.setFocus(Focus.i - step, Focus.j, false); e.preventDefault(); break;
        case 'ArrowRight': rig.glideTo(Focus.i + step, Focus.j); actions.setFocus(Focus.i + step, Focus.j, false); e.preventDefault(); break;
        case 'ArrowUp':    rig.glideTo(Focus.i, Focus.j + step); actions.setFocus(Focus.i, Focus.j + step, false); e.preventDefault(); break;
        case 'ArrowDown':  rig.glideTo(Focus.i, Focus.j - step); actions.setFocus(Focus.i, Focus.j - step, false); e.preventDefault(); break;
        case '[': actions.setFocus(Focus.i - 1, Focus.j, true); break;
        case ']': actions.setFocus(Focus.i + 1, Focus.j, true); break;
        case 'a': case 'A': btnAlign.click(); break;
        case 'b': case 'B': btnBloom.click(); break;
        case 'l': case 'L': btnLabels.click(); break;
        case 'k': case 'K': btnKey.click(); break;
        case 'g': case 'G': btnShuf.click(); break;
        case 'h': case 'H': btnHome.click(); break;
        case 'w': case 'W': btnWarp.click(); break;
        case 'o': case 'O': this.exportSpecimen(); break;
        case 'e': case 'E': this.exportSheet(); break;
        case 'c': case 'C': this.copyAddress(); break;
      }
    });

    this.syncFilterEnablement();
    this.setTiltSlider();
  }

  syncFilterEnablement(){
    this.selSym.disabled  = (Axis.x === 'sym'   || Axis.y === 'sym');
    this.selArch.disabled = (Axis.x === 'arch'  || Axis.y === 'arch');
    this.selFld.disabled  = (Axis.x === 'field' || Axis.y === 'field');
    this.inDens.disabled  = (Axis.x === 'dens'  || Axis.y === 'dens');
  }

  setAxis(which, id){
    const other = which === 'x' ? 'y' : 'x';
    // Two axes may not enumerate the same thing; the loser falls back to roam.
    if (id !== 'free' && Axis[other] === id){
      Axis[other] = 'free';
      (other === 'x' ? this.selAxX : this.selAxY).value = 'free';
    }
    Axis[which] = id;
    this.syncFilterEnablement();
    this.hud.resetStatus();
    this.actions.flushLattice();
  }

  /* Mirror the rig's tilt into its slider (after an orbit drag). */
  setTiltSlider(){ this.inTilt.value = String(Math.round(this.rig.tilt * 180 / Math.PI)); }
  /* Mirror Bloom/Pin state into the button and radius slider (after a permalink). */
  syncBloomUI(){
    this.inKin.value = String(Pin.radius);
    this.btnBloom.classList.toggle('on', Bloom.on);
  }

  exportSpecimen(){
    exportSpecimenOBJ({ specimen: this.virtualiser.at(Focus.i, Focus.j), toast: m => this.hud.showToast(m) });
  }
  exportSheet(){
    const v = this.virtualiser;
    exportSheetOBJ({ rig: this.rig, visible: v.visible, cache: v.cache, toast: m => this.hud.showToast(m) });
  }
  copyAddress(){
    const rig = this.rig, showToast = m => this.hud.showToast(m);
    commitHash(rig);
    const text = location.href.split('#')[0] + hashString(rig);
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text)
        .then(() => showToast('address copied — ' + Focus.i + ', ' + Focus.j))
        .catch(err => { console.warn('clipboard refused', err); showToast('copy blocked; see console'); console.log(text); });
    } else {
      console.log(text);
      showToast('address logged to console');
    }
  }
}
