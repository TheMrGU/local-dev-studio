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

function renderAnnotation(annotation, projectNameFor) {
  const { context: ctx, input } = annotation;
  const lines = [];
  const rating = input.rating !== null ? ` — ${input.rating}/10` : '';
  const axes = input.axes.length ? ` · ${input.axes.join(', ')}` : '';
  const title = ctx.selector || (annotation.scope === 'region' ? 'selected region' : 'annotation');
  lines.push(`## [${input.severity.toUpperCase()}] ${title}${rating}${axes}`);

  if (ctx.selector) lines.push(`**Selector:** \`${ctx.selector}\``);
  if (ctx.selectorFallback && ctx.selectorFallback !== ctx.selector) {
    lines.push(`**Fallback:** \`${ctx.selectorFallback}\``);
  }
  const where = [];
  if (ctx.sourceFile) where.push(`**File:** ${ctx.sourceFile}${ctx.sourceLine ? ':' + ctx.sourceLine : ''}`);
  const vp = viewportLabel(ctx.viewport);
  if (vp) where.push(`**Viewport:** ${vp}`);
  if (where.length) lines.push(where.join(' · '));
  if (ctx.screenshotElement) {
    lines.push(`**Screenshots:** ${ctx.screenshotElement}${ctx.screenshotContext ? ` · context: ${ctx.screenshotContext}` : ''}`);
  }

  const styles = styleLine(ctx.computedStyles);
  if (styles) lines.push('', '**Current styles**', styles);
  if (input.why) lines.push('', '**Why it\'s wrong**', input.why);
  if (input.want) lines.push('', '**What I want**', input.want);

  if (input.referenceSelector || input.referenceProjectId) {
    const refName = projectNameFor(input.referenceProjectId) || 'reference site';
    lines.push('', `**Reference:** ${refName}${input.referenceSelector ? ` — \`${input.referenceSelector}\`` : ''}`);
    const refStyles = styleLine(input.referenceStyles);
    if (refStyles) lines.push(refStyles);
  }
  return lines.join('\n');
}

function renderReviewMd(project, review, annotations, projectNameFor) {
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
    lines.push('', '---', '', renderAnnotation(annotation, projectNameFor));
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
    app: 'SiteSnap',
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
    for (const key of ['screenshotElement', 'screenshotContext']) {
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

module.exports = { exportReview, renderReviewMd, styleLine, sortForReading };
