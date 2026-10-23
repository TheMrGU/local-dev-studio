/* Plain-node checks for the parts of Local Dev Studio that don't need a window.
 * Run with: npm test
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

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
    // Enough safeStorage for the secrets tests: reversible, clearly not the
    // plaintext, and shaped like the real API (Buffers in, Buffers out).
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: s => Buffer.from('enc!' + s, 'utf8'),
      decryptString: b => {
        const text = Buffer.from(b).toString('utf8');
        if (!text.startsWith('enc!')) throw new Error('bad ciphertext');
        return text.slice(4);
      },
    },
  },
};

const { scanPalette, applyColor, undoColor, listUndo, parseColor } = require('../lib/palette');
const { extractSite, uniqueOutDir } = require('../lib/extract');
const { zipFolder, zipFiles, folderEntries } = require('../lib/zip');
const staticAudit = require('../lib/staticAudit');
const { makeHandler, HostManager } = require('../lib/server');
const { makeProxyHandler, adjustCsp } = require('../lib/proxy');
const { parsePublicUrl, viaTunnel } = require('../lib/tunnel');
const runtimes = require('../lib/runtimes');
const { Runner, AttachRunner, freePort, portAnswers } = require('../lib/runner');
const { CHECKLISTS } = require('../lib/checklists');
const { resolveEntry } = require('../lib/entry');
const { normalizeUrl, nameFromUrl, reserveCaptureDir, writeManifest, readManifest,
  parseUrlList, parseHeaderLines, crawlScopeRules, filterByGlobs, buildArgs } = require('../lib/capture');
const { isSitemapUrl, parseSitemap, fetchSitemapUrls } = require('../lib/sitemap');
const versions = require('../lib/versions');
const { watchFolder } = require('../lib/watch');
const settings = require('../lib/settings');
const projectsReg = require('../lib/projects');
const { describeLocal } = require('../lib/library');
const { LiveReload } = require('../lib/livereload');
const reviewsStore = require('../lib/reviews');
const calibrationStore = require('../lib/calibration');
const { exportReview, styleLine, renderAnnotation, renderReviewMd } = require('../lib/reviewExport');
const { ReviewManager } = require('../lib/review');
const { fixModels } = require('../lib/modelfix');
const { mirrorSite, parseCookiesFile, localSegments, siteOrigins, builtByScripts, absolutizeDocument, documentReferences,
  routeShape, rootReferences, TYPES_FILE } = require('../lib/mirror');
const { GrabManager, localPathFor } = require('../lib/grab');
const { MenuManager } = require('../lib/menu');
const { locateSource } = require('../lib/sourceline');
const { ControlServer } = require('../lib/control');
const { GuestManager } = require('../lib/guest');
const certs = require('../lib/certs');
const secrets = require('../lib/secrets');
const httpsMod = require('https');

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

  await check('leaves a data URI inside a custom property inline', async () => {
    // url() reached through var() resolves against the stylesheet using it,
    // so a file path written into `--icon:url(…)` would 404 under css/.
    const src = scratch('ex-customprop');
    const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>');
    fs.writeFileSync(path.join(src, 'a.html'),
      `<span style="--icon:url(${svg})"></span><span style="--bg: url('data:image/png;base64,${pngB64}')"></span><img src="data:image/png;base64,${pngB64}">`);
    const out = path.join(TMP, 'ex-customprop-out');
    const stats = await extractSite(src, out, {});
    const html = fs.readFileSync(path.join(out, 'a.html'), 'utf8');
    ok(html.includes(`--icon:url(${svg})`), 'svg custom property kept inline: ' + html);
    ok(html.includes(`--bg: url('data:image/png;base64,${pngB64}')`), 'base64 custom property kept inline: ' + html);
    ok(/<img src="assets\/images\/img-[0-9a-f]{10}\.png">/.test(html), 'an ordinary data URI still becomes a file: ' + html);
    eq(stats.images, 1);
  });

  await check('makes the site’s own absolute links root-relative', async () => {
    const src = scratch('ex-origin');
    fs.writeFileSync(path.join(src, '_.html'), [
      '<!DOCTYPE html> <html lang=en><!--\n Page saved with SingleFile \n url: https://www.site.test/ \n-->',
      '<a href=https://site.test/shop>s</a><a href="https://www.site.test">h</a><a href="https://site.test?x=1">q</a>',
      '<a href="https://site.test.evil.com/a">e</a><link rel=canonical href="http://site.test/store">',
      '<script>self.__next_f.push([1,"\\"u\\":\\"https://site.test/media/a.webp\\""])</script>',
    ].join(''));
    const out = path.join(TMP, 'ex-origin-out');
    await extractSite(src, out, { siteUrl: 'https://site.test/' });
    const html = fs.readFileSync(path.join(out, '_.html'), 'utf8');
    ok(html.includes('url: https://www.site.test/ '), 'header untouched: ' + html);
    ok(html.includes('href=/shop>'), 'unquoted link: ' + html);
    ok(html.includes('href="/"'), 'bare origin becomes the root: ' + html);
    ok(html.includes('href="/?x=1"'), 'bare origin with a query: ' + html);
    ok(html.includes('https://site.test.evil.com/a'), 'a longer host is not the site: ' + html);
    ok(html.includes('href="/store"'), 'either scheme, www or not: ' + html);
    ok(html.includes('\\"u\\":\\"/media/a.webp\\"'), 'inside an inlined payload too: ' + html);
    const plain = path.join(TMP, 'ex-origin-plain');
    await extractSite(src, plain, {});
    ok(fs.readFileSync(path.join(plain, '_.html'), 'utf8').includes('href=https://site.test/shop>'), 'nothing changes without a site URL');
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

  await check('kept scripts come out as .js files, models as .glb', async () => {
    const src = scratch('ex-js');
    const jsB64 = Buffer.from('console.log("hi from a kept script")').toString('base64');
    const glbB64 = Buffer.from('glTF-binary-payload-here').toString('base64');
    fs.writeFileSync(path.join(src, 'a.html'), [
      `<script src="data:text/javascript;base64,${jsB64}"></script>`,
      `<a href="data:model/gltf-binary;base64,${glbB64}">scene</a>`,
    ].join('\n'));
    const out = path.join(TMP, 'ex-js-out');
    const stats = await extractSite(src, out, {});
    eq(stats.scripts, 1);
    eq(stats.models, 1);
    const script = fs.readdirSync(path.join(out, 'assets', 'scripts'))[0];
    ok(/^script-[0-9a-f]{10}\.js$/.test(script), 'js extension: ' + script);
    const model = fs.readdirSync(path.join(out, 'assets', 'models'))[0];
    ok(/^model-[0-9a-f]{10}\.glb$/.test(model), 'glb extension: ' + model);
  });

  await check('a <style> string inside a kept script is not torn out', async () => {
    const src = scratch('ex-jsstyle');
    const styleStr = `<style>${'.injected{color:blue}'.padEnd(100, ' ')}</style>`;
    fs.writeFileSync(path.join(src, 'a.html'),
      `<script>document.head.insertAdjacentHTML('beforeend', '${styleStr}')</script>`);
    const out = path.join(TMP, 'ex-jsstyle-out');
    await extractSite(src, out, {});
    const html = fs.readFileSync(path.join(out, 'a.html'), 'utf8');
    ok(html.includes('.injected{color:blue}'), 'script-embedded style survived: ' + html);
  });

  await check('keepHiddenStyles leaves reveal styles for the scripts to animate', async () => {
    const src = scratch('ex-keephidden');
    fs.writeFileSync(path.join(src, 'a.html'),
      '<div style="opacity: 0; transform: translateY(40px)">reveal</div>');
    const out = path.join(TMP, 'ex-keephidden-out');
    await extractSite(src, out, { keepHiddenStyles: true });
    const html = fs.readFileSync(path.join(out, 'a.html'), 'utf8');
    ok(/opacity:\s*0/.test(html), 'hidden style kept: ' + html);
  });
}

/* ---------------- modelfix ---------------- */
async function modelfixTests() {
  console.log('\nmodelfix');

  await check('mirrors script-fetched assets and rewrites references', async () => {
    const payload = 'glTF-binary-bytes';
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/deep/models/scene.glb') || req.url === '/img/thumb.webp') {
        res.writeHead(200); res.end(payload);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    try {
      const dir = scratch('mf-site');
      fs.writeFileSync(path.join(dir, 'a.html'), [
        `<!--\n Page saved with SingleFile \n url: ${origin}/deep/page/ \n-->`,
        '<script>loader.load(\'../models/scene.glb?v=3\')</script>',
      ].join('\n'));
      // Runtime media referenced only from an extracted script file.
      fs.mkdirSync(path.join(dir, 'assets', 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'assets', 'scripts', 'script-abc.js'),
        'const thumbs = ["./img/thumb.webp"];');

      const count = await fixModels(dir, origin + '/', () => {});
      eq(count, 2);
      eq(fs.readFileSync(path.join(dir, 'deep', 'models', 'scene.glb'), 'utf8'), payload);
      eq(fs.readFileSync(path.join(dir, 'img', 'thumb.webp'), 'utf8'), payload);
      const html = fs.readFileSync(path.join(dir, 'a.html'), 'utf8');
      ok(html.includes("loader.load('/deep/models/scene.glb')"), 'reference rewritten root-relative: ' + html);
      const js = fs.readFileSync(path.join(dir, 'assets', 'scripts', 'script-abc.js'), 'utf8');
      ok(js.includes('"/img/thumb.webp"'), 'script reference rewritten: ' + js);
    } finally {
      server.close();
    }
  });

  await check('never mistakes method calls for asset paths', async () => {
    const dir = scratch('mf-methods');
    const js = 'fetch("/api").then((res) => res.json()); const t = img.webp; go(sprite.png);';
    fs.mkdirSync(path.join(dir, 'assets', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'scripts', 'script-a.js'), js);
    fs.writeFileSync(path.join(dir, 'a.html'), '<!--\n url: https://site.test/ \n--><p>hi</p>');
    const count = await fixModels(dir, 'https://site.test/', () => {});
    eq(count, 0);
    eq(fs.readFileSync(path.join(dir, 'assets', 'scripts', 'script-a.js'), 'utf8'), js);
  });

  await check('leaves unreachable and hostile references alone', async () => {
    const dir = scratch('mf-bad');
    const page = [
      '<!--\n Page saved with SingleFile \n url: https://site.test/ \n-->',
      '<script>load(\'../../../etc/passwd.glb\')</script>',
      '<script>load(\'data:model/gltf-binary;base64,AAAA.glb\')</script>',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'a.html'), page);
    // site.test never resolves — downloads fail, references stay untouched.
    const count = await fixModels(dir, 'https://site.test/', () => {});
    eq(count, 0);
    eq(fs.readFileSync(path.join(dir, 'a.html'), 'utf8'), page);
  });

  await check('keeps a JSON-escaped payload intact when rewriting a URL inside it', async () => {
    // Next.js inlines its page data as `self.__next_f.push([1,"…\"image\":\"https://…png\"…"])`.
    // Swallowing the `\` before the closing quote used to end the JS string
    // early — a syntax error that took the whole app down at boot.
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('PNG'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const dir = scratch('mf-escaped');
      const script = `self.__next_f.push([1,"3:{\\"image\\":\\"${origin}/files/a.png?v=1\\",\\"x\\":1}"])`;
      fs.writeFileSync(path.join(dir, '_.html'),
        `<!DOCTYPE html> <html lang=en class=x><!--\n Page saved with SingleFile \n url: https://site.test/ \n--><script>${script}</script>`);
      const count = await fixModels(dir, 'https://site.test/', () => {});
      eq(count, 1);
      const html = fs.readFileSync(path.join(dir, '_.html'), 'utf8');
      ok(html.includes('\\"image\\":\\"/assets/remote/127.0.0.1/files/a.png\\",\\"x\\"'), 'rewritten with the escape kept: ' + html);
      const body = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
      new (require('vm').Script)(body); // still parses
    } finally {
      server.close();
    }
  });

  await check('treats the hosts the mirror saw the site answer on as the site itself', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/models/a.glb') { res.writeHead(200); res.end('GLB'); } else { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const dir = scratch('modelfix-origins');
      fs.writeFileSync(path.join(dir, '_.html'), `<!--\n url: https://site.test/ \n--><script>load("${origin}/models/a.glb")</script>`);
      const count = await fixModels(dir, 'https://site.test/', () => {}, { origins: [origin] });
      eq(count, 1);
      ok(fs.existsSync(path.join(dir, 'models', 'a.glb')), 'landed at its real path, not under assets/remote');
      ok(fs.readFileSync(path.join(dir, '_.html'), 'utf8').includes('load("/models/a.glb")'), 'reference rewritten root-relative');
    } finally {
      server.close();
    }
  });
}

/* ---------------- mirror ---------------- */
async function mirrorTests() {
  console.log('\nmirror');

  // A fake recorder standing in for the offscreen browser: hands the sink
  // exactly what the DevTools Network domain would have.
  const fakeRecord = responses => async (pageUrl, { sink }) => {
    for (const r of responses[pageUrl] || []) sink({ status: 200, ...r, body: Buffer.from(r.body) });
    return { requests: (responses[pageUrl] || []).length, failed: [] };
  };

  await check('mirrors runtime fetches at their real paths and rewrites every reference', async () => {
    const dir = scratch('mirror-site');
    const entry = 'const b="https://site.test/";import("./App-abc.js");fetch("https://cdn.example.com/lib/draco.wasm")';
    fs.mkdirSync(path.join(dir, 'assets', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    // Extraction wrote the inlined entry module under a hash name.
    fs.writeFileSync(path.join(dir, 'assets', 'scripts', 'script-0a03.js'), entry);
    fs.writeFileSync(path.join(dir, 'css', 'style-1.css'), '@font-face{src:url(https://site.test/assets/f.woff2)}');
    fs.writeFileSync(path.join(dir, '_.html'), [
      '<!DOCTYPE html> <html lang=en><!--\n Page saved with SingleFile \n url: https://site.test/ \n-->',
      '<script type=module crossorigin src="assets/scripts/script-0a03.js"></script>',
      '<link rel=canonical href=https://site.test/><div id=app></div>',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, '_index.html'), '<ul><li><a href="_.html">Home</a></li></ul>');

    const stats = await mirrorSite(dir, 'https://site.test/', {
      entry: '_.html',
      record: fakeRecord({
        'https://site.test/': [
          { url: 'https://site.test/assets/index-2eb6.js', mime: 'application/javascript', body: entry },
          { url: 'https://site.test/assets/App-abc.js', mime: 'application/javascript', body: 'load("https://site.test/assets/geo/igloo.drc?v=2")' },
          { url: 'https://site.test/assets/geo/igloo.drc?v=2', mime: 'application/octet-stream', body: 'DRACO' },
          { url: 'https://site.test/assets/f.woff2', mime: 'font/woff2', body: 'wOF2' },
          { url: 'https://cdn.example.com/lib/draco.wasm', mime: 'application/wasm', body: '\0asm' },
          { url: 'https://site.test/', mime: 'text/html', body: '<html>' },              // the document itself
          { url: 'https://site.test/api/', mime: 'application/json', body: '{}' },       // directory-shaped
          { url: 'blob:https://site.test/abc', mime: 'image/png', body: 'x' },
          // The URL parser collapses dot-dot segments before they reach the
          // path mapper — this is a root file, not an escape.
          { url: 'https://site.test/../../top.js', mime: 'text/javascript', body: 'x' },
          { url: 'https://site.test/a/b%3Cc%3E.js', mime: 'text/javascript', body: 'x' },
        ],
      }),
    }, () => {});

    eq(stats.pages, 1);
    eq(stats.files, 7, 'files: ');
    eq(stats.deduped, 1, 'deduped: ');
    eq(fs.readFileSync(path.join(dir, 'assets', 'geo', 'igloo.drc'), 'utf8'), 'DRACO');
    eq(fs.readFileSync(path.join(dir, 'assets', 'remote', 'cdn.example.com', 'lib', 'draco.wasm'), 'utf8'), '\0asm');
    ok(fs.existsSync(path.join(dir, 'top.js')), 'dot-dot collapsed to a root file');
    ok(fs.existsSync(path.join(dir, 'a', 'b_c_.js')), 'characters Windows refuses are replaced');
    ok(!fs.existsSync(path.join(path.dirname(dir), 'top.js')), 'nothing escapes the site folder');
    ok(!fs.existsSync(path.join(dir, 'api')), 'directory-shaped fetch skipped');
    ok(!fs.existsSync(path.join(dir, 'assets', 'scripts', 'script-0a03.js')), 'duplicate extracted script removed');

    const html = fs.readFileSync(path.join(dir, '_.html'), 'utf8');
    ok(html.includes('url: https://site.test/ '), 'SingleFile header comment left intact: ' + html);
    ok(html.includes('src="/assets/index-2eb6.js"'), 'page points at the mirrored entry module: ' + html);
    const index = fs.readFileSync(path.join(dir, 'assets', 'index-2eb6.js'), 'utf8');
    ok(index.includes('const b="/"'), 'bare origin literal becomes root-relative: ' + index);
    ok(index.includes('fetch("/assets/remote/cdn.example.com/lib/draco.wasm")'), 'cross-origin URL rewritten: ' + index);
    ok(index.includes('import("./App-abc.js")'), 'relative import untouched: ' + index);
    const app = fs.readFileSync(path.join(dir, 'assets', 'App-abc.js'), 'utf8');
    ok(app.includes('load("/assets/geo/igloo.drc")'), 'query-string variant rewritten to the file: ' + app);
    const css = fs.readFileSync(path.join(dir, 'css', 'style-1.css'), 'utf8');
    ok(css.includes('url(/assets/f.woff2)'), 'extracted css rewritten: ' + css);
    eq(fs.readFileSync(path.join(dir, 'assets', 'geo', 'igloo.drc'), 'utf8'), 'DRACO', 'binary left verbatim');
    const manifestish = fs.readFileSync(path.join(dir, '_index.html'), 'utf8');
    eq(manifestish, '<ul><li><a href="_.html">Home</a></li></ul>', 'hub untouched');
  });

  await check('never overwrites what extraction already wrote, and records every page', async () => {
    const dir = scratch('mirror-pages');
    fs.writeFileSync(path.join(dir, '_.html'), '<!--\n url: https://site.test/ \n--><p>home</p>');
    fs.writeFileSync(path.join(dir, '_about.html'), '<!--\n url: https://site.test/about \n--><p>about</p>');
    fs.mkdirSync(path.join(dir, 'assets', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'images', 'hero.png'), 'extracted-bytes');
    const seen = [];
    const stats = await mirrorSite(dir, 'https://site.test/', {
      record: async (pageUrl, { sink }) => {
        seen.push(pageUrl);
        sink({ url: 'https://site.test/assets/images/hero.png', mime: 'image/png', status: 200, body: Buffer.from('live-bytes') });
        sink({ url: `https://site.test/chunk-${seen.length}.js`, mime: 'text/javascript', status: 200, body: Buffer.from('x') });
        return { requests: 2, failed: [] };
      },
    }, () => {});
    eq(seen, ['https://site.test/', 'https://site.test/about']);
    eq(stats.pages, 2);
    eq(stats.files, 2, 'only the chunks were new: ');
    eq(fs.readFileSync(path.join(dir, 'assets', 'images', 'hero.png'), 'utf8'), 'extracted-bytes');
  });

  await check('names route shapes and root-relative references', () => {
    eq(routeShape('https://s.test/'), '/0');
    eq(routeShape('https://s.test/shop?type=x'), 'shop/1');
    eq(routeShape('https://s.test/Shop/a-b'), 'shop/2');
    const text = '<script src="/_next/a.js"></script><img src="/i/x.png"><a href="/about">x</a>'
      + '<script>p([1,"\\"img\\":\\"/media/p.webp\\""]);import("/c.mjs");u("//cdn.test/x.js");q("/__siteslurp__/x.js");r("/a/../b.css")</script>';
    eq([...rootReferences(text)], ['/_next/a.js', '/i/x.png', '/media/p.webp', '/c.mjs', '/a/../b.css']);
  });

  await check('records one page of every route shape first, then sweeps what the rest still reference', async () => {
    const served = { '/_next/c2.js': 'C2', '/media/p2.webp': 'P2' };
    const server = http.createServer((req, res) => {
      if (served[req.url]) { res.writeHead(200); res.end(served[req.url]); } else { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const dir = scratch('mirror-sweep');
      const page = (u, body) => `<!DOCTYPE html> <html lang=en><!--\n Page saved with SingleFile \n url: ${u} \n-->${body}`;
      fs.writeFileSync(path.join(dir, '_.html'), page(`${origin}/`, '<script src="/_next/c1.js"></script>'));
      fs.writeFileSync(path.join(dir, '_shop.html'), page(`${origin}/shop?type=a`, '<p>a</p>'));
      fs.writeFileSync(path.join(dir, '_shop (2).html'), page(`${origin}/shop?type=b`, '<p>b</p>'));
      fs.writeFileSync(path.join(dir, '_shop (3).html'), page(`${origin}/shop`, '<p>plain</p>'));
      fs.writeFileSync(path.join(dir, '_shop_p1.html'), page(`${origin}/shop/p1`, '<script src="/_next/c2.js"></script>'));
      fs.writeFileSync(path.join(dir, '_shop_p2.html'), page(`${origin}/shop/p2`, '<script>self.__next_f.push([1,"\\"img\\":\\"/media/p2.webp\\""])</script><a href="/nope.js">x</a>'));
      const seen = [];
      const stats = await mirrorSite(dir, origin + '/', {
        entry: '_.html',
        record: async (pageUrl, { sink }) => {
          seen.push(pageUrl);
          if (pageUrl === origin + '/') sink({ url: origin + '/_next/c1.js', mime: 'text/javascript', status: 200, body: Buffer.from('c1') });
          return { requests: 1, failed: [] };
        },
      }, () => {});
      eq(seen.slice(0, 3), [origin + '/', origin + '/shop', origin + '/shop/p1'], 'one of each shape first, the plainest of each: ');
      eq(stats.pages, 6, 'a small site still records every page: ');
      eq(fs.readFileSync(path.join(dir, '_next', 'c1.js'), 'utf8'), 'c1');
      eq(fs.readFileSync(path.join(dir, '_next', 'c2.js'), 'utf8'), 'C2', 'a chunk the recorder never saw was fetched: ');
      eq(fs.readFileSync(path.join(dir, 'media', 'p2.webp'), 'utf8'), 'P2', 'an image named in an escaped payload was fetched: ');
      eq(stats.failed, 1, '/nope.js was tried once: ');
      ok(!fs.existsSync(path.join(dir, 'nope.js')), 'a 404 leaves nothing behind');
    } finally {
      server.close();
    }
  });

  await check('remembers the type of an extensionless file so the server can run it', async () => {
    const dir = scratch('mirror-types');
    fs.writeFileSync(path.join(dir, '_.html'), '<!--\n url: https://site.test/ \n--><script src="https://cdn.test/embed/api/v1"></script>');
    await mirrorSite(dir, 'https://site.test/', {
      record: async (pageUrl, { sink }) => {
        sink({ url: 'https://cdn.test/embed/api/v1', mime: 'text/javascript; charset=utf-8', status: 200, body: Buffer.from('js!') });
        sink({ url: 'https://cdn.test/lib/x.js', mime: 'text/javascript', status: 200, body: Buffer.from('x') });
        // A router's prefetch of another route is a page, not a file.
        sink({ url: 'https://site.test/shop?_rsc=1', mime: 'text/x-component', status: 200, body: Buffer.from('0:[]') });
        sink({ url: 'https://site.test/about', mime: 'text/html; charset=utf-8', status: 200, body: Buffer.from('<p>') });
        return { requests: 4, failed: [] };
      },
    }, () => {});
    const types = JSON.parse(fs.readFileSync(path.join(dir, TYPES_FILE), 'utf8'));
    eq(types, { 'assets/remote/cdn.test/embed/api/v1': 'text/javascript' }, 'only the extensionless file is listed: ');
    ok(!fs.existsSync(path.join(dir, 'shop')) && !fs.existsSync(path.join(dir, 'about')), 'page payloads never become files');
    ok(fs.readFileSync(path.join(dir, '_.html'), 'utf8').includes('src="/assets/remote/cdn.test/embed/api/v1"'), 'reference rewritten');
    const server = http.createServer(makeHandler(dir));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const get = p => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: p }, r => {
        let body = '';
        r.on('data', c => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body }));
      }).on('error', reject);
    });
    try {
      const res = await get('/assets/remote/cdn.test/embed/api/v1');
      eq(res.type, 'text/javascript');
      eq(res.body, 'js!');
      eq((await get(`/${TYPES_FILE}`)).status, 404, 'the types file itself is never served: ');
    } finally {
      server.close();
    }
  });

  await check('falls back to a plain download when the browser dropped a body', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/big/model.glb') { res.writeHead(200); res.end('GLB'); } else { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const dir = scratch('mirror-fallback');
      fs.writeFileSync(path.join(dir, '_.html'), `<!--\n url: ${origin}/ \n--><script>load("${origin}/big/model.glb")</script>`);
      const stats = await mirrorSite(dir, origin + '/', {
        record: async (pageUrl, { sink }) => {
          // What the protocol hands back for a worker's fetch: an empty body.
          sink({ url: `${origin}/big/model.glb`, mime: 'model/gltf-binary', status: 200, body: Buffer.alloc(0) });
          return { requests: 1, failed: [`${origin}/big/model.glb`, `${origin}/missing.bin`] };
        },
      }, () => {});
      eq(stats.files, 1);
      eq(stats.failed, 1);
      eq(fs.readFileSync(path.join(dir, 'big', 'model.glb'), 'utf8'), 'GLB');
      ok(fs.readFileSync(path.join(dir, '_.html'), 'utf8').includes('load("/big/model.glb")'), 'reference rewritten');
    } finally {
      server.close();
    }
  });

  await check('a cancel mid-mirror propagates as a cancel', async () => {
    const dir = scratch('mirror-cancel');
    fs.writeFileSync(path.join(dir, '_.html'), '<!--\n url: https://site.test/ \n--><p>x</p>');
    const controller = new AbortController();
    controller.abort();
    let err = null;
    try { await mirrorSite(dir, 'https://site.test/', { signal: controller.signal, record: async () => ({ failed: [] }) }); }
    catch (e) { err = e; }
    ok(err && err.canceled, 'canceled error expected');
  });

  await check('reads Netscape and JSON cookie exports', () => {
    const netscape = [
      '# Netscape HTTP Cookie File',
      '.site.test\tTRUE\t/\tTRUE\t1893456000\tsession\tabc123',
      '#HttpOnly_.site.test\tTRUE\t/app\tFALSE\t0\tcsrf\txyz',
      'garbage line',
    ].join('\n');
    const a = parseCookiesFile(netscape);
    eq(a.length, 2);
    eq(a[0], { url: 'https://site.test/', name: 'session', value: 'abc123', domain: '.site.test', path: '/', secure: true, httpOnly: false, expirationDate: 1893456000 });
    eq(a[1].httpOnly, true);
    eq(a[1].url, 'http://site.test/app');
    const b = parseCookiesFile(JSON.stringify([{ name: 'sid', value: '1', domain: 'site.test', path: '/', secure: true, expirationDate: 5 }, { nope: true }]));
    eq(b.length, 1);
    eq(b[0].url, 'https://site.test/');
    eq(parseCookiesFile('not json ['), []);
  });

  await check('maps URLs to safe local paths', () => {
    const o = 'https://site.test';
    eq(localSegments('https://site.test/assets/a%20b/c.js?x=1#f', o), ['assets', 'a b', 'c.js']);
    eq(localSegments('https://cdn.x.com/lib/d.wasm', o), ['assets', 'remote', 'cdn.x.com', 'lib', 'd.wasm']);
    eq(localSegments('https://site.test/', o), null);
    eq(localSegments('https://site.test/dir/', o), null);
    eq(localSegments('https://site.test/a/../../x.js', o), ['x.js'], 'the URL parser already collapsed it: ');
    eq(localSegments('https://site.test/a/%2e%2e/x.js', o), ['x.js'], 'encoded dot-dot collapsed too: ');
    eq(localSegments('https://site.test/con%3Afig.js', o), ['con_fig.js'], 'reserved characters replaced: ');
    eq(localSegments('blob:https://site.test/abc', o), null);
    eq(localSegments('data:text/plain,hi', o), null);
  });

  await check('files from the host the site redirects to land at their real paths', async () => {
    // Typed igloo.inc, served from www.igloo.inc: the bundle builds every fetch
    // from location.origin, so www files are the site's own, not a third party.
    const dir = scratch('mirror-redirect');
    fs.writeFileSync(path.join(dir, '_.html'), '<!--\n url: https://site.test/ \n--><script type=module src="https://www.site.test/assets/index.js"></script>');
    const calls = [];
    const stats = await mirrorSite(dir, 'https://site.test/', {
      record: async (pageUrl, { sink, onDocument, mobile }) => {
        calls.push({ pageUrl, mobile });
        onDocument('https://www.site.test/');
        sink({ url: 'https://www.site.test/assets/index.js', mime: 'text/javascript', status: 200,
          body: Buffer.from('const o="https://www.site.test";const b="https://site.test/";fetch("https://cdn.other.com/x.js")') });
        sink({ url: 'https://www.site.test/assets/geo/a.drc', mime: 'application/octet-stream', status: 200, body: Buffer.from('DRC') });
        sink({ url: 'https://cdn.other.com/x.js', mime: 'text/javascript', status: 200, body: Buffer.from('x') });
        return { requests: 3, failed: [], documentUrl: 'https://www.site.test/' };
      },
    }, () => {});
    eq(calls, [{ pageUrl: 'https://site.test/', mobile: false }], 'one desktop pass when mobile is off: ');
    eq(stats.origins, ['https://www.site.test']);
    eq(stats.files, 3);
    ok(fs.existsSync(path.join(dir, 'assets', 'geo', 'a.drc')), 'redirected-host file at its real path');
    ok(!fs.existsSync(path.join(dir, 'assets', 'remote', 'www.site.test')), 'nothing filed as third party: ' + JSON.stringify(fs.readdirSync(path.join(dir, 'assets'))));
    ok(fs.existsSync(path.join(dir, 'assets', 'remote', 'cdn.other.com', 'x.js')), 'a real third party still goes under assets/remote');
    const index = fs.readFileSync(path.join(dir, 'assets', 'index.js'), 'utf8');
    ok(index.includes('const o="/"') && index.includes('const b="/"'), 'both spellings of the origin become root-relative: ' + index);
    ok(index.includes('fetch("/assets/remote/cdn.other.com/x.js")'), 'third-party URL rewritten: ' + index);
    const html = fs.readFileSync(path.join(dir, '_.html'), 'utf8');
    ok(html.includes('src="/assets/index.js"'), 'page reference rewritten: ' + html);
  });

  await check('records a phone pass after the desktop pass when the mobile layout was asked for', async () => {
    const dir = scratch('mirror-phone');
    fs.writeFileSync(path.join(dir, '_.html'), '<!--\n url: https://site.test/ \n--><p>x</p>');
    const calls = [];
    const stats = await mirrorSite(dir, 'https://site.test/', {
      mobile: true,
      record: async (pageUrl, { sink, mobile, budget }) => {
        calls.push({ mobile, budget });
        sink({ url: 'https://site.test/shared.js', mime: 'text/javascript', status: 200, body: Buffer.from('s') });
        sink({ url: `https://site.test/${mobile ? 'phone' : 'desktop'}.ktx2`, mime: 'application/octet-stream', status: 200, body: Buffer.from('k') });
        return { requests: 2, failed: [] };
      },
    }, () => {});
    eq(calls.map(c => c.mobile), [false, true], 'desktop first, then phone: ');
    ok(calls[0].budget > calls[1].budget, 'the desktop pass gets the bigger budget');
    eq(stats.pages, 1, 'two passes are still one page: ');
    eq(stats.files, 3, 'the shared file is written once: ');
    ok(fs.existsSync(path.join(dir, 'desktop.ktx2')) && fs.existsSync(path.join(dir, 'phone.ktx2')), 'both device-specific files kept');
  });

  await check('knows the spellings of a site origin', () => {
    eq([...siteOrigins('https://igloo.inc/')].sort(), ['http://igloo.inc', 'http://www.igloo.inc', 'https://igloo.inc', 'https://www.igloo.inc']);
    eq([...siteOrigins('http://www.a.test:8080/x')].sort(), ['http://a.test:8080', 'http://www.a.test:8080', 'https://a.test:8080', 'https://www.a.test:8080']);
    eq([...siteOrigins('blob:https://a.test/x', 'nope')], []);
    eq(localSegments('https://www.site.test/a.js', siteOrigins('https://site.test/')), ['a.js']);
    eq(localSegments('https://cdn.test/a.js', siteOrigins('https://site.test/')), ['assets', 'remote', 'cdn.test', 'a.js']);
  });

  await check('tells an app shell from a server-rendered page', () => {
    ok(builtByScripts('<!doctype html><html><head><title>x</title></head><body></body></html>'), 'empty body');
    ok(builtByScripts('<html><body><div id="root"></div><script src="/app.js"></script><noscript>Enable JS</noscript></body></html>'), 'one mount point');
    ok(builtByScripts('<html><body><div id="app"><div id="webgl"></div></div><svg><path d="M0 0"/></svg></body></html>'), 'shell with an inline svg');
    ok(!builtByScripts('<html><body><header><nav><a href="/">Home</a><a href="/about">About</a></nav></header><main><h1>Welcome to our site</h1><p>We build things for people who need them built.</p></main></body></html>'), 'real content');
    ok(!builtByScripts(''), 'nothing to judge');
  });

  await check('resolves a document’s relative references against its live URL', () => {
    const origins = siteOrigins('https://site.test/');
    const out = absolutizeDocument(
      '<link rel=icon href="favicon.png"><script src="./js/app.js"></script><img src="/keep.png" srcset="a.png 1x, ../b.png 2x"><a href="https://other.test/x">x</a><script src="//cdn.test/lib.js"></script><a href="#top">top</a>',
      'https://www.site.test/blog/post', origins);
    ok(out.includes('href="/blog/favicon.png"'), 'relative → root-relative: ' + out);
    ok(out.includes('src="/blog/js/app.js"'), 'dot-relative → root-relative: ' + out);
    ok(out.includes('src="/keep.png"'), 'root-relative untouched: ' + out);
    ok(out.includes('srcset="/blog/a.png 1x, /b.png 2x"'), 'srcset resolved: ' + out);
    ok(out.includes('href="https://other.test/x"'), 'absolute untouched: ' + out);
    ok(out.includes('src="https://cdn.test/lib.js"'), 'protocol-relative gets a scheme: ' + out);
    ok(out.includes('href="#top"'), 'fragment untouched: ' + out);
    eq(documentReferences('<link href="/a.png"><script src="https://cdn.test/x.js"></script><a href="/dir/">d</a><a href="#f">f</a>', 'https://site.test/'),
      ['https://site.test/a.png', 'https://cdn.test/x.js']);
  });

  await check('serves the original document when the page is built by its scripts', async () => {
    const dir = scratch('mirror-shell');
    // What SingleFile saved: the DOM the app built, class names and all.
    fs.writeFileSync(path.join(dir, '_.html'), '<!--\n url: https://site.test/ \n-->' + '<html class="en mobile android"><body><div id=app><div id=webgl></div></div></body></html>');
    fs.writeFileSync(path.join(dir, '_about.html'), '<!--' + String.fromCharCode(10) + ' url: https://site.test/about ' + String.fromCharCode(10) + '--><html><body><main><h1>About us</h1><p>Server rendered content that stays put and reads fine.</p></main></body></html>');
    const shell = '<!doctype html><html lang="en"><head><link rel="icon" href="https://site.test/favicon.png"><script type="module" crossorigin src="https://site.test/assets/index-1.js"></script></head><body></body></html>';
    const stats = await mirrorSite(dir, 'https://site.test/', {
      entry: '_.html',
      record: async (pageUrl, { sink }) => {
        sink({ url: 'https://site.test/assets/index-1.js', mime: 'text/javascript', status: 200, body: Buffer.from('app') });
        return {
          requests: 1, failed: [], documentUrl: pageUrl,
          documentHtml: pageUrl === 'https://site.test/' ? shell : '<html><body><main><h1>About us</h1><p>Server rendered content that stays put and reads fine.</p></main></body></html>',
        };
      },
    }, () => {});
    eq(stats.documents, 1, 'only the shell page swapped: ');
    const home = fs.readFileSync(path.join(dir, '_.html'), 'utf8');
    ok(home.includes('url: https://site.test/ '), 'header kept: ' + home);
    ok(home.includes('<body></body>'), 'original empty body served: ' + home);
    ok(!home.includes('id=app'), 'rendered DOM gone: ' + home);
    ok(home.includes('src="/assets/index-1.js"'), 'mirrored script points local: ' + home);
    ok(home.includes('href="https://site.test/favicon.png"'), 'un-mirrored reference left for the fallback download: ' + home);
    ok(fs.readFileSync(path.join(dir, '_about.html'), 'utf8').includes('<h1>About us</h1>'), 'server-rendered page keeps its snapshot');
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

  await check('the 24/7 link record keeps when and from what it was pushed', () => {
    const pa = projectsReg.byPath(a);
    projectsReg.update(pa.id, {
      deploy: { provider: 'netlify', siteId: 's1', url: 'https://x.netlify.app', at: '2026-09-03T00:00:00.000Z', version: 'v3' },
    });
    eq(projectsReg.byId(pa.id).deploy.at, '2026-09-03T00:00:00.000Z');
    eq(projectsReg.byId(pa.id).deploy.version, 'v3');
    projectsReg.update(pa.id, { deploy: { provider: 'netlify', siteId: 's1', url: 'https://x.netlify.app' } });
    eq(projectsReg.byId(pa.id).deploy.at, null, 'no push time means none: ');
    projectsReg.update(pa.id, { deploy: null });
    eq(projectsReg.byId(pa.id).deploy, null);
  });

  await check('a fresh library starts with the three default sections', () => {
    eq(projectsReg.sections().map(s => s.name), ['Client Websites', 'Concepts', 'Personal & Business']);
    eq(projectsReg.byPath(a).section, null, 'a new project is unsorted: ');
  });

  await check('files a project into a section and back out', async () => {
    const pa = projectsReg.byPath(a);
    projectsReg.update(pa.id, { section: 'sec_clients' });
    eq(projectsReg.byId(pa.id).section, 'sec_clients');
    projectsReg.update(pa.id, { section: null });
    eq(projectsReg.byId(pa.id).section, null);
    await throws(() => projectsReg.update(pa.id, { section: 'sec_nope' }), 'unknown section');
    eq(projectsReg.byId(pa.id).section, null, 'a refused move changes nothing: ');
  });

  await check('creates, renames and reorders sections; refuses blanks and twins', async () => {
    const archive = projectsReg.addSection('  Old   work ');
    eq(archive.name, 'Old work', 'whitespace tidied: ');
    await throws(() => projectsReg.addSection('   '), 'blank name');
    await throws(() => projectsReg.addSection('concepts'), 'same name, different case');
    await throws(() => projectsReg.addSection('x'.repeat(41)), 'too long');
    eq(projectsReg.renameSection(archive.id, 'Archive').name, 'Archive');
    await throws(() => projectsReg.renameSection(archive.id, 'Concepts'), 'rename onto another name');
    eq(projectsReg.renameSection(archive.id, 'ARCHIVE').name, 'ARCHIVE', 'recasing its own name is fine: ');
    projectsReg.moveSection(archive.id, -1);
    eq(projectsReg.sections().map(s => s.id).indexOf(archive.id), 2, 'moved one earlier: ');
    projectsReg.moveSection('sec_clients', -1);
    eq(projectsReg.sections()[0].id, 'sec_clients', 'the first stays first: ');
  });

  await check('deleting a section unsorts its projects, and sections survive a reload', () => {
    const pa = projectsReg.byPath(a);
    const archive = projectsReg.sections().find(s => s.name === 'ARCHIVE');
    projectsReg.update(pa.id, { section: archive.id });
    projectsReg.update(projectsReg.byPath(c).id, { section: 'sec_concepts' });
    eq(projectsReg.removeSection(archive.id), 1, 'one project was in it: ');
    eq(projectsReg.byId(pa.id).section, null);
    ok(!projectsReg.sections().some(s => s.id === archive.id), 'section gone');
    delete require.cache[require.resolve('../lib/projects')];
    const fresh = require('../lib/projects');
    eq(fresh.sections().map(s => s.id), ['sec_clients', 'sec_concepts', 'sec_personal']);
    eq(fresh.byPath(c).section, 'sec_concepts', 'filing kept across a restart: ');
    projectsReg.update(projectsReg.byPath(c).id, { section: null });
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

  await check('a bare rating saves; only an entirely empty annotation is rejected', async () => {
    const bare = reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: {}, input: { rating: 5 },
    });
    eq(bare.input.rating, 5, 'bare rating saved: ');
    const short = reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: {}, input: { rating: 5, why: 'too gray' },
    });
    eq(short.input.why, 'too gray', 'short reason saved: ');
    await throws(() => reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: {}, input: {},
    }), 'entirely empty');
  });

  await check('an audit file from a 24/7 link imports note for note, and remembers where each came from', async () => {
    // The shape the standalone overlay downloads: the full captured context
    // (a live guest POSTs the same) plus the browser-minted id the owner's
    // import de-duplicates on.
    const note = {
      id: 'g_1a069959087b5551b', reviewId: 'rev_x', scope: 'element', createdAt: '2026-09-03T23:22:55.422Z',
      resolved: false, author: 'gav', auto: false, local: true,
      context: {
        viewport: { width: 1118, height: 525, label: 'desktop' }, pageUrl: '/_en.html', selector: '#hero',
        selectorFallback: 'body > h1:nth-child(1)', outerHTML: '<h1 id="hero">Zentrix Media</h1>',
        boundingBox: { x: 40, y: 40, w: 300, h: 46 }, computedStyles: { fontSize: '40px' }, sourceFile: '_en.html',
      },
      input: { rating: 3, severity: 'nitpick', axes: [], why: 'Hero type is oversized at this width', want: '' },
    };
    const imported = reviewsStore.addAnnotation(PRJ, {
      scope: note.scope, context: note.context, input: note.input, author: note.author, importedFrom: note.id,
    });
    eq(imported.importedFrom, note.id);
    eq(imported.author, 'gav');
    eq(imported.input.why, 'Hero type is oversized at this width');
    eq(imported.context.selector, '#hero');
    ok(/^ann_/.test(imported.id), 'gets a store id of its own: ' + imported.id);
    // An empty note the overlay refuses to save would be refused here too.
    await throws(() => reviewsStore.addAnnotation(PRJ, {
      scope: 'element', context: note.context, input: { rating: null, severity: 'nitpick', axes: [], why: '', want: '' },
      author: 'gav', importedFrom: 'g_empty',
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

  await check('a guest cannot smuggle an SSRF url or a traversal path through context', () => {
    // pageUrl is later appended to http://127.0.0.1:<port> and loaded; sourceFile
    // is path.joined to the project folder and read. Both are guest-controlled
    // over a share link, so both must be forced back into bounds at save time.
    const ann = reviewsStore.addAnnotation(PRJ, {
      scope: 'element',
      context: {
        selector: 'h1',
        pageUrl: '@169.254.169.254/latest/meta-data/',
        sourceFile: '../../../../Users/Gu/.ssh/id_rsa',
      },
      input: { rating: 4, severity: 'nitpick', axes: ['typography'], why: 'Testing the sanitizer bounds hold.', want: 'x' },
    });
    eq(ann.context.pageUrl, '/', 'authority-hijacking pageUrl neutralised: ' + ann.context.pageUrl);
    eq(ann.context.sourceFile, '', 'climbing sourceFile rejected: ' + ann.context.sourceFile);
    // Protocol-relative and backslash tricks fall back to root too; a real
    // in-site path survives untouched.
    const b = reviewsStore.addAnnotation(PRJ, {
      scope: 'element',
      context: { selector: 'h2', pageUrl: '//evil.com/x', sourceFile: 'about/index.html' },
      input: { rating: 4, severity: 'nitpick', axes: ['typography'], why: 'Second sanitizer case, still fine.', want: 'x' },
    });
    eq(b.context.pageUrl, '/', 'protocol-relative pageUrl neutralised: ' + b.context.pageUrl);
    eq(b.context.sourceFile, 'about/index.html', 'legitimate relative path preserved: ' + b.context.sourceFile);
  });

  await check('update validates too — and stripping the reason is allowed now', async () => {
    const first = reviewsStore.listAnnotations(PRJ).find(a => a.input.rating === 3);
    const stripped = reviewsStore.updateAnnotation(PRJ, first.id, { input: { why: '' } });
    eq(stripped.input.why, '', 'reason removed without a fight: ');
    reviewsStore.updateAnnotation(PRJ, first.id, { input: { why: 'Reads like body copy, no weight at all.' } });
    const patched = reviewsStore.updateAnnotation(PRJ, first.id, { input: { want: 'Near-black, 72px.' } });
    eq(patched.input.want, 'Near-black, 72px.');
    eq(patched.input.rating, 3, 'rating survived the patch: ');
  });

  await check('resolve keeps the old rating and records the new one', () => {
    const first = reviewsStore.listAnnotations(PRJ).find(a => a.input.rating === 3);
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
  const resolvedHook = [];
  const manager = new ReviewManager({
    projects: projectsReg,
    capturesRoot: () => scratch('rev-api-caps'),
    exportReview,
    overlayPath: path.join(ROOT, 'renderer', 'review-overlay.js'),
    onAnchor: (proj, annotation) => anchored.push(annotation.id),
    onResolved: (proj, annotation) => resolvedHook.push(annotation.id),
    onAudit: async () => ({ pages: 1, axeViolations: 0, brokenLinks: 0, added: 0, skipped: 0 }),
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

    await check('an empty annotation surfaces as a 400, not a save', async () => {
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'element', context: { selector: 'h1.hero' }, input: {},
      });
      eq(res.status, 400);
      ok(/empty/i.test(res.json.error), 'error mentions emptiness: ' + res.json.error);
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
      eq(resolvedHook, [target.id], 'onResolved (the verification hook) fired: ');
    });

    await check('before/after shots serve through the image kinds route', async () => {
      const state = await request('GET', '/__siteslurp__/review/state');
      const target = state.json.annotations[0];
      const shotsDir = path.join(TMP, 'userData', 'reviews', project.id, 'shots');
      const px = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      fs.writeFileSync(path.join(shotsDir, `${target.id}_after_el.png`), px);
      reviewsStore.updateAnnotation(project.id, target.id, {
        context: { screenshotAfterElement: `shots/${target.id}_after_el.png` },
        diffScore: 3, // clamped to 1 on the way in
      });
      const img = await request('GET', `/__siteslurp__/review/image/${target.id}/after_el`);
      eq(img.status, 200, 'after shot serves: ');
      const bogus = await request('GET', `/__siteslurp__/review/image/${target.id}/passwd`);
      eq(bogus.status, 404, 'unknown kinds refused: ');
      const fresh = await request('GET', '/__siteslurp__/review/state');
      eq(fresh.json.annotations[0].diffScore, 1, 'diffScore clamped and visible to the overlay: ');
    });

    await check('the audit route lands on the main-process hook', async () => {
      const res = await request('POST', '/__siteslurp__/review/audit');
      eq(res.status, 200);
      eq(res.json.pages, 1, 'the hook\'s summary comes back: ');
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

/* ---------------- grab mode ---------------- */
async function grabTests() {
  console.log('\ngrab mode');

  const site = scratch('grab-site');
  fs.writeFileSync(path.join(site, 'index.html'),
    '<html><body><section class="hero"><img src="assets/images/pic.webp"></section></body></html>');
  fs.mkdirSync(path.join(site, 'assets', 'images'), { recursive: true });
  fs.writeFileSync(path.join(site, 'assets', 'images', 'pic.webp'), 'not-really-webp');
  const caps = scratch('grab-caps');

  const manager = new GrabManager({
    capturesRoot: () => caps,
    clientPath: path.join(ROOT, 'renderer', 'grab-client.js'),
  });
  const hostMgr = new HostManager();
  hostMgr.grabFor = (dir, opts) => manager.forDir(dir, opts);
  const port = await hostMgr.start(site, 4790);

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
    await check('maps served paths back to files on disk', () => {
      eq(localPathFor(site, '/assets/images/pic.webp'), path.join(site, 'assets', 'images', 'pic.webp'));
      eq(localPathFor(site, '/a%20b/c.png'), path.join(site, 'a b', 'c.png'));
      // Same resolution as the static handler: traversal clamps at the site
      // root instead of escaping — the path names what the server would serve.
      eq(localPathFor(site, '/../../evil.txt'), path.join(site, 'evil.txt'), 'traversal clamps: ');
      eq(localPathFor(site, '/%2e%2e/%2e%2e/evil.txt'), path.join(site, 'evil.txt'), 'encoded traversal clamps: ');
      eq(localPathFor(site, '/%zz-bad-encoding'), null, 'undecodable -> null');
    });

    await check('injects the grab client and serves it with this site\'s config', async () => {
      const page = await request('GET', '/');
      ok(page.text.includes('/__siteslurp__/grab/client.js'), 'tag injected');
      const script = await request('GET', '/__siteslurp__/grab/client.js');
      eq(script.status, 200);
      ok(script.text.startsWith('self.__SLURP_GRAB__ = {'), 'config preamble');
      const cfg = JSON.parse(/^self\.__SLURP_GRAB__ = (.*);\n/.exec(script.text)[1]);
      eq(cfg.root, site);
      eq(cfg.mapped, true);
      eq(cfg.grabs, path.join(caps, '_grabs', 'grab-site'));
      ok(script.text.includes('__slurpGrab'), 'client body');
    });

    await check('a canvas or empty element gets a "drawn by script" note pointing at the scripts', async () => {
      fs.writeFileSync(path.join(site, 'index.html'),
        '<html><head><script type="module" src="/assets/index-1.js"></script></head><body><div id="webgl"><canvas></canvas></div><section class="hero"><img src="assets/images/pic.webp"></section></body></html>');
      fs.writeFileSync(path.join(site, 'assets', 'index-1.js'), 'draw()');
      const res = await request('POST', '/__siteslurp__/grab/save', {
        slug: 'div-webgl-test2',
        pageUrl: `http://127.0.0.1:${port}/`,
        selector: '#webgl',
        tag: 'div#webgl',
        rect: { x: 0, y: 0, w: 1280, h: 800 },
        html: '<div id="webgl"><canvas width="1280" height="800"></canvas></div>',
        css: 'div#webgl { position: absolute; }',
        assets: [],
      });
      eq(res.status, 200);
      const md = fs.readFileSync(path.join(res.json.folder, 'GRAB.md'), 'utf8');
      ok(md.includes('## Drawn by script'), 'note present: ' + md);
      ok(md.includes('painted by the page'), 'canvas wording: ' + md);
      ok(md.includes('- script: ' + path.join(site, 'assets', 'index-1.js')), 'script resolved to its local file: ' + md);

      const plain = await request('POST', '/__siteslurp__/grab/save', {
        slug: 'section-hero-test3',
        pageUrl: `http://127.0.0.1:${port}/`,
        selector: 'section.hero', tag: 'section.hero', rect: { x: 0, y: 0, w: 10, h: 10 },
        html: '<section class="hero"><h1>Hello there</h1></section>', css: '', assets: [],
      });
      ok(!fs.readFileSync(path.join(plain.json.folder, 'GRAB.md'), 'utf8').includes('Drawn by script'), 'ordinary markup gets no note');
    });

    await check('save writes a bundle: manifest, html, css, derived asset paths', async () => {
      const res = await request('POST', '/__siteslurp__/grab/save', {
        slug: 'section-hero-test1',
        pageUrl: `http://127.0.0.1:${port}/`,
        selector: 'body > section.hero',
        tag: 'section.hero',
        rect: { x: 0, y: 80, w: 1280, h: 640 },
        html: '<section class="hero"><img src="assets/images/pic.webp"></section>',
        css: '.hero { color: red; }',
        assets: [
          `http://127.0.0.1:${port}/assets/images/pic.webp`,
          'https://cdn.example.com/far-away.png',
        ],
      });
      eq(res.status, 200);
      const folder = path.join(caps, '_grabs', 'grab-site', 'section-hero-test1');
      eq(res.json.folder, folder);
      ok(fs.readFileSync(path.join(folder, 'element.html'), 'utf8').includes('pic.webp'), 'element.html');
      ok(fs.readFileSync(path.join(folder, 'styles.css'), 'utf8').includes('.hero'), 'styles.css');
      const md = fs.readFileSync(path.join(folder, 'GRAB.md'), 'utf8');
      ok(md.includes(`Site folder: ${site}`), 'site folder in manifest');
      ok(md.includes(`Page file: ${path.join(site, 'index.html')}`), 'page resolved to its file');
      ok(md.includes(path.join(site, 'assets', 'images', 'pic.webp')), 'local twin of the asset');
      ok(md.includes('far-away.png (remote — no local copy)'), 'remote asset marked');
    });

    await check('refuses hostile bundle names', async () => {
      for (const slug of ['../evil', 'a/b', 'a\\b', '', '-lead', 'x'.repeat(90)]) {
        const res = await request('POST', '/__siteslurp__/grab/save', { slug, html: 'x' });
        eq(res.status, 400, `slug ${JSON.stringify(slug)} refused`);
      }
      ok(!fs.existsSync(path.join(caps, '_grabs', 'evil')), 'nothing written outside the site\'s grabs folder');
    });

    await check('refuses cross-origin saves', async () => {
      const res = await request('POST', '/__siteslurp__/grab/save',
        { slug: 'from-elsewhere1', html: 'x' }, { Origin: 'http://evil.example' });
      eq(res.status, 403);
    });

    await check('stays local-only: tunnel traffic gets no injection and no API', async () => {
      const page = await request('GET', '/', null, { 'cf-ray': 'abc123' });
      ok(!page.text.includes('grab/client.js'), 'no tag through the tunnel');
      const api = await request('GET', '/__siteslurp__/grab/client.js', null, { 'cf-ray': 'abc123' });
      eq(api.status, 404);
    });
  } finally {
    hostMgr.stopAll();
  }
}

/* ---------------- in-page menu ---------------- */
async function menuTests() {
  console.log('\nin-page menu');

  const site = scratch('menu-site');
  fs.writeFileSync(path.join(site, 'index.html'), '<html><body><h1>hi</h1></body></html>');

  // Stub deps standing in for main.js: one flag plays the review manager.
  let auditOn = false;
  const manager = new MenuManager({
    clientPath: path.join(ROOT, 'renderer', 'slurp-menu.js'),
    logoPath: path.join(ROOT, 'renderer', 'nightshyft-mark.png'),
    siteFor: dir => ({
      name: 'menu-site', auditAvailable: dir === site, auditActive: auditOn,
      reason: dir === site ? null : 'not a project',
    }),
    auditStart: dir => {
      if (dir !== site) throw new Error('This folder is not a library project — audit mode needs one.');
      auditOn = true;
    },
    auditStop: () => { const was = auditOn; auditOn = false; return was; },
  });
  const hostMgr = new HostManager();
  hostMgr.menuFor = dir => manager.forDir(dir);
  const port = await hostMgr.start(site, 4785);

  const request = (method, urlPath, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* html or binary */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString(), buf });
      });
    });
    req.on('error', reject);
    req.end();
  });

  try {
    await check('injects the menu client into hosted pages', async () => {
      const page = await request('GET', '/');
      ok(page.text.includes('/__siteslurp__/menu/client.js'), 'menu tag injected');
    });

    await check('serves the client with this site\'s config', async () => {
      const script = await request('GET', '/__siteslurp__/menu/client.js');
      eq(script.status, 200);
      ok(script.text.startsWith('self.__SLURP_MENU__ = {'), 'config preamble');
      const cfg = JSON.parse(/^self\.__SLURP_MENU__ = (.*);\n/.exec(script.text)[1]);
      eq(cfg.name, 'menu-site');
      eq(cfg.audit.available, true);
      eq(cfg.audit.active, false);
      ok(script.text.includes('__slurpMenu'), 'client body');
    });

    await check('serves the logo as a real png', async () => {
      const res = await request('GET', '/__siteslurp__/menu/logo.png');
      eq(res.status, 200);
      eq(res.headers['content-type'], 'image/png');
      eq([...res.buf.subarray(0, 4)], [0x89, 0x50, 0x4E, 0x47], 'PNG magic: ');
    });

    await check('audit toggles on and off through the menu API', async () => {
      eq((await request('POST', '/__siteslurp__/menu/audit/start')).status, 200);
      eq(auditOn, true, 'audit enabled: ');
      const state = await request('GET', '/__siteslurp__/menu/state');
      eq(state.json.audit.active, true);
      const stop = await request('POST', '/__siteslurp__/menu/audit/stop');
      eq(stop.json.stopped, true);
      eq(auditOn, false, 'audit disabled: ');
    });

    await check('a start that the app refuses comes back as a sentence', async () => {
      const other = scratch('menu-other');
      fs.writeFileSync(path.join(other, 'index.html'), '<p>x</p>');
      const otherMgr = new HostManager();
      otherMgr.menuFor = dir => manager.forDir(dir);
      const otherPort = await otherMgr.start(other, 4795);
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: otherPort, path: '/__siteslurp__/menu/audit/start', method: 'POST' }, r => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
          });
          req.on('error', reject);
          req.end();
        });
        eq(res.status, 400);
        ok(/library project/.test(res.json.error), 'reason given: ' + res.json.error);
      } finally {
        otherMgr.stopAll();
      }
    });

    await check('refuses cross-origin calls', async () => {
      const res = await request('POST', '/__siteslurp__/menu/audit/start', { Origin: 'http://evil.example' });
      eq(res.status, 403);
      eq(auditOn, false, 'nothing flipped: ');
    });

    await check('stays local-only: tunnel traffic gets no menu', async () => {
      const page = await request('GET', '/', { 'cf-ray': 'abc123' });
      ok(!page.text.includes('menu/client.js'), 'no tag through the tunnel');
      const api = await request('GET', '/__siteslurp__/menu/client.js', { 'cf-ray': 'abc123' });
      eq(api.status, 404);
    });
  } finally {
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

  await check('keeps library section view state tidy', () => {
    const saved = settings.save({ libSection: '', collapsedSections: ['sec_clients', 3, null, '_captures'] });
    eq(saved.libSection, 'all');
    eq(saved.collapsedSections, ['sec_clients', '_captures']);
    eq(settings.save({ collapsedSections: 'nope' }).collapsedSections, []);
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

  // People drop the folder above the app all the time — the client folder,
  // not the Next.js project inside it. One level down still counts.
  await check('the folder above the app finds the app — one level down, as root', () => {
    const parent = scratch('rt-parent');
    write(parent, path.join('MyApp', 'package.json'), JSON.stringify({
      dependencies: { next: '16.2.6' }, scripts: { dev: 'next dev' },
    }));
    const found = runtimes.detect(parent);
    eq(found.id, 'next');
    eq(found.root, 'MyApp');
    ok(found.label.includes('MyApp'), 'label says where: ' + found.label);
    const kept = runtimes.normalize(found);
    eq(kept.root, 'MyApp', 'root survives normalize for command runtimes');
    ok(runtimes.needsInstall(parent, kept), 'no node_modules yet');
    fs.mkdirSync(path.join(parent, 'MyApp', 'node_modules'), { recursive: true });
    ok(!runtimes.needsInstall(parent, kept), 'install satisfied in the subfolder');
    // But a folder that is served fine by itself never reaches into subfolders.
    const own = write(scratch('rt-own-first'), 'index.html', '<h1>hi</h1>');
    write(own, path.join('app', 'package.json'), JSON.stringify({
      dependencies: { vite: '5' }, scripts: { dev: 'vite' },
    }));
    eq(runtimes.detect(own).kind, 'static');
  });

  await check('nothing recognisable means no runtime, not a wrong guess', () => {
    eq(runtimes.detect(scratch('rt-nothing')), null);
  });

  // The whole point: a project that only exists once a process runs still gets
  // hosted on its own stable Local Dev Studio port, with the process supervised.
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

  // Restart used to no-op: stop() left this.child set, so the immediate start()
  // bailed on its own guard and the site came back "failed". It must actually
  // respawn and serve again.
  await check('restart brings the dev server back, it does not leave it dead', async () => {
    const dir = scratch('rt-restart');
    write(dir, 'server.js', `
      const http = require('http');
      http.createServer((req, res) => { res.writeHead(200); res.end('pid ' + process.pid); })
        .listen(Number(process.argv[2]), '127.0.0.1');
    `);
    const hostMgr = new HostManager();
    const port = await hostMgr.start(dir, 4392, {
      runtime: { kind: 'command', id: 'custom', label: 'test', command: 'node server.js {port}' }, name: 'test',
    });
    const get = () => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { accept: 'text/html' } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end();
    });
    const waitReady = async () => {
      for (let i = 0; i < 100 && hostMgr.runtimeState(dir).status !== 'ready'; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      return hostMgr.runtimeState(dir).status;
    };
    try {
      eq(await waitReady(), 'ready', 'came up first time');
      const before = (await get()).body;
      const restarted = await hostMgr.restart(dir);
      ok(restarted, 'restart reported success');
      eq(await waitReady(), 'ready', 'came back after restart');
      const after = (await get()).body;
      ok(/^pid \d+$/.test(after), 'serving again after restart: ' + after);
      ok(before !== after, 'a genuinely new process answered: ' + before + ' -> ' + after);
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

  // Next 16 binds its port and prints "Ready" before noticing another `next
  // dev` already owns the folder — then exits. Trusting the first port answer
  // marked that corpse ready and every proxied request died with ECONNRESET.
  await check('a server that binds its port and then exits is failed, not ready', async () => {
    const dir = scratch('rt-dup');
    write(dir, 'server.js', `
      const http = require('http');
      http.createServer(() => {}).listen(Number(process.argv[2]), '127.0.0.1', () => {
        console.log('Ready in 100ms');
        console.log('Another next dev server is already running.');
        console.log('- PID:          31337');
        setTimeout(() => process.exit(1), 150);
      });
    `);
    const port = await freePort();
    const runner = new Runner({ command: `node server.js ${port}`, cwd: dir, port });
    runner.start();
    try {
      // Wait for the child to be fully gone — the PID line can land a chunk
      // after the announcement, and the exit pass folds it into the message.
      for (let attempt = 0; attempt < 100 && (runner.status === 'starting' || runner.child); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      eq(runner.status, 'failed', 'bound-then-died is a failure: ');
      ok(runner.message.includes('already running'), 'names the duplicate: ' + runner.message);
      ok(runner.message.includes('31337'), 'carries the PID: ' + runner.message);
      ok(runner.message.includes('just connect'), 'offers attach mode: ' + runner.message);
    } finally {
      runner.stop();
    }
  });

  // The request that discovers the crash must show the child's exit story,
  // not a bare ECONNRESET — and the failed page keeps refreshing so fixing
  // the cause and restarting heals the tab on its own.
  await check('a reset mid-flight reports the real exit, and the page self-heals', async () => {
    const deadPort = await freePort(); // nothing listening there
    const states = [
      { status: 'ready', port: deadPort },
      { status: 'failed', port: deadPort, message: 'The server exited (code 1)', log: 'Run taskkill /PID 31337 /F to stop it.' },
    ];
    let calls = 0;
    const { handler } = makeProxyHandler(() => states[Math.min(calls++, 1)], { name: 'dup' });
    const front = http.createServer(handler);
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const port = front.address().port;
    try {
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', headers: { accept: 'text/html' } }, r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
      });
      eq(res.status, 503);
      ok(res.body.includes('The server exited (code 1)'), 'shows the exit message: ' + res.body.slice(0, 400));
      ok(res.body.includes('taskkill'), 'shows the log tail');
      ok(!res.body.includes('Lost connection'), 'no bare ECONNRESET when the truth is known');
      ok(res.body.includes('http-equiv="refresh"'), 'failed page still refreshes itself');
    } finally {
      front.close();
      front.closeAllConnections?.();
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

/* ---------------- verification loop & audit annotations ---------------- */
async function verifyLoopTests() {
  console.log('\nverification loop');

  await check('resolve metadata survives the store: note, score clamp, stale flag', () => {
    const id = 'prj_verify_store';
    const a = reviewsStore.addAnnotation(id, {
      scope: 'element',
      context: { selector: '.hero', pageUrl: '/' },
      input: { severity: 'should-fix', why: 'Too small to read comfortably.' },
    });
    reviewsStore.updateAnnotation(id, a.id, {
      resolved: true, resolvedNote: 'Bumped to 18px', diffScore: -2, stale: true,
    });
    const stored = reviewsStore.getAnnotation(id, a.id);
    eq(stored.resolvedNote, 'Bumped to 18px');
    eq(stored.diffScore, 0, 'negative scores clamp to 0: ');
    eq(stored.stale, true);
    reviewsStore.updateAnnotation(id, a.id, { diffScore: 0.42, stale: false });
    eq(reviewsStore.getAnnotation(id, a.id).diffScore, 0.42);
    eq(reviewsStore.getAnnotation(id, a.id).stale, false);
  });

  await check('audit annotations carry the auto flag; user ones never do', () => {
    const id = 'prj_verify_auto';
    const auto = reviewsStore.addAnnotation(id, {
      scope: 'element',
      context: { selector: 'img.logo', pageUrl: '/' },
      input: { severity: 'blocking', why: 'Image has no alternative text at all.' },
      auto: true,
    });
    const mine = reviewsStore.addAnnotation(id, {
      scope: 'element',
      context: { selector: '.hero', pageUrl: '/' },
      input: { severity: 'nitpick', why: 'Feels slightly cramped up top.' },
    });
    eq(reviewsStore.getAnnotation(id, auto.id).auto, true);
    eq(reviewsStore.getAnnotation(id, mine.id).auto, undefined);
  });

  await check('REVIEW.md badges [auto], pairs before/after, and lists resolves', () => {
    const project = { id: 'p', name: 'Verify', kind: 'local', path: '/x' };
    const review = { id: 'rev_20260807_01', startedAt: new Date().toISOString(), exportedAt: null };
    const open = {
      id: 'ann_a', reviewId: review.id, scope: 'element', resolved: false, auto: true,
      context: { selector: 'img.logo', pageUrl: '/', computedStyles: {}, consoleTail: [] },
      input: { rating: null, severity: 'blocking', axes: [], why: 'Image has no alt text.', want: '' },
    };
    const fixed = {
      id: 'ann_b', reviewId: review.id, scope: 'element', resolved: true,
      resolvedRating: 8, resolvedNote: 'Rebuilt the header grid', diffScore: 0.37,
      context: {
        selector: '.hero', pageUrl: '/', computedStyles: {}, consoleTail: [],
        screenshotElement: 'shots/ann_b_el.png', screenshotAfterElement: 'shots/ann_b_after_el.png',
      },
      input: { rating: 3, severity: 'should-fix', axes: [], why: 'Cramped.', want: 'Air.' },
    };
    const unmoved = { ...fixed, id: 'ann_c', diffScore: 0, resolvedNote: '', context: { ...fixed.context } };
    const md = renderReviewMd(project, review, [open, fixed, unmoved], () => null);
    ok(md.includes('[BLOCKING] [auto] img.logo'), 'auto badge in the heading: ' + md.split('\n').find(l => l.includes('BLOCKING')));
    ok(md.includes('## Resolved this review'), 'resolved section exists');
    ok(md.includes('before shots/ann_b_el.png → after shots/ann_b_after_el.png'), 'before/after pair listed');
    ok(md.includes('37% of pixels changed'), 'diff score rendered');
    ok(md.includes('verified: nothing changed visually'), 'the zero-diff resolve is called out');
    ok(md.includes("fixer's note: Rebuilt the header grid"), 'resolve note rendered');

    const block = renderAnnotation(fixed, () => null);
    ok(block.includes('**After (on resolve):** shots/ann_b_after_el.png'), 'after line in the annotation block');
  });
}

/* ---------------- control api & mcp ---------------- */
async function agentTests() {
  console.log('\ncontrol api & mcp');

  // A real project with a real annotation — the control API is a thin wrapper
  // over the same modules the app uses, so the test drives those.
  const site = scratch('agent-site');
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>Agent me</h1>');
  const project = projectsReg.addLocal(site);
  const annotation = reviewsStore.addAnnotation(project.id, {
    scope: 'element',
    context: { selector: 'h1', pageUrl: '/' },
    input: { rating: 4, severity: 'should-fix', why: 'Headline carries no weight.', want: 'Bolder.' },
  });

  const hosted = [];
  const verified = [];
  const controlFile = path.join(TMP, 'userData', 'control.json');
  const control = new ControlServer({
    file: controlFile,
    version: '0.0.0-test',
    log: { info: () => {}, warn: () => {} },
    projects: projectsReg,
    reviews: reviewsStore,
    calibration: calibrationStore,
    versions,
    hostedPort: () => null,
    hostProject: async p => { hosted.push(p.id); return { port: 4999, url: 'http://localhost:4999/' }; },
    stopProject: p => { hosted.push('stop:' + p.id); return true; },
    exportProject: p => exportReview({ project: p, capturesRoot: scratch('agent-caps') }),
    resolveAnnotation: async (p, a, { note, afterRating } = {}) => {
      verified.push(a.id);
      return reviewsStore.updateAnnotation(p.id, a.id, {
        resolved: true,
        ...(afterRating ? { resolvedRating: afterRating } : {}),
        ...(note ? { resolvedNote: note } : {}),
      });
    },
    reviewMarkdown: p => {
      const all = reviewsStore.listReviews(p.id);
      const review = all.find(r => !r.exportedAt) || all[all.length - 1];
      return renderReviewMd(p, review, reviewsStore.listAnnotations(p.id, { reviewId: review.id }), () => null);
    },
  });
  await control.start();
  const { port, token } = JSON.parse(fs.readFileSync(controlFile, 'utf8'));

  const call = (method, urlPath, body, useToken = true) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        ...(useToken ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  try {
    await check('control.json holds a live port and a token the server enforces', async () => {
      ok(Number.isInteger(port) && port > 0, 'random port recorded');
      ok(/^[0-9a-f]{48}$/.test(token), 'token shape');
      eq((await call('GET', '/v1/projects', null, false)).status, 401, 'no token, no answer: ');
      eq((await call('GET', '/v1/ping')).status, 200);
    });

    await check('projects list includes the registered project with open counts', async () => {
      const res = await call('GET', '/v1/projects');
      const mine = res.json.projects.find(p => p.id === project.id);
      ok(mine, 'project listed');
      eq(mine.hosted, false);
      eq(mine.openAnnotations, 1);
    });

    await check('annotations filter by status and resolve by name or id', async () => {
      const open = await call('GET', `/v1/annotations?project=${project.id}&status=open`);
      eq(open.json.annotations.length, 1);
      const byName = await call('GET', `/v1/annotations?project=${encodeURIComponent(project.name)}&status=resolved`);
      eq(byName.json.annotations.length, 0);
      const one = await call('GET', `/v1/annotations/${annotation.id}`);
      eq(one.json.annotation.id, annotation.id);
      eq(one.json.project.id, project.id, 'owner found across stores: ');
      eq((await call('GET', '/v1/annotations?project=no-such-thing')).status, 400, 'unknown project is a sentence: ');
    });

    await check('resolve goes through the injected hook exactly once', async () => {
      const res = await call('POST', `/v1/annotations/${annotation.id}/resolve`, {
        note: 'Made it 700 weight', afterRating: 8,
      });
      eq(res.status, 200);
      eq(res.json.annotation.resolved, true);
      eq(res.json.annotation.resolvedRating, 8);
      eq(res.json.annotation.resolvedNote, 'Made it 700 weight');
      eq(verified, [annotation.id], 'verification hook fired: ');
      eq((await call('POST', `/v1/annotations/${annotation.id}/resolve`, {})).status, 400, 'double resolve refused: ');
    });

    await check('calibration reads and appends through the same store', async () => {
      const before = await call('GET', '/v1/calibration');
      ok(typeof before.json.markdown === 'string', 'markdown rendered');
      const added = await call('POST', '/v1/calibration', { text: 'Never use pure black backgrounds.' });
      eq(added.json.added, true);
      const after = await call('GET', '/v1/calibration');
      ok(after.json.markdown.includes('Never use pure black backgrounds.'), 'preference landed');
    });

    await check('snapshots create and list against the real engine', async () => {
      const made = await call('POST', '/v1/snapshots', { project: project.id, label: 'from mcp' });
      eq(made.status, 200);
      ok(made.json.id, 'snapshot id');
      const list = await call('GET', `/v1/snapshots?project=${project.id}`);
      eq(list.json.snapshots[0].label, 'from mcp');
    });

    await check('host/stop and export round-trip; review markdown renders live', async () => {
      const h = await call('POST', '/v1/host', { project: project.id });
      eq(h.json.port, 4999);
      await call('POST', '/v1/stop', { project: project.id });
      eq(hosted, [project.id, 'stop:' + project.id], 'thin closures called: ');
      const exp = await call('POST', '/v1/export', { project: project.id });
      ok(fs.existsSync(path.join(exp.json.folder, 'REVIEW.md')), 'export wrote the folder');
      const md = await call('GET', `/v1/review?project=${project.id}`);
      ok(md.json.markdown.includes('## Resolved this review'), 'live REVIEW.md shows the resolve');
    });

    /* ---- the MCP stdio server against this control API ---- */
    const mcpDir = scratch('agent-mcp-userdata');
    fs.copyFileSync(controlFile, path.join(mcpDir, 'control.json'));

    const session = env => {
      const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], {
        env: { ...process.env, SLURP_VERSION: '9.9.9-test', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      const waiting = [];
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          const next = waiting.shift();
          if (next) { clearTimeout(next.timer); next.resolve(JSON.parse(line)); }
        }
      });
      let seq = 0;
      return {
        call: (method, params) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('mcp timed out on ' + method)), 8000);
          waiting.push({ resolve, timer });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) + '\n');
        }),
        notify: method => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
        kill: () => child.kill(),
      };
    };

    await check('mcp handshake, tools and a live round-trip through the control api', async () => {
      const mcp = session({ SLURP_USERDATA: mcpDir });
      try {
        const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
        eq(init.result.serverInfo.name, 'local-dev-studio');
        eq(init.result.serverInfo.version, '9.9.9-test');
        mcp.notify('notifications/initialized');
        const tools = await mcp.call('tools/list', {});
        eq(tools.result.tools.map(t => t.name), [
          'list_projects', 'list_annotations', 'get_annotation', 'resolve_annotation',
          'get_calibration', 'create_snapshot', 'export_review',
        ], 'the seven tools: ');
        const listed = await mcp.call('tools/call', { name: 'list_projects', arguments: {} });
        ok(!listed.result.isError, 'call succeeded');
        ok(listed.result.content[0].text.includes(project.name), 'project name in the payload');
        const resources = await mcp.call('resources/list', {});
        ok(resources.result.resources.some(r => r.uri === 'localdevstudio://calibration.md'), 'calibration resource');
        ok(resources.result.resources.some(r => r.uri.endsWith(`${project.id}/REVIEW.md`)), 'per-project review resource');
        const review = await mcp.call('resources/read', { uri: `localdevstudio://projects/${project.id}/REVIEW.md` });
        ok(review.result.contents[0].text.includes('Resolved this review'), 'resource text is the live REVIEW.md');
        const unknown = await mcp.call('no/such/method', {});
        eq(unknown.error.code, -32601, 'unknown methods answer -32601: ');
      } finally {
        mcp.kill();
      }
    });

    await check('a dead or missing control.json is one clear sentence', async () => {
      const emptyDir = scratch('agent-mcp-empty');
      const missing = session({ SLURP_USERDATA: emptyDir });
      try {
        const res = await missing.call('tools/call', { name: 'list_projects', arguments: {} });
        eq(res.result.isError, true);
        ok(res.result.content[0].text.includes('isn\'t running'), 'the sentence: ' + res.result.content[0].text);
      } finally {
        missing.kill();
      }
      // Stale file: the port answers nothing because the app is gone.
      const staleDir = scratch('agent-mcp-stale');
      fs.writeFileSync(path.join(staleDir, 'control.json'),
        JSON.stringify({ port: 1, token: 'dead' }));
      const stale = session({ SLURP_USERDATA: staleDir });
      try {
        const res = await stale.call('tools/call', { name: 'list_projects', arguments: {} });
        eq(res.result.isError, true);
        ok(res.result.content[0].text.includes('isn\'t running'), 'stale reads as not running');
      } finally {
        stale.kill();
      }
    });

    await check('closing the control server removes control.json', () => {
      control.close();
      ok(!fs.existsSync(controlFile), 'file gone with the server');
    });
  } finally {
    control.close();
    projectsReg.remove(project.id);
  }
}

/* ---------------- capture power (Phase 4) ---------------- */
async function capturePowerTests() {
  console.log('\ncapture power');

  await check('a pasted blob becomes a clean URL list', () => {
    eq(parseUrlList('https://a.com\n\n https://b.com/x \nhttps://a.com\n# note\nhttps://c.com, https://d.com'),
      ['https://a.com', 'https://b.com/x', 'https://c.com', 'https://d.com']);
    eq(parseUrlList(''), []);
    eq(parseUrlList('  \n # only noise \n'), []);
    // Commas are legal inside a URL — a single URL never gets cut in half.
    eq(parseUrlList('https://a.com/page,with,commas'), ['https://a.com/page,with,commas']);
  });

  await check('header lines are validated into --http-header values', () => {
    eq(parseHeaderLines('Authorization: Basic abc\nnot a header\nX-Env: staging\n\n'),
      ['Authorization: Basic abc', 'X-Env: staging']);
    eq(parseHeaderLines(''), []);
    eq(parseHeaderLines(': no name'), []);
  });

  await check('crawl scope rules follow the CLI\'s rewrite semantics', () => {
    // Replicates single-file-cli's rewriteURL (single-file-cli-api.js): rules
    // are "<regex> <replacement>" split on spaces, and a URL rewritten to
    // nothing is skipped by the crawler.
    const rewrite = (url, rules) => {
      for (const rule of rules) {
        const parts = rule.trim().split(/ +/);
        url = url.replace(new RegExp(parts[0]), parts[1] || '').trim();
      }
      return url;
    };
    const excl = crawlScopeRules({ exclude: '/tag/*, /search' });
    eq(rewrite('https://site.com/tag/red', excl), '');
    eq(rewrite('https://site.com/search', excl), '');
    eq(rewrite('https://site.com/search?q=x', excl), '');
    eq(rewrite('https://site.com/blog/post', excl), 'https://site.com/blog/post');
    eq(rewrite('https://site.com/searching', excl), 'https://site.com/searching', 'no prefix bleed: ');
    const incl = crawlScopeRules({ include: 'docs/*' }); // leading slash implied
    eq(rewrite('https://site.com/docs/intro', incl), 'https://site.com/docs/intro');
    eq(rewrite('https://site.com/docs/deep/page?x=1', incl), 'https://site.com/docs/deep/page?x=1');
    eq(rewrite('https://site.com/pricing', incl), '');
    // A glob with a space would corrupt the space-separated rule — dropped.
    eq(crawlScopeRules({ exclude: '/has space/*' }), []);
    eq(crawlScopeRules({}), []);
  });

  await check('sitemap page lists post-filter through the same globs', () => {
    const urls = ['https://s.com/', 'https://s.com/docs/a', 'https://s.com/tag/x', 'https://s.com/docs/b?y=1'];
    eq(filterByGlobs(urls, { include: '/docs/*' }), ['https://s.com/docs/a', 'https://s.com/docs/b?y=1']);
    eq(filterByGlobs(urls, { exclude: '/tag/*' }), ['https://s.com/', 'https://s.com/docs/a', 'https://s.com/docs/b?y=1']);
    eq(filterByGlobs(urls, {}), urls);
    eq(filterByGlobs(['not a url'], { include: '/docs/*' }), []);
  });

  await check('buildArgs turns the new options into the CLI flags that exist', () => {
    const args = buildArgs({
      url: 'https://site.com/', crawl: true, depth: 2, browserPath: 'chrome.exe', singleFilePath: 'sf.js',
      profileDir: 'C:\\prof', cookiesFile: 'C:\\cookies.txt', headers: ['X-A: 1', 'X-B: 2'],
      scrollPage: true, include: '', exclude: '/tag/*',
    }, 'C:\\out');
    ok(args.includes('--browser-arg=--user-data-dir=C:\\prof'), 'profile rides in as a browser arg');
    ok(args.includes('--browser-cookies-file=C:\\cookies.txt'), 'cookie file flag');
    ok(args.includes('--http-header=X-A: 1') && args.includes('--http-header=X-B: 2'), 'headers repeat');
    ok(args.includes('--load-deferred-images-dispatch-scroll-event=true'), 'scroll flag');
    ok(args.includes('--load-deferred-images-max-idle-time=10000'), 'scroll mode waits longer');
    ok(args.some(a => a.startsWith('--crawl-rewrite-rule=')), 'scope rules attached to the crawl');

    const plain = buildArgs({ url: 'https://site.com/', browserPath: 'c', singleFilePath: 'sf' }, 'C:\\out');
    ok(!plain.some(a => a.includes('user-data-dir')), 'no profile unless asked');
    ok(plain.includes('--load-deferred-images-max-idle-time=3000'), 'default idle time without scroll');

    // Page-list mode (sitemap): one browser worker, no positional URL, no crawl.
    const list = buildArgs({ url: 'https://site.com/', crawl: true, urlsFile: 'C:\\u.txt',
      browserPath: 'c', singleFilePath: 'sf' }, 'C:\\out');
    ok(list.includes('--urls-file=C:\\u.txt'), 'urls file flag');
    ok(list.includes('--max-parallel-workers=1'), 'one browser at a time');
    ok(!list.includes('https://site.com/'), 'no positional URL in list mode');
    ok(!list.includes('--crawl-links=true'), 'a page list never crawls');
  });

  await check('sitemap parsing handles urlsets, indexes, CDATA and entities', () => {
    const urlset = parseSitemap('<?xml version="1.0"?><urlset><url><loc> https://s.com/a </loc></url>'
      + '<url><loc><![CDATA[https://s.com/b?x=1&amp;y=2]]></loc></url>'
      + '<url><loc>ftp://nope</loc></url></urlset>');
    eq(urlset.kind, 'urlset');
    eq(urlset.urls, ['https://s.com/a', 'https://s.com/b?x=1&y=2']);
    const index = parseSitemap('<sitemapindex><sitemap><loc>https://s.com/a.xml</loc></sitemap></sitemapindex>');
    eq(index.kind, 'index');
    eq(index.urls, ['https://s.com/a.xml']);
    eq(parseSitemap('not xml at all').urls, []);
  });

  await check('isSitemapUrl spots sitemap links and nothing else', () => {
    ok(isSitemapUrl('https://s.com/sitemap.xml'));
    ok(isSitemapUrl('https://s.com/sitemap_index.xml'));
    ok(isSitemapUrl('https://s.com/wp-sitemap.xml'));
    ok(!isSitemapUrl('https://s.com/feed.xml'), 'an .xml feed is not a sitemap');
    ok(!isSitemapUrl('https://s.com/sitemap'), 'needs the .xml');
    ok(!isSitemapUrl('not a url'));
  });

  await check('fetchSitemapUrls follows an index one level, dedupes and caps', async () => {
    const docs = {
      'https://s.com/sitemap.xml': '<sitemapindex><sitemap><loc>https://s.com/a.xml</loc></sitemap>'
        + '<sitemap><loc>https://s.com/broken.xml</loc></sitemap>'
        + '<sitemap><loc>https://s.com/b.xml</loc></sitemap></sitemapindex>',
      'https://s.com/a.xml': '<urlset><url><loc>https://s.com/one</loc></url>'
        + '<url><loc>https://s.com/two#frag</loc></url></urlset>',
      'https://s.com/b.xml': '<urlset><url><loc>https://s.com/two</loc></url>'
        + '<url><loc>https://s.com/three</loc></url></urlset>',
    };
    const fetchText = async url => {
      if (!docs[url]) throw new Error('404');
      return docs[url];
    };
    const urls = await fetchSitemapUrls('https://s.com/sitemap.xml', { fetchText });
    eq(urls, ['https://s.com/one', 'https://s.com/two', 'https://s.com/three']);
    const capped = await fetchSitemapUrls('https://s.com/sitemap.xml', { fetchText, limit: 2 });
    eq(capped, ['https://s.com/one', 'https://s.com/two']);
    await throws(() => fetchSitemapUrls('https://s.com/a.xml', {
      fetchText: async () => '<urlset></urlset>',
    }), 'an empty sitemap is an error, not an empty capture');
  });

  await check('captureOptions and the partial flag round-trip through the manifest', () => {
    const dir = scratch('cap-manifest');
    const co = {
      crawl: true, depth: 3, mobile: false, fixVideos: true, headless: true, stripBanners: true,
      waitDelay: 0, scrollPage: true, useProfile: true, cookiesFile: '', headers: ['X-A: 1'],
      include: '/docs/*', exclude: '', maxPages: 50, sitemap: false,
    };
    writeManifest(dir, { url: 'https://x.com', name: 'x', kind: 'raw', captureOptions: co, partial: true });
    const read = readManifest(dir);
    eq(read.captureOptions, co);
    eq(read.partial, true);
    eq(read.url, 'https://x.com');
  });

  await check('replaceTree swaps the working files and the old state stays in its snapshot', async () => {
    const capDir = scratch('recap-site');
    fs.writeFileSync(path.join(capDir, 'index.html'), '<h1>old</h1>');
    fs.writeFileSync(path.join(capDir, 'stale.html'), 'stale page');
    projectsReg.syncCaptures([{ dir: capDir, name: 'recap-site' }]);
    const project = projectsReg.byPath(capDir);
    // The re-capture order: snapshot first, then swap.
    await versions.createSnapshot(project, { source: 'capture', label: 'Before re-capture' });
    const fresh = scratch('recap-fresh');
    fs.writeFileSync(path.join(fresh, 'index.html'), '<h1>new</h1>');
    fs.mkdirSync(path.join(fresh, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(fresh, 'assets', 'a.css'), 'body{}');
    const swapped = await versions.replaceTree(project, fresh);
    eq(swapped.copied, 2);
    eq(swapped.removed, 1);
    eq(fs.readFileSync(path.join(capDir, 'index.html'), 'utf8'), '<h1>new</h1>');
    ok(!fs.existsSync(path.join(capDir, 'stale.html')), 'file the fresh tree lacks is gone');
    ok(fs.existsSync(path.join(capDir, 'assets', 'a.css')), 'new files copied in');
    // The snapshot store survived the swap and still holds the old state.
    const snap = versions.listSnapshots(project)[0];
    eq(snap.source, 'capture');
    eq((await versions.readFileAt(project, snap.id, 'index.html')).toString(), '<h1>old</h1>');
    eq((await versions.readFileAt(project, snap.id, 'stale.html')).toString(), 'stale page');
    // An empty fresh tree must never wipe a site.
    await throws(() => versions.replaceTree(project, scratch('recap-empty')), 'empty fresh tree refused');
    eq(fs.readFileSync(path.join(capDir, 'index.html'), 'utf8'), '<h1>new</h1>', 'nothing was deleted: ');
  });

  await check('the crawl page cap is a clamped setting', () => {
    eq(settings.save({ maxPages: 99999 }).maxPages, 1000);
    eq(settings.save({ maxPages: 0 }).maxPages, 1);
    eq(settings.save({ maxPages: 100 }).maxPages, 100);
  });
}

/* ---------------- guest review over share links (Phase 5.1) ---------------- */
async function guestReviewTests() {
  console.log('\nguest review (share links)');

  const site = scratch('guest-site');
  fs.writeFileSync(path.join(site, 'index.html'),
    '<html><body><h1 class="hero">Share me</h1></body></html>');
  const project = projectsReg.addLocal(site);

  const manager = new ReviewManager({
    projects: projectsReg,
    capturesRoot: () => scratch('guest-caps'),
    exportReview,
    overlayPath: path.join(ROOT, 'renderer', 'review-overlay.js'),
  });
  const enriched = [];
  const guests = new GuestManager({
    projects: projectsReg,
    reviews: reviewsStore,
    overlayScript: () => manager.overlayScript(),
    latestVersionId: p => {
      try { return (versions.listSnapshots(p)[0] || {}).id || null; } catch { return null; }
    },
    onSaved: (p, annotation) => enriched.push(annotation.id),
    // Tight note cap so the flood test doesn't need thirty saves; the request
    // bucket stays roomy so every other check breathes.
    limits: { bucket: { capacity: 200, refillPerSec: 200 }, notes: { limit: 3, windowMs: 60000 } },
  });
  const hostMgr = new HostManager();
  hostMgr.reviewRouter = dir => manager.forDir(dir);
  hostMgr.guestRouter = dir => guests.forDir(dir);
  hostMgr.versionsRouter = dir => {
    const p = projectsReg.byPath(dir);
    if (!p) return null;
    return {
      meta: id => versions.getSnapshot(p, id, { optional: true }),
      fileAt: (id, rel) => versions.fileAt(p, id, rel),
    };
  };
  const port = await hostMgr.start(site, 4770);

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
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const edge = { 'cf-connecting-ip': '203.0.113.7' };

  try {
    await check('without a guest share, tunneled visitors stay fully locked out', async () => {
      const state = await request('GET', '/__siteslurp__/review/state', null, edge);
      eq(state.status, 404);
      const page = await request('GET', '/', null, edge);
      ok(!page.text.includes('review/client.js'), 'no overlay for plain visitors');
    });

    let token;
    await check('the share URL trades ?review=<token> for a cookie, and only the real token', async () => {
      token = guests.enable(site).token;
      const good = await request('GET', `/?review=${token}`, null, edge);
      eq(good.status, 302);
      ok(good.headers['set-cookie'].some(c => c.startsWith(`__ss_guest=${token}`)), 'cookie set: '
        + JSON.stringify(good.headers['set-cookie']));
      // A wrong or junk token is ignored — never turned into a cookie op and
      // never a redirect off the page.
      const bad = await request('GET', `/?review=${'0'.repeat(32)}`, null, edge);
      ok(!bad.headers['set-cookie'], 'a wrong token sets no cookie: ' + JSON.stringify(bad.headers['set-cookie']));
      // Regression: a coincidental ?review= on an in-site link used to wipe a
      // guest who already held a valid cookie. It must not.
      const survives = await request('GET', '/page?review=notatoken', null, { ...edge, cookie: `__ss_guest=${token}` });
      const wiped = (survives.headers['set-cookie'] || []).some(c => c.includes('Max-Age=0'));
      ok(!wiped, 'an existing guest capability survives a junk review param');
    });

    const asGuest = extra => ({ ...edge, cookie: `__ss_guest=${token}`, ...extra });

    await check('a guest gets the overlay and a stripped state', async () => {
      const page = await request('GET', '/', null, asGuest());
      ok(page.text.includes('review/client.js'), 'overlay injected for the guest');
      const naked = await request('GET', '/', null, edge);
      ok(!naked.text.includes('review/client.js'), 'cookie-less visitors still get none');
      const script = await request('GET', '/__siteslurp__/review/client.js', null, asGuest());
      eq(script.status, 200);
      const state = await request('GET', '/__siteslurp__/review/state', null, asGuest());
      eq(state.status, 200);
      eq(state.json.guest, true);
      eq(Object.keys(state.json.project), ['name'], 'project reveals its name and nothing else: ');
      ok(Array.isArray(state.json.annotations), 'annotations ride along');
    });

    await check('a guest annotates with a name; the note lands enriched and authored', async () => {
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'element',
        author: '  Sam the Client  ',
        context: { selector: 'h1.hero', pageUrl: '/', outerHTML: '<h1>Share me</h1>' },
        input: { severity: 'should-fix', why: 'The headline reads like a shrug.' },
      }, asGuest());
      eq(res.status, 200);
      eq(res.json.annotation.author, 'Sam the Client');
      ok(!('outerHTML' in res.json.annotation.context), 'the reply is stripped too');
      const stored = reviewsStore.getAnnotation(project.id, res.json.annotation.id);
      eq(stored.author, 'Sam the Client');
      eq(stored.context.outerHTML, '<h1>Share me</h1>', 'the store keeps the full context: ');
      eq(enriched, [stored.id], 'the enrichment hook fired: ');
      // Local annotations stay "me" — authorship is a guest concept.
      const mine = reviewsStore.addAnnotation(project.id, {
        scope: 'global', context: {}, input: { why: 'A local note about everything.' },
      });
      eq(mine.author, 'me');
    });

    await check('every capability beyond state + annotate answers 403, not just hidden UI', async () => {
      const target = reviewsStore.listAnnotations(project.id)[0];
      for (const route of ['update', 'delete', 'resolve', 'export', 'export/reveal', 'done', 'audit', 'image']) {
        const res = await request('POST', `/__siteslurp__/review/${route}`, { id: target.id }, asGuest());
        eq(res.status, 403, `${route} refused: `);
      }
      const img = await request('GET', `/__siteslurp__/review/image/${target.id}`, null, asGuest());
      eq(img.status, 403, 'stored images stay private: ');
      const projectsRoute = await request('GET', '/__siteslurp__/review/projects', null, asGuest());
      eq(projectsRoute.status, 403, 'the library listing stays private: ');
    });

    await check('the guest origin check accepts same-host https and refuses others', async () => {
      const good = await request('GET', '/__siteslurp__/review/state', null,
        asGuest({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }));
      eq(good.status, 200);
      const bad = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'global', input: { why: 'Cross-origin mischief attempt.' },
      }, asGuest({ origin: 'https://evil.example' }));
      eq(bad.status, 403);
    });

    await check('the hourly note cap answers 429 with a sentence', async () => {
      // The cap is 3 for this run and one note is already in.
      for (let i = 0; i < 2; i++) {
        const res = await request('POST', '/__siteslurp__/review/annotate', {
          scope: 'global', author: 'Sam', input: { why: `Filler note number ${i} for the cap.` },
        }, asGuest());
        eq(res.status, 200, 'note within the cap saves: ');
      }
      const over = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'global', author: 'Sam', input: { why: 'One more than the window allows.' },
      }, asGuest());
      eq(over.status, 429);
      ok(/note limit/i.test(over.json.error), over.json.error);
    });

    await check('the request bucket rate limits tunneled review traffic per ip', async () => {
      const tight = new GuestManager({
        projects: projectsReg, reviews: reviewsStore,
        overlayScript: () => manager.overlayScript(),
        latestVersionId: () => null,
        limits: { bucket: { capacity: 2, refillPerSec: 0.001 } },
      });
      hostMgr.guestRouter = dir => tight.forDir(dir);
      const tightToken = tight.enable(site).token;
      const cookie = { ...edge, cookie: `__ss_guest=${tightToken}` };
      eq((await request('GET', '/__siteslurp__/review/state', null, cookie)).status, 200);
      eq((await request('GET', '/__siteslurp__/review/state', null, cookie)).status, 200);
      const limited = await request('GET', '/__siteslurp__/review/state', null, cookie);
      eq(limited.status, 429);
      ok(/rate limited/i.test(limited.json.error), limited.json.error);
      hostMgr.guestRouter = dir => guests.forDir(dir);
    });

    let v1;
    await check('a pinned share link sets both cookies in one redirect', async () => {
      v1 = (await versions.createSnapshot(project, { label: 'shared state', source: 'manual' })).id;
      guests.disable(site);
      token = guests.enable(site, { version: v1 }).token;
      const res = await request('GET', `/?v=${v1}&review=${token}`, null, edge);
      eq(res.status, 302);
      const cookies = res.headers['set-cookie'];
      ok(cookies.some(c => c.startsWith(`__ss_version=${v1}`)), 'pin cookie: ' + JSON.stringify(cookies));
      ok(cookies.some(c => c.startsWith(`__ss_guest=${token}`)), 'guest cookie');
    });

    await check('a pinned guest annotates while the pin is latest; the note remembers the version', async () => {
      // A different guest (new ip): the earlier flood test spent this hour's
      // note allowance for the first one.
      const pinnedGuest = { 'cf-connecting-ip': '203.0.113.8', cookie: `__ss_guest=${token}; __ss_version=${v1}` };
      const page = await request('GET', '/', null, pinnedGuest);
      ok(page.text.includes('Viewing snapshot'), 'snapshot banner serves through the tunnel');
      ok(page.text.includes('review/client.js'), 'overlay rides the pinned page');
      const state = await request('GET', '/__siteslurp__/review/state', null, pinnedGuest);
      eq(state.json.pinned, true);
      eq(state.json.pinnedStale, false);
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'element', author: 'Sam',
        context: { selector: 'h1.hero', pageUrl: '/' },
        input: { severity: 'nitpick', why: 'Noted against the pinned snapshot.' },
      }, pinnedGuest);
      eq(res.status, 200);
      const stored = reviewsStore.getAnnotation(project.id, res.json.annotation.id);
      eq(stored.pinnedVersion, v1, 'the snapshot id is on the note: ');
    });

    await check('once the page moves on, the pinned guest gets a friendly refusal', async () => {
      fs.writeFileSync(path.join(site, 'index.html'),
        '<html><body><h1 class="hero">Share me v2</h1></body></html>');
      await versions.createSnapshot(project, { label: 'moved on', source: 'manual' });
      const pinnedGuest = { 'cf-connecting-ip': '203.0.113.8', cookie: `__ss_guest=${token}; __ss_version=${v1}` };
      const state = await request('GET', '/__siteslurp__/review/state', null, pinnedGuest);
      eq(state.json.pinnedStale, true, 'state warns first: ');
      const res = await request('POST', '/__siteslurp__/review/annotate', {
        scope: 'global', author: 'Sam', input: { why: 'Too late for this snapshot.' },
      }, pinnedGuest);
      eq(res.status, 409);
      ok(/moved on/i.test(res.json.error), res.json.error);
    });

    await check('stopping the share kills the capability completely', async () => {
      guests.disable(site);
      const state = await request('GET', '/__siteslurp__/review/state', null, asGuest());
      eq(state.status, 404);
      const page = await request('GET', '/', null, asGuest());
      ok(!page.text.includes('review/client.js'), 'no overlay either');
    });

    await check('REVIEW.md names guest authors and pinned versions', () => {
      const authored = reviewsStore.listAnnotations(project.id).find(a => a.pinnedVersion);
      const md = renderAnnotation(authored, () => null);
      ok(md.includes('**By:** Sam (guest)'), 'author line: ' + md.split('\n')[1]);
      ok(md.includes(`**Noted on snapshot:** ${v1}`), 'pinned version line');
      const local = reviewsStore.listAnnotations(project.id).find(a => a.author === 'me');
      ok(!renderAnnotation(local, () => null).includes('**By:**'), 'local notes stay unadorned');
    });
  } finally {
    hostMgr.stopAll();
  }
}

/* ---------------- local https + secrets + deploy zips (Phase 5.2 / 5.3) ---------------- */
async function sharingPowerTests() {
  console.log('\nlocal https & deploy plumbing');

  await check('the https door serves the same handler with the minted certificate', async () => {
    const dir = scratch('https-site');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>secure</h1>');
    const material = certs.ensureLocalTls(path.join(TMP, 'tls-store'));
    const hostMgr = new HostManager();
    try {
      const port = await hostMgr.start(dir, 4870, {
        tls: { key: material.key, cert: material.cert, port: 9443 },
      });
      const httpsPort = hostMgr.httpsPortFor(dir);
      ok(httpsPort, 'an https port was bound');
      ok(httpsPort !== port, 'on its own port');
      const body = await new Promise((resolve, reject) => {
        httpsMod.get({
          host: '127.0.0.1', port: httpsPort, ca: material.ca,
          servername: 'my-site.slurp.localhost',
        }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        }).on('error', reject);
      });
      ok(body.includes('<h1>secure</h1>'), 'the site serves over tls');
      const plain = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port }, res => { res.resume(); resolve(res.statusCode); })
          .on('error', reject);
      });
      eq(plain, 200, 'the http door still answers: ');
    } finally {
      hostMgr.stopAll();
    }
  });

  await check('secrets round-trip through safeStorage and never sit in plaintext', () => {
    secrets.set('deploy:netlify:token', 'nfp_secret_12345');
    const onDisk = fs.readFileSync(path.join(TMP, 'userData', 'secrets.json'), 'utf8');
    ok(!onDisk.includes('nfp_secret_12345'), 'plaintext is not in the file');
    eq(secrets.get('deploy:netlify:token'), 'nfp_secret_12345');
    eq(secrets.has('deploy:netlify:token'), true);
    secrets.set('deploy:netlify:token', '');
    eq(secrets.get('deploy:netlify:token'), null);
    eq(secrets.has('deploy:netlify:token'), false);
  });

  await check('zipFiles archives an explicit manifest file set — how snapshots deploy', async () => {
    const blobs = scratch('deploy-blobs');
    fs.writeFileSync(path.join(blobs, 'blob1'), '<h1>from a snapshot</h1>');
    fs.writeFileSync(path.join(blobs, 'blob2'), 'body{color:blue}');
    const zipPath = path.join(TMP, 'deploy.zip');
    const result = await zipFiles([
      { name: 'index.html', file: path.join(blobs, 'blob1') },
      { name: 'assets/site.css', file: path.join(blobs, 'blob2') },
      // Bytes made for the archive, no file behind them — how the 24/7 audit
      // bundle adds its state file.
      { name: '_redirects', data: Buffer.from('/  /index.html  200\n') },
    ], zipPath);
    eq(result.files, 3);
    if (process.platform === 'win32') {
      const dest = path.join(TMP, 'deploy-unzipped');
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`], { windowsHide: true });
      eq(fs.readFileSync(path.join(dest, 'index.html'), 'utf8'), '<h1>from a snapshot</h1>');
      eq(fs.readFileSync(path.join(dest, 'assets', 'site.css'), 'utf8'), 'body{color:blue}');
      eq(fs.readFileSync(path.join(dest, '_redirects'), 'utf8'), '/  /index.html  200\n');
    }
    await throws(() => zipFiles([], path.join(TMP, 'empty.zip')), 'an empty entry list refuses');
  });

  await check('a 24/7 audit bundle carries the overlay, a state file, and the entry redirect', async () => {
    const site = scratch('static-audit');
    fs.writeFileSync(path.join(site, '_en.html'), '<html><body><h1>hi</h1></body></html>');
    fs.writeFileSync(path.join(site, 'about.html'), '<h1>no body tag</h1>');
    fs.writeFileSync(path.join(site, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const entries = await folderEntries(site);
    // The capture's real front door answers at "/" on the host.
    const redirect = staticAudit.entryRedirect(entries, '_en.html');
    eq(redirect.name, '_redirects');
    eq(redirect.data.toString(), '/  /_en.html  200\n');
    eq(staticAudit.entryRedirect(entries, 'index.html'), null, 'index.html needs no redirect: ');
    eq(staticAudit.entryRedirect(entries, 'missing.html'), null, 'a page that is not there is not redirected to: ');
    eq(staticAudit.entryRedirect([...entries, { name: 'index.html', data: Buffer.from('') }], '_en.html'), null,
      'an existing index.html wins: ');
    entries.push(redirect);
    const state = staticAudit.standaloneState({
      project: { name: 'Demo' }, review: { id: 'rev_1' }, annotations: [{ id: 'a1' }], axes: ['x'], minWhy: 0, version: 'v2',
    });
    const bundle = await staticAudit.withStaticAudit(entries, { overlaySource: '/* overlay */', state });
    eq(bundle.pages, 2);
    const byName = Object.fromEntries(bundle.entries.map(e => [e.name, e]));
    ok(byName['_en.html'].data.toString().includes(staticAudit.TAG + '</body>'), 'the tag lands before </body>');
    ok(byName['about.html'].data.toString().endsWith(staticAudit.TAG), 'a page without </body> gets the tag appended');
    ok(byName['logo.png'].file, 'other files still come straight from disk');
    eq(byName[staticAudit.CLIENT_NAME].data.toString(), '/* overlay */');
    const shipped = JSON.parse(byName[staticAudit.STATE_NAME].data.toString());
    eq(shipped.guest, true);
    eq(shipped.standalone, true);
    eq(shipped.project.name, 'Demo');
    eq(shipped.review.id, 'rev_1');
    eq(shipped.version, 'v2');
    eq(shipped.annotations.length, 1);
    eq(byName['_redirects'].data.toString(), '/  /_en.html  200\n');
    ok(staticAudit.TAG.includes('data-ss-standalone="1"'), 'the tag tells the overlay it is on its own');
  });
}

/* ---------------- run ---------------- */
/* ---------------- ShowCase ---------------- */
// The director's pure half: options in range, which links a tour walks, what
// happens when a page ends, and where a device frame puts the view.
async function showcaseTests() {
  console.log('\nShowCase');
  const sc = require('../lib/showcase');

  await check('options: defaults, clamps, enums and the old mode names', () => {
    const d = sc.normalizeOptions();
    eq(d.style, 'walkthrough'); eq(d.speed, 90); eq(d.frame, 'none'); eq(d.cursor, 'ghost'); eq(d.display, null);
    eq(d.nav, true); eq(d.flip, false); eq(d.record, false); eq(d.music, ''); eq(d.musicVolume, 60);
    const o = sc.normalizeOptions({ speed: 9999, dwell: -4, zoom: '125', style: 'reel', frame: 'toaster', cursor: 'spotlight',
      tagline: 'x'.repeat(500), display: '3', sections: 0, bogus: true, record: 1, musicVolume: 500, music: 'C:\\x\\y.mp3' });
    eq(o.speed, 800); eq(o.dwell, 0); eq(o.zoom, 125); eq(o.style, 'reel'); eq(o.frame, 'none');
    eq(o.cursor, 'spotlight'); eq(o.tagline.length, 160); eq(o.display, 3); eq(o.sections, false);
    eq(o.record, true); eq(o.musicVolume, 100); eq(o.music, 'C:\\x\\y.mp3');
    ok(!('bogus' in o), 'unknown keys dropped');
    eq(sc.normalizeOptions({ display: 'nope' }).display, null);
    eq(sc.normalizeOptions('junk').style, 'walkthrough');
    eq(sc.normalizeOptions({ frame: 'duo' }).frame, 'duo');
    // 2.7.0 saved "mode"; it still reads.
    eq(sc.normalizeOptions({ mode: 'tour' }).style, 'walkthrough');
    eq(sc.normalizeOptions({ mode: 'still' }).style, 'still');
    eq(sc.normalizeOptions({ mode: 'tour', style: 'reel' }).style, 'reel', 'style wins over mode: ');
    for (const style of sc.STYLES) ok(sc.STYLE_SPEC[style] && sc.STYLE_BEATS[style], `${style} has a spec and beats`);
  });

  await check('nav targets: same origin, no files, no anchors, nav first, deduped, capped', () => {
    const origin = 'http://localhost:4300';
    const links = [
      { href: '/#top', text: 'Top', inNav: true },
      { href: 'http://localhost:4300/', text: 'Home', inNav: true },
      { href: '/about.html', text: '  About\n us ', inNav: true },
      { href: '/about.html?x=1', text: 'About again', inNav: false },
      { href: '/about.html', text: 'dupe', inNav: true },
      { href: '/brochure.pdf', text: 'PDF', inNav: true },
      { href: 'https://twitter.com/x', text: 'Twitter', inNav: true },
      { href: 'mailto:hi@x.com', text: 'Mail' },
      { href: '/blog/post-one', text: '', inNav: false },
      { href: '/contact/', text: 'Contact', inNav: true },
      { href: 'http://localhost:4300/pricing#plans', text: 'Pricing', inNav: false },
      null, { nope: 1 },
    ];
    const out = sc.filterNavTargets(links, { origin, current: origin + '/' });
    eq(out.map(t => t.label), ['About us', 'Contact', 'About again', 'post one', 'Pricing']);
    eq(out[0].href, 'http://localhost:4300/about.html');
    eq(out[1].href, 'http://localhost:4300/contact/');
    eq(out[4].href, 'http://localhost:4300/pricing', 'hash stripped');
    eq(sc.filterNavTargets(links, { origin, current: origin + '/', max: 2 }).length, 2);
    eq(sc.filterNavTargets(links, { origin: 'not a url' }), []);
    // From /about.html the home link is a real page again.
    const fromAbout = sc.filterNavTargets(links, { origin, current: origin + '/about.html' });
    ok(fromAbout.some(t => t.href === origin + '/'), 'home is a target from another page');
    ok(!fromAbout.some(t => t.href.endsWith('/about.html')), 'the current page is not');
  });

  await check('nav targets: a capture\'s links to its source site count as local', () => {
    const origin = 'http://localhost:4300';
    const links = [
      { href: 'https://motionsites.ai/', text: 'Home', inNav: true },
      { href: 'https://motionsites.ai/unlimited', text: 'Unlimited', inNav: true },
      { href: 'https://motionsites.ai/backgrounds?ref=1#top', text: 'Backgrounds' },
      { href: 'https://motionsites.ai/#features', text: 'Features', inNav: true },
      { href: 'https://designrocket.io/', text: 'Elsewhere', inNav: true },
    ];
    const out = sc.filterNavTargets(links, { origin, current: origin + '/', sourceOrigin: 'https://motionsites.ai' });
    eq(out.map(t => t.href), ['http://localhost:4300/unlimited', 'http://localhost:4300/backgrounds?ref=1']);
    eq(out[0].original, 'https://motionsites.ai/unlimited', 'the original link is kept for finding it on the page: ');
    eq(sc.filterNavTargets(links, { origin, current: origin + '/' }), [], 'without a source origin they are foreign: ');
    eq(sc.filterNavTargets(links, { origin, current: origin + '/', sourceOrigin: 'garbage' }), [], 'a bad source origin is ignored: ');
  });

  await check('hosting: a pretty path redirects to the flat page SingleFile saved', async () => {
    const site = scratch('flat-site');
    fs.writeFileSync(path.join(site, '_.html'), '<html><body>home</body></html>');
    fs.writeFileSync(path.join(site, '_about.html'), '<html><body>about</body></html>');
    fs.writeFileSync(path.join(site, '_en_projects_x.html'), '<html><body>x</body></html>');
    const mgr = new HostManager();
    const port = await mgr.start(site, 4791);
    const head = p => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, r => { r.resume(); resolve({ status: r.statusCode, location: r.headers.location }); }).on('error', reject);
    });
    try {
      eq(await head('/about'), { status: 302, location: '/_about.html' });
      eq(await head('/en/projects/x/'), { status: 302, location: '/_en_projects_x.html' });
      eq((await head('/about?utm=1')).status, 302);
      eq((await head('/_about.html')).status, 200, 'the flat name itself serves: ');
      eq((await head('/nothing-here')).status, 404);
      eq((await head('/about.css')).status, 404, 'a file-looking path is not a page: ');
    } finally { mgr.stopAll(); }
  });

  await check('hosting: a query string picks the captured page saved from that URL', async () => {
    // The crawler reached /shop?type=jerseys before /shop, so SingleFile named
    // the filtered page _shop.html and the plain one _shop (3).html.
    const site = scratch('query-site');
    const page = u => `<!DOCTYPE html> <html lang=en><!--\n Page saved with SingleFile \n url: ${u} \n--><p>x</p>`;
    fs.writeFileSync(path.join(site, '_.html'), page('https://site.test/'));
    fs.writeFileSync(path.join(site, '_shop.html'), page('https://site.test/shop?type=jerseys'));
    fs.writeFileSync(path.join(site, '_shop (2).html'), page('https://site.test/shop?type=hats'));
    fs.writeFileSync(path.join(site, '_shop (3).html'), page('https://site.test/shop'));
    fs.writeFileSync(path.join(site, '_about.html'), '<html><body>no header</body></html>');
    const mgr = new HostManager();
    const port = await mgr.start(site, 4793);
    const head = (p, headers = {}) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers }, r => {
        r.resume();
        resolve(r.headers.location ? { status: r.statusCode, location: r.headers.location } : { status: r.statusCode });
      }).on('error', reject);
    });
    try {
      eq(await head('/shop'), { status: 302, location: '/_shop%20(3).html' }, 'the plain page, not the first-crawled filter: ');
      eq(await head('/shop/'), { status: 302, location: '/_shop%20(3).html' });
      eq(await head('/shop?type=hats'), { status: 302, location: '/_shop%20(2).html' });
      eq(await head('/shop?type=jerseys'), { status: 302, location: '/_shop.html' });
      eq(await head('/shop?type=unknown&_rsc=1'), { status: 302, location: '/_shop%20(3).html' }, 'an unknown query falls back to the path: ');
      eq(await head('/about'), { status: 302, location: '/_about.html' }, 'a page without a header still resolves by name: ');
      eq((await head('/_shop%20(2).html')).status, 200);
      // The mirror files a product page's runtime assets under shop/, and a
      // router prefetch payload may have landed as a file named like a route.
      fs.mkdirSync(path.join(site, 'shop', 'hat'), { recursive: true });
      fs.writeFileSync(path.join(site, 'shop', 'hat', 'x.js'), 'js');
      fs.writeFileSync(path.join(site, 'shop', 'hat-payload'), 'rsc');
      fs.writeFileSync(path.join(site, '_shop_hat-payload.html'), page('https://site.test/shop/hat-payload'));
      eq(await head('/shop'), { status: 302, location: '/_shop%20(3).html' }, 'a folder of runtime files does not shadow the page: ');
      eq(await head('/shop/hat/'), { status: 404 }, 'a folder with no index and no page is nothing: ');
      eq(await head('/shop/hat/x.js'), { status: 200 });
      eq(await head('/shop/hat-payload', { accept: 'text/html,*/*' }), { status: 302, location: '/_shop_hat-payload.html' }, 'a navigation goes to the page, not the payload file: ');
      eq((await head('/shop/hat-payload', { accept: '*/*' })).status, 200, 'a fetch of the file itself still gets it: ');
    } finally { mgr.stopAll(); }
  });

  // A reading of a typical landing page, as the client would report it.
  const reading = () => ({
    scrolls: true, max: 6000, vh: 900,
    sections: [
      { y: 900, label: 'Services', key: 10, cards: [11, 12, 13, 14] },
      { y: 1800, label: 'The Build', key: null, cards: [] },
      { y: 2700, label: '', key: 15, cards: [16, 17] },
      { y: 3600, label: 'Reviews', key: 18, cards: [19, 20, 21] },
      { y: 4500, label: 'Book', key: null, cards: [] },
    ],
    nav: [{ ref: 1, label: 'Services' }, { ref: 2, label: 'Gallery' }, { ref: 3, label: 'Reviews' }],
    buttons: [{ ref: 4, label: 'Book Now' }, { ref: 5, label: 'Explore' }],
    hero: 9,
    interactive: [{ ref: 30, label: 'Tag one' }, { ref: 31, label: 'Tag two' }],
  });
  const kinds = board => board.map(s => s.kind).join(' ');

  await check('storyboard: a walkthrough opens, walks the nav, hovers the button, then every section with its picture and cards', () => {
    const board = sc.buildBoard(reading(), { style: 'walkthrough' });
    eq(kinds(board), 'establish nav button glide detail cards glide glide detail glide detail cards glide glide hold');
    eq(board[0].ms, 3000);
    eq(board[1].refs, [1, 2, 3]); eq(board[1].labels, ['Services', 'Gallery', 'Reviews']);
    eq(board[2].ref, 4); eq(board[2].label, 'Button · Book Now');
    eq(board[3], { kind: 'glide', label: 'Section · Services', y: 900, caption: 'Services', ms: 2500, boost: 1 });
    eq(board[4].ref, 10); eq(board[4].push, 1.1); eq(board[4].ms, 2000);
    eq(board[5].refs, [11, 12, 13, 14]);
    eq(board[7].label, 'Section', 'a section without a heading still gets a stop: ');
    eq(board[7].caption, '');
    eq(board[board.length - 2], { kind: 'glide', label: 'To the end', y: 6000, caption: '', ms: 0, boost: 1 });
    eq(board[board.length - 1], { kind: 'hold', label: 'End of page', ms: 4000 });
    // Two cards are not a grid.
    ok(!board.some(s => s.kind === 'cards' && s.refs.length < 3), 'no sweep over fewer than three cards');
  });

  await check('storyboard: beats are switches; flip depends on the frame', () => {
    const quiet = sc.buildBoard(reading(), { style: 'walkthrough', nav: false, buttons: false, details: false, cards: false });
    eq(kinds(quiet), 'establish glide glide glide glide glide glide hold');
    const flipped = sc.buildBoard(reading(), { style: 'walkthrough', flip: true, frame: 'laptop' });
    eq(flipped[flipped.length - 2].kind, 'flip');
    eq(sc.buildBoard(reading(), { style: 'walkthrough', flip: true, frame: 'phone' }).some(s => s.kind === 'flip'), false, 'no flip on a phone: ');
    eq(sc.buildBoard(reading(), { style: 'walkthrough', flip: true }, { frame: 'duo' }).some(s => s.kind === 'flip'), false, 'no flip in a duo: ');
    const noStops = sc.buildBoard(reading(), { style: 'walkthrough', sections: false });
    eq(kinds(noStops), 'establish nav button glide hold');
    const oneNav = sc.buildBoard({ ...reading(), nav: [{ ref: 1, label: 'Only' }] }, { style: 'walkthrough' });
    ok(!oneNav.some(s => s.kind === 'nav'), 'a single nav link is not a walk');
  });

  await check('storyboard: a reel keeps three stops and hurries; cinematic opens on the hero; scroll just scrolls; still holds', () => {
    const reel = sc.buildBoard(reading(), { style: 'reel', ...sc.STYLE_BEATS.reel, frame: 'laptop' });
    eq(kinds(reel), 'establish glide detail glide detail glide glide flip hold');
    eq(reel[0].ms, 1800);
    eq(reel.filter(s => s.kind === 'glide').map(s => s.y), [900, 2700, 4500, 6000], 'spread down the page: ');
    eq(reel[1].boost, 1.8);
    const cine = sc.buildBoard(reading(), { style: 'cinematic', ...sc.STYLE_BEATS.cinematic });
    eq(kinds(cine).slice(0, 16), 'establish detail');
    eq(cine[1], { kind: 'detail', label: 'Hero', ref: 9, push: 1.16, ms: 2500 });
    eq(cine[0].ms, 4500);
    ok(!cine.some(s => s.kind === 'nav' || s.kind === 'cards'), 'cinematic keeps the pointer out of it');
    const scroll = sc.buildBoard(reading(), { style: 'scroll', ...sc.STYLE_BEATS.scroll, details: true });
    eq(kinds(scroll), 'establish glide glide glide glide glide glide hold', 'scroll never pushes in even with details on: ');
    eq(sc.buildBoard(reading(), { style: 'still', pageDwell: 6 }), [{ kind: 'hold', label: 'Hold', ms: 6000 }]);
  });

  await check('storyboard: a page that does not scroll gets explored by pointer; an empty reading still plays', () => {
    const flat = sc.buildBoard({ ...reading(), scrolls: false, max: 0 }, { style: 'walkthrough' });
    eq(kinds(flat), 'establish nav button wander hold');
    eq(flat[3].refs, [30, 31]); eq(flat[3].labels, ['Tag one', 'Tag two']);
    eq(kinds(sc.buildBoard({ scrolls: false, interactive: [] }, { style: 'walkthrough' })), 'establish hold');
    eq(kinds(sc.buildBoard(null, {})), 'establish hold');
    eq(kinds(sc.buildBoard({ scrolls: true, max: 3000, sections: [{ y: 'x' }, null, { y: 1200, label: 'Ok' }], nav: 'nope', buttons: [{}] }, { style: 'walkthrough' })), 'establish glide glide hold', 'junk in the reading is skipped: ');
  });

  await check('next step: pages walk pages, reels walk sites, loop wraps, otherwise ends', () => {
    const step = o => sc.nextStep(o).type;
    eq(step({ pages: false, loop: true }), 'restart');
    eq(step({ pages: false, loop: false }), 'end');
    eq(step({ pages: true, loop: true, pageCount: 3, pageIndex: 0 }), 'nextPage');
    eq(step({ pages: true, loop: true, pageCount: 3, pageIndex: 2 }), 'firstPage');
    eq(step({ pages: true, loop: false, pageCount: 3, pageIndex: 2 }), 'end');
    eq(step({ pages: true, loop: true, pageCount: 1, pageIndex: 0 }), 'restart');
    eq(step({ pages: false, loop: true, siteCount: 3, siteIndex: 0 }), 'nextSite');
    eq(step({ pages: false, loop: true, siteCount: 3, siteIndex: 2 }), 'firstSite');
    eq(step({ pages: false, loop: false, siteCount: 3, siteIndex: 2 }), 'end');
    eq(step({ pages: true, loop: true, pageCount: 4, pageIndex: 1, siteCount: 2, siteIndex: 0 }), 'nextPage');
    eq(step({ pages: true, loop: true, pageCount: 4, pageIndex: 3, siteCount: 2, siteIndex: 0 }), 'nextSite');
    // The reel timer outranks the page order.
    eq(step({ pages: true, loop: true, pageCount: 4, pageIndex: 1, siteCount: 2, siteIndex: 0, reelDue: true }), 'nextSite');
    eq(step({ pages: true, loop: false, pageCount: 4, pageIndex: 1, siteCount: 2, siteIndex: 1, reelDue: true }), 'end');
    eq(step({ pages: true, loop: true, pageCount: 4, pageIndex: 1, siteCount: 1, siteIndex: 0, reelDue: true }), 'nextPage', 'a single site has no reel: ');
  });

  await check('device fit: centred, scaled to fit, full stage for none, laptop and phone side by side for duo', () => {
    const stage = { x: 0, y: 0, width: 1920, height: 1080 };
    eq(sc.fitDevice('none', stage), { kind: 'none', x: 0, y: 0, width: 1920, height: 1080, scale: 1 });
    const phone = sc.fitDevice('phone', stage);
    eq(phone.kind, 'phone');
    ok(phone.height <= 1080 * 0.86 + 1 && phone.height > 900, 'phone fills the height with breathing room: ' + phone.height);
    ok(Math.abs((phone.width / phone.height) - (390 / 844)) < 0.01, 'phone keeps its aspect');
    ok(Math.abs(phone.x + phone.width / 2 - 960) <= 1, 'phone centred');
    ok(Math.abs(phone.scale - phone.width / 390) < 0.01, 'scale matches the CSS width');
    const laptop = sc.fitDevice('laptop', stage);
    ok(laptop.width <= 1920 * 0.8 + 1, 'laptop fits the width');
    ok(laptop.y + laptop.height / 2 < 540, 'laptop rides above centre for its base');
    const duo = sc.fitDevice('duo', stage);
    eq(duo.kind, 'duo');
    ok(duo.phone && duo.phone.kind === 'phone', 'duo carries a phone box');
    ok(duo.x + duo.width <= 1920 * 0.7 + 1, 'the laptop stays in the left 70%: ' + (duo.x + duo.width));
    ok(duo.phone.x >= duo.x + duo.width, 'the phone sits to the right of the laptop');
    ok(duo.phone.x + duo.phone.width <= 1920, 'the phone stays on the stage');
    ok(Math.abs(duo.width / duo.height - 1440 / 900) < 0.01, 'the laptop half keeps its aspect');
    const tiny = sc.fitDevice('tablet', { x: 10, y: 10, width: 200, height: 100 });
    eq(tiny.scale, 0.25, 'never shrinks below a quarter: ');
    const huge = sc.fitDevice('phone', { width: 20000, height: 20000 });
    eq(huge.scale, 4, 'never blows up past 4x: ');
    eq(sc.fitDevice('phone', null).kind, 'phone', 'survives a missing stage: ');
  });

  await check('push-in: the box grows around the focus, which stays put', () => {
    const box = { kind: 'none', x: 100, y: 50, width: 1000, height: 600, scale: 1 };
    eq(sc.pushBox(box, { x: 500, y: 300 }, 1.2), { kind: 'none', x: 0, y: -10, width: 1200, height: 720, scale: 1.2 });
    const corner = sc.pushBox(box, { x: 0, y: 0 }, 1.5);
    eq([corner.x, corner.y], [100, 50], 'a top-left focus grows right and down: ');
    const clamped = sc.pushBox(box, { x: 5000, y: -20 }, 1.1);
    eq([clamped.x, clamped.y], [0, 50], 'focus is clamped to the box: ');
    eq(sc.pushBox(box, null, 1), box, 'k = 1 is the box itself: ');
  });

  await check('recording name: site, moment, format', () => {
    const when = new Date(2026, 8, 23, 14, 5);
    eq(sc.recordingName(['Motion Sites!'], 'video/mp4;codecs=avc1', when), 'motion-sites-20260923-1405.mp4');
    eq(sc.recordingName(['A', 'B'], 'video/mp4', when), 'reel-20260923-1405.mp4');
    eq(sc.recordingName(['x'], 'video/webm;codecs=vp9', when), 'x-20260923-1405.webm');
    eq(sc.recordingName([], '', when), 'reel-20260923-1405.webm');
    eq(sc.recordingName(['!!!'], 'video/mp4', when), 'show-20260923-1405.mp4', 'a name with nothing usable: ');
  });

  await check('idle state and the client script exist', () => {
    eq(sc.idleState(), { active: false });
    const src = fs.readFileSync(sc.clientPath, 'utf8');
    ok(src.includes('window.__nsShowcase'), 'client exposes its API');
    ok(src.includes('data-slurp-ui'), 'client marks its chrome so other in-page tools skip it');
    for (const fn of ['configure', 'begin', 'prepare', 'analyze', 'state', 'glideTo', 'hold', 'pointFor', 'abort', 'follow',
      'navTargets', 'targetFor', 'cursorTo', 'cursorAway', 'restart', 'caption']) {
      ok(new RegExp('\\b' + fn + '\\b').test(src), 'client has ' + fn);
    }
    ok(/data-ns-reveal/.test(src) && /data-ns-hide/.test(src), 'client reveals and tidies through marked attributes');
  });
}

(async () => {
  console.log(`Local Dev Studio checks  (scratch: ${TMP})`);
  await paletteTests();
  await extractTests();
  await modelfixTests();
  await mirrorTests();
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
  await verifyLoopTests();
  await agentTests();
  await versionTests();
  await pinnedServingTests();
  await capturePowerTests();
  await guestReviewTests();
  await sharingPowerTests();
  await grabTests();
  await menuTests();
  await showcaseTests();
  await miscTests();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const [name, err] of failures) console.log(`\n${name}\n${err.stack}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
