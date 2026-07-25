// lib/extract.js — unpack SingleFile captures into an editable site structure.
// Explodes inlined base64 data URIs and <style> blocks into real files
// (css/, assets/images|fonts|media|misc/), deduped by content hash, with the HTML
// rewritten to reference them.
//
// Async by design: a big capture is tens of MB of regex work per page, and the
// main process also runs the local web servers — blocking it froze the UI and
// stalled every hosted site.
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
};

const hash10 = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
const breathe = () => new Promise(resolve => setImmediate(resolve));

function assetInfo(mime) {
  mime = (mime || 'application/octet-stream').toLowerCase().trim();
  const ext = EXT_MAP[mime] || (mime.split('/').pop() || 'bin').replace(/[^\w]/g, '') || 'bin';
  if (mime.startsWith('image/')) return { category: 'images', prefix: 'img', ext };
  if (mime.startsWith('font/') || mime.includes('font')) return { category: 'fonts', prefix: 'font', ext };
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return { category: 'media', prefix: 'media', ext };
  if (mime === 'text/css') return { category: 'css', prefix: 'style', ext: 'css' };
  return { category: 'misc', prefix: 'file', ext };
}

// Scroll-reveal animations are driven by JS that SingleFile strips, leaving the
// content frozen at opacity:0. Drop just those inline declarations.
function unfreezeReveals(html) {
  return html.replace(RE_STYLE_ATTR, (match, quoted) => {
    const css = quoted.slice(1, -1);
    if (!/opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)/i.test(css)) return match;
    if (!/transform\s*:\s*(translate|scale|perspective|matrix)/i.test(css)) return match;
    const kept = css
      .split(';')
      .filter(decl => decl.trim() && !/^\s*(opacity|transform|transition|visibility)\s*:/i.test(decl))
      .join(';')
      .trim();
    return kept ? ` style=${quoted[0]}${kept}${quoted[0]}` : '';
  });
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
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const assetsDir = path.join(outDir, 'assets');
  const cssDir = path.join(outDir, 'css');
  const assetIndex = new Map(); // content hash -> relative path under assets/
  const cssIndex = new Map();   // content hash -> css file name
  // `pages` counts real pages; the generated _index.html hub is processed but not
  // counted, so the finished message matches what the library shows.
  const stats = { pages: 0, processed: 0, css: 0, images: 0, fonts: 0, media: 0, misc: 0, refs: 0, bytes: 0, saved: 0 };

  const saveAsset = (buf, mime) => {
    const h = hash10(buf);
    stats.refs++;
    if (assetIndex.has(h)) { stats.saved += buf.length; return assetIndex.get(h); }
    const { category, prefix, ext } = assetInfo(mime);
    const dir = path.join(assetsDir, category);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${prefix}-${h}.${ext}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    const rel = `${category}/${fileName}`;
    assetIndex.set(h, rel);
    stats[category] = (stats[category] || 0) + 1;
    stats.bytes += buf.length;
    return rel;
  };

  for (const file of files) {
    if (opts.signal && opts.signal.aborted) {
      fs.rmSync(outDir, { recursive: true, force: true });
      throw Object.assign(new Error('Extract canceled.'), { canceled: true });
    }
    const name = path.basename(file);
    if (opts.onProgress) opts.onProgress({ done: stats.processed, total: files.length, page: name });
    await breathe();

    let html = await fs.promises.readFile(file, 'utf8');
    const before = html.length;

    // base64 data URIs anywhere (src, srcset, href, poster, inline style, css url())
    html = html.replace(RE_B64, (m, mime, data) => {
      if (data.length < 24) return m; // 1px spacers etc — leave inline
      let buf;
      try { buf = Buffer.from(data, 'base64'); } catch { return m; }
      if (!buf.length) return m;
      return `${TOKEN}/${saveAsset(buf, mime)}`;
    });

    // URL-encoded SVGs
    html = html.replace(RE_SVG, (m, data) => {
      if (data.length < 24) return m;
      let text;
      try { text = decodeURIComponent(data); } catch { return m; }
      return `${TOKEN}/${saveAsset(Buffer.from(text, 'utf8'), 'image/svg+xml')}`;
    });

    await breathe();

    // <style> blocks -> css/style-<hash>.css + <link> (skip styles inside inline <svg>)
    html = html.replace(RE_STYLE, (m, attrs, css, offset, full) => {
      const lastOpen = full.lastIndexOf('<svg', offset);
      const lastClose = full.lastIndexOf('</svg', offset);
      if (lastOpen > lastClose) return m;        // inside an inline svg — leave alone
      if (css.trim().length < 64) return m;      // tiny blocks stay inline

      const h = hash10(Buffer.from(css, 'utf8'));
      if (!cssIndex.has(h)) {
        fs.mkdirSync(cssDir, { recursive: true });
        const fileName = `style-${h}.css`;
        fs.writeFileSync(path.join(cssDir, fileName), css.split(`${TOKEN}/`).join('../assets/'));
        cssIndex.set(h, fileName);
        stats.css++;
      }
      const mm = /\bmedia\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs);
      return `<link rel="stylesheet" href="css/${cssIndex.get(h)}"${mm ? ` media=${mm[1]}` : ''}>`;
    });

    // Anything still inline references assets relative to the HTML itself.
    html = html.split(`${TOKEN}/`).join('assets/');

    // A CSP meta tag would block the extracted <link> stylesheets. Newer captures
    // are made with --insert-meta-CSP=false; older ones still carry it.
    html = html.replace(RE_CSP, '');

    if (!opts.keepHiddenStyles) html = unfreezeReveals(html);

    await fs.promises.writeFile(path.join(outDir, name), html);
    stats.processed++;
    if (name !== '_index.html') stats.pages++;
    log(`  ${Math.round(before / 1024).toLocaleString()} KB -> ${Math.round(html.length / 1024).toLocaleString()} KB  ${name}`);
  }

  if (opts.onProgress) opts.onProgress({ done: stats.processed, total: files.length, page: '' });
  return stats;
}

module.exports = { extractSite, uniqueOutDir };
