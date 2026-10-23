// lib/reviewExport.js — turn a review session into the folder that IS the
// product: REVIEW.md for the agent to read, annotations.json for tooling,
// calibration.md for taste, shots/ for eyes. The hand-written sample in
// docs/review-sample/ is the contract; this generates that shape.
const fs = require('fs');
const path = require('path');
const reviews = require('./reviews');
const calibration = require('./calibration');

const SEVERITY_ORDER = ['blocking', 'should-fix', 'nitpick'];

const safeName = name => String(name || 'site')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')   // eslint-disable-line no-control-regex
  .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  .toLowerCase() || 'site';

function viewportLabel(vp) {
  if (!vp || !vp.width) return null;
  const size = `${vp.width}×${vp.height || '?'}`;
  return vp.label ? `${size} (${vp.label})` : size;
}

/** "Inter, sans-serif 400 · 42px/48px · letter-spacing 0px · color #6b7280 · …" */
function styleLine(styles) {
  if (!styles || !Object.keys(styles).length) return null;
  const parts = [];
  if (styles.fontFamily || styles.fontWeight) {
    parts.push([styles.fontFamily, styles.fontWeight].filter(Boolean).join(' '));
  }
  if (styles.fontSize) parts.push(styles.lineHeight ? `${styles.fontSize}/${styles.lineHeight}` : styles.fontSize);
  if (styles.letterSpacing && styles.letterSpacing !== 'normal') parts.push(`letter-spacing ${styles.letterSpacing}`);
  if (styles.color) parts.push(`color ${styles.color}`);
  if (styles.backgroundColor && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(styles.backgroundColor)) {
    parts.push(`background ${styles.backgroundColor}`);
  } else if (styles.backgroundColor) {
    parts.push('background transparent');
  }
  if (styles.margin) parts.push(`margin ${styles.margin}`);
  if (styles.padding) parts.push(`padding ${styles.padding}`);
  if (styles.display) parts.push(`display ${styles.display}`);
  return parts.length ? parts.join(' · ') : null;
}

/** " · 12% of pixels changed" / the gentle zero flag, or nothing. */
function diffLabel(diffScore) {
  if (typeof diffScore !== 'number') return '';
  if (diffScore === 0) return ' · verified: nothing changed visually';
  return ` · ${Math.max(1, Math.round(diffScore * 100))}% of pixels changed`;
}

function sortForReading(annotations) {
  return annotations.slice().sort((a, b) => {
    const sev = SEVERITY_ORDER.indexOf(a.input.severity) - SEVERITY_ORDER.indexOf(b.input.severity);
    if (sev !== 0) return sev;
    // Ascending rating within a severity: the worst offenders first. Unrated
    // notes read after rated ones.
    const ra = a.input.rating === null ? 99 : a.input.rating;
    const rb = b.input.rating === null ? 99 : b.input.rating;
    return ra - rb;
  });
}

/**
 * One annotation as the self-contained markdown block REVIEW.md is made of —
 * and, verbatim, what "Copy for agent" puts on the clipboard. One renderer,
 * two doors; they must never drift apart.
 * @param {object} annotation {scope, context, input}
 * @param {(id:string)=>string|null} [projectNameFor]
 * @param {{devServer?: boolean}} [opts] command/attach runtimes have no file
 *   to point at — say so instead of leaving a blank that reads like an oversight.
 */
function renderAnnotation(annotation, projectNameFor = () => null, opts = {}) {
  const { context: ctx, input } = annotation;
  const lines = [];
  const rating = input.rating !== null ? ` — ${input.rating}/10` : '';
  const axes = input.axes.length ? ` · ${input.axes.join(', ')}` : '';
  const title = ctx.selector || (annotation.scope === 'region' ? 'selected region' : 'annotation');
  // Audit findings wear the badge in the heading — a robot's finding must
  // never read as the reviewer's judgment.
  const auto = annotation.auto ? ' [auto]' : '';
  lines.push(`## [${input.severity.toUpperCase()}]${auto} ${title}${rating}${axes}`);

  if (ctx.selector) lines.push(`**Selector:** \`${ctx.selector}\``);
  if (ctx.selectorFallback && ctx.selectorFallback !== ctx.selector) {
    lines.push(`**Fallback:** \`${ctx.selectorFallback}\``);
  }
  const where = [];
  if (ctx.sourceFile) where.push(`**File:** ${ctx.sourceFile}${ctx.sourceLine ? ':' + ctx.sourceLine : ''}`);
  else if (opts.devServer) where.push('**File:** selector-only (dev server)');
  const vp = viewportLabel(ctx.viewport);
  if (vp) where.push(`**Viewport:** ${vp}`);
  // A note from someone else (guest review over a share link) says whose it is;
  // the reviewer's own notes stay unadorned.
  if (annotation.author && annotation.author !== 'me') where.push(`**By:** ${annotation.author} (guest)`);
  if (annotation.pinnedVersion) where.push(`**Noted on snapshot:** ${annotation.pinnedVersion}`);
  if (where.length) lines.push(where.join(' · '));
  if (ctx.screenshotElement) {
    lines.push(`**Screenshots:** ${ctx.screenshotElement}${ctx.screenshotContext ? ` · context: ${ctx.screenshotContext}` : ''}`);
  }
  if (ctx.screenshotAfterElement) {
    lines.push(`**After (on resolve):** ${ctx.screenshotAfterElement}`
      + (ctx.screenshotAfterContext ? ` · context: ${ctx.screenshotAfterContext}` : '')
      + diffLabel(annotation.diffScore));
  }

  const styles = styleLine(ctx.computedStyles);
  if (styles) lines.push('', '**Current styles**', styles);

  if (ctx.outerHTML) {
    const snippet = ctx.outerHTML.length > 600 ? ctx.outerHTML.slice(0, 600) + '…' : ctx.outerHTML;
    lines.push('', '**Markup**', '```html', snippet, '```');
  }

  if (input.why) lines.push('', '**Why it\'s wrong**', input.why);
  if (input.want) lines.push('', '**What I want**', input.want);

  if (input.referenceSelector || input.referenceProjectId) {
    const refName = projectNameFor(input.referenceProjectId) || 'reference site';
    lines.push('', `**Reference:** ${refName}${input.referenceSelector ? ` — \`${input.referenceSelector}\`` : ''}`);
    const refStyles = styleLine(input.referenceStyles);
    if (refStyles) lines.push(refStyles);
  }
  if (ctx.referenceImage) lines.push('', `**Reference image:** ${ctx.referenceImage}`);

  // A stack trace next to "this button is broken" is half the fix. Attached by
  // Studio Browser when the console had errors at the moment the note was saved.
  if (Array.isArray(ctx.consoleTail) && ctx.consoleTail.length) {
    lines.push('', `**Console at the time** (last ${ctx.consoleTail.length})`, '```', ...ctx.consoleTail, '```');
  }
  return lines.join('\n');
}

function renderReviewMd(project, review, annotations, projectNameFor) {
  // Command/attach projects serve generated pages — file:line honesty (3.1).
  const devServer = !!(project.runtime && project.runtime.kind === 'command');
  const open = annotations.filter(a => !a.resolved);
  const rated = open.filter(a => a.input.rating !== null);
  const overall = rated.length
    ? Math.round(rated.reduce((sum, a) => sum + a.input.rating, 0) / rated.length)
    : null;
  const counts = SEVERITY_ORDER
    .map(sev => [sev, open.filter(a => a.input.severity === sev).length])
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${sev}`).join(' · ');
  const viewports = [...new Set(open.map(a => viewportLabel(a.context.viewport)).filter(Boolean)
    .map(v => v.split(' ')[0]))];

  const lines = [`# Review: ${project.name} — ${review.id.slice(4, 8)}-${review.id.slice(8, 10)}-${review.id.slice(10, 12)}`];
  lines.push(`**Overall ${overall !== null ? overall + '/10' : 'unrated'}**${counts ? ' · ' + counts : ''}`);
  lines.push(`Reviewed at ${viewports.length ? viewports.join(' and ') : 'default viewport'}. `
    + 'See calibration.md for how this reviewer\'s ratings');
  lines.push('map to real examples, and annotations.json for machine-readable data.');

  // Sitewide constraints before individual fixes — the agent reads top-down.
  const globals = sortForReading(open.filter(a => a.scope === 'global'));
  if (globals.length) {
    lines.push('', '## Global notes');
    for (const g of globals) {
      const note = [g.input.why, g.input.want].filter(Boolean).join(' ');
      lines.push(`- ${note} _(${g.input.severity}${g.input.rating !== null ? `, ${g.input.rating}/10` : ''})_`);
    }
  }
  const pages = sortForReading(open.filter(a => a.scope === 'page'));
  if (pages.length) {
    lines.push('', '## Page notes');
    for (const p of pages) {
      const note = [p.input.why, p.input.want].filter(Boolean).join(' ');
      lines.push(`- \`${p.context.pageUrl || '/'}\` — ${note} _(${p.input.severity}${p.input.rating !== null ? `, ${p.input.rating}/10` : ''})_`);
    }
  }

  for (const annotation of sortForReading(open.filter(a => a.scope === 'element' || a.scope === 'region'))) {
    lines.push('', '---', '', renderAnnotation(annotation, projectNameFor, { devServer }));
  }

  // The verification loop's receipts: what got fixed, with before/after pairs
  // and the pixel score. A zero score is called out — "resolved" with no
  // visible change deserves a second look, not silence.
  const resolved = annotations.filter(a => a.resolved);
  if (resolved.length) {
    lines.push('', '## Resolved this review');
    for (const a of resolved) {
      const what = a.context.selector || (a.scope === 'region' ? 'selected region' : a.scope + ' note');
      const journey = a.input.rating && a.resolvedRating ? ` (${a.input.rating} → ${a.resolvedRating})` : '';
      const pair = a.context.screenshotElement && a.context.screenshotAfterElement
        ? ` — before ${a.context.screenshotElement} → after ${a.context.screenshotAfterElement}` : '';
      const note = a.resolvedNote ? ` — fixer's note: ${a.resolvedNote}` : '';
      lines.push(`- \`${what}\`${journey}${pair}${diffLabel(a.diffScore)}${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the export folder and mark the review exported.
 * @returns {{folder:string, files:number}}
 */
function exportReview({ project, capturesRoot, reviewId = null, projectNameFor = () => null }) {
  const all = reviews.listAnnotations(project.id);
  const review = reviewId
    ? reviews.listReviews(project.id).find(r => r.id === reviewId)
    : reviews.activeReview(project.id);
  if (!review) throw new Error('No review session to export.');
  const annotations = all.filter(a => a.reviewId === review.id);
  if (!annotations.length) throw new Error('Nothing to export — this review has no annotations yet.');

  const day = review.id.slice(4, 12);
  const folder = path.join(capturesRoot, '_reviews', `review-${safeName(project.name)}-${day}`);
  fs.mkdirSync(path.join(folder, 'shots'), { recursive: true });

  fs.writeFileSync(path.join(folder, 'REVIEW.md'),
    renderReviewMd(project, review, annotations, projectNameFor));
  fs.writeFileSync(path.join(folder, 'calibration.md'), calibration.renderMarkdown());
  fs.writeFileSync(path.join(folder, 'annotations.json'), JSON.stringify({
    app: 'Local Dev Studio',
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, kind: project.kind, path: project.path },
    review,
    calibration: calibration.load(),
    annotations,
  }, null, 2));

  // Only the screenshots this review references, nothing else from the store.
  let files = 3;
  const shotsSource = reviews.shotsDir(project.id);
  for (const annotation of annotations) {
    for (const key of ['screenshotElement', 'screenshotContext',
      'screenshotAfterElement', 'screenshotAfterContext', 'referenceImage']) {
      const rel = annotation.context[key];
      if (!rel) continue;
      const src = path.join(shotsSource, path.basename(rel));
      try {
        fs.copyFileSync(src, path.join(folder, 'shots', path.basename(rel)));
        files++;
      } catch { /* shot was never captured — the markdown still stands alone */ }
    }
  }

  reviews.markExported(project.id, review.id, folder);
  return { folder, files };
}

module.exports = { exportReview, renderReviewMd, renderAnnotation, styleLine, sortForReading };
