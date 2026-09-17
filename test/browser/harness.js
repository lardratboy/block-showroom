/* Browser test harness with no dependencies: a static server for the repo
   root, headless Chrome launched from its installed binary, and a thin
   DevTools-protocol client over Node 22's built-in fetch + WebSocket.
   Playwright would do the same job at the cost of node_modules and a
   browser download; this keeps `npm run test:browser` install-free. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CHROME_CANDIDATES = [
  process.env.SHOWROOM_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).filter(p => process.env.SHOWROOM_CHROME !== '0');

/* Path to a Chrome/Chromium binary, or null. SHOWROOM_CHROME overrides the
   search; SHOWROOM_CHROME=0 forces the browser tests to skip. */
export function findChrome(){
  return CHROME_CANDIDATES.find(p => existsSync(p)) || null;
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };

/* Serve `root` on an ephemeral port. ES modules need the text/javascript
   type; a wrong type is a silent blank page, so the map above is not optional. */
export function serveStatic(root = REPO_ROOT){
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)){ res.writeHead(403); res.end(); return; }
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) });
  }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* One DevTools session on one page target. */
class Session {
  constructor(ws){ this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener('message', ({data}) => {
      const msg = JSON.parse(data);
      if (msg.id && this.waiting.has(msg.id)){
        const { resolve, reject } = this.waiting.get(msg.id); this.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}){
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /* Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression){
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  /* Poll `expression` until it is truthy; returns its value. */
  async waitFor(expression, { timeout = 30000, interval = 250, label = expression } = {}){
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline){
      const v = await this.evaluate(expression);
      if (v) return v;
      await sleep(interval);
    }
    throw new Error(`timed out after ${timeout} ms waiting for: ${label}`);
  }
}

/* Launch headless Chrome with software WebGL and connect to its first page. */
export async function launchChrome(chrome){
  const userDataDir = mkdtempSync(join(tmpdir(), 'showroom-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,800',
    '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Chrome prints "DevTools listening on ws://..." to stderr once the port is chosen.
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    proc.on('exit', code => reject(new Error(`Chrome exited (${code}) before DevTools came up:\n${buf}`)));
    setTimeout(() => reject(new Error('Chrome did not start within 15 s')), 15000);
  });
  const httpBase = wsUrl.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
  let page;
  for (let i = 0; i < 40 && !page; i++){
    page = (await (await fetch(`${httpBase}/json/list`)).json()).find(t => t.type === 'page');
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('no page target in Chrome');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools websocket failed')); });
  const session = new Session(ws);
  await session.send('Page.enable'); await session.send('Runtime.enable');
  const close = async () => {
    try { ws.close(); } catch {}
    proc.kill('SIGTERM');
    await new Promise(r => { proc.on('exit', r); setTimeout(r, 3000); });
    rmSync(userDataDir, { recursive: true, force: true });
  };
  return { session, close };
}

/* Navigate to a showroom URL and wait until the focused specimen is built
   and inspected: `installed > 0`, nothing visible still `missing`, and the
   inspector shows its aut-order line. Returns a snapshot for assertions. */
export async function loadShowroom(session, url, { timeout = 45000 } = {}){
  await session.send('Page.navigate', { url });
  await session.waitFor(`typeof showroomPerformance === 'function'`, { timeout: 15000, label: 'main.js to boot' });
  const errors = await session.evaluate(`(() => { window.__errors = []; addEventListener('error', e => __errors.push(String(e.message))); return true; })()`);
  await session.waitFor(`(() => {
    const perf = showroomPerformance();
    const text = document.getElementById('inspect').innerText;
    return perf.installed > 0 && perf.missing === 0 && /order\\s+\\d+\\s+(of|rigid)/i.test(text);
  })()`, { timeout, label: 'specimens installed and inspector populated' });
  return session.evaluate(`({
    perf: showroomPerformance(),
    inspector: document.getElementById('inspect').innerText,
    coord: document.getElementById('coord').innerText,
    status: document.getElementById('status').innerText,
    hash: location.hash,
    errors: window.__errors,
  })`);
}
