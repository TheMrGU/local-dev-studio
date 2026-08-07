// Unit tests for the pure pieces of guest review (lib/guest.js): the token
// bucket, the hourly cap, cookie/param parsing and the capability stripping.
// The full HTTP flow (token in the URL → cookie → annotate over a "tunnel")
// lives in scripts/test.js where a real server runs.
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// guest.js reaches reviews.js, which asks Electron for app paths; stub it the
// same way scripts/test.js does before anything loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-guesttest-'));
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

const { TokenBucket, HourlyCap, guestParam, guestCookie, stripAnnotation, GuestManager } = require('../lib/guest');

test('token bucket: burst up to capacity, then refills over time', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_000_000;
  assert.ok(bucket.take('ip', t0));
  assert.ok(bucket.take('ip', t0));
  assert.ok(bucket.take('ip', t0));
  assert.ok(!bucket.take('ip', t0), 'burst exhausted');
  assert.ok(!bucket.take('ip', t0 + 500), 'half a token is not a token');
  assert.ok(bucket.take('ip', t0 + 1100), 'refilled after a second');
  assert.ok(bucket.take('other', t0), 'each key has its own bucket');
});

test('token bucket never refills past capacity', () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1000 });
  const t0 = 5_000_000;
  bucket.take('k', t0);
  assert.ok(bucket.take('k', t0 + 60_000));
  assert.ok(bucket.take('k', t0 + 60_000));
  assert.ok(!bucket.take('k', t0 + 60_000), 'an hour away still caps at 2');
});

test('hourly cap: fixed window per key', () => {
  const cap = new HourlyCap({ limit: 2, windowMs: 1000 });
  const t0 = 42_000;
  assert.ok(cap.take('ip', t0));
  assert.ok(cap.take('ip', t0 + 10));
  assert.ok(!cap.take('ip', t0 + 20), 'limit reached');
  assert.ok(cap.take('ip', t0 + 1001), 'a new window starts fresh');
  assert.ok(cap.take('ip2', t0), 'keys are independent');
});

test('guestParam only accepts token-shaped values', () => {
  const token = 'a'.repeat(32);
  assert.equal(guestParam(`/?review=${token}`), token);
  assert.equal(guestParam(`/page?x=1&review=${token}&y=2`), token);
  assert.equal(guestParam('/?review=<script>'), '', 'junk is a present-but-invalid param');
  assert.equal(guestParam('/?review='), '');
  assert.equal(guestParam('/plain'), null, 'absent means absent');
  assert.equal(guestParam('/?other=1'), null);
});

test('guestCookie reads only well-formed tokens', () => {
  const token = 'f'.repeat(32);
  assert.equal(guestCookie({ headers: { cookie: `__ss_guest=${token}` } }), token);
  assert.equal(guestCookie({ headers: { cookie: `a=b; __ss_guest=${token}; c=d` } }), token);
  assert.equal(guestCookie({ headers: { cookie: '__ss_guest=nope!' } }), null);
  assert.equal(guestCookie({ headers: {} }), null);
});

test('stripAnnotation withholds everything a guest has no business seeing', () => {
  const full = {
    id: 'ann_1', reviewId: 'rev_1', scope: 'element', createdAt: 'now', resolved: false,
    author: 'Dana',
    context: {
      selector: '.hero', selectorFallback: 'body > div', pageUrl: '/', boundingBox: { x: 1, y: 2, w: 3, h: 4 },
      sourceFile: 'html/index.html', sourceLine: 12, outerHTML: '<div>secret</div>',
      computedStyles: { color: 'red' }, consoleTail: ['Error: internal'],
      screenshotElement: 'shots/x.png', referenceImage: 'shots/r.png',
    },
    input: { rating: 4, severity: 'should-fix', axes: ['layout'], why: 'w', want: 'x',
      referenceProjectId: 'prj_9', referenceHTML: '<b>ref</b>' },
  };
  const stripped = stripAnnotation(full);
  assert.deepEqual(Object.keys(stripped.context).sort(), ['boundingBox', 'pageUrl', 'selector', 'selectorFallback']);
  assert.deepEqual(Object.keys(stripped.input).sort(), ['axes', 'rating', 'severity', 'want', 'why']);
  assert.equal(stripped.author, 'Dana');
  assert.ok(!JSON.stringify(stripped).includes('secret'), 'no markup leaks');
  assert.ok(!JSON.stringify(stripped).includes('sourceFile'), 'no file paths leak');
  assert.ok(!JSON.stringify(stripped).includes('consoleTail'), 'no console leaks');
});

test('the manager mints per-share tokens and forgets them on disable', () => {
  const manager = new GuestManager({
    projects: { byPath: () => null },
    reviews: {},
    overlayScript: () => '',
    latestVersionId: () => null,
  });
  const dir = 'C:/some/site';
  assert.equal(manager.forDir(dir), null, 'no share, no router');
  const { token } = manager.enable(dir, { version: 'v1' });
  assert.match(token, /^[a-f0-9]{32}$/);
  const router = manager.forDir(dir);
  assert.ok(router.tokenValid(token));
  assert.ok(!router.tokenValid('deadbeef'.repeat(4)));
  assert.deepEqual(manager.stateFor(dir), { token, version: 'v1' });
  const again = manager.enable(dir).token;
  assert.notEqual(again, token, 're-sharing rotates the token');
  manager.disable(dir);
  assert.equal(manager.forDir(dir), null);
  assert.equal(manager.stateFor(dir), null);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* locked on win */ } });
