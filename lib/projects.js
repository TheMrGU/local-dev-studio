// lib/projects.js — the Studio project registry.
//
// The library used to be a stateless scan of the captures root: a site was
// whatever folder the scan found, and its port was whatever the host manager
// happened to bind that day. Studio needs two facts the scan can't provide —
// folders that live outside the captures root, and ports that survive a
// restart — so those are persisted here. Everything derivable from disk
// (page counts, sizes, thumbnails) deliberately stays out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { resolveEntry } = require('./entry');

const PORT_BASE = 4300;

let cache = null;                      // { version, projects: [...] }
const releasedThisSession = new Set(); // ports freed by a removal — see allocatePort

const file = () => path.join(app.getPath('userData'), 'projects.json');

// Windows paths are case-insensitive; the registry must not hold the same
// folder twice just because Explorer and a dialog spelled it differently.
const keyOf = p => {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function valid(p) {
  return p && typeof p === 'object'
    && typeof p.id === 'string'
    && (p.kind === 'capture' || p.kind === 'local')
    && typeof p.path === 'string' && p.path.trim() !== ''
    && Number.isInteger(p.port);
}

function load() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  cache = { version: 1, projects: Array.isArray(raw.projects) ? raw.projects.filter(valid) : [] };
  return cache;
}

function save() {
  const target = file();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, target); // atomic on the same volume
}

const all = () => load().projects.slice();
const byId = id => load().projects.find(p => p.id === id) || null;
const byPath = dir => {
  const key = keyOf(dir);
  return load().projects.find(p => keyOf(p.path) === key) || null;
};

// Lowest port from 4300 upward that no project holds and no removed project
// held earlier in this session. A just-released port may still be what an open
// browser tab or bookmark points at — handing it to a different project mid-
// session would silently serve the wrong site, so releases only take effect
// after a restart.
function allocatePort() {
  const taken = new Set(load().projects.map(p => p.port));
  let port = PORT_BASE;
  while (taken.has(port) || releasedThisSession.has(port)) port++;
  return port;
}

const makeId = () => 'prj_' + crypto.randomBytes(4).toString('hex');

function makeProject(kind, dir, name, extra = {}) {
  return {
    id: makeId(),
    kind,
    name,
    path: path.resolve(dir),
    entryFile: resolveEntry(dir) || 'index.html',
    port: allocatePort(),
    autoStart: false,
    sourceUrl: '',
    addedAt: new Date().toISOString(),
    tags: [],
    ...extra,
  };
}

/**
 * Reconcile the registry with what the library scan actually found: register
 * extracted captures that are new, drop capture entries whose folder is gone
 * (deleted in the app or in Explorer — either way it no longer exists). Local
 * projects are never pruned here; their folders live outside the scan.
 * @param {{dir:string, name:string, sourceUrl?:string}[]} sites extracted captures only
 */
function syncCaptures(sites) {
  const reg = load();
  let changed = false;
  const seen = new Set();
  for (const site of sites) {
    seen.add(keyOf(site.dir));
    const existing = byPath(site.dir);
    if (existing) {
      if (existing.name !== site.name) { existing.name = site.name; changed = true; }
      continue;
    }
    reg.projects.push(makeProject('capture', site.dir, site.name, { sourceUrl: site.sourceUrl || '' }));
    changed = true;
  }
  reg.projects = reg.projects.filter(p => {
    if (p.kind !== 'capture' || seen.has(keyOf(p.path))) return true;
    releasedThisSession.add(p.port);
    changed = true;
    return false;
  });
  if (changed) save();
}

/** Register a folder the user dropped on the window. Throws with a sentence
 *  the UI can show as-is. */
function addLocal(dir) {
  const resolved = path.resolve(String(dir || '').trim());
  let st = null;
  try { st = fs.statSync(resolved); } catch { /* handled below */ }
  if (!st) throw new Error('That path does not exist.');
  if (!st.isDirectory()) throw new Error('Drop a folder, not a file.');
  if (path.parse(resolved).root === resolved) throw new Error('That is a whole drive — drop a project folder.');
  if (byPath(resolved)) throw new Error('That folder is already in the library.');
  if (!resolveEntry(resolved)) throw new Error('No HTML pages found in that folder.');

  const project = makeProject('local', resolved, path.basename(resolved));
  load().projects.push(project);
  save();
  return project;
}

function remove(id) {
  const reg = load();
  const idx = reg.projects.findIndex(p => p.id === id);
  if (idx === -1) return false;
  releasedThisSession.add(reg.projects[idx].port);
  reg.projects.splice(idx, 1);
  save();
  return true;
}

function update(id, patch) {
  const project = byId(id);
  if (!project) return null;
  for (const key of ['name', 'port', 'autoStart', 'entryFile', 'lastOpened']) {
    if (patch[key] !== undefined) project[key] = patch[key];
  }
  save();
  return project;
}

/** Thumbnails for local projects live in userData, never in the user's own
 *  folder — dropping a repo on the window must not dirty its git status. */
const thumbPath = id => path.join(app.getPath('userData'), 'thumbs', id + '.png');

module.exports = { all, byId, byPath, syncCaptures, addLocal, remove, update, thumbPath, PORT_BASE };
