// lib/extract.js — unpack SingleFile captures into an editable site structure.
// Explodes inlined base64 data URIs and <style> blocks into real files
// (css/, assets/images|fonts|media|scripts|models|misc/), deduped by content
// hash, with the HTML rewritten to reference them.
//
// Async by design: a big capture is tens of MB of regex work per page, and the
// main process also runs the local web servers — blocking it froze the UI and
// stalled every hosted site. Every pass is incremental (a manual exec loop that
// yields to the event loop as it goes) because a single String.replace over a
// 30 MB page blocks for seconds and Windows then greys the window out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = '__ASSETROOT__';

const RE_B64 = /data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=-]+)*;base64,([A-Za-z0-9+/=]+)/g;
const RE_SVG = /data:image\/svg\+xml(?:;[\w=-]+)*,([^"')\s<>]+)/g;
const RE_STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const RE_CSP = /<meta\s+http-equiv=["']?content-security-policy["']?[^>]*>/gi;
const RE_STYLE_ATTR = /\sstyle=("[^"]*"|'[^']*')/gi;

const EXT_MAP = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'application/font-woff': 'woff',
  'application/x-font-woff': 'woff', 'font/ttf': 'ttf', 'font/sfnt': 'ttf',
  'application/x-font-ttf': 'ttf', 'font/otf': 'otf', 'application/x-font-otf': 'otf',
  'application/vnd.ms-fontobject': 'eot', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'text/css': 'css',
  'application/json': 'json', 'text/plain': 'txt',
  // Captures made with scripts kept carry these; .js must come out as .js or
  // browsers refuse to execute what the local server hands back.
  'text/javascript': 'js', 'application/javascript': 'js', 'application/x-javascript': 'js',
  'application/wasm': 'wasm', 'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf',
  'image/ktx2': 'ktx2',
};

// The content-hash helpers live here and are shared — the versioning engine
// (lib/versions.js) addresses its blobs with the same sha1, deliberately not
// its own copy of it.
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const hash10 = buf => sha1(buf).slice(0, 10);

/** Streaming sha1 of a file on disk, so a captured video never has to fit in
 *  memory just to be identified. */
function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const breathe = () => new Promise(resolve => setImmediate(resolve));

function assetInfo(mime) {
  mime = (mime || 'application/octet-stream').toLowerCase().trim();
  const ext = EXT_MAP[mime] || (mime.split('/').pop() || 'bin').replace(/[^\w]/g, '') || 'bin';
  if (mime.startsWith('image/')) return { category: 'images', prefix: 'img', ext };
  if (mime.startsWith('font/') || mime.includes('font')) return { category: 'fonts', prefix: 'font', ext };
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return { category: 'media', prefix: 'media', ext };
  if (mime.includes('javascript') || mime === 'application/wasm') return { category: 'scripts', prefix: 'script', ext };
  if (mime.startsWith('model/')) return { category: 'models', prefix: 'model', ext };
  if (mime === 'text/css') return { category: 'css', prefix: 'style', ext: 'css' };
  return { category: 'misc', prefix: 'file', ext };
}

// Scroll-reveal animations are driven by JS that SingleFile strips, leaving the
// content frozen at opacity:0. Drop just those inline declarations.
function unfreezeReveal(quoted) {
  const css = quoted.slice(1, -1);
  if (!/opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)/i.test(css)) return null;
  if (!/transform\s*:\s*(translate|scale|perspective|matrix)/i.test(css)) return null;
  const kept = css
    .split(';')
    .filter(decl => decl.trim() && !/^\s*(opacity|transform|transition|visibility)\s*:/i.test(decl))
    .join(';')
    .trim();
  return kept ? ` style=${quoted[0]}${kept}${quoted[0]}` : '';
}

/**
 * String.replace with a (possibly async) callback that yields to the event
 * loop every ~2 MB of input or 64 matches, and aborts between chunks.
 * The callback gets the same arguments String.replace would pass it.
 */
async function replaceAsync(str, regex, fn, tick) {
  // The shared module-level regexes carry lastIndex across awaits; a private
  // copy keeps overlapping extracts from corrupting each other's scan position.
  regex = new RegExp(regex.source, regex.flags);
  const out = [];
  let last = 0;
  let sinceYield = 0;
  let matches = 0;
  let m;
  while ((m = regex.exec(str))) {
    out.push(str.slice(last, m.index));
    const replaced = await fn(...m, m.index, str);
    out.push(replaced);
    last = m.index + m[0].length;
    if (m[0].length === 0) regex.lastIndex++; // never spin on an empty match
    sinceYield += m[0].length;
    if (++matches % 64 === 0 || sinceYield > 2 * 1024 * 1024) {
      sinceYield = 0;
      if (tick) tick();
      await breathe();
    }
  }
  out.push(str.slice(last));
  return out.join('');
}

/** Pick an output folder that doesn't exist yet: foo_extracted, foo_extracted-2, … */
function uniqueOutDir(base) {
  if (!fs.existsSync(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Too many extracted copies of this capture — delete a few first.');
}

// Windows antivirus / watchers / the hosting server hold short-lived locks on
// these folders; deleting without retries fails EBUSY often enough to matter.
const rmStubborn = target =>
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

/**
 * @param {string} input  capture folder (or a single .html file)
 * @param {string} outDir destination folder; must not exist unless opts.overwrite
 * @param {object} opts   { keepHiddenStyles, overwrite, onProgress, signal }
 * @param {(line:string)=>void} log
 */
async function extractSite(input, outDir, opts = {}, log = () => {}) {
  const stat = fs.statSync(input);
  const files = stat.isDirectory()
    ? fs.readdirSync(input).filter(f => f.endsWith('.html')).sort().map(f => path.join(input, f))
    : [input];
  if (!files.length) throw new Error('No .html files found in ' + input);

  if (fs.existsSync(outDir)) {
    if (!opts.overwrite) throw new Error('Output folder already exists: ' + outDir);
    rmStubborn(outDir);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const assetsDir = path.join(outDir, 'assets');
  const cssDir = path.join(outDir, 'css');
  const assetIndex = new Map(); // content hash -> relative path under assets/
  const cssIndex = new Map();   // content hash -> css file name
  // `pages` counts real pages; the generated _index.html hub is processed but not
  // counted, so the finished message matches what the library shows.
  const stats = { pages: 0, processed: 0, css: 0, images: 0, fonts: 0, media: 0, scripts: 0, models: 0, misc: 0, refs: 0, bytes: 0, saved: 0 };

  const checkAbort = () => {
    if (opts.signal && opts.signal.aborted) {
      throw Object.assign(new Error('Extract canceled.'), { canceled: true });
    }
  };

  const saveAsset = async (buf, mime) => {
    const h = hash10(buf);
    stats.refs++;
    if (assetIndex.has(h)) { stats.saved += buf.length; return assetIndex.get(h); }
    const { category, prefix, ext } = assetInfo(mime);
    const dir = path.join(assetsDir, category);
    await fs.promises.mkdir(dir, { recursive: true });
    const fileName = `${prefix}-${h}.${ext}`;
    await fs.promises.writeFile(path.join(dir, fileName), buf);
    const rel = `${category}/${fileName}`;
    assetIndex.set(h, rel);
    stats[category] = (stats[category] || 0) + 1;
    stats.bytes += buf.length;
    return rel;
  };

  try {
    for (const file of files) {
      checkAbort();
      const name = path.basename(file);
      if (opts.onProgress) opts.onProgress({ done: stats.processed, total: files.length, page: name });
      await breathe();

      let html = await fs.promises.readFile(file, 'utf8');
      const before = html.length;

      // base64 data URIs anywhere (src, srcset, href, poster, inline style, css url())
      html = await replaceAsync(html, RE_B64, async (m, mime, data) => {
        if (data.length < 24) return m; // 1px spacers etc — leave inline
        let buf;
        try { buf = Buffer.from(data, 'base64'); } catch { return m; }
        if (!buf.length) return m;
        return `${TOKEN}/${await saveAsset(buf, mime)}`;
      }, checkAbort);

      // URL-encoded SVGs
      html = await replaceAsync(html, RE_SVG, async (m, data) => {
        if (data.length < 24) return m;
        let text;
        try { text = decodeURIComponent(data); } catch { return m; }
        return `${TOKEN}/${await saveAsset(Buffer.from(text, 'utf8'), 'image/svg+xml')}`;
      }, checkAbort);

      // <style> blocks -> css/style-<hash>.css + <link> (skip styles inside inline <svg>)
      html = await replaceAsync(html, RE_STYLE, async (m, attrs, css, offset, full) => {
        const lastOpen = full.lastIndexOf('<svg', offset);
        const lastClose = full.lastIndexOf('</svg', offset);
        if (lastOpen > lastClose) return m;        // inside an inline svg — leave alone
        // "<style>…</style>" inside a kept <script> is a JS string literal
        // (style-injecting bundles do this) — swapping it for a <link> would
        // shatter the script.
        if (full.lastIndexOf('<script', offset) > full.lastIndexOf('</script', offset)) return m;
        if (css.trim().length < 64) return m;      // tiny blocks stay inline

        const h = hash10(Buffer.from(css, 'utf8'));
        if (!cssIndex.has(h)) {
          await fs.promises.mkdir(cssDir, { recursive: true });
          const fileName = `style-${h}.css`;
          await fs.promises.writeFile(path.join(cssDir, fileName), css.split(`${TOKEN}/`).join('../assets/'));
          cssIndex.set(h, fileName);
          stats.css++;
        }
        const mm = /\bmedia\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs);
        return `<link rel="stylesheet" href="css/${cssIndex.get(h)}"${mm ? ` media=${mm[1]}` : ''}>`;
      }, checkAbort);

      // Anything still inline references assets relative to the HTML itself.
      html = html.split(`${TOKEN}/`).join('assets/');

      // A CSP meta tag would block the extracted <link> stylesheets. Newer captures
      // are made with --insert-meta-CSP=false; older ones still carry it.
      html = html.replace(RE_CSP, '');

      if (!opts.keepHiddenStyles) {
        html = await replaceAsync(html, RE_STYLE_ATTR, (m, quoted) => {
          const fixed = unfreezeReveal(quoted);
          return fixed === null ? m : fixed;
        }, checkAbort);
      }

      await fs.promises.writeFile(path.join(outDir, name), html);
      stats.processed++;
      if (name !== '_index.html') stats.pages++;
      log(`  ${Math.round(before / 1024).toLocaleString()} KB -> ${Math.round(html.length / 1024).toLocaleString()} KB  ${name}`);
    }
  } catch (err) {
    if (err.canceled) rmStubborn(outDir);
    throw err;
  }

  if (opts.onProgress) opts.onProgress({ done: stats.processed, total: files.length, page: '' });
  return stats;
}

module.exports = { extractSite, uniqueOutDir, sha1, sha1File };
