/* Wavefront OBJ exporters. Both take their live collaborators as a
   parameter object rather than reaching into main.js: `specimen` is the
   focused block's cached data, `rig`/`visible`/`cache` the camera target and
   the on-screen set, `toast` the HUD notifier.

   OBJ wants independent triangles, which a resident specimen no longer
   carries: it holds the instance record, and the renderer expands cubes on
   the GPU. So these expand it back here, one specimen at a time and only
   when the viewer asks — Core.expandInstances() is the same emit the baked
   mesher used, so the file written is byte-for-byte the file this exported
   before instancing. */
import { Core } from '../core/bimoblock-core.js';
import { CFG, ROLE_BY_ID } from '../config.js';
import { Axis, Mint, Tier, Focus, State } from '../state.js';
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
  const mesh = Core.expandInstances(p.inst);
  const pos = mesh.pos, nrm = mesh.nrm;
  // Whichever colouring is on screen, as before: the exporter took the
  // attribute the material was reading, not the gamut one by name.
  const col = (State.colorMode === 'orbit' && mesh.colOrbit) ? mesh.colOrbit : mesh.col;
  const verts = pos.length / 3;
  let vi = 1;
  for (let k = 0; k < verts; k += 4){
    for (let q = 0; q < 4; q++){
      const o = (k + q) * 3;
      lines.push(`v ${pos[o].toFixed(4)} ${pos[o+1].toFixed(4)} ${pos[o+2].toFixed(4)} ` +
                 `${col[o].toFixed(4)} ${col[o+1].toFixed(4)} ${col[o+2].toFixed(4)}`);
      lines.push(`vn ${nrm[o].toFixed(4)} ${nrm[o+1].toFixed(4)} ${nrm[o+2].toFixed(4)}`);
    }
    lines.push(`f ${vi}//${vi} ${vi+1}//${vi+1} ${vi+2}//${vi+2} ${vi+3}//${vi+3}`);
    vi += 4;
  }
  const quads = verts / 4;
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
    // Expanded per specimen and dropped again, so the sheet never holds more
    // than one baked mesh at a time however many cells are standing.
    const mesh = Core.expandInstances(p.inst);
    const pos = mesh.pos, nrm = mesh.nrm, idx = mesh.idx;
    const col = (State.colorMode === 'orbit' && mesh.colOrbit) ? mesh.colOrbit : mesh.col;
    const verts = pos.length / 3;
    if (!verts) continue;

    const ox = cellWorldX(c.i), oz = cellWorldZ(c.j), oy = S * 0.5 + 0.42;
    lines.push(`# symmetry mode: ${p.tierSymmetry ? 'independent address tiers' : 'coupled whole-grid'}; groups: ${symmetryLabel(p)}; radices: ${p.levels.map(l=>l.radix).join(',')}`);
    lines.push(`o cell_${c.i}_${c.j}_${symmetryLabel(p,true).replaceAll(' / ','-')}_${ARCH_NAMES[p.arch]}`);
    for (let k = 0; k < verts; k++){
      const o = k * 3;
      lines.push(`v ${(pos[o]*S+ox).toFixed(4)} ${(pos[o+1]*S+oy).toFixed(4)} ${(pos[o+2]*S+oz).toFixed(4)} ` +
                 `${col[o].toFixed(4)} ${col[o+1].toFixed(4)} ${col[o+2].toFixed(4)}`);
      lines.push(`vn ${nrm[o].toFixed(4)} ${nrm[o+1].toFixed(4)} ${nrm[o+2].toFixed(4)}`);
    }
    for (let k = 0; k < idx.length; k += 3){
      const a = idx[k] + vCount, b = idx[k+1] + vCount, d = idx[k+2] + vCount;
      lines.push(`f ${a}//${a} ${b}//${b} ${d}//${d}`);
    }
    tris += idx.length / 3;
    vCount += verts;
    blocks++;
  }

  const filename = `bimoblock_sheet_${Math.round(rig.x / CFG.CELL)}_${Math.round(-rig.z / CFG.CELL)}_g${Mint.gen}.obj`;
  download(new Blob([lines.join("\n")], { type:'text/plain' }), filename);
  toast(`${filename} — ${blocks} specimens, ${tris.toLocaleString()} triangles`);
}

