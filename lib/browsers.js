// lib/browsers.js — find a Chromium-family browser to drive.
// SingleFile talks CDP, so any Chromium build works. Edge ships with Windows,
// which is what lets SiteSlurp capture on a machine with nothing else installed.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WIN_BASES = [
  process.env.PROGRAMFILES,
  process.env['PROGRAMFILES(X86)'],
  process.env.PROGRAMW6432,
  process.env.LOCALAPPDATA,
].filter(Boolean);

// Ordered by preference — the first hit becomes the default.
const WIN_BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', rel: 'Google\\Chrome\\Application\\chrome.exe' },
  { id: 'edge', name: 'Microsoft Edge', rel: 'Microsoft\\Edge\\Application\\msedge.exe' },
  { id: 'brave', name: 'Brave', rel: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
  { id: 'vivaldi', name: 'Vivaldi', rel: 'Vivaldi\\Application\\vivaldi.exe' },
  { id: 'chromium', name: 'Chromium', rel: 'Chromium\\Application\\chrome.exe' },
  { id: 'chrome-beta', name: 'Chrome Beta', rel: 'Google\\Chrome Beta\\Application\\chrome.exe' },
  { id: 'chrome-canary', name: 'Chrome Canary', rel: 'Google\\Chrome SxS\\Application\\chrome.exe' },
  { id: 'opera', name: 'Opera', rel: 'Programs\\Opera\\opera.exe' },
];

const MAC_BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', abs: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { id: 'edge', name: 'Microsoft Edge', abs: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { id: 'brave', name: 'Brave', abs: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { id: 'chromium', name: 'Chromium', abs: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
];

const LINUX_BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', abs: '/usr/bin/google-chrome' },
  { id: 'chromium', name: 'Chromium', abs: '/usr/bin/chromium' },
  { id: 'chromium-browser', name: 'Chromium', abs: '/usr/bin/chromium-browser' },
  { id: 'edge', name: 'Microsoft Edge', abs: '/usr/bin/microsoft-edge' },
  { id: 'brave', name: 'Brave', abs: '/usr/bin/brave-browser' },
];

function candidates() {
  if (process.platform === 'win32') {
    const out = [];
    for (const b of WIN_BROWSERS) {
      for (const base of WIN_BASES) out.push({ ...b, abs: path.join(base, b.rel) });
    }
    return out;
  }
  return process.platform === 'darwin' ? MAC_BROWSERS : LINUX_BROWSERS;
}

function isExe(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

// Fast synchronous scan of the standard install locations.
function scan() {
  const found = [];
  const seen = new Set();
  for (const c of candidates()) {
    const real = path.normalize(c.abs);
    const key = real.toLowerCase();
    if (seen.has(key) || !isExe(real)) continue;
    seen.add(key);
    found.push({ id: c.id, name: c.name, path: real });
  }
  return found;
}

// Windows records browser locations under App Paths — covers non-standard installs.
function fromRegistry() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const exes = ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe'];
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\';
  return Promise.all(exes.map(exe => new Promise(resolve => {
    execFile('reg', ['query', key + exe, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(stdout);
      const p = m && m[1].replace(/^"|"$/g, '');
      resolve(isExe(p) ? { id: path.basename(exe, '.exe'), name: friendlyName(p), path: path.normalize(p) } : null);
    });
  }))).then(list => list.filter(Boolean));
}

function friendlyName(exePath) {
  const base = path.basename(exePath || '', path.extname(exePath || '')).toLowerCase();
  const known = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', brave: 'Brave', vivaldi: 'Vivaldi', opera: 'Opera', chromium: 'Chromium' };
  return known[base] || base || 'browser';
}

// Everything installed, standard locations first, registry as a backstop.
async function detect() {
  const found = scan();
  if (found.length) return found;
  const viaRegistry = await fromRegistry();
  const seen = new Set();
  return viaRegistry.filter(b => {
    const key = b.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pickDefault() {
  const found = await detect();
  return found.length ? found[0].path : '';
}

module.exports = { detect, pickDefault, isExe, friendlyName };
