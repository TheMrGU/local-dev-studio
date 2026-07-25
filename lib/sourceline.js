// lib/sourceline.js — map an annotated DOM element back to file and line.
//
// Served pages are static files, so the page URL names the file directly; the
// line is found by searching the file for the element's own markup. Minified
// or generated pages defeat the search — then the annotation keeps the file
// and simply has no line, which the plan calls the graceful degradation.
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

/**
 * @returns {{sourceFile:string, sourceLine:number|null}}
 */
function locateSource(projectPath, annotation) {
  const ctx = annotation.context;
  let file = ctx.sourceFile;
  if (!file) {
    // "/" — the served entry page; resolve it the same way the server does.
    const entry = resolveEntry(projectPath);
    file = entry || '';
  }
  if (!file) return { sourceFile: '', sourceLine: null };

  let text;
  try {
    text = fs.readFileSync(path.join(projectPath, file), 'utf8');
  } catch {
    return { sourceFile: file, sourceLine: null };
  }
  const lines = text.split('\n');

  const opening = /^<[^>]{0,300}>/.exec(ctx.outerHTML || '');
  const idAttr = opening && /\b(id="[^"]+")/.exec(opening[0]);
  const classAttr = opening && /\b(class="[^"]{1,120}")/.exec(opening[0]);

  const line = uniqueLine(lines, opening && opening[0])
    ?? uniqueLine(lines, idAttr && idAttr[1])
    ?? uniqueLine(lines, classAttr && classAttr[1]);

  return { sourceFile: file, sourceLine: line };
}

module.exports = { locateSource };
