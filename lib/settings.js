// lib/settings.js — user settings, validated on the way in and written atomically
// so a crash mid-write can't leave a corrupt JSON file that bricks the next launch.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const DEFAULTS = {
  capturesRoot: '',        // resolved on first run
  browserPath: '',         // resolved on first run by browser detection
  singleFilePath: '',      // '' = use the bundled copy
  defaultPort: 8008,
  openAfterHost: true,
  // seconds of quiet after an edit burst before a hosted site auto-snapshots
  autoSnapshotIdleSec: 45,
  // remembered capture options
  crawl: true,
  depth: 2,
  mobile: false,
  fixVideos: true,
  headless: true,
  stripBanners: true,
  waitDelay: 0,
  // ui state
  tab: 'extractor',        // which of the two tabs the window opens on
  sort: 'recent',
  showRaw: false,
  windowBounds: null,
  seenWelcome: false,
};

const CLAMPS = {
  defaultPort: [1024, 65535],
  depth: [1, 6],
  waitDelay: [0, 30000],
  autoSnapshotIdleSec: [10, 600],
};

let cache = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

function defaultCapturesRoot() {
  // Keep using folders from earlier lives of this tool when they're already
  // there, so an existing library shows up on first launch: the pre-app
  // crawl.ps1 / extract.ps1 scripts folder, then the pre-rename SiteSnap root.
  // Those earlier lives only ever existed on Windows — elsewhere there is no
  // legacy to probe for and the answer is simply ~/Documents/SiteSlurp.
  if (process.platform === 'win32') {
    const legacies = [
      path.join(os.homedir(), 'Desktop', 'Projects', 'Mockups', 'SiteReferences'),
      path.join(app.getPath('documents'), 'SiteSnap'),
    ];
    for (const legacy of legacies) {
      try { if (fs.statSync(legacy).isDirectory()) return legacy; } catch { /* not a returning user */ }
    }
  }
  return path.join(app.getPath('documents'), 'SiteSlurp');
}

function sanitize(raw) {
  const out = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof fallback === 'boolean') out[key] = !!value;
    else if (typeof fallback === 'number') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = CLAMPS[key] || [-Infinity, Infinity];
      out[key] = Math.min(hi, Math.max(lo, n));
    } else if (typeof fallback === 'string') out[key] = String(value);
    else out[key] = value;
  }
  if (!out.capturesRoot) out.capturesRoot = defaultCapturesRoot();
  if (!['recent', 'name', 'size'].includes(out.sort)) out.sort = 'recent';
  if (!['extractor', 'studio'].includes(out.tab)) out.tab = 'extractor';
  if (out.windowBounds && typeof out.windowBounds !== 'object') out.windowBounds = null;
  return out;
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch { /* first run, or unreadable — fall back to defaults */ }
  // Pre-1.1 builds stored the browser as chromePath.
  if (!raw.browserPath && raw.chromePath) raw.browserPath = raw.chromePath;
  cache = sanitize(raw);
  return cache;
}

function save(patch) {
  const merged = sanitize({ ...load(), ...patch });
  const target = file();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, target);   // atomic on the same volume
  cache = merged;
  return merged;
}

module.exports = { load, save, defaultCapturesRoot, DEFAULTS };
