// lib/library.js — enumerate capture folders under the captures root.
//
// Folder sizes are walked asynchronously and cached: the old synchronous walk ran
// on every refresh and blocked the main process (and therefore every hosted site)
// for as long as it took to stat a few thousand asset files.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readManifest } = require('./capture');

const sizeCache = new Map(); // dir -> { mtimeMs, sizeMB }

function invalidate(dir) {
  if (dir) sizeCache.delete(dir);
  else sizeCache.clear();
}

async function dirSizeBytes(dir, mtimeMs) {
  const hit = sizeCache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.bytes;

  let bytes = 0;
  const walk = async d => {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else {
        try { bytes += (await fs.promises.stat(p)).size; } catch { /* vanished mid-walk */ }
      }
    }
  };
  await walk(dir);

  sizeCache.set(dir, { mtimeMs, bytes });
  return bytes;
}

function displayName(folder, manifest) {
  if (manifest && manifest.name) return manifest.name;
  return folder
    .replace(/_\d{4}-\d{2}-\d{2}_\d{4}/, '')
    .replace(/_extracted(-\d+)?$/, '')
    || folder;
}

async function describe(root, folder) {
  const dir = path.join(root, folder);
  let pages;
  try {
    pages = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.html') && f !== '_index.html');
  } catch {
    return null;
  }
  if (!pages.length) return null;

  const [stat, manifest] = [await fs.promises.stat(dir).catch(() => null), readManifest(dir)];
  if (!stat) return null;

  const extracted = fs.existsSync(path.join(dir, 'assets')) || fs.existsSync(path.join(dir, 'css'));
  const thumb = path.join(dir, 'thumb.png');
  let thumbUrl = null;
  try {
    thumbUrl = pathToFileURL(thumb).href + '?t=' + (await fs.promises.stat(thumb)).mtimeMs;
  } catch { /* no thumbnail yet */ }

  return {
    dir,
    folder,
    name: displayName(folder, manifest),
    kind: extracted ? 'extracted' : 'raw',
    sourceUrl: manifest ? manifest.url || '' : '',
    pages: pages.length,
    sizeBytes: await dirSizeBytes(dir, stat.mtimeMs),
    mtime: stat.mtimeMs,
    thumb: thumbUrl,
    hasSitemap: fs.existsSync(path.join(dir, '_index.html')),
    // A raw capture that's already been extracted is clutter by default.
    hasExtracted: !extracted && fs.existsSync(dir + '_extracted'),
  };
}

/**
 * @param {string} root captures root folder
 * @param {(dir:string)=>number|null} portFor host lookup
 */
async function listLibrary(root, portFor = () => null) {
  let folders = [];
  try {
    folders = (await fs.promises.readdir(root, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return { root, sites: [], missing: true };
  }

  const sites = (await Promise.all(folders.map(f => describe(root, f).catch(() => null))))
    .filter(Boolean)
    .map(site => ({ ...site, port: portFor(site.dir) }));

  sites.sort((a, b) => b.mtime - a.mtime);
  return { root, sites, missing: false };
}

module.exports = { listLibrary, invalidate, dirSizeBytes };
