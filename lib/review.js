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
const { CHECKLISTS } = require('./checklists');

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

// Shared with the guest router (lib/guest.js) — one body reader, one JSON
// answer shape, whichever door a review request comes through.
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
// anything cross-origin announces itself and is refused. The scheme is
// deliberately ignored: the same handler answers on both the http and the
// https (Phase 5.2) listeners, so an https page fetching its own origin is
// same-origin even though the port differs — the host is what must match.
function foreignOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host || '';
  let originHost;
  try { originHost = new URL(origin).host; } catch { return true; }
  return originHost !== host && originHost !== `localhost:${host.split(':')[1] || ''}`;
}

// A browser pinned to a snapshot (?v=<id>, Phase 2.5) carries the pin cookie.
// The overlay still loads there, but annotations describe the live version —
// saving one against an old page would point the agent at ghosts.
function pinnedView(req) {
  return /(?:^|;\s*)__ss_version=[\w.-]/.test(req.headers.cookie || '');
}

class ReviewManager {
  /**
   * @param {{
   *   projects: object, capturesRoot: () => string,
   *   exportReview: Function,
   *   overlayPath: string,
   *   onAnnotationSaved?: Function, onExported?: Function, onReveal?: Function,
   *   onReferenceHost?: Function, onDone?: Function,
   *   onResolved?: Function, onAudit?: Function,
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
            pinned: pinnedView(req),
            annotations: reviewsStore.listAnnotations(project.id),
            axes: reviewsStore.AXES,
            minWhy: reviewsStore.MIN_WHY,
            checklists: CHECKLISTS,
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
        if (route.startsWith('image/')) {
          // Serve an annotation's stored images back to the overlay: the
          // reference by default, or a named shot kind (image/<id>/<kind>) so
          // the pin popup can show before/after pairs. Only stored basenames
          // are ever read — the id names the annotation, never a path.
          const [rawId, kind = 'ref'] = route.slice(6).split('/');
          const KINDS = {
            ref: 'referenceImage',
            el: 'screenshotElement',
            ctx: 'screenshotContext',
            after_el: 'screenshotAfterElement',
            after_ctx: 'screenshotAfterContext',
          };
          if (!KINDS[kind]) { send(res, 404, { error: 'Unknown image kind.' }); return; }
          const annotation = reviewsStore.getAnnotation(project.id, decodeURIComponent(rawId));
          const rel = annotation && annotation.context[KINDS[kind]];
          if (!rel) { send(res, 404, { error: 'No image on that annotation.' }); return; }
          const file = path.join(reviewsStore.shotsDir(project.id), path.basename(rel));
          const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
          fs.readFile(file, (err, buf) => {
            if (err) { send(res, 404, { error: 'The image file is gone.' }); return; }
            res.writeHead(200, {
              'Content-Type': types[file.split('.').pop().toLowerCase()] || 'application/octet-stream',
              'Cache-Control': 'no-store',
              'Content-Length': buf.length,
            });
            res.end(buf);
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
          if (pinnedView(req)) {
            send(res, 409, { error: 'You are viewing a snapshot — annotations target the live version. Use "Back to live" first.' });
            return;
          }
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
          // Verification (after-shot + pixel diff) runs behind the reply —
          // the popup shouldn't wait on an offscreen render.
          if (this.deps.onResolved) this.deps.onResolved(project, annotation);
          send(res, 200, { annotation });
          return;
        }
        case 'audit': {
          // "Run audits" from the toolbar — main.js owns the job lock and
          // the actual run; findings come back as ordinary annotations.
          if (!this.deps.onAudit) { send(res, 404, { error: 'Audits are not available.' }); return; }
          const summary = await this.deps.onAudit(project);
          send(res, 200, summary);
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
        case 'image': {
          // Attach a reference image to a saved annotation. The image arrives
          // as a data URL inside the JSON body, which the 2 MB body cap has
          // already bounded; it lands next to the screenshots so exports copy
          // it with them. Whitelisted image types only — this writes to disk.
          const annotation = reviewsStore.getAnnotation(project.id, String(body.id));
          if (!annotation) { send(res, 404, { error: 'That annotation no longer exists.' }); return; }
          const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/
            .exec(String(body.dataUrl || ''));
          if (!match) { send(res, 400, { error: 'Attach a PNG, JPEG, WebP or GIF image.' }); return; }
          const bytes = Buffer.from(match[2], 'base64');
          if (!bytes.length) { send(res, 400, { error: 'That image is empty.' }); return; }
          if (bytes.length > MAX_BODY) { send(res, 400, { error: 'Images are capped at 2 MB.' }); return; }
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
          const name = `${annotation.id}_ref.${ext}`;
          const dir = reviewsStore.shotsDir(project.id);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name), bytes);
          const updated = reviewsStore.updateAnnotation(project.id, annotation.id, {
            context: { referenceImage: 'shots/' + name },
          });
          send(res, 200, { annotation: updated });
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

module.exports = { ReviewManager, API, readBody, sendJson: send };
