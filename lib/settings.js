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
  keepScripts: false,
  headless: true,
  stripBanners: true,
  waitDelay: 0,
  scrollPage: false,       // simulate scrolling so lazy-loaded content settles
  useProfile: false,       // capture with the persistent signed-in profile
  cookiesFile: '',         // Netscape/JSON cookie export handed to the capture
  captureHeaders: '',      // extra "Name: value" request headers, one per line
  includeGlobs: '',        // crawl/sitemap scope: only pathnames matching these
  excludeGlobs: '',        // crawl/sitemap scope: skip pathnames matching these
  maxPages: 100,           // crawl/sitemap page cap
  // ui state
  tab: 'extractor',        // which of the three tabs the window opens on
  showcase: null,          // ShowCase director options (lib/showcase normalises on use)
  sort: 'recent',
  showRaw: false,
  libSection: 'all',       // which library section the Studio tab shows ('all' = every one)
  collapsedSections: [],   // section ids folded shut in the "all" view
  windowBounds: null,
  seenWelcome: false,
};

const CLAMPS = {
  defaultPort: [1024, 65535],
  depth: [1, 6],
  waitDelay: [0, 30000],
  autoSnapshotIdleSec: [10, 600],
  maxPages: [1, 1000],
};

let cache = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

function defaultCapturesRoot() {
  // Keep using folders from earlier lives of this tool when they're already
  // there, so an existing library shows up on first launch: the pre-app
  // crawl.ps1 / extract.ps1 scripts folder, then the pre-rename SiteSnap root.
  // Those earlier lives only ever existed on Windows — elsewhere there is no
  // legacy to probe for and the answer is simply ~/Documents/Local Dev Studio.
  if (process.platform === 'win32') {
    const legacies = [
      path.join(os.homedir(), 'Desktop', 'Projects', 'Mockups', 'SiteReferences'),
      path.join(app.getPath('documents'), 'SiteSlurp'),
      path.join(app.getPath('documents'), 'SiteSnap'),
    ];
    for (const legacy of legacies) {
      try { if (fs.statSync(legacy).isDirectory()) return legacy; } catch { /* not a returning user */ }
    }
  }
  // 2.8 and earlier defaulted to ~/Documents/NightShyft Studio on every
  // platform, 2.9 to ~/Documents/OpenDevStudio.
  for (const name of ['OpenDevStudio', 'NightShyft Studio']) {
    const previous = path.join(app.getPath('documents'), name);
    try { if (fs.statSync(previous).isDirectory()) return previous; } catch { /* not a returning user */ }
  }
  return path.join(app.getPath('documents'), 'Local Dev Studio');
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
  if (!out.libSection) out.libSection = 'all';
  out.collapsedSections = Array.isArray(out.collapsedSections)
    ? out.collapsedSections.filter(id => typeof id === 'string').slice(0, 100)
    : [];
  if (!['extractor', 'studio', 'showcase'].includes(out.tab)) out.tab = 'extractor';
  if (out.showcase && typeof out.showcase !== 'object') out.showcase = null;
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
