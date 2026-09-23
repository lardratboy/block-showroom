# Discussion: mesh generation

Working notes, not a plan. Numbers first, then what I think they mean, then
the questions I want your answer on before anything gets written.

All timings below are Node 22 on this machine, best-of-5 after warmup,
recipe `{sym:3, arch:1, field:1, lift:1, density:0.40}`, seed `0x1234abcd85ebca6b`.

---

## 1. Where the time actually goes

| levels | R | filled | quads | evaluate | select | **mesh** | bounds | total | geometry |
|---|---|---|---|---|---|---|---|---|---|
| `n5` | 5 | 9 | 54 | 0.05 | 0.00 | 0.01 | 0.01 | 0.07 ms | 0.01 MB |
| `classic` | 9 | 91 | 546 | 0.25 | 0.01 | 0.60 | 0.68 | 1.55 ms | 0.11 MB |
| `n4` | 16 | 504 | 3 024 | 1.08 | 0.02 | 0.22 | 0.08 | 1.40 ms | 0.59 MB |
| `tower3` | 27 | 2 475 | 14 850 | 0.56 | 0.03 | 1.13 | 0.37 | 2.09 ms | 2.89 MB |
| 4·4·4 | 64 | 32 412 | 194 472 | 7.14 | 0.37 | **16.73** | 4.71 | 28.95 ms | 40.06 MB |

Your intuition is right that meshing *should* be the cheap part, and wrong
that it currently is. At the new `MAX_R = 64` ceiling, meshing is 58% of the
build and the bounds pass alone (4.71 ms) costs two thirds of the entire
field evaluation. The field evaluation is doing transcendental math per
orbit; the mesher is copying floats. It is losing anyway.

`select` is genuinely free — the quickselect landed well, leave it alone.

---

## 2. The finding that reframes the whole thing

Look at the `quads` column against `filled`:

```
546 / 91     = 6.000
3 024 / 504  = 6.000
14 850/2 475 = 6.000
194 472/32 412 = 6.000
```

**Not one face is ever culled.** Every shipped preset emits exactly six quads
per occupied voxel.

That is not a bug, it is `occludes()` in [bimoblock-core.js:676-683](src/core/bimoblock-core.js#L676-L683)
working exactly as specified:

```js
const a = ... Math.abs(centers[nx] - centers[x]) ...;
return a <= cellSize * (1 + 1e-9);
```

Two logically adjacent voxels only hide each other's faces when their
physical cubes touch. Adjacent cells at the innermost tier are separated by
`cellSize + gap`, so with **any** non-zero innermost gap the test can never
pass. Every preset in [config.js:56-63](src/config.js#L56-L63) has one
(`0.06`, `0.04`, `0.03`, `0.08`, `0.20`). The gaps are the aesthetic — the
specimens read as *assemblies of separated cubes*, not as a solid.

Forcing the innermost gap to zero confirms the mechanism:

| levels | quads/filled |
|---|---|
| `classic`, gap `0.06` | 6.000 |
| `classic`, gap `0` | 4.418 |
| 3·3·3, inner gap `0` | 2.669 |
| 3·3·3, **all** gaps `0` | 1.163 |

So the mesher is carrying a general occlusion test, a two-pass count-then-fill
structure, and a per-face neighbour probe — to serve a case the app never
enters. Six closure calls per voxel to compute a constant.

**The output is fully determined by the occupancy list.** Mesh = `filled`
unit cubes at `voxelCenters()` positions, scaled by `cellSize`. Nothing else.

---

## 3. Three things to do about it, in increasing order of ambition

### A. Flatten the emit (safe, local, byte-identical)

Keep the architecture. Replace `OBJ_FACES` (array of objects holding arrays
of arrays) with one flat `Float32Array(72)` corner template plus a matching
normal template, drop the counting pass when the innermost gap is non-zero
(`quads = filled * 6` analytically), and hoist the occlusion test out of the
inner loop entirely in that case.

I prototyped the emit loop. Same 194 472 quads, same buffer layout:

```
reference meshArrays   16.7 – 34 ms
flat template emit      3.88 ms
```

**4–9×.** No behaviour change, goldens stay green. This is the boring win and
it is available this afternoon.

Two riders:
- **Bounds are analytic.** `min`/`max` over every vertex (4.71 ms at R=64) is
  a scan over data we just wrote. The bounding box is
  `centers[first] ∓ cellSize/2 … centers[last] ± cellSize/2` over the
  occupied range per axis — trackable in the emit loop for free, or derivable
  from the axis layout without touching a vertex.
- **Index buffer is a pure function of quad count.** `idx` never varies: quad
  *k* is always `4k, 4k+1, 4k+2, 4k, 4k+2, 4k+3`. Build one shared
  `Uint32Array` sized for the largest specimen and let every geometry
  `setIndex` a view of it. That deletes 4.6 MB per specimen at R=64 and the
  loop that fills it.

### B. Stop materialising the mesh at all (the real answer)

If geometry is "`filled` identical cubes at known centres", then a baked
40 MB vertex buffer per specimen is a strange thing to be building, uploading,
budgeting (`UPLOAD_BYTES`), and caching (`CACHE_BYTES = 256 MB`).

An `InstancedBufferGeometry` with a 24-vertex cube template and one
`Float32Array(filled * 3)` of centres carries the same picture:

```
baked mesh, R=64:  40.06 MB
centres only:       0.371 MB     (108× less)
```

Everything the baked buffer encodes is recoverable in the shader:
- **position** — instance centre + template corner × `cellSize`
- **normal** — template attribute, unchanged by a translation
- **gamut colour** — it is literally `position + 0.5`; compute it in the
  vertex shader and the `colorGamut` attribute stops existing
- **orbit colour** — one `uint8` per instance, not 12 floats per quad

`voxelCenters()` already produces exactly the buffer this needs. The mesher's
remaining job shrinks to "copy occupancy into a centres array", which is the
`filled`-bounded loop, ~0.3 ms at R=64.

What this costs us, honestly:
- The **OBJ exporter** in [src/export/obj.js](src/export/obj.js) wants real
  triangles. It would need its own expansion path — which is fine, it is not
  on the hot path, and it can call the flat emit from (A).
- The **wire / points derived views** in the virtualiser share vertex buffers
  with the base mesh. Instanced base ⇒ those need rethinking.
- The `?fullGeometry=1` diagnostic and the 3³ LOD proxy both assume baked
  geometry.
- Culling becomes impossible — but §2 says we never cull, so the only thing
  lost is a capability we don't use.

That is a real chunk of work, and it is Phase-4-redesign shaped, not
refactor-step shaped.

### C. Note the thing neither A nor B fixes

At `MAX_R = 64` with `CACHE_MAX = 760` and `POD_MAX = 480`, baked geometry
at 40 MB/specimen blows `CACHE_BYTES` after **six specimens**. The 64-radix
ceiling you just raised and the baked-mesh strategy are not compatible at
lattice scale. Option B isn't a nice-to-have at R=64, it's the enabling move.
Worth knowing before we pile new archetypes and fields on top.

---

## 4. Smaller things I noticed while measuring

- `at` and `occludes` are arrow closures allocated per `meshArrays()` call and
  invoked ~`6 × filled` times. Under the tier/full branch they are two
  different shapes at the same call site.
- `meshArrays` walks all `R³` cells twice (262 144 at R=64) to find `filled`
  occupied ones — 8× more iterations than there is work. An occupied-index
  list built once during selection (we already have `idxArr`) removes both
  walks.
- `bytes` is computed but `tris` is `quads * 2` — with a shared index buffer
  the accounting the upload budget reads becomes much smaller and more honest.
- `performance.now()` is called 4× per build for timings; at 0.07 ms total for
  `n5` that is measurable overhead on small specimens. Not urgent, just funny.

---

## 5. What I want from you

1. **Is the no-culling property intentional and permanent?** If gaps are the
   aesthetic and the innermost gap will always be > 0, I delete the occlusion
   machinery rather than optimise it. If you ever want gap-0 solids, it stays
   as a branch.

  [BPT:Answer.5.1 - I have been using it with at least 1 zero gap usually at the end, having for instance 3:0.5,5:0.0 ]

2. **A now, B later — or straight to B?** A is a contained commit with goldens
   green. B is a redesign that changes what "geometry" means throughout the
   virtualiser, exporter, and LOD path.

   [BPT:Answer.5.2 - A now, B later please work in a branch :) ]

3. **Does anything downstream read the baked vertex buffers** that I haven't
   spotted? The exporter and derived views are what I found.

  [BPT:Answer.5.3 - nothing currently that I can think of ]

4. **Should the LOD proxy survive B?** With instancing, "draw fewer instances"
   may be a better LOD than "draw a 3³ aggregate mesh" — and it'd fall out of
   the same centres buffer.

   [BPT.Answer.5.4 - I suspect LOD is just making things slower by having to find and choose.. ]

Then: archetypes, fields, and the group theory. I suspect §2 matters there
too — if every specimen is a point cloud plus a rendering convention, new
archetypes cost nothing on the mesh side, and the interesting budget is all
in `evaluate`.

---

## 6. Resolution — what your answers changed, and what landed

Branch `feature/mesh-emit`, two commits, `npm test` and `npm run test:browser`
both green.

### 6.1 Answer 5.1 kills the premise of §2

`3:0.5,5:0.0` is a zero innermost gap, so `occludes()` **does** fire in your
actual usage. §2's "not one face is ever culled" is true of every *shipped
preset* and false of how you drive the app. That reverses its conclusion:
the occlusion machinery stays.

Worse, nothing tested it. Every fixture in `test/fixtures.js` separated all
siblings, so the golden hashes only ever covered the six-quads-per-voxel
path — the analytic `quads = filled * 6` shortcut would have passed the
whole suite while silently wrecking every zero-gap specimen you build.

First commit adds `LEVELS.solidcore` (`3:0.5,5:0.0`) and the `solid-core`
recipe: 336 filled, 994 quads, **2.958 quads/voxel — 51% of faces culled**.
Goldens regenerated to add that one entry; all pre-existing hashes verified
byte-identical.

### 6.2 What A became

Occlusion could not be hoisted out on a gap test, but it turned out to be
cheaper than that anyway. **The test depends only on the index pair along
one axis** — `|centers[nx] - centers[x]| <= cellSize` never looks at the
other two. So it is a per-axis table, `touch[u]`, built once in O(R):

```js
for (let u = 0; u + 1 < N; u++)
  touch[u] = (centers[u+1] - centers[u]) <= cellSize * (1 + 1e-9) ? 1 : 0;
```

That is exact for every layout, zero-gap or not — no branch, no special
case, and the per-face closure disappears. Plus the rest of A: flat
`Float64Array` face templates, one grid walk recording a 6-bit face mask per
occupied cell so the emit iterates `filled` cells and never re-probes a
neighbour, and analytic bounds.

The bounds argument is worth stating because it is what makes the scan
deletable: a cell at an axis extreme always has an empty neighbour beyond
it, so it always emits the face carrying the extreme vertex. The box is
therefore `centers[min] - cellSize/2 … centers[max] + cellSize/2` exactly,
the centre is known *before* the emit, and the radius accumulates as
vertices are written. `timings.bounds` is kept as a perf key, now always 0.

### 6.3 Measured, and where §3A was over-optimistic

mesh+bounds, best-of-N, each case in its own process (sharing one process
lets the two implementations pollute each other's JIT — my first run had a
small case reading as 0.2x for that reason alone):

| layout | R | filled | quads | old | new | speedup |
|---|---|---|---|---|---|---|
| `n5` | 5 | 9 | 54 | 0.005 | 0.002 | 1.9× |
| `classic` | 9 | 91 | 546 | 0.040 | 0.018 | 2.2× |
| `n4` | 16 | 504 | 3 024 | 0.220 | 0.090 | 2.4× |
| `tower3` | 27 | 2 475 | 14 850 | 1.057 | 0.437 | 2.4× |
| 4·4·4 | 64 | 32 412 | 194 472 | 14.262 | 6.222 | 2.3× |
| `3:0.5,5:0.0` | 15 | 336 | 994 | 0.097 | 0.037 | 2.6× |
| 4·4·4 inner 0 | 64 | 32 412 | 58 296 | 7.516 | 2.472 | 3.0× |

**2.3–3.0×, not the 4–9× §3A claimed.** That prototype dropped occlusion
altogether, which 5.1 rules out. Whole build is 1.6–1.7× faster; at R=64,
meshing is now 6.2 ms of a 15.1 ms build — still the largest single item,
and what remains is almost entirely the cost of writing 40 MB of vertex
data. That floor is option B's to remove, not A's.

Equivalence was checked directly rather than trusted to the goldens: 421
cases — every fixture × 3 densities × 5 extra layouts (all-zero gaps,
mid-tier zeros, deep zeros, single-level zero) × full mesh and LOD proxy,
plus empty occupancy — match the old implementation bit-for-bit on `pos`,
`col`, `colOrbit`, `nrm`, `idx`, `quads`, `bytes`, `bounds.center` and
`bounds.radius`.

### 6.4 Riders deliberately not taken

- **Shared index buffer.** Still a good idea (4.6 MB/specimen at R=64), but
  it forces `idx` to `Uint32Array` for small specimens that currently get
  `Uint16Array`, which changes a golden hash. It is not a
  behaviour-preserving step, and under B the index buffer becomes a
  24-vertex template anyway. It belongs to B.
- **Passing `idxArr` in from selection** to skip the grid walk entirely.
  Changes `meshArrays()`'s signature, which `src/lattice/recipe.js` and the
  worker both call. The walk is now a cheap `cell[i]` scan; not worth the
  API churn ahead of B.

### 6.5 Open, for B

Your 5.4 instinct — that LOD costs more in choosing than it saves in
drawing — is measurable and I have not measured it. Worth doing before B
rather than after, because "draw fewer instances" only beats the 3³ proxy if
the proxy is actually earning its keep today. §3C still stands unchanged:
at R=64, 40 MB/specimen exhausts `CACHE_BYTES` after six specimens, so B is
the enabling move for the ceiling you just raised, not a nice-to-have.
