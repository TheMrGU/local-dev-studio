// lib/capture.js — drive the SingleFile CLI to capture a site, then write the
// _index.html navigation hub and a siteslurp.json manifest.
//
// The CLI ships inside the app and runs on Electron's own Node runtime
// (ELECTRON_RUN_AS_NODE), so there is no "install Node.js" / "npm i -g" step.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { bundledModule, nodeEnv, nodeBinary } = require('./paths');

// Pages the crawler saves when it follows a link straight to a media/binary file —
// junk wrappers, not real pages.
const RE_JUNK_PAGE = /\.(mp4|webm|mov|ogv|mp3|wav|zip|pdf|docx?|xlsx?)\.html$/i;

// Consent/cookie overlays freeze the capture behind a modal and ruin every
// screenshot. These cover the widely deployed CMPs.
const BANNER_SELECTORS = [
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog',
  '#usercentrics-root', '#cmpbox', '#cmpbox2', '.fc-consent-root',
  '#hs-eu-cookie-confirmation', '.osano-cm-window', '.cky-consent-container',
  '#truste-consent-track', '#gdpr-cookie-message', '.cc-window',
  '[id*="cookie-banner"]', '[class*="cookie-banner"]', '[id*="cookie-consent"]',
  '[class*="cookie-consent"]', '[aria-label*="cookie" i]',
].join(',');

function findSingleFile(overridePath) {
  const candidates = [
    overridePath,
    bundledModule('single-file-cli', 'single-file-node.js'),
    // Respect a pre-existing global install too — handy for testing a newer CLI.
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'single-file-cli', 'single-file-node.js'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function timestamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}

function nameFromUrl(url) {
  try {
    return new URL(url).host.replace(/^www\./, '').replace(/[^\w.-]/g, '_') || 'site';
  } catch {
    return 'site';
  }
}

// Reject anything that isn't a plain http(s) page before it reaches the browser.
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a URL to capture.');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error(`That doesn't look like a URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be captured (got ${url.protocol}).`);
  }
  if (!url.hostname) throw new Error(`That doesn't look like a URL: ${raw}`);
  return url.href;
}

// Windows keeps the browser alive as a grandchild of the CLI, so a plain kill()
// leaves it running and holding the profile lock.
function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
  }
}

/**
 * Create and return a fresh folder for a capture.
 * Folder stamps are minute-precision, so two captures of the same site seconds
 * apart would otherwise share a folder and interleave their pages.
 */
function reserveCaptureDir(outRoot, rawName) {
  const name = String(rawName || 'site').replace(/[^\w.-]/g, '_').slice(0, 60) || 'site';
  const base = path.join(outRoot, `${name}_${timestamp()}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) {
    if (n > 99) throw new Error('Too many captures of this site in the same minute.');
    dir = `${base}-${n}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildArgs(opts, dir) {
  const { url, depth, mobile, crawl, browserPath, singleFilePath, headless, stripBanners, waitDelay } = opts;
  const args = [
    singleFilePath,
    url,
    `--browser-executable-path=${browserPath}`,
    `--browser-headless=${headless === false ? 'false' : 'true'}`,
    '--browser-wait-until=networkIdle',
    '--browser-load-max-time=60000',
    '--browser-capture-max-time=60000',
    '--load-deferred-images=true',
    '--load-deferred-images-max-idle-time=3000',
    // Extraction turns inline <style> blocks into real stylesheets; SingleFile's
    // CSP meta tag would then block them from loading.
    '--insert-meta-CSP=false',
    `--output-directory=${dir}`,
    '--filename-template=%if-empty<{url-pathname-flat}|home>.html',
    '--filename-conflict-action=uniquify',
    `--errors-file=${path.join(dir, '.capture-errors.txt')}`,
  ];

  if (mobile) {
    args.push('--browser-mobile-emulation=true', '--browser-device-width=390', '--browser-device-height=844');
  } else {
    args.push('--browser-width=1440', '--browser-height=900');
  }
  if (waitDelay > 0) args.push(`--browser-wait-delay=${waitDelay}`);
  if (stripBanners) args.push(`--removed-elements-selector=${BANNER_SELECTORS}`);
  if (crawl) {
    args.push(
      '--crawl-links=true',
      '--crawl-inner-links-only=true',
      `--crawl-max-depth=${depth}`,
      '--crawl-remove-URL-fragment=true',
      '--crawl-replace-URLs=true',
    );
  }
  return args;
}

/**
 * Capture a site into a fresh timestamped folder.
 * @param {object} opts url, name, depth, mobile, crawl, browserPath, singleFilePath,
 *                      outRoot, headless, stripBanners, waitDelay, signal
 * @param {(line:string)=>void} log
 * @returns {Promise<string>} the capture folder
 */
function captureSite(opts, log = () => {}) {
  const url = normalizeUrl(opts.url);
  const name = opts.name || nameFromUrl(url);
  const dir = reserveCaptureDir(opts.outRoot, name);

  const args = buildArgs({ ...opts, url }, dir);
  log(`> single-file ${url}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(nodeBinary(), args, {
      windowsHide: true,
      env: nodeEnv(),
      detached: process.platform !== 'win32',
    });

    let canceled = false;
    const onAbort = () => { canceled = true; log('  cancelling…'); killTree(proc); };
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); }
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => opts.signal && opts.signal.removeEventListener('abort', onAbort);

    const onOutput = chunk => log(chunk.toString());
    proc.stdout.on('data', onOutput);
    proc.stderr.on('data', onOutput);

    proc.on('error', err => {
      cleanup();
      reject(new Error(`Could not start the capture process: ${err.message}`));
    });

    proc.on('close', () => {
      cleanup();
      let pages = [];
      try {
        pages = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
      } catch { /* folder vanished */ }

      if (canceled) {
        fs.rmSync(dir, { recursive: true, force: true });
        reject(Object.assign(new Error('Capture canceled.'), { canceled: true }));
        return;
      }
      if (!pages.length) {
        const detail = readErrors(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        reject(new Error(detail
          ? `No pages captured. ${detail}`
          : 'No pages captured — the site may block automated browsers. Try turning off headless mode in Advanced options.'));
        return;
      }

      // Drop junk wrapper pages (crawler followed a link straight to a file).
      for (const f of pages) {
        if (RE_JUNK_PAGE.test(f)) {
          fs.rmSync(path.join(dir, f), { force: true });
          log(`  removed junk page ${f}`);
        }
      }
      const errors = readErrors(dir);
      if (errors) log(`  note: ${errors}`);
      fs.rmSync(path.join(dir, '.capture-errors.txt'), { force: true });

      // The crawl starts at the entry URL, so the oldest page file is the site's
      // real homepage. Recording it lets hosting land there instead of the sitemap.
      let entry = null;
      try {
        entry = fs.readdirSync(dir)
          .filter(f => f.endsWith('.html'))
          .map(f => ({ f, born: fs.statSync(path.join(dir, f)).birthtimeMs }))
          .sort((a, b) => a.born - b.born)[0].f;
      } catch { /* serve-time heuristics cover it */ }

      writeManifest(dir, {
        url, name, kind: 'raw', crawl: !!opts.crawl, depth: opts.depth, mobile: !!opts.mobile,
        ...(entry ? { entry } : {}),
      });
      writeIndex(dir, name, url);
      resolve(dir);
    });
  });
}

function readErrors(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, '.capture-errors.txt'), 'utf8').trim();
    if (!text) return '';
    const first = text.split(/\r?\n/).filter(Boolean)[0] || '';
    return first.slice(0, 300);
  } catch {
    return '';
  }
}

function writeManifest(dir, data) {
  const file = path.join(dir, 'siteslurp.json');
  const existing = readManifest(dir) || {};
  const merged = { app: 'SiteSlurp', capturedAt: new Date().toISOString(), ...existing, ...data };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}

function readManifest(dir) {
  // Captures made before the SiteSlurp rename carry a sitesnap.json manifest;
  // writes always go to the new name, so a re-capture upgrades the folder.
  for (const name of ['siteslurp.json', 'sitesnap.json']) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* next */ }
  }
  return null;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function writeIndex(dir, name, url) {
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== '_index.html').sort();
  const rows = pages.map(f => {
    const kb = (fs.statSync(path.join(dir, f)).size / 1024).toFixed(1);
    const label = (f.replace(/\.html$/, '').replace(/^_+/, '').replace(/_/g, ' / ')) || 'Home';
    return `    <li><a href="${encodeURIComponent(f)}">${escapeHtml(label)}</a> <span>${kb} KB &middot; ${escapeHtml(f)}</span></li>`;
  });
  const html = `<!doctype html><meta charset="utf-8">
<title>SiteSlurp capture - ${escapeHtml(name)}</title>
<style>
  :root{color-scheme:dark}
  body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#0A0A0B;color:#A8A8B0}
  h1{font-size:20px;font-weight:600;letter-spacing:-.03em;color:#fff}
  .meta{color:#78787F;font-size:13px;margin-bottom:24px}
  ul{list-style:none;padding:0}
  li{padding:9px 0;border-bottom:1px solid rgba(255,255,255,.09);display:flex;justify-content:space-between;gap:12px}
  a{color:#fff;text-decoration:none} a:hover{text-decoration:underline}
  span{color:#78787F;font-size:13px;white-space:nowrap}
</style>
<h1>SiteSlurp capture &mdash; ${escapeHtml(name)}</h1>
<div class="meta">Source: ${escapeHtml(url)} &middot; ${pages.length} pages &middot; captured ${timestamp()}</div>
<ul>
${rows.join('\n')}
</ul>
`;
  fs.writeFileSync(path.join(dir, '_index.html'), html);
}

module.exports = {
  captureSite, findSingleFile, nameFromUrl, normalizeUrl, timestamp,
  reserveCaptureDir, writeIndex, writeManifest, readManifest,
};
