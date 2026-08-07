/* Plain-node checks for the parts of SiteSlurp that don't need a window.
 * Run with: npm test
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-test-'));

// Some modules pull in electron for app paths; stub it before they load.
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    app: {
      getAppPath: () => ROOT,
      getPath: name => path.join(TMP, name),
      getVersion: () => '0.0.0-test',
    },
  },
};

const { scanPalette, applyColor, undoColor, listUndo, parseColor } = require('../lib/palette');
const { extractSite, uniqueOutDir } = require('../lib/extract');
const { zipFolder } = require('../lib/zip');
const { makeHandler, HostManager } = require('../lib/server');
const { makeProxyHandler, adjustCsp } = require('../lib/proxy');
const { parsePublicUrl, viaTunnel } = require('../lib/tunnel');
const runtimes = require('../lib/runtimes');
const { portAnswers, AttachRunner } = require('../lib/runner');
const { CHECKLISTS } = require('../lib/checklists');
const { resolveEntry } = require('../lib/entry');
const { normalizeUrl, nameFromUrl, reserveCaptureDir } = require('../lib/capture');
const versions = require('../lib/versions');
const { watchFolder } = require('../lib/watch');
const settings = require('../lib/settings');
const projectsReg = require('../lib/projects');
const { describeLocal } = require('../lib/library');
const { LiveReload } = require('../lib/livereload');
const reviewsStore = require('../lib/reviews');
const calibrationStore = require('../lib/calibration');
const { exportReview, styleLine, renderAnnotation } = require('../lib/reviewExport');
const { ReviewManager } = require('../lib/review');
const { locateSource } = require('../lib/sourceline');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed++; console.log(`  ok   ${name}`); },
        err => { failures.push([name, err]); console.log(`  FAIL ${name}\n       ${err.message}`); },
      );
    }
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
  return Promise.resolve();
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}expected ${b}, got ${a}`);
}
function ok(value, label = 'expected truthy') {
  if (!value) throw new Error(label);
}
async function throws(fn, label) {
  try { await fn(); } catch { return; }
  throw new Error(label || 'expected it to throw');
}

const scratch = name => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/* ---------------- palette ---------------- */
async function paletteTests() {
  console.log('\npalette');

  await check('parses every color notation to the same rgb', () => {
    eq(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1, kind: 'hex3' });
    eq(parseColor('#FFFFFF').r, 255);
    eq(parseColor('rgb(255,255,255)').r, 255);
    eq(parseColor('rgb(100% 100% 100%)').g, 255);
    eq(parseColor('hsl(0, 0%, 100%)').b, 255);
    eq(parseColor('#ff000080').a, 128 / 255);
    eq(parseColor('rgba(255, 0, 0, 0.5)').a, 0.5);
    eq(parseColor('rgb(255 0 0 / 50%)').a, 0.5);
    eq(parseColor('hsl(120 100% 25%)'), { r: 0, g: 128, b: 0, a: 1, kind: 'hsl' });
    eq(parseColor('not-a-color'), null);
    eq(parseColor('#12345'), null, 'five-digit hex is not a color: ');
  });

  await check('ignores hex-looking things that are not colors', () => {
    const dir = scratch('pal-noise');
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<a href="#a1b2c3d4e5">x</a><p>&#123;</p><style>.a{color:#ff0000}</style>');
    const found = scanPalette(dir).map(c => c.color);
    eq(found, ['#ff0000']);
  });

  await check('groups notations and opacities into one swatch', () => {
    const dir = scratch('pal-group');
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<div style="color:#F00">a</div>');
    fs.writeFileSync(path.join(dir, 'css', 'a.css'),
      '.x{color:rgb(255,0,0)}.y{color:rgba(255,0,0,.5)}.z{background:#ff0000}');
    const [top] = scanPalette(dir);
    eq(top.color, '#ff0000');
    eq(top.count, 4);
    ok(top.variants === 2, 'two distinct opacities');
  });

  await check('apply keeps each notation and its alpha', () => {
    const dir = scratch('pal-apply');
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<div style="color:#F00;border-color:#ff0000">a</div>');
    fs.writeFileSync(path.join(dir, 'css', 'a.css'),
      '.a{color:rgb(255,0,0)}.b{color:rgba(255, 0, 0, 0.5)}.c{color:#ff000080}.d{color:rgb(255 0 0 / 25%)}');
    const result = applyColor(dir, '255,0,0', '#0000ff');
    eq(result.replaced, 6);
    eq(result.files, 2);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(dir, 'css', 'a.css'), 'utf8');
    ok(html.includes('color:#00f'), 'shorthand stays shorthand: ' + html);
    ok(html.includes('border-color:#0000ff'), 'long hex stays long: ' + html);
    ok(css.includes('rgb(0, 0, 255)'), 'rgb kept: ' + css);
    ok(css.includes('rgba(0, 0, 255, 0.5)'), 'alpha kept: ' + css);
    ok(css.includes('#0000ff80'), '8-digit alpha kept: ' + css);
    ok(css.includes('rgb(0 0 255 / 0.25)'), 'space syntax kept: ' + css);
  });

  await check('apply leaves other colors alone', () => {
    const dir = scratch('pal-others');
    fs.writeFileSync(path.join(dir, 'index.html'), '<b style="color:#ff0000;background:#00ff00">x</b>');
    applyColor(dir, '255,0,0', '#000000');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    ok(html.includes('#00ff00'), 'untouched color survived');
    ok(html.includes('#000'), 'target replaced');
  });

  await check('apply writes no undo folder of its own any more', () => {
    // Undo is the versioning engine's job now (a 'palette'-sourced snapshot
    // taken by the IPC layer before apply); the module just rewrites files.
    const dir = scratch('pal-noundo');
    fs.writeFileSync(path.join(dir, 'index.html'), '<i style="color:#ff0000">x</i>');
    const result = applyColor(dir, '255,0,0', '#123456');
    eq(result.replaced, 1);
    ok(!fs.existsSync(path.join(dir, '.siteslurp')), 'no .siteslurp written by apply');
  });

  await check('legacy undo entries still list and restore through the old path', () => {
    const dir = scratch('pal-legacy');
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, '<i style="color:#123456">x</i>');
    // A pre-engine recolor left this behind; the entry must stay visible and
    // restorable even though nothing writes this format any more.
    const undoDir = path.join(dir, '.siteslurp', 'undo', '2025-01-01T00-00-00-000Z');
    fs.mkdirSync(undoDir, { recursive: true });
    fs.writeFileSync(path.join(undoDir, 'index.html'), '<i style="color:#ff0000">x</i>');
    fs.writeFileSync(path.join(undoDir, 'meta.json'), JSON.stringify({
      id: '2025-01-01T00-00-00-000Z', from: '#ff0000', to: '#123456',
      replaced: 1, files: ['index.html'], at: '2025-01-01T00:00:00.000Z',
    }));
    const entries = listUndo(dir);
    eq(entries.length, 1);
    const { restored } = undoColor(dir);
    eq(restored, 1);
    eq(fs.readFileSync(file, 'utf8'), '<i style="color:#ff0000">x</i>');
  });

  await check('reports zero when the color is absent', () => {
    const dir = scratch('pal-none');
    fs.writeFileSync(path.join(dir, 'index.html'), '<b>no colors here</b>');
    const result = applyColor(dir, '1,2,3', '#ffffff');
    eq(result.replaced, 0);
    eq(result.files, 0);
  });

  await check('rejects an invalid replacement color', () =>
    throws(() => applyColor(scratch('pal-bad'), '255,0,0', 'periwinkle')));
}

/* ---------------- extract ---------------- */
async function extractTests() {
  console.log('\nextract');

  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  await check('explodes data URIs and style blocks into files', async () => {
    const src = scratch('ex-src');
    fs.writeFileSync(path.join(src, 'home.html'), [
      '<!doctype html><html><head>',
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">',
      `<style>${'.hero{color:red;background:url(data:image/png;base64,' + pngB64 + ')}'.padEnd(120, ' ')}</style>`,
      '</head><body>',
      `<img src="data:image/png;base64,${pngB64}">`,
      '<div style="opacity: 0; transform: translateY(40px); color: red">reveal</div>',
      '</body></html>',
    ].join('\n'));

    const out = path.join(TMP, 'ex-out');
    const stats = await extractSite(src, out, {});
    eq(stats.pages, 1);
    ok(stats.css >= 1, 'a css file was written');
    ok(stats.images >= 1, 'an image was written');

    const html = fs.readFileSync(path.join(out, 'home.html'), 'utf8');
    ok(!/data:image\/png;base64/.test(html), 'no base64 left in html');
    ok(/<link rel="stylesheet" href="css\/style-[0-9a-f]{10}\.css">/.test(html), 'style block became a link: ' + html);
    ok(!/content-security-policy/i.test(html), 'CSP meta removed');
    ok(!/opacity:\s*0/.test(html), 'frozen reveal style dropped');
    ok(/color: red/.test(html), 'other inline declarations kept');

    const cssName = fs.readdirSync(path.join(out, 'css'))[0];
    const css = fs.readFileSync(path.join(out, 'css', cssName), 'utf8');
    ok(css.includes('../assets/images/'), 'css points up one level: ' + css);
  });

  await check('dedupes identical assets across pages', async () => {
    const src = scratch('ex-dedupe');
    for (const name of ['a.html', 'b.html']) {
      fs.writeFileSync(path.join(src, name), `<img src="data:image/png;base64,${pngB64}">`);
    }
    const out = path.join(TMP, 'ex-dedupe-out');
    const stats = await extractSite(src, out, {});
    eq(stats.pages, 2);
    eq(stats.images, 1, 'one file for two references: ');
    eq(stats.refs, 2);
    eq(fs.readdirSync(path.join(out, 'assets', 'images')).length, 1);
  });

  await check('refuses to overwrite unless asked, and uniquifies', async () => {
    const src = scratch('ex-clash');
    fs.writeFileSync(path.join(src, 'a.html'), '<p>hi</p>');
    const out = path.join(TMP, 'ex-clash-out');
    await extractSite(src, out, {});
    await throws(() => extractSite(src, out, {}), 'second extract should refuse');
    await extractSite(src, out, { overwrite: true });
    const unique = uniqueOutDir(out);
    eq(path.basename(unique), 'ex-clash-out-2');
  });

  await check('leaves styles inside inline svg alone', async () => {
    const src = scratch('ex-svg');
    fs.writeFileSync(path.join(src, 'a.html'),
      `<svg><style>${'.p{fill:red}'.padEnd(100, ' ')}</style><path d="M0 0"/></svg>`);
    const out = path.join(TMP, 'ex-svg-out');
    await extractSite(src, out, {});
    const html = fs.readFileSync(path.join(out, 'a.html'), 'utf8');
    ok(html.includes('<style>'), 'svg style survived: ' + html);
  });
}

/* ---------------- zip ---------------- */
async function zipTests() {
  console.log('\nzip');

  const src = scratch('zip-src');
  fs.mkdirSync(path.join(src, 'css'), { recursive: true });
  fs.mkdirSync(path.join(src, '.siteslurp'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index.html'), '<h1>hello</h1>'.repeat(200));
  fs.writeFileSync(path.join(src, 'css', 'a.css'), 'body{color:red}');
  fs.writeFileSync(path.join(src, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255, 254]));
  fs.writeFileSync(path.join(src, '.siteslurp', 'secret.txt'), 'should not be zipped');

  const zipPath = path.join(TMP, 'out.zip');

  await check('writes an archive and skips dot-folders', async () => {
    const result = await zipFolder(src, zipPath);
    eq(result.files, 3, 'three real files: ');
    ok(fs.statSync(zipPath).size > 0, 'archive is not empty');
    const head = fs.readFileSync(zipPath).subarray(0, 4);
    eq([...head], [0x50, 0x4B, 0x03, 0x04], 'PK header: ');
  });

  await check('Windows can expand it and the bytes round-trip', () => {
    if (process.platform !== 'win32') { console.log('       (skipped — not Windows)'); return; }
    const dest = path.join(TMP, 'unzipped');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`], { windowsHide: true });
    eq(fs.readFileSync(path.join(dest, 'css', 'a.css'), 'utf8'), 'body{color:red}');
    eq([...fs.readFileSync(path.join(dest, 'binary.bin'))], [0, 1, 2, 3, 255, 254]);
    ok(!fs.existsSync(path.join(dest, '.siteslurp')), 'dot-folder stayed out');
  });

  await check('rejects an empty folder', () => throws(() => zipFolder(scratch('zip-empty'), path.join(TMP, 'e.zip'))));
}

/* ---------------- static server ---------------- */
async function serverTests() {
  console.log('\nserver');

  const site = scratch('srv-site');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(site, '.siteslurp'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(site, 'assets', 'clip.mp4'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(site, '.siteslurp', 'secret.txt'), 'nope');
  // A sibling folder whose name shares the site's prefix — the classic prefix-check bypass.
  // The sentinel is deliberately unlike the request path, since the 404 page echoes that back.
  const SENTINEL = 'ESCAPED-THE-SITE-ROOT';
  fs.mkdirSync(site + '-evil', { recursive: true });
  fs.writeFileSync(path.join(site + '-evil', 'loot.txt'), SENTINEL);

  const server = http.createServer(makeHandler(site));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const get = (urlPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers, method }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    await check('serves the homepage at /', async () => {
      const res = await get('/');
      eq(res.status, 200);
      ok(res.body.includes('home'), 'body: ' + res.body);
      eq(res.headers['cache-control'], 'no-store, must-revalidate');
    });

    await check('blocks traversal, encoded traversal and prefix-sibling escapes', async () => {
      for (const attempt of [
        '/../srv-site-evil/loot.txt',
        '/..%2Fsrv-site-evil%2Floot.txt',
        '/%2e%2e/%2e%2e/srv-site-evil/loot.txt',
        '/..\\srv-site-evil\\loot.txt',
      ]) {
        const res = await get(attempt);
        ok(res.status === 403 || res.status === 404, `${attempt} -> ${res.status}`);
        ok(!res.body.includes(SENTINEL), `${attempt} leaked the sibling folder's contents`);
      }
    });

    await check('hides internal dot-folders', async () => {
      const res = await get('/.siteslurp/secret.txt');
      eq(res.status, 404);
    });

    await check('supports range requests for video seeking', async () => {
      const res = await get('/assets/clip.mp4', { Range: 'bytes=2-5' });
      eq(res.status, 206);
      eq(res.body, '2345');
      eq(res.headers['content-range'], 'bytes 2-5/10');
    });

    await check('answers HEAD and refuses other methods', async () => {
      eq((await get('/', {}, 'HEAD')).status, 200);
      eq((await get('/', {}, 'DELETE')).status, 405);
    });

    await check('unsatisfiable range gets a 416', async () => {
      eq((await get('/assets/clip.mp4', { Range: 'bytes=99-' })).status, 416);
    });
  } finally {
    server.close();
  }
}

/* ---------------- entry page + hosting ---------------- */
async function entryTests() {
  console.log('\nentry + hosting');

  const fetchBody = (host, port, urlPath = '/') => new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: urlPath }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
  });

  await check('entry recorded in the manifest wins', () => {
    const dir = scratch('entry-manifest');
    fs.writeFileSync(path.join(dir, '_index.html'), 'sitemap');
    fs.writeFileSync(path.join(dir, 'zzz.html'), 'home');
    fs.writeFileSync(path.join(dir, 'siteslurp.json'), JSON.stringify({ entry: 'zzz.html' }));
    eq(resolveEntry(dir), 'zzz.html');
  });

  await check('a pre-rename sitesnap.json manifest still resolves the entry', () => {
    const dir = scratch('entry-legacy-manifest');
    fs.writeFileSync(path.join(dir, '_index.html'), 'sitemap');
    fs.writeFileSync(path.join(dir, 'zzz.html'), 'home');
    fs.writeFileSync(path.join(dir, 'sitesnap.json'), JSON.stringify({ entry: 'zzz.html' }));
    eq(resolveEntry(dir), 'zzz.html');
  });

  await check('derives the homepage from the source url, not the sitemap', () => {
    const dir = scratch('entry-url');
    fs.writeFileSync(path.join(dir, '_index.html'), 'sitemap');
    fs.writeFileSync(path.join(dir, '_en.html'), 'home');
    fs.writeFileSync(path.join(dir, '_en_about.html'), 'about');
    fs.writeFileSync(path.join(dir, 'siteslurp.json'),
      JSON.stringify({ url: 'https://www.example.com/en?ref=x' }));
    eq(resolveEntry(dir), '_en.html');
  });

  await check('falls back to the shortest page name, sitemap only as a last resort', () => {
    const dir = scratch('entry-short');
    fs.writeFileSync(path.join(dir, '_index.html'), 'sitemap');
    fs.writeFileSync(path.join(dir, '_en_projects_thing.html'), 'deep');
    fs.writeFileSync(path.join(dir, '_en.html'), 'home');
    eq(resolveEntry(dir), '_en.html');
    const only = scratch('entry-only-map');
    fs.writeFileSync(path.join(only, '_index.html'), 'sitemap');
    eq(resolveEntry(only), '_index.html');
  });

  await check('the site root serves the real homepage; the sitemap stays reachable', async () => {
    const dir = scratch('entry-served');
    fs.writeFileSync(path.join(dir, '_index.html'), '<h1>sitemap</h1>');
    fs.writeFileSync(path.join(dir, '_en.html'), '<h1>the actual site</h1>');
    fs.writeFileSync(path.join(dir, 'siteslurp.json'), JSON.stringify({ url: 'https://x.test/en' }));
    const server = http.createServer(makeHandler(dir));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      ok((await fetchBody('127.0.0.1', port, '/')).includes('the actual site'), 'root shows the site');
      ok((await fetchBody('127.0.0.1', port, '/_index.html')).includes('sitemap'), 'sitemap still there');
    } finally {
      server.close();
    }
  });

  await check('a chosen entry page overrides resolution; a stale choice falls back', async () => {
    const dir = scratch('entry-chosen');
    fs.writeFileSync(path.join(dir, '_index.html'), '<h1>sitemap</h1>');
    fs.writeFileSync(path.join(dir, '_en.html'), '<h1>resolved home</h1>');
    fs.writeFileSync(path.join(dir, 'pricing.html'), '<h1>chosen page</h1>');
    fs.mkdirSync(path.join(dir, '.siteslurp'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.siteslurp', 'sneaky.html'), '<h1>internal</h1>');
    fs.writeFileSync(path.join(dir, 'siteslurp.json'), JSON.stringify({ url: 'https://x.test/en' }));

    let chosen = 'pricing.html';
    const server = http.createServer(makeHandler(dir, { entry: () => chosen }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      ok((await fetchBody('127.0.0.1', port, '/')).includes('chosen page'), 'the chosen entry serves at /');
      chosen = 'gone.html';
      ok((await fetchBody('127.0.0.1', port, '/')).includes('resolved home'), 'a deleted choice falls back');
      chosen = '.siteslurp/sneaky.html';
      ok((await fetchBody('127.0.0.1', port, '/')).includes('resolved home'), 'dot-paths never become the entry');
    } finally {
      server.close();
    }
  });

  await check('the host manager asks entryFor and serves that page at the root', async () => {
    const dir = scratch('entry-hostmgr');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>default</h1>');
    fs.writeFileSync(path.join(dir, 'landing.html'), '<h1>the chosen one</h1>');
    const hosts = new HostManager();
    hosts.entryFor = () => 'landing.html';
    try {
      const port = await hosts.start(dir, 0);
      ok((await fetchBody('127.0.0.1', port)).includes('the chosen one'), 'entryFor drives the root page');
    } finally {
      hosts.stopAll();
    }
  });

  await check('hosting binds both loopbacks and skips a port whose IPv6 side is taken', async () => {
    const dir = scratch('host-dual');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ours</h1>');

    // Simulate the bug that shipped: a foreign process (python -m http.server)
    // listening on IPv6 while we would have taken IPv4 on the same port.
    const foreign = http.createServer((req, res) => res.end('WRONG SITE'));
    const hasV6 = await new Promise(resolve => {
      foreign.once('error', () => resolve(false));
      foreign.listen(0, '::1', () => resolve(true));
    });
    if (!hasV6) { console.log('       (skipped — no IPv6 loopback on this machine)'); return; }

    const takenPort = foreign.address().port;
    const hosts = new HostManager();
    try {
      const port = await hosts.start(dir, takenPort);
      ok(port !== takenPort, `moved off the hijacked port (${takenPort} -> ${port})`);
      ok((await fetchBody('127.0.0.1', port)).includes('ours'), 'IPv4 loopback serves our site');
      ok((await fetchBody('::1', port)).includes('ours'), 'IPv6 loopback serves our site');
      eq(hosts.portFor(dir), port);
      ok(hosts.stop(dir), 'stop releases the port');
    } finally {
      hosts.stopAll();
      foreign.close();
    }
  });
}

/* ---------------- project registry ---------------- */
async function projectTests() {
  console.log('\nproject registry');

  const site = name => {
    const dir = scratch('prj-' + name);
    fs.writeFileSync(path.join(dir, 'index.html'), `<h1>${name}</h1>`);
    return dir;
  };

  const a = site('a'), b = site('b'), c = site('c');
  const capDir = site('cap');

  await check('assigns each project its own port, starting at 4300', () => {
    const pa = projectsReg.addLocal(a);
    const pb = projectsReg.addLocal(b);
    eq(pa.port, 4300);
    eq(pb.port, 4301);
    eq(pa.kind, 'local');
    eq(pa.entryFile, 'index.html');
    ok(pa.id !== pb.id, 'distinct ids');
  });

  await check('registers scanned captures once and keeps their port', () => {
    projectsReg.syncCaptures([{ dir: capDir, name: 'cap', sourceUrl: 'https://x.test' }]);
    const first = projectsReg.byPath(capDir);
    ok(first, 'registered by the scan');
    eq(first.kind, 'capture');
    eq(first.port, 4302);
    projectsReg.syncCaptures([{ dir: capDir, name: 'cap' }]);
    const second = projectsReg.byPath(capDir);
    eq(second.id, first.id, 'same identity on rescan: ');
    eq(second.port, first.port, 'same port on rescan: ');
  });

  await check('prunes captures whose folder left the scan, keeps locals', () => {
    projectsReg.syncCaptures([]);
    ok(!projectsReg.byPath(capDir), 'capture entry gone');
    ok(projectsReg.byPath(a), 'local project survived the prune');
  });

  await check('never hands out a released port in the same session', () => {
    const pb = projectsReg.byPath(b);
    projectsReg.remove(pb.id);
    const pc = projectsReg.addLocal(c);
    // 4301 (removed) and 4302 (pruned) are both off-limits until restart.
    eq(pc.port, 4303);
  });

  await check('port assignments survive a reload', () => {
    const before = projectsReg.byPath(c).port;
    delete require.cache[require.resolve('../lib/projects')];
    const fresh = require('../lib/projects');
    eq(fresh.byPath(a).port, 4300);
    eq(fresh.byPath(c).port, before);
    ok(!fresh.byPath(b), 'removed project stayed removed');
  });

  await check('refuses junk folders with a sentence, not a crash', async () => {
    await throws(() => projectsReg.addLocal(path.join(TMP, 'does-not-exist')), 'missing path');
    const file = path.join(scratch('prj-file'), 'x.txt');
    fs.writeFileSync(file, 'x');
    await throws(() => projectsReg.addLocal(file), 'a file, not a folder');
    await throws(() => projectsReg.addLocal(a), 'already registered');
    // A folder with no HTML is no longer junk: a Next.js app, a Django site or
    // a PHP shop has none until something runs. It comes in with no runtime
    // decided, which the card and the runtime panel say out loud.
    const bare = projectsReg.addLocal(scratch('prj-empty'));
    eq(bare.runtime.kind, 'command');
    eq(bare.runtime.id, 'custom');
    eq(bare.runtime.command, '');
  });

  await check('a squatted port slides to a free one and the new port persists', async () => {
    // What main.js does on host:start when an external process owns the
    // registered port: HostManager slides, the registry keeps the new port.
    const foreign = http.createServer((req, res) => res.end('foreign'));
    await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const squatted = foreign.address().port;
    const hostMgr = new HostManager();
    try {
      const resolved = await hostMgr.start(a, squatted);
      ok(resolved !== squatted, `slid off ${squatted} to ${resolved}`);
      const project = projectsReg.byPath(a);
      projectsReg.update(project.id, { port: resolved });
      eq(projectsReg.byPath(a).port, resolved);
    } finally {
      hostMgr.stopAll();
      foreign.close();
    }
  });

  await check('hosts five projects at once, each on its registry port', async () => {
    // The Phase-1 acceptance shape: three locals + two captures, all up together.
    const dirs = ['l1', 'l2', 'l3', 'c1', 'c2'].map(site);
    const [l1, l2, l3] = dirs.slice(0, 3).map(d => projectsReg.addLocal(d));
    projectsReg.syncCaptures([{ dir: dirs[3], name: 'c1' }, { dir: dirs[4], name: 'c2' }]);
    const five = [l1, l2, l3, projectsReg.byPath(dirs[3]), projectsReg.byPath(dirs[4])];
    const hostMgr = new HostManager();
    try {
      const bound = [];
      for (const project of five) {
        const port = await hostMgr.start(project.path, project.port);
        if (port !== project.port) projectsReg.update(project.id, { port });
        bound.push(port);
      }
      eq(new Set(bound).size, 5, 'five distinct ports: ');
      for (let i = 0; i < five.length; i++) {
        const body = await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: bound[i], path: '/' }, res => {
            const chunks = [];
            res.on('data', ch => chunks.push(ch));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
          }).on('error', reject);
        });
        ok(body.includes(path.basename(five[i].path).replace('prj-', '')), `site ${i} serves its own page`);
      }
    } finally {
      hostMgr.stopAll();
    }
  });

  await check('describes a local folder and flags a missing one', async () => {
    const desc = await describeLocal({ path: a, name: 'proj-a' }, path.join(TMP, 'no-thumb.png'));
    eq(desc.kind, 'local');
    eq(desc.pages, 1);
    eq(desc.missing, false);
    ok(desc.sizeBytes > 0, 'size counted');
    const gone = await describeLocal({ path: path.join(TMP, 'vanished'), name: 'x' }, '');
    eq(gone.missing, true);
  });
}

/* ---------------- live reload ---------------- */
async function liveReloadTests() {
  console.log('\nlive reload');

  const get = (port, urlPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  // Open the SSE stream and hand back a way to await the next parsed event.
  const openSse = port => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__siteslurp__/events' }, res => {
      const events = [];
      const waiters = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          events.push(JSON.parse(line.slice(6)));
          while (waiters.length && events.length) waiters.shift()(events.shift());
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        next: (ms = 3000) => new Promise((ok2, no2) => {
          if (events.length) return ok2(events.shift());
          const t = setTimeout(() => no2(new Error(`no SSE event within ${ms}ms`)), ms);
          waiters.push(msg => { clearTimeout(t); ok2(msg); });
        }),
        quiet: ms => new Promise((ok2, no2) => {
          const t = setTimeout(() => ok2(true), ms);
          waiters.push(msg => { clearTimeout(t); no2(new Error('unexpected event: ' + JSON.stringify(msg))); });
        }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });

  await check('inject lands before </body> and degrades to append', () => {
    const lr = new LiveReload('.');
    const injected = lr.inject(Buffer.from('<html><body><h1>x</h1></body></html>')).toString();
    ok(/<script src="\/__siteslurp__\/livereload\.js" defer><\/script><\/body>/.test(injected),
      'before </body>: ' + injected);
    const headless = lr.inject(Buffer.from('just a fragment')).toString();
    ok(headless.startsWith('just a fragment') && headless.includes('livereload.js'), 'appended: ' + headless);
    lr.stop();
  });

  const site = scratch('lr-site');
  fs.mkdirSync(path.join(site, 'css'), { recursive: true });
  const pageOnDisk = '<!doctype html><html><body><h1>lr</h1></body></html>';
  fs.writeFileSync(path.join(site, 'index.html'), pageOnDisk);
  fs.writeFileSync(path.join(site, 'css', 'a.css'), 'body{color:red}');
  fs.writeFileSync(path.join(site, 'clip.mp4'), Buffer.from('0123456789'));

  const hostMgr = new HostManager();
  const port = await hostMgr.start(site, 4500, { liveReload: true });

  try {
    await check('serves injected HTML while the disk stays untouched', async () => {
      const res = await get(port, '/');
      ok(res.body.toString().includes('/__siteslurp__/livereload.js'), 'script tag served');
      eq(parseInt(res.headers['content-length'], 10), res.body.length, 'content-length matches: ');
      eq(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), pageOnDisk, 'disk byte-exact: ');
      eq((await get(port, '/__siteslurp__/livereload.js')).status, 200);
      ok((await get(port, '/__siteslurp__/livereload.js')).headers['content-type'].includes('javascript'),
        'client script is javascript');
    });

    await check('range requests still work for media with live reload on', async () => {
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/clip.mp4', headers: { Range: 'bytes=2-5' } }, r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
      });
      eq(res.status, 206);
      eq(res.body, '2345');
    });

    await check('a css edit broadcasts a hot-swap, an html edit a reload', async () => {
      const sse = await openSse(port);
      eq(sse.status, 200);
      ok(sse.headers['content-type'].includes('text/event-stream'), 'event-stream');
      fs.writeFileSync(path.join(site, 'css', 'a.css'), 'body{color:blue}');
      const cssEvent = await sse.next();
      eq(cssEvent.type, 'css');
      fs.writeFileSync(path.join(site, 'index.html'), pageOnDisk + ' ');
      const htmlEvent = await sse.next();
      eq(htmlEvent.type, 'reload');
      sse.close();
    });

    await check('bookkeeping writes stay silent', async () => {
      const sse = await openSse(port);
      fs.mkdirSync(path.join(site, '.siteslurp'), { recursive: true });
      fs.writeFileSync(path.join(site, '.siteslurp', 'undo.json'), '{}');
      fs.writeFileSync(path.join(site, 'thumb.png'), 'png');
      await sse.quiet(700);
      sse.close();
    });

    await check('toggling live reload off restores byte-exact serving', async () => {
      fs.writeFileSync(path.join(site, 'index.html'), pageOnDisk);
      ok(hostMgr.setLive(site, false), 'toggle accepted');
      const res = await get(port, '/');
      eq(res.body.toString(), pageOnDisk, 'served bytes = disk bytes: ');
      eq((await get(port, '/__siteslurp__/events')).status, 404, 'sse endpoint gone: ');
      ok(hostMgr.setLive(site, true), 'toggle back on');
      ok((await get(port, '/')).body.toString().includes('livereload.js'), 'injection is back');
    });
  } finally {
    hostMgr.stopAll();
  }
}

/* ---------------- review data layer ---------------- */
async function reviewStoreTests() {
  console.log('\nreview store');

  const PRJ = 'prj_test01';

  await check('a rating without a reason is rejected at the data layer', async () => {
    await throws(() => reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: {}, input: { rating: 5 },
    }), 'bare rating');
    await throws(() => reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: {}, input: { rating: 5, why: 'too gray' },
    }), 'why under 10 chars');
    await throws(() => reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: {}, input: {},
    }), 'entirely empty');
  });

  await check('a rating with a real reason saves, and joins todays review', () => {
    const annotation = reviewsStore.addAnnotation(PRJ, {
      scope: 'element',
      context: { selector: 'h1.hero', viewport: { width: 1440, height: 900, label: 'desktop' } },
      input: { rating: 3, severity: 'blocking', axes: ['typography', 'bogus-axis'], why: 'Reads like body copy, no weight at all.', want: 'Heavier.' },
    });
    ok(/^ann_[0-9a-f]{8}$/.test(annotation.id), 'id shape: ' + annotation.id);
    ok(/^rev_\d{8}_\d{2}$/.test(annotation.reviewId), 'review id shape: ' + annotation.reviewId);
    eq(annotation.input.axes, ['typography'], 'unknown axes filtered: ');
    eq(annotation.input.rating, 3);
    const again = reviewsStore.addAnnotation(PRJ, {
      scope: 'global', context: {}, input: { why: 'Buttons are all too round sitewide.' },
    });
    eq(again.reviewId, annotation.reviewId, 'same session: ');
  });

  await check('update validates too — you cannot strip the reason from a rated note', async () => {
    const [first] = reviewsStore.listAnnotations(PRJ);
    await throws(() => reviewsStore.updateAnnotation(PRJ, first.id, { input: { why: '' } }), 'why removed');
    const patched = reviewsStore.updateAnnotation(PRJ, first.id, { input: { want: 'Near-black, 72px.' } });
    eq(patched.input.want, 'Near-black, 72px.');
    eq(patched.input.rating, 3, 'rating survived the patch: ');
  });

  await check('resolve keeps the old rating and records the new one', () => {
    const [first] = reviewsStore.listAnnotations(PRJ);
    const resolved = reviewsStore.updateAnnotation(PRJ, first.id, { resolved: true, resolvedRating: 8 });
    eq(resolved.resolved, true);
    eq(resolved.input.rating, 3, 'original rating intact: ');
    eq(resolved.resolvedRating, 8);
    ok(resolved.resolvedAt, 'resolve timestamped');
    reviewsStore.updateAnnotation(PRJ, first.id, { resolved: false });
  });

  await check('calibration anchors persist and render high-to-low', () => {
    calibrationStore.addAnchor({ rating: 4, axis: 'spacing', summary: '32px section padding at 1440', note: 'Cramped' });
    calibrationStore.addAnchor({ rating: 9, axis: 'typography', summary: 'Söhne 600 at 72px, near-black' });
    ok(calibrationStore.addStandingPreference('Prefers near-black over pure black for text'), 'first add');
    ok(!calibrationStore.addStandingPreference('prefers near-black over pure black for text'), 'case-insensitive dedupe');
    const md = calibrationStore.renderMarkdown();
    ok(md.indexOf('9/10') < md.indexOf('4/10'), 'anchors sorted high to low');
    ok(md.includes('Standing preferences'), 'preferences section present');
  });

  await check('the calibration manager edits and removes by index, refusing stale ones', async () => {
    const prefs = calibrationStore.load().standingPreferences;
    const index = prefs.length - 1;
    eq(calibrationStore.updatePreference(index, '  Near-black, never #000  '), 'Near-black, never #000');
    eq(calibrationStore.load().standingPreferences[index], 'Near-black, never #000');
    await throws(() => calibrationStore.updatePreference(index, '   '), 'empty preference refused');
    await throws(() => calibrationStore.updatePreference(99, 'x'), 'stale preference index refused');
    ok(calibrationStore.removePreference(index), 'preference removed');
    eq(calibrationStore.load().standingPreferences.length, index);

    const anchors = calibrationStore.load().anchors;
    const last = anchors.length - 1;
    eq(calibrationStore.updateAnchor(last, { summary: 'Tighter: 72px display, near-black' }).summary,
      'Tighter: 72px display, near-black');
    await throws(() => calibrationStore.updateAnchor(last, { summary: '' }), 'empty summary refused');
    await throws(() => calibrationStore.removeAnchor(99), 'stale anchor index refused');
    ok(calibrationStore.removeAnchor(last), 'anchor removed');
    eq(calibrationStore.load().anchors.length, last);
  });

  await check('locateSource finds a unique line and refuses ambiguity', () => {
    const dir = scratch('srcline');
    fs.writeFileSync(path.join(dir, 'page.html'),
      '<html>\n<body>\n<h1 class="display">Build faster</h1>\n<p>x</p>\n<p>x</p>\n</body>\n</html>');
    const hit = locateSource(dir, { context: { sourceFile: 'page.html', outerHTML: '<h1 class="display">Build faster</h1>' } });
    eq(hit.sourceLine, 3);
    const miss = locateSource(dir, { context: { sourceFile: 'page.html', outerHTML: '<p>x</p>' } });
    eq(miss.sourceLine, null, 'ambiguous match refused: ');
    const gone = locateSource(dir, { context: { sourceFile: 'nope.html', outerHTML: '<h1>x</h1>' } });
    eq(gone.sourceLine, null);
  });

  await check('a generated page is traced back to the component that made it', () => {
    // A Next.js app serves /about from src/app/about/page.tsx — there is no
    // about.html to search, so the element's own id and text are the trail.
    const dir = scratch('srcline-next');
    fs.mkdirSync(path.join(dir, 'src', 'app', 'about'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app', 'about', 'page.tsx'),
      'export default function About() {\n  return (\n    <section id="team-block">\n'
      + '      <h1 className="display">Built in Ohio, shipped everywhere</h1>\n    </section>\n  );\n}\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk', 'page.tsx'), 'id="team-block"');

    const byId = locateSource(dir, {
      context: { sourceFile: 'about', outerHTML: '<section id="team-block" class="wrap">' },
    });
    eq(byId.sourceFile, 'src/app/about/page.tsx');
    eq(byId.sourceLine, 3, 'found the jsx line, ignoring node_modules: ');

    const byText = locateSource(dir, {
      context: { sourceFile: 'about', outerHTML: '<h1 class="display">Built in Ohio, shipped everywhere</h1>' },
    });
    eq(byText.sourceFile, 'src/app/about/page.tsx');
    eq(byText.sourceLine, 4, 'className never matches, the words do: ');

    const nothing = locateSource(dir, { context: { sourceFile: 'about', outerHTML: '<div class="grid"></div>' } });
    eq(nothing.sourceLine, null, 'no guess when there is no evidence: ');
  });

  await check('command runtimes never pass a route off as a file (sourceline honesty)', () => {
    // Same Next-shaped project: with `generated`, an element the source can't
    // uniquely answer for gets an empty sourceFile — "/about" is a route, and
    // writing it into REVIEW.md as a file would send the agent to a ghost.
    const dir = scratch('srcline-next');
    const blank = locateSource(dir, {
      context: { sourceFile: 'about', outerHTML: '<div class="grid"></div>' },
    }, { generated: true });
    eq(blank.sourceFile, '', 'route never becomes a file: ');
    eq(blank.sourceLine, null);

    // But a unique match in the project's own source still counts.
    const found = locateSource(dir, {
      context: { sourceFile: 'about', outerHTML: '<section id="team-block" class="wrap">' },
    }, { generated: true });
    eq(found.sourceFile, 'src/app/about/page.tsx');
  });
}

/* ---------------- review export ---------------- */
async function reviewExportTests() {
  console.log('\nreview export');

  const PRJ = 'prj_export1';
  const capsRoot = scratch('export-root');
  const project = { id: PRJ, name: 'Client Site', kind: 'local', path: capsRoot };

  reviewsStore.addAnnotation(PRJ, {
    scope: 'element',
    context: {
      selector: 'footer p.legal', selectorFallback: 'body > footer > p:nth-child(3)',
      sourceFile: 'index.html', sourceLine: 203,
      viewport: { width: 1440, height: 900, label: 'desktop' },
      computedStyles: { fontFamily: 'Inter, sans-serif', fontWeight: '400', fontSize: '12px', lineHeight: '18px', color: '#9ca3af', backgroundColor: 'transparent', margin: '24px 0px 0px 0px', padding: '0px', display: 'block' },
    },
    input: { rating: 7, severity: 'nitpick', axes: ['copy'], why: 'The year is stale and the name is spelled two ways.', want: 'Current year, one spelling.' },
  });
  reviewsStore.addAnnotation(PRJ, {
    scope: 'element',
    context: {
      selector: 'section.hero > h1.display',
      viewport: { width: 1440, height: 900, label: 'desktop' },
      computedStyles: { fontFamily: 'Inter, sans-serif', fontWeight: '400', fontSize: '42px', lineHeight: '48px', color: '#6b7280' },
    },
    input: {
      rating: 3, severity: 'blocking', axes: ['typography'],
      why: 'Reads like body copy. No weight contrast against the subhead.',
      want: 'Heavier, larger, near-black.',
      referenceProjectId: 'prj_ref', referenceSelector: 'header h1',
      referenceStyles: { fontFamily: 'Söhne', fontWeight: '600', fontSize: '72px', lineHeight: '76px', color: '#111111' },
    },
  });
  reviewsStore.addAnnotation(PRJ, {
    scope: 'element',
    context: { selector: '.pricing .card', viewport: { width: 375, height: 812, label: 'mobile' } },
    input: { rating: 6, severity: 'should-fix', axes: ['spacing'], why: 'Cards are cramped against the border.', want: 'More padding.' },
  });
  reviewsStore.addAnnotation(PRJ, {
    scope: 'global', context: {},
    input: { severity: 'should-fix', why: 'Every button is too round.', want: 'Cap radius at 6px sitewide.' },
  });

  await check('export writes the folder the plan specifies', () => {
    const result = exportReview({
      project, capturesRoot: capsRoot,
      projectNameFor: id => (id === 'prj_ref' ? 'collection.industries' : null),
    });
    ok(fs.existsSync(path.join(result.folder, 'REVIEW.md')), 'REVIEW.md');
    ok(fs.existsSync(path.join(result.folder, 'calibration.md')), 'calibration.md');
    ok(fs.existsSync(path.join(result.folder, 'annotations.json')), 'annotations.json');
    ok(fs.existsSync(path.join(result.folder, 'shots')), 'shots dir');
    ok(result.folder.includes('review-client-site-'), 'folder name: ' + result.folder);
  });

  await check('REVIEW.md orders blocking first, ascending rating, globals on top', () => {
    const store = reviewsStore.listReviews(PRJ);
    const md = fs.readFileSync(path.join(store[0].exportFolder, 'REVIEW.md'), 'utf8');
    const hero = md.indexOf('[BLOCKING] section.hero');
    const cards = md.indexOf('[SHOULD-FIX] .pricing .card');
    const legal = md.indexOf('[NITPICK] footer p.legal');
    const globals = md.indexOf('## Global notes');
    ok(globals > -1 && globals < hero, 'global notes before elements');
    ok(hero > -1 && cards > hero && legal > cards, `ordering: ${hero}/${cards}/${legal}`);
    ok(md.includes('**Overall 5/10** · 1 blocking · 2 should-fix · 1 nitpick'), 'header counts');
    ok(md.includes('Reviewed at 1440×900 and 375×812'), 'viewports listed');
    ok(md.includes('**Reference:** collection.industries — `header h1`'), 'reference resolved');
    ok(md.includes('Söhne 600 · 72px/76px'), 'reference styles line');
    ok(md.includes('index.html:203'), 'file:line');
    ok(md.includes('- Every button is too round. Cap radius at 6px sitewide. _(should-fix)_'), 'global note rendered');
  });

  await check('styleLine matches the hand-written sample format', () => {
    eq(styleLine({
      fontFamily: 'Inter, sans-serif', fontWeight: '400', fontSize: '42px', lineHeight: '48px',
      letterSpacing: '0px', color: '#6b7280', backgroundColor: 'transparent',
      margin: '0px 0px 16px 0px', padding: '0px', display: 'block',
    }), 'Inter, sans-serif 400 · 42px/48px · letter-spacing 0px · color #6b7280 · background transparent · margin 0px 0px 16px 0px · padding 0px · display block');
  });

  // renderAnnotation is shared between REVIEW.md and "Copy for agent" — the
  // block below is what lands on the clipboard, verbatim.
  await check('the shared annotation formatter carries markup, console tail and reference image', () => {
    const block = renderAnnotation({
      scope: 'element',
      context: {
        selector: '.cta', selectorFallback: 'body > div:nth-child(2)',
        sourceFile: '', viewport: { width: 375, height: 812, label: 'mobile' },
        computedStyles: { color: '#fff' },
        outerHTML: '<button class="cta">Buy now</button>',
        consoleTail: ['[14:30:02] error Uncaught TypeError: x is undefined (app.js:14)'],
        referenceImage: 'shots/ann_ab_ref.png',
      },
      input: { rating: null, severity: 'should-fix', axes: [], why: 'The button does nothing.', want: 'Wire it up.' },
    }, () => null, { devServer: true });
    ok(block.startsWith('## [SHOULD-FIX] .cta'), block.split('\n')[0]);
    ok(block.includes('**File:** selector-only (dev server)'), 'honesty line for dev servers');
    ok(block.includes('```html\n<button class="cta">Buy now</button>\n```'), 'markup fence');
    ok(block.includes('**Console at the time** (last 1)'), 'console tail heading');
    ok(block.includes('Uncaught TypeError'), 'console tail body');
    ok(block.includes('**Reference image:** shots/ann_ab_ref.png'), 'reference image line');
  });

  await check('a static project with a real file never shows the dev-server line', () => {
    const block = renderAnnotation({
      scope: 'element',
      context: { selector: 'h1', sourceFile: 'index.html', sourceLine: 12 },
      input: { rating: null, severity: 'nitpick', axes: [], why: 'Tiny thing here worth a note.', want: '' },
    });
    ok(block.includes('**File:** index.html:12'), block);
    ok(!block.includes('selector-only'), 'no honesty line when the file is real');
  });

  await check('sanitizeContext keeps the console tail and reference image, bounded', () => {
    const noisy = reviewsStore.addAnnotation(PRJ, {
      scope: 'element',
      context: {
        selector: '.x',
        consoleTail: Array.from({ length: 40 }, (v, i) => `line ${i}`),
        referenceImage: 'shots/ref.png',
      },
      input: { severity: 'should-fix', why: 'Console was on fire when I saw this.' },
    });
    eq(noisy.context.consoleTail.length, 20, 'tail capped at 20: ');
    eq(noisy.context.referenceImage, 'shots/ref.png');
    reviewsStore.deleteAnnotation(PRJ, noisy.id);
  });

  await check('the three built-in checklists are real lists with real prompts', () => {
    eq(CHECKLISTS.length, 3);
    eq(CHECKLISTS.map(c => c.id), ['a11y', 'responsive', 'prelaunch']);
    for (const list of CHECKLISTS) {
      ok(list.name && list.items.length >= 4, list.id + ' has prompts');
      for (const item of list.items) ok(typeof item === 'string' && item.length > 10, 'prompt is a sentence');
    }
  });

  await check('exporting marks the review closed; the next note starts a new one', () => {
    const reviews = reviewsStore.listReviews(PRJ);
    ok(reviews[0].exportedAt, 'exported stamp');
    const next = reviewsStore.addAnnotation(PRJ, {
      scope: 'global', context: {}, input: { why: 'Second round of feedback here.' },
    });
    ok(next.reviewId !== reviews[0].id, 'new session id: ' + next.reviewId);
  });

  await check('an empty review refuses to export', async () => {
    const emptyPrj = { id: 'prj_empty', name: 'empty', kind: 'local', path: capsRoot };
    await throws(() => exportReview({ project: emptyPrj, capturesRoot: capsRoot }), 'nothing to export');
  });
}

/* ---------------- resolve loop ---------------- */
async function resolveLoopTests() {
  console.log('\nresolve loop');

  const PRJ = 'prj_resolve1';

  await check('orphan flag round-trips and never deletes the note', () => {
    const annotation = reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: { selector: '.gone' },
      input: { rating: 4, severity: 'should-fix', why: 'This element was misaligned badly.' },
    });
    const orphaned = reviewsStore.updateAnnotation(PRJ, annotation.id, { orphaned: true });
    eq(orphaned.orphaned, true);
    ok(reviewsStore.getAnnotation(PRJ, annotation.id), 'still stored');
    const back = reviewsStore.updateAnnotation(PRJ, annotation.id, { orphaned: false });
    eq(back.orphaned, false, 'element came back: ');
  });

  await check('a resolved annotation becomes a calibration anchor with the diff', () => {
    const annotation = reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: { selector: 'h1' },
      input: { rating: 3, severity: 'blocking', axes: ['typography'], why: 'Way too light for a headline.', want: 'Söhne-weight authority.' },
    });
    reviewsStore.updateAnnotation(PRJ, annotation.id, { resolved: true, resolvedRating: 9 });
    const before = calibrationStore.load().anchors.length;
    calibrationStore.anchorFromAnnotation('clientsite', reviewsStore.getAnnotation(PRJ, annotation.id));
    const anchors = calibrationStore.load().anchors;
    eq(anchors.length, before + 1);
    const anchor = anchors[anchors.length - 1];
    eq(anchor.rating, 9, 'anchors the AFTER rating: ');
    eq(anchor.axis, 'typography');
    ok(anchor.note.includes('3 → 9'), 'note records the journey: ' + anchor.note);
  });

  await check('complaints heard in 3+ reviews become promotion candidates', () => {
    const say = why => reviewsStore.addAnnotation(PRJ, {
      scope: 'global', context: {}, input: { axes: ['layout'], why },
    });
    say('Buttons are far too round everywhere on this site.');
    reviewsStore.markExported(PRJ, reviewsStore.activeReview(PRJ).id, 'x');
    say('Still every button is too round across the pages.');
    eq(reviewsStore.recurringGlobals(PRJ).length, 0, 'two reviews is not a pattern: ');
    reviewsStore.markExported(PRJ, reviewsStore.activeReview(PRJ).id, 'x');
    say('Round buttons again — cap the radius sitewide please.');
    const candidates = reviewsStore.recurringGlobals(PRJ);
    eq(candidates.length, 1);
    eq(candidates[0].count, 3);
    ok(candidates[0].text.includes('Round buttons again'), 'latest phrasing wins: ' + candidates[0].text);
  });

  await check('review history counts resolved notes per session', () => {
    const history = reviewsStore.listReviews(PRJ);
    ok(history.length >= 3, 'three sessions exist');
    const annotations = reviewsStore.listAnnotations(PRJ);
    const firstReview = history[0];
    const inFirst = annotations.filter(a => a.reviewId === firstReview.id);
    const resolvedInFirst = inFirst.filter(a => a.resolved);
    eq(resolvedInFirst.length, 1, 'one resolved in first session: ');
  });
}

/* ---------------- review API over http ---------------- */
async function reviewApiTests() {
  console.log('\nreview api');

  const site = scratch('rev-api');
  fs.writeFileSync(path.join(site, 'index.html'),
    '<html><body><h1 class="hero">Review me</h1></body></html>');
  const project = projectsReg.addLocal(site);

  const anchored = [];
  const manager = new ReviewManager({
    projects: projectsReg,
    capturesRoot: () => scratch('rev-api-caps'),
    exportReview,
    overlayPath: path.join(ROOT, 'renderer', 'review-overlay.js'),
    onAnchor: (proj, annotation) => anchored.push(annotation.id),
  });
  const hostMgr = new HostManager();
  hostMgr.reviewRouter = dir => manager.forDir(dir);
  const port = await hostMgr.start(site, 4700);
  manager.enable(site, project.id);

  const request = (method, urlPath, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
        : headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* html page */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  try {
    await check('review mode injects the overlay and serves it', async () => {
      const page = await request('GET', '/');
      ok(page.text.includes('/__siteslurp__/review/client.js'), 'tag injected');
      const script = await request('GET', '/__siteslurp__/review/client.js');
      eq(script.status, 200);
      ok(script.text.includes('__ssBridge'), 'overlay script body');
      ok(!script.text.includes('__ssReview'), 'debug-era name is gone');
    });

    await check('state reports the project and an open review', async () => {
      const res = await request('GET', '/__siteslurp__/review/state');
      eq(res.status, 200);
      eq(res.json.project.id, project.id);
      ok(/^rev_\d{8}_\d{2}$/.test(res.json.review.id), 'review id');
      ok(Array.isArray(res.json.axes) && res.json.axes.includes('typography'), 'axes list');
      eq(res.json.checklists.map(c => c.id), ['a11y', 'responsive', 'prelaunch'], 'checklists ride along: ');
    });

    await check('the no-reason rule surfaces as a 400, not a save', async () => {
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'element', context: { selector: 'h1.hero' }, input: { rating: 4 },
      });
      eq(res.status, 400);
      ok(/reason/i.test(res.json.error), 'error mentions the reason: ' + res.json.error);
    });

    await check('a valid annotation round-trips through http', async () => {
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'element',
        context: { selector: 'h1.hero', pageUrl: '/', viewport: { width: 1440, height: 900, label: 'desktop' } },
        input: { rating: 4, severity: 'should-fix', why: 'Headline has no presence at all.', want: 'Bigger, bolder.' },
      });
      eq(res.status, 200);
      ok(res.json.annotation.id, 'saved with id');
      const state = await request('GET', '/__siteslurp__/review/state');
      eq(state.json.annotations.length, 1);
    });

    await check('cross-origin posts are refused', async () => {
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'global', context: {}, input: { why: 'Sneaky cross-site write attempt.' },
      }, { Origin: 'http://evil.example' });
      eq(res.status, 403);
    });

    await check('a reference image uploads, serves back, and rides the export', async () => {
      const state = await request('GET', '/__siteslurp__/review/state');
      const target = state.json.annotations[0];
      // A real 1×1 PNG — the endpoint decodes and stores actual bytes.
      const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const res = await request('POST', '/__siteslurp__/review/image', {
        id: target.id, dataUrl: 'data:image/png;base64,' + px,
      });
      eq(res.status, 200);
      eq(res.json.annotation.context.referenceImage, `shots/${target.id}_ref.png`);
      const stored = path.join(TMP, 'userData', 'reviews', project.id, 'shots', `${target.id}_ref.png`);
      ok(fs.existsSync(stored), 'bytes on disk');
      const img = await request('GET', `/__siteslurp__/review/image/${target.id}`);
      eq(img.status, 200, 'served back to the overlay: ');

      const junk = await request('POST', '/__siteslurp__/review/image', {
        id: target.id, dataUrl: 'data:text/html;base64,PGI+bm90IGFuIGltYWdlPC9iPg==',
      });
      eq(junk.status, 400, 'non-images refused: ');
      const nobody = await request('POST', '/__siteslurp__/review/image', {
        id: 'ann_missing', dataUrl: 'data:image/png;base64,' + px,
      });
      eq(nobody.status, 404, 'unknown annotation refused: ');
    });

    await check('export over http produces the folder and reveal is scoped', async () => {
      const res = await request('POST', '/__siteslurp__/review/export');
      eq(res.status, 200);
      ok(fs.existsSync(path.join(res.json.folder, 'REVIEW.md')), 'REVIEW.md exists');
      // The reference image attached above is copied out with the shots.
      const state = await request('GET', '/__siteslurp__/review/state');
      const withImage = state.json.annotations.find(a => a.context.referenceImage);
      ok(withImage, 'annotation still carries the image');
      ok(fs.existsSync(path.join(res.json.folder, path.normalize(withImage.context.referenceImage))),
        'reference image exported');
      const md = fs.readFileSync(path.join(res.json.folder, 'REVIEW.md'), 'utf8');
      ok(md.includes(`**Reference image:** ${withImage.context.referenceImage}`), 'REVIEW.md names it');
    });

    await check('resolve over http re-rates and can request an anchor', async () => {
      const state = await request('GET', '/__siteslurp__/review/state');
      const target = state.json.annotations[0];
      const res = await request('POST', '/__siteslurp__/review/resolve', {
        id: target.id, resolvedRating: 8, asAnchor: true,
      });
      eq(res.status, 200);
      eq(res.json.annotation.resolved, true);
      eq(res.json.annotation.resolvedRating, 8);
      eq(res.json.annotation.input.rating, 4, 'original rating kept for the diff: ');
      eq(anchored, [target.id], 'onAnchor fired: ');
    });

    await check('done turns the api off; the page serves clean again', async () => {
      const res = await request('POST', '/__siteslurp__/review/done');
      eq(res.status, 200);
      const after = await request('GET', '/__siteslurp__/review/state');
      eq(after.status, 404);
      const page = await request('GET', '/');
      ok(!page.text.includes('review/client.js'), 'injection gone');
    });
  } finally {
    hostMgr.stopAll();
  }
}

/* ---------------- versions (snapshots) ---------------- */
async function versionTests() {
  console.log('\nversions (snapshots)');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const dir = scratch('ver-site');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v1</h1>');
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'body{color:red}');
  const project = projectsReg.addLocal(dir);
  const store = path.join(TMP, 'userData', 'versions', project.id);

  await check('creates a snapshot with content-addressed blobs and a windows-safe stamp', async () => {
    const result = await versions.createSnapshot(project, { label: 'first', source: 'manual' });
    ok(!result.unchanged, 'created');
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/.test(result.id), 'stamp shape: ' + result.id);
    ok(!result.id.includes(':'), 'no colon in the folder name');
    eq(result.stats.files, 2);
    // Local projects store under userData — never inside the user's own folder.
    ok(!fs.existsSync(path.join(dir, '.siteslurp')), 'nothing written into the project folder');
    ok(fs.existsSync(path.join(store, 'versions', result.id, 'meta.json')), 'manifest written');
    ok(fs.readdirSync(path.join(store, 'blobs')).length >= 1, 'blobs written');
  });

  await check('identical content is skipped; changed content is not', async () => {
    const again = await versions.createSnapshot(project, { source: 'manual' });
    eq(again.unchanged, true);
    eq(versions.listSnapshots(project).length, 1, 'nothing new was written: ');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v2</h1>');
    const changed = await versions.createSnapshot(project, { label: 'second', source: 'manual' });
    ok(!changed.unchanged, 'a real change snapshots');
    eq(versions.listSnapshots(project).length, 2);
  });

  await check('diffs two snapshots, and a snapshot against the working tree', async () => {
    const [second, first] = versions.listSnapshots(project).map(s => s.id);
    const between = await versions.diffSnapshots(project, first, second);
    eq(between.changed.map(f => f.path), ['index.html']);
    eq(between.added, []);
    eq(between.removed, []);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new');
    fs.rmSync(path.join(dir, 'css', 'a.css'));
    const work = await versions.diffSnapshots(project, second, 'working');
    eq(work.added.map(f => f.path), ['new.txt']);
    eq(work.removed.map(f => f.path), ['css/a.css']);
  });

  await check('readFileAt serves old content from the blob store and refuses escapes', async () => {
    const first = versions.listSnapshots(project).at(-1).id;
    eq((await versions.readFileAt(project, first, 'index.html')).toString(), '<h1>v1</h1>');
    eq((await versions.readFileAt(project, 'working', 'index.html')).toString(), '<h1>v2</h1>');
    await throws(() => versions.readFileAt(project, first, '../outside.txt'), 'traversal refused');
    await throws(() => versions.readFileAt(project, first, '.siteslurp/meta.json'), 'dot paths refused');
  });

  await check('restore is non-destructive: pre-restore snapshot first, tree matches after', async () => {
    const first = versions.listSnapshots(project).at(-1).id;
    const before = versions.listSnapshots(project).length;
    await versions.restoreSnapshot(project, first);
    const list = versions.listSnapshots(project);
    eq(list[0].source, 'pre-restore', 'newest snapshot is the safety copy: ');
    eq(list.length, before + 1, 'a snapshot was added, nothing replaced: ');
    eq(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>v1</h1>');
    ok(fs.existsSync(path.join(dir, 'css', 'a.css')), 'deleted file came back');
    ok(!fs.existsSync(path.join(dir, 'new.txt')), 'file the snapshot lacks is gone');
    // …and the pre-restore snapshot holds the file that just went away.
    eq((await versions.readFileAt(project, list[0].id, 'new.txt')).toString(), 'brand new');
  });

  await check('capture projects store snapshots inside .siteslurp', async () => {
    const capDir = scratch('ver-cap');
    fs.writeFileSync(path.join(capDir, 'index.html'), '<h1>cap</h1>');
    projectsReg.syncCaptures([{ dir: capDir, name: 'ver-cap' }]);
    const capProject = projectsReg.byPath(capDir);
    eq(capProject.autoSnapshot, true, 'captures default to auto-snapshot: ');
    const made = await versions.createSnapshot(capProject, { source: 'capture', label: 'as captured' });
    ok(fs.existsSync(path.join(capDir, '.siteslurp', 'versions', made.id, 'meta.json')),
      'store lives inside the capture');
    // The store must never end up in its own snapshots.
    const meta = versions.getSnapshot(capProject, made.id);
    ok(meta.files.every(f => !f.path.startsWith('.siteslurp')), 'store not self-snapshotted');
  });

  await check('prune keeps deliberate snapshots and the newest autos, then collects blobs', async () => {
    // Fabricate 25 stale autos (well past the 14-day window): the oldest five
    // reference a blob nothing else uses, the rest share another.
    const staleSha = 'f'.repeat(40);
    const keptSha = 'e'.repeat(40);
    for (const sha of [staleSha, keptSha]) {
      const blob = path.join(store, 'blobs', sha.slice(0, 2), sha);
      fs.mkdirSync(path.dirname(blob), { recursive: true });
      fs.writeFileSync(blob, 'x');
    }
    for (let i = 0; i < 25; i++) {
      const id = `2020-01-${String(i + 1).padStart(2, '0')}T00-00-00Z`;
      const metaDir = path.join(store, 'versions', id);
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify({
        id, label: '', source: 'auto', timestamp: `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        files: [{ path: 'x.txt', sha1: i < 5 ? staleSha : keptSha, size: 1, mtime: 0 }],
        stats: { files: 1, bytes: 1, newBlobs: 0 },
      }));
    }
    const deliberate = versions.listSnapshots(project).filter(s => s.source !== 'auto').length;
    const result = await versions.pruneSnapshots(project);
    eq(result.pruned, 5, 'oldest autos beyond the keep-20 window pruned: ');
    ok(result.blobs >= 1, 'orphaned blob collected');
    ok(!fs.existsSync(path.join(store, 'blobs', 'ff', staleSha)), 'stale blob gone');
    ok(fs.existsSync(path.join(store, 'blobs', 'ee', keptSha)), 'referenced blob kept');
    eq(versions.listSnapshots(project).filter(s => s.source !== 'auto').length, deliberate,
      'deliberate snapshots untouched: ');
  });

  await check('the watcher ignores build output when told to', async () => {
    const buildSite = scratch('watch-build');
    fs.mkdirSync(path.join(buildSite, 'dist'), { recursive: true });
    const bursts = [];
    const handle = watchFolder(buildSite, burst => bursts.push(burst), { ignoreDirs: new Set(['dist']) });
    if (!handle.active()) { console.log('       (skipped — recursive fs.watch unavailable)'); return; }
    fs.writeFileSync(path.join(buildSite, 'dist', 'bundle.js'), 'compiled');
    await sleep(500);
    eq(bursts.length, 0, 'build output stayed silent: ');
    fs.writeFileSync(path.join(buildSite, 'src.js'), 'edited');
    await sleep(500);
    ok(bursts.length >= 1, 'a source edit still reports');
    handle.close();
  });

  await check('auto-snapshot fires after idle and is suppressed during app operations', async () => {
    const autoSite = scratch('auto-site');
    fs.writeFileSync(path.join(autoSite, 'index.html'), '<h1>auto</h1>');
    const autoProject = projectsReg.addLocal(autoSite);
    versions.autoWatch(autoProject, { idleMs: 250 });
    try {
      fs.writeFileSync(path.join(autoSite, 'index.html'), '<h1>edited</h1>');
      let list = [];
      for (let i = 0; i < 40 && !list.length; i++) {
        await sleep(100);
        list = versions.listSnapshots(autoProject);
      }
      eq(list.length, 1, 'one auto snapshot: ');
      eq(list[0].source, 'auto');

      await versions.suppressAuto(async () => {
        fs.writeFileSync(path.join(autoSite, 'index.html'), '<h1>churn</h1>');
        await sleep(900); // debounce + idle both pass while suppressed
      });
      await sleep(400);
      eq(versions.listSnapshots(autoProject).length, 1, 'suppressed churn took no snapshot: ');
    } finally {
      versions.autoUnwatch(autoSite);
      projectsReg.remove(autoProject.id);
    }
  });
}

/* ---------------- pinned serving (?v=<id>) ---------------- */
async function pinnedServingTests() {
  console.log('\npinned serving');

  const dir = scratch('pin-site');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>old</h1></body></html>');
  fs.writeFileSync(path.join(dir, 'clip.bin'), Buffer.from('0123456789'));
  const project = projectsReg.addLocal(dir);
  const snap = await versions.createSnapshot(project, { label: 'checkpoint', source: 'manual' });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>new</h1></body></html>');

  const manager = new ReviewManager({
    projects: projectsReg,
    capturesRoot: () => scratch('pin-caps'),
    exportReview,
    overlayPath: path.join(ROOT, 'renderer', 'review-overlay.js'),
  });
  const hostMgr = new HostManager();
  hostMgr.reviewRouter = d => manager.forDir(d);
  // The same wiring main.js installs: snapshots resolved through the engine.
  hostMgr.versionsRouter = d => {
    const p = projectsReg.byPath(d);
    if (!p) return null;
    return {
      meta: id => versions.getSnapshot(p, id, { optional: true }),
      fileAt: (id, rel) => versions.fileAt(p, id, rel),
    };
  };
  const port = await hostMgr.start(dir, 4720, { liveReload: true });
  manager.enable(dir, project.id);

  const get = (urlPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers, method }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
  const pinCookie = `__ss_version=${snap.id}`;

  try {
    await check('?v=<id> sets the pin cookie and redirects to the clean URL', async () => {
      const res = await get(`/?v=${snap.id}`);
      eq(res.status, 302);
      eq(res.headers.location, '/');
      ok(String(res.headers['set-cookie']).includes(`__ss_version=${snap.id}`), 'cookie set');
    });

    await check('a pinned request serves the snapshot with a banner and no live reload', async () => {
      const res = await get('/', { Cookie: pinCookie });
      eq(res.status, 200);
      ok(res.body.includes('<h1>old</h1>'), 'old content served: ' + res.body.slice(0, 200));
      ok(res.body.includes('Viewing snapshot'), 'pin banner injected');
      ok(res.body.includes('checkpoint'), 'banner names the label');
      ok(!res.body.includes('livereload.js'), 'live reload NOT injected while pinned');
      ok(res.body.includes('review/client.js'), 'review overlay still injected');
    });

    await check('live serving is untouched next to the pin', async () => {
      const res = await get('/');
      ok(res.body.includes('<h1>new</h1>'), 'live content: ' + res.body.slice(0, 200));
      ok(res.body.includes('livereload.js'), 'live reload present on live');
      ok(!res.body.includes('Viewing snapshot'), 'no banner on live');
    });

    await check('range requests work against pinned blobs', async () => {
      const res = await get('/clip.bin', { Cookie: pinCookie, Range: 'bytes=2-5' });
      eq(res.status, 206);
      eq(res.body, '2345');
    });

    await check('?v=live clears the pin; an unknown pin falls back to live', async () => {
      const res = await get('/?v=live', { Cookie: pinCookie });
      eq(res.status, 302);
      ok(String(res.headers['set-cookie']).includes('Max-Age=0'), 'cookie cleared');
      const ghost = await get('/', { Cookie: '__ss_version=2020-01-01T00-00-00Z' });
      ok(ghost.body.includes('<h1>new</h1>'), 'pruned pin serves live');
    });

    await check('dot paths stay hidden even while pinned', async () => {
      eq((await get('/.siteslurp/meta.json', { Cookie: pinCookie })).status, 404);
    });

    await check('a site\'s own ?v= cache-buster is not a pin command', async () => {
      // Captured pages reference assets like style.css?v=123 — that must serve
      // normally, never redirect, and never touch the pin cookie.
      const res = await get('/clip.bin?v=123', { Cookie: pinCookie });
      eq(res.status, 200);
      eq(res.headers['set-cookie'], undefined, 'cookie untouched: ');
      eq(res.body, '0123456789');
    });

    await check('the review API reports pinned:true and refuses annotations from a pinned view', async () => {
      const stateRes = await get('/__siteslurp__/review/state', { Cookie: pinCookie });
      eq(JSON.parse(stateRes.body).pinned, true);
      const live = await get('/__siteslurp__/review/state');
      eq(JSON.parse(live.body).pinned, false);
      const refused = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ scope: 'global', context: {}, input: { why: 'A note against an old page.' } });
        const req = http.request({
          host: '127.0.0.1', port, path: '/__siteslurp__/review/annotate', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Cookie: pinCookie },
        }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      eq(refused.status, 409);
      ok(/live version/.test(JSON.parse(refused.body).error), 'friendly message');
    });
  } finally {
    manager.disable(dir);
    hostMgr.stopAll();
  }
}

/* ---------------- misc ---------------- */
async function miscTests() {
  console.log('\nurl + settings');

  await check('gives each capture its own folder, even within one minute', () => {
    const root = scratch('cap-clash');
    const first = reserveCaptureDir(root, 'example.com');
    const second = reserveCaptureDir(root, 'example.com');
    const third = reserveCaptureDir(root, 'example.com');
    ok(first !== second && second !== third, `${first} / ${second} / ${third}`);
    eq(path.basename(second), path.basename(first) + '-2');
    eq(path.basename(third), path.basename(first) + '-3');
    for (const dir of [first, second, third]) ok(fs.statSync(dir).isDirectory(), dir + ' exists');
  });

  await check('sanitizes folder names taken from user input', () => {
    const root = scratch('cap-name');
    const dir = reserveCaptureDir(root, '../../evil name?<>|');
    eq(path.dirname(dir), root, 'stayed inside the root: ');
    ok(!/[?<>|]/.test(path.basename(dir)), 'illegal characters gone: ' + path.basename(dir));
  });

  await check('normalizes and validates capture urls', () => {
    eq(normalizeUrl('example.com'), 'https://example.com/');
    eq(normalizeUrl(' http://example.com/x '), 'http://example.com/x');
    eq(nameFromUrl('https://www.example.co.uk/page'), 'example.co.uk');
  });

  await check('rejects non-http schemes and junk', async () => {
    await throws(() => normalizeUrl('file:///C:/Windows/win.ini'), 'file: should be refused');
    await throws(() => normalizeUrl('javascript:alert(1)'), 'javascript: should be refused');
    await throws(() => normalizeUrl(''), 'empty should be refused');
  });

  await check('clamps out-of-range settings', () => {
    const saved = settings.save({ defaultPort: 99, depth: 99, waitDelay: -5, sort: 'bogus', autoSnapshotIdleSec: 3 });
    eq(saved.defaultPort, 1024);
    eq(saved.depth, 6);
    eq(saved.waitDelay, 0);
    eq(saved.sort, 'recent');
    eq(saved.autoSnapshotIdleSec, 10);
  });

  await check('survives a corrupt settings file', () => {
    const file = path.join(TMP, 'userData', 'settings.json');
    fs.writeFileSync(file, '{ not json');
    delete require.cache[require.resolve('../lib/settings')];
    const fresh = require('../lib/settings');
    ok(fresh.load().defaultPort === 8008, 'fell back to defaults');
  });

  await check('editor detection answers with a real executable or an honest null', () => {
    const { findEditor } = require('../lib/editor');
    const editor = findEditor();
    if (editor === null) return; // machines without an editor are a valid answer
    ok(typeof editor === 'string' && fs.statSync(editor).isFile(), 'points at a file: ' + editor);
  });

  await check('every preload channel has a main handler, and vice versa (invariant 1)', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const invokeBlock = /const INVOKE = new Set\(\[([\s\S]*?)\]\);/.exec(preload);
    ok(invokeBlock, 'INVOKE set found');
    const allowed = [...invokeBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
    const handled = [...new Set([...main.matchAll(/\bhandle\('([^']+)'/g)].map(m => m[1]))].sort();
    const missingHandler = allowed.filter(c => !handled.includes(c));
    const missingAllow = handled.filter(c => !allowed.includes(c));
    eq(missingHandler, [], 'allowlisted but never handled: ');
    eq(missingAllow, [], 'handled but not allowlisted: ');
  });
}

/* ---------------- runtimes: sites that aren't just files ---------------- */
async function runtimeTests() {
  console.log('\nruntimes');

  const write = (dir, name, body) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return dir;
  };

  await check('reads a Next.js app off its package.json, not its HTML', () => {
    const dir = scratch('rt-next');
    write(dir, 'package.json', JSON.stringify({
      dependencies: { next: '16.2.6', react: '19' },
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    }));
    const found = runtimes.detect(dir);
    eq(found.kind, 'command');
    eq(found.id, 'next');
    ok(found.command.includes('{port}'), 'command takes our port: ' + found.command);
    eq(found.install, 'npm install');
    ok(runtimes.needsInstall(dir, found), 'no node_modules yet');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    ok(!runtimes.needsInstall(dir, found), 'install satisfied by node_modules');
    // The production build is offered as an alternative, never as the default.
    ok(runtimes.candidates(dir).some(c => c.id === 'next:prod'), 'prod build offered');
    ok(runtimes.candidates(dir).some(c => c.id === 'custom'), 'custom always offered');
  });

  await check('lockfiles pick the package manager', () => {
    const dir = write(scratch('rt-pnpm'), 'package.json', JSON.stringify({
      dependencies: { vite: '5' }, scripts: { dev: 'vite' },
    }));
    write(dir, 'pnpm-lock.yaml', '');
    const found = runtimes.detect(dir);
    ok(found.command.startsWith('pnpm run dev'), found.command);
    eq(found.install, 'pnpm install');
  });

  await check('recognises the non-node stacks too', () => {
    const django = write(scratch('rt-django'), 'manage.py', '');
    eq(runtimes.detect(django).id, 'django');
    const php = write(scratch('rt-php'), 'public/index.php', '<?php');
    ok(runtimes.detect(php).command.includes('-t public'), 'docroot found');
    const jekyll = write(scratch('rt-jekyll'), '_config.yml', 'title: x');
    write(jekyll, 'Gemfile', 'source "https://rubygems.org"');
    ok(runtimes.detect(jekyll).command.startsWith('bundle exec jekyll'), 'bundled jekyll');
  });

  await check('a folder of HTML is still just files, and built output counts', () => {
    const plain = write(scratch('rt-static'), 'index.html', '<h1>hi</h1>');
    eq(runtimes.detect(plain).kind, 'static');
    const built = write(scratch('rt-built'), 'dist/index.html', '<h1>built</h1>');
    const found = runtimes.detect(built);
    eq(found.kind, 'static');
    eq(found.root, 'dist');
  });

  await check('nothing recognisable means no runtime, not a wrong guess', () => {
    eq(runtimes.detect(scratch('rt-nothing')), null);
  });

  // The whole point: a project that only exists once a process runs still gets
  // hosted on its own stable SiteSlurp port, with the process supervised.
  await check('hosts a command project through the proxy, then kills it on stop', async () => {
    const dir = scratch('rt-live');
    write(dir, 'server.js', `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>generated at ' + req.url + '</body></html>');
      }).listen(Number(process.argv[2]), '127.0.0.1');
    `);
    const runtime = {
      kind: 'command', id: 'custom', label: 'test server',
      command: `node server.js {port}`,
    };
    const hostMgr = new HostManager();
    const port = await hostMgr.start(dir, 4390, { runtime, name: 'test' });
    const get = urlPath => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { accept: 'text/html' } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      // Hosting returns immediately; until the child answers, the port serves
      // the boot page rather than a connection error.
      const booting = await get('/');
      ok(booting.status === 503 || booting.status === 200, 'boot page or already up: ' + booting.status);

      let body = '';
      for (let attempt = 0; attempt < 100 && !body.includes('generated at'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        body = (await get('/hello')).body;
      }
      ok(body.includes('generated at /hello'), 'proxied to the child: ' + body.slice(0, 120));
      eq(hostMgr.runtimeState(dir).status, 'ready');
      const child = hostMgr.runtimeState(dir).port;
      ok(child !== port, 'child got its own private port');

      hostMgr.stop(dir);
      // The child must go with it — an orphan would hold its port forever.
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        alive = await portAnswers(child, 200);
      }
      ok(!alive, `child on ${child} outlived the host`);
    } finally {
      hostMgr.stopAll();
    }
  });

  // Studio's whole value proposition has to survive the extra hop: annotating a
  // Next.js app must work exactly like annotating a folder of HTML, and the
  // framework's hot reload socket must reach its own server through us.
  await check('review overlay is injected into proxied pages, and upgrades pass through', async () => {
    const dir = scratch('rt-review');
    write(dir, 'server.js', `
      const http = require('http');
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1 class="hero">Generated</h1></body></html>');
      });
      // A stand-in for an HMR socket: accept the upgrade and echo what it hears.
      server.on('upgrade', (req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
        socket.on('data', chunk => socket.write(chunk));
      });
      server.listen(Number(process.argv[2]), '127.0.0.1');
    `);
    const project = projectsReg.addLocal(dir);
    const manager = new ReviewManager({
      projects: projectsReg,
      capturesRoot: () => scratch('rt-review-caps'),
      exportReview,
      overlayPath: path.join(ROOT, 'renderer', 'review-overlay.js'),
    });
    const hostMgr = new HostManager();
    hostMgr.reviewRouter = d => manager.forDir(d);
    const port = await hostMgr.start(dir, 4396, {
      runtime: { kind: 'command', id: 'custom', label: 'test', command: 'node server.js {port}' },
    });
    manager.enable(dir, project.id);
    const get = urlPath => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { accept: 'text/html' } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      let page = { body: '' };
      for (let attempt = 0; attempt < 100 && !page.body.includes('Generated'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        page = await get('/');
      }
      ok(page.body.includes('Generated'), 'child page came through');
      ok(page.body.includes('__siteslurp__/review/client.js'), 'overlay injected: ' + page.body);
      // The overlay's own endpoints are answered by us, not forwarded.
      const overlay = await get('/__siteslurp__/review/client.js');
      eq(overlay.status, 200);

      const echoed = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/hmr',
          headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
        });
        req.on('upgrade', (res, socket) => {
          socket.once('data', chunk => { socket.destroy(); resolve(chunk.toString()); });
          socket.write('ping');
        });
        req.on('error', reject);
        setTimeout(() => reject(new Error('no upgrade came back')), 5000).unref();
        req.end();
      });
      eq(echoed, 'ping');
    } finally {
      manager.disable(dir);
      hostMgr.stopAll();
    }
  });

  await check('a command runtime with no command is refused, not spawned', async () => {
    const hostMgr = new HostManager();
    await throws(() => hostMgr.start(scratch('rt-nocmd'), 4395, {
      runtime: { kind: 'command', id: 'custom', label: 'x', command: '' },
    }), 'empty command refused');
    hostMgr.stopAll();
  });
}

/* ---------------- attach mode: front a server we didn't start ---------------- */
async function attachTests() {
  console.log('\nattach mode');

  await check('parses attach targets and refuses anything that is not loopback', () => {
    const refuse = text => {
      try { runtimes.parseAttachTarget(text); } catch { return; }
      throw new Error(`expected a refusal for ${JSON.stringify(text)}`);
    };
    eq(runtimes.parseAttachTarget('3000'), 3000);
    eq(runtimes.parseAttachTarget(':5173'), 5173);
    eq(runtimes.parseAttachTarget('localhost:3000'), 3000);
    eq(runtimes.parseAttachTarget('127.0.0.1:8080'), 8080);
    eq(runtimes.parseAttachTarget('[::1]:4321'), 4321);
    eq(runtimes.parseAttachTarget('http://localhost:5173/'), 5173);
    eq(runtimes.parseAttachTarget('http://localhost/'), 80, 'default http port: ');
    refuse('192.168.1.20:3000');
    refuse('evil.example:80');
    refuse('http://0.0.0.0:3000');
    refuse('file:///etc/passwd');
    refuse('');
    refuse('not a port');
  });

  await check('attach is always offered as a choice but never detected as a guess', () => {
    const dir = scratch('attach-empty');
    ok(runtimes.candidates(dir).some(c => c.id === 'attach'), 'candidate offered');
    eq(runtimes.detect(dir), null, 'not a detection: ');
  });

  await check('AttachRunner reaches ready, notices death, and reconnects by itself', async () => {
    const backing = http.createServer((req, res) => { res.writeHead(200); res.end('hi'); });
    await new Promise(resolve => backing.listen(0, '127.0.0.1', resolve));
    const port = backing.address().port;

    const runner = new AttachRunner({ port, pollMs: 120 });
    runner.start();
    const until = async (want, ms) => {
      const deadline = Date.now() + ms;
      while (runner.status !== want && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      return runner.status;
    };
    try {
      eq(await until('ready', 5000), 'ready');
      ok(runner.state().attached, 'state says attached');
      eq(runner.state().pid, null, 'no process of ours');

      backing.close();
      backing.closeAllConnections?.();
      eq(await until('failed', 8000), 'failed');
      ok(/still running/.test(runner.message), 'friendly message: ' + runner.message);

      // The server comes back — so does the card, with no clicks.
      const revived = http.createServer((req, res) => { res.writeHead(200); res.end('back'); });
      await new Promise((resolve, reject) => {
        revived.once('error', reject);
        revived.listen(port, '127.0.0.1', resolve);
      });
      try {
        eq(await until('ready', 8000), 'ready');
      } finally {
        revived.close();
        revived.closeAllConnections?.();
      }
    } finally {
      runner.stop();
    }
  });

  await check('hosting an attach runtime proxies to the running server, and stop leaves it alive', async () => {
    const backing = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>their server at ' + req.url + '</body></html>');
    });
    await new Promise(resolve => backing.listen(0, '127.0.0.1', resolve));
    const appPort = backing.address().port;

    const hostMgr = new HostManager();
    const runtime = { kind: 'command', id: 'attach', label: 'attach', command: '', appPort };
    const port = await hostMgr.start(scratch('attach-host'), 4680, { runtime, name: 'attached' });
    const get = urlPath => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: urlPath, headers: { accept: 'text/html' } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }).on('error', reject);
    });
    try {
      let page = { body: '' };
      for (let attempt = 0; attempt < 80 && !page.body.includes('their server'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        page = await get('/hello');
      }
      ok(page.body.includes('their server at /hello'), 'proxied through: ' + page.body.slice(0, 120));
      const state = hostMgr.runtimeState(scratch('attach-host'));
      eq(state.status, 'ready');
      ok(state.attached, 'reports attach');

      hostMgr.stop(scratch('attach-host'));
      // The whole point: their process is not ours to kill.
      ok(await portAnswers(appPort, 800), 'the backing server survived our stop');
    } finally {
      hostMgr.stopAll();
      backing.close();
      backing.closeAllConnections?.();
    }
  });

  await check('an attach runtime without a port is refused', async () => {
    const hostMgr = new HostManager();
    await throws(() => hostMgr.start(scratch('attach-noport'), 4685, {
      runtime: { kind: 'command', id: 'attach', label: 'attach', command: '' },
    }), 'missing appPort refused');
    hostMgr.stopAll();
  });
}

/* ---------------- upstream CSP vs the injected overlay ---------------- */
async function cspTests() {
  console.log('\nproxy csp');

  await check('policies that already allow same-origin pass through untouched', () => {
    for (const policy of [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'; connect-src 'self'",
      'default-src *',
      '',
    ]) {
      eq(adjustCsp(policy).changed, [], policy + ': ');
    }
  });

  await check('nonce-only and none policies gain exactly a self allowance', () => {
    const nonce = adjustCsp("script-src 'nonce-abc123'; connect-src 'self'");
    eq(nonce.changed, ['script-src']);
    ok(nonce.value.includes("script-src 'nonce-abc123' 'self'"), nonce.value);
    ok(nonce.value.includes("connect-src 'self'"), 'connect untouched: ' + nonce.value);

    const none = adjustCsp("script-src 'none'");
    eq(none.changed, ['script-src']);
    ok(none.value.includes("script-src 'self'"), none.value);
    ok(!none.value.includes("'none'"), "'none' cannot coexist with 'self': " + none.value);
  });

  await check('a restrictive default-src grows specific directives, not itself', () => {
    const result = adjustCsp("default-src 'nonce-x'; img-src *");
    eq(result.changed.sort(), ['connect-src', 'script-src']);
    ok(result.value.startsWith("default-src 'nonce-x'"), 'default-src itself unchanged: ' + result.value);
    ok(result.value.includes("script-src 'nonce-x' 'self'"), result.value);
    ok(result.value.includes("connect-src 'nonce-x' 'self'"), result.value);
  });

  await check('script-src-elem is patched when it is the governing directive', () => {
    const result = adjustCsp("script-src 'self'; script-src-elem 'nonce-x'");
    eq(result.changed, ['script-src-elem']);
    ok(result.value.includes("script-src-elem 'nonce-x' 'self'"), result.value);
  });

  await check('the proxy rewrites CSP only on pages it injects into, and warns', async () => {
    const CSP = "script-src 'nonce-abc'; connect-src 'none'";
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP });
      res.end('<html><body>app</body></html>');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const warns = [];
    let inject = true;
    const { handler } = makeProxyHandler(() => ({ status: 'ready', port: upstream.address().port }), {
      warn: message => warns.push(message),
      transformHtml: () => (inject ? (buf => buf) : null),
    });
    const front = http.createServer(handler);
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const get = () => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: front.address().port, path: '/' }, res => {
        res.resume();
        res.on('end', () => resolve(res.headers['content-security-policy']));
      }).on('error', reject);
    });
    try {
      const patched = await get();
      ok(patched.includes("script-src 'nonce-abc' 'self'"), 'script allowed: ' + patched);
      ok(patched.includes("connect-src 'self'"), 'connect allowed: ' + patched);
      eq(warns.length, 1, 'one WARN per rewrite: ');
      ok(/Content-Security-Policy/.test(warns[0]), warns[0]);

      inject = false; // overlay off → the app's own policy passes byte-exact
      eq(await get(), CSP);
      eq(warns.length, 1, 'no warn without a rewrite: ');
    } finally {
      front.close(); front.closeAllConnections?.();
      upstream.close(); upstream.closeAllConnections?.();
    }
  });
}

/* ---------------- sharing ---------------- */
async function sharingTests() {
  console.log('\nsharing');

  await check('finds the public address in cloudflared output, nothing else', () => {
    const banner = [
      '2026-08-06T08:00:00Z INF Thank you for trying Cloudflare Tunnel. If you intend to use',
      'Tunnels in production you should read: https://developers.cloudflare.com/cloudflare-one/',
      '2026-08-06T08:00:02Z INF +------------------------------------------------------------+',
      '2026-08-06T08:00:02Z INF |  Your quick Tunnel has been created! Visit it at:          |',
      '2026-08-06T08:00:02Z INF |  https://liberia-sandwich-brings-relatives.trycloudflare.com  |',
      '2026-08-06T08:00:02Z INF +------------------------------------------------------------+',
    ].join('\n');
    eq(parsePublicUrl(banner), 'https://liberia-sandwich-brings-relatives.trycloudflare.com');
    eq(parsePublicUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
    eq(parsePublicUrl('read https://developers.cloudflare.com/cloudflare-one/'), null);
  });

  await check('a request through the tunnel is recognised by its edge headers', () => {
    eq(viaTunnel({ headers: {} }), false);
    eq(viaTunnel({ headers: { 'cf-connecting-ip': '203.0.113.9' } }), true);
    eq(viaTunnel({ headers: { 'cf-ray': '8a1b2c3d4e5f-EWR' } }), true);
  });

  // Review Mode can reveal folders and write exports on this machine, and live
  // reload is tooling for the person at the keyboard. Neither may exist for a
  // visitor who arrived through the public link.
  await check('review and live reload are local-only: hidden from tunneled requests', async () => {
    const dir = scratch('share-guard');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>Hi</h1></body></html>');
    const liveStub = {
      inject: buf => Buffer.concat([buf, Buffer.from('<script>LIVE</script>')]),
      handleRequest: (req, res) => { res.writeHead(200); res.end('sse'); },
    };
    const reviewStub = {
      handleRequest: (req, res) => { res.writeHead(200); res.end('review api'); },
    };
    const handler = makeHandler(dir, { live: () => liveStub, review: () => reviewStub });
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const get = (urlPath, headers = {}) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: urlPath, headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }).on('error', reject);
    });
    const edge = { 'cf-connecting-ip': '203.0.113.9' };
    try {
      const local = await get('/');
      ok(local.body.includes('review/client.js'), 'local page carries the overlay');
      ok(local.body.includes('LIVE'), 'local page carries live reload');
      const remote = await get('/', edge);
      ok(!remote.body.includes('review/client.js'), 'tunneled page has no overlay');
      ok(!remote.body.includes('LIVE'), 'tunneled page has no live reload');
      ok(remote.body.includes('<h1>Hi</h1>'), 'the site itself still serves');
      eq((await get('/__siteslurp__/review/api/state')).status, 200);
      eq((await get('/__siteslurp__/review/api/state', edge)).status, 404, 'review api is local-only: ');
      eq((await get('/__siteslurp__/events')).status, 200);
      eq((await get('/__siteslurp__/events', edge)).status, 404, 'live reload is local-only: ');
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  });

  await check('tunneled requests reach the dev server with a localhost host header', async () => {
    // Vite 6+ rejects Host values it doesn't know as DNS-rebinding attempts;
    // the proxy answers for the tunnel by asking upstream for localhost.
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(JSON.stringify({ host: req.headers.host, forwarded: req.headers['x-forwarded-host'] }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream.address().port;
    const { handler } = makeProxyHandler(() => ({ status: 'ready', port: upstreamPort }));
    const front = http.createServer(handler);
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const port = front.address().port;
    const get = headers => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      }).on('error', reject);
    });
    try {
      const local = await get({ host: `localhost:${port}` });
      eq(local.host, `localhost:${port}`, 'local host header passes through: ');
      const remote = await get({ host: 'random-words.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9' });
      eq(remote.host, `127.0.0.1:${upstreamPort}`, 'tunneled host is rewritten: ');
      eq(remote.forwarded, 'random-words.trycloudflare.com', 'original host survives in x-forwarded-host: ');
    } finally {
      front.close(); front.closeAllConnections?.();
      upstream.close(); upstream.closeAllConnections?.();
    }
  });
}

/* ---------------- run ---------------- */
(async () => {
  console.log(`SiteSlurp checks  (scratch: ${TMP})`);
  await paletteTests();
  await extractTests();
  await zipTests();
  await serverTests();
  await entryTests();
  await projectTests();
  // After projectTests: registering a project here would shift the ports it
  // asserts absolutely.
  await runtimeTests();
  await attachTests();
  await cspTests();
  await sharingTests();
  await liveReloadTests();
  await reviewStoreTests();
  await reviewExportTests();
  await resolveLoopTests();
  await reviewApiTests();
  await versionTests();
  await pinnedServingTests();
  await miscTests();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const [name, err] of failures) console.log(`\n${name}\n${err.stack}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
