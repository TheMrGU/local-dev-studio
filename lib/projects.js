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

// Library sections: the user's own shelves for sorting the library (client
// work, concepts, their own sites). A project points at one by id; no id means
// unsorted. A registry written before sections existed starts with these three,
// under fixed ids so they're stable even before the first save.
const DEFAULT_SECTIONS = [
  { id: 'sec_clients', name: 'Client Websites' },
  { id: 'sec_concepts', name: 'Concepts' },
  { id: 'sec_personal', name: 'Personal & Business' },
];
const SECTION_NAME_MAX = 40;

const validSection = s => s && typeof s === 'object'
  && typeof s.id === 'string' && s.id
  && typeof s.name === 'string' && s.name.trim() !== '';

function load() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  const sections = Array.isArray(raw.sections)
    ? raw.sections.filter(validSection).map(s => ({ id: s.id, name: s.name.trim() }))
    : DEFAULT_SECTIONS.map(s => ({ ...s }));
  const sectionIds = new Set(sections.map(s => s.id));
  const projects = (Array.isArray(raw.projects) ? raw.projects.filter(valid) : []).map(p => ({
    // Entries written before live reload existed get the kind's default:
    // a local folder is being edited, a capture should serve byte-exact.
    liveReload: p.kind === 'local',
    // Same treatment for auto-snapshot: captures get zero-config history, a
    // user's own folder (often a git repo with history already) opts in.
    autoSnapshot: p.kind === 'capture',
    ...p,
    // A section deleted by a hand edit of the file leaves the project unsorted.
    section: sectionIds.has(p.section) ? p.section : null,
  }));
  cache = { version: 1, sections, projects };
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
  // A capture is always a folder of files Local Dev Studio wrote itself; only the
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
    section: null,
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
  // beyond a folder that isn't one. The exception is a framework's own build
  // internals: dropping `.next` instead of the app is only ever a miss, and
  // the app it belongs to is sitting right above it.
  const base = path.basename(resolved).toLowerCase();
  if (/^(\.next|\.nuxt|\.astro|\.svelte-kit|\.output|node_modules)$/.test(base)
      && !runtimes.detect(resolved)) {
    const parent = path.dirname(resolved);
    throw new Error(`${path.basename(resolved)} is ${base === 'node_modules' ? 'a dependency folder' : 'build output'}, `
      + `not the project — add ${path.basename(parent)} (the folder above it) instead.`);
  }

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
        // When and from what: a 24/7 link is the files as they were at push
        // time, so the Share window can say how far behind the link is.
        at: typeof patch.deploy.at === 'string' ? patch.deploy.at.slice(0, 40) : null,
        version: patch.deploy.version ? String(patch.deploy.version).slice(0, 60) : null,
        // Whether the review overlay went up with the files, so a re-push keeps it.
        audit: !!patch.deploy.audit,
      }
      : null;
  }
  // Which library section the project sits in; null puts it back in unsorted.
  if (patch.section !== undefined) {
    if (patch.section !== null && !sectionById(patch.section)) {
      throw new Error('That section no longer exists.');
    }
    project.section = patch.section;
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

/* ---------- library sections ---------- */
const sections = () => load().sections.map(s => ({ ...s }));
const sectionById = id => load().sections.find(s => s.id === id) || null;

/** A section name the user typed, or a sentence saying why not. Names are
 *  compared case-insensitively so "Concepts" and "concepts" can't both exist. */
function sectionName(name, exceptId = null) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Give the section a name.');
  if (clean.length > SECTION_NAME_MAX) throw new Error(`Keep section names under ${SECTION_NAME_MAX} characters.`);
  const clash = load().sections.find(s => s.id !== exceptId && s.name.toLowerCase() === clean.toLowerCase());
  if (clash) throw new Error(`There's already a section called "${clash.name}".`);
  return clean;
}

function addSection(name) {
  const section = { id: 'sec_' + crypto.randomBytes(4).toString('hex'), name: sectionName(name) };
  load().sections.push(section);
  save();
  return { ...section };
}

function renameSection(id, name) {
  const section = sectionById(id);
  if (!section) throw new Error('That section no longer exists.');
  section.name = sectionName(name, id);
  save();
  return { ...section };
}

/** Delete a section; its projects go back to unsorted, never anywhere else.
 *  Returns how many projects were in it. */
function removeSection(id) {
  const reg = load();
  const idx = reg.sections.findIndex(s => s.id === id);
  if (idx === -1) return 0;
  reg.sections.splice(idx, 1);
  let moved = 0;
  for (const project of reg.projects) {
    if (project.section === id) { project.section = null; moved++; }
  }
  save();
  return moved;
}

/** Shift a section earlier (offset < 0) or later in the library's order. */
function moveSection(id, offset) {
  const list = load().sections;
  const from = list.findIndex(s => s.id === id);
  if (from === -1) throw new Error('That section no longer exists.');
  const to = Math.max(0, Math.min(list.length - 1, from + Math.sign(Number(offset) || 0)));
  if (to !== from) {
    list.splice(to, 0, list.splice(from, 1)[0]);
    save();
  }
  return sections();
}

module.exports = {
  all, byId, byPath, syncCaptures, addLocal, addAttach, remove, update, thumbPath, runtimeFor, PORT_BASE,
  sections, addSection, renameSection, removeSection, moveSection,
};
