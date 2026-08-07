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
const runtimes = require('./runtimes');

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
  const projects = (Array.isArray(raw.projects) ? raw.projects.filter(valid) : []).map(p => ({
    // Entries written before live reload existed get the kind's default:
    // a local folder is being edited, a capture should serve byte-exact.
    liveReload: p.kind === 'local',
    // Same treatment for auto-snapshot: captures get zero-config history, a
    // user's own folder (often a git repo with history already) opts in.
    autoSnapshot: p.kind === 'capture',
    ...p,
  }));
  cache = { version: 1, projects };
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

const STATIC_RUNTIME = { kind: 'static', id: 'static', label: 'Static files' };
const UNSET_RUNTIME = { kind: 'command', id: 'custom', label: 'Custom command', command: '' };

function makeProject(kind, dir, name, extra = {}) {
  // A capture is always a folder of files SiteSlurp wrote itself; only the
  // user's own folders get asked what they are.
  const runtime = kind === 'capture'
    ? STATIC_RUNTIME
    : runtimes.normalize(runtimes.detect(dir)) || { ...UNSET_RUNTIME };
  return {
    id: makeId(),
    kind,
    name,
    path: path.resolve(dir),
    entryFile: resolveEntry(dir) || 'index.html',
    port: allocatePort(),
    autoStart: false,
    // A dev server does its own hot reload; the file watcher is for hand-edited
    // static folders, which is what a local project used to mean.
    liveReload: kind === 'local' && runtime.kind === 'static',
    // Captures get zero-config version history; local folders opt in — git
    // users already have history, and we don't nag them about ours.
    autoSnapshot: kind === 'capture',
    runtime,
    sourceUrl: '',
    addedAt: new Date().toISOString(),
    tags: [],
    ...extra,
  };
}

/** The runtime to host a project with. Entries written before runtimes existed
 *  have none stored — those are captures or folders of HTML, so static is the
 *  right answer and re-detecting on every read would only be slower. */
function runtimeFor(project) {
  if (!project) return { ...STATIC_RUNTIME };
  return runtimes.normalize(project.runtime) || { ...STATIC_RUNTIME };
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
  // A folder no longer has to contain HTML: a Next.js app, a Django site or a
  // PHP shop has none until something runs. What it needs is a way to be
  // served, and "custom command" is always a way — so nothing is refused here
  // beyond a folder that isn't one.

  const project = makeProject('local', resolved, path.basename(resolved));
  load().projects.push(project);
  save();
  return project;
}

/**
 * Register a project that fronts a dev server the user already runs (attach
 * mode). The folder is optional: with one, sourceline and snapshots work like
 * any local project; without one there is nothing on disk to read, so a
 * placeholder folder is created under userData and the entry is flagged
 * `attachOnly` — the UI hides everything file-shaped for those.
 * @param {{port:number, folder?:string|null, name?:string}} opts
 */
function addAttach({ port, folder = null, name = '' }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Attach needs the port your dev server listens on.');
  }
  const runtime = { ...runtimes.ATTACH_RUNTIME, appPort: port };
  if (folder) {
    const resolved = path.resolve(String(folder).trim());
    let st = null;
    try { st = fs.statSync(resolved); } catch { /* handled below */ }
    if (!st || !st.isDirectory()) throw new Error('That folder does not exist.');
    if (byPath(resolved)) throw new Error('That folder is already in the library — set its runtime to attach instead.');
    const project = makeProject('local', resolved, name || path.basename(resolved), { runtime, liveReload: false });
    load().projects.push(project);
    save();
    return project;
  }
  // No folder: the project is only "a port that answers". The placeholder dir
  // keeps every folder-shaped code path (thumbs, stats) from special-casing.
  const id = makeId();
  const placeholder = path.join(app.getPath('userData'), 'attached', id);
  fs.mkdirSync(placeholder, { recursive: true });
  const project = {
    ...makeProject('local', placeholder, name || `localhost:${port}`, { runtime, liveReload: false }),
    id,
    attachOnly: true,
    autoSnapshot: false,
  };
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

// The https door gets its own stable port per project, from a base far from
// the http range so the two never fight over the same numbers.
const HTTPS_PORT_BASE = 8443;
function allocateHttpsPort() {
  const taken = new Set();
  for (const p of load().projects) {
    taken.add(p.port);
    if (Number.isInteger(p.httpsPort)) taken.add(p.httpsPort);
  }
  let port = HTTPS_PORT_BASE;
  while (taken.has(port)) port++;
  return port;
}

function update(id, patch) {
  const project = byId(id);
  if (!project) return null;
  for (const key of ['name', 'port', 'autoStart', 'liveReload', 'autoSnapshot', 'entryFile', 'lastOpened']) {
    if (patch[key] !== undefined) project[key] = patch[key];
  }
  // [PRO] serve this project over https too (5.2). The port is allocated once
  // and kept, so the https address stays bookmarkable.
  if (patch.https !== undefined) {
    project.https = !!patch.https;
    if (project.https && !Number.isInteger(project.httpsPort)) project.httpsPort = allocateHttpsPort();
  }
  // [PRO] where this project publishes (5.3): remembered so the next publish
  // updates the same site instead of minting a new one.
  if (patch.deploy !== undefined) {
    project.deploy = patch.deploy && typeof patch.deploy === 'object'
      ? {
        provider: String(patch.deploy.provider || '').slice(0, 40),
        siteId: String(patch.deploy.siteId || '').slice(0, 120),
        url: String(patch.deploy.url || '').slice(0, 300),
      }
      : null;
  }
  if (patch.runtime !== undefined) {
    const runtime = runtimes.normalize(patch.runtime);
    if (!runtime) throw new Error('That runtime is not something we can serve.');
    // Attach runs nothing, so it needs a port instead of a command.
    if (runtime.id === 'attach') {
      if (!Number.isInteger(runtime.appPort) || runtime.appPort < 1) {
        throw new Error('Attach needs the port your dev server listens on — set "App port".');
      }
    } else if (runtime.kind === 'command' && !String(runtime.command || '').trim()) {
      throw new Error('A command runtime needs a command to run.');
    }
    project.runtime = runtime;
    // The file watcher and a dev server's own reload fight over the page.
    if (runtime.kind === 'command') project.liveReload = false;
  }
  save();
  return project;
}

/** Thumbnails for local projects live in userData, never in the user's own
 *  folder — dropping a repo on the window must not dirty its git status. */
const thumbPath = id => path.join(app.getPath('userData'), 'thumbs', id + '.png');

module.exports = {
  all, byId, byPath, syncCaptures, addLocal, addAttach, remove, update, thumbPath, runtimeFor, PORT_BASE,
};
