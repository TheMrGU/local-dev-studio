// lib/verify.js — [PRO] the verification loop: prove a resolve actually
// changed pixels, and notice when a noted element drifted before the reviewer
// looks again.
//
// On resolve, the element is re-shot through the same offscreen queue the
// original screenshots used, and the two PNGs are compared per-pixel in main —
// nativeImage gives us raw BGRA, and counting pixels that moved beyond a
// threshold is all a "did anything visibly change" answer needs. No image
// library, no dependency.
//
// This module is the single entry point for the feature: main.js wires
// verifyResolved into the resolve flow and checkStale into review start, and
// Phase 7's edition gate lands at exactly those two calls.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { captureAnnotationShots } = require('./shots');
const log = require('./logger');

// How far apart two pixels' BGR channels must be (summed) to count as changed:
// low enough to catch a real restyle, high enough to shrug at antialiasing.
const CHANNEL_THRESHOLD = 30;
// Above this share of changed pixels, a stale check calls the element changed.
const STALE_RATIO = 0.02;

/**
 * Per-pixel compare of two BGRA bitmaps. Pure math, unit-testable.
 * Differing dimensions are themselves a visual change: the overlapping region
 * is compared and every pixel outside it counts as different.
 * @returns {number} 0..1 — the share of pixels that changed
 */
function diffBitmaps(a, b, wA, hA, wB, hB, threshold = CHANNEL_THRESHOLD) {
  const w = Math.min(wA, wB);
  const h = Math.min(hA, hB);
  const total = Math.max(wA * hA, wB * hB);
  if (!total || !w || !h) return 1;
  let changed = 0;
  for (let y = 0; y < h; y++) {
    let ia = (y * wA) * 4;
    let ib = (y * wB) * 4;
    for (let x = 0; x < w; x++, ia += 4, ib += 4) {
      const d = Math.abs(a[ia] - b[ib])
        + Math.abs(a[ia + 1] - b[ib + 1])
        + Math.abs(a[ia + 2] - b[ib + 2]); // BGR; alpha is always opaque here
      if (d > threshold) changed++;
    }
  }
  return (changed + (total - w * h)) / total;
}

/** The 0..1 diff score between two PNGs on disk, or null when either is
 *  unreadable. Electron-only (nativeImage) — required lazily so the pure math
 *  above stays testable under plain node. */
function diffFiles(fileA, fileB) {
  const { nativeImage } = require('electron');
  const a = nativeImage.createFromPath(fileA);
  const b = nativeImage.createFromPath(fileB);
  const sa = a.getSize();
  const sb = b.getSize();
  if (!sa.width || !sa.height || !sb.width || !sb.height) return null;
  return diffBitmaps(a.toBitmap(), b.toBitmap(), sa.width, sa.height, sb.width, sb.height);
}

/**
 * A visual annotation was just resolved: re-shoot its element as the "after",
 * score it against the "before", and store both on the annotation so the pin
 * popup and REVIEW.md can show the pair. Failures degrade to a resolve
 * without verification — never to an error the resolver sees.
 * @param {object} project registry entry
 * @param {object} annotation the (already resolved) annotation
 * @param {{port: number|null, reviews: object, shotsDir: string}} deps
 */
async function verifyResolved(project, annotation, { port, reviews, shotsDir }) {
  try {
    if (!port) return null;
    if (annotation.scope !== 'element' && annotation.scope !== 'region') return null;
    const shots = await captureAnnotationShots(annotation, { port, shotsDir, prefix: 'after_' });
    if (!shots) return null;
    const patch = { context: {} };
    if (shots.el) patch.context.screenshotAfterElement = 'shots/' + shots.el;
    if (shots.ctx) patch.context.screenshotAfterContext = 'shots/' + shots.ctx;
    // Score element against element; fall back to context crops when the
    // original never got an element shot.
    const before = annotation.context.screenshotElement || annotation.context.screenshotContext;
    const after = shots.el ? 'shots/' + shots.el : (shots.ctx ? 'shots/' + shots.ctx : null);
    if (before && after) {
      const score = diffFiles(
        path.join(shotsDir, path.basename(before)),
        path.join(shotsDir, path.basename(after)),
      );
      if (score !== null) patch.diffScore = score;
    }
    reviews.updateAnnotation(project.id, annotation.id, patch);
    log.info('verify', annotation.id,
      patch.diffScore === undefined ? 'no score' : `diff ${(patch.diffScore * 100).toFixed(1)}%`);
    return patch.diffScore === undefined ? null : patch.diffScore;
  } catch (err) {
    log.warn('verify failed', annotation.id, err.message);
    return null;
  }
}

/**
 * Review mode just started: cheaply re-shoot each open annotation's element
 * and badge the ones that changed visually since they were noted ("changed
 * since noted" on the pin). Shots land in a temp folder and die there; only
 * the boolean survives, on the annotation.
 * @param {object} project registry entry
 * @param {{port: number|null, reviews: object, shotsDir: string}} deps
 */
async function checkStale(project, { port, reviews, shotsDir }) {
  if (!port) return;
  const open = reviews.listAnnotations(project.id).filter(a =>
    !a.resolved && a.scope === 'element' && a.context.screenshotElement);
  if (!open.length) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurp-stale-'));
  try {
    for (const annotation of open) {
      try {
        const shots = await captureAnnotationShots(annotation, { port, shotsDir: tmp });
        // No shot usually means the selector is gone — the orphan check owns
        // that story; staleness only speaks about elements that still exist.
        if (!shots || !shots.el) continue;
        const score = diffFiles(
          path.join(shotsDir, path.basename(annotation.context.screenshotElement)),
          path.join(tmp, shots.el),
        );
        if (score === null) continue;
        const stale = score > STALE_RATIO;
        if (stale !== !!annotation.stale) {
          reviews.updateAnnotation(project.id, annotation.id, { stale });
          if (stale) log.info('stale annotation', annotation.id, `diff ${(score * 100).toFixed(1)}%`);
        }
      } catch (err) {
        log.warn('stale check failed', annotation.id, err.message);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { diffBitmaps, diffFiles, verifyResolved, checkStale, CHANNEL_THRESHOLD, STALE_RATIO };
