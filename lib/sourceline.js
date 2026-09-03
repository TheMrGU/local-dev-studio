// lib/sourceline.js — map an annotated DOM element back to file and line.
//
// For a capture, served pages are static files: the page URL names the file
// directly and the line is found by searching that file for the element's own
// markup. For a project that generates its pages — Next.js, Django, Laravel —
// the served HTML exists nowhere on disk, so the same question is answered by
// searching the project's own source for something the element carries with it:
// its id, then its text. A match only counts when it is unique in the whole
// tree, because a confidently wrong file is worse than an honest blank.
const fs = require('fs');
const path = require('path');
const { resolveEntry } = require('./entry');

/** A match only counts when it's unique — a wrong line is worse than none. */
function uniqueLine(lines, needle) {
  if (!needle) return null;
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      if (found !== null) return null;
      found = i + 1;
    }
  }
  return found;
}

// Where a generated site keeps the code that produced the page, and what that
// code is written in. Everything else — build output, dependencies, assets — is
// noise that would only produce duplicate matches.
const SOURCE_DIRS = ['src', 'app', 'pages', 'components', 'layouts', 'templates', 'views',
  'resources', 'lib', 'content', 'partials', 'includes', 'themes'];
const SOURCE_EXT = new Set(['.jsx', '.tsx', '.js', '.ts', '.mjs', '.vue', '.svelte', '.astro',
  '.html', '.htm', '.php', '.erb', '.twig', '.hbs', '.ejs', '.liquid', '.blade', '.md', '.mdx', '.py']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'vendor', 'target', '__pycache__', 'coverage', 'public', 'static', 'assets']);
const MAX_FILES = 4000;
const MAX_BYTES = 512 * 1024;

const listCache = new Map(); // projectPath -> { at, files }
const CACHE_MS = 20000;      // long enough for a burst of notes, short enough to notice new files

function sourceFiles(projectPath) {
  const hit = listCache.get(projectPath);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;

  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
      if (files.length >= MAX_FILES) return;
    }
  };
  // Root files first (a single-file PHP or HTML site lives there), then the
  // conventional source folders.
  walk(projectPath, 6);
  for (const name of SOURCE_DIRS) {
    const dir = path.join(projectPath, name);
    try { if (fs.statSync(dir).isDirectory()) walk(dir, 0); } catch { /* not this project */ }
  }

  const unique = [...new Set(files)];
  listCache.set(projectPath, { at: Date.now(), files: unique });
  return unique;
}

/** The one file and line in the project that contains `needle`, or null when
 *  it appears nowhere or more than once. */
function searchProject(projectPath, needle) {
  if (!needle || needle.length < 4) return null;
  let found = null;
  for (const file of sourceFiles(projectPath)) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    if (!text.includes(needle)) continue;
    if (found) return null; // in two files — not an answer
    const lines = text.split('\n');
    const line = uniqueLine(lines, needle);
    found = { sourceFile: path.relative(projectPath, file).split(path.sep).join('/'), sourceLine: line };
  }
  return found;
}

/** The longest single run of text inside the element. A whole innerText would
 *  join across child tags with spaces the source doesn't have; one contiguous
 *  run is what a template actually contains, verbatim. */
function searchableText(annotation) {
  const html = String((annotation.context && annotation.context.outerHTML) || '');
  const runs = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .split(/<[^>]*>/)
    .map(run => run.replace(/\s+/g, ' ').trim())
    .filter(run => run.length >= 6 && !run.includes('&') && !/^[{[]/.test(run));
  const longest = runs.sort((a, b) => b.length - a.length)[0];
  if (!longest) return null;
  // A long paragraph is likely to be wrapped in the source; its opening is not.
  return longest.length > 80 ? longest.slice(0, 60) : longest;
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.entry] the project's chosen entry page
 * @param {boolean} [opts.generated] command/attach runtimes: the served pages
 *   exist nowhere on disk, so the URL path is a route, never a file name.
 *   Only a unique match in the project's own source counts; anything else is
 *   an honest blank, not a guess.
 * @returns {{sourceFile:string, sourceLine:number|null}}
 */
function locateSource(projectPath, annotation, { entry: chosenEntry = null, generated = false } = {}) {
  const ctx = annotation.context;

  if (generated) {
    const open = /^<[^>]{0,300}>/.exec(ctx.outerHTML || '');
    const id = open && /\bid="([^"]+)"/.exec(open[0]);
    const hit = (id && searchProject(projectPath, id[1]))
      || searchProject(projectPath, searchableText(annotation));
    return hit || { sourceFile: '', sourceLine: null };
  }

  let file = ctx.sourceFile;
  if (!file) {
    // "/" — the served entry page; resolve it the same way the server does:
    // the project's chosen entry when it exists, the folder's own otherwise.
    let entry = null;
    if (chosenEntry) {
      try { if (fs.statSync(path.join(projectPath, chosenEntry)).isFile()) entry = chosenEntry; } catch { /* stale choice */ }
    }
    file = entry || resolveEntry(projectPath) || '';
  }

  const opening = /^<[^>]{0,300}>/.exec(ctx.outerHTML || '');
  const idAttr = opening && /\bid="([^"]+)"/.exec(opening[0]);
  const classAttr = opening && /\b(class="[^"]{1,120}")/.exec(opening[0]);

  let text = null;
  if (file) {
    // Belt-and-braces on top of sanitizeContext: never let a stored path escape
    // the project folder, and never read something absurd into memory.
    const resolved = path.resolve(projectPath, file);
    const within = resolved === path.resolve(projectPath)
      || resolved.startsWith(path.resolve(projectPath) + path.sep);
    try {
      if (within && fs.statSync(resolved).size <= 8 * 1024 * 1024) {
        text = fs.readFileSync(resolved, 'utf8');
      }
    } catch { /* generated page */ }
  }

  if (text !== null) {
    const lines = text.split('\n');
    const line = uniqueLine(lines, opening && opening[0])
      ?? uniqueLine(lines, idAttr && idAttr[0])
      ?? uniqueLine(lines, classAttr && classAttr[1]);
    return { sourceFile: file, sourceLine: line };
  }

  // Nothing on disk answers to that URL — the page was generated. Ask the
  // project's source what produced it. The element's own id is the strongest
  // signal (frameworks pass it through verbatim); its text is next, because a
  // heading reads the same in JSX, Blade and a Django template.
  const hit = (idAttr && searchProject(projectPath, idAttr[1]))
    || searchProject(projectPath, searchableText(annotation));
  if (hit) return hit;
  return { sourceFile: file, sourceLine: null };
}

module.exports = { locateSource };
