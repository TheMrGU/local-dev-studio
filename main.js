// SiteSlurp — capture any website, extract it into editable files, host it locally.
const { app, BrowserWindow, ipcMain, shell, dialog, screen, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const log = require('./lib/logger');
const settings = require('./lib/settings');
const browsers = require('./lib/browsers');
const { captureSite, findSingleFile, nameFromUrl, normalizeUrl, writeManifest, readManifest } = require('./lib/capture');
const { extractSite, uniqueOutDir } = require('./lib/extract');
const { HostManager } = require('./lib/server');
const { TunnelManager } = require('./lib/tunnel');
const runtimes = require('./lib/runtimes');
const { runOnce } = require('./lib/runner');
const { scanPalette, applyColor, undoColor, listUndo, parseColor, toHex } = require('./lib/palette');
const versions = require('./lib/versions');
const { diffSegments } = require('./lib/diff');
const { fixVideos } = require('./lib/videofix');
const { zipFolder } = require('./lib/zip');
const { listLibrary, describeLocal, invalidate } = require('./lib/library');
const projects = require('./lib/projects');
const reviews = require('./lib/reviews');
const calibration = require('./lib/calibration');
const { exportReview, renderAnnotation } = require('./lib/reviewExport');
const { ReviewManager } = require('./lib/review');
const { StudioBrowsers } = require('./lib/studioBrowser');
const { captureAnnotationShots } = require('./lib/shots');
const { locateSource } = require('./lib/sourceline');
const { makeThumb } = require('./lib/thumbs');
const { attachAccelerators, zoomBy } = require('./lib/accelerators');
const { findEditor } = require('./lib/editor');

// This app shipped as "SiteSnap" through 1.x, and the rename moved the profile
// folder. Copy the old profile (settings, projects, reviews) into the new
// location once, before anything below opens it, so nothing is lost.
try {
  const newData = app.getPath('userData');
  const oldData = path.join(app.getPath('appData'), 'SiteSnap');
  if (!fs.existsSync(path.join(newData, 'settings.json'))
      && fs.existsSync(path.join(oldData, 'settings.json'))) {
    fs.cpSync(oldData, newData, { recursive: true, force: false });
  }
} catch { /* a failed migration must not stop the launch */ }

const hosts = new HostManager();
const tunnels = new TunnelManager({
  binDir: path.join(app.getPath('userData'), 'bin'),
  onChange: (dir, state) => {
    send('share:state', { dir, ...state });
    // A tunnel dying on its own (network drop, cloudflared crash) has to reach
    // the card, not just the event stream a closed panel missed.
    if (state.status === 'failed' || state.status === 'stopped') send('ui:refresh');
  },
});
let win = null;
let job = null;   // { name, controller } — one long-running pipeline at a time

// Kept in step with --titlebar-h in renderer/style.css: the custom bar and the
// slot Windows paints its buttons into have to be exactly the same height.
const TITLEBAR_HEIGHT = 46;

// ---------- review mode ----------
// The overlay in the user's browser talks HTTP to the hosted site's own
// server; ReviewManager routes those calls and this wiring supplies the few
// Electron-touching pieces: screenshots, source mapping, shell access.
const reviewManager = new ReviewManager({
  projects,
  capturesRoot: () => settings.load().capturesRoot,
  exportReview,
  overlayPath: path.join(__dirname, 'renderer', 'review-overlay.js'),
  onAnnotationSaved: (project, annotation) => enrichAnnotation(project, annotation),
  onExported: (project, result) => {
    log.info('review exported', project.name, result.folder);
    send('review:exported', { project: project.name, folder: result.folder });
    // Complaints heard in 3+ reviews are offered for promotion to a standing
    // preference — the user decides, we only notice the repetition.
    const already = calibration.load().standingPreferences.map(p => p.toLowerCase());
    const candidates = reviews.recurringGlobals(project.id)
      .filter(c => !already.includes(c.text.toLowerCase()))
      .slice(0, 3);
    if (candidates.length) send('review:promote', { candidates });
    send('ui:refresh');
  },
  onAnchor: (project, annotation) => {
    try {
      const shot = annotation.context.screenshotElement
        ? path.join(reviews.shotsDir(project.id), path.basename(annotation.context.screenshotElement))
        : null;
      calibration.anchorFromAnnotation(project.name, annotation, shot);
      log.info('calibration anchor added', annotation.id);
    } catch (err) {
      log.warn('anchor failed', annotation.id, err.message);
    }
  },
  onReveal: folder => shell.openPath(folder),
  onReferenceHost: async (target, pick) => {
    const port = await hosts.start(target.path, target.port, {
      liveReload: false, runtime: projects.runtimeFor(target), name: target.name,
    });
    if (port !== target.port) projects.update(target.id, { port });
    reviewManager.enable(target.path, target.id, { pick });
    return `http://localhost:${port}/`;
  },
  onDone: (project, dir) => {
    log.info('review done', dir);
    send('ui:refresh');
  },
});
hosts.reviewRouter = dir => reviewManager.forDir(dir);
// "/" serves the project's chosen entry page; the server falls back to its own
// resolution when nothing is chosen or the chosen file is gone.
hosts.entryFor = dir => {
  const project = projects.byPath(dir);
  return project ? project.entryFile : null;
};
// Pinned serving (?v=<id>): the server resolves files through the snapshot
// engine while a pin cookie is present. Static/extracted projects only — a
// dev server's rendered output isn't a function of its files, so pinning a
// command runtime would be a lie.
hosts.versionsRouter = dir => {
  const project = projects.byPath(dir);
  if (!project) return null;
  const runtime = projects.runtimeFor(project);
  if (runtime.kind === 'command') return null;
  // Built-output projects serve from a subfolder; snapshot paths are rooted at
  // the project folder, so requests get the prefix back.
  const prefix = runtime.root ? String(runtime.root).replace(/\\/g, '/').replace(/\/+$/, '') + '/' : '';
  return {
    meta: id => versions.getSnapshot(project, id, { optional: true }),
    fileAt: (id, rel) => versions.fileAt(project, id, prefix + rel),
  };
};
// Auto-snapshot follows hosting: edits only matter while the site is being
// looked at, and that is exactly when the folder is hosted.
hosts.onHostChange = (dir, hosted) => {
  if (!hosted) { versions.autoUnwatch(dir); return; }
  const project = projects.byPath(dir);
  if (project && project.autoSnapshot) versions.autoWatch(project);
};
// Proxy surprises (upstream CSP rewrites) belong in the log, as WARNs.
hosts.onWarn = message => log.warn('proxy', message);

// ---------- studio browser ----------
// One dedicated window per project: nav chrome, viewport presets, version
// picker, console capture, "Copy for agent". The window module owns the
// Electron pieces; the annotation-block formatting is shared with REVIEW.md.
const studioBrowsers = new StudioBrowsers({
  chromePath: path.join(__dirname, 'renderer', 'studio-browser.html'),
  preloadPath: path.join(__dirname, 'preload.js'),
  manualShotsDir: () => path.join(app.getPath('userData'), 'shots', 'manual'),
  log,
  // "Copy for agent": the current selection rendered exactly like a REVIEW.md
  // annotation — same formatter, plus file:line and the console tail.
  agentBlock: (project, payload, consoleTail) => {
    const runtime = projects.runtimeFor(project);
    const devServer = runtime.kind === 'command';
    const ctx = { ...(payload.context || {}) };
    if (!project.attachOnly && (payload.scope || 'element') === 'element') {
      try {
        const located = locateSource(project.path, { context: ctx }, {
          entry: project.entryFile, generated: devServer,
        });
        Object.assign(ctx, located);
      } catch { /* an unlocatable element still copies fine */ }
    }
    if (consoleTail) ctx.consoleTail = consoleTail;
    const input = {
      rating: null, severity: 'should-fix', axes: [], why: '', want: '',
      ...(payload.input || {}),
    };
    return renderAnnotation(
      { scope: payload.scope || 'element', context: ctx, input },
      id => { const p = id && projects.byId(id); return p ? p.name : null; },
      { devServer },
    );
  },
});

/** Fill in what the overlay can't know: source file/line from the served
 *  files, screenshots from an offscreen render, and — when the note was made
 *  in a Studio Browser window whose console holds errors — the console tail. */
async function enrichAnnotation(project, annotation) {
  try {
    if (annotation.scope === 'element' || annotation.scope === 'region') {
      // Command/attach projects serve generated pages: the URL is a route, not
      // a file, so only a unique source match counts (sourceline honesty).
      const generated = projects.runtimeFor(project).kind === 'command';
      const located = project.attachOnly
        ? { sourceFile: '', sourceLine: null }
        : locateSource(project.path, annotation, { entry: project.entryFile, generated });
      const port = hosts.portFor(project.path);
      const patch = { ...located };
      const tail = studioBrowsers.consoleTailFor(project.id);
      if (tail) patch.consoleTail = tail;
      if (port) {
        const shots = await captureAnnotationShots(annotation, {
          port, shotsDir: reviews.shotsDir(project.id),
        });
        if (shots) {
          if (shots.el) patch.screenshotElement = 'shots/' + shots.el;
          if (shots.ctx) patch.screenshotContext = 'shots/' + shots.ctx;
        }
      }
      reviews.updateAnnotation(project.id, annotation.id, { context: patch });
    } else {
      // Page/site notes carry no element to shoot, but a console full of
      // errors is still context an agent wants.
      const tail = studioBrowsers.consoleTailFor(project.id);
      if (tail) reviews.updateAnnotation(project.id, annotation.id, { context: { consoleTail: tail } });
    }
  } catch (err) {
    log.warn('annotation enrich failed', annotation.id, err.message);
  }
}

app.setAppUserModelId('com.nightshyft.siteslurp');

// ---------- helpers ----------
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const runLog = text => send('run:log', String(text).replace(/\s+$/, ''));

// A dev server takes seconds to minutes to come up, so the card follows it live
// instead of freezing on "Host" until the first compile finishes.
hosts.onRuntimeChange = (dir, state) => {
  send('runtime:state', { dir, ...state });
  if (state.status === 'ready' || state.status === 'failed') {
    log.info('runtime', state.status, dir, state.message);
    send('ui:refresh');
  }
  // The first time a generated site is actually up is the first time there is
  // a homepage to photograph — until then its card can only show a letter.
  if (state.status !== 'ready') return;
  const project = projects.byPath(dir);
  const port = hosts.portFor(dir);
  if (!project || project.kind !== 'local' || !port) return;
  if (fs.existsSync(projects.thumbPath(project.id))) return;
  makeThumb(dir, projects.thumbPath(project.id), { url: `http://localhost:${port}/` })
    .then(made => { if (made) send('ui:refresh'); })
    .catch(() => {});
};

function isInRoot(dir) {
  const root = path.resolve(settings.load().capturesRoot);
  const target = path.resolve(dir);
  return target !== root && target.startsWith(root + path.sep);
}

/** Long operations write into the user's folders — keep them inside the library. */
function assertInRoot(dir, what = 'That folder') {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`${what} is missing.`);
  // A folder we're already hosting stays valid even if the root was changed since.
  if (!isInRoot(dir) && !hosts.portFor(dir)) {
    throw new Error(`${what} is outside the captures folder and was refused.`);
  }
  return path.resolve(dir);
}

/** The looser gate for read-and-serve operations (hosting, thumbnails, opening):
 *  the captures root plus every folder the user explicitly registered as a
 *  project. Content-mutating operations (palette, video fix, delete, zip) keep
 *  the strict in-root rule — SiteSlurp edits its own captures, not your repos. */
function assertManaged(dir, what = 'That folder') {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`${what} is missing.`);
  if (!isInRoot(dir) && !hosts.portFor(dir) && !projects.byPath(dir)) {
    throw new Error(`${what} is not in the library and was refused.`);
  }
  return path.resolve(dir);
}

/** Windows refuses to recycle a folder while a closing file handle lingers. */
async function trashWithRetry(target) {
  for (let attempt = 0; ; attempt++) {
    try {
      await shell.trashItem(target);
      return;
    } catch (err) {
      if (attempt >= 2) {
        throw new Error('Could not move the folder to the system trash — close anything using it '
          + '(a file manager, an editor, a browser tab) and try again.');
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
}

function claimJob(name) {
  if (job) throw new Error(`${job.name} is already running. Wait for it to finish or cancel it.`);
  job = { name, controller: new AbortController() };
  send('run:busy', { busy: true, name });
  return job;
}

function releaseJob() {
  job = null;
  send('run:busy', { busy: false, name: '' });
}

async function resolveBrowser() {
  const current = settings.load();
  if (current.browserPath && browsers.isExe(current.browserPath)) return current.browserPath;
  const detected = await browsers.pickDefault();
  if (detected) {
    log.info('auto-selected browser', detected);
    settings.save({ browserPath: detected });
  }
  return detected;
}

async function environment() {
  const current = settings.load();
  const installed = await browsers.detect();
  const singleFile = findSingleFile(current.singleFilePath);
  let rootWritable = false;
  try {
    fs.mkdirSync(current.capturesRoot, { recursive: true });
    fs.accessSync(current.capturesRoot, fs.constants.W_OK);
    rootWritable = true;
  } catch { /* reported to the user below */ }

  return {
    browser: {
      path: current.browserPath,
      ok: browsers.isExe(current.browserPath),
      name: browsers.friendlyName(current.browserPath),
      installed,
    },
    singleFile: {
      path: singleFile || '',
      ok: !!singleFile,
      bundled: !current.singleFilePath,
    },
    capturesRoot: { path: current.capturesRoot, ok: rootWritable },
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    logPath: log.logPath(),
  };
}

// ---------- pipelines ----------
async function runCapture(opts) {
  const { controller } = claimJob('A capture');
  const started = Date.now();
  try {
    const current = settings.load();
    const url = normalizeUrl(opts.url);
    const singleFilePath = findSingleFile(current.singleFilePath);
    if (!singleFilePath) throw new Error('The bundled page-capture engine is missing. Reinstall SiteSlurp.');
    const browserPath = await resolveBrowser();
    if (!browserPath) {
      throw new Error('No Chromium browser found. Install Google Chrome or Microsoft Edge, then set it in Settings.');
    }
    fs.mkdirSync(current.capturesRoot, { recursive: true });

    // Remember the options for next time.
    settings.save({
      crawl: !!opts.crawl, depth: opts.depth, mobile: !!opts.mobile,
      fixVideos: opts.fixVideos !== false, headless: opts.headless !== false,
      stripBanners: !!opts.stripBanners, waitDelay: opts.waitDelay || 0,
    });

    send('run:status', { phase: 'capture', msg: `Capturing ${url}` });
    log.info('capture start', url, JSON.stringify({ crawl: opts.crawl, depth: opts.depth, mobile: opts.mobile }));

    const rawDir = await captureSite({
      url,
      name: opts.name || nameFromUrl(url),
      depth: opts.depth,
      mobile: opts.mobile,
      crawl: opts.crawl,
      headless: opts.headless,
      stripBanners: opts.stripBanners,
      waitDelay: opts.waitDelay,
      browserPath,
      singleFilePath,
      outRoot: current.capturesRoot,
      signal: controller.signal,
    }, runLog);

    if (controller.signal.aborted) throw Object.assign(new Error('Capture canceled.'), { canceled: true });

    send('run:status', { phase: 'extract', msg: 'Extracting into editable files' });
    const outDir = uniqueOutDir(rawDir + '_extracted');
    // suppressAuto: extraction churn must not read as the user editing.
    const stats = await versions.suppressAuto(() => extractSite(rawDir, outDir, {
      onProgress: p => send('run:progress', p),
    }, runLog));
    runLog(`  ${stats.pages} pages | ${stats.css} css | ${stats.images} images | ${stats.fonts} fonts`);
    const rawManifest = readManifest(rawDir) || {};
    writeManifest(outDir, { ...rawManifest, url, name: opts.name || nameFromUrl(url), kind: 'extracted', source: rawDir });

    if (opts.fixVideos !== false) {
      send('run:status', { phase: 'videos', msg: 'Restoring stripped videos' });
      const fixed = await versions.suppressAuto(() => fixVideos(outDir, runLog));
      if (fixed) runLog(`  restored ${fixed} video(s)`);
    }

    send('run:status', { phase: 'thumb', msg: 'Rendering preview' });
    await makeThumb(outDir);

    invalidate();
    const seconds = Math.round((Date.now() - started) / 1000);
    log.info('capture done', outDir, `${seconds}s`, JSON.stringify(stats));
    send('run:done', { ok: true, dir: outDir, stats, seconds });
    return outDir;
  } catch (err) {
    if (err.canceled) {
      log.info('capture canceled');
      send('run:done', { ok: false, canceled: true, error: 'Capture canceled.' });
    } else {
      log.error('capture failed', err);
      send('run:done', { ok: false, error: err.message });
    }
    throw err;
  } finally {
    releaseJob();
  }
}

async function runExtract(rawDir, { overwrite = false } = {}) {
  const { controller } = claimJob('An extract');
  try {
    const base = rawDir.replace(/[\\/]+$/, '') + '_extracted';
    const outDir = overwrite ? base : uniqueOutDir(base);
    send('run:status', { phase: 'extract', msg: 'Extracting into editable files' });
    // suppressAuto: an overwrite extract rewrites a folder that may be hosted
    // with the idle watcher listening — that churn is ours, not an edit.
    const stats = await versions.suppressAuto(() => extractSite(rawDir, outDir, {
      overwrite,
      signal: controller.signal,
      onProgress: p => send('run:progress', p),
    }, runLog));
    const manifest = readManifest(rawDir) || {};
    writeManifest(outDir, { ...manifest, kind: 'extracted', source: rawDir });

    send('run:status', { phase: 'videos', msg: 'Restoring stripped videos' });
    await versions.suppressAuto(() => fixVideos(outDir, runLog)).catch(err => log.warn('videofix', err));
    send('run:status', { phase: 'thumb', msg: 'Rendering preview' });
    await makeThumb(outDir);

    invalidate();
    send('run:done', { ok: true, dir: outDir, stats });
    return { dir: outDir, stats };
  } catch (err) {
    if (err.canceled) {
      log.info('extract canceled');
      send('run:done', { ok: false, canceled: true, error: 'Extract canceled.' });
    } else {
      log.error('extract failed', err);
      send('run:done', { ok: false, error: err.message });
    }
    throw err;
  } finally {
    releaseJob();
  }
}

// ---------- ipc ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (event.senderFrame && event.senderFrame.url && !event.senderFrame.url.startsWith('file://')) {
      throw new Error('Refused: unexpected sender.');
    }
    try {
      // The event rides along for the few handlers that need to know which
      // window is talking (Studio Browser chrome); most ignore it.
      return await fn(payload || {}, event);
    } catch (err) {
      if (!err.canceled) log.error(`ipc ${channel}`, err);
      throw err;
    }
  });
}

function registerIpc() {
  handle('env:get', () => environment());

  handle('update:install', () => {
    if (!updater) throw new Error('No update is ready to install.');
    // quitAndInstall goes through before-quit, so tunnels and dev servers come
    // down the same way they do on a normal exit.
    updater.quitAndInstall(true, true);
    return true;
  });

  // Window-level actions the command palette offers now that there is no menu
  // to hang them off. Deliberately a fixed allowlist, not an eval of a role.
  handle('win:action', ({ action }) => {
    if (!win || win.isDestroyed()) return false;
    switch (action) {
      case 'zoomIn': zoomBy(win, 0.5); return true;
      case 'zoomOut': zoomBy(win, -0.5); return true;
      case 'zoomReset': win.webContents.setZoomLevel(0); return true;
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); return true;
      case 'devtools': win.webContents.toggleDevTools(); return true;
      case 'capturesFolder': {
        const root = settings.load().capturesRoot;
        fs.mkdirSync(root, { recursive: true });
        shell.openPath(root);
        return true;
      }
      case 'minimize': win.minimize(); return true;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); return true;
      case 'close': win.close(); return true;
      default: throw new Error(`Unknown window action: ${action}`);
    }
  });
  handle('settings:get', () => ({ settings: settings.load() }));
  handle('settings:set', patch => {
    const saved = settings.save(patch);
    invalidate();
    return saved;
  });

  handle('settings:browseRoot', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a captures folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.load().capturesRoot,
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('settings:browseBrowser', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a Chromium-based browser',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('library:list', async () => {
    const list = await listLibrary(settings.load().capturesRoot, dir => hosts.portFor(dir));
    // The scan is still the source of truth for what exists; the registry adds
    // identity (a stable id and port) to extracted captures and contributes the
    // local projects the scan can't see.
    projects.syncCaptures(list.sites.filter(s => s.kind === 'extracted'));

    const sites = list.sites.map(site => {
      const project = site.kind === 'extracted' ? projects.byPath(site.dir) : null;
      return project
        ? {
          ...site,
          projectId: project.id,
          projectPort: project.port,
          autoStart: project.autoStart,
          liveReload: project.liveReload,
          autoSnapshot: project.autoSnapshot,
          reviewActive: reviewManager.isActive(site.dir),
        }
        : site;
    });
    for (const project of projects.all()) {
      if (project.kind !== 'local') continue;
      const described = await describeLocal(project, projects.thumbPath(project.id));
      sites.push({
        ...described,
        projectId: project.id,
        projectPort: project.port,
        autoStart: project.autoStart,
        liveReload: project.liveReload,
        autoSnapshot: project.autoSnapshot,
        attachOnly: !!project.attachOnly,
        reviewActive: reviewManager.isActive(project.path),
        port: hosts.portFor(project.path),
        runtimeState: hosts.runtimeState(project.path),
      });
    }
    sites.sort((a, b) => b.mtime - a.mtime);
    return { ...list, sites: sites.map(s => ({ ...s, share: tunnels.state(s.dir) })) };
  });

  handle('project:addLocal', async ({ path: dir }) => {
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('No folder path received.');
    if (isInRoot(dir)) throw new Error('That folder is already part of the captures library.');
    const project = projects.addLocal(dir);
    log.info('local project added', project.path, ':' + project.port);
    // Thumbnail in the background — the card shows a letter tile until then.
    makeThumb(project.path, projects.thumbPath(project.id))
      .then(made => { if (made) send('ui:refresh'); })
      .catch(() => {});
    return project;
  });

  handle('project:remove', async ({ id }) => {
    const project = projects.byId(id);
    if (!project) return false;
    if (project.kind !== 'local') {
      throw new Error('Captures are deleted from their card — this only removes local projects.');
    }
    tunnels.stop(project.path);
    hosts.stop(project.path);
    projects.remove(id);
    fs.promises.rm(projects.thumbPath(id), { force: true }).catch(() => {});
    // Snapshots of a local project live in userData (never in the user's
    // folder) — app bookkeeping, removed with the entry like the thumbnail.
    fs.promises.rm(path.join(app.getPath('userData'), 'versions', id), { recursive: true, force: true })
      .catch(() => {});
    // Folderless attach projects own a placeholder dir in userData — ours to clean.
    if (project.attachOnly) {
      fs.promises.rm(path.join(app.getPath('userData'), 'attached', id), { recursive: true, force: true })
        .catch(() => {});
    }
    log.info('local project removed', project.path);
    return true;
  });

  // ---------- attach mode ----------
  // Front a dev server the developer already runs. The target is a port on
  // this machine and nothing else — parseAttachTarget refuses any other host,
  // so attach can never become an open proxy.
  handle('project:addAttach', async ({ target, folder, name }) => {
    const port = runtimes.parseAttachTarget(target);
    const project = projects.addAttach({
      port,
      folder: typeof folder === 'string' && folder.trim() ? folder.trim() : null,
      name: typeof name === 'string' ? name.trim() : '',
    });
    log.info('attach project added', project.name, '->', port, project.attachOnly ? '(no folder)' : project.path);
    if (!project.attachOnly) {
      makeThumb(project.path, projects.thumbPath(project.id))
        .then(made => { if (made) send('ui:refresh'); })
        .catch(() => {});
    }
    return project;
  });

  handle('project:browseFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the project folder (optional — enables file:line mapping and snapshots)',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // ---------- runtimes ----------
  // Everything the Runtime panel needs in one call: what the folder looks like
  // it wants, what it is set to now, and whether it can actually start.
  handle('project:runtimes', ({ id }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    const current = projects.runtimeFor(project);
    const found = fs.existsSync(project.path) ? runtimes.candidates(project.path) : [];
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      current,
      candidates: found,
      detected: runtimes.detect(project.path),
      needsInstall: runtimes.needsInstall(project.path, current),
      hosted: !!hosts.portFor(project.path),
      state: hosts.runtimeState(project.path),
    };
  });

  handle('project:setRuntime', async ({ id, runtime }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    if (project.kind !== 'local') throw new Error('Captures are always served as files.');
    // A running site is serving the old runtime — stop it so the next Host
    // click starts what was just chosen, rather than silently disagreeing.
    if (hosts.portFor(project.path)) {
      tunnels.stop(project.path);
      reviewManager.disable(project.path);
      hosts.stop(project.path);
    }
    const updated = projects.update(id, { runtime });
    log.info('runtime set', project.path, updated.runtime.id, updated.runtime.command || '(static)');
    return updated;
  });

  handle('project:install', async ({ id }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    const runtime = projects.runtimeFor(project);
    if (!runtime.install) throw new Error('This runtime has no install step.');
    const claimed = claimJob('Installing dependencies');
    send('run:status', { phase: 'install', msg: `Installing dependencies for ${project.name}` });
    try {
      await runOnce(runtime.install, project.path, runLog);
      runLog('  dependencies installed');
      send('run:done', { ok: true, install: true, dir: project.path });
      return true;
    } catch (err) {
      send('run:done', { ok: false, install: true, error: err.message });
      throw err;
    } finally {
      if (job === claimed) releaseJob();
    }
  });

  handle('runtime:state', ({ dir }) => {
    assertManaged(dir, 'The site folder');
    return hosts.runtimeState(dir);
  });

  handle('runtime:restart', ({ dir }) => {
    assertManaged(dir, 'The site folder');
    if (!hosts.restart(dir)) throw new Error('That site has no process to restart.');
    log.info('runtime restart', dir);
    return true;
  });

  handle('project:setAutoStart', ({ id, autoStart }) => {
    const project = projects.update(id, { autoStart: !!autoStart });
    if (!project) throw new Error('Unknown project.');
    return project.autoStart;
  });

  handle('project:setLiveReload', ({ id, liveReload }) => {
    const project = projects.update(id, { liveReload: !!liveReload });
    if (!project) throw new Error('Unknown project.');
    // Applies immediately if the site is currently hosted.
    hosts.setLive(project.path, project.liveReload);
    return project.liveReload;
  });

  handle('project:setAutoSnapshot', ({ id, autoSnapshot }) => {
    const project = projects.update(id, { autoSnapshot: !!autoSnapshot });
    if (!project) throw new Error('Unknown project.');
    // Applies immediately if the site is currently hosted.
    if (hosts.portFor(project.path)) {
      if (project.autoSnapshot) versions.autoWatch(project);
      else versions.autoUnwatch(project.path);
    }
    return project.autoSnapshot;
  });

  // ---------- versioning (snapshots) ----------
  // Every handler resolves the project from the registry; captures are
  // additionally held to the captures-root gate, the same one their other
  // mutating operations pass through.
  function versionedProject(id) {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    if (project.kind === 'capture') assertInRoot(project.path, 'The site folder');
    return project;
  }

  handle('version:create', async ({ id, label }) => {
    const project = versionedProject(id);
    const result = await versions.createSnapshot(project, { label: String(label || ''), source: 'manual' });
    if (!result.unchanged) log.info('snapshot created', project.path, result.id);
    return result;
  });

  handle('version:list', ({ id }) => {
    const project = versionedProject(id);
    // Summaries only — the file manifests can be thousands of entries.
    return {
      snapshots: versions.listSnapshots(project).map(({ id: vid, label, source, timestamp, stats }) =>
        ({ id: vid, label, source, timestamp, stats })),
    };
  });

  const DIFF_TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.xml', '.md', '.map']);
  const DIFF_MAX_BYTES = 2 * 1024 * 1024;

  handle('version:diff', async ({ id, a, b, path: relPath }) => {
    const project = versionedProject(id);
    if (!relPath) return versions.diffSnapshots(project, String(a), String(b));
    // One file's line diff, computed here so the renderer needs no diff engine.
    const read = side => versions.readFileAt(project, String(side), relPath).catch(() => Buffer.alloc(0));
    const [bufA, bufB] = await Promise.all([read(a), read(b)]);
    if (bufA.length > DIFF_MAX_BYTES || bufB.length > DIFF_MAX_BYTES) return { kind: 'large' };
    if (!DIFF_TEXT_EXT.has(path.extname(String(relPath)).toLowerCase())
        || bufA.includes(0) || bufB.includes(0)) return { kind: 'binary' };
    return { kind: 'text', ...diffSegments(bufA.toString('utf8'), bufB.toString('utf8')) };
  });

  handle('version:readFile', async ({ id, versionId, path: relPath }) => {
    const project = versionedProject(id);
    const buf = await versions.readFileAt(project, String(versionId), relPath);
    if (buf.length > 20 * 1024 * 1024) throw new Error('That file is too large to preview here.');
    return { base64: buf.toString('base64'), size: buf.length };
  });

  handle('version:restore', async ({ id, versionId }) => {
    const project = versionedProject(id);
    const result = await versions.restoreSnapshot(project, String(versionId));
    log.info('snapshot restored', project.path, result.id, `${result.restored} file(s)`);
    invalidate(project.path);
    // The tree just changed under the thumbnail — re-render it to match.
    const out = project.kind === 'local' ? projects.thumbPath(project.id) : undefined;
    makeThumb(project.path, out, { entry: project.entryFile })
      .then(made => { if (made) send('ui:refresh'); })
      .catch(() => {});
    send('ui:refresh');
    return result;
  });

  // ---------- entry page ----------
  // Which page "/" serves. Stored in the registry since Studio shipped, but
  // only now choosable; a dev-server project decides its own routes.
  handle('project:pages', ({ id }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    if (projects.runtimeFor(project).kind === 'command') {
      throw new Error('A dev server decides its own pages — entry pages apply to static sites.');
    }
    const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target', '__pycache__']);
    const pages = [];
    (function walk(dir, rel, depth) {
      if (depth > 3 || pages.length >= 400) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
        const next = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), next, depth + 1);
        else if (/\.html?$/i.test(entry.name)) pages.push(next);
      }
    })(project.path, '', 0);
    // Homepages tend to have the shortest names — same heuristic as resolveEntry.
    pages.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return { pages, entryFile: project.entryFile };
  });

  handle('project:setEntry', ({ id, entryFile }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    const rel = String(entryFile || '').replace(/\\/g, '/');
    if (!rel || rel.split('/').some(seg => !seg || seg.startsWith('.'))) {
      throw new Error('That is not a page inside the project.');
    }
    const full = path.resolve(project.path, rel);
    if (!full.startsWith(path.resolve(project.path) + path.sep)) {
      throw new Error('That is not a page inside the project.');
    }
    let st = null;
    try { st = fs.statSync(full); } catch { /* reported below */ }
    if (!st || !st.isFile()) throw new Error('That page no longer exists.');
    projects.update(id, { entryFile: rel });
    log.info('entry page set', project.path, rel);
    // The thumbnail is a picture of the entry page — re-render it to match.
    const out = project.kind === 'local' ? projects.thumbPath(project.id) : undefined;
    makeThumb(project.path, out, { entry: rel })
      .then(made => { invalidate(project.path); if (made) send('ui:refresh'); })
      .catch(() => {});
    return { entryFile: rel };
  });

  handle('review:start', async ({ dir }) => {
    assertManaged(dir, 'The site folder');
    const project = projects.byPath(dir);
    if (!project) throw new Error('Only library projects can be reviewed — host it once first.');
    const port = await hosts.start(project.path, project.port, {
      liveReload: !!project.liveReload, runtime: projects.runtimeFor(project), name: project.name,
    });
    if (port !== project.port) projects.update(project.id, { port });
    reviewManager.enable(project.path, project.id);
    const url = `http://localhost:${port}/`;
    log.info('review start', project.path, port);
    await shell.openExternal(url);
    return { url, port };
  });

  handle('review:stop', ({ dir }) => {
    assertManaged(dir, 'The site folder');
    return reviewManager.disable(dir);
  });

  // ---------- studio browser ----------
  // Open the dedicated window for a project: host it (if it isn't), turn on
  // review mode so the overlay rides along, and hand the URL to the window.
  handle('studio:open', async ({ id }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    const runtime = projects.runtimeFor(project);
    if (runtime.kind === 'command' && runtime.id !== 'attach' && runtimes.needsInstall(project.path, runtime)) {
      throw new Error(`Dependencies aren't installed yet — run "${runtime.install}" from Runtime settings first.`);
    }
    const port = await hosts.start(project.path, project.port, {
      liveReload: !!project.liveReload, runtime, name: project.name,
    });
    if (port !== project.port) projects.update(project.id, { port });
    reviewManager.enable(project.path, project.id);
    const url = `http://localhost:${port}/`;
    studioBrowsers.open(project, url, { canPin: runtime.kind !== 'command' });
    send('ui:refresh');
    return { url, port };
  });

  // The chrome window's own channels. Each resolves the Studio Browser that
  // the *sender* belongs to — a stranger window simply has none.
  const sbFor = event => {
    const browser = studioBrowsers.forSender(event.sender);
    if (!browser) throw new Error('This window is not a Studio Browser.');
    return browser;
  };
  handle('sb:hello', (payload, event) => sbFor(event).hello());
  handle('sb:layout', (payload, event) => { sbFor(event).layout(payload); return true; });
  handle('sb:nav', ({ action }, event) => {
    if (!['back', 'forward', 'reload'].includes(action)) throw new Error('Unknown navigation action.');
    sbFor(event).nav(action);
    return true;
  });
  handle('sb:annotate', ({ on }, event) => sbFor(event).setAnnotating(!!on));
  handle('sb:pin', async ({ versionId }, event) => { await sbFor(event).pin(versionId); return true; });
  handle('sb:shot', async (payload, event) => {
    const file = await sbFor(event).screenshot();
    log.info('studio browser screenshot', file);
    return { file };
  });
  handle('sb:revealShot', ({ file }, event) => {
    sbFor(event); // only Studio Browser windows may ask
    const manual = path.join(app.getPath('userData'), 'shots', 'manual');
    const resolved = path.resolve(String(file || ''));
    if (!resolved.startsWith(manual + path.sep)) throw new Error('That is not a screenshot of ours.');
    shell.showItemInFolder(resolved);
    return true;
  });
  handle('sb:consoleTail', (payload, event) => ({ entries: sbFor(event).buffer.slice() }));
  handle('sb:copyAgent', (payload, event) => sbFor(event).copyForAgent());
  handle('sb:copyText', ({ text }, event) => {
    sbFor(event);
    clipboard.writeText(String(text == null ? '' : text).slice(0, 10000));
    return true;
  });

  handle('review:history', ({ id }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    const annotations = reviews.listAnnotations(project.id);
    return {
      reviews: reviews.listReviews(project.id).map(review => ({
        ...review,
        annotations: annotations.filter(a => a.reviewId === review.id).length,
        resolved: annotations.filter(a => a.reviewId === review.id && a.resolved).length,
      })).reverse(),
    };
  });

  handle('calibration:promote', ({ text }) => calibration.addStandingPreference(text));

  // ---------- calibration manager ----------
  // Anchors and standing preferences were write-only until now — visible only
  // in exported calibration.md. This is the read/edit surface behind the
  // Calibration modal.
  handle('calibration:get', () => {
    const data = calibration.load();
    return {
      updatedAt: data.updatedAt,
      standingPreferences: data.standingPreferences.slice(),
      anchors: data.anchors.map(anchor => ({
        ...anchor,
        screenshotUrl: anchor.screenshot && fs.existsSync(anchor.screenshot)
          ? pathToFileURL(anchor.screenshot).href
          : null,
      })),
    };
  });

  handle('calibration:update', ({ preference, anchor }) => {
    if (preference) return calibration.updatePreference(preference.index, preference.text);
    if (anchor) return calibration.updateAnchor(anchor.index, { summary: anchor.summary });
    throw new Error('Nothing to update.');
  });

  handle('calibration:removeAnchor', ({ index }) => calibration.removeAnchor(index));
  handle('calibration:removePreference', ({ index }) => calibration.removePreference(index));

  // Manual export from the history modal: an open review exports for the first
  // time, an exported one re-exports (fresh calibration.md, same folder shape).
  handle('review:export', ({ id, reviewId }) => {
    const project = projects.byId(id);
    if (!project) throw new Error('Unknown project.');
    const result = exportReview({
      project,
      capturesRoot: settings.load().capturesRoot,
      reviewId: reviewId || null,
      projectNameFor: pid => {
        const p = pid && projects.byId(pid);
        return p ? p.name : null;
      },
    });
    log.info('review exported from history', project.name, result.folder);
    return result;
  });

  handle('capture:start', opts => {
    // Validate before returning so the UI can show input errors immediately.
    normalizeUrl(opts.url);
    runCapture(opts).catch(() => {});
    return true;
  });

  handle('capture:cancel', () => {
    if (!job) return false;
    job.controller.abort();
    return true;
  });

  handle('extract:run', async ({ dir, overwrite }) => {
    assertInRoot(dir, 'The capture folder');
    return runExtract(dir, { overwrite });
  });

  handle('host:start', async ({ dir, port }) => {
    assertManaged(dir, 'The site folder');
    const project = projects.byPath(dir);
    const want = port || (project && project.port) || settings.load().defaultPort;
    const runtime = projects.runtimeFor(project);
    if (project && runtime.kind === 'command' && runtimes.needsInstall(dir, runtime)) {
      throw new Error(`Dependencies aren't installed yet — run "${runtime.install}" from Runtime settings first.`);
    }
    const resolved = await hosts.start(dir, want, {
      liveReload: !!(project && project.liveReload),
      runtime,
      name: project ? project.name : path.basename(dir),
    });
    if (project) {
      // If an external process squatted the registered port, the host manager
      // slid to a free one — persist that so the address stays stable from now on.
      projects.update(project.id, {
        lastOpened: new Date().toISOString(),
        ...(project.port !== resolved ? { port: resolved } : {}),
      });
      if (project.port !== resolved) log.info('port reassigned', dir, `${project.port} -> ${resolved}`);
    }
    log.info('hosting', dir, resolved);
    return { port: resolved, url: `http://localhost:${resolved}/` };
  });

  handle('host:stop', ({ dir }) => {
    tunnels.stop(dir);
    reviewManager.disable(dir);
    return hosts.stop(dir);
  });
  handle('host:stopAll', () => {
    for (const { dir } of hosts.list()) reviewManager.disable(dir);
    tunnels.stopAll();
    hosts.stopAll();
    return true;
  });

  // ---------- public sharing ----------
  // One switch: the hosted port goes online through a Cloudflare quick tunnel
  // and comes back as an https link. The link dies with the toggle, the host,
  // or the app — nothing outlives the session.
  handle('share:start', async ({ dir }) => {
    assertManaged(dir, 'The site folder');
    const port = hosts.portFor(dir);
    if (!port) throw new Error('Host the site first — sharing puts the hosted address online.');
    const url = await tunnels.start(dir, port, {
      onDownload: p => send('share:download', p),
    });
    log.info('sharing', dir, url);
    return { url };
  });

  handle('share:stop', ({ dir }) => {
    const stopped = tunnels.stop(dir);
    if (stopped) log.info('share stopped', dir);
    return stopped;
  });

  handle('share:state', ({ dir }) => tunnels.state(dir));

  handle('zip:export', async ({ dir }) => {
    assertInRoot(dir, 'The site folder');
    const zip = dir.replace(/[\\/]+$/, '') + '.zip';
    // A big capture is thousands of files; don't flood the renderer with IPC.
    const result = await zipFolder(dir, zip, (done, total) => {
      if (done === total || done % 25 === 0) send('zip:progress', { done, total });
    });
    log.info('zip', zip, JSON.stringify(result));
    shell.showItemInFolder(zip);
    return { zip, ...result };
  });

  // Any color literal (or an "r,g,b" scan key) as a hex string, for labels.
  const paletteHex = value => {
    const text = String(value).trim();
    if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(text)) {
      const [r, g, b] = text.split(',').map(n => parseInt(n, 10));
      return toHex({ r, g, b });
    }
    const parsed = parseColor(text);
    return parsed ? toHex(parsed) : text;
  };

  handle('palette:scan', ({ dir }) => {
    assertInRoot(dir, 'The site folder');
    const project = projects.byPath(dir);
    // Recolor history now lives in the versioning engine; sites recolored
    // before the engine existed keep their old undo entries, read-only.
    const history = [];
    if (project) {
      for (const snap of versions.listSnapshots(project)) {
        if (snap.source !== 'palette') continue;
        history.push({ id: snap.id, label: snap.label, at: snap.timestamp, engine: true });
      }
    }
    for (const legacy of listUndo(dir)) history.push({ ...legacy, legacy: true });
    history.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { colors: scanPalette(dir), undo: history };
  });

  handle('palette:apply', async ({ dir, from, to }) => {
    assertInRoot(dir, 'The site folder');
    const project = projects.byPath(dir);
    const result = await versions.suppressAuto(async () => {
      // The recolor's undo is a snapshot now — taken before a byte changes.
      if (project) {
        await versions.createSnapshot(project, {
          source: 'palette',
          label: `Before recolor ${paletteHex(from)} → ${paletteHex(to)}`,
        });
      }
      return applyColor(dir, from, to);
    });
    invalidate(dir);
    return result;
  });

  // The legacy path: restores a pre-engine .siteslurp/undo entry.
  handle('palette:undo', async ({ dir, id }) => {
    assertInRoot(dir, 'The site folder');
    const result = await versions.suppressAuto(async () => undoColor(dir, id));
    invalidate(dir);
    return result;
  });

  handle('video:fix', async ({ dir }) => {
    assertInRoot(dir, 'The site folder');
    const fixed = await versions.suppressAuto(() => fixVideos(dir, runLog));
    invalidate(dir);
    return fixed;
  });

  handle('thumb:make', async ({ dir }) => {
    assertManaged(dir, 'The site folder');
    const project = projects.byPath(dir);
    const out = project && project.kind === 'local' ? projects.thumbPath(project.id) : undefined;
    // A project that generates its pages only has a homepage while it's hosted.
    const port = hosts.portFor(dir);
    const state = hosts.runtimeState(dir);
    const url = port && state && state.status === 'ready' ? `http://localhost:${port}/` : null;
    const thumb = await makeThumb(dir, out, { url, entry: project ? project.entryFile : null });
    invalidate(dir);
    return thumb ? pathToFileURL(thumb).href + '?t=' + Date.now() : null;
  });

  handle('open:folder', ({ dir }) => {
    assertManaged(dir, 'That folder');
    return shell.openPath(dir);
  });

  handle('open:editor', ({ dir }) => {
    assertManaged(dir, 'That folder');
    const editor = findEditor();
    if (!editor) throw new Error('No code editor found — install VS Code or Cursor, or use "Open folder" instead.');
    // Args array, never a shell string — folder names are user data.
    spawn(editor, [dir], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return true;
  });

  handle('open:url', ({ url }) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Refused to open ' + parsed.protocol);
    return shell.openExternal(parsed.href);
  });

  handle('open:log', () => shell.openPath(log.logPath()));
  handle('log:tail', () => log.tail(500));

  handle('open:notices', () => {
    // Shipped as an extraResource so it's a real file, openable outside the asar.
    const packaged = path.join(process.resourcesPath || '', 'THIRD-PARTY-NOTICES.md');
    const target = fs.existsSync(packaged) ? packaged : path.join(__dirname, 'THIRD-PARTY-NOTICES.md');
    if (!fs.existsSync(target)) throw new Error('Notices file is missing from this build.');
    return shell.openPath(target);
  });

  handle('site:delete', async ({ dir, folder }) => {
    assertInRoot(dir, 'The site folder');
    const manifest = readManifest(dir);
    const rawDir = manifest && manifest.source ? path.resolve(manifest.source) : null;
    const offerRaw = !!(rawDir && isInRoot(rawDir) && fs.existsSync(rawDir));
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Move to trash', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Delete site',
      message: `Move "${folder || path.basename(dir)}" to the system trash?`,
      detail: dir,
      ...(offerRaw ? { checkboxLabel: 'Also delete the raw snapshot it was extracted from', checkboxChecked: false } : {}),
    });
    if (response !== 0) return false;
    tunnels.stop(dir);
    hosts.stop(dir);
    await trashWithRetry(dir);
    log.info('deleted', dir);
    if (offerRaw && checkboxChecked) {
      tunnels.stop(rawDir);
      hosts.stop(rawDir);
      await trashWithRetry(rawDir);
      log.info('deleted', rawDir);
    }
    invalidate();
    return true;
  });

  handle('shell:confirm', async ({ title, message, detail, confirmLabel }) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [confirmLabel || 'OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: title || 'SiteSlurp Studio',
      message: message || '',
      detail: detail || '',
    });
    return response === 0;
  });
}

// ---------- updates ----------
// electron-updater against the GitHub Releases feed. Downloads happen in the
// background; installing is always a user action — the renderer shows a toast
// with a Restart button and nothing restarts on its own.
let updater = null;

function initUpdater() {
  if (!app.isPackaged) return; // dev runs have no feed and no installer
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log.warn('updater unavailable', err.message);
    return;
  }
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // a quit installs the waiting update; no restart forced
  autoUpdater.on('update-downloaded', info => {
    log.info('update downloaded', info.version);
    send('update:ready', { version: info.version });
  });
  // An offline check failing is routine, not a dialog.
  autoUpdater.on('error', err => log.warn('updater', err && err.message ? err.message : String(err)));
  const check = () => autoUpdater.checkForUpdates().catch(err => log.warn('updater check', err.message));
  check();
  setInterval(check, 4 * 60 * 60 * 1000).unref();
  updater = autoUpdater;
}

// ---------- window ----------
function savedBounds() {
  const bounds = settings.load().windowBounds;
  if (!bounds || !Number.isFinite(bounds.width)) return null;
  // Don't restore onto a monitor that no longer exists.
  const visible = screen.getAllDisplays().some(display => {
    const a = display.workArea;
    return bounds.x < a.x + a.width && bounds.x + bounds.width > a.x
      && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y;
  });
  return visible ? bounds : null;
}

function createWindow() {
  const bounds = savedBounds();
  win = new BrowserWindow({
    width: bounds ? bounds.width : 1200,
    height: bounds ? bounds.height : 840,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0A0A0B',
    title: 'SiteSlurp Studio',
    show: false,
    // No OS title bar and no menu strip: the app draws its own 46px bar.
    // Windows paints only the minimise/maximise/close buttons into the reserved
    // slot on the right (the renderer positions itself with the
    // env(titlebar-area-*) variables the overlay turns on); macOS instead
    // inset-places its traffic lights on the left; Linux gets the renderer's
    // own fallback buttons because neither mechanism exists there.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#0A0A0B',
          symbolColor: '#8E8E96',
          height: TITLEBAR_HEIGHT,
        },
      }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // preload needs ipcRenderer
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The UI is local and self-contained: nothing should navigate or pop out of it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.webContents.on('render-process-gone', (event, details) => {
    log.error('renderer gone', JSON.stringify(details));
    if (details.reason !== 'clean-exit') win.reload();
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    settings.save({ windowBounds: win.getNormalBounds() });
  };
  win.on('resize', debounce(persistBounds, 400));
  win.on('move', debounce(persistBounds, 400));
  win.on('close', persistBounds);

  attachAccelerators({ win, send });

  if (process.argv.includes('--selftest')) runSelfTest();
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Screenshot the UI — and optionally drive a real capture through the UI and IPC —
// then exit. Used by `npm run smoke` to check a build before shipping it.
function runSelfTest() {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const url = process.env.SLURP_SELFTEST_URL;
  let failure = null;

  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2000);

      // Every read-only channel the UI depends on, exercised through the real bridge.
      const health = await win.webContents.executeJavaScript(`(async () => {
        const results = [];
        const env = await window.snap.invoke('env:get');
        results.push('browser=' + (env.browser.ok ? env.browser.name : 'MISSING'));
        results.push('engine=' + (env.singleFile.ok ? 'ok' : 'MISSING'));
        const lib = await window.snap.invoke('library:list');
        results.push('sites=' + lib.sites.length);
        const card = document.querySelector('.card-actions');
        results.push('cardButtons=' + (card ? card.querySelectorAll('button').length : 0));
        // The window is frameless. If Windows never painted its controls into
        // the reserved slot, the app has no close button — fail, don't ship.
        const wco = navigator.windowControlsOverlay;
        results.push('wco=' + (wco && wco.visible
          ? Math.round(wco.getTitlebarAreaRect().width) + 'px'
          : (document.querySelector('.win-controls') ? 'fallback' : 'MISSING')));
        // Nothing may render at the 300x150 intrinsic size of an unsized <svg>.
        const huge = [...document.querySelectorAll('svg')]
          .filter(s => s.getBoundingClientRect().width > 120).length;
        results.push('oversizedIcons=' + huge);
        const extracted = lib.sites.find(s => s.kind === 'extracted');
        if (extracted) {
          const pal = await window.snap.invoke('palette:scan', { dir: extracted.dir });
          results.push('palette=' + pal.colors.length);
        }
        await window.snap.invoke('settings:get');
        await window.snap.invoke('log:tail');
        const cal = await window.snap.invoke('calibration:get');
        results.push('calibration=' + cal.anchors.length + '+' + cal.standingPreferences.length);
        return results.join(' ');
      })()`);
      log.info('selftest ipc:', health);
      if (/MISSING/.test(health)) failure = 'environment incomplete: ' + health;
      if (!/oversizedIcons=0\b/.test(health)) failure = 'an icon rendered at its intrinsic size: ' + health;

      // Snapshot lifecycle through the real bridge: create -> edit -> create ->
      // diff -> restore -> prune surface. Opt-in (it registers and removes a
      // temp project) so a routine smoke never touches the registry.
      if (process.env.SLURP_SELFTEST_VERSIONS) {
        const site = fs.mkdtempSync(path.join(app.getPath('temp'), 'slurp-versions-'));
        try {
          fs.writeFileSync(path.join(site, 'index.html'), '<h1>v1</h1>');
          const inv = (channel, data) => win.webContents.executeJavaScript(
            `window.snap.invoke(${JSON.stringify(channel)}, ${JSON.stringify(data)})`);
          const project = await inv('project:addLocal', { path: site });
          const first = await inv('version:create', { id: project.id, label: 'selftest' });
          fs.writeFileSync(path.join(site, 'index.html'), '<h1>v2</h1>');
          const second = await inv('version:create', { id: project.id });
          const diff = await inv('version:diff', { id: project.id, a: first.id, b: second.id });
          await inv('version:restore', { id: project.id, versionId: first.id });
          const restoredOk = fs.readFileSync(path.join(site, 'index.html'), 'utf8').includes('v1');
          const list = await inv('version:list', { id: project.id });
          await inv('project:remove', { id: project.id });
          const summary = `created=${!first.unchanged} changed=${diff.changed.length}`
            + ` restored=${restoredOk} snapshots=${list.snapshots.length}`;
          log.info('selftest versions:', summary);
          if (summary !== 'created=true changed=1 restored=true snapshots=3') {
            failure = 'versions lifecycle broke: ' + summary;
          }
        } catch (err) {
          failure = 'versions lifecycle broke: ' + err.message;
        } finally {
          fs.rmSync(site, { recursive: true, force: true });
        }
      }

      if (url) {
        log.info('selftest capturing', url);
        // Submit the real form so the whole renderer -> ipc -> pipeline path runs.
        await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#doctorModal').classList.add('hidden');
          document.querySelector('#url').value = ${JSON.stringify(url)};
          document.querySelector('#crawl').checked = false;
          document.querySelector('#captureForm').dispatchEvent(new Event('submit', { cancelable: true }));
          return true;
        })()`);

        const deadline = Date.now() + 180000;
        let status = '';
        do {
          await sleep(1000);
          status = await win.webContents.executeJavaScript(
            'document.querySelector("#runStatus").textContent');
        } while (!/^(Done|Failed|Canceled)/.test(status) && Date.now() < deadline);

        log.info('selftest capture status:', status);
        if (!/^Done/.test(status)) failure = status || 'capture never finished';
      }

      // Screenshot a specific surface instead of the landing view. A fixed set
      // of names, not arbitrary script — enough to eyeball the states that only
      // exist after a click.
      const show = process.env.SLURP_SELFTEST_SHOW;
      if (show) {
        const clicks = {
          options: ['#btnOptions'],
          studio: ['#doctorClose', '#tab-studio'],
          commands: ['#btnPalette'],
          settings: ['#btnSettings'],
          // The Settings link works even while its modal is hidden — clicking
          // it directly avoids racing openSettings' async fill-in.
          calibration: ['#doctorClose', '#setCalibration'],
          // The first card's menu, then its first item — "How to serve this…"
          // on a local project.
          runtime: ['#doctorClose', '#tab-studio', '.card .menu-btn', '.menu-pop button'],
          // Host the first card for real. A project that runs a dev server is
          // only proven by watching its badge stop saying "starting…".
          hosting: ['#doctorClose', '#tab-studio', '.card .host-btn'],
        }[show];
        if (!clicks) throw new Error(`Unknown SLURP_SELFTEST_SHOW: ${show}`);
        await win.webContents.executeJavaScript(`(() => {
          for (const sel of ${JSON.stringify(clicks)}) document.querySelector(sel).click();
          return true;
        })()`);
        await sleep(700);

        if (show === 'hosting') {
          const deadline = Date.now() + 150000;
          let badge = '';
          do {
            await sleep(1000);
            badge = await win.webContents.executeJavaScript(
              '((document.querySelector(".badge.live") || {}).textContent || "").trim()');
          } while ((!badge || /starting/i.test(badge)) && Date.now() < deadline);
          log.info('selftest hosting badge:', badge);
          if (!/^localhost:\d+$/.test(badge)) failure = 'the hosted site never came up: ' + badge;
          await sleep(1500); // let the thumbnail land before the screenshot
        }
      }

      const img = await win.webContents.capturePage();
      const out = process.env.SLURP_SELFTEST_OUT || path.join(app.getPath('temp'), 'siteslurp-selftest.png');
      fs.writeFileSync(out, img.toPNG());
      log.info('selftest screenshot', out);
    } catch (err) {
      log.error('selftest failed', err);
      failure = err.message;
    }
    // app.exit skips before-quit, so anything the run started has to be taken
    // down here — a leaked dev server would outlive the app that spawned it.
    tunnels.stopAll();
    hosts.stopAll();
    await sleep(600);
    if (failure) {
      console.error('SELFTEST FAIL: ' + failure);
      app.exit(1);
    } else {
      app.exit(0);
    }
  });
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  // A second copy would fight over ports and the settings file. Say so out loud:
  // otherwise an automated run just sees a silent exit 0 and no window.
  console.error('SiteSlurp is already running — bringing the existing window forward.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  let reportedCrash = false;
  const onFatal = (label, err) => {
    log.error(label, err);
    if (reportedCrash) return;
    reportedCrash = true;
    // showErrorBox blocks the main process until dismissed, which would freeze
    // hosting and leave an unclickable window; showMessageBox doesn't.
    dialog.showMessageBox({
      type: 'error',
      title: 'SiteSlurp hit an error',
      message: err && err.message ? err.message : String(err),
      detail: `The app will keep running, but something may be in a bad state.\n\nDetails were written to:\n${log.logPath()}`,
      buttons: ['Continue', 'Open log'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 1) shell.openPath(log.logPath());
    }).catch(() => {});
  };
  process.on('uncaughtException', err => onFatal('uncaughtException', err));
  process.on('unhandledRejection', err => log.error('unhandledRejection', err));

  // Projects marked autoStart come up hosting without a click. Failures are
  // per-project and logged, never fatal — a missing folder must not take the
  // rest of the fleet down with it.
  async function autoStartProjects() {
    for (const project of projects.all()) {
      if (!project.autoStart) continue;
      try {
        const runtime = projects.runtimeFor(project);
        if (runtime.kind === 'command' && runtimes.needsInstall(project.path, runtime)) {
          log.warn('auto-host skipped', project.path, 'dependencies not installed');
          continue;
        }
        const port = await hosts.start(project.path, project.port, {
          liveReload: !!project.liveReload, runtime, name: project.name,
        });
        if (port !== project.port) projects.update(project.id, { port });
        log.info('auto-hosting', project.path, port);
      } catch (err) {
        log.warn('auto-host failed', project.path, err.message);
      }
    }
    send('ui:refresh');
  }

  app.whenReady().then(async () => {
    log.info(`SiteSlurp ${app.getVersion()} starting — electron ${process.versions.electron}`);
    registerIpc();
    createWindow();
    initUpdater();
    // Fill in a browser on first run without blocking the window.
    resolveBrowser().then(found => send('env:changed', { browser: found })).catch(err => log.warn('browser detect', err));
    autoStartProjects().catch(err => log.warn('auto-host', err));
  }).catch(err => onFatal('startup', err));

  app.on('before-quit', () => {
    if (job) job.controller.abort();
    tunnels.stopAll();
    hosts.stopAll();
    versions.autoUnwatchAll();
  });
  // Ctrl+C in the terminal during development never reaches before-quit, and a
  // dev server we started would keep running with nothing left to stop it.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      tunnels.stopAll();
      hosts.stopAll();
      setTimeout(() => app.exit(0), 400);
    });
  }
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}
