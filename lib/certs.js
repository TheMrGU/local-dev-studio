// lib/certs.js — [PRO] a tiny local certificate authority, hand-written on
// node:crypto. No dependency, no openssl.
//
// HTTPS locally needs exactly two artifacts: a CA certificate the user trusts
// once, and a leaf certificate for localhost / *.slurp.localhost signed by it.
// Node can generate keys and sign hashes but won't write X.509, so the ~hundred
// lines of DER encoding a certificate needs live here. It writes only what
// this feature needs — RSA-2048, SHA-256, v3 certs with basicConstraints,
// keyUsage, extKeyUsage and subjectAltName — and nothing else on purpose:
// this is a certificate writer for the site bench, not a PKI.
//
// *.slurp.localhost resolves to loopback in every modern browser (localhost
// names are special-cased per RFC 6761), so each project can have a stable
// https name with no hosts-file edits.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CA_NAME = 'SiteSlurp Local CA';
const CA_DAYS = 3650;   // the anchor: trust once, forget for years
const LEAF_DAYS = 730;  // under Apple's 825-day ceiling for locally trusted certs
const REISSUE_BEFORE_DAYS = 30;

/* ---------- DER primitives ---------- */

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
const SEQ = (...parts) => tlv(0x30, Buffer.concat(parts));
const SET = (...parts) => tlv(0x31, Buffer.concat(parts));
const derNull = () => Buffer.from([0x05, 0x00]);
const derBool = value => Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
const derOctet = buf => tlv(0x04, buf);
const derUtf8 = text => tlv(0x0c, Buffer.from(text, 'utf8'));
const context = (n, content) => tlv(0xa0 | n, content); // constructed [n]

/** INTEGER from a buffer of magnitude bytes (two's complement padding). */
function derInt(value) {
  if (typeof value === 'number') {
    if (value === 0) return Buffer.from([0x02, 0x01, 0x00]);
    const bytes = [];
    for (let v = value; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    if (bytes[0] & 0x80) bytes.unshift(0);
    return tlv(0x02, Buffer.from(bytes));
  }
  let buf = value;
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0 && !(buf[i + 1] & 0x80)) i++;
  buf = buf.subarray(i);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function derOid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let v = part;
    do { chunk.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let j = 0; j < chunk.length - 1; j++) chunk[j] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** BIT STRING wrapping whole bytes (signatures, SPKI reuse node's DER). */
const derBitString = buf => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));

/** UTCTime — fine until 2050, which outlives every cert written here. */
function derTime(date) {
  const pad = n => String(n).padStart(2, '0');
  const text = String(date.getUTCFullYear()).slice(2)
    + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
    + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

/* ---------- X.509 pieces ---------- */

const OID = {
  commonName: '2.5.4.3',
  sha256Rsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const algSha256Rsa = () => SEQ(derOid(OID.sha256Rsa), derNull());
const name = commonName => SEQ(SET(SEQ(derOid(OID.commonName), derUtf8(commonName))));

const extension = (oid, critical, valueDer) => SEQ(
  derOid(oid),
  ...(critical ? [derBool(true)] : []),
  derOctet(valueDer),
);

/** Named-bit KeyUsage BIT STRING: bits are MSB-first in one byte here. */
function keyUsageBits(bits) {
  let byte = 0;
  for (const bit of bits) byte |= 0x80 >> bit;
  let unused = 0;
  for (let b = byte; b && !(b & 1); b >>= 1) unused++;
  return tlv(0x03, Buffer.from([unused, byte]));
}
const KU_DIGITAL_SIGNATURE = 0;
const KU_KEY_ENCIPHERMENT = 2;
const KU_KEY_CERT_SIGN = 5;
const KU_CRL_SIGN = 6;

function ipBytes(ip) {
  if (ip.includes(':')) {
    // Enough IPv6 for loopback and friends: expand :: and hex groups.
    const [head, tail = ''] = ip.split('::');
    const parts = head.split(':').filter(Boolean);
    const end = tail.split(':').filter(Boolean);
    const groups = [...parts, ...Array(8 - parts.length - end.length).fill('0'), ...end];
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
    return out;
  }
  return Buffer.from(ip.split('.').map(Number));
}

function subjectAltName(dns, ips) {
  const names = [
    ...dns.map(host => tlv(0x82, Buffer.from(host, 'ascii'))),  // [2] dNSName
    ...ips.map(ip => tlv(0x87, ipBytes(ip))),                   // [7] iPAddress
  ];
  return SEQ(...names);
}

/**
 * Build and sign one certificate.
 * @param {{
 *   subjectCN: string, issuerCN: string,
 *   publicKeyPem: string|object, signWithKeyPem: string|object,
 *   days: number, isCa: boolean, dns?: string[], ips?: string[],
 * }} opts
 * @returns {string} PEM certificate
 */
function makeCert({ subjectCN, issuerCN, publicKeyPem, signWithKeyPem, days, isCa, dns = [], ips = [] }) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000); // clock-skew slack
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const extensions = [
    extension(OID.basicConstraints, true, isCa ? SEQ(derBool(true)) : SEQ()),
    extension(OID.keyUsage, true, isCa
      ? keyUsageBits([KU_KEY_CERT_SIGN, KU_CRL_SIGN])
      : keyUsageBits([KU_DIGITAL_SIGNATURE, KU_KEY_ENCIPHERMENT])),
    ...(isCa ? [] : [
      extension(OID.extKeyUsage, false, SEQ(derOid(OID.serverAuth))),
      extension(OID.subjectAltName, false, subjectAltName(dns, ips)),
    ]),
  ];

  const tbs = SEQ(
    context(0, derInt(2)),                       // version: v3
    derInt(crypto.randomBytes(9)),               // serial: random, positive after trim
    algSha256Rsa(),
    name(issuerCN),
    SEQ(derTime(notBefore), derTime(notAfter)),
    name(subjectCN),
    spki,
    context(3, SEQ(...extensions)),
  );

  const signature = crypto.createSign('sha256').update(tbs).sign(signWithKeyPem);
  const cert = SEQ(tbs, algSha256Rsa(), derBitString(signature));
  return pem('CERTIFICATE', cert);
}

function pem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function makeKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/* ---------- the local CA on disk ---------- */

/** Days until a PEM certificate expires (negative = already expired). */
function daysLeft(certPem) {
  const parsed = new crypto.X509Certificate(certPem);
  return (new Date(parsed.validTo).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

/**
 * The CA + leaf pair for local https, created on first use in `dir` and
 * reused for every project (the leaf is a wildcard for *.slurp.localhost).
 * Atomic-enough: key first, cert after — a torn write regenerates both.
 * @returns {{key:string, cert:string, ca:string, caPath:string, created:boolean}}
 */
function ensureLocalTls(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = base => path.join(dir, base);
  const read = base => { try { return fs.readFileSync(file(base), 'utf8'); } catch { return null; } };

  let caKey = read('ca.key');
  let caCert = read('ca.crt');
  let created = false;
  const caUsable = (() => {
    try { return caKey && caCert && daysLeft(caCert) > REISSUE_BEFORE_DAYS; } catch { return false; }
  })();
  if (!caUsable) {
    const pair = makeKeyPair();
    caKey = pair.privateKey;
    caCert = makeCert({
      subjectCN: CA_NAME, issuerCN: CA_NAME,
      publicKeyPem: pair.publicKey, signWithKeyPem: caKey,
      days: CA_DAYS, isCa: true,
    });
    fs.writeFileSync(file('ca.key'), caKey);
    fs.writeFileSync(file('ca.crt'), caCert);
    // A new CA orphans any old leaf — force a reissue below.
    fs.rmSync(file('local.crt'), { force: true });
    created = true;
  }

  let key = read('local.key');
  let cert = read('local.crt');
  const leafUsable = (() => {
    try { return key && cert && daysLeft(cert) > REISSUE_BEFORE_DAYS; } catch { return false; }
  })();
  if (!leafUsable) {
    const pair = makeKeyPair();
    key = pair.privateKey;
    cert = makeCert({
      subjectCN: 'localhost', issuerCN: CA_NAME,
      publicKeyPem: pair.publicKey, signWithKeyPem: caKey,
      days: LEAF_DAYS, isCa: false,
      dns: ['localhost', '*.slurp.localhost', 'slurp.localhost'],
      ips: ['127.0.0.1', '::1'],
    });
    fs.writeFileSync(file('local.key'), key);
    fs.writeFileSync(file('local.crt'), cert);
  }

  return { key, cert, ca: caCert, caPath: file('ca.crt'), created };
}

/** A project name as a *.slurp.localhost label: lowercase, dash-separated,
 *  never empty. "Acme Site (v2)" → acme-site-v2.slurp.localhost. */
function hostSlug(projectName) {
  const slug = String(projectName || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'site';
}

module.exports = {
  ensureLocalTls, hostSlug, makeCert, makeKeyPair, daysLeft, pem,
  CA_NAME,
  // DER pieces exported for the unit tests only
  derInt, derOid, derLen,
};
