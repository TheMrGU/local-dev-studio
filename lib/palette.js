// lib/palette.js — scan an extracted site's colors and swap one across every
// css / html / svg file. The client-recolor superpower.
//
// Colors are grouped by their resolved RGB, so #FFF, #ffffff, rgb(255,255,255)
// and rgba(255,255,255,.5) are one swatch. On apply each literal is rewritten in
// its own notation with its own alpha kept, instead of being blanket
// string-replaced (which used to drop alpha and could corrupt other notations).
const fs = require('fs');
const path = require('path');

// Longest-first alternatives with a non-hex lookahead so #abcdef12345 isn't read
// as a color, and a (?<!&) guard so the HTML entity &#123; isn't either.
const RE_COLOR = new RegExp([
  '(?<!&)#[0-9a-fA-F]{8}(?![0-9a-fA-F])',
  '(?<!&)#[0-9a-fA-F]{6}(?![0-9a-fA-F])',
  '(?<!&)#[0-9a-fA-F]{4}(?![0-9a-fA-F])',
  '(?<!&)#[0-9a-fA-F]{3}(?![0-9a-fA-F])',
  '\\b(?:rgba?|hsla?)\\([^()]{1,160}?\\)',
].join('|'), 'g');

const SCANNED_EXT = new Set(['.html', '.htm', '.css', '.svg']);
const UNDO_DIR = '.siteslurp';
const LEGACY_UNDO_DIR = '.sitesnap';
const MAX_UNDO = 10;

/** Sites recolored before the SiteSlurp rename keep their history in
 *  .sitesnap — keep using it there so old and new snapshots stay together. */
function undoBase(dir) {
  try {
    if (fs.statSync(path.join(dir, LEGACY_UNDO_DIR)).isDirectory()) {
      return path.join(dir, LEGACY_UNDO_DIR);
    }
  } catch { /* fresh site */ }
  return path.join(dir, UNDO_DIR);
}

const clamp255 = n => Math.max(0, Math.min(255, Math.round(n)));

/** Every file whose colors we scan and rewrite. */
function siteFiles(dir) {
  const out = [];
  const walk = (rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        // css/ and assets/images/ (for svg logos) are the only nested places colors live.
        if (depth < 3) walk(next, depth + 1);
      } else if (SCANNED_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(next);
      }
    }
  };
  walk('', 0);
  return out;
}

// ---------- color parsing ----------

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = t => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

function numberFrom(token, scale) {
  const m = /^([+-]?[\d.]+)(%)?$/.exec(token.trim());
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  return m[2] ? (value / 100) * scale : value;
}

/** @returns {{r:number,g:number,b:number,a:number,kind:string}|null} */
function parseColor(literal) {
  const text = literal.trim();

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const expand = c => parseInt(c + c, 16);
    if (hex.length === 3) return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: 1, kind: 'hex3' };
    if (hex.length === 4) return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: expand(hex[3]) / 255, kind: 'hex4' };
    if (hex.length === 6) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1, kind: 'hex6' };
    if (hex.length === 8) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: parseInt(hex.slice(6, 8), 16) / 255, kind: 'hex8' };
    return null;
  }

  const fn = /^(rgba?|hsla?)\(([\s\S]*)\)$/i.exec(text);
  if (!fn) return null;
  const isHsl = fn[1].toLowerCase().startsWith('hsl');
  // Both `a, b, c` and the modern `a b c / alpha` syntaxes.
  const [main, alphaPart] = fn[2].split('/');
  const parts = main.trim().split(/\s*,\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let alphaToken = alphaPart !== undefined ? alphaPart : parts[3];
  let a = 1;
  if (alphaToken !== undefined) {
    const alpha = numberFrom(alphaToken, 1);
    if (alpha === null) return null;
    a = Math.max(0, Math.min(1, alpha));
  }

  if (isHsl) {
    const h = numberFrom(parts[0].replace(/deg$/i, ''), 360);
    const s = numberFrom(parts[1], 1);
    const l = numberFrom(parts[2], 1);
    if (h === null || s === null || l === null) return null;
    const [r, g, b] = hslToRgb(h, s > 1 ? s / 100 : s, l > 1 ? l / 100 : l);
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a, kind: 'hsl' };
  }

  const r = numberFrom(parts[0], 255);
  const g = numberFrom(parts[1], 255);
  const b = numberFrom(parts[2], 255);
  if (r === null || g === null || b === null) return null;
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a, kind: 'rgb' };
}

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map(n => clamp255(n).toString(16).padStart(2, '0')).join('');

const keyOf = c => `${c.r},${c.g},${c.b}`;

/** Rewrite one literal to the new color, keeping its notation and alpha. */
function rewrite(original, parsed, target) {
  const { r, g, b } = target;
  const a = parsed.a;
  switch (parsed.kind) {
    case 'hex3':
    case 'hex6': {
      const hex = toHex(target);
      // Keep shorthand only when it stays lossless.
      if (parsed.kind === 'hex3' && hex[1] === hex[2] && hex[3] === hex[4] && hex[5] === hex[6]) {
        return `#${hex[1]}${hex[3]}${hex[5]}`;
      }
      return hex;
    }
    case 'hex4':
    case 'hex8':
      return toHex(target) + clamp255(a * 255).toString(16).padStart(2, '0');
    default: {
      const spaced = !original.includes(',');
      const round = n => (Math.round(n * 1000) / 1000);
      if (a >= 1) {
        return spaced ? `rgb(${r} ${g} ${b})` : `rgb(${r}, ${g}, ${b})`;
      }
      return spaced ? `rgb(${r} ${g} ${b} / ${round(a)})` : `rgba(${r}, ${g}, ${b}, ${round(a)})`;
    }
  }
}

// ---------- public API ----------

function scanPalette(dir, limit = 30) {
  const groups = new Map(); // "r,g,b" -> { count, alphas:Set, hex }
  for (const rel of siteFiles(dir)) {
    let text;
    try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(RE_COLOR)) {
      const parsed = parseColor(match[0]);
      if (!parsed) continue;
      const key = keyOf(parsed);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { key, hex: toHex(parsed), count: 0, alphas: new Set() }));
      group.count++;
      group.alphas.add(Math.round(parsed.a * 100) / 100);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(g => ({ key: g.key, color: g.hex, count: g.count, variants: g.alphas.size }));
}

/**
 * Swap every occurrence of one color for another.
 * @returns {{replaced:number, files:number, undoId:string|null}}
 */
function applyColor(dir, fromKey, toColor) {
  const target = parseColor(String(toColor).trim());
  if (!target) throw new Error(`Not a valid replacement color: ${toColor}`);
  // Accept either an "r,g,b" key or any color literal as the source.
  const wanted = /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(String(fromKey))
    ? String(fromKey).split(',').map(n => clamp255(parseInt(n, 10))).join(',')
    : (() => {
        const parsed = parseColor(String(fromKey).trim());
        if (!parsed) throw new Error(`Not a valid source color: ${fromKey}`);
        return keyOf(parsed);
      })();

  const undoId = newUndoId();
  const snapshotDir = path.join(undoBase(dir), 'undo', undoId);
  let replaced = 0;
  const touched = [];

  for (const rel of siteFiles(dir)) {
    const file = path.join(dir, rel);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let hits = 0;
    const next = text.replace(RE_COLOR, literal => {
      const parsed = parseColor(literal);
      if (!parsed || keyOf(parsed) !== wanted) return literal;
      hits++;
      return rewrite(literal, parsed, target);
    });
    if (!hits) continue;

    const backup = path.join(snapshotDir, rel);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, next);
    replaced += hits;
    touched.push(rel);
  }

  if (!replaced) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    return { replaced: 0, files: 0, undoId: null };
  }

  fs.writeFileSync(path.join(snapshotDir, 'meta.json'), JSON.stringify({
    id: undoId, from: `#${wanted.split(',').map(n => (+n).toString(16).padStart(2, '0')).join('')}`,
    fromKey: wanted, to: toHex(target), replaced, files: touched, at: new Date().toISOString(),
  }, null, 2));
  pruneUndo(dir);
  return { replaced, files: touched.length, undoId };
}

function newUndoId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function undoRoot(dir) {
  return path.join(undoBase(dir), 'undo');
}

function listUndo(dir) {
  let ids;
  try { ids = fs.readdirSync(undoRoot(dir)); } catch { return []; }
  return ids
    .map(id => {
      try { return JSON.parse(fs.readFileSync(path.join(undoRoot(dir), id, 'meta.json'), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Restore the most recent recolor (or a specific one). */
function undoColor(dir, id = null) {
  const entries = listUndo(dir);
  const meta = id ? entries.find(e => e.id === id) : entries[0];
  if (!meta) throw new Error('Nothing to undo for this site.');
  const from = path.join(undoRoot(dir), meta.id);
  let restored = 0;
  for (const rel of meta.files) {
    const backup = path.join(from, rel);
    if (!fs.existsSync(backup)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(backup, path.join(dir, rel));
    restored++;
  }
  fs.rmSync(from, { recursive: true, force: true });
  return { restored, meta };
}

function pruneUndo(dir) {
  const entries = listUndo(dir);
  for (const stale of entries.slice(MAX_UNDO)) {
    fs.rmSync(path.join(undoRoot(dir), stale.id), { recursive: true, force: true });
  }
}

module.exports = { scanPalette, applyColor, undoColor, listUndo, parseColor, toHex, siteFiles };
