// lib/modelfix.js — mirror runtime-fetched assets into a capture.
// SingleFile saves what the DOM references, but kept scripts fetch more at
// runtime: 3D payloads (.glb, .hdr, decoder .wasm), gallery thumbnails, video
// files listed in a config object. None of that lands in the snapshot. This
// scans the saved pages and their extracted scripts for such URLs, downloads
// them into the site folder at the path the page will request, and rewrites
// each reference to a root-relative path so the fetch resolves against the
// local server instead of the live site. Only useful on captures made with
// scripts kept — without JS, nothing ever fetches these.
const fs = require('fs');
const path = require('path');
const { download } = require('./videofix');

// Formats a 3D runtime pulls in: meshes, scenes, environment maps, compressed
// textures, and the decoder binaries that unpack them.
const EXT_3D = 'glb|gltf|hdr|exr|ktx2|basis|drc|splinecode|usdz|fbx|obj|mtl|ply|vox|wasm';
// Inside script code, ordinary media gets fetched at runtime too (lazy
// galleries, video playlists). Too noisy to scan for in plain markup — DOM
// references were already captured — but script-only references are exactly
// what's missing. No `json` here: `res.json()` method calls look identical
// to a filename and litter every script that uses fetch.
const EXT_RUNTIME = `${EXT_3D}|png|jpe?g|webp|gif|avif|svg|mp4|webm|ogv|mp3|wav|ogg`;

// A URL-ish run of characters ending in one of the extensions (optionally with
// ?query/#fragment), bounded by quote/paren/whitespace on both sides. A
// backslash is a boundary too: a framework that inlines JSON as a JS string
// (Next.js's `self.__next_f.push([1,"…\"image\":\"https://…png\"…"])`) escapes
// every quote, and a match that swallowed the `\` before the closing quote
// would, once rewritten, end the string early and turn the whole payload
// script into a syntax error — the app then boots into its own "This page
// couldn't load" screen instead of the site.
const urlPattern = exts => new RegExp(
  `[^"'\`()\\s<>=,\\\\]+\\.(?:${exts})(?:[?#][^"'\`()\\s<>,\\\\]*)?(?=["'\`()\\s<>,\\\\]|$)`, 'gi');
const RE_3D = urlPattern(EXT_3D);
const RE_RUNTIME = urlPattern(EXT_RUNTIME);
const RE_SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

// SingleFile stamps every page with "url: https://…" in its header comment;
// crawled pages each carry their own, which relative references resolve against.
// The comment sits after the doctype and the <html> tag, so those may come first.
const RE_PAGE_URL = /^\s*(?:<!doctype[^>]*>\s*)?(?:<html[^>]*>\s*)?<!--[^>]*?\burl:\s*(https?:\/\/\S+)/i;

// A store's product pages each list a handful of runtime images in their
// payloads; a few hundred files is one site, not a runaway.
const MAX_FILES = 1500;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/** Decoded, Windows-safe relative segments for a URL pathname — or null if hostile. */
function safeSegments(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const segments = decoded.split('/').filter(Boolean);
  if (!segments.length) return null;
  for (const s of segments) if (s === '.' || s === '..') return null;
  return segments.map(s => s.replace(/[<>:"|?*\\]/g, '_'));
}

/** The origins a site answers on. The URL a capture starts from is rarely the
 *  one the site serves from — igloo.inc 308s to www.igloo.inc, http to https —
 *  and a bundle builds its fetches from `location.origin`, so a file from any
 *  of these must land at its real path, not under assets/remote/<host>/ as a
 *  third party. Each URL contributes its origin and the www-toggled twin on
 *  both schemes. */
function siteOrigins(...urls) {
  const out = new Set();
  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const hosts = [parsed.host, parsed.host.startsWith('www.') ? parsed.host.slice(4) : `www.${parsed.host}`];
    for (const host of hosts) for (const scheme of ['https:', 'http:']) out.add(`${scheme}//${host}`);
    out.add(parsed.origin);
  }
  return out;
}

/** Candidates from a page: 3D anywhere, plus runtime media inside script blocks. */
function collectFromHtml(html) {
  const found = new Set(html.match(RE_3D) || []);
  for (const m of html.matchAll(RE_SCRIPT_BLOCK)) {
    for (const ref of m[1].match(RE_RUNTIME) || []) found.add(ref);
  }
  return found;
}

/** @param {object} [opts] origins: extra origins the site was seen answering on
 *  (the mirror's redirect discoveries), treated as the site's own. */
async function fixModels(dir, siteUrl, log = () => {}, opts = {}) {
  const origins = siteOrigins(siteUrl, ...(opts.origins || []));
  const targets = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.html') && f !== '_index.html') targets.push({ file: path.join(dir, f), html: true });
    }
    const scriptsDir = path.join(dir, 'assets', 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const f of fs.readdirSync(scriptsDir)) {
        if (f.endsWith('.js')) targets.push({ file: path.join(scriptsDir, f), html: false });
      }
    }
  } catch {
    return 0;
  }

  const mirrored = new Map(); // resolved href -> local root-relative path ('' = failed/skipped)
  let count = 0;
  let totalBytes = 0;

  const mirror = async resolved => {
    if (mirrored.has(resolved.href)) return mirrored.get(resolved.href);
    let rel = '';
    if (mirrored.size >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      log(`  asset limit reached — skipping ${resolved.href}`);
    } else {
      const sameOrigin = origins.has(resolved.origin);
      const rest = safeSegments(resolved.pathname);
      const segments = !rest ? null
        : sameOrigin ? rest
          : ['assets', 'remote', resolved.hostname.replace(/[^\w.-]/g, '_'), ...rest];
      if (segments) {
        const dest = path.join(dir, ...segments);
        const localRel = '/' + segments.map(encodeURIComponent).join('/');
        if (fs.existsSync(dest)) {
          rel = localRel;
        } else {
          log(`  downloading ${resolved.href}`);
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const bytes = await download(resolved.href, dest);
            totalBytes += bytes;
            count++;
            log(`  got ${(bytes / 1048576).toFixed(1)} MB -> ${segments.join('/')}`);
            rel = localRel;
          } catch (err) {
            log(`  FAILED ${resolved.href} — ${err.message}`);
            // leave the reference pointing at the live site
          }
        }
      }
    }
    mirrored.set(resolved.href, rel);
    return rel;
  };

  for (const { file, html: isHtml } of targets) {
    let text = fs.readFileSync(file, 'utf8');
    // Extracted scripts run with the document as base URL, so their relative
    // references resolve against the page, not against assets/scripts/.
    const baseUrl = isHtml
      ? (RE_PAGE_URL.exec(text.slice(0, 2000)) || [])[1] || siteUrl
      : siteUrl;

    const found = [...(isHtml ? collectFromHtml(text) : new Set(text.match(RE_RUNTIME) || []))]
      // Longest first, so an absolute URL is rewritten before a shorter
      // candidate that happens to be its substring.
      .sort((a, b) => b.length - a.length);

    let changed = false;
    for (const literal of found) {
      // Bare words like `res.json` or `img.webp` in code are identifiers and
      // method calls, not fetchable paths — a real reference has a directory.
      if (!literal.includes('/')) continue;
      // Already local, non-fetchable, or a template the site fills in at runtime.
      if (/^(data:|blob:|assets\/|\.\.?\/assets\/|\/assets\/)/i.test(literal) || literal.includes('${')) continue;

      let resolved;
      try { resolved = new URL(literal, baseUrl); } catch { continue; }
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;

      const rel = await mirror(resolved);
      if (rel && literal !== rel) {
        text = text.split(literal).join(rel);
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(file, text);
  }
  return count;
}

module.exports = { fixModels, safeSegments, siteOrigins, urlPattern, RE_PAGE_URL };
