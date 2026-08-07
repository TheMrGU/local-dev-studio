// Unit tests for the audit engine's pure helpers (lib/audits.js): link
// extraction, internal-path resolution, severity mapping, dedupe keys.
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// audits.js pulls in the logger, which asks Electron for app paths; stub it
// the same way scripts/test.js does before anything loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-auditstest-'));
require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    app: {
      getAppPath: () => path.join(__dirname, '..'),
      getPath: name => path.join(TMP, name),
      getVersion: () => '0.0.0-test',
    },
  },
};

const { extractLinks, internalPath, severityFor, findingKey, AXE_FILE, AXE_VERSION } = require('../lib/audits');

test('extractLinks reads every quoting style, in order', () => {
  const html = '<a href="/one.html">1</a> <A HREF=\'/two\'>2</A> <a class="x" href=three>3</a>'
    + ' <a>no href</a> <area href="/not-an-anchor">';
  assert.deepEqual(extractLinks(html), ['/one.html', '/two', 'three']);
});

test('internalPath keeps same-site targets and refuses the rest', () => {
  assert.equal(internalPath('/about.html', '/'), '/about.html');
  assert.equal(internalPath('pricing', '/docs/index.html'), '/docs/pricing', 'relative resolves against the page');
  assert.equal(internalPath('../up.html', '/docs/index.html'), '/up.html');
  assert.equal(internalPath('/page?tab=2', '/'), '/page?tab=2', 'query survives');
  assert.equal(internalPath('#section', '/'), null, 'fragments are not links to check');
  assert.equal(internalPath('mailto:x@y.z', '/'), null);
  assert.equal(internalPath('tel:+123', '/'), null);
  assert.equal(internalPath('javascript:void(0)', '/'), null);
  assert.equal(internalPath('https://elsewhere.example/page', '/'), null, 'absolute external');
  assert.equal(internalPath('//cdn.example/x.js', '/'), null, 'protocol-relative is external');
  assert.equal(internalPath('/__siteslurp__/events', '/'), null, 'our own endpoints are not findings');
});

test('axe impact maps onto the review severity scale', () => {
  assert.equal(severityFor('critical'), 'blocking');
  assert.equal(severityFor('serious'), 'should-fix');
  assert.equal(severityFor('moderate'), 'nitpick');
  assert.equal(severityFor('minor'), 'nitpick');
  assert.equal(severityFor(undefined), 'nitpick');
});

test('findingKey makes reruns idempotent per page+selector+message', () => {
  const a = findingKey('/', 'a[href="/x"]', 'Broken internal link');
  assert.equal(a, findingKey('/', 'a[href="/x"]', 'Broken internal link'));
  assert.notEqual(a, findingKey('/other', 'a[href="/x"]', 'Broken internal link'));
  assert.notEqual(a, findingKey('/', 'a[href="/y"]', 'Broken internal link'));
});

test('the vendored axe-core file exists and is the pinned version', () => {
  const head = fs.readFileSync(AXE_FILE, 'utf8').slice(0, 200);
  assert.ok(head.includes(`axe v${AXE_VERSION}`), `vendor/axe.min.js should be axe ${AXE_VERSION}, got: ${head.slice(0, 40)}`);
});
