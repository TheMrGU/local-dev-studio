// Unit tests for the verification loop's pure pixel math (lib/verify.js).
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// verify.js pulls in modules that ask Electron for app paths; stub it the
// same way scripts/test.js does before anything loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-verifytest-'));
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

const { diffBitmaps, CHANNEL_THRESHOLD } = require('../lib/verify');

/** A w×h BGRA buffer painted a single color. */
function bitmap(w, h, [b, g, r, a = 255]) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  }
  return buf;
}

test('identical bitmaps score 0', () => {
  const a = bitmap(4, 4, [10, 20, 30]);
  assert.equal(diffBitmaps(a, Buffer.from(a), 4, 4, 4, 4), 0);
});

test('one strongly-changed pixel scores 1/total', () => {
  const a = bitmap(4, 4, [10, 20, 30]);
  const b = Buffer.from(a);
  b[0] = 250; b[1] = 250; b[2] = 250; // pixel (0,0) goes near-white
  assert.equal(diffBitmaps(a, b, 4, 4, 4, 4), 1 / 16);
});

test('sub-threshold noise (antialiasing) scores 0', () => {
  const a = bitmap(3, 3, [100, 100, 100]);
  const b = bitmap(3, 3, [104, 104, 104]); // 12 summed — under the threshold
  assert.equal(diffBitmaps(a, b, 3, 3, 3, 3), 0);
  const c = bitmap(3, 3, [101 + CHANNEL_THRESHOLD, 100, 100]); // just over, every pixel
  assert.equal(diffBitmaps(a, c, 3, 3, 3, 3), 1);
});

test('alpha differences alone do not count', () => {
  const a = bitmap(2, 2, [50, 50, 50, 255]);
  const b = bitmap(2, 2, [50, 50, 50, 10]);
  assert.equal(diffBitmaps(a, b, 2, 2, 2, 2), 0);
});

test('a size change is itself a visual change', () => {
  // 2×1 vs 1×1 of the same color: the overlap matches, the extra pixel differs.
  const wide = bitmap(2, 1, [10, 20, 30]);
  const narrow = bitmap(1, 1, [10, 20, 30]);
  assert.equal(diffBitmaps(wide, narrow, 2, 1, 1, 1), 0.5);
  // Grown AND repainted: everything counts.
  const white = bitmap(1, 1, [255, 255, 255]);
  assert.equal(diffBitmaps(wide, white, 2, 1, 1, 1), 1);
});

test('empty bitmaps are fully different, not a crash', () => {
  assert.equal(diffBitmaps(Buffer.alloc(0), Buffer.alloc(0), 0, 0, 0, 0), 1);
  assert.equal(diffBitmaps(bitmap(1, 1, [0, 0, 0]), Buffer.alloc(0), 1, 1, 0, 0), 1);
});
