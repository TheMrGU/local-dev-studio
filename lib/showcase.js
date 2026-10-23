// lib/showcase.js — ShowCase: put a Studio site on the big screen.
//
// A presentation is one frameless window (fullscreen on the display you pick)
// holding a sandboxed WebContentsView of the hosted site, with a thin stage
// renderer around it for device bezels, title/end cards, blackout and the
// recorder. A client script is injected into every page the view lands on
// (renderer/showcase-client.js); it makes the page presentable, reads it, and
// carries out the moves. The director below turns what it read into a
// storyboard — a list of shots — and runs them: an opening hold, a walk along
// the navigation, a hover on the main button, a glide to each section with a
// push-in on its picture, a sweep across a card grid, a flip to the phone
// layout, a hop to the next page, on to the next site. Pages that don't scroll
// (a WebGL piece, an app shell) get explored by pointer instead.
//
// The main window's ShowCase tab is the remote: everything the keys do in the
// show, the remote does too, and the show pushes its state (including the
// storyboard and where it is in it) back every tick.
//
// The pure parts (option sanitising, nav-link filtering, the storyboard
// builder, the step planner and the device-frame fit) come first and have no
// Electron dependency so they can be unit-tested; the window class follows.
const fs = require('fs');
const path = require('path');

const STYLES = ['walkthrough', 'reel', 'cinematic', 'scroll', 'still'];
const FRAMES = ['none', 'laptop', 'tablet', 'phone', 'duo'];
const CURSORS = ['hidden', 'ghost', 'spotlight'];

const DEFAULTS = {
  style: 'walkthrough', // pacing and camera language; see STYLE_SPEC
  speed: 90,            // px per second
  sections: true,       // ease to a stop at each section
  dwell: 2.5,           // seconds held at a section
  pageDwell: 4,         // seconds held at the end of a page before moving on
  loop: true,           // start over when the show runs out
  // Beats — which kinds of shot the storyboard may use.
  nav: true,            // walk the pointer along the site's navigation
  buttons: true,        // hover the main call-to-action
  details: true,        // push in on each section's picture
  cards: true,          // sweep the pointer across card grids
  flip: false,          // show the page on a phone before moving on
  pages: true,          // click through to the site's other pages
  // Polish — what the client fixes in the page before the camera rolls.
  tidy: true,           // hide cookie bars, chat bubbles, parked pop-ups
  reveal: true,         // show reveal-on-scroll content the page never revealed
  media: true,          // play videos (muted) on screen, load lazy images
  frame: 'none',        // device bezel around the site
  cursor: 'ghost',      // what the audience sees moving
  zoom: 100,            // percent, on top of the frame's own scale
  slates: true,         // title card in, end card out
  tagline: '',          // one line under the site name on the title card
  progress: true,       // hairline progress bar
  captions: true,       // lower-third page and section names
  siteSeconds: 0,       // reel: seconds per site (0 = when its own story ends)
  fullscreen: true,
  display: null,        // display id, null = wherever the app is
  record: false,        // save the show as a video
  music: '',            // path of an audio file to play under the show
  musicVolume: 60,      // percent
};

const CLAMPS = {
  speed: [10, 800],
  dwell: [0, 30],
  pageDwell: [0, 120],
  zoom: [50, 250],
  siteSeconds: [0, 3600],
  musicVolume: [0, 100],
};

// The mode names 2.7.0 shipped with, so a saved panel still reads.
const LEGACY_MODES = { scroll: 'scroll', tour: 'walkthrough', still: 'still' };

/** How each style paces and frames a page. `establish` = seconds on the
 *  opening view; `push` = how far a detail pushes in (1 = no push); `stops` =
 *  how many sections a page may stop at; `boost` multiplies the glide speed;
 *  `heroPush` = open on a push-in of the hero picture. The beats themselves
 *  are options the style only suggests (see STYLE_BEATS). */
const STYLE_SPEC = {
  walkthrough: { establish: 3, push: 1.1, stops: 40, boost: 1, heroPush: false },
  reel: { establish: 1.8, push: 1.14, stops: 3, boost: 1.8, heroPush: false },
  cinematic: { establish: 4.5, push: 1.16, stops: 40, boost: 0.75, heroPush: true },
  scroll: { establish: 1, push: 1, stops: 40, boost: 1, heroPush: false },
  still: { establish: 0, push: 1, stops: 0, boost: 1, heroPush: false },
};

/** The beats a style switches on when it is chosen (the panel applies these;
 *  the presenter can still change any of them). */
const STYLE_BEATS = {
  walkthrough: { nav: true, buttons: true, details: true, cards: true, flip: false, pages: true },
  reel: { nav: false, buttons: false, details: true, cards: false, flip: true, pages: false },
  cinematic: { nav: false, buttons: false, details: true, cards: false, flip: false, pages: true },
  scroll: { nav: false, buttons: false, details: false, cards: false, flip: false, pages: false },
  still: { nav: false, buttons: false, details: false, cards: false, flip: false, pages: true },
};

// CSS-pixel viewports of the device frames. The view is sized to a scaled copy
// of these and the page is zoomed by the same factor, so a phone frame really
// lays the site out at 390px wide — the mobile design, just bigger.
const DEVICES = {
  phone: { width: 390, height: 844, pad: 0.07 },
  tablet: { width: 1180, height: 820, pad: 0.09 },
  laptop: { width: 1440, height: 900, pad: 0.10 },
};

/** Sanitise a raw options object (from settings or the renderer) into a full,
 *  in-range set. Unknown keys are dropped; wrong types fall back. */
function normalizeOptions(raw) {
  const out = { ...DEFAULTS };
  const src = raw && typeof raw === 'object' ? { ...raw } : {};
  if (src.style === undefined && typeof src.mode === 'string' && LEGACY_MODES[src.mode]) src.style = LEGACY_MODES[src.mode];
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = src[key];
    if (value === undefined) continue;
    if (typeof fallback === 'boolean') out[key] = !!value;
    else if (typeof fallback === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = CLAMPS[key] || [-Infinity, Infinity];
      out[key] = Math.min(hi, Math.max(lo, n));
    } else if (typeof fallback === 'string') out[key] = String(value).slice(0, key === 'music' ? 1024 : 160);
    else out[key] = value;
  }
  if (!STYLES.includes(out.style)) out.style = DEFAULTS.style;
  if (!FRAMES.includes(out.frame)) out.frame = DEFAULTS.frame;
  if (!CURSORS.includes(out.cursor)) out.cursor = DEFAULTS.cursor;
  if (out.display !== null && !Number.isFinite(Number(out.display))) out.display = null;
  else if (out.display !== null) out.display = Number(out.display);
  return out;
}

const SKIP_EXT = /\.(pdf|zip|rar|7z|gz|dmg|exe|msi|apk|jpe?g|png|gif|webp|svg|mp4|webm|mp3|wav|ics|csv|xlsx?|docx?|pptx?)$/i;

/** Which of a page's links a tour should walk. Same-origin pages only, no
 *  anchors-on-this-page, no files, no repeats, the current page dropped;
 *  links that live inside a nav/header come first because they're the site's
 *  own idea of its main pages. A capture's links still point at the site it
 *  came from (`sourceOrigin`); those count as local and are mapped onto the
 *  hosted origin, keeping the original in `original` so the link can still
 *  be found on the page. Returns [{ href, label, original }]. */
function filterNavTargets(links, { origin, current, sourceOrigin = null, max = 12 } = {}) {
  let base;
  try { base = new URL(origin); } catch { return []; }
  let source = null;
  try { source = sourceOrigin ? new URL(sourceOrigin).origin : null; } catch { /* no source */ }
  if (source === base.origin) source = null;
  let currentKey = null;
  try {
    const c = new URL(current || origin, base);
    currentKey = c.pathname.replace(/\/+$/, '') + c.search;
  } catch { /* no current page yet */ }

  const seen = new Set();
  const picked = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || typeof link.href !== 'string') continue;
    let url;
    try { url = new URL(link.href, base); } catch { continue; }
    const original = url.href;
    if (source && url.origin === source) url = new URL(url.pathname + url.search + url.hash, base);
    if (url.origin !== base.origin) continue;
    if (!/^https?:$/.test(url.protocol)) continue;
    if (SKIP_EXT.test(url.pathname)) continue;
    const key = url.pathname.replace(/\/+$/, '') + url.search;
    if (key === currentKey) continue;              // an anchor into this page, or a home link
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String(link.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      || (url.pathname.split('/').filter(Boolean).pop() || 'Page').replace(/[-_]/g, ' ').replace(/\.html?$/, '');
    picked.push({ href: url.origin + url.pathname + url.search, label, original, inNav: !!link.inNav, order: picked.length });
  }
  picked.sort((a, b) => (b.inNav - a.inNav) || (a.order - b.order));
  return picked.slice(0, Math.max(1, max)).map(({ href, label, original }) => ({ href, label, original }));
}

/** Turn what the client read off a page into the shots to run on it. Pure:
 *  the same reading and options always give the same storyboard.
 *
 *  analysis: { scrolls, max, sections: [{ y, label, key, cards }], nav: [{ref,label}],
 *              buttons: [{ref,label}], hero, interactive: [{ref,label}] }
 *  ctx: { frame }
 *  → [{ kind, label, ... }] where kind is one of
 *    establish | nav | button | glide | detail | cards | wander | flip | hold */
function buildBoard(analysis, options, ctx = {}) {
  const o = normalizeOptions(options);
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const spec = STYLE_SPEC[o.style] || STYLE_SPEC.walkthrough;
  const frame = ctx.frame || o.frame;
  const shots = [];
  const sectionsIn = Array.isArray(a.sections) ? a.sections.filter(s => s && Number.isFinite(s.y)) : [];
  const navIn = Array.isArray(a.nav) ? a.nav.filter(n => n && Number.isInteger(n.ref)) : [];
  const buttonsIn = Array.isArray(a.buttons) ? a.buttons.filter(b => b && Number.isInteger(b.ref)) : [];
  const wanderIn = Array.isArray(a.interactive) ? a.interactive.filter(i => i && Number.isInteger(i.ref)) : [];
  const scrolls = !!a.scrolls && Number(a.max) > 0;
  const dwellMs = Math.round(o.dwell * 1000);
  const endMs = Math.round(o.pageDwell * 1000);

  if (o.style === 'still') {
    return [{ kind: 'hold', label: 'Hold', ms: Math.max(1000, endMs) }];
  }

  shots.push({ kind: 'establish', label: 'Opening', ms: Math.round(spec.establish * 1000) });
  if (spec.heroPush && o.details && Number.isInteger(a.hero)) {
    shots.push({ kind: 'detail', label: 'Hero', ref: a.hero, push: spec.push, ms: dwellMs });
  }
  if (o.nav && navIn.length >= 2) {
    shots.push({ kind: 'nav', label: 'Navigation', refs: navIn.slice(0, 6).map(n => n.ref), labels: navIn.slice(0, 6).map(n => n.label) });
  }
  if (o.buttons && buttonsIn.length) {
    shots.push({ kind: 'button', label: buttonsIn[0].label ? `Button · ${buttonsIn[0].label}` : 'Button', ref: buttonsIn[0].ref });
  }

  if (scrolls) {
    let stops = o.sections ? sectionsIn : [];
    if (stops.length > spec.stops) {
      // A reel has time for a few: spread them down the page.
      const picked = [];
      for (let i = 0; i < spec.stops; i++) picked.push(stops[Math.round((i + 0.5) * stops.length / spec.stops - 0.5)]);
      stops = picked.filter(Boolean);
    }
    for (const stop of stops) {
      const label = String(stop.label || '').trim();
      shots.push({ kind: 'glide', label: label ? `Section · ${label}` : 'Section', y: Math.round(stop.y), caption: label, ms: dwellMs, boost: spec.boost });
      if (o.details && spec.push > 1 && Number.isInteger(stop.key)) {
        shots.push({ kind: 'detail', label: label ? `Detail · ${label}` : 'Detail', ref: stop.key, push: spec.push, ms: Math.round(dwellMs * 0.8) });
      }
      if (o.cards && Array.isArray(stop.cards) && stop.cards.length >= 3) {
        shots.push({ kind: 'cards', label: 'Cards', refs: stop.cards.slice(0, 6) });
      }
    }
    shots.push({ kind: 'glide', label: 'To the end', y: Math.round(a.max), caption: '', ms: 0, boost: spec.boost });
  } else if (wanderIn.length) {
    shots.push({ kind: 'wander', label: 'Explore', refs: wanderIn.slice(0, 6).map(i => i.ref), labels: wanderIn.slice(0, 6).map(i => i.label) });
  }

  if (o.flip && scrolls && frame !== 'phone' && frame !== 'duo') {
    shots.push({ kind: 'flip', label: 'On a phone', ms: 7000 });
  }
  shots.push({ kind: 'hold', label: 'End of page', ms: endMs });
  return shots;
}

/** What happens when the current page is done. Pure: the director hands in
 *  where it is and gets one instruction back. `reelDue` = the per-site timer
 *  of a multi-site reel has run out, which outranks the page order. */
function nextStep({ pages, loop, pageCount = 1, pageIndex = 0, siteCount = 1, siteIndex = 0, reelDue = false }) {
  const morePages = !!pages && pageIndex < pageCount - 1;
  const moreSites = siteIndex < siteCount - 1;
  if (reelDue && siteCount > 1) {
    if (moreSites) return { type: 'nextSite' };
    return loop ? { type: 'firstSite' } : { type: 'end' };
  }
  if (morePages) return { type: 'nextPage' };
  if (moreSites) return { type: 'nextSite' };
  if (!loop) return { type: 'end' };
  if (siteCount > 1) return { type: 'firstSite' };
  if (pages && pageCount > 1) return { type: 'firstPage' };
  return { type: 'restart' };
}

/** Where the site view goes for a device frame inside the available stage
 *  rectangle: centred, scaled to fit with the frame's breathing room, never
 *  upscaled past 4× or shrunk below a quarter. `none` fills the stage. `duo`
 *  is a laptop on the left and a phone on the right (`phone` in the answer),
 *  the same page in both. */
function fitDevice(frame, avail) {
  const a = {
    x: Number(avail && avail.x) || 0, y: Number(avail && avail.y) || 0,
    width: Math.max(1, Number(avail && avail.width) || 1),
    height: Math.max(1, Number(avail && avail.height) || 1),
  };
  if (frame === 'duo') {
    const split = Math.round(a.width * 0.7);
    const main = fitDevice('laptop', { x: a.x, y: a.y, width: split, height: a.height });
    const phone = fitDevice('phone', { x: a.x + split, y: a.y, width: a.width - split, height: a.height });
    return { ...main, kind: 'duo', phone };
  }
  const device = DEVICES[frame];
  if (!device) return { kind: 'none', x: a.x, y: a.y, width: a.width, height: a.height, scale: 1 };
  const usableW = a.width * (1 - 2 * device.pad);
  const usableH = a.height * (1 - 2 * device.pad);
  let scale = Math.min(usableW / device.width, usableH / device.height);
  scale = Math.min(4, Math.max(0.25, scale));
  const width = Math.round(device.width * scale);
  const height = Math.round(device.height * scale);
  // A laptop sits on its base, so it rides a touch high of centre.
  const lift = frame === 'laptop' ? Math.round(height * 0.04) : 0;
  return {
    kind: frame,
    x: Math.round(a.x + (a.width - width) / 2),
    y: Math.round(a.y + (a.height - height) / 2 - lift),
    width, height, scale,
  };
}

/** A box pushed in by `k` around a focus point (DIP, relative to the box):
 *  the same page, bigger, with the focus pinned where it was. Pure. */
function pushBox(box, focus, k) {
  const fx = Math.max(0, Math.min(box.width, focus && Number.isFinite(focus.x) ? focus.x : box.width / 2));
  const fy = Math.max(0, Math.min(box.height, focus && Number.isFinite(focus.y) ? focus.y : box.height / 2));
  return {
    ...box,
    x: Math.round(box.x - fx * (k - 1)),
    y: Math.round(box.y - fy * (k - 1)),
    width: Math.round(box.width * k),
    height: Math.round(box.height * k),
    scale: box.scale * k,
  };
}

/** Public shape of a ShowCase for the remote; `active:false` when there is
 *  no show. Kept as a function so the idle answer is one place. */
function idleState() {
  return { active: false };
}

/** File name for a recording: the site (or "reel"), the moment, the format. */
function recordingName(sites, mime, when = new Date()) {
  const names = Array.isArray(sites) ? sites : [];
  const base = names.length === 1 ? String(names[0] || 'show') : 'reel';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'show';
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  const ext = /mp4/.test(String(mime || '')) ? 'mp4' : 'webm';
  return `${slug}-${stamp}.${ext}`;
}

// ---------------------------------------------------------------------------
// Electron half
// ---------------------------------------------------------------------------

const TICK_MS = 250;
const SLATE_MS = 2800;
const NAV_WAIT_MS = 3000;
const CURSOR_GLIDE_MS = 750;
const PUSH_FPS = 30;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let electron = null;
function lazyElectron() {
  if (!electron) electron = require('electron');
  return electron;
}

/** One running show. Created by Showcase.start(); dies with its window. */
class ShowcaseWindow {
  /**
   * @param {object[]} sites registry projects, in reel order
   * @param {object} options normalised
   * @param {{ stagePath, preloadPath, clientSource, urlFor, publicUrlFor, sourceUrlFor, recordDir, onState, onClosed, anchorDisplay, brand, log }} deps
   */
  constructor(sites, options, deps) {
    const { BrowserWindow, WebContentsView, screen, session, desktopCapturer } = lazyElectron();
    this.sites = sites;
    this.opts = options;
    this.deps = deps;
    this.destroyed = false;

    this.siteIndex = 0;
    this.pageIndex = 0;
    this.pages = [];           // [{ href, label }] for the current site
    this.board = [];           // shots for the current page
    this.shotIndex = -1;
    this.boardToken = 0;       // bumps whenever a new board starts
    this.jump = null;          // shot index the remote asked for
    this.waiters = new Set();  // director-side sleeps cut short by a skip
    this.playing = true;
    this.blackout = false;
    this.phase = 'slate';      // slate | site | end
    this.advancing = false;
    this.reelStartedAt = 0;
    this.last = { progress: 0, title: '', y: 0, max: 0 };
    this.fixed = null;         // what the client tidied on this page
    this.stageRect = null;
    this.frameBox = null;
    this.pushed = null;        // { box } while a detail is pushed in
    this.userZoom = options.zoom / 100;
    this.navToken = 0;
    this.pendingNav = null;    // resolver waiting for a navigation after a click
    this.mirror = null;        // the phone half of a duo frame
    this.recording = null;     // { mime, path, bytes, stream, done }

    // Which display: the chosen one, else the one under the app.
    let display = null;
    const all = screen.getAllDisplays();
    if (options.display !== null) display = all.find(d => d.id === options.display) || null;
    if (!display) display = deps.anchorDisplay ? deps.anchorDisplay() : screen.getPrimaryDisplay();
    const b = display.bounds;
    const width = Math.min(1440, Math.round(b.width * 0.86));
    const height = Math.min(900, Math.round(b.height * 0.86));

    // The stage gets its own session so the recorder's screen-share answer
    // (always: this window) never reaches any other renderer of the app.
    const stageSession = session.fromPartition('showcase-stage');
    this.win = new BrowserWindow({
      x: Math.round(b.x + (b.width - width) / 2),
      y: Math.round(b.y + (b.height - height) / 2),
      width, height,
      minWidth: 640, minHeight: 400,
      frame: false,
      backgroundColor: '#000000',
      title: `${sites[0].name} — ShowCase`,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        session: stageSession,
      },
    });
    this.stageId = this.win.webContents.id;
    stageSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['window'] }).then(sources => {
        const mine = sources.find(s => s.id === this.win.getMediaSourceId());
        if (!mine) throw new Error('the show window is not capturable');
        callback({ video: mine, audio: process.platform === 'win32' ? 'loopback' : undefined });
      }).catch(err => {
        this.deps.log.warn('showcase record source', err.message);
        callback({});
      });
    }, { useSystemPicker: false });

    // Its own in-memory partition: zoom is per-host in Chromium, so the zoom a
    // phone frame applies must never leak into the Studio Browser on the same
    // localhost port — and no cookie or pin from elsewhere leaks in.
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'showcase',
        backgroundThrottling: false,
      },
    });
    const wc = this.view.webContents;
    this.viewId = wc.id;
    wc.setUserAgent(wc.getUserAgent() + ' NightShyftShowCase');
    this.win.contentView.addChildView(this.view);
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width, height });

    wc.on('dom-ready', () => this.onDomReady());
    wc.on('did-navigate-in-page', () => this.onInPageNav());
    wc.on('did-navigate', () => { this.settleNav(); this.mirrorFollowUrl(); });
    wc.on('did-fail-load', (e, code, description, failedUrl, isMainFrame) => {
      if (code === -3 || !isMainFrame) return;
      this.deps.log.warn('showcase load failed', failedUrl, description);
      this.settleNav();
    });
    wc.on('page-title-updated', (e, title) => { this.last.title = title; });
    // A renderer that dies mid-show (GPU hiccup, a page that OOMs) comes back
    // on its own: reload the page, the injection and begin() follow dom-ready.
    wc.on('render-process-gone', (e, details) => {
      if (this.destroyed || !details || details.reason === 'clean-exit') return;
      this.deps.log.warn('showcase renderer gone', details.reason, '— reloading');
      setTimeout(() => { if (!this.destroyed) wc.reload(); }, 800);
    });

    // Nothing leaves the site: pop-ups and off-site links are dropped on the
    // floor (a presentation must never open a browser behind itself).
    wc.setWindowOpenHandler(({ url }) => {
      const local = this.sameOrigin(url) ? url : this.localize(url);
      if (local) wc.loadURL(local).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (this.sameOrigin(url)) return;
      event.preventDefault();
      const local = this.localize(url);
      if (local) wc.loadURL(local).catch(() => {});
    });

    for (const contents of [this.win.webContents, wc]) {
      contents.on('before-input-event', (event, input) => this.onKey(event, input));
    }

    this.win.once('ready-to-show', () => {
      this.win.show();
      if (this.opts.fullscreen) this.win.setFullScreen(true);
      if (this.opts.record) setTimeout(() => this.startRecording(), 700);
    });
    // A recording in flight gets its last chunk before the window goes.
    this.win.on('close', event => {
      if (this.recording && !this.recording.done && !this.closingForReal) {
        event.preventDefault();
        this.closingForReal = true;
        this.stopRecording().finally(() => { if (!this.win.isDestroyed()) this.win.close(); });
      }
    });
    this.win.on('closed', () => this.teardown());
    this.win.on('enter-full-screen', () => this.pushState());
    this.win.on('leave-full-screen', () => this.pushState());

    this.win.loadFile(deps.stagePath);
    this.ticker = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.loadSite(0).catch(err => this.deps.log.warn('showcase start', err.message));
  }

  /* ---------- lifecycle ---------- */

  teardown() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.ticker);
    clearTimeout(this.slateTimer);
    this.cutWaiters();
    if (this.recording && this.recording.stream) { try { this.recording.stream.end(); } catch { /* closed */ } }
    try { const d = this.view.webContents.debugger; if (d.isAttached()) d.detach(); } catch { /* gone */ }
    try { this.view.webContents.close(); } catch { /* already closed with the window */ }
    this.dropMirror();
    this.deps.onClosed(this);
  }

  close() {
    if (!this.destroyed && !this.win.isDestroyed()) this.win.close();
  }

  sameOrigin(target) {
    try {
      const a = new URL(target);
      const b = new URL(this.base || 'http://localhost/');
      return a.port === b.port && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(a.hostname);
    } catch { return false; }
  }

  /** A link back to the site this capture came from is a link into the
   *  capture: the same path on the hosted origin. Null for anything else. */
  localize(target) {
    if (!this.sourceOrigin || !this.base) return null;
    try {
      const u = new URL(target);
      if (u.origin !== this.sourceOrigin) return null;
      return this.base + u.pathname + u.search;
    } catch { return null; }
  }

  /** Run code in the page. Falls back when there is no page yet, when the
   *  page throws, or when it never answers (a renderer mid-navigation can
   *  swallow a call whole) — a shot must never hang the show. */
  exec(code, fallback = null, timeoutMs = 20000) {
    if (this.destroyed) return Promise.resolve(fallback);
    const wc = this.view.webContents;
    if (wc.isDestroyed() || !wc.getURL() || wc.getURL() === 'about:blank') return Promise.resolve(fallback);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      wc.executeJavaScript(code, true).then(
        value => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); resolve(fallback); },
      );
    });
  }

  /** Call one client function; null when the client isn't there. */
  client(fn, ...args) {
    return this.exec(`window.__nsShowcase ? window.__nsShowcase.${fn}(${args.map(a => JSON.stringify(a)).join(', ')}) : null`, null);
  }

  stage(channel, data) {
    if (this.destroyed || this.win.isDestroyed()) return;
    try { this.win.webContents.send(channel, data); } catch { /* the stage is on its way out */ }
  }

  /** A director-side sleep that a skip cuts short. */
  wait(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(entry); resolve(true); }, ms);
      const entry = () => { clearTimeout(timer); resolve(false); };
      this.waiters.add(entry);
    });
  }
  cutWaiters() {
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  get project() { return this.sites[this.siteIndex]; }

  /* ---------- sites & pages ---------- */

  async loadSite(index) {
    const project = this.sites[index];
    if (!project) return;
    this.boardToken++;
    this.cutWaiters();
    await this.client('abort');
    this.siteIndex = index;
    this.pageIndex = 0;
    this.pages = [];
    this.board = [];
    this.shotIndex = -1;
    this.last = { progress: 0, title: '', y: 0, max: 0 };
    this.fixed = null;
    this.reelStartedAt = Date.now();
    if (!this.win.isDestroyed()) this.win.setTitle(`${project.name} — ShowCase`);

    let url;
    try {
      url = await this.deps.urlFor(project);
    } catch (err) {
      this.deps.log.warn('showcase host', project.name, err.message);
      this.showSlate({ kind: 'error', title: project.name, tagline: err.message });
      return;
    }
    if (this.destroyed) return;
    this.base = url.replace(/\/$/, '');
    this.sourceOrigin = null;
    try {
      const src = this.deps.sourceUrlFor(project);
      if (src) this.sourceOrigin = new URL(src).origin;
    } catch { /* not a capture, or an odd manifest */ }
    if (this.opts.slates) {
      this.showSlate({ kind: 'title', title: project.name, tagline: this.opts.tagline, url: this.deps.publicUrlFor(project) });
      clearTimeout(this.slateTimer);
      this.slateTimer = setTimeout(() => this.revealSite(), SLATE_MS);
    } else {
      this.revealSite();
    }
    this.navToken++;
    this.view.webContents.loadURL(this.base + '/').catch(() => {});
    if (this.mirror) this.mirror.webContents.loadURL(this.base + '/').catch(() => {});
    this.pushState();
  }

  showSlate(slate) {
    this.phase = slate.kind === 'end' ? 'end' : 'slate';
    this.view.setVisible(false);
    if (this.mirror) this.mirror.setVisible(false);
    this.stage('sc:slate', { ...slate, brand: this.deps.brand });
    this.pushState();
  }

  revealSite() {
    if (this.destroyed) return;
    this.phase = 'site';
    this.stage('sc:slate', null);
    if (!this.blackout) {
      this.view.setVisible(true);
      if (this.mirror) this.mirror.setVisible(true);
    }
    this.pushState();
  }

  clientConfig(mirror = false) {
    const o = this.opts;
    return {
      speed: o.speed, dwell: o.dwell, pageDwell: o.pageDwell,
      cursor: o.cursor, progress: o.progress, captions: o.captions,
      tidy: o.tidy, reveal: o.reveal, media: o.media,
      brand: this.deps.brand.name,
      mirror,
    };
  }

  async onDomReady() {
    if (this.destroyed) return;
    const token = this.navToken;
    this.pageUrl = this.view.webContents.getURL().replace(/#.*$/, '');
    await this.exec(this.deps.clientSource + '\n;true');
    await this.client('configure', this.clientConfig());
    if (this.destroyed || token !== this.navToken) return;
    this.settleNav();
    await this.afterPageReady();
  }

  /** A route change inside a single-page app is a new page; a hash change
   *  is not — sites with a scroll-spy rewrite the hash as the camera passes
   *  each section, and the show must not start over every time. */
  async onInPageNav() {
    this.settleNav();
    const url = this.view.webContents.getURL().replace(/#.*$/, '');
    if (url === this.pageUrl) return;
    this.pageUrl = url;
    await this.afterPageReady();
  }

  /** A page is on screen: make it presentable, learn the site's pages (once
   *  per site), read the page, build its storyboard and run it. */
  async afterPageReady() {
    if (this.destroyed) return;
    const token = ++this.boardToken;
    this.cutWaiters();
    if (this.opts.pages && !this.pages.length) {
      const links = await this.client('navTargets') || [];
      const current = await this.exec('location.href', this.base + '/');
      const targets = filterNavTargets(links, { origin: this.base, current, sourceOrigin: this.sourceOrigin });
      this.pages = [{ href: current, label: 'Home' }, ...targets];
      this.pageIndex = 0;
    }
    const page = this.pages[this.pageIndex];
    const label = page ? page.label : '';
    this.fixed = await this.client('begin', { playing: this.playing, label });
    if (this.fixed && (this.fixed.hidden || this.fixed.reveal)) {
      this.deps.log.info('showcase prepared', this.project.name, JSON.stringify(this.fixed));
    }
    await this.wait(400);                      // let the tidy-up and any reveal settle
    if (this.destroyed || token !== this.boardToken) return;
    const analysis = await this.client('analyze');
    if (this.destroyed || token !== this.boardToken) return;
    this.board = buildBoard(analysis, this.opts, { frame: this.opts.frame });
    this.analysis = analysis ? { scrolls: !!analysis.scrolls, sections: (analysis.sections || []).length, max: analysis.max } : null;
    this.deps.log.info('showcase board', this.project.name, label || '/', this.board.map(s => s.kind).join(' '));
    this.shotIndex = -1;
    this.pushState();
    this.runBoard(token).catch(err => this.deps.log.warn('showcase board', err.message));
  }

  settleNav() {
    if (this.pendingNav) { const r = this.pendingNav; this.pendingNav = null; r(true); }
  }

  waitForNav(ms) {
    return new Promise(resolve => {
      this.pendingNav = resolve;
      setTimeout(() => { if (this.pendingNav === resolve) { this.pendingNav = null; resolve(false); } }, ms);
    });
  }

  /* ---------- the storyboard ---------- */

  async runBoard(token) {
    let i = 0;
    while (i < this.board.length) {
      if (this.destroyed || token !== this.boardToken) return;
      this.shotIndex = i;
      this.pushState();
      try {
        await this.runShot(this.board[i]);
      } catch (err) {
        this.deps.log.warn('showcase shot', this.board[i].kind, err.message);
      }
      if (this.destroyed || token !== this.boardToken) return;
      if (this.jump !== null) { i = this.jump; this.jump = null; continue; }
      i++;
    }
    if (this.destroyed || token !== this.boardToken) return;
    this.shotIndex = this.board.length;
    await this.advance();
  }

  get cursorOn() { return this.opts.cursor !== 'hidden'; }

  /** Hover, through the devtools protocol — the one way to trigger the
   *  page's own :hover styles from outside. Quiet when it can't. */
  async mouseMove(x, y) {
    const dbg = this.view.webContents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      return true;
    } catch { return false; }
  }

  /** Bring the pointer to an element (glide + real hover). Null if it's gone. */
  async pointTo(ref, ms = CURSOR_GLIDE_MS) {
    const p = await this.client('pointFor', ref);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (this.cursorOn) await this.client('cursorTo', p.x, p.y, ms);
    else await this.wait(Math.min(ms, 300));
    await this.mouseMove(p.x, p.y);
    return p;
  }

  async runShot(shot) {
    switch (shot.kind) {
      case 'establish':
      case 'hold':
        await this.client('hold', shot.ms);
        return;
      case 'nav': {
        for (const [n, r] of shot.refs.entries()) {
          if (this.jump !== null) return;
          const p = await this.pointTo(r, n === 0 ? CURSOR_GLIDE_MS : 520);
          if (!p) continue;
          await this.client('hold', 620);
        }
        if (this.cursorOn) await this.client('cursorAway');
        return;
      }
      case 'button': {
        const p = await this.pointTo(shot.ref);
        if (!p) return;
        await this.client('hold', 900);
        if (this.cursorOn) await this.client('cursorPress');
        await this.client('hold', 700);
        if (this.cursorOn) await this.client('cursorAway');
        return;
      }
      case 'glide':
        await this.client('glideTo', shot.y, { boost: shot.boost || 1, label: shot.caption || '' });
        if (shot.ms > 0) await this.client('hold', shot.ms);
        return;
      case 'detail': {
        const p = await this.pointTo(shot.ref, 600);
        if (!p) return;
        await this.pushIn(p, shot.push || 1.1, 1100);
        await this.client('hold', shot.ms);
        await this.pushOut(750);
        if (this.cursorOn) await this.client('cursorAway');
        return;
      }
      case 'cards':
      case 'wander': {
        const slow = shot.kind === 'wander';
        for (const [n, r] of shot.refs.entries()) {
          if (this.jump !== null) return;
          const p = await this.pointTo(r, n === 0 ? CURSOR_GLIDE_MS : (slow ? 700 : 480));
          if (!p) continue;
          if (slow && shot.labels && shot.labels[n]) await this.client('caption', shot.labels[n], 'Explore');
          await this.client('hold', slow ? 1100 : 520);
        }
        if (this.cursorOn) await this.client('cursorAway');
        return;
      }
      case 'flip': {
        const back = this.opts.frame;
        this.setFrame('phone');
        if (!(await this.wait(900))) { this.setFrame(back); return; }
        await this.client('glideTo', (this.last.max || 0) * 0.75, { boost: 3, maxMs: Math.max(1500, shot.ms - 2200) });
        await this.client('hold', 800);
        this.setFrame(back);
        await this.wait(500);
        return;
      }
      default:
        return;
    }
  }

  /** Walk to a page of the tour: glide the ghost cursor onto its link and
   *  click it for real (hover styles and all); fall back to a plain load when
   *  the link isn't on this page or the click leads nowhere. */
  async goToPage(index) {
    const page = this.pages[index];
    if (!page || this.destroyed) return;
    this.boardToken++;
    this.cutWaiters();
    await this.client('abort');
    await this.pushOut(300);
    this.pageIndex = index;
    this.advancing = true;
    this.board = [];
    this.shotIndex = -1;
    this.pushState();
    try {
      const before = await this.exec('location.href', '');
      let navigated = false;
      if (this.cursorOn) {
        const hrefs = [page.href, page.original].filter(Boolean);
        const target = await this.client('targetFor', hrefs);
        if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
          await this.client('cursorTo', target.x, target.y, CURSOR_GLIDE_MS);
          await sleep(CURSOR_GLIDE_MS + 80);
          // The page may have settled a little more while the cursor glided;
          // aim at where the link is now, not where it was.
          const fresh = await this.client('targetFor', hrefs);
          const aim = fresh && Number.isFinite(fresh.x) && Number.isFinite(fresh.y) ? fresh : target;
          if (aim !== target) await this.client('cursorTo', aim.x, aim.y, 200).then(() => sleep(220));
          const navPromise = this.waitForNav(NAV_WAIT_MS);
          const clicked = await this.realClick(aim.x, aim.y);
          if (!clicked) await this.client('clickAt', aim.x, aim.y);
          await this.client('cursorPress');
          navigated = await navPromise;
          const after = await this.exec('location.href', '');
          if (!navigated && after !== before) navigated = true;
          this.deps.log.info('showcase click', navigated ? 'moved to' : 'did not reach', page.href, clicked ? '(real click)' : '(page click)');
        }
      }
      if (!navigated) {
        this.navToken++;
        this.deps.log.info('showcase load', page.href);
        await this.view.webContents.loadURL(page.href).catch(() => {});
      }
    } finally {
      this.advancing = false;
    }
  }

  async realClick(x, y) {
    const dbg = this.view.webContents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(260);
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return true;
    } catch (err) {
      this.deps.log.warn('showcase click', err.message);
      return false;
    }
  }

  /* ---------- the loop ---------- */

  async tick() {
    if (this.destroyed || this.phase !== 'site' || this.advancing) return;
    const wc = this.view.webContents;
    if (wc.isDestroyed() || wc.isCrashed() || wc.isLoadingMainFrame()) return;
    const st = await this.client('state');
    if (!st || this.destroyed) return;
    this.last = { ...this.last, ...st };
    // A presenter grabbing the wheel pauses the glide; the remote should say
    // so. Only that explicit takeover counts.
    if (st.userPaused && this.playing) {
      this.playing = false;
      this.deps.log.info('showcase paused by the presenter (wheel)');
    }
    if (this.mirror && !this.mirror.webContents.isDestroyed() && !this.mirror.webContents.isLoadingMainFrame()) {
      this.mirror.webContents.executeJavaScript(`window.__nsShowcase && window.__nsShowcase.follow(${Number(st.progress) || 0})`, true).catch(() => {});
    }
    const reelDue = this.sites.length > 1 && this.opts.siteSeconds > 0
      && Date.now() - this.reelStartedAt > this.opts.siteSeconds * 1000;
    if (reelDue) await this.advance(true);
    this.pushState();
  }

  async advance(reelDue = false) {
    if (this.advancing || this.destroyed) return;
    const step = nextStep({
      pages: this.opts.pages, loop: this.opts.loop,
      pageCount: this.pages.length || 1, pageIndex: this.pageIndex,
      siteCount: this.sites.length, siteIndex: this.siteIndex, reelDue,
    });
    this.deps.log.info('showcase step', step.type, this.project.name, this.pageIndex);
    switch (step.type) {
      case 'nextPage': return this.goToPage(this.pageIndex + 1);
      case 'firstPage': return this.goToPage(0);
      case 'nextSite': return this.loadSite(this.siteIndex + 1);
      case 'firstSite': return this.loadSite(0);
      case 'restart': return this.restartPage();
      case 'end':
        this.playing = false;
        if (this.opts.slates) {
          this.showSlate({ kind: 'end', title: this.project.name, url: this.deps.publicUrlFor(this.project) });
        } else {
          await this.client('restart');
        }
        if (this.recording) await this.wait(SLATE_MS).then(() => this.stopRecording());
        return undefined;
      default: return undefined;
    }
  }

  /** Same page, from the top, with a fresh storyboard. */
  async restartPage() {
    this.boardToken++;
    this.cutWaiters();
    await this.client('abort');
    await this.pushOut(300);
    await this.client('restart');
    await this.afterPageReady();
  }

  /* ---------- controls (keys + remote) ---------- */

  onKey(event, input) {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '');
    const mod = input.control || input.meta || input.alt;
    const fire = (action, value) => { event.preventDefault(); this.control(action, value).catch(() => {}); };
    if (key === 'Escape') return fire('close');
    if (mod) return;
    switch (key) {
      case ' ': return fire('toggle');
      case 'ArrowRight': case 'PageDown': return fire('next');
      case 'ArrowLeft': case 'PageUp': return fire('prev');
      case 'n': case 'N': return fire('nextPage');
      case 'p': case 'P': return fire('prevPage');
      case 'ArrowUp': return fire('speed', this.opts.speed + 20);
      case 'ArrowDown': return fire('speed', this.opts.speed - 20);
      case ']': return fire('nextSite');
      case '[': return fire('prevSite');
      case 'b': case 'B': case '.': return fire('blackout');
      case 'f': case 'F': case 'F11': return fire('fullscreen');
      case 'c': case 'C': return fire('cursor', CURSORS[(CURSORS.indexOf(this.opts.cursor) + 1) % CURSORS.length]);
      case 'h': case 'H': case '?': return fire('hint');
      case 'Home': case 'r': case 'R': return fire('restart');
      case '1': case '2': case '3': case '4': case '5': return fire('frame', FRAMES[Number(key) - 1]);
      default: return undefined;
    }
  }

  /** Jump the storyboard: cut the running shot, continue at `index`. */
  async skipTo(index) {
    if (!this.board.length) return;
    this.jump = Math.max(0, Math.min(this.board.length - 1, index));
    this.cutWaiters();
    await this.pushOut(250);
    await this.client('abort');
  }

  async control(action, value) {
    if (this.destroyed) return this.deps.idle();
    switch (action) {
      case 'play': this.playing = true; await this.client('play'); break;
      case 'pause': this.playing = false; await this.client('pause'); break;
      case 'toggle':
        if (this.phase === 'end') { this.playing = true; await this.loadSite(0); break; }
        return this.control(this.playing ? 'pause' : 'play');
      case 'speed': {
        this.opts.speed = normalizeOptions({ speed: value }).speed;
        await this.client('setSpeed', this.opts.speed);
        break;
      }
      case 'next':
        if (this.phase === 'end') { this.playing = true; await this.loadSite(0); break; }
        if (this.shotIndex < this.board.length - 1) await this.skipTo(this.shotIndex + 1);
        else await this.advance();
        break;
      case 'prev':
        if (this.shotIndex > 0) await this.skipTo(this.shotIndex - 1);
        else if (this.pageIndex > 0) await this.goToPage(this.pageIndex - 1);
        else await this.restartPage();
        break;
      case 'shot': {
        const i = Number(value);
        if (Number.isInteger(i)) await this.skipTo(i);
        break;
      }
      case 'nextPage':
        if (this.phase === 'end') { this.playing = true; await this.loadSite(0); break; }
        if (this.pageIndex < this.pages.length - 1) await this.goToPage(this.pageIndex + 1);
        else if (this.sites.length > 1) await this.loadSite((this.siteIndex + 1) % this.sites.length);
        else await this.advance();
        break;
      case 'prevPage':
        if (this.pageIndex > 0) await this.goToPage(this.pageIndex - 1);
        else if (this.sites.length > 1) await this.loadSite((this.siteIndex - 1 + this.sites.length) % this.sites.length);
        else await this.restartPage();
        break;
      case 'nextSite': if (this.sites.length > 1) await this.loadSite((this.siteIndex + 1) % this.sites.length); break;
      case 'prevSite': if (this.sites.length > 1) await this.loadSite((this.siteIndex - 1 + this.sites.length) % this.sites.length); break;
      case 'site': {
        const i = Number(value);
        if (Number.isInteger(i) && this.sites[i]) await this.loadSite(i);
        break;
      }
      case 'restart': await this.restartPage(); break;
      case 'blackout':
        this.blackout = value === undefined ? !this.blackout : !!value;
        this.stage('sc:black', this.blackout);
        this.view.setVisible(!this.blackout && this.phase === 'site');
        if (this.mirror) this.mirror.setVisible(!this.blackout && this.phase === 'site');
        break;
      case 'fullscreen':
        if (!this.win.isDestroyed()) this.win.setFullScreen(value === undefined ? !this.win.isFullScreen() : !!value);
        break;
      case 'frame':
        if (FRAMES.includes(value)) this.setFrame(value);
        break;
      case 'cursor':
        if (CURSORS.includes(value)) {
          this.opts.cursor = value;
          await this.client('setCursor', value);
        }
        break;
      case 'zoom':
        this.opts.zoom = normalizeOptions({ zoom: value }).zoom;
        this.userZoom = this.opts.zoom / 100;
        this.relayout();
        break;
      case 'record':
        if (value === undefined ? !this.recording : !!value) await this.startRecording();
        else await this.stopRecording();
        break;
      case 'hint': this.stage('sc:hint', value === undefined ? 'toggle' : !!value); break;
      case 'focus': if (!this.win.isDestroyed()) this.win.focus(); break;
      case 'close': this.close(); return this.deps.idle();
      default: throw new Error(`Unknown ShowCase action: ${action}`);
    }
    this.pushState();
    return this.publicState();
  }

  /* ---------- layout & camera ---------- */

  /** The stage renderer reports the rectangle it can give the site; the fit
   *  for the chosen frame goes back so it can draw the bezel around it. */
  setStage(rect) {
    this.stageRect = rect;
    this.relayout();
  }

  setFrame(frame) {
    if (!FRAMES.includes(frame)) return;
    this.opts.frame = frame;
    this.pushed = null;
    this.relayout();
  }

  relayout() {
    if (this.destroyed || !this.stageRect) return;
    const box = fitDevice(this.opts.frame, this.stageRect);
    this.frameBox = box;
    this.pushed = null;
    this.view.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
    try { this.view.webContents.setZoomFactor(box.scale * this.userZoom); } catch { /* not loaded yet */ }
    if (box.kind === 'duo') {
      this.ensureMirror();
      this.mirror.setBounds({ x: box.phone.x, y: box.phone.y, width: box.phone.width, height: box.phone.height });
      try { this.mirror.webContents.setZoomFactor(box.phone.scale * this.userZoom); } catch { /* not loaded yet */ }
      this.mirror.setVisible(!this.blackout && this.phase === 'site');
    } else {
      this.dropMirror();
    }
    this.stage('sc:frame', box);
  }

  /** Dolly in on a point of the page: the view (and its bezel) grow around
   *  the focus so it stays put on screen, and the page zooms with them — no
   *  reflow, the same layout, closer. */
  async pushIn(p, k, ms) {
    if (this.destroyed || !this.frameBox || !(k > 1)) return;
    const box = this.frameBox;
    const z0 = box.scale * this.userZoom;
    const focus = { x: p.x * z0, y: p.y * z0 };
    const frames = Math.max(2, Math.round(ms / (1000 / PUSH_FPS)));
    for (let i = 1; i <= frames; i++) {
      if (this.destroyed || this.jump !== null || this.frameBox !== box) return;
      while (!this.playing && !this.destroyed && this.jump === null) await sleep(80);
      const kk = 1 + (k - 1) * ease(i / frames);
      this.applyPush(box, focus, kk);
      await sleep(1000 / PUSH_FPS);
    }
    this.pushed = { box, focus, k };
  }

  async pushOut(ms) {
    const pushed = this.pushed;
    if (!pushed || this.destroyed) return;
    this.pushed = null;
    const frames = Math.max(2, Math.round(ms / (1000 / PUSH_FPS)));
    for (let i = 1; i <= frames; i++) {
      if (this.destroyed || this.frameBox !== pushed.box) return;
      const kk = pushed.k - (pushed.k - 1) * ease(i / frames);
      this.applyPush(pushed.box, pushed.focus, kk);
      await sleep(1000 / PUSH_FPS);
    }
    this.applyPush(pushed.box, pushed.focus, 1);
  }

  applyPush(box, focus, k) {
    const b = pushBox(box, focus, k);
    this.view.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    try { this.view.webContents.setZoomFactor(box.scale * this.userZoom * k); } catch { /* gone */ }
    this.stage('sc:frame', { ...b, moving: k !== 1 });
  }

  /* ---------- the duo mirror ---------- */

  ensureMirror() {
    if (this.mirror || this.destroyed) return;
    const { WebContentsView } = lazyElectron();
    this.mirror = new WebContentsView({
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: 'showcase-mirror',   // its own zoom, apart from the main view's
        backgroundThrottling: false,
      },
    });
    const wc = this.mirror.webContents;
    wc.setUserAgent(wc.getUserAgent() + ' NightShyftShowCase');
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', event => event.preventDefault());
    wc.on('dom-ready', async () => {
      if (!this.mirror || wc.isDestroyed()) return;
      await wc.executeJavaScript(this.deps.clientSource + '\n;true', true).catch(() => {});
      await wc.executeJavaScript(`window.__nsShowcase && (window.__nsShowcase.configure(${JSON.stringify(this.clientConfig(true))}), window.__nsShowcase.begin({ playing: true, label: '' }))`, true).catch(() => {});
    });
    this.win.contentView.addChildView(this.mirror);
    this.mirror.setVisible(false);
    const url = this.view.webContents.getURL();
    if (url) wc.loadURL(url).catch(() => {});
  }

  dropMirror() {
    if (!this.mirror) return;
    const m = this.mirror;
    this.mirror = null;
    try { this.win.contentView.removeChildView(m); } catch { /* window gone */ }
    try { m.webContents.close(); } catch { /* already closed */ }
  }

  mirrorFollowUrl() {
    if (!this.mirror || this.mirror.webContents.isDestroyed()) return;
    const url = this.view.webContents.getURL();
    if (url && this.mirror.webContents.getURL() !== url) this.mirror.webContents.loadURL(url).catch(() => {});
  }

  /* ---------- recording ---------- */

  async startRecording() {
    if (this.recording || this.destroyed || this.win.isDestroyed()) return;
    const dir = this.deps.recordDir();
    fs.mkdirSync(dir, { recursive: true });
    this.recording = { mime: '', path: '', bytes: 0, stream: null, done: false, startedAt: Date.now() };
    this.stage('sc:hint', false);
    this.stage('sc:record', { on: true });
    this.pushState();
  }

  /** Bytes from the stage's recorder; the first message names the format. */
  onRecordChunk(msg) {
    const rec = this.recording;
    if (!rec) return false;
    if (msg && msg.start) {
      rec.mime = String(msg.mime || '');
      rec.path = path.join(this.deps.recordDir(), recordingName(this.sites.map(s => s.name), rec.mime));
      rec.stream = fs.createWriteStream(rec.path);
      this.deps.log.info('showcase recording', rec.path, rec.mime);
      this.pushState();
      return true;
    }
    if (msg && msg.error) {
      this.deps.log.warn('showcase recording failed', msg.error);
      rec.done = true;
      rec.error = String(msg.error);
      if (rec.stream) rec.stream.end();
      this.recording = null;
      this.lastRecording = { error: rec.error };
      this.pushState();
      return true;
    }
    if (msg && msg.done) {
      rec.done = true;
      const finish = () => {
        this.lastRecording = { path: rec.path, bytes: rec.bytes, mime: rec.mime, seconds: Math.round((Date.now() - rec.startedAt) / 1000) };
        this.recording = null;
        this.deps.log.info('showcase recording saved', rec.path, rec.bytes, 'bytes');
        if (this.stopResolve) { this.stopResolve(); this.stopResolve = null; }
        this.pushState();
      };
      if (rec.stream) rec.stream.end(finish); else finish();
      return true;
    }
    const buf = Buffer.isBuffer(msg) ? msg : (msg instanceof Uint8Array || msg instanceof ArrayBuffer ? Buffer.from(msg) : null);
    if (buf && rec.stream && !rec.done) {
      rec.bytes += buf.length;
      rec.stream.write(buf);
    }
    return true;
  }

  stopRecording() {
    const rec = this.recording;
    if (!rec || rec.done) return Promise.resolve();
    return new Promise(resolve => {
      this.stopResolve = resolve;
      this.stage('sc:record', { on: false });
      // The stage flushes within a second; don't hold a closing window hostage.
      setTimeout(() => { if (this.stopResolve === resolve) { this.stopResolve = null; this.onRecordChunk({ done: true }); } }, 2500);
    });
  }

  /* ---------- state ---------- */

  hello() {
    return {
      brand: this.deps.brand, frame: this.opts.frame, cursor: this.opts.cursor,
      music: this.opts.music ? { path: this.opts.music, volume: this.opts.musicVolume / 100 } : null,
    };
  }

  publicState() {
    const page = this.pages[this.pageIndex];
    const rec = this.recording;
    return {
      active: true,
      phase: this.phase,
      playing: this.playing,
      blackout: this.blackout,
      fullscreen: !this.win.isDestroyed() && this.win.isFullScreen(),
      style: this.opts.style,
      speed: this.opts.speed,
      frame: this.opts.frame,
      cursor: this.opts.cursor,
      zoom: this.opts.zoom,
      pagesOn: this.opts.pages,
      site: { id: this.project.id, name: this.project.name },
      siteIndex: this.siteIndex,
      siteCount: this.sites.length,
      sites: this.sites.map(s => ({ id: s.id, name: s.name })),
      page: { index: this.pageIndex, count: this.pages.length || 1, label: page ? page.label : '', title: this.last.title || '' },
      board: this.board.map(s => ({ kind: s.kind, label: s.label })),
      shot: this.shotIndex,
      fixed: this.fixed,
      progress: Math.max(0, Math.min(1, Number(this.last.progress) || 0)),
      busy: this.advancing,
      scroll: { y: Number(this.last.y) || 0, max: Number(this.last.max) || 0 },
      recording: rec ? { on: true, path: rec.path, bytes: rec.bytes, mime: rec.mime, seconds: Math.round((Date.now() - rec.startedAt) / 1000) } : null,
      lastRecording: this.lastRecording || null,
    };
  }

  pushState() {
    if (this.destroyed) return;
    this.deps.onState(this.publicState());
  }
}

/** The one ShowCase the app can run. */
class Showcase {
  /**
   * @param {{ stagePath, clientPath, preloadPath, urlFor, publicUrlFor, sourceUrlFor, recordDir, onState, anchorDisplay, brand, log }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.show = null;
    this.clientSource = null;
  }

  displays() {
    const { screen } = lazyElectron();
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `Display ${i + 1}`,
      primary: d.id === primary.id,
      width: d.bounds.width, height: d.bounds.height,
      internal: !!d.internal,
    }));
  }

  /** Start a show (closing any running one). `sites` are registry projects
   *  in the order they should play. */
  start(sites, rawOptions) {
    if (!Array.isArray(sites) || !sites.length) throw new Error('Pick at least one site to present.');
    if (this.show) this.show.close();
    if (!this.clientSource || process.env.SLURP_DEV) this.clientSource = fs.readFileSync(this.deps.clientPath, 'utf8');
    const options = normalizeOptions(rawOptions);
    this.show = new ShowcaseWindow(sites, options, {
      stagePath: this.deps.stagePath,
      preloadPath: this.deps.preloadPath,
      clientSource: this.clientSource,
      urlFor: this.deps.urlFor,
      publicUrlFor: this.deps.publicUrlFor || (() => ''),
      sourceUrlFor: this.deps.sourceUrlFor || (() => ''),
      recordDir: this.deps.recordDir || (() => path.join(require('os').homedir(), 'Local Dev Studio', 'Reels')),
      anchorDisplay: this.deps.anchorDisplay,
      brand: this.deps.brand,
      log: this.deps.log,
      idle: idleState,
      onState: state => this.deps.onState(state),
      onClosed: show => {
        if (this.show === show) this.show = null;
        this.deps.onState({ ...idleState(), lastRecording: show.lastRecording || null });
      },
    });
    this.deps.log.info('showcase started', sites.map(s => s.name).join(', '), JSON.stringify(options));
    return this.show.publicState();
  }

  control(action, value) {
    if (!this.show) {
      if (action === 'close') return idleState();
      throw new Error('Nothing is being presented right now.');
    }
    return this.show.control(action, value);
  }

  state() {
    return this.show ? this.show.publicState() : idleState();
  }

  forSender(webContents) {
    return this.show && !this.show.destroyed && this.show.stageId === webContents.id ? this.show : null;
  }

  closeAll() {
    if (this.show) this.show.close();
  }
}

module.exports = {
  Showcase, ShowcaseWindow,
  normalizeOptions, filterNavTargets, buildBoard, nextStep, fitDevice, pushBox, idleState, recordingName,
  DEFAULTS, STYLES, STYLE_SPEC, STYLE_BEATS, FRAMES, CURSORS, DEVICES,
  clientPath: path.join(__dirname, '..', 'renderer', 'showcase-client.js'),
};
