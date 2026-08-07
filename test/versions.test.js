// Unit tests for the pure manifest logic in lib/versions.js — stamps, the
// identical-content comparison, manifest diffing, and path normalization.
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// versions.js pulls in modules that ask Electron for app paths; stub it the
// same way scripts/test.js does before anything loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-vtest-'));
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

const { stampFrom, sameFiles, diffManifests, normalizeRel } = require('../lib/versions');

test('stamps are UTC, Windows-safe and sortable', () => {
  const stamp = stampFrom(new Date('2026-08-07T14:30:05.123Z'));
  assert.equal(stamp, '2026-08-07T14-30-05Z');
  assert.ok(!stamp.includes(':'), 'no colon anywhere');
  const earlier = stampFrom(new Date('2026-08-07T14:30:04.999Z'));
  assert.ok(earlier < stamp, 'lexicographic order follows time');
});

test('sameFiles compares path + content hash only', () => {
  const a = [{ path: 'a.html', sha1: '1'.repeat(40), size: 5, mtime: 1 }];
  const same = [{ path: 'a.html', sha1: '1'.repeat(40), size: 5, mtime: 999 }];
  const renamed = [{ path: 'b.html', sha1: '1'.repeat(40), size: 5, mtime: 1 }];
  const edited = [{ path: 'a.html', sha1: '2'.repeat(40), size: 5, mtime: 1 }];
  assert.equal(sameFiles(a, same), true, 'mtime differences are not changes');
  assert.equal(sameFiles(a, renamed), false);
  assert.equal(sameFiles(a, edited), false);
  assert.equal(sameFiles(a, []), false);
  assert.equal(sameFiles(a, [...a, ...renamed]), false);
});

test('diffManifests buckets added, removed and changed', () => {
  const before = [
    { path: 'index.html', sha1: 'a'.repeat(40), size: 10 },
    { path: 'css/site.css', sha1: 'b'.repeat(40), size: 20 },
    { path: 'gone.txt', sha1: 'c'.repeat(40), size: 5 },
  ];
  const after = [
    { path: 'index.html', sha1: 'd'.repeat(40), size: 12 },
    { path: 'css/site.css', sha1: 'b'.repeat(40), size: 20 },
    { path: 'new.txt', sha1: 'e'.repeat(40), size: 7 },
  ];
  const diff = diffManifests(before, after);
  assert.deepEqual(diff.added, [{ path: 'new.txt', size: 7 }]);
  assert.deepEqual(diff.removed, [{ path: 'gone.txt', size: 5 }]);
  assert.deepEqual(diff.changed, [{ path: 'index.html', sizeA: 10, sizeB: 12 }]);
});

test('diffManifests of identical manifests is empty', () => {
  const files = [{ path: 'x', sha1: 'a'.repeat(40), size: 1 }];
  const diff = diffManifests(files, files);
  assert.deepEqual(diff, { added: [], removed: [], changed: [] });
});

test('normalizeRel accepts real relative paths and refuses escapes', () => {
  assert.equal(normalizeRel('css/site.css'), 'css/site.css');
  assert.equal(normalizeRel('css\\site.css'), 'css/site.css', 'backslashes normalize');
  assert.equal(normalizeRel('/leading/slash'), 'leading/slash');
  assert.equal(normalizeRel('../escape'), null);
  assert.equal(normalizeRel('a/../b'), null);
  assert.equal(normalizeRel('.siteslurp/meta.json'), null, 'the store is never addressable');
  assert.equal(normalizeRel('a//b'), null);
  assert.equal(normalizeRel(''), null);
});
