// Unit tests for the deploy adapters (lib/deploy.js) against a fake transport
// — the real Netlify API is deliberately never touched here.
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { adapterFor, listAdapters, runDeploy, runRemove, siteNameFor } = require('../lib/deploy');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-deploytest-'));
const zipPath = path.join(TMP, 'site.zip');
fs.writeFileSync(zipPath, Buffer.from('PK\x05\x06' + '\x00'.repeat(18), 'latin1'));

test('the adapter table knows netlify and refuses strangers', () => {
  assert.equal(adapterFor('netlify').label, 'Netlify');
  assert.equal(adapterFor('NETLIFY').id, 'netlify');
  assert.throws(() => adapterFor('geocities'), /No deploy adapter/);
  assert.deepEqual(listAdapters().map(a => a.id), ['netlify']);
});

test('first publish: creates the site, uploads the zip, polls to ready', async () => {
  const calls = [];
  const transport = async req => {
    calls.push({ method: req.method, path: req.path, type: req.type, isZip: Buffer.isBuffer(req.body) });
    if (req.path === '/api/v1/sites') return { status: 201, json: { id: 'site_1', ssl_url: 'https://x.netlify.app' } };
    if (req.path === '/api/v1/sites/site_1/deploys') return { status: 200, json: { id: 'dep_1', state: 'uploaded' } };
    if (req.path === '/api/v1/deploys/dep_1') {
      return calls.filter(c => c.path === '/api/v1/deploys/dep_1').length < 2
        ? { status: 200, json: { id: 'dep_1', state: 'processing' } }
        : { status: 200, json: { id: 'dep_1', state: 'ready', ssl_url: 'https://fancy-site.netlify.app' } };
    }
    throw new Error('unexpected call ' + req.path);
  };
  const progress = [];
  const result = await runDeploy({
    provider: 'netlify', zipPath, token: 'tok', siteId: null,
    onProgress: msg => progress.push(msg), transport, pollMs: 1,
  });
  assert.equal(result.siteId, 'site_1');
  assert.equal(result.url, 'https://fancy-site.netlify.app');
  assert.equal(calls[0].path, '/api/v1/sites', 'site created first');
  const upload = calls.find(c => c.path === '/api/v1/sites/site_1/deploys');
  assert.equal(upload.type, 'application/zip');
  assert.ok(upload.isZip, 'the archive bytes travel as the body');
  assert.ok(progress.some(m => /Uploading/.test(m)));
});

test('a linked site skips creation and updates in place', async () => {
  const calls = [];
  const transport = async req => {
    calls.push(req.path);
    if (req.path === '/api/v1/sites/site_9/deploys') {
      return { status: 200, json: { id: 'dep_2', state: 'ready', ssl_url: 'https://linked.netlify.app' } };
    }
    throw new Error('unexpected call ' + req.path);
  };
  const result = await runDeploy({ provider: 'netlify', zipPath, token: 'tok', siteId: 'site_9', transport, pollMs: 1 });
  assert.equal(result.siteId, 'site_9');
  assert.ok(!calls.includes('/api/v1/sites'), 'no site creation');
});

test('a bad token turns into a sentence about the token', async () => {
  const transport = async () => ({ status: 401, json: { message: 'Unauthorized' } });
  await assert.rejects(
    () => runDeploy({ provider: 'netlify', zipPath, token: 'expired', transport, pollMs: 1 }),
    /rejected the token/);
});

test('a deploy that errors on the CDN side reports Netlify\'s reason', async () => {
  const transport = async req => {
    if (req.path === '/api/v1/sites/site_9/deploys') {
      return { status: 200, json: { id: 'dep_3', state: 'error', error_message: 'invalid zip' } };
    }
    throw new Error('unexpected ' + req.path);
  };
  await assert.rejects(
    () => runDeploy({ provider: 'netlify', zipPath, token: 't', siteId: 'site_9', transport, pollMs: 1 }),
    /invalid zip/);
});

test('a missing token fails before any network call', async () => {
  const transport = async () => { throw new Error('must not be called'); };
  await assert.rejects(
    () => runDeploy({ provider: 'netlify', zipPath, token: '', transport }),
    /access token/);
});

test('a fresh site is asked for by name, and a taken name falls back to Netlify\'s pick', async () => {
  const bodies = [];
  const transport = async req => {
    if (req.path === '/api/v1/sites') {
      bodies.push(req.body);
      return bodies.length === 1
        ? { status: 422, json: { errors: { subdomain: ['must be unique'] } } }
        : { status: 201, json: { id: 'site_n' } };
    }
    if (req.path === '/api/v1/sites/site_n/deploys') {
      return { status: 200, json: { id: 'dep_n', state: 'ready', ssl_url: 'https://random-words.netlify.app' } };
    }
    throw new Error('unexpected call ' + req.path);
  };
  const result = await runDeploy({ provider: 'netlify', zipPath, token: 'tok', name: 'my-site-ab12', transport, pollMs: 1 });
  assert.deepEqual(bodies, [{ name: 'my-site-ab12' }, {}], 'named first, nameless on refusal');
  assert.equal(result.siteId, 'site_n');
  assert.equal(result.url, 'https://random-words.netlify.app');
});

test('siteNameFor makes a subdomain-safe slug with a random tail, or nothing', () => {
  assert.match(siteNameFor('Zentrix Media — Portfolio!'), /^zentrix-media-portfolio-[0-9a-f]{4}$/);
  assert.equal(siteNameFor('!!!'), null);
  assert.equal(siteNameFor(''), null);
  assert.ok(siteNameFor('x'.repeat(80)).length <= 45, 'long names are cut before the tail');
});

test('taking a site down deletes it, and an already-gone site counts as down', async () => {
  const calls = [];
  const transport = async req => { calls.push(`${req.method} ${req.path}`); return { status: 204, json: null }; };
  assert.deepEqual(await runRemove({ provider: 'netlify', siteId: 'site_9', token: 'tok', transport }), { gone: true });
  assert.deepEqual(calls, ['DELETE /api/v1/sites/site_9']);
  const gone = async () => ({ status: 404, json: { message: 'Not Found' } });
  assert.deepEqual(await runRemove({ provider: 'netlify', siteId: 'site_9', token: 'tok', transport: gone }), { gone: true });
});

test('taking a site down with a bad token says so; with no token it never calls out', async () => {
  const transport = async () => ({ status: 401, json: { message: 'Unauthorized' } });
  await assert.rejects(
    () => runRemove({ provider: 'netlify', siteId: 'site_9', token: 'expired', transport }),
    /rejected the token/);
  const never = async () => { throw new Error('must not be called'); };
  await assert.rejects(
    () => runRemove({ provider: 'netlify', siteId: 'site_9', token: '', transport: never }),
    /access token/);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* locked on win */ } });
