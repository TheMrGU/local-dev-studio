// lib/livereload.js — watch a hosted folder and tell open tabs to refresh.
//
// Server-sent events instead of websockets: the plain http server we already
// run can push them with no new dependency, EventSource reconnects on its own,
// and a one-way "something changed" is all a reload needs. The client script
// lives in this file and is injected at serve time only — the files on disk
// are never modified.
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 150;
const PING_MS = 30000;
const PREFIX = '/__siteslurp__/';

// Kept deliberately tiny: swap same-origin stylesheets in place for CSS-only
// changes (state like scroll position and form input survives), full reload
// for anything else.
const CLIENT_JS = `(() => {
  'use strict';
  const swapCss = () => {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      let url;
      try { url = new URL(link.href, location.href); } catch { continue; }
      if (url.origin !== location.origin) continue;
      url.searchParams.set('__lr', Date.now().toString(36));
      link.href = url.href;
    }
  };
  const source = new EventSource('${PREFIX}events');
  source.onmessage = e => {
    let msg = {};
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'css') swapCss();
    else if (msg.type === 'reload') location.reload();
  };
})();
`;

// Never react to bookkeeping the app itself writes, or to churn nobody serves.
const IGNORED_NAMES = new Set(['thumb.png', 'siteslurp.json', 'sitesnap.json']);

function ignored(rel) {
  const parts = String(rel).split(/[\\/]/);
  return parts.some(seg => seg.startsWith('.') || seg === 'node_modules')
    || IGNORED_NAMES.has(parts[parts.length - 1]);
}

class LiveReload {
  constructor(dir) {
    this.dir = dir;
    this.clients = new Set();  // open SSE responses
    this.pending = new Set();  // filenames seen since the last flush
    this.watcher = null;
    this.timer = null;
    this.pinger = null;
  }

  start() {
    try {
      // Editors save in bursts (write + rename + metadata); the debounce folds
      // a burst into one event so the browser reloads once, not four times.
      this.watcher = fs.watch(this.dir, { recursive: true }, (event, filename) => {
        this.pending.add(filename ? String(filename) : '*');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
      });
      this.watcher.on('error', () => this.stop());
    } catch { /* folder vanished or unwatchable — live reload just stays quiet */ }

    // A comment line now and then keeps idle connections from being reaped.
    this.pinger = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, PING_MS);
    if (this.pinger.unref) this.pinger.unref();
    return this;
  }

  flush() {
    const seen = [...this.pending].filter(f => f === '*' || !ignored(f));
    this.pending.clear();
    if (!seen.length) return;
    // Windows reports the parent directory alongside the file that changed
    // inside it. A directory entry says nothing about what to swap, so drop
    // directories from classification — unless they're all we have (something
    // was created or deleted; a full reload is the safe answer). A path that
    // no longer exists is a deleted file and counts as a file.
    const files = seen.filter(f => {
      if (f === '*') return true;
      try { return !fs.statSync(path.join(this.dir, f)).isDirectory(); } catch { return true; }
    });
    const changed = files.length ? files : seen;
    // '*' means the watcher couldn't name the file — assume the worst, reload.
    const cssOnly = changed.every(f => f !== '*' && f.toLowerCase().endsWith('.css'));
    this.broadcast({ type: cssOnly ? 'css' : 'reload', files: changed.slice(0, 20) });
  }

  broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  /** Handle requests under /__siteslurp__/ — the event stream and the client script. */
  handleRequest(req, res, urlPath) {
    if (urlPath === PREFIX + 'events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      this.clients.add(res);
      res.on('close', () => this.clients.delete(res));
      return;
    }
    if (urlPath === PREFIX + 'livereload.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(CLIENT_JS);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  /** Add the client script tag to an HTML payload. Serve-time only — the
   *  buffer is a copy; nothing here ever writes to disk. */
  inject(buf) {
    const tag = `<script src="${PREFIX}livereload.js" defer></script>`;
    // latin1 keeps byte offsets aligned with character offsets, so the index
    // found in the string is valid in the buffer even for multi-byte UTF-8.
    const lower = buf.toString('latin1').toLowerCase();
    let at = lower.lastIndexOf('</body>');
    if (at === -1) at = lower.lastIndexOf('</html>');
    if (at === -1) return Buffer.concat([buf, Buffer.from('\n' + tag)]);
    return Buffer.concat([buf.subarray(0, at), Buffer.from(tag), buf.subarray(at)]);
  }

  stop() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* already closed */ }
      this.watcher = null;
    }
    clearTimeout(this.timer);
    clearInterval(this.pinger);
    for (const res of this.clients) {
      try { res.end(); } catch { /* connection already gone */ }
    }
    this.clients.clear();
  }
}

module.exports = { LiveReload, PREFIX };
