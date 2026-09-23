# Manual smoke check (~3 minutes)

Run `npm run serve`, open http://localhost:8000/, then:

1. Lattice appears; specimens populate outward from the centre.
2. Drag to pan; wheel to zoom; shift-drag to orbit. Movement has inertia.
3. Click a cell → focus ring moves, inspector (bottom-left) updates.
4. `[` and `]` step focus; arrow keys step the camera.
5. Keys: A align, B bloom, L labels, K key, G shuffle, H origin.
6. Type `3, -2` in the goto box + Enter → camera glides there.
7. Change the X/Y axis dropdowns → lattice re-mints.
8. Levels panel: click `tower [3,3,3]` preset → specimens rebuild at R=27.
9. Reload the page → same address and specimen (permalink hash works).
10. Append `?workers=0` to the URL → same specimens, just slower to appear.
11. Console: `showroomPerformance()` returns an object with `installed > 0`.
    (Steps 1, 9, 10 and 11 are also covered by `npm run test:browser`.)
12. `O` downloads a `.obj`; `E` downloads a sheet `.obj`.
13. `display:` dropdown: wireframe → box edges only (no diagonals);
    vertices → a point at every mesh corner; box centers → one point per
    voxel; solid → back to shaded boxes. Switching is instant (no re-mint)
    and the `color:` dropdown still recolours every mode.
14. Levels panel: set a zero innermost gap (e.g. radices `3, 5` with gaps
    `0.50, 0.00`) → specimens read as solid blocks with no seams, and as one
    rises into place while still translucent you should not see the inside of
    it: the faces between touching cubes are still culled.
15. Console: `showroomPerformance().residentBytes` — a few hundred KB for a
    few hundred specimens on the default preset, not tens of MB. Specimens
    are instanced, so a mode switch should not change it.
