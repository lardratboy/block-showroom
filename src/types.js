/* Shared JSDoc typedefs. No runtime code: this module exists so editors can
   give completion and hover docs on the plain objects that flow between the
   core, the worker, the generation pool and the virtualiser, without a
   TypeScript build. Reference a type from any module with a
   `@type {import('../types.js').BlockData}` tag, or in @param / @returns. The names match what the code calls the
   values: `P` is a Recipe, `p` is a BlockData, `l` is a Level. */

/**
 * One tier of the nested voxel grid. `Tier.levels[0]` is the outer (macro)
 * tier; the resolution is the product of every `radix`.
 * @typedef {Object} Level
 * @property {number} radix  Cells per side at this tier (2..5 in practice).
 * @property {number} gap    Fraction of a cell left empty between children
 *                           of this tier, applied during voxel layout.
 * @property {number} [sym]  Subgroup index for this tier when
 *                           `Recipe.tierSymmetry` is on; `-1`/absent means
 *                           "inherit the specimen's group".
 */

/**
 * What the core needs to build one specimen. Pure data: the same Recipe and
 * levels always produce the same voxels. Produced by `cellParams()` /
 * `cellRecipe()` and checked by `test/golden.json`.
 * @typedef {Object} Recipe
 * @property {number} sym            Index into `Core.GROUPS` (Oh subgroup).
 * @property {number} arch           Index into `Core.ARCH_NAMES` (envelope).
 * @property {number} field          Index into `Core.FIELD_NAMES` (scalar field).
 * @property {number} lift           Index into `Core.LIFT_NAMES`.
 * @property {number} density        Fraction of envelope cells kept (0.06..0.72).
 * @property {bigint} seed           Unsigned 64-bit hash; drives the field.
 * @property {boolean} [tierSymmetry] Each tier folds by its own `Level.sym`.
 */

/**
 * How a district cell relates to its pin (`cellRecipe()` in lattice/recipe.js).
 * `null` outside a district.
 * @typedef {Object} Kin
 * @property {number} ring       Chebyshev distance from the pin; 0 is the pin.
 * @property {string[]} drift    Traits mutated away from the pin's recipe:
 *                               'sym' | 'arch' | 'field' | 'lift' | 'density' | 'seed'.
 */

/**
 * The full address → specimen resolution for one cell.
 * @typedef {Object} CellRecipe
 * @property {Recipe} P
 * @property {Kin|null} kin
 */

/**
 * Transferable mesh buffers from `Core.meshArrays()`. Converted to a
 * `THREE.BufferGeometry` by `geometryFromArrays()` on the main thread.
 * @typedef {Object} MeshArrays
 * @property {Float32Array} pos             xyz per vertex.
 * @property {Float32Array} col             rgb per vertex, the gamut colouring.
 * @property {Float32Array|null} colOrbit   rgb per vertex, coloured by fold orbit.
 * @property {Float32Array} nrm             xyz normal per vertex.
 * @property {Uint16Array|Uint32Array} idx  Triangle indices (32-bit above 65535 verts).
 * @property {number} quads
 * @property {number} tris                  Always `quads * 2`.
 * @property {{center:number[], radius:number}} bounds  Bounding sphere.
 * @property {number} bytes                 Total byte length of every buffer.
 * @property {{mesh:number, bounds:number}} timings  Milliseconds.
 */

/**
 * Return value of `Core.buildBlock(P, levels)`.
 * @typedef {Object} BuildResult
 * @property {Uint8Array} occ        Occupancy, `R*R*R`, x fastest.
 * @property {number} R              `levelResolution(levels)`.
 * @property {number} filled         Count of set cells in `occ`.
 * @property {number} envelopeCells  Cells inside the archetype envelope.
 * @property {MeshArrays} geometry
 * @property {{evaluate:number, select:number, mesh:number, bounds:number, total:number}} timings
 */

/**
 * A resident specimen in `Virtualiser.cache`: the recipe it was built from
 * plus everything the renderer and inspector need. Built by
 * `GenerationPool.service()`, freed by `Virtualiser.evict()`.
 * @typedef {Recipe & {
 *   occ: Uint8Array,
 *   R: number,
 *   levels: Level[],
 *   filled: number,
 *   envelopeCells: number,
 *   geo: import('three').BufferGeometry,
 *   geoLod: import('three').BufferGeometry|null,
 *   geoCenters: import('three').BufferGeometry|null,
 *   tris: number,
 *   lodTris?: number,
 *   aut: number,
 *   seen: number,
 *   kin: Kin|null,
 *   bytes: number,
 *   revision: number
 * }} BlockData
 * `geo` is the full mesh; `geoLod` is the outer-tier proxy, meshed lazily by
 * `Virtualiser.lodOf()`; `geoCenters` is the voxel-centre point cloud, built
 * lazily by `Virtualiser.viewOf()` for the 'centers' render mode (the wire and
 * points views hang off `geo`/`geoLod` in their `userData` instead).
 * `aut` is the automorphism order, `-1` until the
 * analyze job for the focused cell lands. `seen` is the LRU tick.
 */

/**
 * The numeric message that crosses to a worker (or `runNumericJob()` on the
 * main thread). Only typed arrays and plain numbers: rendering objects
 * never cross threads.
 * @typedef {{ type:'build', jobId:number, recipe:Recipe, levels:Level[] }} BuildJobMessage
 * @typedef {{ type:'analyze', jobId:number, occ:Uint8Array, R:number }} AnalyzeJobMessage
 * @typedef {BuildJobMessage|AnalyzeJobMessage} JobMessage
 */

/**
 * The pool's bookkeeping record for one in-flight job (`GenerationPool`).
 * `payload` becomes the `JobMessage`; the rest stays on the main thread so
 * the result can be matched, validated and installed when it comes back.
 * @typedef {Object} Job
 * @property {'build'|'analyze'} type
 * @property {number} i
 * @property {number} j
 * @property {string} key        `Virtualiser.keyOf(i, j)` at issue time.
 * @property {string} token      `revision/type/key`; the `pending` map key.
 * @property {number} estimate   Bytes reserved against `CFG.RESULT_BYTES`.
 * @property {Object} payload    Spread into the `JobMessage`.
 * @property {number} [revision] Pool revision at dispatch; stale results are dropped.
 * @property {number} [jobId]    Serial matched against the reply.
 * @property {CellRecipe} [rec]  build only.
 * @property {Level[]} [levels]  build only; a snapshot of `Tier.levels`.
 * @property {BlockData} [specimen] analyze only; receives `aut`.
 */

export {};
