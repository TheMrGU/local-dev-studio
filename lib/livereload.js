// lib/livereload.js — watch a hosted folder and tell open tabs to refresh.
//
// Server-sent events instead of websockets: the plain http server we already
// run can push them with no new dependency, EventSource reconnects on its own,
// and a one-way "something changed" is all a reload needs. The client script
// lives in this file and is injected at serve time only — the files on disk
// are never modified. The file watching itself lives in lib/watch.js, shared
// with the versioning engine's auto-snapshots.
const { watchFolder } = require('./watch');

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

class LiveReload {
  constructor(dir) {
    this.dir = dir;
    this.clients = new Set();  // open SSE responses
    this.watcher = null;
    this.pinger = null;
  }

  start() {
    this.watcher = watchFolder(this.dir, ({ files, cssOnly }) => {
      this.broadcast({ type: cssOnly ? 'css' : 'reload', files: files.slice(0, 20) });
    }, { onError: () => this.stop() });

    // A comment line now and then keeps idle connections from being reaped.
    this.pinger = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, PING_MS);
    if (this.pinger.unref) this.pinger.unref();
    return this;
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
      this.watcher.close();
      this.watcher = null;
    }
    clearInterval(this.pinger);
    for (const res of this.clients) {
      try { res.end(); } catch { /* connection already gone */ }
    }
    this.clients.clear();
  }
}

module.exports = { LiveReload, PREFIX };
