// Unit tests for the pure Phase-3a helpers: the attach-target parser (the
// loopback guard that keeps attach from becoming an open proxy) and the
// minimal upstream-CSP rewrite that lets the same-origin overlay run.
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAttachTarget } = require('../lib/runtimes');
const { adjustCsp } = require('../lib/proxy');

test('attach targets: every loopback spelling resolves to its port', () => {
  assert.equal(parseAttachTarget('3000'), 3000);
  assert.equal(parseAttachTarget(' 3000 '), 3000);
  assert.equal(parseAttachTarget(':5173'), 5173);
  assert.equal(parseAttachTarget('localhost:3000'), 3000);
  assert.equal(parseAttachTarget('LOCALHOST:3000'), 3000);
  assert.equal(parseAttachTarget('127.0.0.1:8000'), 8000);
  assert.equal(parseAttachTarget('[::1]:4321'), 4321);
  assert.equal(parseAttachTarget('http://localhost:5173/some/page'), 5173);
  assert.equal(parseAttachTarget('http://127.0.0.1:3000'), 3000);
});

test('attach targets: anything not-this-machine is refused with a sentence', () => {
  for (const bad of [
    '192.168.1.20:3000', '10.0.0.5:80', 'evil.example:443',
    'http://192.168.1.20:3000', 'http://evil.example/', 'http://0.0.0.0:3000',
    'ftp://localhost:21', 'file:///etc/passwd',
    '', '   ', 'not a port', 'localhost:0', 'localhost:99999', 'localhost:-1',
  ]) {
    assert.throws(() => parseAttachTarget(bad), /refused|port|address|http/i, bad);
  }
});

test('csp: permissive policies are never touched', () => {
  for (const policy of [
    "default-src 'self'",
    "script-src 'self'; connect-src 'self'",
    "script-src * ; style-src 'none'",
    "default-src https: ; img-src 'none'",
    '',
  ]) {
    assert.deepEqual(adjustCsp(policy).changed, [], policy);
  }
});

test('csp: a blocking script-src gains self and only self', () => {
  const result = adjustCsp("script-src 'nonce-x' 'strict-dynamic'; img-src 'none'");
  assert.deepEqual(result.changed, ['script-src']);
  assert.match(result.value, /script-src 'nonce-x' 'strict-dynamic' 'self'/);
  assert.match(result.value, /img-src 'none'/, 'unrelated directives untouched');
});

test("csp: 'none' is replaced, not joined", () => {
  const result = adjustCsp("script-src 'none'; connect-src 'none'");
  assert.deepEqual(result.changed, ['script-src', 'connect-src']);
  assert.equal(result.value.includes("'none'"), false);
});

test('csp: default-src fallback adds specific directives instead of widening it', () => {
  const result = adjustCsp("default-src 'nonce-abc'");
  assert.deepEqual(result.changed.sort(), ['connect-src', 'script-src']);
  assert.match(result.value, /^default-src 'nonce-abc'/);
  assert.match(result.value, /script-src 'nonce-abc' 'self'/);
  assert.match(result.value, /connect-src 'nonce-abc' 'self'/);
});

test('csp: script-src-elem governs element loads when present', () => {
  const both = adjustCsp("script-src 'nonce-a'; script-src-elem 'self'");
  assert.deepEqual(both.changed, [], 'elem already allows the overlay tag');
  const blocked = adjustCsp("script-src 'self'; script-src-elem 'nonce-a'");
  assert.deepEqual(blocked.changed, ['script-src-elem']);
});
