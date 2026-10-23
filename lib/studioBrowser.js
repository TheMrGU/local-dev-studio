// lib/studioBrowser.js — a dedicated browsing window per project: the place
// where Local Dev Studio *looks at* a site.
//
// Not an editor and not devtools: custom top chrome (back/forward, the path,
// viewport presets, a version picker, the annotate toggle, screenshot, console
// drawer) around a WebContentsView showing the hosted/proxied site — with the
// review overlay injected by the server exactly as in any external browser.
// The chrome is an ordinary file:// renderer speaking the same preload bridge
// as the main window; the site view is sandboxed, untrusted content.
//
// Console and network capture happen main-side ('console-message' events and
// session.webRequest) — nothing extra is ever injected into the page, per the
// serve-time-only invariant.
const path = require('path');
const fs = require('fs');
const { BrowserWindow, WebContentsView, clipboard, session, shell } = require('electron');

const RING_MAX = 500;      // console entries kept per window
const TAIL_MAX = 20;       // entries attached to an annotation
const CHROME_H = 46;       // matches --titlebar-h / TITLEBAR_HEIGHT

// The overlay reads this marker to know it's inside Studio Browser (its
// popup-size buttons are superseded by the viewport presets here).
const UA_MARKER = 'SiteSlurpStudioBrowser';

const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
const safeName = name => String(name || 'site')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')   // eslint-disable-line no-control-regex
  .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'site';

const LEVELS = { 0: 'log', 1: 'log', 2: 'warn', 3: 'error', verbose: 'log', info: 'log', log: 'log', warning: 'warn', warn: 'warn', error: 'error' };

/** One Studio Browser window. */
class StudioBrowser {
  /**
   * @param {object} project registry entry
   * @param {{url: string, canPin: boolean, deps: object}} opts
   */
  constructor(project, { url, canPin, deps }) {
    this.project = project;
    this.baseUrl = url.replace(/\/$/, '');
    this.canPin = canPin;
    this.deps = deps;
    this.buffer = [];        // { ts, kind: 'error'|'warn'|'log'|'network', text }
    this.destroyed = false;

    this.win = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: '#0A0A0B',
      title: `${project.name} — Studio Browser`,
      show: false,
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' }
        : {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#0A0A0B', symbolColor: '#8E8E96', height: CHROME_H },
        }),
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });

    this.chromeId = this.win.webContents.id;

    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const wc = this.view.webContents;
    this.viewId = wc.id;
    wc.setUserAgent(wc.getUserAgent() + ' ' + UA_MARKER);
    this.win.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: CHROME_H, width: 1360, height: 900 - CHROME_H });

    // ---- console + load-failure capture (main-side, nothing injected) ----
    wc.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySource) => {
      const structured = event && typeof event === 'object' && 'message' in event;
      const level = structured ? event.level : legacyLevel;
      const message = structured ? event.message : legacyMessage;
      const line = structured ? event.lineNumber : legacyLine;
      const source = structured ? event.sourceId : legacySource;
      const where = source ? ` (${String(source).split('/').pop()}${line ? ':' + line : ''})` : '';
      this.push(LEVELS[level] || 'log', String(message) + where);
    });
    wc.on('did-fail-load', (event, code, description, failedUrl, isMainFrame) => {
      if (code === -3) return; // aborted — a normal navigation interrupting a load
      this.push('network', `failed to load ${failedUrl || 'page'} — ${description || code}`);
    });

    // ---- navigation state pushed to the chrome ----
    const pushState = () => this.sendState();
    for (const evt of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) {
      wc.on(evt, pushState);
    }
    wc.on('page-title-updated', pushState);

    // The view browses the project; anything popping out or leaving for the
    // wider web goes to the real default browser instead.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (this.sameOrigin(target)) { wc.loadURL(target).catch(() => {}); return { action: 'deny' }; }
      if (/^https?:/.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, target) => {
      if (this.sameOrigin(target)) return;
      event.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    });

    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('closed', () => {
      this.destroyed = true;
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* already gone */ }
      this.deps.onClosed(this);
    });

    this.win.loadFile(deps.chromePath);
    wc.loadURL(this.baseUrl + '/').catch(() => {});
  }

  sameOrigin(target) {
    try {
      const a = new URL(target);
      const b = new URL(this.baseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]', '::1'];
      return a.port === b.port && local.includes(a.hostname);
    } catch { return false; }
  }

  push(kind, text) {
    const entry = { ts: new Date().toISOString().slice(11, 19), kind, text: String(text).slice(0, 500) };
    this.buffer.push(entry);
    if (this.buffer.length > RING_MAX) this.buffer.splice(0, this.buffer.length - RING_MAX);
    if (!this.destroyed) this.win.webContents.send('sb:console', entry);
  }

  async sendState() {
    if (this.destroyed) return;
    const wc = this.view.webContents;
    let pinnedId = null;
    if (this.canPin) {
      try {
        const cookies = await wc.session.cookies.get({ url: this.baseUrl, name: '__ss_version' });
        pinnedId = cookies.length ? cookies[0].value : null;
      } catch { /* cookie store unavailable mid-teardown */ }
    }
    if (this.destroyed) return;
    let pathShown = '/';
    try {
      const u = new URL(wc.getURL());
      pathShown = u.pathname + u.search;
    } catch { /* not navigated yet */ }
    this.win.webContents.send('sb:state', {
      path: pathShown,
      canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
      canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      loading: wc.isLoading(),
      pinnedId,
    });
  }

  hello() {
    return {
      projectId: this.project.id,
      name: this.project.name,
      url: this.baseUrl,
      canPin: this.canPin,
      attachOnly: !!this.project.attachOnly,
    };
  }

  layout({ x, y, width, height }) {
    const n = v => Math.max(0, Math.round(Number(v) || 0));
    this.view.setBounds({ x: n(x), y: n(y), width: Math.max(1, n(width)), height: Math.max(1, n(height)) });
  }

  nav(action) {
    const wc = this.view.webContents;
    const history = wc.navigationHistory;
    if (action === 'back') (history ? history.goBack() : wc.goBack());
    else if (action === 'forward') (history ? history.goForward() : wc.goForward());
    else if (action === 'reload') wc.reload();
  }

  setAnnotating(on) {
    return this.view.webContents.executeJavaScript(
      `!!(window.__ssBridge && window.__ssBridge.setAnnotating(${on ? 'true' : 'false'}))`, true,
    ).catch(() => false);
  }

  pin(versionId) {
    const id = String(versionId || 'live');
    if (!/^(live|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?)$/.test(id)) {
      throw new Error('That is not a snapshot id.');
    }
    return this.view.webContents.loadURL(`${this.baseUrl}/?v=${encodeURIComponent(id)}`);
  }

  /** Full-page PNG via the devtools protocol — the only way to capture beyond
   *  the viewport without resizing the page out from under the user. */
  async screenshot() {
    const wc = this.view.webContents;
    const dbg = wc.debugger;
    const wasAttached = dbg.isAttached();
    if (!wasAttached) dbg.attach('1.3');
    try {
      const { data } = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
      });
      const dir = this.deps.manualShotsDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${safeName(this.project.name)}-${stamp()}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    } finally {
      if (!wasAttached) { try { dbg.detach(); } catch { /* view closed mid-shot */ } }
    }
  }

  /** The console entries an annotation should carry: the last 20, but only
   *  when something in the buffer is actually wrong — a clean console attaches
   *  nothing. */
  consoleTail() {
    if (!this.buffer.some(e => e.kind === 'error' || e.kind === 'network')) return null;
    return this.buffer.slice(-TAIL_MAX).map(e => `[${e.ts}] ${e.kind} ${e.text}`);
  }

  /** Ask the overlay for the current selection, format it with the shared
   *  per-annotation renderer, and put it on the clipboard. */
  async copyForAgent() {
    const payload = await this.view.webContents.executeJavaScript(
      'window.__ssBridge ? window.__ssBridge.agentContext() : null', true,
    ).catch(() => null);
    if (!payload || !payload.context) {
      throw new Error('Select an element first — turn Annotate on and click the thing you mean.');
    }
    const markdown = this.deps.agentBlock(this.project, payload, this.consoleTail());
    clipboard.writeText(markdown);
    return { chars: markdown.length };
  }
}

/** All Studio Browser windows, keyed by project. */
class StudioBrowsers {
  /**
   * @param {{ chromePath: string, preloadPath: string,
   *   manualShotsDir: () => string,
   *   agentBlock: (project, payload, consoleTail) => string,
   *   log: {info: Function, warn: Function} }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.byProject = new Map(); // projectId -> StudioBrowser
    this.byChrome = new Map();  // chrome webContents.id -> StudioBrowser
    this.webRequestHooked = false;
  }

  /** Open (or focus) the window for a project. The caller has already hosted
   *  the project and enabled review mode — this only owns the window. */
  open(project, url, { canPin }) {
    const existing = this.byProject.get(project.id);
    if (existing && !existing.destroyed) {
      existing.win.focus();
      return existing;
    }
    const browser = new StudioBrowser(project, {
      url,
      canPin,
      deps: {
        chromePath: this.deps.chromePath,
        preloadPath: this.deps.preloadPath,
        manualShotsDir: this.deps.manualShotsDir,
        agentBlock: this.deps.agentBlock,
        onClosed: b => {
          this.byProject.delete(b.project.id);
          this.byChrome.delete(b.chromeId);
        },
      },
    });
    this.byProject.set(project.id, browser);
    this.byChrome.set(browser.chromeId, browser);
    this.hookWebRequest();
    this.deps.log.info('studio browser opened', project.name, url);
    return browser;
  }

  /** Responses ≥400 count as console material. One session-wide listener
   *  (webRequest allows exactly one), dispatched to whichever window owns the
   *  webContents that made the request. */
  hookWebRequest() {
    if (this.webRequestHooked) return;
    this.webRequestHooked = true;
    session.defaultSession.webRequest.onCompleted(details => {
      if (!details || !details.statusCode || details.statusCode < 400) return;
      for (const browser of this.byProject.values()) {
        if (browser.destroyed || browser.viewId !== details.webContentsId) continue;
        browser.push('network', `HTTP ${details.statusCode} ${details.method} ${details.url}`);
        return;
      }
    });
  }

  forSender(webContents) {
    return this.byChrome.get(webContents.id) || null;
  }

  forProject(projectId) {
    const browser = this.byProject.get(projectId);
    return browser && !browser.destroyed ? browser : null;
  }

  /** Console lines to attach to an annotation of this project, or null. */
  consoleTailFor(projectId) {
    const browser = this.forProject(projectId);
    return browser ? browser.consoleTail() : null;
  }

  closeAll() {
    for (const browser of [...this.byProject.values()]) {
      if (!browser.destroyed) browser.win.close();
    }
  }
}

module.exports = { StudioBrowsers, UA_MARKER };
