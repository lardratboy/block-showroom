/* Browser test for marking (issue #8): double click toggles a cell's mark,
   and the sheet export then holds exactly the marked specimens — including
   one that is no longer resident and has to be built on the spot.
   The download is intercepted in the page (URL.createObjectURL is stubbed to
   keep the Blob), so nothing is written to disk. */
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function click(session, x, y){
  for (const type of ['mousePressed', 'mouseReleased'])
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
}
async function key(session, k){
  for (const type of ['keyDown', 'keyUp'])
    await session.send('Input.dispatchKeyEvent', { type, key: k, text: type === 'keyDown' ? k : undefined });
}
const toast = session => session.evaluate(`document.getElementById('toast').innerText`);

/* Press E and return { name, text } of the OBJ it would have downloaded. */
async function exportSheet(session){
  await session.evaluate(`(() => {
    window.__download = null;
    URL.createObjectURL = blob => { window.__blob = blob; return 'blob:intercepted'; };
    HTMLAnchorElement.prototype.click = function(){ window.__download = this.download; };
  })()`);
  await key(session, 'e');
  await session.waitFor(`window.__download`, { label: 'sheet export' });
  return session.evaluate(`window.__blob.text().then(text => ({ name: window.__download, text }))`);
}

test('double click marks a cell; the sheet export holds just the marked ones', { skip }, async () => {
  const s = browser.session;
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  const r = await loadShowroom(s, `${server.origin}/#0,0,15.0,0`);
  assert.deepEqual(r.errors, []);

  // A single click only focuses.
  await click(s, 600, 400);
  const focused = await s.evaluate(`document.getElementById('coord').innerText`);
  const [i, j] = focused.split(',').map(n => parseInt(n, 10));
  await sleep(500);                       // past the double-click window
  assert.doesNotMatch(await toast(s), /marked/);

  // A second click inside the window marks.
  await click(s, 600, 400);
  await click(s, 600, 400);
  assert.match(await toast(s), new RegExp(`^marked ${i}, ${j} · 1 marked`));

  let obj = await exportSheet(s);
  assert.match(obj.name, /^bimoblock_marked_/);
  assert.match(obj.text, /marked specimens \(1\)/);
  const objects = t => [...t.matchAll(/^o (cell_-?\d+_-?\d+)_/gm)].map(m => m[1]);
  assert.deepEqual(objects(obj.text), [`cell_${i}_${j}`]);
  assert.ok(/^v /m.test(obj.text) && /^f /m.test(obj.text), 'geometry written');
  const resident = obj.text.slice(obj.text.indexOf('\no '));

  // Warp far away and re-mint (G) to empty the cache; the mark survives and
  // its specimen is rebuilt on the spot for the export.
  await key(s, 'w');
  await key(s, 'g');
  // G flushed the cache, and the marked cell is ~1000 cells from the warp
  // target, so nothing re-mints it: the export has to build it itself.
  obj = await exportSheet(s);
  assert.deepEqual(objects(obj.text), [`cell_${i}_${j}`]);
  assert.ok(/^f /m.test(obj.text), 'non-resident mark still exported with geometry');
  assert.notEqual(obj.text.slice(obj.text.indexOf('\no ')), resident, 'generation changed, so did the specimen');

  // X clears; with nothing marked the export falls back to the visible sheet.
  await key(s, 'x');
  assert.match(await toast(s), /^cleared 1 mark/);
  obj = await exportSheet(s);
  assert.match(obj.name, /^bimoblock_sheet_/);
  assert.match(obj.text, /visible lattice sheet/);

  assert.deepEqual(await s.evaluate(`window.__errors`), []);
});

test('double clicking a marked cell unmarks it', { skip }, async () => {
  const s = browser.session;
  // The query string forces a real reload (a hash-only change would not).
  await loadShowroom(s, `${server.origin}/?reload#0,0,15.0,0`);
  for (let n = 0; n < 2; n++){ await click(s, 600, 400); await click(s, 600, 400); await sleep(500); }
  assert.match(await toast(s), /^unmarked -?\d+, -?\d+ · 0 marked/);
});

/* A marked sheet is repacked into the squarest grid that holds it: four
   marks scattered over the view come out as a 2 × 2, in marking order, one
   lattice pitch (CFG.CELL = 2.6) apart and centred on the origin. */
test('the marked sheet lays its specimens out as a square grid', { skip }, async () => {
  const s = browser.session;
  await loadShowroom(s, `${server.origin}/?grid#0,0,15.0,0`);
  const marked = [];
  for (const [x, y] of [[400, 300], [800, 300], [400, 500], [800, 500]]){
    await click(s, x, y); await click(s, x, y); await sleep(500);
    const m = (await toast(s)).match(/^marked (-?\d+), (-?\d+)/);
    assert.ok(m, 'each click lands on a fresh cell');
    marked.push(`cell_${m[1]}_${m[2]}`);
  }

  const obj = await exportSheet(s);
  assert.match(obj.text, /marked specimens \(4\) in a 2 × 2 grid/);
  const blocks = obj.text.split(/^o /m).slice(1).map(b => {
    const xs = [], zs = [];
    for (const m of b.matchAll(/^v (\S+) \S+ (\S+)/gm)){ xs.push(+m[1]); zs.push(+m[2]); }
    const mid = a => (Math.min(...a) + Math.max(...a)) / 2;
    return { name: b.match(/^cell_-?\d+_-?\d+/)[0], x: mid(xs), z: mid(zs) };
  });
  assert.deepEqual(blocks.map(b => b.name), marked, 'marking order kept');
  const slots = [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]];
  blocks.forEach((b, n) => {
    assert.ok(Math.abs(b.x - slots[n][0]) < 0.6 && Math.abs(b.z - slots[n][1]) < 0.6,
      `${b.name} at ${b.x.toFixed(2)}, ${b.z.toFixed(2)} should sit in slot ${slots[n]}`);
  });
  assert.deepEqual(await s.evaluate(`window.__errors`), []);
});
