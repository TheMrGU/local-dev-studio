// lib/server.js — static hosting for extracted sites. Multiple sites at once,
// one http server per folder, Range support so videos seek, and no caching so
// hand-edits show up on refresh.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { resolveEntry, SITEMAP } = require('./entry');

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

function makeHandler(rootDir) {
  const root = path.resolve(rootDir);

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split(/[?#]/)[0]);
    } catch {
      res.writeHead(400); res.end('Bad request'); return;
    }
    if (urlPath.includes('\0')) { res.writeHead(400); res.end('Bad request'); return; }

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
        ? (entry => entry && path.join(root, entry))(resolveEntry(root))
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

function listenOn(handler, port, host) {
  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
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
    this.servers = new Map(); // dir -> { servers: [http.Server], port }
  }

  async start(dir, wantPort) {
    const existing = this.servers.get(dir);
    if (existing) return existing.port;

    const handler = makeHandler(dir);
    let port = Math.min(65535, Math.max(1024, wantPort | 0 || 8008));
    let lastError = null;
    for (let attempt = 0; attempt < 60 && port <= 65535; attempt++, port++) {
      if ([...this.servers.values()].some(s => s.port === port)) continue;

      let v4;
      try {
        v4 = await listenOn(handler, port, '127.0.0.1');
      } catch (err) {
        lastError = err;
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
        continue;
      }

      let v6 = null;
      try {
        v6 = await listenOn(handler, port, '::1');
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

      this.servers.set(dir, { servers: v6 ? [v4, v6] : [v4], port });
      return port;
    }
    throw new Error(`No free port available near ${wantPort}${lastError ? ` (${lastError.code})` : ''}.`);
  }

  stop(dir) {
    const entry = this.servers.get(dir);
    if (!entry) return false;
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

module.exports = { HostManager, makeHandler };
