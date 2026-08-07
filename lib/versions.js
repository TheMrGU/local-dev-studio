// lib/versions.js — the Snapshots engine: zero-config version history for every
// project in the library.
//
// Storage is content-addressed, one blob per distinct file body, one small
// manifest per snapshot — so fifty snapshots of a site that barely changes
// cost barely more than one:
//
//   <store>/blobs/<aa>/<sha1>            file bodies (aa = first 2 hex chars)
//   <store>/versions/<stamp>/meta.json   one manifest per snapshot
//
// <store> is <siteFolder>/.siteslurp for captures (they're ours, and the
// server never exposes dot-folders), but userData/versions/<projectId> for
// local drag-dropped projects — mirroring the thumbnails decision to never
// write into a user's own repo. Stamps are UTC with dashes for the colons
// (2026-08-07T14-30-05Z): Windows-safe and still sortable.
//
// Restores are non-destructive: the first thing a restore does is snapshot the
// tree it is about to rewrite. Nothing here ever deletes the only copy of
// anything.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { sha1File } = require('./extract');
const { watchFolder, BUILD_OUTPUT_DIRS } = require('./watch');
const log = require('./logger');
const projects = require('./projects');
const settings = require('./settings');

const STORE_DIR = '.siteslurp';
const SOURCES = new Set(['manual', 'auto', 'palette', 'pre-restore', 'capture']);

// Prune policy. Deliberate snapshots (manual, palette, pre-restore, capture —
// each one is a decision or a safety net) keep their newest 50; automatic ones
// keep the newest 20 or anything younger than 14 days, whichever keeps more.
const KEEP_DELIBERATE = 50;
const KEEP_AUTO_COUNT = 20;
const KEEP_AUTO_DAYS = 14;

/* ---------- identity & paths ---------- */

function projectFor(idOrProject) {
  const project = typeof idOrProject === 'string' ? projects.byId(idOrProject) : idOrProject;
  if (!project || !project.id || !project.path) throw new Error('Unknown project.');
  return project;
}

/** Where a project's snapshots live. */
function storeFor(project) {
  return project.kind === 'capture'
    ? path.join(project.path, STORE_DIR)
    : path.join(app.getPath('userData'), 'versions', project.id);
}

const blobPath = (store, sha) => path.join(store, 'blobs', sha.slice(0, 2), sha);

// Windows paths are case-insensitive; a manifest lookup must not miss a file
// just because the URL spelled it differently.
const pathKey = rel => (process.platform === 'win32' ? String(rel).toLowerCase() : String(rel));

const validId = id => typeof id === 'string' && /^[\w][\w.-]{0,120}$/.test(id) && !id.includes('..');

/** UTC stamp with no colons: 2026-08-07T14-30-05Z. Sorts like ISO does. */
function stampFrom(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function uniqueStamp(store) {
  const base = stampFrom();
  let id = base;
  for (let n = 2; fs.existsSync(path.join(store, 'versions', id)); n++) id = `${base}-${n}`;
  return id;
}

/** A path from a manifest or an IPC payload, normalized to forward slashes.
 *  Anything with an empty or dot-leading segment is refused — snapshots never
 *  contain such paths, so asking for one is always an escape attempt. */
function normalizeRel(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts.some(seg => !seg || seg.startsWith('.'))) return null;
  return parts.join('/');
}

/* ---------- walking the working tree ---------- */

const isCommandRuntime = project => projects.runtimeFor(project).kind === 'command';

/** The same skip rules as the library size-walk (dotfiles, node_modules) plus
 *  thumb.png; command runtimes additionally skip their build output — a dev
 *  server regenerating dist/ is not the user editing source. */
function ignoreDirsFor(project) {
  return isCommandRuntime(project) ? BUILD_OUTPUT_DIRS : null;
}

async function walkFiles(root, ignoreDirs) {
  const files = [];
  const walk = async rel => {
    let entries;
    try {
      entries = await fs.promises.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const next = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!ignoreDirs || !ignoreDirs.has(entry.name)) await walk(next);
      } else if (entry.isFile()) {
        if (entry.name === 'thumb.png') continue;
        files.push(next);
      }
    }
  };
  await walk('');
  files.sort();
  return files;
}

/** Hash the working tree. Files changing mid-walk are the normal case on a
 *  live site — a file that can't be read any more is skipped with a warning,
 *  never a reason to abort. */
async function hashWorkingTree(project, signal = null) {
  const files = [];
  for (const rel of await walkFiles(project.path, ignoreDirsFor(project))) {
    if (signal && signal.aborted) throw Object.assign(new Error('Snapshot canceled.'), { canceled: true });
    try {
      const abs = path.join(project.path, rel);
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) continue;
      files.push({ path: rel, sha1: await sha1File(abs), size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch (err) {
      log.warn('snapshot: skipped a file that changed mid-walk', rel, err.message);
    }
  }
  return files;
}

/** Same file set with the same content — sizes/mtimes don't matter. Both
 *  sides are sorted by path (the walk sorts, manifests store sorted). */
function sameFiles(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].sha1 !== b[i].sha1) return false;
  }
  return true;
}

/** Manifest-only diff: {added, removed, changed}, each sorted by path.
 *  Direction reads a → b (b is the newer side). */
function diffManifests(aFiles, bFiles) {
  const aBy = new Map(aFiles.map(f => [f.path, f]));
  const bBy = new Map(bFiles.map(f => [f.path, f]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const f of bFiles) {
    const was = aBy.get(f.path);
    if (!was) added.push({ path: f.path, size: f.size });
    else if (was.sha1 !== f.sha1) changed.push({ path: f.path, sizeA: was.size, sizeB: f.size });
  }
  for (const f of aFiles) {
    if (!bBy.has(f.path)) removed.push({ path: f.path, size: f.size });
  }
  const byPath = (x, y) => x.path.localeCompare(y.path);
  return { added: added.sort(byPath), removed: removed.sort(byPath), changed: changed.sort(byPath) };
}

/* ---------- manifests on disk ---------- */

// Manifests are immutable once written, so caching them is safe; pruning
// evicts what it deletes.
const manifestCache = new Map(); // `${store}|${id}` -> meta

function readMeta(store, id) {
  const key = `${store}|${id}`;
  const hit = manifestCache.get(key);
  if (hit) return hit;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(store, 'versions', id, 'meta.json'), 'utf8'));
  } catch { return null; }
  if (!meta || meta.id !== id || !Array.isArray(meta.files)) return null;
  // Index by normalized path once — pinned serving looks files up per request.
  Object.defineProperty(meta, 'filesByKey', {
    value: new Map(meta.files.map(f => [pathKey(f.path), f])),
    enumerable: false,
  });
  manifestCache.set(key, meta);
  return meta;
}

function listMetas(store) {
  let ids = [];
  try { ids = fs.readdirSync(path.join(store, 'versions')); } catch { return []; }
  return ids
    .filter(validId)
    .sort((a, b) => b.localeCompare(a)) // stamps sort lexicographically; newest first
    .map(id => readMeta(store, id))
    .filter(Boolean);
}

/** One snapshot's manifest, or null/throw. */
function getSnapshot(projectOrId, id, { optional = false } = {}) {
  const project = projectFor(projectOrId);
  const meta = validId(id) ? readMeta(storeFor(project), id) : null;
  if (!meta && !optional) throw new Error('That snapshot no longer exists.');
  return meta;
}

/* ---------- the per-project op queue ---------- */

// One snapshot operation per project at a time (like the shots queue): a
// restore must never interleave with the auto-snapshot it just triggered.
const queues = new Map(); // projectId -> tail promise

function enqueue(projectId, fn) {
  const prev = queues.get(projectId) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(projectId, next.then(() => {}, () => {}));
  return next;
}

/* ---------- core operations ---------- */

async function doCreate(project, { label = '', source = 'manual', signal = null } = {}) {
  if (!SOURCES.has(source)) throw new Error(`Unknown snapshot source: ${source}`);
  const store = storeFor(project);
  const files = await hashWorkingTree(project, signal);

  // Skip if identical: same file set, same hashes as the newest snapshot.
  const latest = listMetas(store)[0] || null;
  if (latest && sameFiles(latest.files, files)) {
    return { unchanged: true, id: latest.id, stats: latest.stats };
  }

  let newBlobs = 0;
  let bytes = 0;
  const kept = [];
  for (const f of files) {
    if (signal && signal.aborted) throw Object.assign(new Error('Snapshot canceled.'), { canceled: true });
    const blob = blobPath(store, f.sha1);
    if (fs.existsSync(blob)) { bytes += f.size; kept.push(f); continue; }
    // Copy to a temp name, re-hash the copy, then rename to its true address —
    // a file rewritten between hash and copy still lands under the hash of
    // what was actually captured, and a crash never leaves a half blob
    // answering to a full blob's name.
    const tmp = path.join(store, 'blobs', `.tmp-${process.pid}-${newBlobs}-${Date.now()}`);
    try {
      await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
      await fs.promises.copyFile(path.join(project.path, f.path), tmp);
      const actual = await sha1File(tmp);
      const st = await fs.promises.stat(tmp);
      const finalBlob = blobPath(store, actual);
      await fs.promises.mkdir(path.dirname(finalBlob), { recursive: true });
      if (fs.existsSync(finalBlob)) await fs.promises.rm(tmp, { force: true });
      else { await fs.promises.rename(tmp, finalBlob); newBlobs++; }
      bytes += st.size;
      kept.push({ ...f, sha1: actual, size: st.size });
    } catch (err) {
      log.warn('snapshot: blob write failed, file dropped from manifest', f.path, err.message);
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }

  const id = uniqueStamp(store);
  const dir = path.join(store, 'versions', id);
  await fs.promises.mkdir(dir, { recursive: true });
  const meta = {
    id,
    label: String(label || '').slice(0, 200),
    source,
    timestamp: new Date().toISOString(),
    files: kept,
    stats: { files: kept.length, bytes, newBlobs },
  };
  // Atomic like every other manifest this app writes: tmp + rename.
  const target = path.join(dir, 'meta.json');
  await fs.promises.writeFile(target + '.tmp', JSON.stringify(meta, null, 2));
  await fs.promises.rename(target + '.tmp', target);
  manifestCache.delete(`${store}|${id}`);
  return { unchanged: false, id, stats: meta.stats };
}

async function doRestore(project, id) {
  const snap = getSnapshot(project, id);
  const store = storeFor(project);
  // Restore churns every file it rewrites; the idle watcher must not read
  // that as editing and snapshot the restore itself.
  suppressCount++;
  try {
    // FIRST: the safety net. Whatever the tree looks like right now survives.
    await doCreate(project, { label: 'Before restore', source: 'pre-restore' });

    const want = new Map(snap.files.map(f => [pathKey(f.path), f]));
    // Delete files the snapshot doesn't have. The walk uses the same skip
    // rules as everything else, so .siteslurp/, dotfiles and node_modules are
    // never even considered — the store cannot delete itself.
    for (const rel of await walkFiles(project.path, ignoreDirsFor(project))) {
      if (!want.has(pathKey(rel))) {
        await fs.promises.rm(path.join(project.path, rel), { force: true }).catch(() => {});
      }
    }
    // Write blobs over files that differ.
    let restored = 0;
    for (const f of snap.files) {
      const target = path.join(project.path, f.path);
      let same = false;
      try { same = (await sha1File(target)) === f.sha1; } catch { /* missing — restore it */ }
      if (same) continue;
      const blob = blobPath(store, f.sha1);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(blob, target);
      restored++;
    }
    return { restored, id: snap.id, label: snap.label };
  } finally {
    suppressCount--;
  }
}

async function doPrune(project) {
  const store = storeFor(project);
  const all = listMetas(store); // newest first
  const keep = new Set();
  all.filter(m => m.source !== 'auto')
    .slice(0, KEEP_DELIBERATE)
    .forEach(m => keep.add(m.id));
  const cutoff = Date.now() - KEEP_AUTO_DAYS * 24 * 60 * 60 * 1000;
  all.filter(m => m.source === 'auto').forEach((m, i) => {
    if (i < KEEP_AUTO_COUNT || Date.parse(m.timestamp) >= cutoff) keep.add(m.id);
  });

  const dropped = all.filter(m => !keep.has(m.id));
  for (const m of dropped) {
    await fs.promises.rm(path.join(store, 'versions', m.id), { recursive: true, force: true });
    manifestCache.delete(`${store}|${m.id}`);
  }
  if (!dropped.length) return { pruned: 0, blobs: 0 };

  // Garbage-collect blobs no surviving manifest references.
  const referenced = new Set();
  for (const m of listMetas(store)) for (const f of m.files) referenced.add(f.sha1);
  let blobs = 0;
  const blobsRoot = path.join(store, 'blobs');
  let buckets = [];
  try { buckets = await fs.promises.readdir(blobsRoot); } catch { /* nothing stored yet */ }
  for (const bucket of buckets) {
    let names = [];
    try { names = await fs.promises.readdir(path.join(blobsRoot, bucket)); } catch { continue; }
    for (const name of names) {
      if (referenced.has(name)) continue;
      await fs.promises.rm(path.join(blobsRoot, bucket, name), { force: true }).catch(() => {});
      blobs++;
    }
  }
  return { pruned: dropped.length, blobs };
}

/* ---------- public API ---------- */

/** Snapshot the project's working tree. Returns {unchanged:true, id} when the
 *  tree is identical to the newest snapshot — auto-snapshot leans on that. */
function createSnapshot(projectOrId, opts = {}) {
  const project = projectFor(projectOrId);
  return enqueue(project.id, () => doCreate(project, opts));
}

/** Manifests only, newest first — no blob reads, cheap enough for every open
 *  of the history modal. */
function listSnapshots(projectOrId) {
  const project = projectFor(projectOrId);
  return listMetas(storeFor(project));
}

/** {added, removed, changed} between two snapshots, or a snapshot and the
 *  working tree (idB === 'working'). Manifest work only, unless the working
 *  tree has to be hashed. */
async function diffSnapshots(projectOrId, idA, idB) {
  const project = projectFor(projectOrId);
  const filesOf = async id => (id === 'working'
    ? hashWorkingTree(project)
    : getSnapshot(project, id).files);
  const [a, b] = [await filesOf(idA), await filesOf(idB)];
  return diffManifests(a, b);
}

/** Locate a file inside a snapshot without reading it: {blobPath, size, sha1}
 *  or null. This is what pinned serving streams from. */
function fileAt(projectOrId, id, relPath) {
  const project = projectFor(projectOrId);
  const meta = getSnapshot(project, id, { optional: true });
  if (!meta) return null;
  const rel = normalizeRel(relPath);
  if (!rel) return null;
  const entry = meta.filesByKey.get(pathKey(rel));
  if (!entry) return null;
  const blob = blobPath(storeFor(project), entry.sha1);
  if (!fs.existsSync(blob)) return null;
  return { blobPath: blob, size: entry.size, sha1: entry.sha1 };
}

/** A file's content at a snapshot — or at 'working' for the live tree, so the
 *  diff view can put both sides next to each other through one door. */
async function readFileAt(projectOrId, id, relPath) {
  const project = projectFor(projectOrId);
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('That is not a file inside the project.');
  if (id === 'working') {
    const abs = path.resolve(project.path, rel);
    if (!abs.startsWith(path.resolve(project.path) + path.sep)) {
      throw new Error('That is not a file inside the project.');
    }
    return fs.promises.readFile(abs);
  }
  const entry = fileAt(project, id, rel);
  if (!entry) throw new Error('That file is not part of this snapshot.');
  return fs.promises.readFile(entry.blobPath);
}

/** Non-destructive restore: snapshots the current tree first (source
 *  'pre-restore'), then makes the working tree match the manifest. Never
 *  touches the store itself. Thumbnail refresh is the caller's job — this
 *  module stays Electron-window-free. */
function restoreSnapshot(projectOrId, id) {
  const project = projectFor(projectOrId);
  return enqueue(project.id, () => doRestore(project, id));
}

function pruneSnapshots(projectOrId) {
  const project = projectFor(projectOrId);
  return enqueue(project.id, () => doPrune(project));
}

/* ---------- auto-snapshot on idle ---------- */

// While a palette apply, restore, extract or video fix is churning files, the
// idle timer firing would snapshot half-finished work — those operations wrap
// themselves in suppressAuto and the timer simply declines to fire.
let suppressCount = 0;

/** Run fn with auto-snapshots suppressed. Nestable. */
async function suppressAuto(fn) {
  suppressCount++;
  try { return await fn(); } finally { suppressCount--; }
}

const watchKey = dir => (process.platform === 'win32'
  ? path.resolve(String(dir)).toLowerCase()
  : path.resolve(String(dir)));

const autoWatchers = new Map(); // watchKey(dir) -> { close }

/** Start watching a hosted project: after a change burst settles and the idle
 *  window passes with no further edits, take an 'auto' snapshot and prune.
 *  The identical-content check makes false alarms free. */
function autoWatch(project, { idleMs = null } = {}) {
  const key = watchKey(project.path);
  if (autoWatchers.has(key)) return;
  let timer = null;
  const handle = watchFolder(project.path, () => {
    clearTimeout(timer);
    const wait = idleMs || (settings.load().autoSnapshotIdleSec * 1000);
    timer = setTimeout(() => {
      if (suppressCount > 0) return; // an app operation is churning files, not the user
      createSnapshot(project.id, { source: 'auto' })
        .then(result => {
          if (result.unchanged) return null;
          log.info('auto-snapshot', project.path, result.id);
          return pruneSnapshots(project.id);
        })
        .catch(err => log.warn('auto-snapshot failed', project.path, err.message));
    }, wait);
    if (timer.unref) timer.unref();
  }, { ignoreDirs: ignoreDirsFor(project), onError: () => autoUnwatch(project.path) });
  autoWatchers.set(key, { close: () => { clearTimeout(timer); handle.close(); } });
}

function autoUnwatch(dir) {
  const key = watchKey(dir);
  const handle = autoWatchers.get(key);
  if (!handle) return;
  handle.close();
  autoWatchers.delete(key);
}

function autoUnwatchAll() {
  for (const handle of autoWatchers.values()) handle.close();
  autoWatchers.clear();
}

module.exports = {
  createSnapshot, listSnapshots, diffSnapshots, readFileAt, fileAt, restoreSnapshot, pruneSnapshots,
  getSnapshot, storeFor,
  autoWatch, autoUnwatch, autoUnwatchAll, suppressAuto,
  // pure helpers, exported for the unit tests
  stampFrom, sameFiles, diffManifests, normalizeRel,
};
