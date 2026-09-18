/* LEVELS EDITOR — arbitrary {radix,gap} tier list, global (like density),
   not per-cell. Editing it invalidates every cached specimen since it
   changes their resolution, which is what `onChange` is for. MAX_R
   (config.js) caps the per-specimen cell count. */
import { Core } from '../core/bimoblock-core.js';
import { MAX_R, PRESETS } from '../config.js';
import { Tier } from '../state.js';

const { GROUPS, levelResolution } = Core;

export class LevelsEditor {
  constructor({ setStatus, onChange }){
    this.setStatus = setStatus;
    this.onChange = onChange;
    this.lvRows = document.getElementById('lvrows');
    this.resLine = document.getElementById('resLine');
    this.tierSymmetry = document.getElementById('tierSymmetry');

    this.tierSymmetry.onchange = e => { Tier.symmetry = e.target.checked; this.render(); this.onChange(); };
    document.getElementById('tierMirrorSpin').onclick = () => this._tierExample(1, 5);
    document.getElementById('tierCubeFree').onclick = () => this._tierExample(9, 0);

    document.getElementById('btnAddLevel').addEventListener('click', () => {
      const trial = [...Tier.levels, { radix:3, gap:0.1 }];
      if (levelResolution(trial) > MAX_R){
        console.warn(`[bimoblock] add-level rejected: R would exceed MAX_R=${MAX_R}`);
        this.setStatus(`too large — R capped at ${MAX_R}`);
        return;
      }
      Tier.levels.push({ radix:3, gap:0.1 });
      this._changed();
    });
    document.getElementById('btnDelLevel').addEventListener('click', () => {
      if (Tier.levels.length <= 1) return;
      Tier.levels.pop();
      this._changed();
    });
    document.querySelectorAll('#levelsPanel .presets button').forEach(b => b.addEventListener('click', () => {
      const p = b.dataset.preset;
      const next = PRESETS[p] || Tier.levels;
      if (levelResolution(next) > MAX_R){
        console.warn(`[bimoblock] preset '${p}' rejected: R=${levelResolution(next)} exceeds MAX_R=${MAX_R}`);
        this.setStatus(`preset too large — R capped at ${MAX_R}`);
        return;
      }
      Tier.levels = next.map((l,i)=>({...l,sym:Tier.levels[i]?.sym ?? -1}));
      this._changed();
    }));
    this.render();
  }

  _tierExample(outer, inner){
    if (Tier.levels.length < 2) Tier.levels = [{radix:3,gap:.30},{radix:3,gap:.06}];
    Tier.levels = Tier.levels.map((l,i)=>({...l,sym:i===0?outer:inner}));
    Tier.symmetry = true; this.tierSymmetry.checked = true;
    this.render(); this.onChange();
  }

  /* The tier list changed shape: redraw, announce the new resolution, rebuild. */
  _changed(){
    this.render();
    this.setStatus(`levels [${Tier.levels.map(l=>l.radix).join('×')}] → R=${levelResolution(Tier.levels)}`);
    this.onChange();
  }

  render(){
    const lvRows = this.lvRows;
    lvRows.innerHTML = '';
    Tier.levels.forEach((lv, i) => {
      const row = document.createElement('div'); row.className = 'lvrow';
      row.innerHTML =
        `<span class="idx">${i===0?'out':(i===Tier.levels.length-1?'in':i)}</span>` +
        `<input type="number" min="2" max="12" value="${lv.radix}" data-i="${i}" class="radixIn">` +
        `<input type="range" min="0" max="100" value="${Math.round(lv.gap*100)}" data-i="${i}" class="gapIn" title="Sibling spacing at this tier (% of child width)">` +
        `<span class="gapv">${lv.gap.toFixed(2)}</span>` +
        `<button data-i="${i}" class="delBtn" title="remove this level">×</button>`;
      const select=document.createElement('select');
      select.className='tierGroup'; select.disabled=!Tier.symmetry;
      select.setAttribute('aria-label',`Tier ${i+1} symmetry`);
      select.add(new Option('inherit specimen group', '-1'));
      GROUPS.forEach((g,j)=>select.add(new Option(g.name+' ('+g.order+')',String(j))));
      select.value=String(lv.sym ?? -1);
      select.onchange=()=>{ lv.sym=+select.value; this.onChange(); };
      row.appendChild(select);
      lvRows.appendChild(row);
    });
    const R = levelResolution(Tier.levels);
    this.resLine.textContent = `R=${R} · ${(R*R*R).toLocaleString()} cells`;

    lvRows.querySelectorAll('.radixIn').forEach(el => el.onchange = e => {
      const i = +e.target.dataset.i, want = Math.max(2, Math.min(12, parseInt(e.target.value) || 2));
      const trial = Tier.levels.map((l,k) => k===i ? { ...l, radix:want } : l);
      if (levelResolution(trial) > MAX_R){
        console.warn(`[bimoblock] radix change rejected: R would exceed MAX_R=${MAX_R}`);
        this.setStatus(`too large — R capped at ${MAX_R}`);
        e.target.value = Tier.levels[i].radix;
        return;
      }
      Tier.levels[i].radix = want;
      this._changed();
    });
    lvRows.querySelectorAll('.gapIn').forEach(el => el.oninput = e => {
      const i = +e.target.dataset.i;
      Tier.levels[i].gap = (+e.target.value) / 100;
      e.target.parentElement.querySelector('.gapv').textContent = Tier.levels[i].gap.toFixed(2);
      this.setStatus(`${i===0?'outer':i===Tier.levels.length-1?'inner':'level '+i} tier gap ${Math.round(Tier.levels[i].gap*100)}%`);
      this.onChange();
    });
    lvRows.querySelectorAll('.delBtn').forEach(el => el.onclick = e => {
      if (Tier.levels.length <= 1) return;
      Tier.levels.splice(+e.target.dataset.i, 1);
      this._changed();
    });
  }
}
