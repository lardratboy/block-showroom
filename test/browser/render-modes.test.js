/* What the page actually draws, in every render mode and every colouring.

   Specimens are instanced: a shared cube template plus one centre per voxel,
   with the gamut ramp, the orbit hue ramp and face occlusion all resolved in
   the vertex shader (src/scene/instancing.js). A mistake there does not throw
   — three logs the failed compile and carries on drawing nothing — so the
   only honest check is to look at the pixels.

   These are invariants of one build rather than a comparison against a stored
   image: every mode must draw, and the three colourings must be visibly
   different from each other in every mode. The thresholds sit roughly a
   factor of two inside what the modes actually differ by, so ordinary
   rendering jitter cannot trip them but a colouring that silently fell back
   to gamut, or a mask that hid everything, would. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, serveStatic, launchChrome } from './harness.js';
import { decodePNG, imageStats, histL1 } from './png.js';

const chrome = findChrome();
const skip = chrome ? false : 'no Chrome found (SHOWROOM_CHROME=/path/to/chrome to point at one, =0 to skip)';

const RENDER = ['solid', 'wire', 'points', 'centers'];
const COLOUR = ['gamut', 'chiral', 'orbit'];
const FRAMES = 3;          // averaged: the idle bob cannot be switched off

/* Warnings the test itself provokes, or that the page has always emitted. */
const BENIGN = [/GPU stall due to ReadPixels/, /Failed to load resource.*404/];

let server, browser, shots = {}, logs = [];

before(async () => {
  if (skip) return;
  server = await serveStatic();
  browser = await launchChrome(chrome);
  const session = browser.session;

  await session.send('Log.enable');
  session.ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    const entry = m.method === 'Log.entryAdded' ? m.params.entry : null;
    if (entry && (entry.level === 'error' || entry.level === 'warning'))
      logs.push(`${entry.level}: ${entry.text}`.slice(0, 300));
  });

  await session.send('Page.navigate', { url: `${server.origin}/#0,0,15.0,0` });
  await session.waitFor(`typeof showroomPerformance === 'function'`, { timeout: 20000, label: 'main.js to boot' });
  await session.waitFor(`(() => { const p = showroomPerformance(); return p.installed > 0 && p.missing === 0; })()`,
    { timeout: 90000, label: 'specimens installed' });

  // Freeze what can be frozen, so the frames being averaged differ as little
  // as possible: no idle spin, one shared orientation.
  await session.evaluate(`(() => {
    const spin = document.getElementById('spin');
    spin.value = 0; spin.dispatchEvent(new Event('input'));
    document.getElementById('align').click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 1200));

  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (const render of RENDER) for (const colour of COLOUR){
    await session.evaluate(`(() => {
      const r = document.getElementById('renderMode'), c = document.getElementById('colorMode');
      r.value = ${JSON.stringify(render)}; r.dispatchEvent(new Event('change'));
      c.value = ${JSON.stringify(colour)}; c.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const frames = [];
    for (let f = 0; f < FRAMES; f++){
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      frames.push(imageStats(decodePNG(Buffer.from(data, 'base64'))));
      await new Promise(r => setTimeout(r, 80));
    }
    shots[`${render}/${colour}`] = {
      litFraction: mean(frames.map(f => f.litFraction)),
      litMean: [0,1,2].map(i => mean(frames.map(f => f.litMean[i]))),
      hist: Array.from({ length: 64 }, (_, i) => mean(frames.map(f => f.hist[i])))
    };
  }
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('every render mode draws something', { skip }, () => {
  for (const render of RENDER) for (const colour of COLOUR){
    const s = shots[`${render}/${colour}`];
    assert.ok(s.litFraction > 0.05,
      `${render}/${colour} lit only ${(s.litFraction * 100).toFixed(2)}% of the view`);
  }
});

test('the point modes are sparser than the surface modes', { skip }, () => {
  // A cube centre is one dot where a solid face is a filled quad; if the
  // centres cloud ever started drawing cubes this is what would notice.
  for (const colour of COLOUR){
    assert.ok(shots[`centers/${colour}`].litFraction < shots[`solid/${colour}`].litFraction,
      `centers/${colour} is not sparser than solid`);
    assert.ok(shots[`centers/${colour}`].litFraction < shots[`points/${colour}`].litFraction,
      `one point per voxel should be sparser than one per mesh corner (${colour})`);
  }
});

test('each colouring is visibly its own in every render mode', { skip }, () => {
  // Measured separation is 0.06-0.50 here; half the smallest is the floor.
  const FLOOR = 0.03;
  for (const render of RENDER){
    const g = shots[`${render}/gamut`].hist;
    for (const other of ['chiral', 'orbit']){
      const d = histL1(g, shots[`${render}/${other}`].hist);
      assert.ok(d > FLOOR,
        `${render}: ${other} is indistinguishable from gamut (histogram L1 ${d.toFixed(4)})`);
    }
    const d = histL1(shots[`${render}/chiral`].hist, shots[`${render}/orbit`].hist);
    assert.ok(d > FLOOR, `${render}: orbit and chiral are indistinguishable (L1 ${d.toFixed(4)})`);
  }
});

test('the gamut colouring still spans the local bounding box', { skip }, () => {
  // R = x + 0.5, G = y + 0.5, B = z + 0.5 over a roughly symmetric field of
  // specimens, so no channel may dominate: a shader that dropped a component
  // or handed out a flat colour would skew this hard.
  const [r, g, b] = shots['solid/gamut'].litMean;
  for (const [name, v] of [['red', r], ['green', g], ['blue', b]])
    assert.ok(v > 40 && v < 200, `gamut ${name} channel averages ${v.toFixed(1)}, outside 40..200`);
  assert.ok(Math.max(r, g, b) / Math.min(r, g, b) < 2.2,
    `gamut channels are lopsided: ${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)}`);
});

test('nothing logged a shader or WebGL error', { skip }, () => {
  const real = logs.filter(l => !BENIGN.some(re => re.test(l)));
  assert.deepEqual(real, [], 'unexpected console errors/warnings');
});
