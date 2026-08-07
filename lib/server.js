// lib/server.js — local hosting for everything in the library. Multiple sites at
// once, one http server per folder, Range support so videos seek, and no caching
// so hand-edits show up on refresh.
//
// Two shapes of site live behind the same door. A capture (or any folder of
// HTML) is served straight off disk. A project that needs a process — Next.js,
// Vite, Django, PHP — gets that process started on a private port while this
// server keeps the public one and proxies to it, so the address, Review Mode
// and everything else in Studio work identically either way.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { resolveEntry, SITEMAP } = require('./entry');
const { LiveReload, PREFIX: LR_PREFIX } = require('./livereload');
const { Runner, freePort } = require('./runner');
const { makeProxyHandler } = require('./proxy');
const { withPort, envWithPort, takesPort } = require('./runtimes');
const { viaTunnel } = require('./tunnel');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf', '.map': 'application/json; charset=utf-8',
};

const HOME_CANDIDATES = ['_.html', 'home.html', 'index.html', SITEMAP];

const REVIEW_PREFIX = LR_PREFIX + 'review/';
const REVIEW_TAG = `<script src="${REVIEW_PREFIX}client.js" defer></script>`;

/** Insert a tag before </body> (or </html>, or append) without touching disk. */
function injectTag(buf, tag) {
  const lower = buf.toString('latin1').toLowerCase();
  let at = lower.lastIndexOf('</body>');
  if (at === -1) at = lower.lastIndexOf('</html>');
  if (at === -1) return Buffer.concat([buf, Buffer.from('\n' + tag)]);
  return Buffer.concat([buf.subarray(0, at), Buffer.from(tag), buf.subarray(at)]);
}

/** The page "/" serves: the registry's chosen entry when it still exists,
 *  otherwise whatever resolveEntry works out from the folder itself. */
function landingPage(root, chosen) {
  if (chosen && typeof chosen === 'string') {
    const full = path.resolve(root, chosen);
    const inside = full.startsWith(root + path.sep)
      && !path.relative(root, full).split(path.sep).some(seg => seg.startsWith('.'));
    const st = inside ? statOr404(full) : null;
    if (st && st.isFile()) return full;
  }
  const entry = resolveEntry(root);
  return entry ? path.join(root, entry) : null;
}

/**
 * @param {string} rootDir site folder to serve
 * @param {{live?: () => LiveReload|null, review?: () => object|null, entry?: () => string|null}} hooks
 *   resolved per request so toggles apply to a server that is already running.
 *   `review` returns a handler with handleRequest(req, res, urlPath) while the
 *   folder is in review mode; `entry` returns the project's chosen entry page.
 */
function makeHandler(rootDir, hooks = {}) {
  const root = path.resolve(rootDir);
  const getLive = hooks.live || (() => null);
  const getReview = hooks.review || (() => null);
  const getEntry = hooks.entry || (() => null);

  return (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split(/[?#]/)[0]);
    } catch {
      res.writeHead(400); res.end('Bad request'); return;
    }
    if (urlPath.includes('\0')) { res.writeHead(400); res.end('Bad request'); return; }

    // A visitor arriving through a public share link gets the site and nothing
    // else. Review Mode can reveal folders and write exports on this machine —
    // that toolbelt exists for the person at the keyboard, not the internet.
    const remote = viaTunnel(req);

    // The review API is the one place POST exists; static serving stays GET/HEAD.
    const review = remote ? null : getReview();
    if (urlPath.startsWith(REVIEW_PREFIX)) {
      if (!review) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      review.handleRequest(req, res, urlPath);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }

    const live = remote ? null : getLive();
    if (urlPath.startsWith(LR_PREFIX)) {
      if (live) live.handleRequest(req, res, urlPath);
      else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
      return;
    }

    // Resolve inside the site folder, then verify we're still inside it. Resolving
    // first is what makes ".." and absolute paths safe; the separator check stops a
    // sibling folder with a matching prefix from passing.
    let filePath = path.resolve(root, '.' + path.posix.normalize('/' + urlPath.replace(/\\/g, '/')));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    // Internal bookkeeping (undo snapshots, manifests) isn't part of the site.
    if (path.relative(root, filePath).split(path.sep).some(seg => seg.startsWith('.'))) {
      res.writeHead(404); res.end('Not found'); return;
    }

    let st = statOr404(filePath);
    if (st && st.isDirectory()) {
      // The site root goes to the capture's actual homepage; the sitemap hub
      // stays reachable at /_index.html for anyone who wants the page list.
      const landing = filePath === root
        ? landingPage(root, getEntry())
        : HOME_CANDIDATES.map(c => path.join(filePath, c)).find(p => statOr404(p));
      if (!landing) { notFound(res, urlPath); return; }
      filePath = landing;
      st = statOr404(filePath);
    }
    if (!st) { notFound(res, urlPath); return; }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // Editing a hosted site and hitting refresh must show the change.
    const base = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    // With live reload or review mode on, HTML goes out with client scripts
    // injected. The page is buffered (no ranges — pages are small, video isn't
    // HTML) and the file on disk is never touched; turning the toggles off
    // restores byte-exact serving on the very next request.
    if ((live || review) && type.startsWith('text/html')) {
      fs.readFile(filePath, (err, raw) => {
        if (err) { notFound(res, urlPath); return; }
        let body = raw;
        if (review) body = injectTag(body, REVIEW_TAG);
        if (live) body = live.inject(body);
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': body.length,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(body);
      });
      return;
    }

    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      const start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
      const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      if (!Number.isFinite(start) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return;
      }
      res.writeHead(206, {
        ...base,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      pipe(fs.createReadStream(filePath, { start, end }), res);
    } else {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      if (req.method === 'HEAD') { res.end(); return; }
      pipe(fs.createReadStream(filePath), res);
    }
  };
}

/**
 * The same door in front of a running dev server. Requests are forwarded to the
 * child process; SiteSlurp's own endpoints (review API, live reload) are
 * answered here so they exist on a Next.js app exactly as on a capture.
 * @returns {{handler:Function, upgrade:Function}}
 */
function makeCommandHandler({ hooks = {}, getRunner, name }) {
  const getLive = hooks.live || (() => null);
  const getReview = hooks.review || (() => null);

  const proxy = makeProxyHandler(() => {
    const runner = getRunner();
    return runner ? runner.state() : null;
  }, {
    name,
    // Resolved per request, so toggling Review Mode doesn't need a restart —
    // and never injected into pages leaving through a public share link.
    transformHtml: req => {
      if (viaTunnel(req)) return null;
      const review = getReview();
      const live = getLive();
      if (!review && !live) return null;
      return buf => {
        let body = buf;
        if (review) body = injectTag(body, REVIEW_TAG);
        if (live) body = live.inject(body);
        return body;
      };
    },
  });

  const handler = (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split(/[?#]/)[0]);
    } catch {
      res.writeHead(400); res.end('Bad request'); return;
    }
    const remote = viaTunnel(req);
    const review = remote ? null : getReview();
    if (urlPath.startsWith(REVIEW_PREFIX)) {
      if (!review) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      review.handleRequest(req, res, urlPath);
      return;
    }
    const live = remote ? null : getLive();
    if (urlPath.startsWith(LR_PREFIX)) {
      if (live) live.handleRequest(req, res, urlPath);
      else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
      return;
    }
    proxy.handler(req, res);
  };

  return { handler, upgrade: proxy.upgrade };
}

function statOr404(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function pipe(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function notFound(res, urlPath) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const safe = String(urlPath).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.end(`<!doctype html><meta charset="utf-8"><title>404</title>
<body style="font:15px system-ui;padding:40px;color:#333">
<h1 style="font-size:20px">404 — not in this capture</h1>
<p style="color:#777"><code>${safe}</code> wasn't saved. Deep links and pages beyond the crawl depth won't exist locally.</p>`);
}

// "localhost" resolves to ::1 and 127.0.0.1, and the browser may try either.
// Listening on only one of them lets a different process own the other — the
// browser then silently shows *that* process's content on "our" port. (Seen in
// the wild: a leftover `python -m http.server` bound to :: made every hosted
// site come up as the wrong website.) So a port only counts as ours when both
// loopbacks bind, and a machine without IPv6 is detected and served v4-only.
const V6_UNAVAILABLE = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL']);

function listenOn(handler, port, host, upgrade) {
  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  // Hot-module-reload sockets arrive as upgrades; without this a Vite or Next
  // page loads once and then never updates.
  if (upgrade) server.on('upgrade', upgrade);
  return new Promise((resolve, reject) => {
    server.once('error', err => { server.close(); reject(err); });
    server.listen(port, host, () => {
      // Only surprises after listen succeeds should reach here.
      server.on('error', () => {});
      resolve(server);
    });
  });
}

function closeServer(server) {
  server.close();
  server.closeAllConnections?.();
}

class HostManager {
  constructor() {
    this.servers = new Map(); // dir -> { servers: [http.Server], port, lr, runner, runtime }
    this.reviewRouter = null; // (dir) => review handler | null, set by main
    this.entryFor = null;     // (dir) => entry page filename | null, set by main
    this.onRuntimeChange = null; // (dir, state) => void, so the UI can follow a boot
  }

  /**
   * @param {string} dir project folder (also the identity used everywhere else)
   * @param {number} wantPort preferred public port
   * @param {object} opts
   * @param {boolean} [opts.liveReload] SiteSlurp's own file-watching reload
   * @param {import('./runtimes').Runtime} [opts.runtime] how this folder is served;
   *   omitted means the original behaviour, static files straight off disk
   * @param {string} [opts.name] shown on the "starting up" page
   */
  async start(dir, wantPort, { liveReload = false, runtime = null, name = '' } = {}) {
    const existing = this.servers.get(dir);
    if (existing) return existing.port;

    const isCommand = !!runtime && runtime.kind === 'command';
    // A framework brings its own hot reload, and watching a repo full of
    // node_modules would be expensive and pointless — so the file watcher is a
    // static-hosting feature only.
    const useLiveReload = liveReload && !isCommand;

    // Resolved per request, so setLive / review toggles apply to a running server.
    const hooks = {
      live: () => {
        const entry = this.servers.get(dir);
        return entry ? entry.lr : null;
      },
      review: () => (this.reviewRouter ? this.reviewRouter(dir) : null),
      entry: () => (this.entryFor ? this.entryFor(dir) : null),
    };

    let runner = null;
    let handler;
    let upgrade;
    if (isCommand) {
      if (!String(runtime.command || '').trim()) {
        throw new Error('This project has no start command yet — set one in Runtime settings.');
      }
      // The child gets a private port; the public one stays ours. A command
      // that binds a fixed port of its own (docker, a hard-coded server) says
      // so with appPort and we simply proxy there.
      const childPort = takesPort(runtime)
        ? await freePort()
        : (runtime.appPort || await freePort());
      runner = new Runner({
        command: withPort(runtime.command, childPort),
        cwd: runtime.root ? path.join(dir, runtime.root) : dir,
        env: envWithPort(runtime.env, childPort),
        port: childPort,
        onChange: r => { if (this.onRuntimeChange) this.onRuntimeChange(dir, r.state()); },
      });
      ({ handler, upgrade } = makeCommandHandler({
        hooks, name: name || path.basename(dir), getRunner: () => runner,
      }));
    } else {
      const serveRoot = runtime && runtime.root ? path.join(dir, runtime.root) : dir;
      handler = makeHandler(serveRoot, hooks);
    }

    let port = Math.min(65535, Math.max(1024, wantPort | 0 || 8008));
    let lastError = null;
    for (let attempt = 0; attempt < 60 && port <= 65535; attempt++, port++) {
      if ([...this.servers.values()].some(s => s.port === port)) continue;

      let v4;
      try {
        v4 = await listenOn(handler, port, '127.0.0.1', upgrade);
      } catch (err) {
        lastError = err;
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
        continue;
      }

      let v6 = null;
      try {
        v6 = await listenOn(handler, port, '::1', upgrade);
      } catch (err) {
        if (!V6_UNAVAILABLE.has(err.code)) {
          // Another process owns the IPv6 side of this port — the browser
          // would show its content, not ours. The whole port is a no-go.
          closeServer(v4);
          lastError = err;
          if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
          continue;
        }
      }

      this.servers.set(dir, {
        servers: v6 ? [v4, v6] : [v4],
        port,
        lr: useLiveReload ? new LiveReload(dir).start() : null,
        runner,
        runtime,
      });
      // Started after the public port is ours, so hosting returns immediately
      // and the browser shows the boot page instead of a spinner in the app.
      if (runner) runner.start();
      return port;
    }
    if (runner) runner.stop();
    throw new Error(`No free port available near ${wantPort}${lastError ? ` (${lastError.code})` : ''}.`);
  }

  /** What the child process is doing, for the card and the runtime panel.
   *  Static sites report themselves as ready — there is nothing to boot. */
  runtimeState(dir) {
    const entry = this.servers.get(dir);
    if (!entry) return null;
    if (!entry.runner) return { status: 'ready', message: 'Serving files', kind: 'static' };
    return { ...entry.runner.state(), kind: 'command' };
  }

  /** Restart the process behind a hosted project without moving its port. */
  restart(dir) {
    const entry = this.servers.get(dir);
    if (!entry || !entry.runner) return false;
    entry.runner.stop();
    entry.runner.lines = [];
    entry.runner.stopping = false;
    entry.runner.start();
    return true;
  }

  /** Flip live reload on a running host. No-op when the dir isn't hosted —
   *  the preference still lands in the registry for the next start. */
  setLive(dir, on) {
    const entry = this.servers.get(dir);
    if (!entry) return false;
    if (on && !entry.lr) entry.lr = new LiveReload(dir).start();
    else if (!on && entry.lr) { entry.lr.stop(); entry.lr = null; }
    return true;
  }

  stop(dir) {
    const entry = this.servers.get(dir);
    if (!entry) return false;
    if (entry.lr) entry.lr.stop();
    // Kill the dev server before dropping the entry: an orphaned child would
    // keep its port and reappear as a mysteriously "already running" site.
    if (entry.runner) entry.runner.stop();
    for (const server of entry.servers) closeServer(server);
    this.servers.delete(dir);
    return true;
  }

  stopAll() {
    for (const dir of [...this.servers.keys()]) this.stop(dir);
  }

  portFor(dir) {
    const entry = this.servers.get(dir);
    return entry ? entry.port : null;
  }

  list() {
    return [...this.servers.entries()].map(([dir, { port }]) => ({ dir, port }));
  }
}

module.exports = { HostManager, makeHandler, makeCommandHandler };
