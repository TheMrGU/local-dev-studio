/* End-to-end check of the real pipeline: detect a browser, drive the bundled
 * SingleFile CLI, extract, scan the palette, zip. Hits the network.
 *
 *   npm run e2e                     # captures example.com
 *   npm run e2e -- https://site.com
 *
 * Re-executes itself under Electron's Node so it uses exactly the runtime the
 * packaged app uses (no system Node.js involved).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

if (!process.versions.electron) {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electron)) {
    console.error('electron not installed — run npm install first');
    process.exit(1);
  }
  const child = spawn(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('close', code => process.exit(code || 0));
  return;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-e2e-'));
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: require.resolve('electron'),
  loaded: true,
  exports: { app: { getAppPath: () => ROOT, getPath: name => path.join(TMP, name), getVersion: () => 'e2e' } },
};

const browsers = require('../lib/browsers');
const { captureSite, findSingleFile, readManifest } = require('../lib/capture');
const { extractSite } = require('../lib/extract');
const { scanPalette } = require('../lib/palette');
const { zipFolder } = require('../lib/zip');
const { HostManager } = require('../lib/server');

const url = process.argv[2] || 'https://example.com';
const crawl = process.argv.includes('--crawl');

(async () => {
  console.log(`runtime: electron ${process.versions.electron} / node ${process.versions.node}`);

  const singleFilePath = findSingleFile('');
  console.log(`engine : ${singleFilePath}`);
  if (!singleFilePath) throw new Error('bundled single-file-cli not found');

  const found = await browsers.detect();
  if (!found.length) throw new Error('no Chromium browser detected');
  console.log(`browser: ${found[0].name} — ${found[0].path}`);
  console.log(`         (${found.length} detected: ${found.map(b => b.name).join(', ')})`);

  console.log(`\ncapturing ${url}${crawl ? ' (crawling)' : ''}…`);
  const started = Date.now();
  const rawDir = await captureSite({
    url,
    crawl,
    depth: 1,
    browserPath: found[0].path,
    singleFilePath,
    outRoot: TMP,
    headless: true,
    stripBanners: true,
    waitDelay: 0,
  }, line => process.stdout.write(String(line).replace(/\s+$/, '') + '\n'));

  const pages = fs.readdirSync(rawDir).filter(f => f.endsWith('.html'));
  console.log(`captured ${pages.length} file(s) in ${Math.round((Date.now() - started) / 1000)}s -> ${path.basename(rawDir)}`);
  if (!readManifest(rawDir)) throw new Error('manifest missing');

  const outDir = rawDir + '_extracted';
  const stats = await extractSite(rawDir, outDir, {}, () => {});
  console.log(`extracted: ${JSON.stringify(stats)}`);
  if (!stats.pages) throw new Error('extract produced no pages');

  const colors = scanPalette(outDir);
  console.log(`palette  : ${colors.slice(0, 6).map(c => `${c.color}×${c.count}`).join(' ') || '(none)'}`);

  const zipPath = outDir + '.zip';
  const zipped = await zipFolder(outDir, zipPath);
  console.log(`zip      : ${zipped.files} files, ${(zipped.bytes / 1024).toFixed(0)} KB`);

  const hosts = new HostManager();
  const port = await hosts.start(outDir, 8123);
  const body = await new Promise((resolve, reject) => {
    require('http').get(`http://127.0.0.1:${port}/`, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
  hosts.stopAll();
  console.log(`host     : GET / -> ${body.status}, ${body.text.length} bytes`);
  if (body.status !== 200) throw new Error('hosting did not serve the homepage');

  console.log('\nPASS — full pipeline works on the packaged runtime');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(err => {
  console.error('\nFAIL —', err.message);
  console.error(`scratch kept for inspection: ${TMP}`);
  process.exit(1);
});
