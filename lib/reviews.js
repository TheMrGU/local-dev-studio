// lib/reviews.js — the annotation store behind Review Mode.
//
// One JSON file per project under userData/reviews/<projectId>/store.json,
// screenshots beside it in shots/. Annotations carry a reviewId so history
// accumulates; nothing is deleted by exporting. The one rule this layer
// enforces — not just the UI — is the plan's: a rating without a written
// reason is noise an agent can't act on, so it never saves.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const SCOPES = new Set(['element', 'region', 'page', 'global']);
const SEVERITIES = new Set(['blocking', 'should-fix', 'nitpick']);
const AXES = ['layout', 'typography', 'color', 'spacing', 'copy', 'motion', 'responsive'];
const MIN_WHY = 10;

const root = () => path.join(app.getPath('userData'), 'reviews');
const projectDir = projectId => path.join(root(), String(projectId));
const storeFile = projectId => path.join(projectDir(projectId), 'store.json');
const shotsDir = projectId => path.join(projectDir(projectId), 'shots');

const stores = new Map(); // projectId -> parsed store

function loadStore(projectId) {
  if (stores.has(projectId)) return stores.get(projectId);
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(storeFile(projectId), 'utf8')); } catch { /* fresh */ }
  const store = {
    version: 1,
    reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
    annotations: Array.isArray(raw.annotations) ? raw.annotations : [],
  };
  stores.set(projectId, store);
  return store;
}

function saveStore(projectId) {
  const store = stores.get(projectId);
  if (!store) return;
  const target = storeFile(projectId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, target);
}

/** The review that annotations join right now: today's unexported review,
 *  created on first use. Closing the window keeps it — the plan's "session
 *  persists" rule falls out of never discarding unexported reviews. */
function activeReview(projectId) {
  const store = loadStore(projectId);
  const open = store.reviews.find(r => !r.exportedAt);
  if (open) return open;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = store.reviews.filter(r => r.id.includes(day)).length + 1;
  const review = {
    id: `rev_${day}_${String(seq).padStart(2, '0')}`,
    startedAt: new Date().toISOString(),
    exportedAt: null,
  };
  store.reviews.push(review);
  saveStore(projectId);
  return review;
}

/** Throws with a user-facing sentence when the input breaks the contract. */
function validateInput(input, scope) {
  const out = {
    rating: null,
    severity: 'should-fix',
    axes: [],
    why: '',
    want: '',
    referenceProjectId: input.referenceProjectId || null,
    referenceSelector: input.referenceSelector || null,
    referenceStyles: input.referenceStyles || null,
    referenceHTML: input.referenceHTML || null,
  };

  if (input.rating !== undefined && input.rating !== null && input.rating !== '') {
    const n = Math.round(Number(input.rating));
    if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('Rating must be 1–10.');
    out.rating = n;
  }
  if (input.severity !== undefined) {
    if (!SEVERITIES.has(input.severity)) throw new Error('Severity must be blocking, should-fix or nitpick.');
    out.severity = input.severity;
  }
  if (input.axes !== undefined) {
    if (!Array.isArray(input.axes)) throw new Error('Axes must be a list.');
    out.axes = input.axes.filter(a => AXES.includes(a));
  }
  out.why = String(input.why || '').trim();
  out.want = String(input.want || '').trim();

  // The rule that makes exports actionable: a number alone teaches the agent
  // nothing. Blocked here so no future UI can forget it.
  if (out.rating !== null && out.why.length < MIN_WHY) {
    throw new Error('A rating needs a reason — say what\'s wrong (at least a short sentence) before saving.');
  }
  if (!SCOPES.has(scope)) throw new Error('Unknown annotation scope.');
  if (out.rating === null && !out.why && !out.want) {
    throw new Error('An empty annotation says nothing — add a rating with a reason, or at least a note.');
  }
  return out;
}

function addAnnotation(projectId, { scope, context, input, auto = false, author = '', pinnedVersion = '' }) {
  const clean = validateInput(input || {}, scope);
  const store = loadStore(projectId);
  const review = activeReview(projectId);
  const annotation = {
    id: 'ann_' + crypto.randomBytes(4).toString('hex'),
    projectId,
    reviewId: review.id,
    scope,
    createdAt: new Date().toISOString(),
    resolved: false,
    orphaned: false,
    // Audit findings carry the flag so every surface (pins, REVIEW.md) can
    // say "a robot noticed this", never passing it off as the reviewer.
    ...(auto ? { auto: true } : {}),
    // Who wrote it. Local annotations are the reviewer's own ("me"); guest
    // review (share links) records the name the guest gave.
    author: String(author || '').trim().slice(0, 60) || 'me',
    // The snapshot a pinned guest was looking at when the note was saved —
    // context for the owner, empty for notes made against live.
    ...(pinnedVersion ? { pinnedVersion: String(pinnedVersion).slice(0, 40) } : {}),
    context: sanitizeContext(context || {}),
    input: clean,
  };
  store.annotations.push(annotation);
  saveStore(projectId);
  return annotation;
}

// Context is captured by our own overlay, but it still arrives over HTTP from
// a page that hosts third-party code — keep only known fields, bound sizes.
function sanitizeContext(ctx) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const box = b => (b && typeof b === 'object'
    ? { x: num(b.x) || 0, y: num(b.y) || 0, w: num(b.w) || 0, h: num(b.h) || 0 }
    : null);
  return {
    selector: str(ctx.selector, 500),
    selectorFallback: str(ctx.selectorFallback, 1000),
    outerHTML: str(ctx.outerHTML, 4000),
    sourceFile: str(ctx.sourceFile, 300),
    sourceLine: num(ctx.sourceLine),
    viewport: ctx.viewport && typeof ctx.viewport === 'object'
      ? { width: num(ctx.viewport.width) || 0, height: num(ctx.viewport.height) || 0, label: str(ctx.viewport.label, 20) }
      : null,
    pageUrl: str(ctx.pageUrl, 500),
    boundingBox: box(ctx.boundingBox),
    computedStyles: ctx.computedStyles && typeof ctx.computedStyles === 'object'
      ? Object.fromEntries(Object.entries(ctx.computedStyles).slice(0, 40)
        .map(([k, v]) => [String(k).slice(0, 50), String(v).slice(0, 200)]))
      : {},
    screenshotElement: str(ctx.screenshotElement, 300),
    screenshotContext: str(ctx.screenshotContext, 300),
    // The verification loop's "after" pair — shot on resolve, shown beside
    // the originals in the pin popup and REVIEW.md.
    screenshotAfterElement: str(ctx.screenshotAfterElement, 300),
    screenshotAfterContext: str(ctx.screenshotAfterContext, 300),
    // A reference image attached through the overlay's same-origin upload
    // endpoint — a relative shots/ path, like the screenshots above.
    referenceImage: str(ctx.referenceImage, 300),
    // The Studio Browser console at the moment the note was saved: at most 20
    // one-line strings, attached only when errors were present.
    consoleTail: Array.isArray(ctx.consoleTail)
      ? ctx.consoleTail.slice(0, 20).map(line => str(line, 500)).filter(Boolean)
      : [],
    parentSection: str(ctx.parentSection, 200),
    siblingCount: num(ctx.siblingCount),
  };
}

function getAnnotation(projectId, id) {
  return loadStore(projectId).annotations.find(a => a.id === id) || null;
}

function updateAnnotation(projectId, id, patch) {
  const store = loadStore(projectId);
  const annotation = store.annotations.find(a => a.id === id);
  if (!annotation) throw new Error('That annotation no longer exists.');
  if (patch.input) {
    annotation.input = validateInput({ ...annotation.input, ...patch.input }, annotation.scope);
  }
  if (patch.context) {
    annotation.context = sanitizeContext({ ...annotation.context, ...patch.context });
  }
  for (const key of ['resolved', 'orphaned', 'stale']) {
    if (patch[key] !== undefined) annotation[key] = !!patch[key];
  }
  if (patch.resolvedRating !== undefined) {
    const n = Math.round(Number(patch.resolvedRating));
    if (Number.isFinite(n) && n >= 1 && n <= 10) annotation.resolvedRating = n;
  }
  // What the fixer says they changed (the MCP resolve carries it) — kept as
  // its own field so it never masquerades as the reviewer's words.
  if (patch.resolvedNote !== undefined) {
    annotation.resolvedNote = String(patch.resolvedNote || '').slice(0, 500);
  }
  // The verification loop's pixel score: 0 = nothing changed visually.
  if (patch.diffScore !== undefined) {
    const score = Number(patch.diffScore);
    if (Number.isFinite(score)) annotation.diffScore = Math.min(1, Math.max(0, score));
  }
  if (patch.resolved) annotation.resolvedAt = new Date().toISOString();
  saveStore(projectId);
  return annotation;
}

function deleteAnnotation(projectId, id) {
  const store = loadStore(projectId);
  const idx = store.annotations.findIndex(a => a.id === id);
  if (idx === -1) return false;
  store.annotations.splice(idx, 1);
  saveStore(projectId);
  return true;
}

function listAnnotations(projectId, { reviewId = null } = {}) {
  const store = loadStore(projectId);
  return store.annotations.filter(a => !reviewId || a.reviewId === reviewId);
}

function listReviews(projectId) {
  return loadStore(projectId).reviews.slice();
}

function markExported(projectId, reviewId, folder) {
  const store = loadStore(projectId);
  const review = store.reviews.find(r => r.id === reviewId);
  if (review) {
    review.exportedAt = new Date().toISOString();
    review.exportFolder = folder;
    saveStore(projectId);
  }
}

/** Global-scope complaints that keep coming back — heard in three or more
 *  distinct reviews — are candidates for promotion to a standing preference.
 *  Grouping is deliberately crude (shared axes, else the complaint's opening
 *  words): it only has to catch "I said this again", not understand prose. */
function recurringGlobals(projectId) {
  const globals = loadStore(projectId).annotations.filter(a => a.scope === 'global');
  const groups = new Map();
  for (const annotation of globals) {
    const key = annotation.input.axes.length
      ? 'axes:' + annotation.input.axes.slice().sort().join('+')
      : 'words:' + annotation.input.why.toLowerCase().split(/\s+/).slice(0, 4).join(' ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(annotation);
  }
  const candidates = [];
  for (const list of groups.values()) {
    const distinctReviews = new Set(list.map(a => a.reviewId));
    if (distinctReviews.size < 3) continue;
    const latest = list[list.length - 1];
    candidates.push({
      text: [latest.input.why, latest.input.want].filter(Boolean).join(' ').slice(0, 300),
      count: distinctReviews.size,
    });
  }
  return candidates;
}

module.exports = {
  activeReview, addAnnotation, getAnnotation, updateAnnotation, deleteAnnotation,
  listAnnotations, listReviews, markExported, recurringGlobals, shotsDir, validateInput,
  AXES, MIN_WHY,
};
