// lib/entry.js — decide which page is a capture's real front door.
//
// SingleFile names each page after its URL path (/en -> _en.html), so a capture
// almost never contains an index.html. Hosting used to fall through to the
// generated _index.html sitemap hub, which made "open the site" land on a page
// list instead of the site. The entry page is resolved here, in order of trust:
// the filename recorded at capture time, the name derived from the source URL,
// conventional homepage names, the shortest page name, and only then the sitemap.
const fs = require('fs');
const path = require('path');

const SITEMAP = '_index.html';
const CONVENTIONAL = ['_.html', 'home.html', 'index.html'];

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'sitesnap.json'), 'utf8')); } catch { return null; }
}

// Mirror SingleFile's {url-pathname-flat}: every slash becomes an underscore
// (so "/" -> "_", "/en" -> "_en"), and filename-hostile characters are replaced.
function pageNameFromUrl(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    // eslint-disable-next-line no-control-regex
    const flat = pathname.replace(/\//g, '_').replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
    return flat ? flat + '.html' : null;
  } catch {
    return null;
  }
}

/** @returns {string|null} entry page filename inside dir, or null if no pages */
function resolveEntry(dir) {
  const isFile = name => {
    try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  };

  const manifest = readManifest(dir);
  if (manifest && manifest.entry && manifest.entry !== SITEMAP && isFile(manifest.entry)) {
    return manifest.entry;
  }
  if (manifest && manifest.url) {
    const derived = pageNameFromUrl(manifest.url);
    if (derived && isFile(derived)) return derived;
  }
  for (const name of CONVENTIONAL) if (isFile(name)) return name;

  let pages = [];
  try {
    pages = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== SITEMAP);
  } catch { /* unreadable */ }
  if (pages.length) {
    // The homepage tends to have the shortest URL path, hence the shortest name.
    return pages.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  return isFile(SITEMAP) ? SITEMAP : null;
}

module.exports = { resolveEntry, pageNameFromUrl, SITEMAP };
