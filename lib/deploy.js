// lib/deploy.js — [PRO] "Publish…": push a site's files to a real host.
//
// The shape is an adapter table so more providers can slot in later; Netlify
// goes first because its ZIP deploy API is the simplest thing that works —
// POST an archive, poll until the CDN says ready. The ZIP comes from
// lib/zip.js: the working tree zips like an export, a snapshot zips straight
// from its manifest's blobs, which makes any historical version deployable
// byte-for-byte.
//
// This module is deliberately Electron-free and network-injectable: `transport`
// defaults to a small https wrapper and the tests hand in a fake.
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const NETLIFY_HOST = 'api.netlify.com';
const POLL_MS = 2000;
const READY_TIMEOUT_MS = 5 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One JSON-or-ZIP request to a provider API. */
function apiRequest({ method, host, path: reqPath, token, body = null, type = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null
      : Buffer.isBuffer(body) ? body
        : Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      method,
      host,
      path: reqPath,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SiteSlurp-Studio',
        ...(payload ? { 'Content-Type': type, 'Content-Length': payload.length } : {}),
      },
      timeout: 120000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON — kept as text */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('The request to the deploy service timed out.')); });
    req.on('error', err => reject(new Error(
      err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
        ? 'Could not reach the deploy service — are you online?'
        : err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Provider errors as sentences a toast can show. */
function friendly(provider, res, doing) {
  const detail = res.json && (res.json.message || (res.json.errors && JSON.stringify(res.json.errors)));
  if (res.status === 401) {
    return `${provider} rejected the token — paste a fresh personal access token in the Publish window.`;
  }
  if (res.status === 404) {
    return `${provider} says that site no longer exists — unlink it in the Publish window and publish again.`;
  }
  if (res.status === 429) {
    return `${provider} is rate limiting this account — wait a minute and try again.`;
  }
  return `${provider} refused while ${doing} (HTTP ${res.status})${detail ? ` — ${detail}` : ''}.`;
}

const ADAPTERS = {
  netlify: {
    id: 'netlify',
    label: 'Netlify',
    tokenHint: 'Create a personal access token at app.netlify.com → User settings → Applications → Personal access tokens.',
    /**
     * Deploy a ZIP. Creates the site on first publish; later publishes update it.
     * @param {{zipPath:string, token:string, siteId?:string|null,
     *          onProgress?:(msg:string)=>void, transport?:Function,
     *          pollMs?:number, timeoutMs?:number}} opts
     * @returns {Promise<{siteId:string, url:string, deployId:string}>}
     */
    async deploy({ zipPath, token, siteId = null, name = null, onProgress = () => {},
      transport = apiRequest, pollMs = POLL_MS, timeoutMs = READY_TIMEOUT_MS }) {
      if (!token) throw new Error('Publishing needs a Netlify personal access token — paste one in the Share window.');

      if (!siteId) {
        onProgress('Creating the Netlify site…');
        // A readable address when one is offered (<slug>-<hex>.netlify.app).
        // Site names are global on Netlify, so a taken or refused name falls
        // back to whatever Netlify picks rather than failing the share.
        const create = body => transport({ method: 'POST', host: NETLIFY_HOST, path: '/api/v1/sites', token, body });
        let made = await create(name ? { name } : {});
        if (name && made.status === 422) made = await create({});
        if (made.status !== 200 && made.status !== 201) {
          throw new Error(friendly('Netlify', made, 'creating the site'));
        }
        siteId = made.json.id;
      }

      onProgress('Uploading the site…');
      const zip = fs.readFileSync(zipPath);
      const started = await transport({
        method: 'POST', host: NETLIFY_HOST,
        path: `/api/v1/sites/${encodeURIComponent(siteId)}/deploys`,
        token, body: zip, type: 'application/zip',
      });
      if (started.status !== 200 && started.status !== 201) {
        throw new Error(friendly('Netlify', started, 'uploading the archive'));
      }

      // The upload answer usually says "uploaded" or "processing"; the CDN
      // flips it to "ready" moments later. Poll gently until it does.
      let deploy = started.json;
      const deadline = Date.now() + timeoutMs;
      while (deploy.state !== 'ready') {
        if (deploy.state === 'error') {
          throw new Error('Netlify could not process the deploy'
            + (deploy.error_message ? ` — ${deploy.error_message}` : '') + '.');
        }
        if (Date.now() > deadline) {
          throw new Error('Netlify is still processing after several minutes — check the site dashboard; the upload itself succeeded.');
        }
        onProgress(`Netlify is processing — ${deploy.state || 'working'}…`);
        await sleep(pollMs);
        const polled = await transport({
          method: 'GET', host: NETLIFY_HOST,
          path: `/api/v1/deploys/${encodeURIComponent(deploy.id)}`, token,
        });
        if (polled.status !== 200) throw new Error(friendly('Netlify', polled, 'checking the deploy'));
        deploy = polled.json;
      }

      return {
        siteId,
        deployId: deploy.id,
        url: deploy.ssl_url || deploy.url || `https://app.netlify.com/sites/${siteId}`,
      };
    },
    /**
     * Take a site down for good: the address stops answering and the site
     * leaves the account. A site Netlify no longer knows counts as gone —
     * the point is that the link is dead, and it is.
     * @param {{siteId:string, token:string, transport?:Function}} opts
     * @returns {Promise<{gone:true}>}
     */
    async remove({ siteId, token, transport = apiRequest }) {
      if (!token) throw new Error('Taking the site down needs the Netlify personal access token — paste one in the Share window.');
      if (!siteId) return { gone: true };
      const res = await transport({
        method: 'DELETE', host: NETLIFY_HOST, path: `/api/v1/sites/${encodeURIComponent(siteId)}`, token,
      });
      if (res.status === 200 || res.status === 204 || res.status === 404) return { gone: true };
      throw new Error(friendly('Netlify', res, 'taking the site down'));
    },
  },
};

/** A subdomain-safe name from a project name — lowercase, dashes, a short
 *  random tail so two "portfolio" projects never fight over one address.
 *  Nothing usable in the name means no name: the provider picks. */
function siteNameFor(label) {
  const slug = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!slug) return null;
  return `${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

function adapterFor(provider) {
  const adapter = ADAPTERS[String(provider || '').toLowerCase()];
  if (!adapter) throw new Error(`No deploy adapter for "${provider}".`);
  return adapter;
}

const listAdapters = () => Object.values(ADAPTERS).map(({ id, label, tokenHint }) => ({ id, label, tokenHint }));

/** The two entry points main.js calls: put a site up, take a site down. */
function runDeploy({ provider, ...opts }) {
  return adapterFor(provider).deploy(opts);
}
function runRemove({ provider, ...opts }) {
  return adapterFor(provider).remove(opts);
}

module.exports = { adapterFor, listAdapters, runDeploy, runRemove, siteNameFor, apiRequest };
