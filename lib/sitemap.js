// lib/sitemap.js — turn a sitemap.xml link into the list of pages it names.
//
// A sitemap is either a <urlset> of pages or a <sitemapindex> pointing at more
// sitemaps; both carry their entries in <loc> elements. The parsing is a
// hand-rolled regex pass on purpose (zero-dependency culture): sitemaps are
// machine-written XML with a two-element vocabulary, not documents that need a
// real parser.
/* global fetch, AbortSignal */
'use strict';

const MAX_BYTES = 20 * 1024 * 1024; // a sitemap bigger than this is not a sitemap
const MAX_CHILD_SITEMAPS = 25;      // sitemapindex fan-out cap

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
const decodeEntities = s => s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, m => ENTITIES[m]);

/** Does this URL look like a sitemap? ("/sitemap.xml", "/wp-sitemap.xml",
 *  "/sitemap_index.xml" — an .xml pathname with "sitemap" in it.) */
function isSitemapUrl(url) {
  try {
    const pathname = new URL(String(url)).pathname.toLowerCase();
    return pathname.endsWith('.xml') && pathname.includes('sitemap');
  } catch {
    return false;
  }
}

/** One sitemap document → { kind: 'urlset'|'index', urls: [...] }.
 *  Only http(s) entries survive; entities and CDATA wrappers are unwrapped. */
function parseSitemap(xml) {
  const text = String(xml || '');
  const kind = /<sitemapindex[\s>]/i.test(text) ? 'index' : 'urlset';
  const urls = [];
  const re = /<loc\s*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc\s*>/gi;
  let m;
  while ((m = re.exec(text))) {
    const url = decodeEntities(m[1].trim());
    if (/^https?:\/\//i.test(url)) urls.push(url);
  }
  return { kind, urls };
}

async function fetchText(url, signal) {
  // A cancel from the run panel and a 30s network timeout both end the fetch.
  const timeout = AbortSignal.timeout(30000);
  const res = await fetch(url, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'user-agent': 'Mozilla/5.0 (Local Dev Studio)' },
  });
  if (!res.ok) throw new Error(`The sitemap at ${url} answered ${res.status}.`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_BYTES) throw new Error(`The sitemap at ${url} is too large to be a sitemap.`);
  return res.text();
}

/**
 * Fetch a sitemap (following a sitemapindex one level down) and return the
 * page URLs it lists — deduped (fragments dropped), capped at `limit`.
 * @param {string} url the sitemap.xml address
 * @param {object} opts { signal, limit, fetchText } — fetchText injectable for tests
 */
async function fetchSitemapUrls(url, { signal = null, limit = 5000, fetchText: ft = fetchText } = {}) {
  const first = parseSitemap(await ft(url, signal));
  let pages = [];
  if (first.kind === 'index') {
    if (!first.urls.length) throw new Error('That sitemap index lists no sitemaps.');
    for (const child of first.urls.slice(0, MAX_CHILD_SITEMAPS)) {
      if (pages.length >= limit) break;
      if (signal && signal.aborted) throw Object.assign(new Error('Capture canceled.'), { canceled: true });
      try {
        const parsed = parseSitemap(await ft(child, signal));
        if (parsed.kind === 'urlset') pages.push(...parsed.urls);
      } catch { /* one broken child sitemap doesn't sink the rest */ }
    }
  } else {
    pages = first.urls;
  }
  const seen = new Set();
  const out = [];
  for (const page of pages) {
    const clean = page.replace(/#.*$/, '');
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error('That sitemap lists no pages.');
  return out;
}

module.exports = { isSitemapUrl, parseSitemap, fetchSitemapUrls };
