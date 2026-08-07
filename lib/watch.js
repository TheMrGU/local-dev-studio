// lib/watch.js — the shared folder watcher behind live reload and auto-snapshots.
//
// Extracted from lib/livereload.js so the versioning engine could subscribe to
// the same change stream instead of running a second fs.watch over the same
// tree. The behaviour here is livereload's, unchanged: recursive watch, 150ms
// debounce so an editor's write burst lands as one event, bookkeeping files
// ignored, and directory-only reports classified conservatively.
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 150;

// Never react to bookkeeping the app itself writes, or to churn nobody serves.
const IGNORED_NAMES = new Set(['thumb.png', 'siteslurp.json', 'sitesnap.json']);

// What a dev server rebuilds on its own. Watching a command-runtime project
// must not read the framework regenerating its output as the user editing
// source. The dotted ones (.next, .nuxt, .astro, .cache) are already covered
// by the dotfile rule below; these are the bare names.
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'vendor', '__pycache__', 'target']);

function ignored(rel, ignoreDirs = null) {
  const parts = String(rel).split(/[\\/]/);
  return parts.some(seg => seg.startsWith('.') || seg === 'node_modules'
    || (ignoreDirs && ignoreDirs.has(seg)))
    || IGNORED_NAMES.has(parts[parts.length - 1]);
}

/**
 * Watch a folder recursively and report change bursts, debounced.
 *
 * @param {string} dir folder to watch
 * @param {(burst: {files: string[], cssOnly: boolean}) => void} onFlush called
 *   once per settled burst; `files` are the changed relative paths (or '*' when
 *   the watcher couldn't name one), `cssOnly` is true when every change was a
 *   stylesheet — livereload uses that for hot-swapping instead of reloading.
 * @param {{ignoreDirs?: Set<string>, onError?: () => void}} [opts] extra
 *   directory names to ignore (build output for command runtimes) and an error
 *   hook — fs.watch dies when the folder is deleted out from under it.
 * @returns {{close: () => void, active: () => boolean}}
 */
function watchFolder(dir, onFlush, { ignoreDirs = null, onError = null } = {}) {
  let watcher = null;
  let timer = null;
  const pending = new Set(); // filenames seen since the last flush

  const flush = () => {
    const seen = [...pending].filter(f => f === '*' || !ignored(f, ignoreDirs));
    pending.clear();
    if (!seen.length) return;
    // Windows reports the parent directory alongside the file that changed
    // inside it. A directory entry says nothing about what to swap, so drop
    // directories from classification — unless they're all we have (something
    // was created or deleted; a full reload is the safe answer). A path that
    // no longer exists is a deleted file and counts as a file.
    const files = seen.filter(f => {
      if (f === '*') return true;
      try { return !fs.statSync(path.join(dir, f)).isDirectory(); } catch { return true; }
    });
    const changed = files.length ? files : seen;
    // '*' means the watcher couldn't name the file — assume the worst.
    const cssOnly = changed.every(f => f !== '*' && f.toLowerCase().endsWith('.css'));
    onFlush({ files: changed, cssOnly });
  };

  const close = () => {
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
    clearTimeout(timer);
  };

  try {
    // Editors save in bursts (write + rename + metadata); the debounce folds
    // a burst into one event so consumers act once, not four times.
    watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
      pending.add(filename ? String(filename) : '*');
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });
    watcher.on('error', () => { close(); if (onError) onError(); });
  } catch { /* folder vanished or unwatchable — the watch just stays quiet */ }

  return { close, active: () => !!watcher };
}

module.exports = { watchFolder, ignored, IGNORED_NAMES, BUILD_OUTPUT_DIRS, DEBOUNCE_MS };
