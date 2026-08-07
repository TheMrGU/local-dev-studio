// Unit tests for the hand-written X.509 mini-CA (lib/certs.js). The proof is
// a real TLS handshake: node's own chain validation and SAN matching accept
// what this module writes, or these tests fail.
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const { ensureLocalTls, hostSlug, makeCert, makeKeyPair, daysLeft, CA_NAME } = require('../lib/certs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siteslurp-certs-'));

test('ensureLocalTls mints a CA and a leaf that node itself validates', () => {
  const material = ensureLocalTls(path.join(TMP, 'tls'));
  assert.ok(material.created, 'first call creates the CA');

  const leaf = new crypto.X509Certificate(material.cert);
  const ca = new crypto.X509Certificate(material.ca);
  assert.ok(leaf.verify(ca.publicKey), 'leaf signature checks out against the CA key');
  assert.match(ca.subject, new RegExp(CA_NAME));
  assert.equal(leaf.checkIssued(ca), true, 'the CA issued the leaf');
  assert.ok(ca.ca, 'basicConstraints marks the CA as a CA');
  assert.match(leaf.subjectAltName, /\*\.slurp\.localhost/);
  assert.match(leaf.subjectAltName, /DNS:localhost/);
  assert.match(leaf.subjectAltName, /127\.0\.0\.1/);
  assert.ok(daysLeft(material.cert) > 300, 'leaf has real validity left');
  assert.ok(daysLeft(material.ca) > 3000, 'CA lasts years');
});

test('the second call reuses what is on disk', () => {
  const dir = path.join(TMP, 'tls');
  const first = ensureLocalTls(dir);
  const again = ensureLocalTls(dir);
  assert.equal(again.created, false);
  assert.equal(again.cert, first.cert, 'same leaf bytes');
  assert.equal(again.ca, first.ca, 'same CA bytes');
});

test('an https server with the leaf passes a strict client handshake, wildcard included', async () => {
  const material = ensureLocalTls(path.join(TMP, 'tls'));
  const server = https.createServer({ key: material.key, cert: material.cert },
    (req, res) => res.end('over tls'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const fetchAs = servername => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, ca: material.ca, servername }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    assert.equal(await fetchAs('localhost'), 'over tls');
    assert.equal(await fetchAs('my-project.slurp.localhost'), 'over tls', 'wildcard SAN matches');
    await assert.rejects(() => fetchAs('evil.example.com'), /altnames|Hostname\/IP/i,
      'a name outside the SANs is refused by the client');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('a certificate signed by a different CA is rejected by the trust check', () => {
  const rogue = makeKeyPair();
  const rogueCert = makeCert({
    subjectCN: 'localhost', issuerCN: CA_NAME, // even claiming the same name
    publicKeyPem: rogue.publicKey, signWithKeyPem: rogue.privateKey,
    days: 30, isCa: false, dns: ['localhost'], ips: [],
  });
  const material = ensureLocalTls(path.join(TMP, 'tls'));
  const ca = new crypto.X509Certificate(material.ca);
  const fake = new crypto.X509Certificate(rogueCert);
  assert.equal(fake.verify(ca.publicKey), false, 'signature does not verify');
});

test('tls.checkServerIdentity agrees with the SAN list', () => {
  const material = ensureLocalTls(path.join(TMP, 'tls'));
  const leaf = new crypto.X509Certificate(material.cert);
  const cert = { subject: { CN: 'localhost' }, subjectaltname: leaf.subjectAltName };
  assert.equal(tls.checkServerIdentity('anything.slurp.localhost', cert), undefined);
  assert.ok(tls.checkServerIdentity('deep.sub.slurp.localhost', cert),
    'wildcards cover one label only');
});

test('hostSlug writes browser-safe labels', () => {
  assert.equal(hostSlug('Acme Site (v2)'), 'acme-site-v2');
  assert.equal(hostSlug('  --Weird__NAME!!  '), 'weird-name');
  assert.equal(hostSlug(''), 'site');
  assert.equal(hostSlug('ÜBER'), 'ber', 'non-ascii collapses rather than leaks');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* locked on win */ } });
