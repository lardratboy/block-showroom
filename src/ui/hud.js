/* HUD — the text around the edges: coordinate readout, status line,
   toast, the inspector for the focused specimen and the symmetry legend.
   Reads the virtualiser and generation pool for the inspector's live
   figures; the frame loop ticks its timers and feeds it fps/triangle
   counts. */
import { Core } from '../core/bimoblock-core.js';
import { CFG, ROLE_BY_ID, GROUP_COLORS, idiv } from '../config.js';
import { Axis, Pin, Focus } from '../state.js';
import { symmetryLabel, seedHex } from '../lattice/recipe.js';

const { GROUPS, ARCH_NAMES, FIELD_NAMES, NATIVE_FIELDS, LEGACY_FIELD_COUNT, LIFT_NAMES } = Core;

export class Hud {
  constructor(virtualiser, pool, rig){
    this.virtualiser = virtualiser;
    this.pool = pool;
    this.rig = rig;
    this.elCoord   = document.getElementById('coord');
    this.elStatus  = document.getElementById('status');
    this.elInspect = document.getElementById('inspect');
    this.elToast   = document.getElementById('toast');
    this.elLegend  = document.getElementById('legend');
    this.statusTimer = 0;
    this.toastTimer = 0;
    this.fps = 60;
    this.frameTris = 0;     // triangles submitted last frame, from layout()
    this._hudT = 0;
    this._buildLegend();
    this.resetStatus();
  }

  setStatus(text){ this.elStatus.textContent = text; this.statusTimer = 3.4; }
  /* Show the standing status (axis roles, district) with no timeout. */
  resetStatus(){ this.elStatus.textContent = this.defaultStatus(); }
  defaultStatus(){
    const axes = 'X → ' + ROLE_BY_ID[Axis.x].label + '   ·   Y → ' + ROLE_BY_ID[Axis.y].label;
    return (Pin.on && Pin.params)
      ? 'district of ' + Pin.i + ', ' + Pin.j + '   ·   radius ' + Pin.radius + '   ·   ' + axes
      : axes;
  }
  showToast(msg){ this.elToast.textContent = msg; this.elToast.style.opacity = '1'; this.toastTimer = 2.4; }
  setLegendVisible(on){ this.elLegend.style.display = on ? '' : 'none'; }

  refreshInspector(){
    const v = this.virtualiser, pool = this.pool;
    const p = v.at(Focus.i, Focus.j);
    if (!p){
      this.elInspect.innerHTML = `<span class="k">cell</span> <b>${Focus.i}, ${Focus.j}</b>\n<span class="k">${pool.failed('build', Focus.i, Focus.j) ? 'generation failed — shuffle to retry' : 'minting…'}</span>`;
      return;
    }

    const g = GROUPS[p.sym];
    const px = ROLE_BY_ID[Axis.x].count ? idiv(Focus.i, ROLE_BY_ID[Axis.x].count) : Focus.i;
    const py = ROLE_BY_ID[Axis.y].count ? idiv(Focus.j, ROLE_BY_ID[Axis.y].count) : Focus.j;

    this.elInspect.innerHTML =
      `<span class="k">cell</span> <b>${Focus.i}, ${Focus.j}</b> <span class="k">· page ${px}, ${py}</span>\n` +
      `<span class="k">${p.tierSymmetry ? 'tiers out → in' : 'group'}</span> <b>${symmetryLabel(p)}</b>\n` +
      `<span class="k">archetype</span> <b>${ARCH_NAMES[p.arch]}</b>\n` +
      `<span class="k">field</span> <b>${FIELD_NAMES[p.field]}</b>` +
        (p.field >= NATIVE_FIELDS && p.field < LEGACY_FIELD_COUNT ? ` <span class="k">/</span> <b>${LIFT_NAMES[p.lift]}</b>` : '') + `\n` +
      `<span class="k">resolution</span> <b>${p.R}</b> <span class="k">[${p.levels.map(l=>l.radix).join('×')}]</span>\n` +
      `<span class="k">${p.tierSymmetry ? 'whole-grid order' : 'aut-order'}</span> <b>${p.aut < 0 ? (pool.failed('analyze', Focus.i, Focus.j) ? 'unavailable' : 'calculating…') : p.aut}</b> <span class="k">${p.tierSymmetry ? 'rigid transforms' : 'of '+g.order}</span>\n` +
      `<span class="k">voxels</span> <b>${p.filled}</b> <span class="k">/ ${p.envelopeCells}</span>\n` +
      `<span class="k">density</span> <b>${(p.density * 100).toFixed(0)}%</b>\n` +
      `<span class="k">seed</span> <b>#${seedHex(p.seed)}</b>\n` +
      (p.kin
        ? `<span class="k">kin</span> <b>ring ${p.kin.ring}</b> <span class="k">of ${Pin.radius} · ${p.kin.drift.length ? 'drift ' + p.kin.drift.join(' ') : 'pure inheritance'}</span>\n`
        : '') +
      `<span class="k">resident</span> <b>${v.cache.size}</b> <span class="k">blocks · ${(v.cacheBytes/1048576).toFixed(0)} MB · ${v.visible.length} nearby</span>\n` +
      `<span class="k">stream tris</span> <b>${(this.frameTris / 1000).toFixed(0)}k</b> <span class="k">· ${this.fps.toFixed(0)} fps</span>\n` +
      `<span class="k">generation</span> <b>${pool.mode === 'workers' ? pool.liveWorkers + ' workers' : pool.mode}</b> <span class="k">· ${pool.pending.size} pending${v.cacheBytes > CFG.CACHE_BYTES ? ' · visible set over cache target' : ''}</span>`;
  }

  _buildLegend(){
    let html = '<div class="hd">symmetry key</div>';
    GROUPS.forEach((g, i) => {
      html += `<div class="row"><i style="background:${GROUP_COLORS[i]}"></i>${g.name}</div>`;
    });
    this.elLegend.innerHTML = html;
  }

  /* Once per frame. `rawDt` is the unclamped frame time (for the fps
     estimate); `dt` the clamped one the timers run on. */
  tick(rawDt, dt, frameTris){
    this.frameTris = frameTris;
    this.fps += (1 / Math.max(rawDt, 1e-4) - this.fps) * Math.min(1, dt * 3);
    this._hudT += dt;
    if (this._hudT >= 0.4){
      this._hudT = 0;
      this.refreshInspector();
      this.elCoord.textContent = this.rig.cellI + ', ' + this.rig.cellJ;
    }
    if (this.statusTimer > 0){
      this.statusTimer -= dt;
      if (this.statusTimer <= 0) this.resetStatus();
    }
    if (this.toastTimer > 0){
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.elToast.style.opacity = '0';
    }
  }
}
