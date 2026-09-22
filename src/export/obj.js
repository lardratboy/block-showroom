/* Wavefront OBJ exporters. Both take their live collaborators as a
   parameter object rather than reaching into main.js: `specimen` is the
   focused block's cached data, `rig`/`visible`/`cache` the camera target and
   the on-screen set, `toast` the HUD notifier. */
import { Core } from '../core/bimoblock-core.js';
import { CFG, ROLE_BY_ID } from '../config.js';
import { Axis, Mint, Tier, Focus } from '../state.js';
import { symmetryLabel, cellWorldX, cellWorldZ, seedHex } from '../lattice/recipe.js';

const { ARCH_NAMES, FIELD_NAMES } = Core;

function download(blob, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function specimenName(p){
  return `bimoblock_${p.tierSymmetry?'tiers_':''}${symmetryLabel(p,true).replaceAll(' / ','-')}_${ARCH_NAMES[p.arch]}_${seedHex(p.seed)}`;
}

export function exportSpecimenOBJ({ specimen, toast }){
  const p = specimen;
  if (!p) return;
  const R = p.R;
  const lines = [
    `# bimoblock specimen — ${specimenName(p)}`,
    `# lattice cell: ${Focus.i}, ${Focus.j}   generation: ${Mint.gen}`,
    `# group: ${symmetryLabel(p)}  archetype: ${ARCH_NAMES[p.arch]}  field: ${FIELD_NAMES[p.field]}`,
    `# symmetry mode: ${p.tierSymmetry ? 'independent address tiers (outer to inner)' : 'coupled whole-grid'}`,
    `# levels: [${p.levels.map(l=>l.radix).join('×')}]  resolution: ${R}`,
    `# gaps: [${p.levels.map(l=>l.gap.toFixed(2)).join(', ')}] (fraction of child width)`,
    `# format: v X Y Z R G B (normalized local gamut colors), vn NX NY NZ, f v1//vn1 v2//vn2 v3//vn3`,
    ""
  ];
  const pos = p.geo.getAttribute('position');
  const col = p.geo.getAttribute('color');
  const nrm = p.geo.getAttribute('normal');
  let vi = 1;
  for (let k = 0; k < pos.count; k += 4){
    for (let q = 0; q < 4; q++){
      const n = k + q;
      lines.push(`v ${pos.getX(n).toFixed(4)} ${pos.getY(n).toFixed(4)} ${pos.getZ(n).toFixed(4)} ` +
                 `${col.getX(n).toFixed(4)} ${col.getY(n).toFixed(4)} ${col.getZ(n).toFixed(4)}`);
      lines.push(`vn ${nrm.getX(n).toFixed(4)} ${nrm.getY(n).toFixed(4)} ${nrm.getZ(n).toFixed(4)}`);
    }
    lines.push(`f ${vi}//${vi} ${vi+1}//${vi+1} ${vi+2}//${vi+2} ${vi+3}//${vi+3}`);
    vi += 4;
  }
  const quads = pos.count / 4;
  download(new Blob([lines.join("\n")], { type:'text/plain' }), specimenName(p) + '.obj');
  toast(`${specimenName(p)}.obj exported (${quads} quads)`);
}

/* Everything currently standing in the showroom, exported flat on the
   lattice at full resolution regardless of the LOD used on screen. */
export function exportSheetOBJ({ rig, visible, cache, toast }){
  const lines = [
    `# bimoblock showroom — visible lattice sheet`,
    `# generated: ${new Date().toISOString()}`,
    `# centre cell: ${Math.round(rig.x / CFG.CELL)}, ${Math.round(-rig.z / CFG.CELL)}   generation: ${Mint.gen}`,
    `# axes: x → ${ROLE_BY_ID[Axis.x].label}   y → ${ROLE_BY_ID[Axis.y].label}`,
    `# levels: [${Tier.levels.map(l=>l.radix).join('×')}]  gaps: [${Tier.levels.map(l=>l.gap.toFixed(2)).join(', ')}]`,
    `# format: v X Y Z R G B (normalized local gamut colors), vn NX NY NZ, f v1//vn1 v2//vn2 v3//vn3`,
    ""
  ];

  let vCount = 1, tris = 0, blocks = 0;
  const S = CFG.BLOCK_S;

  for (const c of visible){
    const p = cache.get(c.key);
    if (!p) continue;
    const geo = p.geo;
    const posAttr = geo.getAttribute('position');
    const colAttr = geo.getAttribute('color');
    const nrmAttr = geo.getAttribute('normal');
    const idxAttr = geo.getIndex();
    if (!posAttr || posAttr.count === 0) continue;

    const ox = cellWorldX(c.i), oz = cellWorldZ(c.j), oy = S * 0.5 + 0.42;
    lines.push(`# symmetry mode: ${p.tierSymmetry ? 'independent address tiers' : 'coupled whole-grid'}; groups: ${symmetryLabel(p)}; radices: ${p.levels.map(l=>l.radix).join(',')}`);
    lines.push(`o cell_${c.i}_${c.j}_${symmetryLabel(p,true).replaceAll(' / ','-')}_${ARCH_NAMES[p.arch]}`);
    for (let k = 0; k < posAttr.count; k++){
      lines.push(`v ${(posAttr.getX(k)*S+ox).toFixed(4)} ${(posAttr.getY(k)*S+oy).toFixed(4)} ${(posAttr.getZ(k)*S+oz).toFixed(4)} ` +
                 `${colAttr.getX(k).toFixed(4)} ${colAttr.getY(k).toFixed(4)} ${colAttr.getZ(k).toFixed(4)}`);
      lines.push(`vn ${nrmAttr.getX(k).toFixed(4)} ${nrmAttr.getY(k).toFixed(4)} ${nrmAttr.getZ(k).toFixed(4)}`);
    }
    for (let k = 0; k < idxAttr.count; k += 3){
      const a = idxAttr.getX(k) + vCount, b = idxAttr.getX(k+1) + vCount, d = idxAttr.getX(k+2) + vCount;
      lines.push(`f ${a}//${a} ${b}//${b} ${d}//${d}`);
    }
    tris += idxAttr.count / 3;
    vCount += posAttr.count;
    blocks++;
  }

  const filename = `bimoblock_sheet_${Math.round(rig.x / CFG.CELL)}_${Math.round(-rig.z / CFG.CELL)}_g${Mint.gen}.obj`;
  download(new Blob([lines.join("\n")], { type:'text/plain' }), filename);
  toast(`${filename} — ${blocks} specimens, ${tris.toLocaleString()} triangles`);
}

