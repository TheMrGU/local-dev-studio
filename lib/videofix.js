// lib/videofix.js — SingleFile doesn't capture <video> sources; it leaves an empty
// <source> plus a small overlay link to the remote file. This downloads each such
// video into assets/media/, wires it into the emptied <video>, adds `muted` so
// autoplay isn't blocked, and removes the overlay link.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const RE_OVERLAY = /<a href=(["']?)(https?:\/\/[^"'\s>]+\.(?:mp4|webm|mov|ogv|m4v))\1[^>]*>[\s\S]*?<\/a>/g;

// Plenty of CDNs 403 a request with no User-Agent.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8',
};

const MAX_BYTES = 512 * 1024 * 1024;

function downloadOnce(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects: ' + url)); return; }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: HEADERS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadOnce(new URL(res.headers.location, url).href, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      if (Number(res.headers['content-length']) > MAX_BYTES) {
        res.destroy();
        reject(new Error('Video larger than 512 MB — skipped'));
        return;
      }
      const out = fs.createWriteStream(dest);
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { res.destroy(); out.destroy(); reject(new Error('Video larger than 512 MB — skipped')); }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(bytes)));
      out.on('error', err => { fs.rmSync(dest, { force: true }); reject(err); });
      res.on('error', err => { out.destroy(); fs.rmSync(dest, { force: true }); reject(err); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
  });
}

async function download(url, dest, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await downloadOnce(url, dest);
    } catch (err) {
      lastError = err;
      fs.rmSync(dest, { force: true });
    }
  }
  throw lastError;
}

/**
 * @param {string} dir extracted site folder
 * @param {(line:string)=>void} log
 * @returns {Promise<number>} number of <video> elements wired up
 */
async function fixVideos(dir, log = () => {}) {
  let fixed = 0;
  let pages;
  try {
    pages = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  } catch {
    return 0;
  }

  for (const name of pages) {
    const file = path.join(dir, name);
    let html = fs.readFileSync(file, 'utf8');
    const anchors = [...html.matchAll(RE_OVERLAY)];
    if (!anchors.length) continue;

    // Work back-to-front so earlier indices stay valid while we splice.
    for (const m of anchors.reverse()) {
      const url = m[2];
      const base = decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/[^\w.-]/g, '_').slice(-120) || 'video.mp4';
      const mediaDir = path.join(dir, 'assets', 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const dest = path.join(mediaDir, base);

      if (!fs.existsSync(dest)) {
        log(`  downloading ${url}`);
        try {
          const bytes = await download(url, dest);
          log(`  got ${(bytes / 1048576).toFixed(1)} MB`);
        } catch (err) {
          log(`  FAILED ${url} — ${err.message}`);
          continue; // leave the overlay link so the reference isn't lost
        }
      }
      const rel = `assets/media/${base}`;

      // 1) Remove the overlay anchor.
      html = html.slice(0, m.index) + html.slice(m.index + m[0].length);

      // 2) Wire the local file into the <video> the overlay was sitting on
      //    (SingleFile places the link right after </video>).
      const vidOpen = html.lastIndexOf('<video', m.index);
      if (vidOpen === -1) {
        log(`  downloaded ${rel} (no <video> found in ${name})`);
        continue;
      }
      const vidEnd = html.indexOf('</video>', vidOpen);
      if (vidEnd === -1 || m.index - (vidEnd + 8) >= 200) {
        log(`  downloaded ${rel} (no adjacent <video> in ${name})`);
        continue;
      }

      let region = html.slice(vidOpen, vidEnd);
      if (/<source(?![^>]*\bsrc=)[^>]*>/.test(region)) {
        region = region.replace(/<source(?![^>]*\bsrc=)([^>]*)>/, `<source src="${rel}"$1>`);
      } else if (/^<video(?![^>]*\bsrc=)/.test(region)) {
        region = region.replace(/^<video/, `<video src="${rel}"`);
      } else {
        // Already has a source — add ours as a fallback rather than losing it.
        region = region.replace(/^(<video[^>]*>)/, `$1<source src="${rel}">`);
      }
      // Autoplay is blocked without muted (the original site set this via JS).
      region = region.replace(/^<video([^>]*)>/, (whole, attrs) =>
        (/\bmuted\b/.test(attrs) || !/\bautoplay\b/.test(attrs)) ? whole : `<video${attrs} muted>`);

      html = html.slice(0, vidOpen) + region + html.slice(vidEnd);
      fixed++;
      log(`  wired ${rel} into ${name}`);
    }
    fs.writeFileSync(file, html);
  }
  return fixed;
}

module.exports = { fixVideos, download };
