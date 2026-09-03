// lib/menu.js — the HTTP side of the in-page SiteSlurp menu.
//
// Every locally hosted page gets renderer/slurp-menu.js injected at serve
// time (never through a share link). The menu is where the in-page tools live
// as toggles — the asset dragger, and audit mode, which used to need a second
// button in Studio and now switches on from the page itself. This module
// serves the client and its logo, and routes the audit on/off calls; main.js
// supplies the callbacks that actually flip review mode.
const fs = require('fs');
const { PREFIX: LR_PREFIX } = require('./livereload');

const PREFIX = LR_PREFIX + 'menu/';

/** Same stance as the review and grab APIs: same-origin fetches carry no
 *  Origin header (GET) or a matching one (POST); anything else is refused. */
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host || '';
  return origin !== `http://${host}` && origin !== `http://localhost:${host.split(':')[1]}`;
}

const send = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

class MenuManager {
  /**
   * @param {{
   *   clientPath: string, logoPath: string,
   *   siteFor: (dir: string) => {name: string, auditAvailable: boolean, auditActive: boolean, reason?: string},
   *   auditStart: (dir: string) => void|Promise<void>,
   *   auditStop: (dir: string) => boolean,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.clientCache = null;
    this.logoCache = null;
  }

  clientScript() {
    if (!this.clientCache) this.clientCache = fs.readFileSync(this.deps.clientPath, 'utf8');
    return this.clientCache;
  }

  logo() {
    if (!this.logoCache) this.logoCache = fs.readFileSync(this.deps.logoPath);
    return this.logoCache;
  }

  /** Router hook for HostManager. */
  forDir(dir) {
    return { handleRequest: (req, res, urlPath) => this.route(dir, req, res, urlPath) };
  }

  async route(dir, req, res, urlPath) {
    const route = urlPath.slice(PREFIX.length);
    try {
      if (foreignOrigin(req)) { send(res, 403, { error: 'Cross-origin request refused.' }); return; }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === 'client.js') {
          const site = this.deps.siteFor(dir);
          const cfg = {
            api: PREFIX,
            name: site.name,
            audit: { active: site.auditActive, available: site.auditAvailable, reason: site.reason || null },
          };
          const body = `self.__SLURP_MENU__ = ${JSON.stringify(cfg)};\n` + this.clientScript();
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
        if (route === 'logo.png') {
          const body = this.logo();
          // The logo never changes within a session — spare every page load a refetch.
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600', 'Content-Length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
        if (route === 'state') {
          const site = this.deps.siteFor(dir);
          send(res, 200, { name: site.name, audit: { active: site.auditActive, available: site.auditAvailable } });
          return;
        }
        send(res, 404, { error: 'Unknown menu endpoint.' });
        return;
      }

      if (req.method !== 'POST') { send(res, 405, { error: 'GET or POST only.' }); return; }

      if (route === 'audit/start') {
        await this.deps.auditStart(dir);
        send(res, 200, { ok: true });
        return;
      }
      if (route === 'audit/stop') {
        send(res, 200, { ok: true, stopped: this.deps.auditStop(dir) });
        return;
      }
      send(res, 404, { error: 'Unknown menu endpoint.' });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }
}

module.exports = { MenuManager, PREFIX };
