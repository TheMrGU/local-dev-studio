// lib/guest.js — [PRO] guest review over share links.
//
// A share link shows the site and nothing else (invariant 12: tunneled
// requests never reach the review tooling). Guest review deliberately relaxes
// exactly two capabilities — reading review state and saving an annotation —
// and only for visitors whose link carries this share's capability token
// (?review=<token>). The token is minted when sharing starts and dies with the
// share; everything else the overlay can do (export, resolve, delete, images,
// references, audits) stays refused server-side, never just hidden in UI.
//
// Nothing here trusts the visitor: every tunneled review request is rate
// limited per Cloudflare-reported IP, annotations are capped per guest per
// hour, and the review payload guests receive is a stripped subset — no source
// paths, no console tails, no markup, no screenshots.
const crypto = require('crypto');
const path = require('path');
const { readBody, sendJson } = require('./review');

const GUEST_COOKIE = '__ss_guest';
const TOKEN_RE = /^[a-f0-9]{16,64}$/;

// Rate limits. The bucket bounds *requests* (state polls, annotate posts —
// anything under /__siteslurp__/review/ arriving through the tunnel); the
// hourly cap bounds *annotations* so one guest can't flood a review.
const BUCKET_CAPACITY = 40;      // burst
const BUCKET_REFILL_PER_SEC = 0.5; // sustained: 30/minute
const NOTES_PER_HOUR = 30;

/** Classic token bucket, one bucket per key, refilled lazily on take(). */
class TokenBucket {
  constructor({ capacity = BUCKET_CAPACITY, refillPerSec = BUCKET_REFILL_PER_SEC } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map(); // key -> { tokens, at }
  }

  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    // A full bucket is indistinguishable from a fresh one — drop it so the map
    // doesn't grow with every IP that ever visited.
    if (this.buckets.size > 500) {
      for (const [k, v] of this.buckets) {
        if (v.tokens >= this.capacity - 0.01 && k !== key) this.buckets.delete(k);
      }
    }
    return true;
  }
}

/** Fixed-window counter: at most `limit` takes per key per window. */
class HourlyCap {
  constructor({ limit = NOTES_PER_HOUR, windowMs = 60 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.counts = new Map(); // key -> { n, windowStart }
  }

  take(key, now = Date.now()) {
    let c = this.counts.get(key);
    if (!c || now - c.windowStart >= this.windowMs) {
      c = { n: 0, windowStart: now };
      this.counts.set(key, c);
    }
    if (c.n >= this.limit) return false;
    c.n += 1;
    return true;
  }
}

/** The `review` query parameter when it looks like a capability token. */
function guestParam(reqUrl) {
  const at = reqUrl.indexOf('?');
  if (at === -1) return null;
  for (const pair of reqUrl.slice(at + 1).split('#')[0].split('&')) {
    if (pair === 'review' || pair.startsWith('review=')) {
      const value = pair.slice(7);
      return TOKEN_RE.test(value) ? value : '';
    }
  }
  return null;
}

function guestCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${GUEST_COOKIE}=([a-f0-9]{16,64})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

/** The IP Cloudflare says the visitor has — the only per-guest identity a
 *  quick tunnel offers. Local fallback keeps tests honest. */
function guestIp(req) {
  return String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// Same-origin check for guest posts. The overlay fetches relative URLs, so a
// legitimate request's Origin (when the browser sends one) names the tunnel
// host itself. review.js's check assumes http://; share links are https.
function foreignGuestOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== (req.headers.host || ''); } catch { return true; }
}

// The pin cookie, read here so a pinned guest's save can be checked against
// the latest snapshot (server.js owns the cookie's write path).
function pinnedId(req) {
  const m = /(?:^|;\s*)__ss_version=([\w.-]{1,130})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

/** What a guest is allowed to know about an annotation: enough to draw a pin
 *  and read the note — no source paths, markup, styles, console or shots. */
function stripAnnotation(a) {
  return {
    id: a.id,
    reviewId: a.reviewId,
    scope: a.scope,
    createdAt: a.createdAt,
    resolved: !!a.resolved,
    author: a.author || 'me',
    auto: !!a.auto,
    context: {
      selector: a.context.selector || '',
      selectorFallback: a.context.selectorFallback || '',
      pageUrl: a.context.pageUrl || '',
      boundingBox: a.context.boundingBox || null,
    },
    input: {
      rating: a.input.rating,
      severity: a.input.severity,
      axes: a.input.axes,
      why: a.input.why,
      want: a.input.want,
    },
  };
}

class GuestManager {
  /**
   * @param {{
   *   projects: object, reviews: object,
   *   overlayScript: () => string,
   *   latestVersionId: (project: object) => string|null,
   *   onSaved?: (project: object, annotation: object) => void,
   *   log?: object,
   *   limits?: {bucket?: object, notes?: object},
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.shares = new Map(); // resolved dir -> { token, version }
    const limits = deps.limits || {};
    this.bucket = new TokenBucket(limits.bucket);
    this.notes = new HourlyCap(limits.notes);
  }

  key(dir) {
    const resolved = path.resolve(String(dir));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  /** Mint a fresh capability token for this share. Called by share:start —
   *  a new share means a new token; old links stop working. */
  enable(dir, { version = null } = {}) {
    const token = crypto.randomBytes(16).toString('hex');
    this.shares.set(this.key(dir), { token, version: version || null, dir });
    return { token, version: version || null };
  }

  disable(dir) { return this.shares.delete(this.key(dir)); }
  disableAll() { this.shares.clear(); }

  /** {token, version} while guest review is on for this dir, else null. */
  stateFor(dir) {
    const share = this.shares.get(this.key(dir));
    return share ? { token: share.token, version: share.version } : null;
  }

  /** Router hook for HostManager, same shape as reviewRouter: non-null only
   *  while this dir has an active guest share. */
  forDir(dir) {
    const share = this.shares.get(this.key(dir));
    if (!share) return null;
    return {
      tokenValid: token => !!token && token === share.token,
      handleRequest: (req, res, urlPath) => this.route(share, dir, req, res, urlPath),
    };
  }

  async route(share, dir, req, res, urlPath) {
    const route = urlPath.slice(urlPath.indexOf('review/') + 'review/'.length);
    try {
      // Rate limit before anything else — even the token check costs cycles,
      // and a flood of bad tokens is exactly what the bucket is for.
      if (!this.bucket.take(guestIp(req))) {
        sendJson(res, 429, { error: 'Slow down a little — this link is rate limited.' });
        return;
      }
      if (guestCookie(req) !== share.token) {
        // No capability, no API — indistinguishable from review mode being off.
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      if (foreignGuestOrigin(req)) {
        sendJson(res, 403, { error: 'Cross-origin request refused.' });
        return;
      }
      const project = this.deps.projects.byPath(dir);
      if (!project) { sendJson(res, 410, { error: 'This project no longer exists.' }); return; }

      if (req.method === 'GET') {
        if (route === 'client.js') {
          const body = this.deps.overlayScript();
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
          return;
        }
        if (route === 'state') {
          const reviews = this.deps.reviews;
          const pin = pinnedId(req);
          sendJson(res, 200, {
            guest: true,
            project: { name: project.name },
            review: { id: reviews.activeReview(project.id).id },
            pinned: !!pin,
            // A pinned link goes read-only the moment the pin stops being the
            // newest snapshot — the page has moved on.
            pinnedStale: !!pin && pin !== this.deps.latestVersionId(project),
            annotations: reviews.listAnnotations(project.id).map(stripAnnotation),
            axes: reviews.AXES,
            minWhy: reviews.MIN_WHY,
          });
          return;
        }
        sendJson(res, 403, { error: 'Not available on a share link.' });
        return;
      }

      if (req.method !== 'POST') { sendJson(res, 405, { error: 'GET or POST only.' }); return; }

      if (route === 'annotate') {
        if (!this.notes.take(guestIp(req))) {
          sendJson(res, 429, { error: 'You have hit this link\'s hourly note limit — take a break and try again later.' });
          return;
        }
        const body = await readBody(req);
        const pin = pinnedId(req);
        if (pin && pin !== this.deps.latestVersionId(project)) {
          sendJson(res, 409, {
            error: 'This page has moved on — the site changed since this snapshot link was made. Ask for a fresh link to keep annotating.',
          });
          return;
        }
        const author = String(body.author || '').trim().slice(0, 60) || 'Guest';
        const annotation = this.deps.reviews.addAnnotation(project.id, {
          scope: body.scope,
          context: body.context,
          input: body.input,
          author,
          // Which snapshot the guest was actually looking at, kept on the note
          // so the owner can read it in context.
          ...(pin ? { pinnedVersion: pin } : {}),
        });
        if (this.deps.onSaved) this.deps.onSaved(project, annotation);
        sendJson(res, 200, { annotation: stripAnnotation(annotation) });
        return;
      }

      // Everything else the overlay knows how to ask for — update, delete,
      // resolve, export, images, references, audits, done — is refused here,
      // not hidden in the UI. Capabilities are stripped server-side.
      sendJson(res, 403, { error: 'Not available on a share link.' });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  }
}

module.exports = {
  GuestManager, TokenBucket, HourlyCap,
  guestParam, guestCookie, guestIp, stripAnnotation,
  GUEST_COOKIE, NOTES_PER_HOUR,
};
