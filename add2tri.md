# From Address to Triangles

**How block-showroom turns two numbers into a 3D object on your screen**

The showroom is an endless floor of small sculptures called *bimoblocks*.
Each one stands on its own square of a grid, and each square has an address:
a pair of whole numbers `(i, j)`. None of the sculptures is stored anywhere.
When a square comes into view, the program works out from scratch what
belongs there and draws it.

This document follows that process from start to finish: from the two
numbers of an address to the triangles your graphics card draws. It assumes
no background in graphics or geometry. Each stage explains what goes in,
what comes out and why it's done that way, then shows the step applied to
one real specimen, and ends with a pointer to the code.

---

## Contents

1. [The whole journey on one page](#1-the-whole-journey-on-one-page)
2. [Words you'll need](#2-words-youll-need)
3. [Stage 1: Address → recipe](#3-stage-1-address--recipe)
4. [Stage 2: The grid, levels and resolution](#4-stage-2-the-grid-levels-and-resolution)
5. [Stage 3: Symmetry, folding the grid into orbits](#5-stage-3-symmetry-folding-the-grid-into-orbits)
6. [Stage 4: Envelope, the silhouette](#6-stage-4-envelope-the-silhouette)
7. [Stage 5: Field, giving every cell a score](#7-stage-5-field-giving-every-cell-a-score)
8. [Stage 6: Density, keeping the top slice](#8-stage-6-density-keeping-the-top-slice)
9. [Stage 7: Physical layout, where each cube sits](#9-stage-7-physical-layout-where-each-cube-sits)
10. [Stage 8: The occupancy walk, which faces can be seen](#10-stage-8-the-occupancy-walk-which-faces-can-be-seen)
11. [Stage 9: Off the main thread and into the cache](#11-stage-9-off-the-main-thread-and-into-the-cache)
12. [Stage 10: On the GPU, one cube drawn many times](#12-stage-10-on-the-gpu-one-cube-drawn-many-times)
13. [Stage 11: Into the world and onto the screen](#13-stage-11-into-the-world-and-onto-the-screen)
14. [The other road: triangles on the CPU](#14-the-other-road-triangles-on-the-cpu)
15. [Why it's built this way](#15-why-its-built-this-way)
16. [Try it yourself](#16-try-it-yourself)
17. [Map of the code](#17-map-of-the-code)

---

## The running example

The whole document follows **the specimen at address (0, 0)**. It's the
first thing you see at
[http://localhost:8000/#0,0,15.0,0](http://localhost:8000/#0,0,15.0,0), and
the automated browser test checks this same specimen. Every number quoted
for it below came from running the actual code, not from working it out by
hand.

> **Worked example: cell (0, 0)** boxes like this one show what happens to
> the running example at each stage.

---

## 1. The whole journey on one page

```
  (i, j)            the address, e.g. (0, 0)                  src/lattice/recipe.js
    │
    │  1. scramble the address into a recipe
    ▼
  Recipe  { symmetry, archetype, field, lift, density, seed }
    │
    │  2. pick a grid size from the "levels" setting           src/state.js
    ▼
  An empty R × R × R grid of cells (9 × 9 × 9 = 729 by default)
    │                                                          src/core/bimoblock-core.js
    │  3. SYMMETRY  group cells into sets of mirror-copies
    │  4. ENVELOPE  throw away cells outside the silhouette
    │  5. FIELD     give every surviving cell a score
    │  6. DENSITY   keep only the highest-scoring fraction
    ▼
  Occupancy grid: 1 = "a cube goes here", 0 = "empty"
    │
    │  7. LAYOUT    work out where each cube physically sits (gaps)
    │  8. WALK      list the cubes, note which faces can be seen
    ▼
  Instance record: a list of cubes + a visible-face mask each (6 bytes per cube)
    │
    │  9. send it from the background thread to the main thread
    ▼
  GPU buffers: one centre per cube, plus ONE shared cube shape  src/scene/instancing.js
    │
    │ 10. VERTEX SHADER  place each corner, colour it, hide covered faces
    │ 11. place in the world, apply the camera, rasterise       src/scene/layout.js
    ▼
  Triangles  →  pixels
```

Stages 1–8 are ordinary arithmetic and involve no graphics at all. They live
in the "core", a single file that could run on a server just as well as in a
browser. Stages 10–11 are the graphics part.

---

## 2. Words you'll need

| Word | Meaning here |
|---|---|
| **Lattice** | The endless grid of squares on the floor. Every square holds one specimen. |
| **Address** | A square's coordinates `(i, j)`, such as `(0, 0)` or `(7, -3)`. |
| **Specimen / bimoblock** | One sculpture, made of small cubes. |
| **Cell / voxel** | One slot in a specimen's 3D grid. A voxel is the 3D version of a pixel. A cell is either *occupied* (a cube is drawn there) or empty. |
| **Recipe** | The handful of settings that fully describe a specimen, such as "mirror symmetry, starship shape, seed 75591b98…". |
| **Deterministic / pure** | Same input, same output, every time, with no hidden state. Everything in stages 1–8 is pure. |
| **Hash** | A function that scrambles a number into an unrelated-looking number. The same input always gives the same output, but nearby inputs give wildly different outputs. It's how the program gets "randomness" that is repeatable. |
| **Seed** | A big number that drives the "random" parts of a specimen. Same seed, same details. |
| **Vertex** | A corner point in 3D space, with a position, and here also a colour and a facing direction. |
| **Triangle** | Three vertices joined up. GPUs draw everything as triangles. A square cube face is two triangles. |
| **Face / quad** | One square side of a cube: 4 vertices, 2 triangles. A cube has 6 faces. |
| **GPU** | The graphics card, a processor built to handle millions of vertices and pixels in parallel. |
| **Shader** | A small program that runs on the GPU. A *vertex shader* runs once per vertex and decides where it lands on screen. A *fragment shader* runs once per pixel and decides its colour. |
| **Instancing** | Telling the GPU "here is one shape, draw it N times at these N positions" instead of sending N copies of the shape. |
| **Typed array** | A compact, fixed-type list of numbers (`Uint8Array`, `Float32Array`, …). It's what gets passed between threads and handed to the GPU. |

---

## 3. Stage 1: Address → recipe

**In:** `(i, j)` and the global settings. **Out:** a recipe.
**Code:** [`cellParams()` in src/lattice/recipe.js](src/lattice/recipe.js#L52)

Think of a library catalogue with no shelves. The catalogue number *is* the
book: read the number the right way and the whole book can be rewritten from
it. Nothing about a specimen is saved. Its address is its identity, and the
recipe is computed from the address every time.

### The two axes mean something

By default the **x axis walks through the 12 archetypes** (shapes) and the
**y axis walks through the 10 symmetry groups**:

```
archetype = i mod 12        page_x = floor(i / 12)
symmetry  = j mod 10        page_y = floor(j / 10)
```

So cells `(0…11, 0…9)` form one **page**, a 12 × 10 contact sheet that
shows every shape under every symmetry. One step right from `(11, 0)` wraps
back to archetype 0 on the next page. (You can change which trait each axis
walks in the UI, or set an axis to "free roam".)

### Everything else comes from a hash of the page

The traits no axis controls come out of a hash of the *page* numbers and the
*generation* number:

```js
h = hash32(hash32(page_x, 0x51ed270b ^ gen·0x9e3779b1), page_y·31 + 7)

field = (h >>> 16) % 16      // which scoring function (stage 5)
lift  = (h >>> 24) % 3       // a sub-option some fields use
seed  = two more hashes, glued into one 64-bit number
```

`hash32` ([recipe.js:32](src/lattice/recipe.js#L32)) is a few multiplications
by large odd constants plus bit shifts. What matters is its behaviour: feed
it `(0, 0)` and you get `0x72a1d91c` today, tomorrow and on every computer.
Feed it `(0, 1)` and you get something completely unrelated.

Because the hash takes the *page* and not the exact cell, every specimen on a
page shares one seed. A row across a page is one "random" pattern sculpted
into twelve different shapes, which is what makes the contact sheet readable.

**Density** (the share of cells to keep, stage 6) is a global slider,
0.25 by default.

**Generation** (`gen`) is a master counter. It's the fourth number in the
URL (`#0,0,15.0,`**`0`**), and pressing **G** bumps it. Because it feeds
every hash, changing it re-rolls the whole lattice at once, and changing it
back brings every specimen back exactly.

> **Worked example: cell (0, 0), generation 0**
>
> | trait | how it's chosen | value |
> |---|---|---|
> | symmetry | `0 mod 10` | 0 → **C1:free** (no symmetry at all) |
> | archetype | `0 mod 12` | 0 → **starship** |
> | page | `floor(0/12), floor(0/10)` | (0, 0) |
> | page hash `h` | `hash32(…)` | `0x72a1d91c` |
> | field | `0x72a1 % 16` | 1 → **shells** |
> | lift | `0x72 % 3` | 0 → weighted |
> | density | global slider | 0.25 |
> | seed | two hashes | **`75591b98ce6d116d`** |
>
> This seed is exactly what the inspector panel shows for this cell.

### Sidebar: districts ("bloom")

Press **B** on a specimen to *pin* it. Its neighbours then become its
relatives: the ring right next to it inherits its recipe almost exactly, and
cells further out drift away more and more (a different shape here, a new
seed there). This is [`cellRecipe()`](src/lattice/recipe.js#L117), a thin
wrapper around `cellParams()`. It's still a pure function, now of
(address, generation, pin), so a district is exactly as reproducible as the
plain lattice. Everything after this stage is identical either way.

---

## 4. Stage 2: The grid, levels and resolution

**In:** the *levels* setting. **Out:** a grid size `R` and ways to describe
each cell's position.
**Code:** [`levelResolution`, `decomposeDigits`, `foldedAxis` in bimoblock-core.js](src/core/bimoblock-core.js#L190)

A specimen is carved out of a cube-shaped block of `R × R × R` cells. `R`
comes from the **levels**, a list of tiers such as:

```
classic = [ { radix: 3, gap: 0.30 },   ← outer tier ("macro")
            { radix: 3, gap: 0.06 } ]  ← inner tier ("micro")
```

Read it like this: along each axis there are **3 big blocks, each split into
3 small cells**, so `R = 3 × 3 = 9` and the grid has `9³ = 729` cells. The
`gap` values only matter in stage 7, where they set how far apart things sit.

| preset | levels (radices) | R | cells |
|---|---|---|---|
| `n5` | 5 | 5 | 125 |
| `classic` (default) | 3 × 3 | 9 | 729 |
| `n4` | 4 × 4 | 16 | 4 096 |
| `hetero` | 4 × 3 × 2 | 24 | 13 824 |
| `tower3` | 3 × 3 × 3 | 27 | 19 683 |

### Three ways to name a cell along one axis

It's worth getting this straight early, because the code switches between
them:

1. **Index `u`**, a whole number `0 … R-1` that says which slot. With
   mixed-radix digits, `u = 3·macro + micro`, like reading "47" as 4 tens and
   7 ones. So `u = 5` is macro block 1, micro cell 2.
2. **Logical coordinate `s`**, the index rescaled to run from −1 to +1:
   `s = (u − 4) / 4` when `R = 9`. The shape decisions in stages 3–5 use
   this. It's evenly spaced and ignores gaps.
3. **Physical position**, where the cube is actually drawn, with gaps. That
   comes later, in stage 7.

A 3D cell has three indices `(x, y, z)`, which the code often packs into one
**flat index**: `li = x + R·y + R²·z`.

> **Worked example.** Flat index 29 is `x=2, y=3, z=0`, because
> `2 + 9·3 + 81·0 = 29`. Its logical coordinates are
> `s = (−0.5, −0.25, −1.0)`. This is the first cube the specimen ends up
> with, and we'll keep coming back to it.

---

## 5. Stage 3: Symmetry, folding the grid into orbits

**In:** the grid and the recipe's symmetry group. **Out:** cells grouped
into *orbits*, one representative each.
**Code:** [`GROUPS`](src/core/bimoblock-core.js#L71) and the orbit loop in [`buildBlock()`](src/core/bimoblock-core.js#L944)

### The 48 symmetries of a cube

Pick up a cube. There are 48 ways to put it back so it looks untouched:
6 ways to reorder the axes (x↔y and so on) times 8 ways to flip their signs
(mirror left/right, up/down, front/back). Each of these moves sends a point
`(x, y, z)` to another point, for example `(−x, y, z)` for a left–right
mirror.

A **symmetry group** is a chosen subset of those 48 moves that "closes up":
doing any two of them in a row gives another move in the set. The recipe
picks one of ten:

| # | name | moves in group | orbits in a 9³ grid |
|---|---|---|---|
| 0 | C1:free | 1 (do nothing) | 729 |
| 1 | Cs:mirror-X | 2 | 405 |
| 2 | C2:rot180-Y | 2 | 369 |
| 3 | C2v:bi-axial | 4 | 225 |
| 4 | C3:diag-3 | 3 | 249 |
| 5 | C4:pinwheel | 4 | 189 |
| 6 | C4v:quad-4 | 8 | 135 |
| 7 | S6:diag-6 | 6 | 125 |
| 8 | Td:tetra-24 | 24 | 55 |
| 9 | Oh:octa-48 | 48 | 35 |

A group with no mirror moves in it is called **chiral**: the specimen will
have a distinct left- and right-handed version, like a screw. The "chiral"
colour mode tints specimens by this property.

### Orbits: sets of copies

Take one cell and apply every move in the group to it. The cells you land on
form that cell's **orbit**, a set of cells that the symmetry says must look
the same.

- Under **mirror-X**, cell `(3, −1, 2)` has orbit `{ (3, −1, 2), (−3, −1, 2) }`,
  itself and its reflection.
- Under **Oh** (all 48 moves), `(3, −1, 2)` has 48 copies, but `(2, 2, 0)`
  has only 12, because some moves leave it where it is (it sits on a mirror
  plane).

(These coordinates are centred on the middle of the grid, running −4…4
when `R = 9`.)

### The trick: decide once per orbit

For each orbit, the code picks one **representative**, the member that comes
first in dictionary order (smallest x, then y breaks ties, then z). Every
later decision (is it inside the silhouette? what's its score?) is made
**once, at the representative**, and the answer is copied to every member.

That one idea does two jobs:

1. **The symmetry is guaranteed.** Copies can't come out different, because
   they don't have separate answers. They literally share one.
2. **It's faster.** Under Oh at `R = 9`, the program makes 35 decisions
   instead of 729.

The code walks the grid in order, and each cell it hasn't visited yet starts
a new orbit. It generates the whole orbit, evaluates the representative, and
marks every member as visited.

It also records, for each cell, *which* move carried it to the
representative (the `orbit[]` byte). That isn't needed for the shape, but the
"orbit" colour mode uses it to paint each symmetric copy a different hue.

> **Worked example.** Cell (0, 0) uses **C1:free**, the group with only the
> do-nothing move. Every cell is its own orbit, so this specimen has no
> symmetry at all. To see what the group changes, here is the *same* recipe
> built under other groups:
>
> | group | cells in silhouette | cubes kept | symmetries of the result |
> |---|---|---|---|
> | C1:free | 251 | 63 | 1 |
> | Cs:mirror-X | 251 | 63 | 2 |
> | C2v:bi-axial | 309 | 77 | 4 |
> | Oh:octa-48 | 149 | 48 | 48 |
>
> "Symmetries of the result" is the **aut** figure in the inspector. After the
> focused specimen is built, a background job counts how many of the 48 cube
> moves leave it unchanged. It always comes out at least the group size, which
> checks that the guarantee held.

### Sidebar: independent tier symmetry

The levels panel has a checkbox that gives **each tier its own symmetry
group**, so the big blocks can be arranged with 4-fold symmetry while the
small cells inside each block are mirrored. That path
([`tierFolder()`](src/core/bimoblock-core.js#L909)) folds each tier's digits
separately using lookup tables. The idea is the same: find a canonical
representative and decide there.

---

## 6. Stage 4: Envelope, the silhouette

**In:** each orbit's representative, as logical coordinates `s`. **Out:**
in or out.
**Code:** [`envelope()` in bimoblock-core.js](src/core/bimoblock-core.js#L122)

The **archetype** sets the overall silhouette. `envelope(sx, sy, sz, arch)`
is a yes/no test on a point in the −1…+1 cube, and there are 12 of them:

> starship · mech · totem · crystal · orbiter · full · hollow · spire ·
> frame · spindle · gyroid · lens

Most are a line or two of arithmetic. **Crystal**, for example, is
`|sx| + |sy| + |sz| ≤ 1.25`, a diamond (octahedron). **Hollow** keeps points
whose distance from the centre is between 0.55 and 1.05, a thick shell.
**Full** says yes to everything.

Cells whose representative fails the test are out, and so is their whole
orbit. Because the test only runs at the representative, a big symmetry
group can trim a lopsided silhouette down to its symmetric core. That's why
the Oh version above has only 149 cells inside instead of 251.

> **Worked example: starship**
>
> ```js
> wings = 0.28 + 0.72 * (1 - (sz + 1) / 2)   // 1.0 at the back, 0.28 at the nose
> thick = 0.35 + 0.65 * (1 - |sz|)           // fattest in the middle, thin at both ends
> inside = |sx| <= wings  &&  |sy| <= thick
> ```
>
> A wedge that is broad at the back and tapers to a point: a dart. Cell 29,
> at `s = (−0.5, −0.25, −1.0)`, sits at the very back (`sz = −1`), where
> `wings = 1.0` and `thick = 0.35`. Both `0.5 ≤ 1.0` and `0.25 ≤ 0.35` hold,
> so it's **inside**.
>
> Across the whole grid, **251 of the 729 cells** are inside the starship.

---

## 7. Stage 5: Field, giving every cell a score

**In:** each representative inside the envelope, plus the seed. **Out:** a
number, the score.
**Code:** [`field()`](src/core/bimoblock-core.js#L327) and [`tierField()`](src/core/bimoblock-core.js#L404)

If the envelope were the whole story, every starship would be the same solid
dart. The **field** gives the inside texture. It gives each cell a score, and
stage 6 keeps the high scorers, so the field decides *which* parts of the
silhouette get filled in.

There are 16 fields in three families:

| family | names | idea |
|---|---|---|
| native | `xor/hash`, `shells`, `diamond`, `popcount` | Direct formulas in 3D: pure noise, rippling ellipsoid shells, rippling diamonds, bit counting |
| planar (`p:`) | `p:conic`, `p:cubic`, `p:trefoil`, … | A 2D polynomial "lifted" into 3D. The recipe's **lift** picks how: weighted, extrude or nested |
| tier (`t:`) | `t:digit-swap`, `t:wreath`, `t:cross`, … | Uses the macro and micro digits from stage 2, so a cell's score depends on its position *within* its block as well as the block's position in the specimen |

**The seed enters here, and only here.** The code splits it into two 32-bit
halves `lo` and `hi`, plus a mixed digest `mix`
([`seedWords()`](src/core/bimoblock-core.js#L283)). Each field mixes some of
those in: the hash field uses all 64 bits, while the wave fields use a few
bits of `mix` as a phase shift. Two specimens with the same recipe but
different seeds get the same silhouette with different detail.

> **Worked example: shells.** The seed's `mix` is `4068824536`, and its low
> byte `mix & 0xff` is **216**.
>
> ```js
> r     = sqrt(1.00·sx² + 1.37·sy² + 0.71·sz²)      // squashed distance from centre
> tilt  = 0.55·sx − 0.31·sy + 0.83·sz                // a slant
> score = 0.5 + 0.5 · sin(r·9.4248 + tilt·4.1 + 216·0.1)
> ```
>
> The score ripples up and down with distance from the centre, which makes
> nested, slightly tilted shells. For cell 29, `s = (−0.5, −0.25, −1.0)`:
>
> ```
> r     = sqrt(0.25 + 1.37·0.0625 + 0.71·1)  = 1.0226
> tilt  = −0.275 + 0.0775 − 0.83             = −1.0275
> score = 0.5 + 0.5 · sin(9.638 − 4.213 + 21.6) = 0.9744
> ```
>
> A high score. Keep an eye on it for the next stage.

---

## 8. Stage 6: Density, keeping the top slice

**In:** the scores of every cell inside the envelope, and the density.
**Out:** the **occupancy grid** `occ`, which holds a 1 or 0 for each of the
`R³` cells.
**Code:** end of [`buildBlock()`](src/core/bimoblock-core.js#L1043) and [`quickSelect()`](src/core/bimoblock-core.js#L575)

Density is "what share of the silhouette to fill". The rule is:

1. `want = round(density × cells_in_envelope)`.
2. Find the score of the `want`-th best cell. Call it the **cut**.
3. Keep every cell whose score is **≥ cut**.

Finding the `want`-th best doesn't need a full sort. **Quickselect** finds a
single ranked value in about the time of one pass. It's the same idea as
quicksort, except that it only recurses into the side that holds the rank it
wants.

Rule 3 says **≥** rather than "the top `want`", and that matters for
symmetry. All copies in an orbit share one score (stage 3), so they're either
all above the cut or all below it. A symmetric specimen can't lose half of a
mirror pair at this step.

> **Worked example.**
>
> ```
> want = round(0.25 × 251) = round(62.75) = 63
> cut  = 63rd-highest score           = 0.9024
> ```
>
> Cell 29 scored 0.9744, so it's **kept**. In total **63 cells** end up
> occupied. The inspector shows this as **63/251**, the same figure the
> browser test checks.

At this point the *shape* is finished. `occ` is 729 bytes of ones and
zeros, and everything after this is about how to draw it.

---

## 9. Stage 7: Physical layout, where each cube sits

**In:** the levels (with their gaps). **Out:** a table of centre positions
along one axis, and the cube size.
**Code:** [`tierAxisLayout()` in bimoblock-core.js](src/core/bimoblock-core.js#L225)

So far a cell is only a slot number. Now each cube gets an actual position.
Each tier's `gap` sets how much empty space goes between its children, as a
fraction of one child's width:

```
one axis, classic levels (gap 0.30 between macro blocks, 0.06 between micro cells)

   macro 0              macro 1              macro 2
 ┌─┐ ┌─┐ ┌─┐        ┌─┐ ┌─┐ ┌─┐        ┌─┐ ┌─┐ ┌─┐
 └─┘ └─┘ └─┘        └─┘ └─┘ └─┘        └─┘ └─┘ └─┘
 u=0  1   2          3   4   5          6   7   8
     ↑                 ↑
  small gap         big gap
  (6% of a cube)    (30% of a macro block)
```

The gaps are what make specimens look like *assemblies of separate cubes*
rather than solid lumps.

The whole thing is then scaled to fit a box from −0.5 to +0.5 on every axis
(the "unit box"), so changing levels or gaps never changes the specimen's
overall footprint.

> **Worked example: the arithmetic for `classic`**, in units of one cube:
>
> ```
> micro block  = 3 cubes + 2 small gaps = 3 + 2·0.06           = 3.12
> macro stride = micro block + big gap  = 3.12 · 1.30          = 4.056
> whole axis   = 3 micro blocks + 2 big gaps = 3·3.12 + 2·0.3·3.12 = 11.232
>
> scale to the unit box: divide everything by 11.232
> cube size  = 1 / 11.232 = 0.0890
> ```
>
> The centre table (the same one serves x, y and z):
>
> ```
> u:       0        1        2        3        4       5       6       7       8
> centre: −0.4555  −0.3611  −0.2667  −0.0944  0.0000  0.0944  0.2667  0.3611  0.4555
> ```
>
> Cell 29, `(x=2, y=3, z=0)`, therefore has its cube centred at
> **(−0.2667, −0.0944, −0.4555)**, and the cube is 0.0890 wide.

The table is kept in 64-bit precision on purpose. The CPU-side
triangle builder (section 14) must reproduce old output bit for bit, and
rounding the centres to 32-bit first would shift every corner very
slightly. Only the copy sent to the GPU is 32-bit.

---

## 10. Stage 8: The occupancy walk, which faces can be seen

**In:** `occ`, the centre table and the cube size. **Out:** the
**instance record**, the specimen in its final, compact form.
**Code:** [`instanceArrays()` in bimoblock-core.js](src/core/bimoblock-core.js#L702)

### Hidden faces

Every cube has 6 faces. If two cubes sit **flush** against each other, the
faces where they meet can never be seen, so there's no point drawing them.
A face is hidden when both of these hold:

1. the neighbouring cell in that direction is occupied, **and**
2. the two cubes physically touch, meaning there is no gap between them.

Condition 2 only depends on the two positions along *one* axis, so it's
computed once as a small table: `touch[u]` is 1 if cells `u` and `u+1` are
flush. That's true exactly when their centres are no more than one cube width
apart.

With the classic gaps, neighbouring centres are 0.0944 apart and a cube is
0.0890 wide, so **nothing ever touches** and every face of every cube is
visible. Set an inner gap to 0 and it matters a lot: levels
`3 (gap 0.5), 5 (gap 0.0)` built from the same recipe give 317 cubes but only
1 164 visible faces instead of 1 902, about 39% hidden.

### The walk

The code makes one pass over the grid. For each occupied cell it records the
cell's flat index and a **face mask**, one bit per face, set if that face is
visible:

| bit | 1 | 2 | 4 | 8 | 16 | 32 |
|---|---|---|---|---|---|---|
| face | +X | −X | +Y | −Y | +Z | −Z |

A mask of `63` (all six bits) means a fully exposed cube. A mask of `0` means
a cube buried on all sides.

### The instance record

The result is everything any later step needs:

| field | type | per | meaning |
|---|---|---|---|
| `cells` | Uint32 | cube | flat grid index |
| `masks` | Uint8 | cube | visible-face bits |
| `orbitIdx` | Uint8 | cube | which symmetry move (for orbit colouring) |
| `centers` | Float64 | axis slot | the stage 7 table, `R` entries |
| `cellSize` | number | specimen | cube width |
| `bounds` | sphere | specimen | a centre and radius that enclose everything, used later to skip off-screen specimens |

That's **6 bytes per cube** plus one small table. The record contains no
triangles: it says *which* cubes and *which* faces, and leaves drawing them to
the GPU.

> **Worked example.**
>
> ```
> count   = 63 cubes
> cells   = [29, 30, 31, 35, 37, …]    ← cell 29 is first
> masks   = [63, 63, 63, 63, 63, …]    ← every face visible (classic gaps)
> quads   = 378 visible faces (= 63 × 6)
> bytes   = 63·4 + 63 + 63 + 9·8 = 450
> bounds  = centre (0.047, 0, 0), radius 0.689
> ```
>
> The whole specimen fits in **450 bytes**.

---

## 11. Stage 9: Off the main thread and into the cache

**Code:** [src/lattice/generation.js](src/lattice/generation.js), [src/core/worker.js](src/core/worker.js), [src/scene/virtualiser.js](src/scene/virtualiser.js)

Stages 3–8 cost a fraction of a millisecond per specimen, but a screenful
holds around 300 of them. If the browser tab's main thread did all that
work, scrolling would stutter. So the work goes to **Web Workers**,
background threads with no access to the page or the graphics.

1. The **virtualiser** keeps a list of cells in view, nearest first.
2. The **generation pool** turns each cell that isn't cached yet into a *job*
   (the recipe and levels, just numbers) and posts it to an idle worker.
3. The worker runs `buildBlock()`, which is stages 3–8, and posts back the
   instance record. Its arrays are *transferred* rather than copied: ownership
   of the memory moves across threads instantly.
4. Once per frame, [`service()`](src/lattice/generation.js#L185) accepts
   finished results, with a small time and byte budget per frame so no single
   frame gets overloaded. Each result is stored in the **cache**, keyed by
   address.
5. When the cache is full, the specimens seen least recently (and not on
   screen) are dropped. Walking back to them later just rebuilds them, and
   stage 1 guarantees the rebuild is identical.

If workers aren't available, `?workers=0` in the URL forces the fallback,
which runs the same `buildBlock()` on the main thread, one job per frame.

---

## 12. Stage 10: On the GPU, one cube drawn many times

**Code:** [src/scene/instancing.js](src/scene/instancing.js)

### Instancing: the rubber stamp

A specimen is just `count` identical cubes at different positions. So the GPU
isn't sent 63 cubes' worth of corners. It gets:

- **one template cube**, shared by every specimen on the page, and
- **one small record per cube**: its centre, its face mask and its orbit
  byte.

Then it's told: "stamp the template once per record". That's **instancing**.

### The template cube

[`templates()`](src/scene/instancing.js#L34) builds the template once. A cube
has 8 corners, but the template has **24 vertices**: 4 per face × 6 faces.
Corners get repeated because each face needs its own **normal** (the
direction it faces, used for lighting). The corner where the top, front and
left faces meet appears three times, once per face, each copy with a
different normal.

Each template vertex also carries its face's bit (1, 2, 4, … 32) as
`faceBit`, which is how the shader will know which faces to hide.

The **index list** says how to join the 24 vertices into triangles: 6 faces ×
2 triangles × 3 corners = **36 indices, 12 triangles**. For a face whose
corners are `0, 1, 2, 3`, the two triangles are `0-1-2` and `0-2-3`:

```
 3 ─────── 2
 │       ╱ │
 │     ╱   │     triangle A: 0 → 1 → 2
 │   ╱     │     triangle B: 0 → 2 → 3
 │ ╱       │     (counter-clockwise seen from outside,
 0 ─────── 1      which is how the GPU knows the front side)
```

### Per-cube data

[`InstancedSpecimen`](src/scene/instancing.js#L78) turns the instance record
into three GPU attributes:

| attribute | per cube | from |
|---|---|---|
| `instCenter` | 3 × float32 = 12 bytes | `centers[x], centers[y], centers[z]` looked up from `cells` |
| `instMask` | 1 byte | `masks` |
| `instOrbit` | 1 byte | `orbitIdx` |

That's **14 bytes per cube** on the GPU.

### The vertex shader, line by line

The drawing uses stock Three.js materials (a standard lit material for solid
cubes). [`patchInstancing()`](src/scene/instancing.js#L215) slips three small
additions into its vertex shader. The GPU runs that shader **once for every
template vertex of every cube**, so 24 × 63 = 1 512 runs for our specimen.

**1. Where is this corner?**

```glsl
vec3 transformed = instCenter + position * uCellSize;
```

`position` is the template corner, each coordinate ±0.5, and `uCellSize` is
the cube width. So this is "the cube's centre, plus half a cube width in the
direction of this corner". It's the exact same arithmetic the CPU uses in
section 14.

**2. What colour is it?**

```glsl
vColor = mix(transformed + 0.5, bimoblockOrbitColor(instOrbit, uOrbitOrder), uOrbitMix);
```

In the default **gamut** colouring, the colour *is* the position: adding 0.5
moves the unit box from −0.5…0.5 to 0…1, and then x, y, z become red, green,
blue. A corner's colour tells you where it sits in its specimen: redder
toward +x, greener toward +y, bluer toward +z. In **orbit** colouring
(`uOrbitMix = 1`) the cube instead gets a flat hue picked by its orbit byte,
so each symmetric copy shows in a different colour.

**3. Should this face be drawn at all?**

```glsl
if (faceBit > 0.5 && mod(floor(instMask / faceBit), 2.0) < 0.5)
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
```

This checks "is this vertex's face bit set in this cube's mask?". If it
isn't, the vertex is thrown to a point *outside the visible screen volume*
(the GPU only draws what lands in −1…+1 on every axis). All four corners of a
hidden face get the same treatment, so the whole face collapses to an
off-screen point and the GPU discards it before any pixel is coloured.

> **Worked example.** Cube 29's centre is `(−0.2667, −0.0944, −0.4555)` and
> `uCellSize = 0.0890`. Its first template vertex, on the +X face, is the
> corner `(+0.5, −0.5, −0.5)`:
>
> ```
> transformed = (−0.2667, −0.0944, −0.4555) + (0.5, −0.5, −0.5) × 0.0890
>             = (−0.2222, −0.1389, −0.5000)
> gamut colour = transformed + 0.5 = (0.278, 0.361, 0.000)   → a dark olive green
> mask 63 has bit 1 (+X) set                                → drawn
> ```
>
> The whole specimen goes to the GPU as **63 instances × 12 triangles = 756
> triangles** in one draw call.

### Four render modes, one set of data

The render-mode menu doesn't rebuild anything. Each mode is a different
**index list over the same template and the same per-cube data**:

| mode | template | index list | draws |
|---|---|---|---|
| solid | 24-vertex cube | 36 (triangles) | shaded boxes |
| wire | 24-vertex cube | 48 (4 edges per face) | box outlines |
| points | 24-vertex cube | none | a dot at every corner |
| centers | 1 vertex at the centre | none | one dot per cube |

Switching modes therefore costs almost nothing, and the face mask hides the
covered edges and corners in every mode, not only in solid.

---

## 13. Stage 11: Into the world and onto the screen

**Code:** [`layout()` in src/scene/layout.js](src/scene/layout.js#L29), [src/scene/scene.js](src/scene/scene.js)

Everything so far lives in the specimen's own little unit box. Each frame,
`layout()` places every visible specimen in the shared world:

| | value | for cell (0, 0) |
|---|---|---|
| floor position | `x = i × 2.6`, `z = −j × 2.6` | (0, 0) |
| height | 1.01 above the floor, plus a gentle bob, plus a rise while fading in | ≈ 1.01 |
| scale | the unit box becomes 1.18 world units wide (starting smaller and growing as it fades in) | 1.18 |
| rotation | a slow spin; speed and phase come from `hash32(i, j)`, so each cell spins differently but always the same way | — |

Those values form the object's **model matrix** (object space to world
space). From there it's the standard graphics pipeline, all done by Three.js
and the GPU:

1. **View matrix:** world to "as seen from the camera".
2. **Projection matrix:** a 50° perspective lens, so far things shrink.
3. **Clipping:** anything outside the visible volume is dropped, including
   the hidden faces from stage 10.
4. **Rasterisation:** each surviving triangle is turned into the screen
   pixels it covers.
5. **Fragment shader:** each pixel is lit (one ambient light plus two
   directional lights) and fogged with distance, starting from the vertex
   colour.

Two refinements keep this fast:

- **Frustum culling.** The bounding sphere from stage 8 lets Three.js skip a
  specimen entirely when it's behind the camera or off to the side.
- **Level of detail (LOD).** A specimen that is smaller than about 30 pixels
  on screen is drawn from a coarse stand-in: only the outer tier's blocks
  (`3³ = 27` cells for classic). A block is kept if enough of the cells
  inside it are occupied. It's built lazily by the same `instanceArrays()`
  function ([`siteTier()`](src/core/bimoblock-core.js#L639) chooses the
  blocks) and drawn the same instanced way. `?fullGeometry=1` in the URL
  turns this off.

And those are the triangles.

---

## 14. The other road: triangles on the CPU

**Code:** [`expandInstances()` in bimoblock-core.js](src/core/bimoblock-core.js#L816), [src/export/obj.js](src/export/obj.js)

There is one place the program builds real triangles itself instead of
letting the GPU do it: when **you export a model** (key **O** for one
specimen, **E** for everything on screen) as a `.obj` file for another 3D
program, and in the **tests**.

`expandInstances()` does on the CPU what the vertex shader does on the GPU,
except that it simply *skips* hidden faces instead of discarding them. For
each cube and each visible face it writes 4 vertices (position, gamut colour,
orbit colour, normal) and 6 indices (`v, v+1, v+2` and `v, v+2, v+3`).

> **Worked example.**
>
> ```
> 378 faces  →  1 512 vertices,  756 triangles,  77 112 bytes
> ```
>
> The same specimen is 450 bytes as an instance record, about 170 times
> smaller. That gap is why the showroom keeps records and not triangles.

This CPU path is also the project's **source of truth**. `npm test` builds a
fixed set of recipes, expands them into triangles, and compares a fingerprint
(hash) of the bytes against [test/golden.json](test/golden.json). If any
stage above changes its output by even one bit, the fingerprint changes and
the test fails. Another test
([test/instancing.test.js](test/instancing.test.js)) re-implements the vertex
shader in JavaScript and checks that it produces the same vertices and
colours as the CPU path. That keeps the two roads to triangles in agreement.

(On the GPU, a cube always *submits* 12 triangles and the hidden ones are
thrown away in the shader. On the CPU, hidden faces are never written. The
pictures are identical. The GPU just does a little throwaway vertex work in
exchange for not having to store triangles.)

---

## 15. Why it's built this way

- **The address is the identity.** Because stages 1–8 are pure functions of
  the address, nothing needs saving. A URL like `#7,-3,12.0,3` *is* a
  bookmark for a specimen, and anyone who opens it sees the same thing. The
  cache can throw specimens away freely because it can always rebuild them
  exactly.
- **The core has no graphics code in it.** Stages 1–8 import nothing from
  Three.js or the browser. The same file runs in a worker, on the main thread
  and in Node for the tests.
- **Symmetry by construction, not by checking.** Deciding once per orbit
  makes asymmetry impossible rather than unlikely, and it's faster as well.
- **Ship the recipe for the triangles, not the triangles.** The instance
  record plus instancing is what lets ~300 specimens sit in memory at once.
  In the browser at `#0,0,15.0,0`, the resident data for 294 specimens came
  to **0.66 MB**, against **27.8 MB** when every specimen was stored as baked
  triangles.

---

## 16. Try it yourself

**See the running example.** In a terminal in the project folder:

```sh
npm run serve
```

This starts a small web server that shares the project folder. Then open
**[http://localhost:8000/#0,0,15.0,0](http://localhost:8000/#0,0,15.0,0)**.
The focused specimen's inspector should show seed `75591b98ce6d116d` and
63/251 voxels.

**Watch the stages change it:**

| try | what it changes | stage |
|---|---|---|
| [`#0,0,15.0,1`](http://localhost:8000/#0,0,15.0,1) (generation 1) | every hash, so a whole new lattice | 1 |
| press **]** to step right one cell | archetype | 1, 4 |
| step up one cell (arrow up) | symmetry group | 1, 3 |
| the density slider | the cut | 6 |
| levels panel → `tower3` | `R = 27`, much finer cubes | 2, 7 |
| levels panel → two levels: radix 3 gap 0.5, then radix 5 gap 0 | cubes touch, so faces get hidden | 7, 8 |
| colour mode → orbit | shows the symmetry copies | 3, 10 |
| render mode → wire / centers | same data, different index list | 10 |

**Run the core by itself**, with no browser. From the project folder:

```sh
node --input-type=module -e "
import { Core } from './src/core/bimoblock-core.js';
const recipe = { sym:0, arch:0, field:1, lift:0, density:0.25, seed:0x75591b98ce6d116dn };
const levels = [{ radix:3, gap:0.30 }, { radix:3, gap:0.06 }];
const b = Core.buildBlock(recipe, levels);
console.log('envelope cells:', b.envelopeCells, ' kept:', b.filled, ' visible faces:', b.instances.quads);
"
```

It prints `envelope cells: 251  kept: 63  visible faces: 378`. Change `sym`
to 9 or `density` to 0.5 and run it again.

**Peek at live numbers.** In the browser, open the developer console (⌥⌘J
in Chrome on a Mac) and type `showroomPerformance()`. It shows how many
specimens are built, how many bytes they hold, and how many triangles the
last frame drew.

---

## 17. Map of the code

| stage | what | file | function |
|---|---|---|---|
| 1 | address → recipe | [src/lattice/recipe.js](src/lattice/recipe.js) | `cellParams`, `cellRecipe`, `hash32` |
| 2 | grid size, digits, `s` coords | [src/core/bimoblock-core.js](src/core/bimoblock-core.js) | `levelResolution`, `decomposeDigits`, `foldedAxis` |
| 3 | symmetry, orbits | 〃 | `GROUPS`, orbit loop in `buildBlock`, `tierFolder` |
| 4 | silhouette | 〃 | `envelope` |
| 5 | score | 〃 | `field`, `tierField`, `seedWords` |
| 6 | keep the top slice | 〃 | end of `buildBlock`, `quickSelect` |
| 7 | physical positions | 〃 | `tierAxisLayout` |
| 8 | face masks, instance record | 〃 | `instanceArrays` |
| 9 | workers, cache | [src/lattice/generation.js](src/lattice/generation.js), [src/core/worker.js](src/core/worker.js), [src/scene/virtualiser.js](src/scene/virtualiser.js) | `GenerationPool`, `Virtualiser` |
| 10 | GPU buffers, vertex shader | [src/scene/instancing.js](src/scene/instancing.js) | `InstancedSpecimen`, `patchInstancing` |
| 11 | world placement, LOD | [src/scene/layout.js](src/scene/layout.js) | `layout` |
| 14 | CPU triangles, export | [src/core/bimoblock-core.js](src/core/bimoblock-core.js), [src/export/obj.js](src/export/obj.js) | `expandInstances`, `exportSpecimenOBJ` |
| — | shared data shapes | [src/types.js](src/types.js) | `Recipe`, `Level`, `InstanceArrays`, `BlockData` |
