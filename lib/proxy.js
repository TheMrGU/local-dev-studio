// lib/proxy.js — put SiteSlurp's own port in front of a project's dev server.
//
// The obvious way to host a Next.js app would be to run `next dev` and hand the
// user localhost:3000. Everything Studio does would then be gone: the stable
// per-project port, Review Mode's injected overlay, one address that doesn't
// move when the framework picks a different port. So the dev server is started
// on a private port and SiteSlurp keeps the public one, forwarding requests and
// injecting into HTML exactly as it does for a folder of files.
//
// Buffering is deliberate for HTML only (pages are small, and injection needs
// the whole document); everything else streams. Upgrades are forwarded raw so
// hot-module-reload websockets keep working through the proxy.
const http = require('http');
const { viaTunnel } = require('./tunnel');

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

const escapeHtml = text => String(text).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The page shown while the dev server is still compiling — or after it died.
 *  It refreshes itself, so the browser tab the user already opened becomes the
 *  real site the moment the server answers. */
function bootPage(state, { name = 'This site' } = {}) {
  const failed = state.status === 'failed' || state.status === 'stopped';
  const seconds = Math.round((state.elapsed || 0) / 1000);
  const tail = (state.log || '').split('\n').slice(-24).join('\n');
  return `<!doctype html><meta charset="utf-8">
<title>${escapeHtml(name)} — ${failed ? 'failed to start' : 'starting…'}</title>
${failed ? '' : '<meta http-equiv="refresh" content="2">'}
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif; background:#fff; color:#111; }
  main { width:min(760px,92vw); padding:40px 0; }
  h1 { font-size:19px; font-weight:600; margin:0 0 6px; letter-spacing:-0.01em; }
  p  { margin:0 0 20px; color:#6b6b6b; font-size:13.5px; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:8px;
         background:${failed ? '#c0392b' : '#111'}; ${failed ? '' : 'animation:pulse 1.2s ease-in-out infinite;'} }
  @keyframes pulse { 0%,100%{opacity:.25} 50%{opacity:1} }
  pre { margin:0; padding:16px 18px; border-radius:10px; background:#f6f6f6; color:#444;
        font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace; white-space:pre-wrap;
        max-height:52vh; overflow:auto; border:1px solid #ebebeb; }
  @media (prefers-color-scheme: dark) {
    body { background:#0e0e0e; color:#f2f2f2; }
    p { color:#8c8c8c; }
    pre { background:#161616; color:#c8c8c8; border-color:#242424; }
    .dot { background:${failed ? '#e05c4b' : '#f2f2f2'}; }
  }
</style>
<main>
  <h1><span class="dot"></span>${escapeHtml(name)} — ${failed ? 'the server stopped' : 'starting up'}</h1>
  <p>${escapeHtml(state.message || (failed ? 'The process exited.' : 'Waiting for the dev server to listen…'))}
     ${failed ? '' : `&nbsp;·&nbsp;${seconds}s&nbsp;·&nbsp;this page refreshes itself`}</p>
  <pre>${escapeHtml(tail || 'no output yet')}</pre>
</main>`;
}

function cleanHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.includes(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/* ---------- upstream CSP vs. the injected overlay ----------
 * The overlay tag is same-origin (<script src="/__siteslurp__/…">) and its
 * calls are same-origin fetches, so a dev server sending `script-src 'self'`
 * (or no CSP at all — Next and Vite defaults) needs nothing. What breaks it is
 * a nonce-/hash-only or 'none' policy. The fix is the smallest one that can
 * work: append 'self' to exactly the directive that blocks, never loosen
 * anything else. Every rewrite is reported so it's a logged fact, not magic. */

const SELF_TOKENS = new Set(["'self'", '*', 'http:', 'https:']);

/**
 * @param {string} value one Content-Security-Policy header value
 * @returns {{value: string, changed: string[]}} patched header + which
 *   directives had 'self' added (empty when the policy already allows us)
 */
function adjustCsp(value) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) return { value: text, changed: [] };
  const directives = text.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const tokens = part.split(/\s+/);
    return { name: tokens[0].toLowerCase(), tokens: tokens.slice(1) };
  });
  const find = name => directives.find(d => d.name === name) || null;
  const allowsSelf = tokens => tokens.some(t => SELF_TOKENS.has(t.toLowerCase()));
  const changed = [];

  // chain = governing order (most specific first); create = the directive to
  // add when the restriction comes from default-src, so nothing else widens.
  const ensure = (chain, create) => {
    const governing = chain.map(find).find(Boolean);
    if (!governing) return; // no restriction anywhere — same-origin is allowed
    if (allowsSelf(governing.tokens)) return;
    const kept = governing.tokens.filter(t => t.toLowerCase() !== "'none'");
    if (governing.name === 'default-src' && governing.name !== create) {
      directives.push({ name: create, tokens: [...kept, "'self'"] });
      changed.push(create);
    } else {
      governing.tokens = [...kept, "'self'"];
      changed.push(governing.name);
    }
  };
  ensure(['script-src-elem', 'script-src', 'default-src'], 'script-src');
  ensure(['connect-src', 'default-src'], 'connect-src');

  if (!changed.length) return { value: text, changed };
  return { value: directives.map(d => [d.name, ...d.tokens].join(' ')).join('; '), changed };
}

/**
 * @param {() => {status:string, port:number, message?:string, log?:string, elapsed?:number}|null} getTarget
 * @param {{name?:string, transformHtml?:(req:import('http').IncomingMessage)=>(buf:Buffer)=>Buffer}} opts
 *   transformHtml is resolved per request, so Review Mode can be toggled on a
 *   server that is already running — and so it can decline for requests that
 *   arrived through a public share link. opts.warn receives one sentence per
 *   upstream-CSP rewrite (see adjustCsp).
 */
function makeProxyHandler(getTarget, opts = {}) {
  const name = opts.name || 'This site';
  const getTransform = opts.transformHtml || (() => null);
  const warn = opts.warn || (() => {});

  const notReady = (req, res, state) => {
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    const body = wantsHtml
      ? bootPage(state, { name })
      : `${state.status === 'failed' ? 'Dev server failed' : 'Dev server starting'} — ${state.message || ''}`;
    res.writeHead(503, {
      'Content-Type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '2',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const handler = (req, res) => {
    const state = getTarget();
    if (!state || state.status !== 'ready') {
      notReady(req, res, state || { status: 'starting', message: 'Not started yet.' });
      return;
    }

    const headers = cleanHeaders(req.headers);
    // Injection needs readable bytes, and a dev server will happily gzip. Asking
    // for identity is cheaper and safer than gunzipping every page.
    headers['accept-encoding'] = 'identity';
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
    // A tunneled request carries Host: xxx.trycloudflare.com, which a dev
    // server with host checking (Vite 6+) rejects as a DNS-rebinding attempt.
    // It's asking for localhost content, so say so; the original stays in
    // x-forwarded-host for anything that builds absolute URLs.
    if (viaTunnel(req)) headers.host = `127.0.0.1:${state.port}`;

    const upstream = http.request({
      host: '127.0.0.1',
      port: state.port,
      method: req.method,
      path: req.url,
      headers,
    }, ures => {
      const type = String(ures.headers['content-type'] || '');
      const transform = type.startsWith('text/html') ? getTransform(req) : null;
      const out = cleanHeaders(ures.headers);

      // Only pages we inject into need the CSP looked at; everything else
      // passes through byte- and header-exact.
      if (transform) {
        for (const key of Object.keys(out)) {
          if (key.toLowerCase() !== 'content-security-policy') continue;
          const patched = [].concat(out[key]).map(one => {
            const result = adjustCsp(one);
            if (result.changed.length) {
              warn(`rewrote the dev server's Content-Security-Policy so the same-origin overlay can run `
                + `(added 'self' to ${result.changed.join(', ')})`);
            }
            return result.value;
          });
          out[key] = patched.length === 1 ? patched[0] : patched;
        }
      }

      if (!transform) {
        res.writeHead(ures.statusCode || 200, out);
        ures.pipe(res);
        res.on('close', () => ures.destroy());
        return;
      }

      const chunks = [];
      ures.on('data', chunk => chunks.push(chunk));
      ures.on('end', () => {
        let body;
        try {
          body = transform(Buffer.concat(chunks));
        } catch {
          body = Buffer.concat(chunks); // a broken injection must not break the page
        }
        delete out['content-length'];
        delete out['content-encoding'];
        res.writeHead(ures.statusCode || 200, { ...out, 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
      ures.on('error', () => res.destroy());
    });

    upstream.on('error', err => {
      if (res.headersSent) { res.destroy(); return; }
      // The server was ready a moment ago — a restart or a crash between
      // requests lands here, and the boot page is the honest answer.
      notReady(req, res, { ...state, status: 'failed', message: `Lost connection to the dev server (${err.code || err.message}).` });
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };

  /** Forward websocket upgrades (HMR, live preview channels) untouched. */
  const upgrade = (req, socket, head) => {
    const state = getTarget();
    if (!state || state.status !== 'ready') { socket.destroy(); return; }
    socket.on('error', () => socket.destroy());

    const headers = { ...req.headers };
    if (viaTunnel(req)) headers.host = `127.0.0.1:${state.port}`;
    const upstream = http.request({
      host: '127.0.0.1',
      port: state.port,
      method: req.method,
      path: req.url,
      headers,
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', ures => {
      // Not an upgrade after all — pass the plain response through and hang up.
      if (!socket.destroyed) {
        socket.write(`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n`
          + Object.entries(ures.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        ures.pipe(socket);
      }
    });
    upstream.on('upgrade', (ures, usocket, uhead) => {
      usocket.on('error', () => usocket.destroy());
      const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
      for (const [key, value] of Object.entries(ures.headers)) {
        for (const one of [].concat(value)) lines.push(`${key}: ${one}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (uhead && uhead.length) socket.write(uhead);
      if (head && head.length) usocket.write(head);
      usocket.pipe(socket);
      socket.pipe(usocket);
    });
    upstream.end();
  };

  return { handler, upgrade };
}

module.exports = { makeProxyHandler, bootPage, adjustCsp };
