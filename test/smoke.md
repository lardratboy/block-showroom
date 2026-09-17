# Manual smoke check (~3 minutes)

Run `npm run serve`, open http://localhost:8000/ (Phase 0: open
`block-showroom.html` directly instead), then:

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
12. `O` downloads a `.obj`; `E` downloads a sheet `.obj`.
