// SiteSnap — capture any website, extract it into editable files, host it locally.
const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
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
const { scanPalette, applyColor, undoColor, listUndo } = require('./lib/palette');
const { fixVideos } = require('./lib/videofix');
const { zipFolder } = require('./lib/zip');
const { listLibrary, describeLocal, invalidate } = require('./lib/library');
const projects = require('./lib/projects');
const { makeThumb } = require('./lib/thumbs');
const { buildMenu } = require('./lib/menu');

const hosts = new HostManager();
let win = null;
let job = null;   // { name, controller } — one long-running pipeline at a time

app.setAppUserModelId('com.nightshyft.sitesnap');

// ---------- helpers ----------
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const runLog = text => send('run:log', String(text).replace(/\s+$/, ''));

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
 *  the strict in-root rule — SiteSnap edits its own captures, not your repos. */
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
        throw new Error('Could not move the folder to the Recycle Bin — close anything using it '
          + '(Explorer, an editor, a browser tab) and try again.');
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
    if (!singleFilePath) throw new Error('The bundled page-capture engine is missing. Reinstall SiteSnap.');
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
    const stats = await extractSite(rawDir, outDir, {
      onProgress: p => send('run:progress', p),
    }, runLog);
    runLog(`  ${stats.pages} pages | ${stats.css} css | ${stats.images} images | ${stats.fonts} fonts`);
    const rawManifest = readManifest(rawDir) || {};
    writeManifest(outDir, { ...rawManifest, url, name: opts.name || nameFromUrl(url), kind: 'extracted', source: rawDir });

    if (opts.fixVideos !== false) {
      send('run:status', { phase: 'videos', msg: 'Restoring stripped videos' });
      const fixed = await fixVideos(outDir, runLog);
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
    const stats = await extractSite(rawDir, outDir, {
      overwrite,
      signal: controller.signal,
      onProgress: p => send('run:progress', p),
    }, runLog);
    const manifest = readManifest(rawDir) || {};
    writeManifest(outDir, { ...manifest, kind: 'extracted', source: rawDir });

    send('run:status', { phase: 'videos', msg: 'Restoring stripped videos' });
    await fixVideos(outDir, runLog).catch(err => log.warn('videofix', err));
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
      return await fn(payload || {});
    } catch (err) {
      if (!err.canceled) log.error(`ipc ${channel}`, err);
      throw err;
    }
  });
}

function registerIpc() {
  handle('env:get', () => environment());
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
        port: hosts.portFor(project.path),
      });
    }
    sites.sort((a, b) => b.mtime - a.mtime);
    return { ...list, sites };
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
    hosts.stop(project.path);
    projects.remove(id);
    fs.promises.rm(projects.thumbPath(id), { force: true }).catch(() => {});
    log.info('local project removed', project.path);
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
    const resolved = await hosts.start(dir, want, { liveReload: !!(project && project.liveReload) });
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

  handle('host:stop', ({ dir }) => hosts.stop(dir));
  handle('host:stopAll', () => { hosts.stopAll(); return true; });

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

  handle('palette:scan', ({ dir }) => {
    assertInRoot(dir, 'The site folder');
    return { colors: scanPalette(dir), undo: listUndo(dir) };
  });

  handle('palette:apply', async ({ dir, from, to }) => {
    assertInRoot(dir, 'The site folder');
    const result = applyColor(dir, from, to);
    invalidate(dir);
    return result;
  });

  handle('palette:undo', async ({ dir, id }) => {
    assertInRoot(dir, 'The site folder');
    const result = undoColor(dir, id);
    invalidate(dir);
    return result;
  });

  handle('video:fix', async ({ dir }) => {
    assertInRoot(dir, 'The site folder');
    const fixed = await fixVideos(dir, runLog);
    invalidate(dir);
    return fixed;
  });

  handle('thumb:make', async ({ dir }) => {
    assertManaged(dir, 'The site folder');
    const project = projects.byPath(dir);
    const out = project && project.kind === 'local' ? projects.thumbPath(project.id) : undefined;
    const thumb = await makeThumb(dir, out);
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
    if (!editor) throw new Error('VS Code not found. Use "Open folder" instead.');
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
      buttons: ['Move to Recycle Bin', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Delete site',
      message: `Move "${folder || path.basename(dir)}" to the Recycle Bin?`,
      detail: dir,
      ...(offerRaw ? { checkboxLabel: 'Also delete the raw snapshot it was extracted from', checkboxChecked: false } : {}),
    });
    if (response !== 0) return false;
    hosts.stop(dir);
    await trashWithRetry(dir);
    log.info('deleted', dir);
    if (offerRaw && checkboxChecked) {
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
      title: title || 'SiteSnap',
      message: message || '',
      detail: detail || '',
    });
    return response === 0;
  });
}

const EDITOR_CANDIDATES = [
  ['LOCALAPPDATA', 'Programs\\Microsoft VS Code\\Code.exe'],
  ['PROGRAMFILES', 'Microsoft VS Code\\Code.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft VS Code\\Code.exe'],
  ['LOCALAPPDATA', 'Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe'],
  ['LOCALAPPDATA', 'Programs\\cursor\\Cursor.exe'],
];

function findEditor() {
  if (process.platform !== 'win32') return null;
  for (const [envKey, rel] of EDITOR_CANDIDATES) {
    const base = process.env[envKey];
    if (!base) continue;
    const full = path.join(base, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
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
    backgroundColor: '#f5f5f7',
    title: 'SiteSnap',
    show: false,
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

  buildMenu({
    win,
    send,
    onStopAllHosts: () => { hosts.stopAll(); send('ui:refresh'); },
    openCapturesFolder: () => {
      const root = settings.load().capturesRoot;
      fs.mkdirSync(root, { recursive: true });
      shell.openPath(root);
    },
    logPath: log.logPath,
  });

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
  const url = process.env.SNAP_SELFTEST_URL;
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
        const extracted = lib.sites.find(s => s.kind === 'extracted');
        if (extracted) {
          const pal = await window.snap.invoke('palette:scan', { dir: extracted.dir });
          results.push('palette=' + pal.colors.length);
        }
        await window.snap.invoke('settings:get');
        await window.snap.invoke('log:tail');
        return results.join(' ');
      })()`);
      log.info('selftest ipc:', health);
      if (/MISSING/.test(health)) failure = 'environment incomplete: ' + health;

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

      const img = await win.webContents.capturePage();
      const out = process.env.SNAP_SELFTEST_OUT || path.join(app.getPath('temp'), 'sitesnap-selftest.png');
      fs.writeFileSync(out, img.toPNG());
      log.info('selftest screenshot', out);
    } catch (err) {
      log.error('selftest failed', err);
      failure = err.message;
    }
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
  console.error('SiteSnap is already running — bringing the existing window forward.');
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
      title: 'SiteSnap hit an error',
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
        const port = await hosts.start(project.path, project.port, { liveReload: !!project.liveReload });
        if (port !== project.port) projects.update(project.id, { port });
        log.info('auto-hosting', project.path, port);
      } catch (err) {
        log.warn('auto-host failed', project.path, err.message);
      }
    }
    send('ui:refresh');
  }

  app.whenReady().then(async () => {
    log.info(`SiteSnap ${app.getVersion()} starting — electron ${process.versions.electron}`);
    registerIpc();
    createWindow();
    // Fill in a browser on first run without blocking the window.
    resolveBrowser().then(found => send('env:changed', { browser: found })).catch(err => log.warn('browser detect', err));
    autoStartProjects().catch(err => log.warn('auto-host', err));
  }).catch(err => onFatal('startup', err));

  app.on('before-quit', () => {
    if (job) job.controller.abort();
    hosts.stopAll();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}
