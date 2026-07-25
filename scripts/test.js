/* Plain-node checks for the parts of SiteSnap that don't need a window.
 * Run with: npm test
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesnap-test-'));

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

const { scanPalette, applyColor, undoColor, parseColor } = require('../lib/palette');
const { extractSite, uniqueOutDir } = require('../lib/extract');
const { zipFolder } = require('../lib/zip');
const { makeHandler, HostManager } = require('../lib/server');
const { resolveEntry } = require('../lib/entry');
const { normalizeUrl, nameFromUrl, reserveCaptureDir } = require('../lib/capture');
const settings = require('../lib/settings');

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

  await check('undo restores the previous content', () => {
    const dir = scratch('pal-undo');
    const file = path.join(dir, 'index.html');
    const before = '<i style="color:#ff0000">x</i>';
    fs.writeFileSync(file, before);
    applyColor(dir, '255,0,0', '#123456');
    ok(fs.readFileSync(file, 'utf8') !== before, 'file changed');
    const { restored } = undoColor(dir);
    eq(restored, 1);
    eq(fs.readFileSync(file, 'utf8'), before);
  });

  await check('reports zero when the color is absent', () => {
    const dir = scratch('pal-none');
    fs.writeFileSync(path.join(dir, 'index.html'), '<b>no colors here</b>');
    const result = applyColor(dir, '1,2,3', '#ffffff');
    eq(result.replaced, 0);
    eq(result.undoId, null);
    ok(!fs.existsSync(path.join(dir, '.sitesnap')) || !fs.readdirSync(path.join(dir, '.sitesnap', 'undo')).length,
      'no empty snapshot left behind');
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
  fs.mkdirSync(path.join(src, '.sitesnap'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index.html'), '<h1>hello</h1>'.repeat(200));
  fs.writeFileSync(path.join(src, 'css', 'a.css'), 'body{color:red}');
  fs.writeFileSync(path.join(src, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255, 254]));
  fs.writeFileSync(path.join(src, '.sitesnap', 'secret.txt'), 'should not be zipped');

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
    ok(!fs.existsSync(path.join(dest, '.sitesnap')), 'dot-folder stayed out');
  });

  await check('rejects an empty folder', () => throws(() => zipFolder(scratch('zip-empty'), path.join(TMP, 'e.zip'))));
}

/* ---------------- static server ---------------- */
async function serverTests() {
  console.log('\nserver');

  const site = scratch('srv-site');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(site, '.sitesnap'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(site, 'assets', 'clip.mp4'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(site, '.sitesnap', 'secret.txt'), 'nope');
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
      const res = await get('/.sitesnap/secret.txt');
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
    fs.writeFileSync(path.join(dir, 'sitesnap.json'), JSON.stringify({ entry: 'zzz.html' }));
    eq(resolveEntry(dir), 'zzz.html');
  });

  await check('derives the homepage from the source url, not the sitemap', () => {
    const dir = scratch('entry-url');
    fs.writeFileSync(path.join(dir, '_index.html'), 'sitemap');
    fs.writeFileSync(path.join(dir, '_en.html'), 'home');
    fs.writeFileSync(path.join(dir, '_en_about.html'), 'about');
    fs.writeFileSync(path.join(dir, 'sitesnap.json'),
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
    fs.writeFileSync(path.join(dir, 'sitesnap.json'), JSON.stringify({ url: 'https://x.test/en' }));
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
    const saved = settings.save({ defaultPort: 99, depth: 99, waitDelay: -5, sort: 'bogus' });
    eq(saved.defaultPort, 1024);
    eq(saved.depth, 6);
    eq(saved.waitDelay, 0);
    eq(saved.sort, 'recent');
  });

  await check('survives a corrupt settings file', () => {
    const file = path.join(TMP, 'userData', 'settings.json');
    fs.writeFileSync(file, '{ not json');
    delete require.cache[require.resolve('../lib/settings')];
    const fresh = require('../lib/settings');
    ok(fresh.load().defaultPort === 8008, 'fell back to defaults');
  });
}

/* ---------------- run ---------------- */
(async () => {
  console.log(`SiteSnap checks  (scratch: ${TMP})`);
  await paletteTests();
  await extractTests();
  await zipTests();
  await serverTests();
  await entryTests();
  await miscTests();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const [name, err] of failures) console.log(`\n${name}\n${err.stack}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
