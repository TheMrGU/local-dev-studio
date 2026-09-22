// lib/mirror.js — mirror everything a page fetches at runtime into a capture.
//
// SingleFile serializes the DOM, so a site that draws itself with code — a
// Vite + three.js experience whose entry module dynamically imports the real
// app, which then streams meshes, compressed textures, decoder .wasm, shaders,
// audio and web workers — captures as an empty <div> and one script. Guessing
// those URLs out of the script text (lib/modelfix.js) only reaches the first
// hop: hashed chunk names, worker files and anything fetched by code that was
// itself fetched are invisible to a scan.
//
// So this stops guessing. It loads each captured page in an offscreen Electron
// window with the DevTools protocol's Network domain recording, nudges the page
// the way a visitor would (wheel, scroll, mouse), and keeps the body of every
// response the page pulled in — from the main thread and its workers alike.
// Same-origin files land at their real path under the site folder, so relative
// imports inside mirrored chunks resolve untouched; third-party files land under
// assets/remote/<host>/. Then every mirrored URL is rewritten to its local path
// across the saved pages, styles and scripts, and an extracted copy of a script
// the mirror also saw (SingleFile inlines the entry module; extraction writes it
// out under a hash name, where its "./chunk.js" imports can never resolve) is
// swapped for the file at its original path.
//
// The browser-driving half is injectable (`opts.record`) so the file-writing
// and rewriting half runs under plain Node in the test suite.
const fs = require('fs');
const path = require('path');
const { download } = require('./videofix');
const { sha1 } = require('./extract');
const { safeSegments, siteOrigins } = require('./modelfix');

const RE_PAGE_URL = /^\s*<!--[^>]*?\burl:\s*(https?:\/\/\S+)/i;
// Files whose bytes are text the rewrite pass may touch. Binary payloads are
// written verbatim — a URL-shaped run inside a .glb is data, not a reference.
const RE_TEXT_MIME = /^(?:text\/|application\/(?:(?:x-)?javascript|json|xml|xhtml\+xml|manifest\+json|x-www-form-urlencoded)|image\/svg\+xml)/i;
const RE_TEXT_EXT = /\.(?:js|mjs|cjs|css|json|html?|xml|svg|txt|map|glsl|frag|vert|wgsl)$/i;

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PAGES = 25;

// Time budgets. The first page gets the most: a 3D site front-loads its whole
// world there. Later pages mostly share chunks already on disk.
const FIRST_PAGE_MS = 75000;
const NEXT_PAGE_MS = 30000;
const IDLE_MS = 2500;        // no network activity for this long = settled
const SETTLE_MAX_MS = 25000; // give up waiting for the first settle after this
const DRIVE_MS = 18000;      // how long to scroll/wheel/mouse the page
const FINAL_IDLE_MAX_MS = 12000;
const PHONE_PASS_MS = 45000; // the phone pass only needs what the desktop pass did not fetch

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A renderer pegged by a heavy scene can leave a protocol reply or a script
// evaluation hanging; nothing in the recorder may wait on one without a limit.
const withTimeout = (promise, ms, fallback = null) =>
  Promise.race([promise, sleep(ms).then(() => fallback)]);

const MOBILE_UA = chrome =>
  `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`;
const DESKTOP_UA = chrome =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;

const isOwnOrigin = (origin, origins) =>
  typeof origins === 'string' ? origin === origins : origins.has(origin);

/** Where a fetched URL lives inside the site folder: same-site at its own
 *  path, anything else under assets/remote/<host>/. Null for URLs that can't
 *  be a file (the document root, a directory, a hostile path). `origins` is
 *  one origin string or the Set from siteOrigins. */
function localSegments(url, origins) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.pathname === '/' || parsed.pathname.endsWith('/')) return null;
  const rest = safeSegments(parsed.pathname);
  if (!rest) return null;
  return isOwnOrigin(parsed.origin, origins)
    ? rest
    : ['assets', 'remote', parsed.hostname.replace(/[^\w.-]/g, '_'), ...rest];
}

const rootRelative = segments => '/' + segments.map(encodeURIComponent).join('/');

/** A cookies export — Netscape cookies.txt or a JSON array (browser extension
 *  exports) — as the objects Electron's session.cookies.set accepts. */
function parseCookiesFile(text) {
  const out = [];
  const push = c => {
    if (!c.name || !c.domain) return;
    const host = c.domain.replace(/^\./, '');
    const p = c.path && c.path.startsWith('/') ? c.path : '/';
    out.push({
      url: `${c.secure ? 'https' : 'http'}://${host}${p}`,
      name: String(c.name), value: String(c.value == null ? '' : c.value),
      domain: c.domain, path: p, secure: !!c.secure, httpOnly: !!c.httpOnly,
      ...(c.expirationDate > 0 ? { expirationDate: Number(c.expirationDate) } : {}),
    });
  };
  const raw = String(text || '').trim();
  if (raw.startsWith('[')) {
    let list;
    try { list = JSON.parse(raw); } catch { return out; }
    for (const c of Array.isArray(list) ? list : []) {
      if (c && typeof c === 'object') push({ ...c, expirationDate: c.expirationDate || c.expires });
    }
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    // "#HttpOnly_" is the curl/wget convention for httpOnly cookies — a comment
    // that isn't one.
    const httpOnly = line.startsWith('#HttpOnly_');
    const body = httpOnly ? line.slice('#HttpOnly_'.length) : line;
    if (!body.trim() || body.startsWith('#')) continue;
    const f = body.split('\t');
    if (f.length < 7) continue;
    push({
      domain: f[0], path: f[2], secure: /^true$/i.test(f[3]), expirationDate: Number(f[4]) || 0,
      name: f[5], value: f[6], httpOnly,
    });
  }
  return out;
}

/** Record every response one page loads. Electron only — the offscreen window
 *  is Chromium with WebGL, so a 3D site's loader runs for real. Each finished
 *  response goes to `sink` as soon as its body is available; the return value
 *  names the URLs whose bodies the browser had already dropped. */
async function recordPage(pageUrl, { sink, onDocument = () => {}, budget, mobile, headers = [], cookies = [], signal, log = () => {} }) {
  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition(`mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const cookie of cookies) await ses.cookies.set(cookie).catch(() => {});

  const win = new BrowserWindow({
    show: false,
    width: mobile ? 390 : 1440,
    height: mobile ? 844 : 900,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      session: ses,
    },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setFrameRate(10);
  const dbg = wc.debugger;

  const pending = new Map(); // requestId -> { url, type, mime, status, sessionId }
  const failed = [];
  const problems = [];
  let requests = 0;
  let seen = 0;
  let inflight = 0;
  let lastActivity = Date.now();
  let bodyWork = Promise.resolve();
  let documentUrl = '';
  let documentHtml = null; // null: not seen; '': seen, body not (yet) read

  const wanted = p => p && p.status === 200
    && /^https?:/.test(p.url)
    && !/^(Document|WebSocket|EventSource|Ping|CSPViolationReport|Preflight)$/.test(p.type || '');

  // The page's own events arrive with an empty session id, and Electron refuses
  // an empty one on the way back — only a worker's id is ever passed along.
  const send = (method, params, sessionId) => withTimeout(
    dbg.sendCommand(method, params || {}, sessionId || undefined).catch(err => {
      if (problems.length < 5) problems.push(`${method}: ${err && err.message ? err.message : err}`);
      return null;
    }), 10000, null);
  // DevTools' own buffer sizes; anything a scene streams beyond them comes back
  // through the plain-download fallback.
  const enableNetwork = sessionId => send('Network.enable', {
    maxResourceBufferSize: 100 * 1000 * 1000, maxTotalBufferSize: 200 * 1000 * 1000,
  }, sessionId);

  dbg.on('message', (_event, method, params, sessionId) => {
    switch (method) {
      case 'Target.attachedToTarget': {
        // Workers fetch on their own session (decoder .wasm, texture streams).
        const sid = params.sessionId;
        enableNetwork(sid).then(() => params.waitingForDebugger && send('Runtime.runIfWaitingForDebugger', {}, sid));
        break;
      }
      case 'Network.requestWillBeSent':
        requests++;
        inflight++;
        lastActivity = Date.now();
        pending.set(params.requestId, { url: params.request.url, type: params.type, sessionId });
        break;
      case 'Network.responseReceived': {
        const p = pending.get(params.requestId);
        if (!p) break;
        p.url = params.response.url || p.url;
        p.mime = params.response.mimeType;
        p.status = params.response.status;
        p.type = params.type || p.type;
        // The top document's final URL, after every redirect: the origin the
        // page's own code will build its fetches from. It always arrives
        // before any subresource, and bodies are only handed over later.
        if (!sessionId && p.type === 'Document' && !documentUrl && /^https?:/.test(p.url)) {
          documentUrl = p.url;
          try { onDocument(documentUrl); } catch { /* caller's problem */ }
        }
        break;
      }
      case 'Network.loadingFinished': {
        inflight = Math.max(0, inflight - 1);
        lastActivity = Date.now();
        const p = pending.get(params.requestId);
        pending.delete(params.requestId);
        if (p && !sessionId && p.type === 'Document' && p.status === 200 && p.url === documentUrl && documentHtml === null) {
          // The document as the server sent it — before any script touched
          // it. For a page that builds itself, this is the only version that
          // can run again.
          documentHtml = '';
          bodyWork = bodyWork.then(async () => {
            const res = await withTimeout(
              dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).catch(() => null),
              20000, null);
            if (res && typeof res.body === 'string' && res.body) {
              documentHtml = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
            }
          });
          break;
        }
        if (!wanted(p)) break;
        seen++;
        // Bodies are read as they finish: the browser's buffer evicts old ones.
        bodyWork = bodyWork.then(async () => {
          const res = await withTimeout(
            dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }, p.sessionId || undefined).catch(() => null),
            20000, null);
          // A worker's fetch comes back with an empty body rather than an
          // error — those go to the download fallback like a dropped body.
          if (!res || typeof res.body !== 'string' || res.body === '') { failed.push(p.url); return; }
          try {
            sink({ url: p.url, mime: p.mime, status: p.status, body: Buffer.from(res.body, res.base64Encoded ? 'base64' : 'utf8') });
          } catch (err) {
            if (problems.length < 5) problems.push(`sink ${p.url}: ${err.message}`);
          }
        });
        break;
      }
      case 'Network.loadingFailed':
        inflight = Math.max(0, inflight - 1);
        lastActivity = Date.now();
        pending.delete(params.requestId);
        break;
      default:
    }
  });

  const started = Date.now();
  const left = () => budget - (Date.now() - started);
  const canceled = () => signal && signal.aborted;
  const settled = () => inflight === 0 && Date.now() - lastActivity >= IDLE_MS;
  const waitIdle = async max => {
    const until = Date.now() + Math.min(max, Math.max(0, left()));
    while (Date.now() < until && !canceled() && !settled()) await sleep(200);
  };

  try {
    // A window that has never navigated has no frame for the Network domain to
    // bind to: Network.enable then never answers and the recorder sits on it
    // for its whole budget. One about:blank first gives it something to hold.
    await withTimeout(wc.loadURL('about:blank').catch(() => null), 5000, null);
    dbg.attach('1.3');
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await enableNetwork();
    const chrome = process.versions.chrome || '131.0.0.0';
    await send('Network.setUserAgentOverride', { userAgent: mobile ? MOBILE_UA(chrome) : DESKTOP_UA(chrome) });
    if (mobile) {
      // 2×, not a phone's 3×: the offscreen renderer may be on software GL, and
      // pixels are what it pays for. Asset choice rarely hinges on 2 vs 3.
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    const extra = {};
    for (const h of headers) {
      const m = /^([\w-]+):\s*(.*)$/.exec(String(h));
      if (m) extra[m[1]] = m[2];
    }
    if (Object.keys(extra).length) await send('Network.setExtraHTTPHeaders', { headers: extra });

    wc.loadURL(pageUrl).catch(() => {});
    await waitIdle(SETTLE_MAX_MS);
    if (canceled()) throw Object.assign(new Error('Mirror canceled.'), { canceled: true });
    if (!documentUrl) {
      // A document served from cache or a client-side redirect never shows up
      // as a Document response; the window still knows where it ended up.
      const here = wc.getURL();
      if (/^https?:/.test(here || '')) {
        documentUrl = here;
        try { onDocument(documentUrl); } catch { /* caller's problem */ }
      }
    }

    // Drive the page: wheel for virtual scrollers (overflow:hidden 3D sites),
    // scrollBy for ordinary lazy loading, mouse movement for hover-triggered
    // loads. Clicks are off the table — they navigate away.
    const w = mobile ? 390 : 1440;
    const h = mobile ? 844 : 900;
    const driveUntil = Date.now() + Math.min(DRIVE_MS, Math.max(0, left() - FINAL_IDLE_MAX_MS));
    let tick = 0;
    while (Date.now() < driveUntil && !canceled()) {
      const x = w / 2 + Math.sin(tick / 7) * w * 0.3;
      const y = h / 2 + Math.cos(tick / 5) * h * 0.3;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 160 });
      if (tick % 6 === 0) {
        await withTimeout(
          wc.executeJavaScript('window.scrollBy(0, Math.round(window.innerHeight * 0.7))', true).catch(() => null),
          2000, null);
      }
      if (tick % 20 === 19) {
        // Some experiences need a key to advance (space/enter on a "press to
        // start" loader). Space also scrolls a normal page.
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      }
      tick++;
      await sleep(140);
    }
    await waitIdle(FINAL_IDLE_MAX_MS);
    if (canceled()) throw Object.assign(new Error('Mirror canceled.'), { canceled: true });
    await withTimeout(bodyWork, 30000);
    log(`  ${seen} response(s) kept of ${requests} request(s) from ${pageUrl}${mobile ? ' (phone)' : ''}`);
    for (const problem of problems) log(`  note: ${problem}`);
    return { requests: seen, failed, documentUrl, documentHtml: documentHtml || '' };
  } finally {
    try { if (dbg.isAttached()) dbg.detach(); } catch { /* window gone */ }
    if (!win.isDestroyed()) win.destroy();
    ses.clearCache().catch(() => {});
  }
}

/** The pages of an extracted capture with the live URL each was saved from
 *  (SingleFile's header comment), entry page first. */
function pageFiles(dir, siteUrl, entry) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== '_index.html').sort();
  if (entry && files.includes(entry)) {
    files.splice(files.indexOf(entry), 1);
    files.unshift(entry);
  }
  const pages = [];
  const seen = new Set();
  for (const f of files) {
    let head = '';
    try { head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 2000); } catch { continue; }
    const url = (RE_PAGE_URL.exec(head) || [])[1] || (f === files[0] ? siteUrl : null);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    pages.push({ file: path.join(dir, f), url });
  }
  if (!pages.length) pages.push({ file: null, url: siteUrl });
  return pages.slice(0, MAX_PAGES);
}

function pageUrls(dir, siteUrl, entry) {
  return pageFiles(dir, siteUrl, entry).map(p => p.url);
}

const RE_DROP = /<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;

/** True when the server's document is an app shell — a body with (nearly)
 *  nothing in it, everything to be built by scripts. SingleFile saves what
 *  those scripts built; hosting that and running the scripts again puts a
 *  second app on top of the first (two `#app`s, a phone *and* a desktop class
 *  on `<html>`), and the scroll-driven experience never wires up. The shell is
 *  the version that can run again. Server-rendered pages keep their snapshot:
 *  their scripts hydrate what is already there. */
function builtByScripts(originalHtml) {
  if (!originalHtml) return false;
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(originalHtml);
  const body = (bodyMatch ? bodyMatch[1] : originalHtml.replace(/^[\s\S]*?<\/head\s*>/i, '')).replace(RE_DROP, '');
  const tags = (body.match(/<[a-z][^\s>/]*/gi) || []).length;
  const text = body.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return tags <= 8 && text.length < 60;
}

const RE_ATTR_URL = /(\s(?:src|href|poster|data-src|data-href)\s*=\s*)(["']?)([^"'\s>]+)\2/gi;
const RE_SRCSET = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;

/** The original document with every relative reference resolved against the
 *  page's live URL: same-site ones become root-relative (the file sits at its
 *  real path under the site folder), others become absolute. Root-relative
 *  and absolute references are left alone — the exact-URL rewrite pass points
 *  mirrored absolute ones at their local copies. */
function absolutizeDocument(html, pageUrl, origins) {
  const resolve = raw => {
    const v = raw.trim();
    if (!v || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(v)) return v.startsWith('//') ? 'https:' + v : raw;
    let u;
    try { u = new URL(v, pageUrl); } catch { return raw; }
    return isOwnOrigin(u.origin, origins) ? u.pathname + u.search + u.hash : u.href;
  };
  return html
    .replace(RE_ATTR_URL, (m, lead, q, v) => `${lead}${q || '"'}${resolve(v)}${q || '"'}`)
    .replace(RE_SRCSET, (m, lead, q, v) => `${lead}${q}${v.split(',').map(part => {
      const [u, ...d] = part.trim().split(/\s+/);
      return [resolve(u), ...d].join(' ');
    }).join(', ')}${q}`);
}

/** URLs a document references outright — icons, manifests, scripts, images —
 *  as absolute URLs, for anything the recorder did not see go over the wire
 *  (Chromium fetches favicons outside the page's network session). */
function documentReferences(html, pageUrl) {
  const out = new Set();
  for (const m of html.matchAll(RE_ATTR_URL)) {
    let u;
    try { u = new URL(m[3].trim(), pageUrl); } catch { continue; }
    if (/^https?:$/.test(u.protocol) && u.pathname !== '/' && !u.pathname.endsWith('/')) out.add(u.href);
  }
  return [...out].slice(0, 40);
}

/** Every file the rewrite pass may touch: pages, extracted styles and scripts,
 *  plus whatever text the mirror itself wrote. */
function textTargets(dir, mirroredText) {
  const files = new Set(mirroredText);
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.html')) files.add(path.join(dir, f));
  for (const sub of [['css'], ['assets', 'scripts']]) {
    const d = path.join(dir, ...sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.(css|js|mjs)$/i.test(f)) files.add(path.join(d, f));
  }
  return [...files];
}

/** Split a saved page into its SingleFile header comment and the rest, so the
 *  "url: https://…" line every later pass reads stays intact. */
function splitHeader(text) {
  if (!/^\s*(?:<!doctype[^>]*>\s*)?(?:<html[^>]*>\s*)?<!--/i.test(text)) return ['', text];
  const end = text.indexOf('-->');
  if (end === -1 || end > 4000 || !/SingleFile|\burl:/i.test(text.slice(0, end))) return ['', text];
  return [text.slice(0, end + 3), text.slice(end + 3)];
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Mirror the runtime assets of every page in an extracted capture.
 * @param {string} dir      extracted site folder
 * @param {string} siteUrl  the URL the capture started from
 * @param {object} opts     mobile, headers, cookiesFile, entry, signal, record (test hook)
 * @param {(line:string)=>void} log
 * @returns {Promise<{pages:number, files:number, bytes:number, failed:number, deduped:number, documents:number, origins:string[]}>}
 */
async function mirrorSite(dir, siteUrl, opts = {}, log = () => {}) {
  const record = opts.record || recordPage;
  const stats = { pages: 0, files: 0, bytes: 0, failed: 0, deduped: 0, documents: 0, origins: [] };
  const pages = pageFiles(dir, siteUrl, opts.entry);
  const urls = pages.map(p => p.url);
  // Grows as pages land: the recorder reports where each document really came
  // from, and only then does the sink decide what counts as the site's own.
  const origins = siteOrigins(siteUrl, ...urls);
  const landed = new Set();
  const onDocument = url => {
    for (const o of siteOrigins(url)) origins.add(o);
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    if (landed.has(origin)) return;
    landed.add(origin);
    if (origin !== new URL(siteUrl).origin) log(`  site answers at ${origin}`);
  };
  const local = new Map();      // url -> root-relative local path
  const written = new Map();    // sha1 -> { file, rel } for same-content matching
  const mirroredText = new Set();
  let cookies = [];
  if (opts.cookiesFile) {
    try { cookies = parseCookiesFile(fs.readFileSync(opts.cookiesFile, 'utf8')); } catch { /* unreadable — anonymous mirror */ }
  }

  const place = url => {
    const segments = localSegments(url, origins);
    if (!segments) return null;
    return { dest: path.join(dir, ...segments), rel: rootRelative(segments), segments };
  };

  const keep = ({ url, mime, body }) => {
    if (local.has(url) || !body || !body.length) return;
    const spot = place(url);
    if (!spot) return;
    if (local.size >= MAX_FILES || body.length > MAX_FILE_BYTES || stats.bytes + body.length > MAX_TOTAL_BYTES) {
      log(`  asset limit reached — skipping ${url}`);
      return;
    }
    const isText = RE_TEXT_MIME.test(mime || '') || RE_TEXT_EXT.test(spot.segments[spot.segments.length - 1]);
    if (!fs.existsSync(spot.dest)) {
      fs.mkdirSync(path.dirname(spot.dest), { recursive: true });
      fs.writeFileSync(spot.dest, body);
      stats.files++;
      stats.bytes += body.length;
    }
    local.set(url, spot.rel);
    if (isText) {
      mirroredText.add(spot.dest);
      written.set(sha1(body), { file: spot.dest, rel: spot.rel });
      const squashed = sha1(Buffer.from(body.toString('utf8').replace(/\s+/g, ''), 'utf8'));
      if (!written.has(squashed)) written.set(squashed, { file: spot.dest, rel: spot.rel });
    }
  };

  // What a page fetches depends on the device it thinks it is on: srcset
  // picks, media-query backgrounds, a 3D scene's quality tier (igloo.inc only
  // streams clouds_noise.ktx2 to a desktop). The hosted copy is viewed on a
  // desktop first, so that pass always runs and gets the big budget; a phone
  // pass follows when the capture asked for the mobile layout.
  const passes = [{ mobile: false }];
  if (opts.mobile) passes.push({ mobile: true });
  const budgetFor = (i, pass) => (pass.mobile ? PHONE_PASS_MS : i === 0 ? FIRST_PAGE_MS : NEXT_PAGE_MS);

  for (const [i, { file, url: pageUrl }] of pages.entries()) {
    let recorded = false;
    let documentHtml = '';
    for (const pass of passes) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Mirror canceled.'), { canceled: true });
      log(`  recording ${pageUrl}${pass.mobile ? ' as a phone' : ''}`);
      let result;
      try {
        result = await record(pageUrl, {
          sink: keep,
          onDocument,
          budget: budgetFor(i, pass),
          mobile: pass.mobile,
          headers: opts.headers || [],
          cookies,
          signal: opts.signal,
          log,
        });
      } catch (err) {
        if (err.canceled) throw err;
        log(`  could not record ${pageUrl} — ${err.message}`);
        continue;
      }
      recorded = true;
      if (result && result.documentUrl) onDocument(result.documentUrl);
      if (result && result.documentHtml && !documentHtml) documentHtml = result.documentHtml;
      await refetchDropped((result && result.failed) || []);
    }
    if (!recorded) continue;
    stats.pages++;
    if (file && builtByScripts(documentHtml)) {
      // Serve the shell the server sent; the rendered snapshot stays in the
      // raw capture folder for anyone who wants the built DOM.
      let saved = '';
      try { saved = fs.readFileSync(file, 'utf8'); } catch { /* fine — header rebuilt below */ }
      // Only the comment survives: the snapshot's own <!DOCTYPE>/<html> before
      // it would open the document with the built DOM's class names, and the
      // parser keeps the first <html>'s attributes over the original's.
      let [header] = splitHeader(saved);
      header = header.includes('<!--') ? header.slice(header.indexOf('<!--')) : '';
      if (!header) header = `<!--\n Page saved with SingleFile \n url: ${pageUrl} \n-->`;
      fs.writeFileSync(file, header + absolutizeDocument(documentHtml, pageUrl, origins));
      stats.documents++;
      log(`  ${path.basename(file)} is built by its scripts — serving the original document instead of the rendered snapshot`);
      await refetchDropped(documentReferences(documentHtml, pageUrl).filter(u => !local.has(u)));
    }
  }
  stats.origins = [...landed];
  if (!local.size) return stats;

  // An extracted script that the mirror also fetched from its real URL: point
  // the page at the mirrored file (its sibling imports resolve there) and drop
  // the hash-named copy.
  const scriptsDir = path.join(dir, 'assets', 'scripts');
  const swaps = new Map(); // "assets/scripts/script-x.js" -> "/real/path.js"
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (!/\.(js|mjs)$/i.test(f)) continue;
      const file = path.join(scriptsDir, f);
      const body = fs.readFileSync(file);
      const hit = written.get(sha1(body))
        || written.get(sha1(Buffer.from(body.toString('utf8').replace(/\s+/g, ''), 'utf8')));
      if (!hit || hit.file === file) continue;
      swaps.set(`assets/scripts/${f}`, hit.rel);
      fs.rmSync(file, { force: true });
      stats.deduped++;
    }
  }
  // Nothing left under assets/scripts once every extracted copy moved home.
  try { if (fs.existsSync(scriptsDir) && !fs.readdirSync(scriptsDir).length) fs.rmdirSync(scriptsDir); } catch { /* leave it */ }

  // Rewrite: exact mirrored URLs (longest first, so a URL never clobbers one
  // it is a prefix of), the swapped script names, and the site's own origins
  // when one stands alone as a string — the base a Vite/webpack bundle
  // prefixes to chunk and CSS preloads at runtime. Every own origin counts:
  // the bundle may spell the host the way the site redirects to.
  const exact = [...local.entries()].sort((a, b) => b[0].length - a[0].length);
  const ownOrigins = [...origins].sort((a, b) => b.length - a.length);
  const originLiteral = new RegExp(`(["'\`])(?:${ownOrigins.map(escapeRegExp).join('|')})/?\\1`, 'g');
  for (const file of textTargets(dir, mirroredText)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const [header, rest] = file.endsWith('.html') ? splitHeader(text) : ['', text];
    let body = rest;
    for (const [url, rel] of exact) {
      if (url === rel) continue;
      if (body.includes(url)) body = body.split(url).join(rel);
    }
    if (file.endsWith('.html')) {
      for (const [from, to] of swaps) {
        body = body.replace(new RegExp(`(src\\s*=\\s*["']?)(?:\\./)?${escapeRegExp(from)}`, 'g'), `$1${to}`);
      }
    }
    body = body.replace(originLiteral, '$1/$1');
    if (body !== rest) fs.writeFileSync(file, header + body);
  }
  return stats;

  /** A body the browser had already evicted is fetched again over plain HTTP. */
  async function refetchDropped(failedUrls) {
    for (const url of failedUrls) {
      if (local.has(url)) continue;
      const spot = place(url);
      if (!spot) continue;
      try {
        if (!fs.existsSync(spot.dest)) {
          fs.mkdirSync(path.dirname(spot.dest), { recursive: true });
          const bytes = await download(url, spot.dest);
          stats.files++;
          stats.bytes += bytes;
        }
        local.set(url, spot.rel);
      } catch (err) {
        stats.failed++;
        log(`  FAILED ${url} — ${err.message}`);
      }
    }
  }
}

module.exports = { mirrorSite, recordPage, localSegments, siteOrigins, parseCookiesFile, splitHeader, pageUrls, pageFiles, builtByScripts, absolutizeDocument, documentReferences };
