/* Browser-level test (Phase 5): load a permalink in headless Chrome, wait for
   showroomPerformance().installed > 0, assert the inspector text.
   Runs with `npm run test:browser`; skipped when no Chrome is installed.
   The expected values are the reference values recorded in refactorplan.md
   (Phase 2/3 verification) — a specimen at a fixed address is deterministic,
   so they are as much a contract as test/golden.json. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, serveStatic, launchChrome, loadShowroom } from './harness.js';

const chrome = findChrome();
const skip = chrome ? false : 'no Chrome found (SHOWROOM_CHROME=/path/to/chrome to point at one, =0 to skip)';

let server, browser;
before(async () => {
  if (skip) return;
  server = await serveStatic();
  browser = await launchChrome(chrome);
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const nows = s => s.replace(/\s+/g, ' ');

test('#0,0,15.0,0 builds the origin specimen (workers)', { skip }, async () => {
  const r = await loadShowroom(browser.session, `${server.origin}/#0,0,15.0,0`);
  assert.deepEqual(r.errors, [], 'uncaught page errors');
  assert.ok(r.perf.installed > 0, `installed=${r.perf.installed}`);
  assert.equal(r.perf.missing, 0);
  assert.equal(r.perf.mode, 'workers');
  assert.equal(r.coord, '0, 0');
  const t = nows(r.inspector);
  assert.match(t, /#ce6d116d/i, 'seed');
  assert.match(t, /63\s*\/\s*251/, 'filled / envelope voxels');
  assert.match(t, /order\s+1\s+of/i, 'aut-order');
});

test('?workers=0 compatibility path gives the same specimen', { skip }, async () => {
  const r = await loadShowroom(browser.session, `${server.origin}/?workers=0#7,-3,12.0,3,7.-3.4`, { timeout: 90000 });
  assert.deepEqual(r.errors, [], 'uncaught page errors');
  assert.ok(r.perf.installed > 0, `installed=${r.perf.installed}`);
  assert.equal(r.perf.mode, 'compatibility');
  assert.equal(r.perf.workers, 0);
  assert.equal(r.coord, '7, -3');
  const t = nows(r.inspector);
  assert.match(t, /#77ad20e6/i, 'seed');
  assert.match(t, /49\s*\/\s*197/, 'filled / envelope voxels');
  assert.match(t, /order\s+6\s+of/i, 'aut-order');
  assert.match(t, /ring\s*0/i, 'pinned cell is ring 0 of its district');
});
