// lib/grab.js — drag any element out of a hosted page.
//
// Natively a browser only lets you drag images, links and selected text — and
// what lands in the drop is a localhost URL that means nothing once the app
// stops hosting. Grab mode fixes both. A client script (injected at serve time,
// like live reload) makes whatever is under the cursor draggable while Alt is
// held. Media elements drop the file's real path on disk, so a terminal or an
// AI CLI gets something it can open directly. Everything else drops the path
// of a "grab bundle" this module writes on demand: the element's HTML, every
// stylesheet rule that touches it, and where its assets live locally — a
// self-contained folder of context for whoever the drop is aimed at.
const fs = require('fs');
const path = require('path');
const { PREFIX: LR_PREFIX } = require('./livereload');
const { resolveEntry } = require('./entry');

const PREFIX = LR_PREFIX + 'grab/';
const MAX_BODY = 8 * 1024 * 1024;   // outerHTML + collected CSS of a big section
const MAX_ASSETS = 60;

/** Map a served URL path back to the file on disk — the exact resolution the
 *  static handler uses, so what the browser fetched is what the path names.
 *  Null when the path decodes badly or escapes the site folder. */
function localPathFor(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(String(urlPath).split(/[?#]/)[0]); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** Lines for GRAB.md when the grabbed element is a surface code draws on —
 *  a <canvas> (WebGL, 2D) or an empty container the scripts fill at runtime —
 *  or nothing when the element is ordinary markup. */
function scriptDrawnNote(html, pageFile, root) {
  const inner = html.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>\s*$/, '');
  const hasCanvas = /<canvas\b/i.test(inner);
  const text = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
  const tags = (inner.match(/<[a-z][^\s>/]*/gi) || []).length;
  if (!hasCanvas && !(text === 0 && tags <= 3)) return [];

  const scripts = [];
  if (pageFile) {
    let page = '';
    try { page = fs.readFileSync(pageFile, 'utf8'); } catch { /* no page — the note still applies */ }
    for (const m of page.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/gi)) {
      const src = m[1];
      if (/^(?:https?:)?\/\//i.test(src)) { scripts.push(src); continue; }
      const local = root ? localPathFor(root, src.startsWith('/') ? src : '/' + src) : null;
      scripts.push(local && fs.existsSync(local) ? local : src);
    }
  }
  const mirrored = root && fs.existsSync(path.join(root, 'siteslurp.json'));
  return [
    '',
    '## Drawn by script',
    '',
    hasCanvas
      ? 'This element is a `<canvas>` (or holds one): what you see on it is painted by the page\'s JavaScript every frame — WebGL or 2D drawing, not markup. `element.html` and `styles.css` are the frame around the picture; a screenshot of it is just pixels.'
      : 'This element is empty in the markup: the page\'s JavaScript builds and animates its contents at runtime. `element.html` and `styles.css` are the container, not the thing you saw.',
    '',
    'To reuse the effect you need the code and its data, not the DOM:',
    '',
    ...(scripts.length ? scripts.map(s => `- script: ${s}`) : ['- (no script tags found on the page file — the site may inject them)']),
    ...(mirrored ? [`- runtime files the scripts load (models, textures, shaders, audio): under ${path.join(root, 'assets')} — the mirror manifest in ${path.join(root, 'siteslurp.json')} lists how many`] : []),
    '',
    'Host the site folder and open it in a browser to see the effect run; read the scripts for how it is built.',
  ];
}

/** Same stance as the review API: same-origin fetches carry no Origin header
 *  (GET) or a matching one (POST); anything else announces itself and is refused. */
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host || '';
  return origin !== `http://${host}` && origin !== `http://localhost:${host.split(':')[1]}`;
}

const safeName = name => String(name).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'site';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

const send = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

class GrabManager {
  /** @param {{capturesRoot: () => string, clientPath: string}} deps */
  constructor(deps) {
    this.deps = deps;
    this.clientCache = null;
  }

  clientScript() {
    if (!this.clientCache) this.clientCache = fs.readFileSync(this.deps.clientPath, 'utf8');
    return this.clientCache;
  }

  /** Bundles for one site all land in one folder next to the captures —
   *  visible in Explorer, never mistaken for a capture (no top-level HTML). */
  grabsRootFor(dir) {
    return path.join(this.deps.capturesRoot(), '_grabs', safeName(path.basename(dir)));
  }

  /**
   * Router hook for HostManager.
   * @param {string} dir project folder (identity)
   * @param {{mapped?: boolean, root?: string}} opts `mapped` is false behind a
   *   dev-server proxy, where URL paths say nothing about files on disk — the
   *   client then grabs everything as a bundle. `root` is the folder actually
   *   served (a runtime may serve a subfolder of the project).
   */
  forDir(dir, { mapped = true, root = dir } = {}) {
    const ctx = { dir, mapped, root: path.resolve(root) };
    return { handleRequest: (req, res, urlPath) => this.route(ctx, req, res, urlPath) };
  }

  async route(ctx, req, res, urlPath) {
    const route = urlPath.slice(PREFIX.length);
    try {
      if (foreignOrigin(req)) { send(res, 403, { error: 'Cross-origin request refused.' }); return; }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === 'client.js') {
          const cfg = {
            root: ctx.root,
            sep: path.sep,
            grabs: this.grabsRootFor(ctx.dir),
            api: PREFIX,
            mapped: ctx.mapped,
          };
          const body = `self.__SLURP_GRAB__ = ${JSON.stringify(cfg)};\n` + this.clientScript();
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
        send(res, 404, { error: 'Unknown grab endpoint.' });
        return;
      }

      if (req.method !== 'POST') { send(res, 405, { error: 'GET or POST only.' }); return; }
      if (route !== 'save') { send(res, 404, { error: 'Unknown grab endpoint.' }); return; }

      const body = await readBody(req);
      const folder = this.save(ctx, req, body);
      send(res, 200, { folder });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }

  /** Write one bundle. The folder name comes from the client because the drag
   *  payload already promised that exact path — but only as a single sanitized
   *  segment under this site's grabs folder, never a path of its own. */
  save(ctx, req, body) {
    const slug = String(body.slug || '');
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(slug)) throw new Error('Bad bundle name.');
    const grabsRoot = path.resolve(this.grabsRootFor(ctx.dir));
    const folder = path.resolve(grabsRoot, slug);
    if (!folder.startsWith(grabsRoot + path.sep)) throw new Error('Bad bundle name.');

    const html = String(body.html || '').slice(0, 2 * 1024 * 1024);
    const css = String(body.css || '').slice(0, 2 * 1024 * 1024);
    const selector = String(body.selector || '').slice(0, 500);
    const tag = String(body.tag || 'element').slice(0, 120);
    const pageUrl = String(body.pageUrl || '').slice(0, 2000);
    const rect = body.rect && typeof body.rect === 'object' ? body.rect : {};

    // The site's own local origin, from the request — not from the body.
    const origin = `http://${req.headers.host || ''}`;

    // Where the grabbed page lives on disk, when that question has an answer.
    let pageFile = null;
    if (ctx.mapped) {
      try {
        const pagePath = new URL(pageUrl, origin).pathname;
        const mappedPage = localPathFor(ctx.root, pagePath);
        const st = mappedPage && fs.existsSync(mappedPage) ? fs.statSync(mappedPage) : null;
        if (st && st.isFile()) pageFile = mappedPage;
        else if (pagePath === '/' || (st && st.isDirectory())) {
          const entry = resolveEntry(ctx.root);
          if (entry) pageFile = path.join(ctx.root, entry);
        }
      } catch { /* unparseable page url — the manifest just omits the file */ }
    }

    // Assets are sent as absolute URLs; their local twins are derived here from
    // the served root, never trusted from the body.
    const assets = [];
    for (const raw of Array.isArray(body.assets) ? body.assets.slice(0, MAX_ASSETS) : []) {
      let url;
      try { url = new URL(String(raw).slice(0, 2000)); } catch { continue; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      let local = null;
      if (ctx.mapped && url.origin === origin) {
        const mapped = localPathFor(ctx.root, url.pathname);
        if (mapped && fs.existsSync(mapped)) local = mapped;
      }
      assets.push({ href: url.href, local });
    }

    // An element with nothing in it but a <canvas>, or nothing at all, is
    // drawn by code: its HTML and CSS are the frame, not the picture.
    const drawnByScript = scriptDrawnNote(html, pageFile, ctx.mapped ? ctx.root : null);

    const lines = [
      `# Grabbed element: ${tag}`,
      '',
      `- Page: ${pageUrl}`,
      `- Site folder: ${ctx.root}`,
      ...(pageFile ? [`- Page file: ${pageFile}`] : []),
      `- Selector: \`${selector}\``,
      ...(rect.w ? [`- Rendered size: ${Math.round(rect.w)}×${Math.round(rect.h)} at (${Math.round(rect.x)}, ${Math.round(rect.y)})`] : []),
      `- Grabbed: ${new Date().toISOString()}`,
      '',
      '## Files here',
      '',
      '- `element.html` — the element\'s outer HTML as currently served',
      ...(css ? ['- `styles.css` — every stylesheet rule matching the element or its descendants, plus the `:root`/`body` context, `@keyframes` and `@font-face` it uses'] : []),
      ...drawnByScript,
      ...(assets.length ? [
        '',
        '## Assets it references',
        '',
        ...assets.map(a => a.local ? `- ${a.href}\n  → ${a.local}` : `- ${a.href} (remote — no local copy)`),
      ] : []),
      '',
    ];

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'element.html'), html);
    if (css) fs.writeFileSync(path.join(folder, 'styles.css'), css);
    fs.writeFileSync(path.join(folder, 'GRAB.md'), lines.join('\n'));
    return folder;
  }
}

module.exports = { GrabManager, PREFIX, localPathFor };
