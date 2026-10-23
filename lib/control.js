// lib/control.js — the loopback control API: what the MCP server (and any
// local script the user trusts) talks to while the app is running.
//
// One http server on 127.0.0.1 at a random port, gated by a bearer token that
// changes every launch. {port, token} land in userData/control.json (0600
// where the OS honours modes) so a local client can find the door; nothing is
// ever bound beyond loopback and nothing works without the token. This module
// owns transport and routing only — every endpoint is a thin call into the
// managers main.js already has, so there is no second implementation of
// anything to drift.
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 1024 * 1024; // control payloads are labels and notes, not uploads

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
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

class ControlServer {
  /**
   * @param {{
   *   file: string,                       control.json path
   *   version: string,
   *   log: {info: Function, warn: Function},
   *   projects: object,                   the registry module
   *   reviews: object,                    the annotation store module
   *   calibration: object,                the calibration module
   *   versions: object,                   the snapshot engine
   *   hostedPort: (dir: string) => number|null,
   *   hostProject: (project: object) => Promise<{port: number, url: string}>,
   *   stopProject: (project: object) => boolean,
   *   exportProject: (project: object) => {folder: string, files: number},
   *   resolveAnnotation: (project, annotation, opts: {note?: string, afterRating?: number}) => object,
   *   reviewMarkdown: (project: object) => string,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.port = 0;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch(err => {
        try { send(res, 400, { error: err.message }); } catch { /* client went away */ }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    // Rewritten every launch: a stale file can only point at a dead port with a
    // dead token, and the MCP client turns that into one clear sentence.
    fs.writeFileSync(this.deps.file, JSON.stringify({
      app: 'Local Dev Studio',
      version: this.deps.version,
      pid: process.pid,
      port: this.port,
      token: this.token,
      startedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    this.deps.log.info('control api listening', '127.0.0.1:' + this.port);
    return this.port;
  }

  close() {
    if (this.server) {
      this.server.close();
      if (this.server.closeAllConnections) this.server.closeAllConnections();
      this.server = null;
    }
    // Best effort — a crash leaves the file behind, and that's fine: the token
    // inside died with the process.
    try { fs.rmSync(this.deps.file, { force: true }); } catch { /* locked file */ }
  }

  /** id or (unique) name → project. Throws a sentence the client can show. */
  project(ref) {
    const wanted = String(ref || '').trim();
    if (!wanted) throw new Error('Say which project — an id or a name from list_projects.');
    const all = this.deps.projects.all();
    const byId = all.find(p => p.id === wanted);
    if (byId) return byId;
    const byName = all.filter(p => p.name.toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Two projects are named "${wanted}" — use the id instead.`);
    throw new Error(`No project called "${wanted}". list_projects shows what exists.`);
  }

  /** Annotation ids are unique across stores; find which project owns one. */
  annotation(id) {
    const wanted = String(id || '').trim();
    for (const project of this.deps.projects.all()) {
      const found = this.deps.reviews.getAnnotation(project.id, wanted);
      if (found) return { project, annotation: found };
    }
    throw new Error(`No annotation with id "${wanted}".`);
  }

  projectSummary(project) {
    const port = this.deps.hostedPort(project.path);
    // The library section it's filed under, by name ("Client Websites"), so an
    // agent can be asked about a whole shelf. Null when unsorted.
    const sections = typeof this.deps.projects.sections === 'function' ? this.deps.projects.sections() : [];
    const section = sections.find(s => s.id === project.section);
    return {
      id: project.id,
      name: project.name,
      kind: project.kind,
      section: section ? section.name : null,
      path: project.path,
      port: port || null,
      hosted: !!port,
      url: port ? `http://localhost:${port}/` : null,
      openAnnotations: this.deps.reviews.listAnnotations(project.id).filter(a => !a.resolved).length,
    };
  }

  async route(req, res) {
    // Loopback-only by bind address; the token still has to match so another
    // local user (or a curious npm script) can't drive the app blind.
    if ((req.headers.authorization || '') !== `Bearer ${this.token}`) {
      send(res, 401, { error: 'Missing or wrong bearer token — read userData/control.json.' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const seg = url.pathname.split('/').filter(Boolean); // ['v1', ...]
    if (seg[0] !== 'v1') { send(res, 404, { error: 'Unknown endpoint.' }); return; }
    const deps = this.deps;

    if (req.method === 'GET') {
      switch (seg[1]) {
        case 'ping':
          send(res, 200, { ok: true, app: 'Local Dev Studio', version: deps.version });
          return;
        case 'projects':
          send(res, 200, { projects: deps.projects.all().map(p => this.projectSummary(p)) });
          return;
        case 'annotations': {
          if (seg[2]) {
            const { project, annotation } = this.annotation(seg[2]);
            send(res, 200, { annotation, project: { id: project.id, name: project.name } });
            return;
          }
          const project = this.project(url.searchParams.get('project'));
          const status = url.searchParams.get('status') || 'open';
          if (!['open', 'resolved', 'all'].includes(status)) {
            throw new Error('status must be open, resolved or all.');
          }
          const annotations = deps.reviews.listAnnotations(project.id).filter(a =>
            status === 'all' || (status === 'resolved' ? a.resolved : !a.resolved));
          send(res, 200, { project: { id: project.id, name: project.name }, annotations });
          return;
        }
        case 'calibration':
          send(res, 200, { calibration: deps.calibration.load(), markdown: deps.calibration.renderMarkdown() });
          return;
        case 'snapshots': {
          const project = this.project(url.searchParams.get('project'));
          const snapshots = deps.versions.listSnapshots(project)
            .map(({ id, label, source, timestamp, stats }) => ({ id, label, source, timestamp, stats }));
          send(res, 200, { snapshots });
          return;
        }
        case 'review': {
          const project = this.project(url.searchParams.get('project'));
          send(res, 200, { project: { id: project.id, name: project.name }, markdown: deps.reviewMarkdown(project) });
          return;
        }
        default:
          send(res, 404, { error: 'Unknown endpoint.' });
          return;
      }
    }

    if (req.method !== 'POST') { send(res, 405, { error: 'GET or POST only.' }); return; }
    const body = await readBody(req);

    if (seg[1] === 'annotations' && seg[2] && seg[3] === 'resolve') {
      const { project, annotation } = this.annotation(seg[2]);
      if (annotation.resolved) throw new Error('That annotation is already resolved.');
      const updated = await deps.resolveAnnotation(project, annotation, {
        note: body.note, afterRating: body.afterRating,
      });
      send(res, 200, { annotation: updated });
      return;
    }
    if (seg[1] === 'annotations' && seg[2] && seg[3] === 'update') {
      const { project, annotation } = this.annotation(seg[2]);
      const updated = deps.reviews.updateAnnotation(project.id, annotation.id, body.patch || {});
      send(res, 200, { annotation: updated });
      return;
    }
    switch (seg[1]) {
      case 'calibration': { // append a standing preference
        const added = deps.calibration.addStandingPreference(body.text);
        send(res, 200, { added });
        return;
      }
      case 'snapshots': {
        const project = this.project(body.project);
        const result = await deps.versions.createSnapshot(project, {
          label: String(body.label || ''), source: 'manual',
        });
        send(res, 200, result);
        return;
      }
      case 'export': {
        const project = this.project(body.project);
        send(res, 200, deps.exportProject(project));
        return;
      }
      case 'host': {
        const project = this.project(body.project);
        send(res, 200, await deps.hostProject(project));
        return;
      }
      case 'stop': {
        const project = this.project(body.project);
        send(res, 200, { stopped: deps.stopProject(project) });
        return;
      }
      default:
        send(res, 404, { error: 'Unknown endpoint.' });
    }
  }
}

module.exports = { ControlServer };
