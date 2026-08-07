// lib/audits.js — [PRO] automated audits: accessibility (axe-core) and an
// internal broken-link crawl, run against the hosted port on demand.
//
// Findings become ordinary annotations — same severity/axis schema, same
// store, same pins, same REVIEW.md — just flagged `auto` so nobody mistakes a
// robot's opinion for the reviewer's. Nothing here runs automatically; the
// "Run audits" button (toolbar, card menu, palette) is the only trigger, and
// main.js claims the browser-job lock around it.
//
// axe-core is vendored, pinned and unmodified:
//   vendor/axe.min.js — axe-core 4.13.0 (MPL-2.0)
//   sha256 c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1
// Recorded in THIRD-PARTY-NOTICES.md. This is the plan's sanctioned exception
// to the zero-dependency rule: a pinned file, not an npm dependency.
//
// This module is the feature's single entry point (runAudits) — Phase 7's
// edition gate lands on the one call site in main.js.
const fs = require('fs');
const path = require('path');
const http = require('http');
const log = require('./logger');

const AXE_VERSION = '4.13.0';
const AXE_FILE = path.join(__dirname, '..', 'vendor', 'axe.min.js');

const MAX_PAGES = 30;   // pages crawled for links
const MAX_LINKS = 300;  // distinct internal targets HEAD-checked
const AXE_PAGES = 5;    // pages given the full axe pass (each is a page load)
const MAX_FINDINGS = 60; // annotations one run may add — a broken site needs a summary, not 4000 pins

/* ---------- pure helpers (unit-tested) ---------- */

/** Every href in the page's <a> tags, in order, unresolved. */
function extractLinks(html) {
  const links = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
    if (href) links.push(href);
  }
  return links;
}

/** Resolve an href against the page it sits on; answer the site-local path to
 *  check, or null for anything external, non-http or ours. */
function internalPath(href, pagePath) {
  if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) return null;
  let url;
  try { url = new URL(href, 'http://slurp.local' + (pagePath || '/')); } catch { return null; }
  if (url.origin !== 'http://slurp.local') return null; // absolute link elsewhere
  if (url.pathname.startsWith('/__siteslurp__/')) return null;
  return url.pathname + url.search;
}

/** axe impact → the review's severity scale. */
function severityFor(impact) {
  if (impact === 'critical') return 'blocking';
  if (impact === 'serious') return 'should-fix';
  return 'nitpick';
}

/** Dedupe key: re-running audits must not stack identical pins. */
function findingKey(pageUrl, selector, why) {
  return `${pageUrl}|${selector}|${why}`;
}

/* ---------- fetching the hosted site ---------- */

function request(port, method, reqPath) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, timeout: 15000 }, res => {
      const html = /text\/html/.test(res.headers['content-type'] || '');
      if (method === 'HEAD' || !html) {
        res.resume();
        resolve({ status: res.statusCode, html: null });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); resolve({ status: res.statusCode, html: null }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, html: null }); });
    req.on('error', () => resolve({ status: 0, html: null }));
    req.end();
  });
}

/** Crawl internal pages from '/' and HEAD-check every internal link.
 *  @returns {{pages: string[], broken: {page:string, href:string, target:string, status:number}[]}} */
async function crawlLinks(port, onProgress) {
  const pages = [];                 // HTML pages found, crawl order
  const queued = new Set(['/']);
  const queue = ['/'];
  const linksAt = new Map();        // target path -> [{page, href}]
  while (queue.length && pages.length < MAX_PAGES) {
    const pagePath = queue.shift();
    const { status, html } = await request(port, 'GET', pagePath);
    if (status >= 400 || !html) continue;
    pages.push(pagePath);
    if (onProgress) onProgress(`crawling ${pagePath}`);
    for (const href of extractLinks(html)) {
      const target = internalPath(href, pagePath);
      if (!target) continue;
      if (!linksAt.has(target)) {
        if (linksAt.size >= MAX_LINKS) continue;
        linksAt.set(target, []);
      }
      const seen = linksAt.get(target);
      if (!seen.some(s => s.page === pagePath)) seen.push({ page: pagePath, href });
      // Only path-y targets that look like pages join the crawl queue.
      const bare = target.split('?')[0];
      if (!queued.has(bare) && (bare.endsWith('/') || /\.html?$/i.test(bare) || !/\.[a-z0-9]{1,8}$/i.test(bare))) {
        queued.add(bare);
        queue.push(bare);
      }
    }
  }
  const broken = [];
  for (const [target, sources] of linksAt) {
    const { status } = await request(port, 'HEAD', target);
    if (status === 0 || status >= 400) {
      for (const { page, href } of sources) broken.push({ page, href, target, status });
    }
  }
  return { pages, broken };
}

/* ---------- axe in an offscreen window ---------- */

let axeCache = null;
function axeSource() {
  if (!axeCache) axeCache = fs.readFileSync(AXE_FILE, 'utf8');
  return axeCache;
}

// Serialize the page's violations down to what an annotation needs; the
// overlay's own host is excluded so we never audit ourselves.
const AXE_RUN = `axe.run(document, {
  resultTypes: ['violations'],
  exclude: [['#__ss-review-host'], ['#__ss_pin_banner']],
}).then(r => r.violations.map(v => ({
  id: v.id, impact: v.impact || 'minor', help: v.help, helpUrl: v.helpUrl,
  nodes: v.nodes.slice(0, 8).map(n => ({
    target: (Array.isArray(n.target) ? n.target : [n.target])
      .map(t => (Array.isArray(t) ? t.join(' ') : String(t))).join(' '),
    html: String(n.html || '').slice(0, 500),
    failureSummary: String(n.failureSummary || '').slice(0, 400),
  })),
})))`;

async function axePage(port, pagePath) {
  const { BrowserWindow } = require('electron'); // lazy: keeps the module loadable under plain node
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    const loaded = win.webContents.loadURL(`http://127.0.0.1:${port}${pagePath}`);
    await Promise.race([loaded.catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
    await new Promise(r => setTimeout(r, 600)); // fonts, late layout
    await win.webContents.executeJavaScript(axeSource() + ';true', true);
    return await win.webContents.executeJavaScript(AXE_RUN, true);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/* ---------- the run ---------- */

/**
 * Audit a hosted project and file the findings as [auto] annotations.
 * @param {object} project registry entry
 * @param {{port: number, reviews: object, onProgress?: (msg:string)=>void}} deps
 * @returns {Promise<{pages:number, axeViolations:number, brokenLinks:number, added:number, skipped:number}>}
 */
async function runAudits(project, { port, reviews, onProgress = () => {} }) {
  const existing = new Set(reviews.listAnnotations(project.id)
    .filter(a => a.auto && !a.resolved)
    .map(a => findingKey(a.context.pageUrl || '/', a.context.selector || '', a.input.why || '')));
  let added = 0;
  let skipped = 0;
  const file = (scope, context, input) => {
    const key = findingKey(context.pageUrl || '/', context.selector || '', input.why || '');
    if (existing.has(key) || added >= MAX_FINDINGS) { skipped++; return; }
    existing.add(key);
    reviews.addAnnotation(project.id, { scope, context, input, auto: true });
    added++;
  };

  onProgress('Checking internal links…');
  const { pages, broken } = await crawlLinks(port, onProgress);
  for (const b of broken) {
    file('element', {
      selector: `a[href="${b.href}"]`,
      pageUrl: b.page,
    }, {
      severity: 'should-fix',
      why: `Broken internal link: "${b.href}" answers ${b.status ? 'HTTP ' + b.status : 'nothing'}.`,
      want: 'Point it at an existing page or remove it.',
    });
  }

  let axeViolations = 0;
  const audited = pages.slice(0, AXE_PAGES);
  for (const pagePath of audited.length ? audited : ['/']) {
    onProgress(`Accessibility scan: ${pagePath}`);
    let violations = [];
    try {
      violations = await axePage(port, pagePath) || [];
    } catch (err) {
      log.warn('axe failed', pagePath, err.message);
      continue;
    }
    for (const v of violations) {
      for (const node of v.nodes) {
        axeViolations++;
        file('element', {
          selector: node.target,
          outerHTML: node.html,
          pageUrl: pagePath,
        }, {
          severity: severityFor(v.impact),
          axes: /contrast|color/.test(v.id) ? ['color'] : [],
          why: `${v.help} (axe: ${v.id}). ${node.failureSummary}`.trim(),
          want: `Fix per ${v.helpUrl}`,
        });
      }
    }
  }

  const summary = { pages: pages.length, axeViolations, brokenLinks: broken.length, added, skipped };
  log.info('audits', project.name, JSON.stringify(summary));
  return summary;
}

module.exports = {
  runAudits, extractLinks, internalPath, severityFor, findingKey,
  AXE_VERSION, AXE_FILE,
};
