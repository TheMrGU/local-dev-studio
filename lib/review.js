// lib/review.js — the HTTP API behind Review Mode.
//
// The overlay runs inside the user's browser on the site's own origin, so it
// talks to the app over same-origin HTTP — no CORS, no websocket, no bridge.
// This module routes /__siteslurp__/review/* for every folder currently in
// review mode. It owns no policy: validation lives in reviews.js, rendering
// in reviewExport.js; main.js supplies the few Electron-touching callbacks.
const fs = require('fs');
const path = require('path');
const { PREFIX } = require('./livereload');
const reviewsStore = require('./reviews');

const API = PREFIX + 'review/';
const MAX_BODY = 2 * 1024 * 1024;

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

// A random web page must not be able to poke this API from the user's browser.
// Same-origin fetches carry no Origin header (GET) or a matching one (POST);
// anything cross-origin announces itself and is refused.
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host || '';
  return origin !== `http://${host}` && origin !== `http://localhost:${host.split(':')[1]}`;
}

class ReviewManager {
  /**
   * @param {{
   *   projects: object, capturesRoot: () => string,
   *   exportReview: Function,
   *   overlayPath: string,
   *   onAnnotationSaved?: Function, onExported?: Function, onReveal?: Function,
   *   onReferenceHost?: Function, onDone?: Function,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.active = new Map(); // dir -> { projectId, pick: {annotationId, forProjectId}|null, lastExport: string|null }
    this.overlayCache = null;
  }

  enable(dir, projectId, { pick = null } = {}) {
    this.active.set(path.resolve(dir), { projectId, pick, lastExport: null });
  }

  disable(dir) { return this.active.delete(path.resolve(dir)); }
  isActive(dir) { return this.active.has(path.resolve(dir)); }

  /** Router hook for HostManager: non-null only while dir is in review mode. */
  forDir(dir) {
    const session = this.active.get(path.resolve(dir));
    if (!session) return null;
    return { handleRequest: (req, res, urlPath) => this.route(session, dir, req, res, urlPath) };
  }

  overlayScript() {
    if (!this.overlayCache) this.overlayCache = fs.readFileSync(this.deps.overlayPath, 'utf8');
    return this.overlayCache;
  }

  async route(session, dir, req, res, urlPath) {
    const route = urlPath.slice(API.length);
    try {
      if (foreignOrigin(req)) { send(res, 403, { error: 'Cross-origin request refused.' }); return; }
      const project = this.deps.projects.byId(session.projectId);
      if (!project) { send(res, 410, { error: 'This project no longer exists.' }); return; }

      if (req.method === 'GET') {
        if (route === 'client.js') {
          const body = this.overlayScript();
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
          return;
        }
        if (route === 'state') {
          send(res, 200, {
            project: { id: project.id, name: project.name, kind: project.kind },
            review: reviewsStore.activeReview(project.id),
            pick: session.pick,
            annotations: reviewsStore.listAnnotations(project.id),
            axes: reviewsStore.AXES,
            minWhy: reviewsStore.MIN_WHY,
          });
          return;
        }
        if (route === 'projects') {
          send(res, 200, {
            projects: this.deps.projects.all()
              .filter(p => p.id !== project.id)
              .map(p => ({ id: p.id, name: p.name, kind: p.kind })),
          });
          return;
        }
        send(res, 404, { error: 'Unknown review endpoint.' });
        return;
      }

      if (req.method !== 'POST') { send(res, 405, { error: 'GET or POST only.' }); return; }
      const body = await readBody(req);

      switch (route) {
        case 'annotate': {
          const annotation = reviewsStore.addAnnotation(project.id, {
            scope: body.scope, context: body.context, input: body.input,
          });
          if (this.deps.onAnnotationSaved) this.deps.onAnnotationSaved(project, annotation);
          send(res, 200, { annotation });
          return;
        }
        case 'update': {
          const annotation = reviewsStore.updateAnnotation(project.id, String(body.id), body.patch || {});
          send(res, 200, { annotation });
          return;
        }
        case 'delete': {
          send(res, 200, { deleted: reviewsStore.deleteAnnotation(project.id, String(body.id)) });
          return;
        }
        case 'resolve': {
          const annotation = reviewsStore.updateAnnotation(project.id, String(body.id), {
            resolved: true, resolvedRating: body.resolvedRating,
          });
          if (body.asAnchor && this.deps.onAnchor) this.deps.onAnchor(project, annotation);
          send(res, 200, { annotation });
          return;
        }
        case 'export': {
          const result = this.deps.exportReview({
            project,
            capturesRoot: this.deps.capturesRoot(),
            projectNameFor: id => {
              const p = id && this.deps.projects.byId(id);
              return p ? p.name : null;
            },
          });
          session.lastExport = result.folder;
          if (this.deps.onExported) this.deps.onExported(project, result);
          send(res, 200, result);
          return;
        }
        case 'export/reveal': {
          // Only the folder this session just produced — never an arbitrary path.
          if (!session.lastExport) { send(res, 400, { error: 'Nothing exported yet.' }); return; }
          if (this.deps.onReveal) this.deps.onReveal(session.lastExport);
          send(res, 200, { ok: true });
          return;
        }
        case 'reference/open': {
          const target = this.deps.projects.byId(String(body.projectId));
          const annotation = reviewsStore.getAnnotation(project.id, String(body.annotationId));
          if (!target || !annotation) { send(res, 404, { error: 'Unknown project or annotation.' }); return; }
          const url = await this.deps.onReferenceHost(target, {
            annotationId: annotation.id, forProjectId: project.id,
          });
          send(res, 200, { url });
          return;
        }
        case 'reference/set': {
          if (!session.pick) { send(res, 400, { error: 'This tab is not picking a reference.' }); return; }
          const annotation = reviewsStore.updateAnnotation(session.pick.forProjectId, session.pick.annotationId, {
            input: {
              referenceProjectId: session.projectId,
              referenceSelector: String(body.selector || '').slice(0, 500),
              referenceStyles: body.styles && typeof body.styles === 'object' ? body.styles : null,
              referenceHTML: String(body.outerHTML || '').slice(0, 2000),
            },
          });
          send(res, 200, { annotation });
          return;
        }
        case 'done': {
          this.disable(dir);
          if (this.deps.onDone) this.deps.onDone(project, dir);
          send(res, 200, { ok: true });
          return;
        }
        default:
          send(res, 404, { error: 'Unknown review endpoint.' });
      }
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }
}

module.exports = { ReviewManager, API };
