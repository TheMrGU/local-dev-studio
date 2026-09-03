// lib/staticAudit.js — the review overlay on a site that lives on a real host.
//
// A 24/7 link runs on a CDN, where nothing of the app exists: no review API,
// no guest token, no owner online to receive a note. So the bundle that goes
// up carries the overlay itself, a state file standing in for the API's
// answer, and every page gets the same tag the local server would inject —
// marked standalone, so the overlay keeps notes in the reviewer's browser and
// "Send audit" downloads the file the owner imports from Project history.
//
// Pure over an entry list ({name, file} or {name, data}), so it is testable
// without Electron, a network, or a host.
const fs = require('fs');

const PREFIX = '/__siteslurp__/review/';
const CLIENT_NAME = '__siteslurp__/review/client.js';
const STATE_NAME = '__siteslurp__/review/state.json';
const TAG = `<script src="${PREFIX}client.js" data-ss-standalone="1" defer></script>`;

const isHtml = name => /\.html?$/i.test(name);

/** Insert a tag before </body> (or </html>, or append). The local server's rule. */
function injectTag(buf, tag) {
  const lower = buf.toString('latin1').toLowerCase();
  let at = lower.lastIndexOf('</body>');
  if (at === -1) at = lower.lastIndexOf('</html>');
  if (at === -1) return Buffer.concat([buf, Buffer.from('\n' + tag)]);
  return Buffer.concat([buf.subarray(0, at), Buffer.from(tag), buf.subarray(at)]);
}

/**
 * Rewrite a publish entry list so the site reviews itself on a static host:
 * every HTML page gets the standalone tag, and the overlay plus its state
 * file ride along under the same prefix the local server uses.
 * @param {{name:string, file?:string, data?:Buffer}[]} entries
 * @param {{overlaySource:string, state:object, readFile?:Function}} opts
 * @returns {Promise<{entries: Array, pages: number}>}
 */
async function withStaticAudit(entries, { overlaySource, state, readFile = fs.promises.readFile }) {
  const out = [];
  let pages = 0;
  for (const entry of entries) {
    if (!isHtml(entry.name)) { out.push(entry); continue; }
    const buf = entry.data !== undefined ? Buffer.from(entry.data) : await readFile(entry.file);
    out.push({ name: entry.name, data: injectTag(buf, TAG) });
    pages += 1;
  }
  out.push({ name: CLIENT_NAME, data: Buffer.from(String(overlaySource), 'utf8') });
  out.push({ name: STATE_NAME, data: Buffer.from(JSON.stringify(state), 'utf8') });
  return { entries: out, pages };
}

/** Netlify's _redirects entry that makes the site's real front door answer at
 *  "/" — a capture almost never has an index.html. Null when nothing is needed. */
function entryRedirect(entries, entry) {
  if (!entry || entry === 'index.html') return null;
  if (entries.some(e => e.name === 'index.html')) return null;
  if (!entries.some(e => e.name === entry)) return null;
  return { name: '_redirects', data: Buffer.from(`/  /${entry}  200\n`, 'utf8') };
}

/** The state.json a standalone overlay boots from: the guest API's answer,
 *  frozen at publish time. Existing notes ride along so reviewers see what
 *  has already been said. */
function standaloneState({ project, review, annotations = [], axes = [], minWhy = 0, version = null }) {
  return {
    guest: true,
    standalone: true,
    project: { name: project.name },
    review: { id: review.id },
    pinned: false,
    pinnedStale: false,
    version: version || null,
    publishedAt: new Date().toISOString(),
    annotations,
    axes,
    minWhy,
  };
}

module.exports = { withStaticAudit, entryRedirect, standaloneState, injectTag, TAG, CLIENT_NAME, STATE_NAME };
