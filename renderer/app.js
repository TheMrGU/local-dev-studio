/* SiteSnap renderer */
const $ = sel => document.querySelector(sel);
const invoke = (channel, data) => window.snap.invoke(channel, data);

const state = {
  library: { root: '', sites: [], missing: false },
  env: null,
  settings: null,
  busy: false,
  paletteDir: null,
  paletteFrom: null,
  filter: '',
  runStarted: 0,
  runTimer: null,
  zipToast: null,
};

/* ---------- toasts ---------- */
function toast(message, { kind = '', action = null, timeout = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const link = document.createElement('button');
    link.className = 'toast-action';
    link.textContent = action.label;
    link.addEventListener('click', () => { action.fn(); el.remove(); });
    el.appendChild(link);
  }
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  $('#toasts').appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

const failed = err => toast(err && err.message ? err.message : String(err), { kind: 'err', timeout: 9000 });

// A one-page capture is kilobytes; a crawled site with video is gigabytes.
function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ---------- environment ---------- */
async function refreshEnv() {
  state.env = await invoke('env:get');
  const { browser, singleFile, capturesRoot } = state.env;
  const chip = (ok, label) => `<span class="dot ${ok ? 'ok' : 'bad'}"></span>${label}`;
  $('#envStatus').innerHTML = [
    chip(browser.ok, browser.ok ? browser.name : 'no browser'),
    chip(singleFile.ok && capturesRoot.ok, 'engine'),
  ].join('<span class="env-sep"></span>');
  $('#envStatus').classList.toggle('warn', !(browser.ok && singleFile.ok && capturesRoot.ok));
  return state.env;
}

function problems() {
  const env = state.env;
  if (!env) return [];
  const list = [];
  if (!env.browser.ok) {
    list.push({
      ok: false,
      title: 'No Chromium browser found',
      detail: env.browser.installed.length
        ? 'Pick one in Settings.'
        : 'SiteSnap drives a real browser so React and other JS-heavy sites render before they are saved. Install Microsoft Edge or Google Chrome, then reopen this dialog.',
    });
  } else {
    list.push({ ok: true, title: `Browser: ${env.browser.name}`, detail: env.browser.path });
  }
  list.push(env.singleFile.ok
    ? { ok: true, title: `Capture engine ready${env.singleFile.bundled ? ' (bundled)' : ''}`, detail: env.singleFile.path }
    : { ok: false, title: 'Capture engine missing', detail: 'Reinstall SiteSnap, or point Settings → Advanced at a single-file-cli install.' });
  list.push(env.capturesRoot.ok
    ? { ok: true, title: 'Captures folder writable', detail: env.capturesRoot.path }
    : { ok: false, title: 'Captures folder is not writable', detail: `${env.capturesRoot.path} — pick another folder in Settings.` });
  return list;
}

function openDoctor(firstRun = false) {
  const list = problems();
  $('#doctorTitle').textContent = firstRun ? 'Welcome to SiteSnap' : 'Setup & diagnostics';
  $('#doctorIntro').textContent = firstRun
    ? 'Paste any URL and SiteSnap saves the whole site, unpacks it into editable files, and hosts it on localhost. Here is what it found on this machine:'
    : '';
  const ul = $('#doctorList');
  ul.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    li.className = item.ok ? 'ok' : 'bad';
    li.innerHTML = `<svg aria-hidden="true"><use href="#i-${item.ok ? 'check' : 'alert'}"/></svg>`;
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    body.appendChild(title);
    body.appendChild(detail);
    li.appendChild(body);
    ul.appendChild(li);
  }
  $('#doctorModal').classList.remove('hidden');
}

$('#envStatus').addEventListener('click', () => refreshEnv().then(() => openDoctor()));
$('#doctorClose').addEventListener('click', () => $('#doctorModal').classList.add('hidden'));
$('#doctorLog').addEventListener('click', () => invoke('open:log'));
$('#doctorSettings').addEventListener('click', () => {
  $('#doctorModal').classList.add('hidden');
  openSettings();
});

/* ---------- about ---------- */
function openAbout() {
  const v = state.env ? state.env.versions : {};
  $('#aboutVersion').textContent = v.app ? `v${v.app}` : '';
  const rows = [
    ['Electron', v.electron], ['Chromium', v.chrome], ['Node', v.node],
    ['Captures', state.library.root], ['Log', state.env && state.env.logPath],
  ];
  const dl = $('#aboutDetails');
  dl.innerHTML = '';
  for (const [key, value] of rows) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  $('#aboutModal').classList.remove('hidden');
}
$('#aboutClose').addEventListener('click', () => $('#aboutModal').classList.add('hidden'));
$('#aboutNotices').addEventListener('click', () => invoke('open:notices').catch(failed));

/* ---------- settings ---------- */
async function openSettings() {
  const [{ settings }, env] = await Promise.all([invoke('settings:get'), refreshEnv()]);
  state.settings = settings;
  $('#setRoot').value = settings.capturesRoot;
  $('#setPort').value = settings.defaultPort;
  $('#setOpenAfterHost').checked = settings.openAfterHost;
  $('#setSf').value = settings.singleFilePath || '';
  $('#setSf').placeholder = env.singleFile.path || 'not found';
  $('#setSfStatus').textContent = env.singleFile.ok ? '(ready)' : '(missing)';
  $('#setSfStatus').className = 'mini ' + (env.singleFile.ok ? 'ok' : 'bad');

  const pick = $('#setBrowserPick');
  pick.innerHTML = '';
  const options = [...env.browser.installed];
  if (settings.browserPath && !options.some(b => b.path.toLowerCase() === settings.browserPath.toLowerCase())) {
    options.unshift({ name: env.browser.name + (env.browser.ok ? '' : ' (missing)'), path: settings.browserPath });
  }
  if (!options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Chromium browser found';
    pick.appendChild(opt);
  }
  for (const browser of options) {
    const opt = document.createElement('option');
    opt.value = browser.path;
    opt.textContent = browser.name;
    pick.appendChild(opt);
  }
  pick.value = settings.browserPath || (options[0] ? options[0].path : '');
  $('#setBrowserPath').textContent = pick.value;
  $('#settingsModal').classList.remove('hidden');
}

$('#btnSettings').addEventListener('click', openSettings);
$('#setCancel').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#setBrowserPick').addEventListener('change', e => { $('#setBrowserPath').textContent = e.target.value; });
$('#setBrowse').addEventListener('click', async () => {
  const dir = await invoke('settings:browseRoot');
  if (dir) $('#setRoot').value = dir;
});
$('#setBrowserBrowse').addEventListener('click', async () => {
  const file = await invoke('settings:browseBrowser');
  if (!file) return;
  const pick = $('#setBrowserPick');
  const opt = document.createElement('option');
  opt.value = file;
  opt.textContent = file.split(/[\\/]/).pop();
  pick.appendChild(opt);
  pick.value = file;
  $('#setBrowserPath').textContent = file;
});
$('#setSave').addEventListener('click', async () => {
  try {
    state.settings = await invoke('settings:set', {
      capturesRoot: $('#setRoot').value.trim(),
      browserPath: $('#setBrowserPick').value.trim(),
      singleFilePath: $('#setSf').value.trim(),
      defaultPort: parseInt($('#setPort').value, 10) || 8008,
      openAfterHost: $('#setOpenAfterHost').checked,
    });
    $('#settingsModal').classList.add('hidden');
    await refreshEnv();
    await refreshLibrary();
    toast('Settings saved', { kind: 'ok', timeout: 2500 });
  } catch (err) {
    failed(err);
  }
});

/* ---------- capture ---------- */
function applyRememberedOptions(settings) {
  $('#crawl').checked = settings.crawl;
  $('#depth').value = String(settings.depth);
  $('#mobile').checked = settings.mobile;
  $('#fixVideos').checked = settings.fixVideos;
  $('#stripBanners').checked = settings.stripBanners;
  $('#showBrowser').checked = !settings.headless;
  $('#waitDelay').value = String(settings.waitDelay || 0);
}

$('#btnAdvanced').addEventListener('click', () => {
  const panel = $('#advanced');
  panel.classList.toggle('hidden');
  $('#btnAdvanced').innerHTML = panel.classList.contains('hidden') ? 'Advanced &#9662;' : 'Advanced &#9652;';
});

$('#captureForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#url').value.trim();
  if (!url) return;
  startRunPanel('Starting…');
  try {
    await invoke('capture:start', {
      url,
      name: $('#siteName').value.trim() || undefined,
      crawl: $('#crawl').checked,
      depth: parseInt($('#depth').value, 10),
      mobile: $('#mobile').checked,
      fixVideos: $('#fixVideos').checked,
      stripBanners: $('#stripBanners').checked,
      headless: !$('#showBrowser').checked,
      waitDelay: parseInt($('#waitDelay').value, 10) || 0,
    });
  } catch (err) {
    stopRunPanel('fail', err.message);
    failed(err);
  }
});

$('#btnCancel').addEventListener('click', async () => {
  $('#btnCancel').disabled = true;
  $('#runStatus').textContent = 'Cancelling…';
  await invoke('capture:cancel').catch(() => {});
});

function startRunPanel(message) {
  $('#runPanel').classList.remove('hidden');
  $('#runLog').textContent = '';
  $('#runSpinner').className = 'spinner';
  $('#runStatus').textContent = message;
  $('#btnCancel').disabled = false;
  $('#btnCancel').classList.remove('hidden');
  state.runStarted = Date.now();
  clearInterval(state.runTimer);
  state.runTimer = setInterval(() => {
    const s = Math.floor((Date.now() - state.runStarted) / 1000);
    $('#runElapsed').textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }, 500);
}

function stopRunPanel(kind, message) {
  clearInterval(state.runTimer);
  $('#runSpinner').className = 'spinner ' + kind;
  $('#runStatus').textContent = message;
  $('#btnCancel').classList.add('hidden');
}

window.snap.on('run:log', text => {
  const el = $('#runLog');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.textContent += text + '\n';
  // Keep the log bounded — a deep crawl prints a lot.
  if (el.textContent.length > 200000) el.textContent = el.textContent.slice(-150000);
  if (atBottom) el.scrollTop = el.scrollHeight;
});

window.snap.on('run:status', ({ msg }) => { $('#runStatus').textContent = msg; });

window.snap.on('run:progress', ({ done, total, page }) => {
  if (!total) return;
  $('#runStatus').textContent = page
    ? `Extracting ${done + 1}/${total} — ${page}`
    : `Extracted ${done}/${total} pages`;
});

window.snap.on('zip:progress', ({ done, total }) => {
  if (state.zipToast) state.zipToast.textContent = `Zipping ${done}/${total}…`;
});

window.snap.on('run:busy', ({ busy }) => {
  state.busy = busy;
  $('#btnCapture').disabled = busy;
});

window.snap.on('run:done', async ({ ok, dir, stats, error, canceled, seconds }) => {
  if (ok) {
    const summary = `${stats.pages} page${stats.pages === 1 ? '' : 's'}, ${stats.images} images, `
      + `${stats.fonts} fonts, ${stats.css} css${seconds ? ` — ${seconds}s` : ''}`;
    stopRunPanel('done', `Done — ${summary}`);
    toast('Site captured & extracted', {
      kind: 'ok', timeout: 12000,
      action: { label: 'Host now', fn: () => hostSite(dir) },
    });
  } else {
    stopRunPanel(canceled ? '' : 'fail', canceled ? 'Canceled.' : 'Failed: ' + error);
    if (!canceled) failed(new Error(error));
  }
  await refreshLibrary();
});

/* ---------- hosting ---------- */
async function hostSite(dir) {
  try {
    const { port, url } = await invoke('host:start', { dir });
    if (!state.settings || state.settings.openAfterHost) await invoke('open:url', { url });
    toast(`Hosting on localhost:${port}`, { kind: 'ok', action: { label: 'Open', fn: () => invoke('open:url', { url }) } });
    await refreshLibrary();
  } catch (err) {
    failed(err);
  }
}

async function stopSite(dir) {
  await invoke('host:stop', { dir }).catch(failed);
  await refreshLibrary();
}

$('#btnStopAll').addEventListener('click', async () => {
  await invoke('host:stopAll').catch(failed);
  await refreshLibrary();
});

/* ---------- drag & drop: add a local folder as a project ---------- */
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  for (const file of e.dataTransfer.files || []) {
    try {
      const project = await invoke('project:addLocal', { path: window.snap.pathForFile(file) });
      toast(`Added "${project.name}" — its port is ${project.port}`, {
        kind: 'ok', action: { label: 'Host now', fn: () => hostSite(project.path) },
      });
    } catch (err) {
      failed(err);
    }
  }
  await refreshLibrary();
});

/* ---------- library ---------- */
function iconBtn(icon, title, fn) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(); } catch (err) { failed(err); } finally { b.disabled = false; }
  });
  return b;
}

function textButton(icon, label, className, fn) {
  const b = document.createElement('button');
  b.className = `host-btn ${className}`;
  b.innerHTML = `<svg><use href="#i-${icon}"/></svg> <span></span>`;
  b.querySelector('span').textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(); } catch (err) { failed(err); } finally { b.disabled = false; }
  });
  return b;
}

/* One "⋯" button per card; secondary actions live in a popover so the card
   never overflows (which used to clip the last buttons off the edge). */
let openMenu = null;
function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}
document.addEventListener('click', e => {
  if (openMenu && !openMenu.contains(e.target) && e.target.closest('.menu-btn') !== openMenu.anchor) closeMenu();
});

function menuButton(items) {
  const b = document.createElement('button');
  b.className = 'icon-btn menu-btn';
  b.title = 'More actions';
  b.setAttribute('aria-label', 'More actions');
  b.innerHTML = '<svg><use href="#i-more"/></svg>';
  b.addEventListener('click', () => {
    if (openMenu && openMenu.anchor === b) { closeMenu(); return; }
    closeMenu();
    const pop = document.createElement('div');
    pop.className = 'menu-pop';
    pop.anchor = b;
    for (const item of items) {
      const row = document.createElement('button');
      row.innerHTML = `<svg><use href="#i-${item.icon}"/></svg><span></span>`;
      row.querySelector('span').textContent = item.label;
      row.addEventListener('click', async () => {
        closeMenu();
        try { await item.fn(); } catch (err) { failed(err); }
      });
      pop.appendChild(row);
    }
    b.closest('.card-actions').appendChild(pop);
    openMenu = pop;
  });
  return b;
}

function renderCard(site) {
  const card = document.createElement('div');
  card.className = 'card';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (site.thumb) {
    const img = document.createElement('img');
    img.src = site.thumb;
    img.loading = 'lazy';
    img.alt = '';
    thumb.appendChild(img);
  } else {
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = site.name.slice(0, 2);
    thumb.appendChild(letter);
  }
  const badge = document.createElement('span');
  if (site.port) {
    badge.className = 'badge live';
    badge.textContent = 'localhost:' + site.port;
    badge.title = 'Open in browser';
    badge.addEventListener('click', e => {
      e.stopPropagation();
      invoke('open:url', { url: `http://localhost:${site.port}/` }).catch(failed);
    });
  } else if (site.missing) { badge.className = 'badge missing'; badge.textContent = 'missing'; }
  else if (site.kind === 'local') { badge.className = 'badge local'; badge.textContent = 'local'; }
  else if (site.kind === 'extracted') { badge.className = 'badge extracted'; badge.textContent = 'extracted'; }
  else { badge.className = 'badge'; badge.textContent = 'raw'; }
  thumb.appendChild(badge);
  if (!site.missing && (site.kind === 'extracted' || site.kind === 'local' || site.port)) {
    thumb.classList.add('clickable');
    thumb.title = 'Open this site';
    thumb.addEventListener('click', () => (site.port
      ? invoke('open:url', { url: `http://localhost:${site.port}/` })
      : hostSite(site.dir)));
  }
  card.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'card-body';
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = site.name;
  name.title = site.sourceUrl ? `${site.folder}\n${site.sourceUrl}` : site.dir;
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = site.missing
    ? 'folder not found on disk'
    : `${site.pages} page${site.pages === 1 ? '' : 's'} · ${fileSize(site.sizeBytes)} · `
      + new Date(site.mtime).toLocaleDateString();
  body.appendChild(name);
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const exportZip = async () => {
    const pending = toast('Zipping…', { timeout: 0 });
    state.zipToast = pending.querySelector('span');
    try {
      const { zip, files } = await invoke('zip:export', { dir: site.dir });
      toast(`Exported ${files} files to ${zip.split(/[\\/]/).pop()}`, { kind: 'ok' });
    } finally {
      state.zipToast = null;
      pending.remove();
    }
  };
  const deleteSite = async () => {
    try {
      const done = await invoke('site:delete', { dir: site.dir, folder: site.folder });
      if (done) toast('Moved to the Recycle Bin', { kind: 'ok', timeout: 3000 });
    } finally {
      // Refresh even on failure — a partial delete leaves stale cards behind.
      await refreshLibrary();
    }
  };
  // A local project is the user's own folder — removing it only forgets the
  // library entry. Deleting files stays a captures-only operation.
  const removeLocal = async () => {
    const yes = await invoke('shell:confirm', {
      title: 'Remove project',
      message: `Remove "${site.name}" from the library?`,
      detail: 'The folder and its files stay on disk — only the library entry goes away.',
      confirmLabel: 'Remove',
    });
    if (!yes) return;
    await invoke('project:remove', { id: site.projectId });
    toast('Removed — files untouched', { kind: 'ok', timeout: 3000 });
    await refreshLibrary();
  };

  const more = [];
  if (site.port && site.hasSitemap) {
    more.push({ icon: 'map', label: 'Open sitemap', fn: () =>
      invoke('open:url', { url: `http://localhost:${site.port}/_index.html` }) });
  }
  more.push({ icon: 'folder', label: 'Open folder', fn: () => invoke('open:folder', { dir: site.dir }) });
  more.push({ icon: 'code', label: 'Open in VS Code', fn: () => invoke('open:editor', { dir: site.dir }) });
  if (site.kind === 'extracted') {
    more.push({ icon: 'film', label: 'Restore stripped videos', fn: async () => {
      const fixed = await invoke('video:fix', { dir: site.dir });
      toast(fixed ? `Restored ${fixed} video(s)` : 'No stripped videos found', { kind: fixed ? 'ok' : '' });
    } });
  }
  if (!site.missing && (site.kind === 'extracted' || site.kind === 'local')) {
    more.push({ icon: 'camera', label: 'Refresh preview', fn: async () => {
      await invoke('thumb:make', { dir: site.dir });
      await refreshLibrary();
    } });
  }
  if (site.projectId) {
    more.push({ icon: 'refresh', label: site.liveReload ? 'Live reload: on' : 'Live reload: off', fn: async () => {
      await invoke('project:setLiveReload', { id: site.projectId, liveReload: !site.liveReload });
      await refreshLibrary();
    } });
    more.push({ icon: 'check', label: site.autoStart ? 'Auto-start: on' : 'Auto-start: off', fn: async () => {
      await invoke('project:setAutoStart', { id: site.projectId, autoStart: !site.autoStart });
      await refreshLibrary();
    } });
  }
  if (site.kind !== 'local') more.push({ icon: 'zip', label: 'Export ZIP', fn: exportZip });

  if (site.kind === 'raw') {
    actions.appendChild(textButton('unpack', 'Extract', 'primary', async () => {
      // Same panel as a capture, so progress and the log are visible.
      startRunPanel('Extracting…');
      try {
        await invoke('extract:run', { dir: site.dir });
      } catch (err) {
        stopRunPanel('fail', err.message);
        throw err;
      }
    }));
  } else if (site.port) {
    actions.appendChild(textButton('stop', 'Stop', 'stop', () => stopSite(site.dir)));
    actions.appendChild(iconBtn('open', 'Open in browser', () =>
      invoke('open:url', { url: `http://localhost:${site.port}/` })));
  } else if (!site.missing) {
    actions.appendChild(textButton('globe', 'Host', 'primary', () => hostSite(site.dir)));
  }
  if (site.kind === 'extracted') {
    actions.appendChild(iconBtn('palette', 'Recolor palette', () => openPalette(site)));
  }
  if (site.kind === 'local') {
    actions.appendChild(iconBtn('trash', 'Remove from library (files stay on disk)', removeLocal));
  } else {
    actions.appendChild(iconBtn('trash', 'Delete (to Recycle Bin)', deleteSite));
  }
  actions.appendChild(menuButton(more));

  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

function visibleSites() {
  const showRaw = $('#libShowRaw').checked;
  const needle = state.filter.toLowerCase();
  let sites = state.library.sites.filter(site => {
    if (!showRaw && site.kind === 'raw' && site.hasExtracted) return false;
    if (!needle) return true;
    return (site.name + ' ' + site.folder + ' ' + site.sourceUrl).toLowerCase().includes(needle);
  });
  const sort = $('#libSort').value;
  if (sort === 'name') sites = sites.slice().sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'size') sites = sites.slice().sort((a, b) => b.sizeBytes - a.sizeBytes);
  return sites;
}

function renderLibrary() {
  closeMenu(); // the popover's card is about to be re-rendered
  const sites = visibleSites();
  const grid = $('#grid');
  grid.innerHTML = '';
  for (const site of sites) grid.appendChild(renderCard(site));

  const empty = $('#empty');
  empty.classList.toggle('hidden', sites.length > 0);
  if (!sites.length) {
    empty.textContent = state.library.sites.length
      ? 'Nothing matches that filter.'
      : 'Nothing here yet — paste a URL above to capture a site, or drop a folder to add your own.';
  }

  const hosted = state.library.sites.filter(s => s.port);
  $('#serversStrip').classList.toggle('hidden', !hosted.length);
  const chips = $('#serverChips');
  chips.innerHTML = '';
  for (const site of hosted) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<span class="live"></span>';
    const link = document.createElement('button');
    link.className = 'chip-link';
    link.textContent = `${site.name} :${site.port}`;
    link.addEventListener('click', () => invoke('open:url', { url: `http://localhost:${site.port}/` }));
    chip.appendChild(link);
    chip.appendChild(iconBtn('stop', 'Stop', () => stopSite(site.dir)));
    chips.appendChild(chip);
  }
}

async function refreshLibrary() {
  try {
    state.library = await invoke('library:list');
  } catch (err) {
    failed(err);
    return;
  }
  const root = $('#libRoot');
  root.textContent = state.library.root;
  root.classList.toggle('missing', !!state.library.missing);
  renderLibrary();
}

$('#btnRefresh').addEventListener('click', refreshLibrary);
$('#libSearch').addEventListener('input', e => { state.filter = e.target.value.trim(); renderLibrary(); });
$('#libSort').addEventListener('change', e => {
  invoke('settings:set', { sort: e.target.value }).catch(() => {});
  renderLibrary();
});
$('#libShowRaw').addEventListener('change', e => {
  invoke('settings:set', { showRaw: e.target.checked }).catch(() => {});
  renderLibrary();
});

/* ---------- palette ---------- */
async function openPalette(site) {
  state.paletteDir = site.dir;
  state.paletteFrom = null;
  $('#palSite').textContent = '— ' + site.name;
  $('#palEdit').classList.add('hidden');
  $('#paletteDrawer').classList.remove('hidden');
  const wrap = $('#swatches');
  wrap.innerHTML = '<div class="pal-loading">Scanning colors…</div>';

  let result;
  try {
    result = await invoke('palette:scan', { dir: site.dir });
  } catch (err) {
    wrap.innerHTML = '';
    failed(err);
    return;
  }

  wrap.innerHTML = '';
  if (!result.colors.length) {
    wrap.innerHTML = '<div class="pal-loading">No colors found in this site.</div>';
  }
  for (const entry of result.colors) {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.style.background = entry.color;
    swatch.title = `${entry.color} — ${entry.count} use${entry.count === 1 ? '' : 's'}`
      + (entry.variants > 1 ? ` across ${entry.variants} opacities` : '');
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = entry.count;
    swatch.appendChild(count);
    swatch.addEventListener('click', () => {
      wrap.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'));
      swatch.classList.add('sel');
      state.paletteFrom = entry.key;
      $('#palFromChip').style.background = entry.color;
      $('#palFromLabel').textContent = `${entry.color} (${entry.count})`;
      $('#palTo').value = entry.color;
      $('#palToHex').value = entry.color;
      $('#palEdit').classList.remove('hidden');
    });
    wrap.appendChild(swatch);
  }
  renderUndo(result.undo);
}

function renderUndo(entries) {
  const panel = $('#palUndo');
  const list = $('#palUndoList');
  list.innerHTML = '';
  panel.classList.toggle('hidden', !entries || !entries.length);
  for (const entry of (entries || []).slice(0, 5)) {
    const row = document.createElement('div');
    row.className = 'undo-row';
    const chips = document.createElement('span');
    chips.className = 'undo-chips';
    chips.innerHTML = `<i style="background:${cssColor(entry.from)}"></i>&rarr;<i style="background:${cssColor(entry.to)}"></i>`;
    const label = document.createElement('span');
    label.className = 'undo-label';
    label.textContent = `${entry.replaced} in ${entry.files.length} file${entry.files.length === 1 ? '' : 's'}`;
    row.appendChild(chips);
    row.appendChild(label);
    row.appendChild(iconBtn('undo', 'Revert this change', async () => {
      const result = await invoke('palette:undo', { dir: state.paletteDir, id: entry.id });
      toast(`Reverted ${result.restored} file${result.restored === 1 ? '' : 's'}`, { kind: 'ok' });
      const site = state.library.sites.find(s => s.dir === state.paletteDir);
      if (site) await openPalette(site);
      invoke('thumb:make', { dir: state.paletteDir }).then(refreshLibrary).catch(() => {});
    }));
    list.appendChild(row);
  }
}

// Only used for the little history chips — keeps a bad string from breaking layout.
const cssColor = value => (/^#[0-9a-fA-F]{3,8}$/.test(String(value)) ? value : 'transparent');

$('#palClose').addEventListener('click', () => $('#paletteDrawer').classList.add('hidden'));
$('#palTo').addEventListener('input', e => { $('#palToHex').value = e.target.value; });
$('#palToHex').addEventListener('change', e => {
  const value = e.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) $('#palTo').value = value;
});

$('#palApply').addEventListener('click', async () => {
  if (!state.paletteDir || !state.paletteFrom) return;
  const button = $('#palApply');
  button.disabled = true;
  try {
    const to = /^#[0-9a-fA-F]{6}$/.test($('#palToHex').value.trim())
      ? $('#palToHex').value.trim()
      : $('#palTo').value;
    const result = await invoke('palette:apply', { dir: state.paletteDir, from: state.paletteFrom, to });
    if (!result.replaced) {
      toast('Nothing changed — that color is no longer in the site.', { kind: 'err' });
    } else {
      toast(`Replaced ${result.replaced} occurrence${result.replaced === 1 ? '' : 's'} across ${result.files} file${result.files === 1 ? '' : 's'}`, { kind: 'ok' });
    }
    const site = state.library.sites.find(s => s.dir === state.paletteDir);
    if (site) await openPalette(site);
    invoke('thumb:make', { dir: state.paletteDir }).then(refreshLibrary).catch(() => {});
  } catch (err) {
    failed(err);
  } finally {
    button.disabled = false;
  }
});

/* ---------- menu + keyboard ---------- */
window.snap.on('ui:refresh', refreshLibrary);
window.snap.on('ui:settings', openSettings);
window.snap.on('ui:doctor', () => refreshEnv().then(() => openDoctor()));
window.snap.on('ui:about', openAbout);
window.snap.on('ui:focus-url', () => { $('#url').focus(); $('#url').select(); });
window.snap.on('env:changed', () => refreshEnv());

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMenu();
    for (const sel of ['#settingsModal', '#doctorModal', '#aboutModal', '#paletteDrawer']) {
      $(sel).classList.add('hidden');
    }
  }
  if (e.key === 'Enter' && !$('#settingsModal').classList.contains('hidden')) $('#setSave').click();
  if (e.key === '/' && document.activeElement === document.body) {
    e.preventDefault();
    $('#libSearch').focus();
  }
});

// Click the backdrop to dismiss a modal.
for (const id of ['settingsModal', 'doctorModal', 'aboutModal']) {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) e.target.classList.add('hidden');
  });
}

/* ---------- init ---------- */
(async () => {
  try {
    const [{ settings }] = await Promise.all([invoke('settings:get'), refreshEnv()]);
    state.settings = settings;
    applyRememberedOptions(settings);
    $('#libSort').value = settings.sort;
    $('#libShowRaw').checked = settings.showRaw;
    await refreshLibrary();
    if (!settings.seenWelcome) {
      openDoctor(true);
      invoke('settings:set', { seenWelcome: true }).catch(() => {});
    }
    $('#url').focus();
  } catch (err) {
    failed(err);
  }
})();
