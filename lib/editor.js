// lib/editor.js — find the user's code editor for "Open in VS Code".
// Standard install locations per platform first, then the CLI shims on PATH as
// a backstop (POSIX only — the Windows shims are .cmd files, which spawn()
// refuses without a shell, and the install table already covers Windows).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WIN_CANDIDATES = [
  ['LOCALAPPDATA', 'Programs\\Microsoft VS Code\\Code.exe'],
  ['PROGRAMFILES', 'Microsoft VS Code\\Code.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft VS Code\\Code.exe'],
  ['LOCALAPPDATA', 'Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe'],
  ['LOCALAPPDATA', 'Programs\\cursor\\Cursor.exe'],
];

// The .app binaries accept a folder argument just like the CLI does.
const MAC_CANDIDATES = [
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
  '/Applications/Cursor.app/Contents/MacOS/Cursor',
];

const LINUX_CANDIDATES = [
  '/usr/bin/code',
  '/usr/local/bin/code',
  '/snap/bin/code',
  '/var/lib/flatpak/exports/bin/com.visualstudio.code',
  '/usr/bin/code-insiders',
  '/usr/bin/codium',
  '/usr/bin/cursor',
];

const PATH_NAMES = ['code', 'cursor', 'code-insiders', 'codium'];

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function fromPath(name) {
  try {
    const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)[0].trim();
    return isFile(found) ? found : null;
  } catch {
    return null;
  }
}

/** @returns {string|null} path to an editor executable, or null when none found */
function findEditor() {
  if (process.platform === 'win32') {
    for (const [envKey, rel] of WIN_CANDIDATES) {
      const base = process.env[envKey];
      if (!base) continue;
      const full = path.join(base, rel);
      if (isFile(full)) return full;
    }
    return null;
  }
  const candidates = process.platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;
  for (const abs of candidates) if (isFile(abs)) return abs;
  for (const name of PATH_NAMES) {
    const found = fromPath(name);
    if (found) return found;
  }
  return null;
}

module.exports = { findEditor };
