/* SiteSlurp renderer */
const $ = sel => document.querySelector(sel);
const invoke = (channel, data) => window.snap.invoke(channel, data);

const state = {
  library: { root: '', sites: [], missing: false },
  env: null,
  settings: null,
  busy: false,
  tab: 'extractor',
  paletteDir: null,
  paletteFrom: null,
  filter: '',
  runStarted: 0,
  runTimer: null,
  zipToast: null,
};

/* ---------- tabs ----------
   Extractor owns capturing and the run log; Studio owns hosting and the
   library. Anything that starts a run pulls the user back to Extractor so the
   log is never running behind a hidden tab. */
const TABS = ['extractor', 'studio'];

function setTab(name, { persist = true } = {}) {
  if (!TABS.includes(name)) name = 'extractor';
  state.tab = name;
  for (const tab of TABS) {
    const on = tab === name;
    const button = document.getElementById('tab-' + tab);
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
    document.getElementById('view-' + tab).classList.toggle('hidden', !on);
  }
  window.scrollTo({ top: 0 });
  if (persist) invoke('settings:set', { tab: name }).catch(() => {});
}

for (const tab of TABS) {
  document.getElementById('tab-' + tab).addEventListener('click', () => setTab(tab));
}
$('#btnGoStudio').addEventListener('click', () => setTab('studio'));

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
// One word in the title bar, not a readout. The browser name, engine path and
// captures folder all live one click away in Setup & diagnostics — spelling
// them out up here was noise on every screen.
async function refreshEnv() {
  state.env = await invoke('env:get');
  const { browser, singleFile, capturesRoot } = state.env;
  const ok = browser.ok && singleFile.ok && capturesRoot.ok;
  const button = $('#envStatus');
  button.innerHTML = `<span class="dot ${ok ? 'ok' : 'bad'}"></span><span></span>`;
  button.querySelector('span:last-child').textContent = ok ? 'Ready' : 'Setup needed';
  button.classList.toggle('warn', !ok);
  button.title = ok
    ? `Ready — capturing with ${browser.name}. Click for setup & diagnostics.`
    : 'Something needed for capturing is missing. Click for setup & diagnostics.';
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
        : 'SiteSlurp drives a real browser so React and other JS-heavy sites render before they are saved. Install Microsoft Edge or Google Chrome, then reopen this dialog.',
    });
  } else {
    list.push({ ok: true, title: `Browser: ${env.browser.name}`, detail: env.browser.path });
  }
  list.push(env.singleFile.ok
    ? { ok: true, title: `Capture engine ready${env.singleFile.bundled ? ' (bundled)' : ''}`, detail: env.singleFile.path }
    : { ok: false, title: 'Capture engine missing', detail: 'Reinstall SiteSlurp, or point Settings → Advanced at a single-file-cli install.' });
  list.push(env.capturesRoot.ok
    ? { ok: true, title: 'Captures folder writable', detail: env.capturesRoot.path }
    : { ok: false, title: 'Captures folder is not writable', detail: `${env.capturesRoot.path} — pick another folder in Settings.` });
  return list;
}

function openDoctor(firstRun = false) {
  const list = problems();
  $('#doctorTitle').textContent = firstRun ? 'Welcome to SiteSlurp Studio' : 'Setup & diagnostics';
  $('#doctorIntro').textContent = firstRun
    ? 'Paste any URL and SiteSlurp saves the whole site, unpacks it into editable files, and hosts it on localhost. Here is what it found on this machine:'
    : '';
  const ul = $('#doctorList');
  ul.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    li.className = item.ok ? 'ok' : 'bad';
    li.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${item.ok ? 'check' : 'alert'}"/></svg>`;
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
  $('#setSnapIdle').value = settings.autoSnapshotIdleSec;
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
      autoSnapshotIdleSec: parseInt($('#setSnapIdle').value, 10) || 45,
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
  syncOptions();
}

/* The options panel is collapsed by default, so this one line has to say
   everything the old row of checkboxes said — in words, not ticks. */
function syncOptions() {
  const crawl = $('#crawl').checked;
  const bits = [crawl ? `whole site, depth ${$('#depth').value}` : 'single page'];
  bits.push($('#mobile').checked ? 'mobile' : 'desktop');
  if ($('#fixVideos').checked) bits.push('videos restored');
  if ($('#stripBanners').checked) bits.push('banners stripped');
  if ($('#showBrowser').checked) bits.push('browser visible');
  const wait = parseInt($('#waitDelay').value, 10) || 0;
  if (wait) bits.push(`${wait / 1000}s wait`);
  const name = $('#siteName').value.trim();
  if (name) bits.push(`saved as "${name}"`);
  $('#optsSummary').textContent = bits.join('  ·  ');

  // Depth is meaningless on a single-page capture — show it that way.
  $('#depthRow').classList.toggle('off', !crawl);
  $('#depth').disabled = !crawl;
}

$('#options').addEventListener('change', syncOptions);
$('#siteName').addEventListener('input', syncOptions);

$('#btnOptions').addEventListener('click', () => {
  const panel = $('#options');
  const open = panel.classList.toggle('hidden') === false;
  $('#btnOptions').setAttribute('aria-expanded', String(open));
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
  setTab('extractor');   // extracting from a Studio card still shows its log
  $('#runPanel').classList.remove('hidden');
  $('#runLog').textContent = '';
  $('#runSpinner').className = 'spinner';
  $('#runPanel .run-status').classList.remove('fail');
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
  // The only red in the app: a run that actually failed.
  $('#runPanel .run-status').classList.toggle('fail', kind === 'fail');
}

window.snap.on('run:log', text => {
  // A dependency install is started from the runtime panel, so its output
  // belongs there and not on a tab the user would have to go looking for.
  if (rt.capturing) {
    const box = $('#rtLog');
    box.textContent += text + '\n';
    box.scrollTop = box.scrollHeight;
  }
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

// The dev server behind a card reports as it boots. A full refresh happens when
// it lands (main sends ui:refresh); until then just keep the badge honest.
window.snap.on('runtime:state', ({ dir, status, message }) => {
  const card = [...document.querySelectorAll('.card')].find(c => c.dataset.dir === dir);
  const badge = card && card.querySelector('.badge.live');
  if (!badge) return;
  badge.classList.toggle('booting', status === 'starting');
  badge.classList.toggle('missing', status === 'failed');
  const site = state.library && state.library.sites.find(s => s.dir === dir);
  badge.textContent = status === 'starting' ? 'starting…'
    : status === 'failed' ? 'failed to start'
      : 'localhost:' + ((site && site.port) || '');
  badge.title = message || 'Open in browser';
});

window.snap.on('zip:progress', ({ done, total }) => {
  if (state.zipToast) state.zipToast.textContent = `Zipping ${done}/${total}…`;
});

// The tunnel engine is fetched once, on the very first share — a ~60MB download
// the toast narrates so the wait doesn't read as a hang.
window.snap.on('share:download', ({ done, total }) => {
  if (!state.shareToast) return;
  const mb = n => Math.round(n / 1048576);
  state.shareToast.textContent = total
    ? `First share: downloading the tunnel engine — ${mb(done)} of ${mb(total)} MB…`
    : `First share: downloading the tunnel engine — ${mb(done)} MB…`;
});

// A tunnel that dies on its own (network drop) reports here; main also sends
// ui:refresh, so this only keeps the badge honest until the refresh lands.
window.snap.on('share:state', ({ dir, status, url }) => {
  const card = [...document.querySelectorAll('.card')].find(c => c.dataset.dir === dir);
  if (!card) return;
  const badge = card.querySelector('.badge.public');
  if (badge && status !== 'up') badge.remove();
  if (badge && status === 'up') badge.title = url;
});

window.snap.on('run:busy', ({ busy }) => {
  state.busy = busy;
  $('#btnCapture').disabled = busy;
  $('#tab-extractor').classList.toggle('busy', busy);
});

window.snap.on('run:done', async ({ ok, dir, stats, error, canceled, seconds, install }) => {
  // An install has no capture stats to summarise — it either worked or it said why.
  if (install) {
    stopRunPanel(ok ? 'done' : 'fail', ok ? 'Dependencies installed.' : 'Install failed: ' + error);
    await refreshLibrary();
    return;
  }
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
async function hostSite(dir, site = null) {
  // A project that runs a dev server can't start without its dependencies.
  // Better to offer the install than to let the boot page show a crash.
  if (site && site.needsInstall && site.runtime && site.runtime.install) {
    const yes = await invoke('shell:confirm', {
      title: 'Install dependencies',
      message: `"${site.name}" hasn't had its dependencies installed yet.`,
      detail: `Run "${site.runtime.install}" in ${site.dir} now? This can take a few minutes.`,
      confirmLabel: 'Install',
    });
    if (!yes) return;
    startRunPanel('Installing dependencies…');
    try {
      await invoke('project:install', { id: site.projectId });
    } catch (err) {
      stopRunPanel('fail', err.message);
      failed(err);
      return;
    }
    await refreshLibrary();
  }
  try {
    const { port, url } = await invoke('host:start', { dir });
    if (!state.settings || state.settings.openAfterHost) await invoke('open:url', { url });
    const booting = site && site.runtime && site.runtime.kind === 'command';
    toast(booting
      ? `Starting ${site.runtime.label} on localhost:${port} — the page turns into the site when it's up`
      : `Hosting on localhost:${port}`,
    { kind: 'ok', timeout: booting ? 9000 : undefined, action: { label: 'Open', fn: () => invoke('open:url', { url }) } });
    await refreshLibrary();
  } catch (err) {
    failed(err);
  }
}

async function stopSite(dir) {
  await invoke('host:stop', { dir }).catch(failed);
  await refreshLibrary();
}

/* ---------- public sharing ---------- */
// One click on the share toggle puts the hosted port online through a
// Cloudflare quick tunnel and hands back an https link; the same click takes
// it down. The link is random on purpose — shareable, not guessable.
async function shareSite(site) {
  const pending = toast(`Creating a public link for "${site.name}"…`, { timeout: 0 });
  state.shareToast = pending.querySelector('span');
  try {
    const { url } = await invoke('share:start', { dir: site.dir });
    pending.remove();
    toast(`${site.name} is public at ${url.replace('https://', '')} — the link works until sharing or hosting stops`, {
      kind: 'ok', timeout: 15000,
      action: { label: 'Copy link', fn: () => navigator.clipboard.writeText(url) },
    });
  } catch (err) {
    pending.remove();
    failed(err);
  } finally {
    state.shareToast = null;
  }
  await refreshLibrary();
}

async function unshareSite(site) {
  await invoke('share:stop', { dir: site.dir }).catch(failed);
  toast('Public link taken down', { kind: 'ok', timeout: 3000 });
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
// Every generated icon carries .icon. A bare <svg> with no size falls back to
// 300×150, which is how the Host button once rendered as a billboard.
function iconBtn(icon, title, fn) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = `<svg class="icon"><use href="#i-${icon}"/></svg>`;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(); } catch (err) { failed(err); } finally { b.disabled = false; }
  });
  return b;
}

function textButton(icon, label, fn) {
  const b = document.createElement('button');
  b.className = 'host-btn';
  b.innerHTML = `<svg class="icon"><use href="#i-${icon}"/></svg> <span></span>`;
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
      row.innerHTML = `<svg class="icon"><use href="#i-${item.icon}"/></svg><span></span>`;
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

// A project that runs a process is either booting, up, or broken — and that
// matters more on the card than "how many HTML files are in the folder".
const runState = site => (site.runtimeState && site.runtimeState.kind === 'command' ? site.runtimeState : null);

function renderCard(site) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.dir = site.dir;

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
  const running = runState(site);
  const shared = site.share && site.share.status === 'up' && site.port ? site.share : null;
  if (site.port) {
    badge.className = 'badge live';
    badge.textContent = 'localhost:' + site.port;
    badge.title = 'Open in browser';
    // A dev server takes a moment to come up; the badge says so rather than
    // promising an address that isn't answering yet.
    if (running && running.status !== 'ready') {
      badge.classList.add(running.status === 'failed' ? 'missing' : 'booting');
      badge.textContent = running.status === 'failed' ? 'failed to start' : 'starting…';
      badge.title = running.message || '';
    }
    badge.addEventListener('click', e => {
      e.stopPropagation();
      invoke('open:url', { url: `http://localhost:${site.port}/` }).catch(failed);
    });
  } else if (site.missing) { badge.className = 'badge missing'; badge.textContent = 'missing'; }
  else if (site.kind === 'local') { badge.className = 'badge local'; badge.textContent = 'local'; }
  else if (site.kind === 'extracted') { badge.className = 'badge extracted'; badge.textContent = 'extracted'; }
  else { badge.className = 'badge'; badge.textContent = 'raw'; }
  thumb.appendChild(badge);
  if (shared) {
    const pub = document.createElement('span');
    pub.className = 'badge public';
    pub.textContent = 'public';
    pub.title = shared.url + ' — open the public link';
    pub.addEventListener('click', e => {
      e.stopPropagation();
      invoke('open:url', { url: shared.url }).catch(failed);
    });
    thumb.appendChild(pub);
  }
  if (!site.missing && (site.kind === 'extracted' || site.kind === 'local' || site.port)) {
    thumb.classList.add('clickable');
    thumb.title = 'Open this site';
    thumb.addEventListener('click', () => (site.port
      ? invoke('open:url', { url: `http://localhost:${site.port}/` })
      : hostSite(site.dir, site)));
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
  // "0 pages" is a lie about a Next.js app — it has no HTML until it runs. What
  // that card should say is what will be run.
  const command = site.runtime && site.runtime.kind === 'command' ? site.runtime : null;
  meta.textContent = site.missing
    ? 'folder not found on disk'
    : command
      ? `${command.label}${site.needsInstall ? ' · needs install' : ''} · ${fileSize(site.sizeBytes)}`
      : `${site.pages} page${site.pages === 1 ? '' : 's'} · ${fileSize(site.sizeBytes)} · `
        + new Date(site.mtime).toLocaleDateString();
  if (command) meta.title = command.command || '';
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
      if (done) toast('Moved to the system trash', { kind: 'ok', timeout: 3000 });
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
  // For a folder that isn't just HTML, "how does this get served" is the first
  // thing anyone needs — it comes before the file-manager actions.
  if (site.kind === 'local' && site.projectId) {
    more.push({ icon: 'gear', label: 'How to serve this…', fn: () => openRuntime(site) });
    if (site.port && site.runtime && site.runtime.kind === 'command') {
      more.push({ icon: 'refresh', label: 'Restart server', fn: async () => {
        await invoke('runtime:restart', { dir: site.dir });
        toast('Restarting…', { kind: 'ok', timeout: 3000 });
        await refreshLibrary();
      } });
    }
  }
  if (shared) {
    more.push({ icon: 'share', label: 'Copy public link', fn: async () => {
      await navigator.clipboard.writeText(shared.url);
      toast('Public link copied', { kind: 'ok', timeout: 2500 });
    } });
  }
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
  // Which page "/" opens on — a static-serving question; a dev server routes itself.
  if (site.projectId && !site.missing && !command) {
    more.push({ icon: 'home', label: 'Set entry page…', fn: () => openEntry(site) });
  }
  if (site.projectId) {
    if (site.reviewActive) {
      more.push({ icon: 'stop', label: 'End review mode', fn: async () => {
        await invoke('review:stop', { dir: site.dir });
        toast('Review mode off — the overlay is gone on next reload', { kind: 'ok', timeout: 4000 });
        await refreshLibrary();
      } });
    }
    // A restorable copy of the files as they are right now.
    if (!site.missing) {
      more.push({ icon: 'layers', label: 'Snapshot now…', fn: () => openSnapshotPrompt(site) });
    }
    more.push({ icon: 'history', label: 'Project history', fn: () => openHistory(site) });
    // A dev server does its own hot reload — SiteSlurp's file watcher would only
    // fight it, so the toggle is a static-hosting option.
    if (!command) {
      more.push({ icon: 'refresh', label: site.liveReload ? 'Live reload: on' : 'Live reload: off', fn: async () => {
        await invoke('project:setLiveReload', { id: site.projectId, liveReload: !site.liveReload });
        await refreshLibrary();
      } });
    }
    // Snapshot on its own after edits go quiet, while the site is hosted.
    if (!site.missing) {
      more.push({ icon: 'layers', label: site.autoSnapshot ? 'Auto-snapshot: on' : 'Auto-snapshot: off', fn: async () => {
        await invoke('project:setAutoSnapshot', { id: site.projectId, autoSnapshot: !site.autoSnapshot });
        await refreshLibrary();
      } });
    }
    more.push({ icon: 'check', label: site.autoStart ? 'Auto-start: on' : 'Auto-start: off', fn: async () => {
      await invoke('project:setAutoStart', { id: site.projectId, autoStart: !site.autoStart });
      await refreshLibrary();
    } });
  }
  if (site.kind !== 'local') more.push({ icon: 'zip', label: 'Export ZIP', fn: exportZip });

  if (site.kind === 'raw') {
    actions.appendChild(textButton('unpack', 'Extract', async () => {
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
    actions.appendChild(textButton('stop', 'Stop', () => stopSite(site.dir)));
    actions.appendChild(iconBtn('open', 'Open in browser', () =>
      invoke('open:url', { url: `http://localhost:${site.port}/` })));
    const shareBtn = iconBtn('share', shared
      ? 'Stop sharing — the public link stops working'
      : 'Share publicly — creates an https link anyone can open', () =>
      (shared ? unshareSite(site) : shareSite(site)));
    if (shared) shareBtn.classList.add('sharing');
    actions.appendChild(shareBtn);
  } else if (!site.missing) {
    actions.appendChild(textButton('globe', 'Host', () => hostSite(site.dir, site)));
  }
  if (site.projectId && !site.missing) {
    actions.appendChild(iconBtn('note', 'Review this site (annotate + export a spec)', async () => {
      await invoke('review:start', { dir: site.dir });
      toast('Review mode on — annotate in the browser, then Export from the toolbar', { kind: 'ok', timeout: 7000 });
      await refreshLibrary();
    }));
  }
  if (site.kind === 'extracted') {
    actions.appendChild(iconBtn('palette', 'Recolor palette', () => openPalette(site)));
  }
  if (site.kind === 'local') {
    actions.appendChild(iconBtn('trash', 'Remove from library (files stay on disk)', removeLocal));
  } else {
    actions.appendChild(iconBtn('trash', 'Delete (moves to the system trash)', deleteSite));
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

/* The Extractor tab's own short list: the last few things this app produced,
   with the one action each of them is waiting for. Local folders belong to
   Studio, so they stay out of it. */
function renderRecent() {
  const rows = state.library.sites
    .filter(site => !site.missing && (site.kind === 'raw' || site.kind === 'extracted'))
    .filter(site => !(site.kind === 'raw' && site.hasExtracted))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 4);

  $('#recentWrap').classList.toggle('hidden', !rows.length);
  const list = $('#recentList');
  list.innerHTML = '';
  for (const site of rows) {
    const row = document.createElement('div');
    row.className = 'recent-row';

    const info = document.createElement('div');
    info.className = 'recent-info';
    const name = document.createElement('div');
    name.className = 'recent-name';
    name.textContent = site.name;
    const meta = document.createElement('div');
    meta.className = 'recent-meta';
    if (site.port) {
      meta.innerHTML = '<span class="port"></span>';
      meta.querySelector('.port').textContent = `localhost:${site.port}`;
      meta.append(` · ${site.pages} page${site.pages === 1 ? '' : 's'} · ${fileSize(site.sizeBytes)}`);
    } else {
      meta.textContent = site.kind === 'raw'
        ? `raw snapshot · ${fileSize(site.sizeBytes)} · not extracted yet`
        : `${site.pages} page${site.pages === 1 ? '' : 's'} · ${fileSize(site.sizeBytes)}`;
    }
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);

    if (site.kind === 'raw') {
      row.appendChild(textButton('unpack', 'Extract', async () => {
        startRunPanel('Extracting…');
        try {
          await invoke('extract:run', { dir: site.dir });
        } catch (err) {
          stopRunPanel('fail', err.message);
          throw err;
        }
      }));
    } else if (site.port) {
      row.appendChild(textButton('open', 'Open', () =>
        invoke('open:url', { url: `http://localhost:${site.port}/` })));
    } else {
      row.appendChild(textButton('globe', 'Host', () => hostSite(site.dir, site)));
    }
    list.appendChild(row);
  }
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
      : 'Nothing here yet — capture a site in the Extractor tab, or drop a folder to add your own.';
  }
  $('#libCount').textContent = sites.length || '';

  const hosted = state.library.sites.filter(s => s.port);
  $('#tabStudioCount').textContent = state.library.sites.length || '';
  $('#tab-studio').classList.toggle('busy', hosted.length > 0);
  renderRecent();
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

/* ---------- project history: reviews + versions ----------
   One modal, two tabs — everything a site has been through. Reviews are the
   existing history; Versions is the snapshot timeline from the Phase-2
   engine: restore, pin & view, diff. */
const hist = { site: null, tab: 'reviews', snapshots: [], diff: null };

function histSetTab(tab) {
  hist.tab = tab;
  $('#histTabReviews').classList.toggle('on', tab === 'reviews');
  $('#histTabReviews').setAttribute('aria-selected', String(tab === 'reviews'));
  $('#histTabVersions').classList.toggle('on', tab === 'versions');
  $('#histTabVersions').setAttribute('aria-selected', String(tab === 'versions'));
  $('#historyList').classList.toggle('hidden', tab !== 'reviews');
  $('#versionsPane').classList.toggle('hidden', tab !== 'versions');
}

async function openHistory(site, tab = 'reviews') {
  hist.site = site;
  $('#historyTitle').textContent = `Project history — ${site.name}`;
  $('#diffPane').classList.add('hidden');
  $('#versionsList').classList.remove('hidden');
  histSetTab(tab);
  await renderReviewHistory(site);
  if (tab === 'versions') await renderVersions(site);
  $('#historyModal').classList.remove('hidden');
}

async function renderReviewHistory(site) {
  const { reviews } = await invoke('review:history', { id: site.projectId });
  const list = $('#historyList');
  list.innerHTML = '';
  if (!reviews.length) {
    list.innerHTML = '<div class="history-empty">No reviews yet — click the speech-bubble button on the card to start one.</div>';
  }
  for (const review of reviews) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = review.id.replace(/^rev_(\d{4})(\d{2})(\d{2})_(\d+)$/, '$1-$2-$3 #$4');
    const meta = document.createElement('span');
    meta.className = 'mini';
    meta.textContent = ` ${review.annotations} note${review.annotations === 1 ? '' : 's'}`
      + (review.resolved ? ` · ${review.resolved} resolved` : '')
      + (review.exportedAt ? ' · exported' : ' · open');
    info.appendChild(title);
    info.appendChild(meta);
    row.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (review.annotations) {
      actions.appendChild(iconBtn('export', review.exportedAt ? 'Re-export this review' : 'Export this review', async () => {
        const { folder } = await invoke('review:export', { id: site.projectId, reviewId: review.id });
        toast(`Review of ${site.name} exported`, {
          kind: 'ok', timeout: 12000,
          action: { label: 'Open folder', fn: () => invoke('open:folder', { dir: folder }) },
        });
        await renderReviewHistory(site); // the row's exported state just changed
      }));
    }
    if (review.exportFolder) {
      actions.appendChild(iconBtn('folder', 'Open export folder', () =>
        invoke('open:folder', { dir: review.exportFolder })));
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}
$('#historyClose').addEventListener('click', () => $('#historyModal').classList.add('hidden'));
$('#histTabReviews').addEventListener('click', () => histSetTab('reviews'));
$('#histTabVersions').addEventListener('click', async () => {
  histSetTab('versions');
  if (hist.site) await renderVersions(hist.site);
});

/* ---------- versions tab ---------- */
const SOURCE_LABELS = { manual: 'manual', auto: 'auto', palette: 'recolor', 'pre-restore': 'pre-restore', capture: 'capture' };

function versionStamp(snap) {
  const date = new Date(snap.timestamp);
  return isNaN(date.getTime())
    ? snap.id
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// Pinned viewing only exists for sites served straight off their files.
const canPinSite = site => !(site.runtime && site.runtime.kind === 'command');

async function renderVersions(site) {
  const list = $('#versionsList');
  $('#diffPane').classList.add('hidden');
  list.classList.remove('hidden');
  $('#versionsHint').textContent = canPinSite(site)
    ? 'Every snapshot is restorable — restoring saves the current state first. Pin & view shows an old version in the browser while live serving stays untouched.'
    : 'Snapshots cover this project\'s source files. Pin & view is off for dev-server projects — their pages aren\'t a pure function of the files on disk.';
  list.innerHTML = '<div class="history-empty">Loading…</div>';
  let result;
  try {
    result = await invoke('version:list', { id: site.projectId });
  } catch (err) {
    list.innerHTML = '';
    failed(err);
    return;
  }
  hist.snapshots = result.snapshots;
  list.innerHTML = '';
  if (!result.snapshots.length) {
    list.innerHTML = '<div class="history-empty">No snapshots yet — "Snapshot now…" is in the card\'s ⋯ menu, and hosted sites snapshot themselves once your edits go quiet.</div>';
    return;
  }
  for (const snap of result.snapshots) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const info = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = 'ver-badge ver-' + snap.source;
    badge.textContent = SOURCE_LABELS[snap.source] || snap.source;
    const title = document.createElement('strong');
    title.textContent = snap.label || versionStamp(snap);
    const meta = document.createElement('span');
    meta.className = 'mini';
    meta.textContent = ` ${snap.label ? versionStamp(snap) + ' · ' : ''}`
      + `${snap.stats.files} file${snap.stats.files === 1 ? '' : 's'} · ${fileSize(snap.stats.bytes)}`
      + (snap.stats.newBlobs ? ` · ${snap.stats.newBlobs} new` : '');
    info.appendChild(badge);
    info.appendChild(title);
    info.appendChild(meta);
    row.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.appendChild(iconBtn('code', 'Diff against… — see what changed', () => openDiff(site, snap)));
    if (canPinSite(site)) {
      actions.appendChild(iconBtn('open', 'Pin & view — open the browser on this snapshot', () => pinAndView(site, snap)));
    }
    actions.appendChild(iconBtn('undo', 'Restore — make the files match this snapshot (the current state is snapshotted first)', () => restoreVersion(site, snap)));
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function pinAndView(site, snap) {
  let port = site.port;
  if (!port) {
    ({ port } = await invoke('host:start', { dir: site.dir }));
    await refreshLibrary();
  }
  await invoke('open:url', { url: `http://localhost:${port}/?v=${encodeURIComponent(snap.id)}` });
}

async function restoreVersion(site, snap) {
  const yes = await invoke('shell:confirm', {
    title: 'Restore snapshot',
    message: `Make "${site.name}" match this snapshot?`,
    detail: `${snap.label || versionStamp(snap)}\n\nThe files as they are now get snapshotted first, so this is fully undoable.`,
    confirmLabel: 'Restore',
  });
  if (!yes) return;
  await invoke('version:restore', { id: site.projectId, versionId: snap.id });
  toast('Restored — the previous state was snapshotted first', { kind: 'ok' });
  await renderVersions(site);
  await refreshLibrary();
}

/* ---------- diff view ---------- */
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
};
const extOf = p => String(p).toLowerCase().split('.').pop();
const isImagePath = p => !!IMAGE_MIME[extOf(p)];

const emptyNote = text => {
  const el = document.createElement('div');
  el.className = 'history-empty';
  el.textContent = text;
  return el;
};

async function openDiff(site, snap) {
  hist.diff = { site, a: snap.id };
  $('#versionsList').classList.add('hidden');
  $('#diffPane').classList.remove('hidden');
  $('#diffTitle').textContent = snap.label || versionStamp(snap);
  const pick = $('#diffAgainst');
  pick.innerHTML = '';
  const options = [
    { id: 'working', label: 'the working files (now)' },
    ...hist.snapshots.filter(s => s.id !== snap.id)
      .map(s => ({ id: s.id, label: s.label || versionStamp(s) })),
  ];
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label;
    pick.appendChild(el);
  }
  pick.value = 'working';
  await renderDiffFiles();
}

async function renderDiffFiles() {
  if (!hist.diff) return;
  const { site, a } = hist.diff;
  const b = $('#diffAgainst').value;
  $('#diffView').classList.add('hidden');
  const box = $('#diffFiles');
  box.innerHTML = '<div class="history-empty">Comparing…</div>';
  let diff;
  try {
    diff = await invoke('version:diff', { id: site.projectId, a, b });
  } catch (err) {
    box.innerHTML = '';
    failed(err);
    return;
  }
  box.innerHTML = '';
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (!total) {
    box.appendChild(emptyNote('No differences — the two states are identical.'));
    return;
  }
  for (const [label, files, kind] of [['Added', diff.added, 'add'], ['Removed', diff.removed, 'del'], ['Changed', diff.changed, 'chg']]) {
    if (!files.length) continue;
    const head = document.createElement('div');
    head.className = 'diff-group';
    head.textContent = `${label} (${files.length})`;
    box.appendChild(head);
    for (const file of files) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'diff-file ' + kind;
      row.innerHTML = '<span class="diff-path"></span><span class="mini"></span>';
      row.querySelector('.diff-path').textContent = file.path;
      row.querySelector('.mini').textContent = kind === 'chg'
        ? `${fileSize(file.sizeA)} → ${fileSize(file.sizeB)}`
        : fileSize(file.size);
      if (kind === 'chg') row.addEventListener('click', () => showFileDiff(file.path));
      else row.disabled = true;
      box.appendChild(row);
    }
  }
}

async function showFileDiff(relPath) {
  const { site, a } = hist.diff;
  const b = $('#diffAgainst').value;
  const view = $('#diffView');
  view.classList.remove('hidden');
  view.innerHTML = '<div class="history-empty">Loading…</div>';

  const name = document.createElement('div');
  name.className = 'diff-file-name mini';
  name.textContent = relPath;

  if (isImagePath(relPath)) {
    // Before/after side by side, both sides streamed out of the store.
    try {
      const [before, after] = await Promise.all([
        invoke('version:readFile', { id: site.projectId, versionId: a, path: relPath }),
        invoke('version:readFile', { id: site.projectId, versionId: b, path: relPath }),
      ]);
      view.innerHTML = '';
      view.appendChild(name);
      const pair = document.createElement('div');
      pair.className = 'img-pair';
      for (const [caption, payload] of [['Before', before], ['After', after]]) {
        const cell = document.createElement('figure');
        const img = document.createElement('img');
        img.src = `data:${IMAGE_MIME[extOf(relPath)]};base64,${payload.base64}`;
        img.alt = caption;
        const cap = document.createElement('figcaption');
        cap.className = 'mini';
        cap.textContent = `${caption} · ${fileSize(payload.size)}`;
        cell.appendChild(img);
        cell.appendChild(cap);
        pair.appendChild(cell);
      }
      view.appendChild(pair);
    } catch (err) {
      view.innerHTML = '';
      failed(err);
    }
    return;
  }

  let result;
  try {
    result = await invoke('version:diff', { id: site.projectId, a, b, path: relPath });
  } catch (err) {
    view.innerHTML = '';
    failed(err);
    return;
  }
  view.innerHTML = '';
  view.appendChild(name);
  if (result.kind === 'binary') { view.appendChild(emptyNote('Binary file — no line diff.')); return; }
  if (result.kind === 'large') { view.appendChild(emptyNote('Too large to diff here.')); return; }
  if (!result.changed) { view.appendChild(emptyNote('The bytes differ but the lines match (line endings, most likely).')); return; }
  const code = document.createElement('div');
  code.className = 'diff-code';
  for (const seg of result.segments) {
    if (seg.kind === 'skip') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${seg.lines.length} unchanged lines`;
      details.appendChild(summary);
      const inner = document.createElement('div');
      for (const op of seg.lines) inner.appendChild(diffLineEl(op));
      details.appendChild(inner);
      code.appendChild(details);
    } else {
      for (const op of seg.lines) code.appendChild(diffLineEl(op));
    }
  }
  view.appendChild(code);
}

function diffLineEl(op) {
  const row = document.createElement('div');
  row.className = 'dl' + (op.type === 'add' ? ' add' : op.type === 'del' ? ' del' : '');
  const sign = document.createElement('span');
  sign.className = 'sign';
  sign.textContent = op.type === 'add' ? '+' : op.type === 'del' ? '−' : '';
  const text = document.createElement('span');
  text.className = 'txt';
  text.textContent = op.line;
  row.appendChild(sign);
  row.appendChild(text);
  return row;
}

$('#diffBack').addEventListener('click', () => {
  $('#diffPane').classList.add('hidden');
  $('#versionsList').classList.remove('hidden');
});
$('#diffAgainst').addEventListener('change', renderDiffFiles);

/* ---------- snapshot prompt ---------- */
const snapState = { site: null };

function openSnapshotPrompt(site) {
  snapState.site = site;
  $('#snapName').textContent = '— ' + site.name;
  $('#snapLabel').value = '';
  $('#snapModal').classList.remove('hidden');
  $('#snapLabel').focus();
}

$('#snapCancel').addEventListener('click', () => $('#snapModal').classList.add('hidden'));
$('#snapLabel').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#snapSave').click(); }
});
$('#snapSave').addEventListener('click', async () => {
  const site = snapState.site;
  if (!site) return;
  const button = $('#snapSave');
  button.disabled = true;
  try {
    const result = await invoke('version:create', { id: site.projectId, label: $('#snapLabel').value.trim() });
    $('#snapModal').classList.add('hidden');
    if (result.unchanged) {
      toast('No changes since the last snapshot — nothing new to save.', { timeout: 5000 });
    } else {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      toast(`Snapshot saved · ${time}`, {
        kind: 'ok',
        action: { label: 'History', fn: () => openHistory(site, 'versions') },
      });
    }
  } catch (err) {
    failed(err);
  } finally {
    button.disabled = false;
  }
});

/* ---------- calibration manager ----------
   Anchors and standing preferences were write-only until now. Each row edits
   in place; deletes ask first — this file is the asset that grows. */
function calRow({ badge = null, text, meta = '', img = null, onSave = null, onDelete }) {
  const row = document.createElement('div');
  row.className = 'cal-row';
  if (img) {
    const shot = document.createElement('img');
    shot.className = 'cal-shot';
    shot.src = img;
    shot.alt = '';
    row.appendChild(shot);
  }
  if (badge) {
    const chip = document.createElement('span');
    chip.className = 'cal-badge';
    chip.textContent = badge;
    row.appendChild(chip);
  }
  const body = document.createElement('div');
  body.className = 'cal-body';
  const line = document.createElement('span');
  line.className = 'cal-text';
  line.textContent = text;
  body.appendChild(line);
  if (meta) {
    const mini = document.createElement('span');
    mini.className = 'cal-meta mini';
    mini.textContent = meta;
    body.appendChild(mini);
  }
  row.appendChild(body);

  if (onSave) {
    row.appendChild(iconBtn('edit', 'Edit', () => {
      const edit = document.createElement('div');
      edit.className = 'cal-edit';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = text;
      input.spellcheck = false;
      const save = document.createElement('button');
      save.className = 'primary small';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        try { await onSave(input.value); await openCalibration(); } catch (err) { failed(err); }
      });
      edit.appendChild(input);
      edit.appendChild(save);
      body.replaceChildren(edit);
      input.focus();
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') save.click();
        e.stopPropagation(); // Escape while typing cancels the edit, not the modal
        if (e.key === 'Escape') openCalibration();
      });
    }));
  }
  row.appendChild(iconBtn('trash', 'Delete', async () => {
    const yes = await invoke('shell:confirm', {
      title: 'Delete from calibration',
      message: 'Remove this from your calibration?',
      detail: text.length > 120 ? text.slice(0, 120) + '…' : text,
      confirmLabel: 'Remove',
    });
    if (!yes) return;
    await onDelete();
    await openCalibration();
  }));
  return row;
}

async function openCalibration() {
  let data;
  try { data = await invoke('calibration:get'); } catch (err) { failed(err); return; }

  const prefs = $('#calPrefs');
  prefs.innerHTML = '';
  if (!data.standingPreferences.length) {
    prefs.innerHTML = '<div class="history-empty">Nothing standing yet. When a complaint repeats across reviews, a toast offers to promote it here.</div>';
  }
  data.standingPreferences.forEach((text, index) => prefs.appendChild(calRow({
    text,
    onSave: value => invoke('calibration:update', { preference: { index, text: value } }),
    onDelete: () => invoke('calibration:removePreference', { index }),
  })));

  const anchors = $('#calAnchors');
  anchors.innerHTML = '';
  if (!data.anchors.length) {
    anchors.innerHTML = '<div class="history-empty">No anchors yet. Resolving an annotation as an anchor records what that rating looks like.</div>';
  }
  data.anchors.forEach((anchor, index) => anchors.appendChild(calRow({
    badge: `${anchor.rating}/10`,
    text: anchor.summary,
    meta: [anchor.axis, anchor.note].filter(Boolean).join(' · '),
    img: anchor.screenshotUrl,
    onSave: value => invoke('calibration:update', { anchor: { index, summary: value } }),
    onDelete: () => invoke('calibration:removeAnchor', { index }),
  })));

  $('#calibrationModal').classList.remove('hidden');
}
$('#calClose').addEventListener('click', () => $('#calibrationModal').classList.add('hidden'));
$('#setCalibration').addEventListener('click', () => {
  $('#settingsModal').classList.add('hidden');
  openCalibration();
});

/* ---------- log viewer ----------
   The tail, in the app, refreshing while open — for the "what just happened"
   check that doesn't deserve a trip to a text editor. */
let logTimer = null;
async function openLogViewer() {
  $('#logPath').textContent = (state.env && state.env.logPath) || '';
  $('#logModal').classList.remove('hidden');
  const el = $('#logText');
  const refresh = async () => {
    if ($('#logModal').classList.contains('hidden')) { clearInterval(logTimer); return; }
    let text;
    try { text = await invoke('log:tail'); } catch { return; }
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    el.textContent = text;
    if (atBottom) el.scrollTop = el.scrollHeight;
  };
  el.textContent = '';
  await refresh();
  el.scrollTop = el.scrollHeight;
  clearInterval(logTimer);
  logTimer = setInterval(refresh, 2000);
}
$('#logClose').addEventListener('click', () => { $('#logModal').classList.add('hidden'); clearInterval(logTimer); });
$('#logOpen').addEventListener('click', () => invoke('open:log').catch(failed));

/* ---------- entry page picker ---------- */
async function openEntry(site) {
  let result;
  try { result = await invoke('project:pages', { id: site.projectId }); } catch (err) { failed(err); return; }
  $('#entryName').textContent = '— ' + site.name;
  const list = $('#entryList');
  list.innerHTML = '';
  if (!result.pages.length) {
    list.innerHTML = '<div class="history-empty">No HTML pages found in this folder.</div>';
  }
  for (const page of result.pages) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'entry-row' + (page === result.entryFile ? ' current' : '');
    row.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-home"/></svg>'
      + '<span></span><svg class="icon tick-icon" aria-hidden="true"><use href="#i-check"/></svg>';
    row.querySelector('span').textContent = page;
    row.addEventListener('click', async () => {
      try {
        await invoke('project:setEntry', { id: site.projectId, entryFile: page });
        $('#entryModal').classList.add('hidden');
        toast(`"${site.name}" now opens on ${page}`, { kind: 'ok' });
        await refreshLibrary();
      } catch (err) {
        failed(err);
      }
    });
    list.appendChild(row);
  }
  $('#entryModal').classList.remove('hidden');
}
$('#entryClose').addEventListener('click', () => $('#entryModal').classList.add('hidden'));

/* ---------- runtime: how a project gets served ----------
   A folder of HTML is served straight off disk, everything else needs a
   process. This panel is where that choice lives: what SiteSlurp detected,
   what it will actually run, and — while the site is hosted — what that
   process is saying. */
const rt = { site: null, list: [], timer: null, capturing: false };
const rtKey = runtime => `${runtime.kind}:${runtime.id}`;

function rtSelected() {
  return rt.list.find(c => rtKey(c) === $('#rtPick').value) || rt.list[0] || null;
}

/** Show the fields the chosen runtime actually uses. */
function rtRenderChoice(runtime, { command, appPort } = {}) {
  const isCommand = runtime && runtime.kind === 'command';
  $('#rtCommandRow').classList.toggle('hidden', !isCommand);
  $('#rtPortRow').classList.toggle('hidden', !isCommand);
  if (isCommand) {
    $('#rtCommand').value = command !== undefined ? command : (runtime.command || '');
    $('#rtAppPort').value = appPort || runtime.appPort || '';
  }
  const install = isCommand && runtime.install;
  $('#rtInstallRow').classList.toggle('hidden', !install);
  if (install) {
    $('#rtInstallText').textContent = rt.needsInstall
      ? `Dependencies aren't installed yet — run "${runtime.install}".`
      : `Dependencies look installed. Run "${runtime.install}" again if they're stale.`;
  }
  $('#rtDetected').textContent = runtime && runtime.note
    ? runtime.note
    : rt.detected
      ? `Detected: ${rt.detected.label}.`
      : 'Nothing recognisable in this folder — set a command that starts it.';
}

function rtRenderState(runtimeState) {
  const box = $('#rtStatus');
  const logEl = $('#rtLog');
  if (!runtimeState || runtimeState.kind !== 'command') {
    box.classList.add('hidden');
    $('#rtRestart').classList.add('hidden');
    if (!rt.capturing) logEl.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.className = 'rt-status ' + runtimeState.status;
  box.textContent = runtimeState.message || runtimeState.status;
  $('#rtRestart').classList.toggle('hidden', false);
  if (runtimeState.log) {
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
    logEl.classList.remove('hidden');
    logEl.textContent = runtimeState.log;
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
}

function rtPoll() {
  clearInterval(rt.timer);
  rt.timer = setInterval(async () => {
    if (!rt.site || $('#runtimeModal').classList.contains('hidden')) { clearInterval(rt.timer); return; }
    const runtimeState = await invoke('runtime:state', { dir: rt.site.dir }).catch(() => null);
    rtRenderState(runtimeState);
  }, 1200);
}

async function openRuntime(site) {
  const info = await invoke('project:runtimes', { id: site.projectId });
  rt.site = site;
  rt.detected = info.detected;
  rt.needsInstall = info.needsInstall;

  // Everything we could run, with whatever is set now first — a hand-edited
  // command must not disappear because detection has other ideas.
  rt.list = info.candidates.slice();
  if (!rt.list.some(c => rtKey(c) === rtKey(info.current))) rt.list.unshift({ ...info.current });

  const pick = $('#rtPick');
  pick.innerHTML = '';
  for (const candidate of rt.list) {
    const option = document.createElement('option');
    option.value = rtKey(candidate);
    option.textContent = candidate.label
      + (info.detected && rtKey(info.detected) === rtKey(candidate) ? ' — detected' : '');
    pick.appendChild(option);
  }
  pick.value = rtKey(info.current);
  $('#rtName').textContent = info.name;
  rtRenderChoice(info.current, { command: info.current.command, appPort: info.current.appPort });
  $('#rtLog').textContent = '';
  rtRenderState(info.state);
  $('#runtimeModal').classList.remove('hidden');
  rtPoll();
}

$('#rtPick').addEventListener('change', () => {
  const chosen = rtSelected();
  // Switching runtime means taking that runtime's command, not keeping the
  // previous one — except for "custom", which is whatever the user types.
  rtRenderChoice(chosen, chosen && chosen.id === 'custom' ? { command: $('#rtCommand').value } : {});
});

$('#rtInstall').addEventListener('click', async () => {
  const button = $('#rtInstall');
  button.disabled = true;
  rt.capturing = true;
  $('#rtLog').textContent = '';
  $('#rtLog').classList.remove('hidden');
  try {
    await invoke('project:install', { id: rt.site.projectId });
    rt.needsInstall = false;
    toast('Dependencies installed', { kind: 'ok' });
    rtRenderChoice(rtSelected(), { command: $('#rtCommand').value, appPort: $('#rtAppPort').value });
    await refreshLibrary();
  } catch (err) {
    failed(err);
  } finally {
    rt.capturing = false;
    button.disabled = false;
  }
});

$('#rtRestart').addEventListener('click', async () => {
  try {
    await invoke('runtime:restart', { dir: rt.site.dir });
    toast('Restarting the server…', { kind: 'ok', timeout: 3000 });
  } catch (err) { failed(err); }
});

$('#rtSave').addEventListener('click', async () => {
  const chosen = rtSelected();
  if (!chosen) return;
  const runtime = { ...chosen };
  if (runtime.kind === 'command') {
    runtime.command = $('#rtCommand').value.trim();
    const appPort = parseInt($('#rtAppPort').value, 10);
    if (appPort > 0) runtime.appPort = appPort; else delete runtime.appPort;
    if (!runtime.command) { failed(new Error('Enter the command that starts this site.')); return; }
  }
  try {
    await invoke('project:setRuntime', { id: rt.site.projectId, runtime });
    $('#runtimeModal').classList.add('hidden');
    clearInterval(rt.timer);
    toast(`"${rt.site.name}" will be served as ${runtime.label}`, { kind: 'ok' });
    await refreshLibrary();
  } catch (err) {
    failed(err);
  }
});

$('#rtCancel').addEventListener('click', () => {
  $('#runtimeModal').classList.add('hidden');
  clearInterval(rt.timer);
});

window.snap.on('review:exported', ({ project, folder }) => {
  toast(`Review of ${project} exported`, {
    kind: 'ok', timeout: 12000,
    action: { label: 'Open folder', fn: () => invoke('open:folder', { dir: folder }) },
  });
});

window.snap.on('review:promote', ({ candidates }) => {
  for (const candidate of candidates) {
    toast(`You've said this in ${candidate.count} reviews: “${candidate.text.slice(0, 90)}”`, {
      timeout: 20000,
      action: {
        label: 'Make it standing',
        fn: () => invoke('calibration:promote', { text: candidate.text })
          .then(() => toast('Added to standing preferences — ships with every export', { kind: 'ok' }))
          .catch(failed),
      },
    });
  }
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

/* Recolor history: engine snapshots (source 'palette') plus any legacy
   .siteslurp/undo entries old sites still carry, labelled and reverted
   through their own old code path. */
function renderUndo(entries) {
  const panel = $('#palUndo');
  const list = $('#palUndoList');
  list.innerHTML = '';
  panel.classList.toggle('hidden', !entries || !entries.length);
  for (const entry of (entries || []).slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'undo-row';
    // Engine entries carry the colors in their label ("Before recolor #a → #b");
    // legacy entries carry them as fields.
    const hexes = entry.legacy
      ? [entry.from, entry.to]
      : (String(entry.label || '').match(/#[0-9a-fA-F]{3,8}/g) || []);
    const chips = document.createElement('span');
    chips.className = 'undo-chips';
    chips.innerHTML = `<i style="background:${cssColor(hexes[0])}"></i>&rarr;<i style="background:${cssColor(hexes[1])}"></i>`;
    const label = document.createElement('span');
    label.className = 'undo-label';
    label.textContent = entry.legacy
      ? `${entry.replaced} in ${entry.files.length} file${entry.files.length === 1 ? '' : 's'} · legacy`
      : new Date(entry.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    row.appendChild(chips);
    row.appendChild(label);
    row.appendChild(iconBtn('undo', entry.legacy
      ? 'Revert this change (legacy history)'
      : 'Revert this change (restores the snapshot taken before it)', async () => {
      const site = state.library.sites.find(s => s.dir === state.paletteDir);
      let restored;
      if (entry.legacy) {
        ({ restored } = await invoke('palette:undo', { dir: state.paletteDir, id: entry.id }));
      } else {
        if (!site || !site.projectId) throw new Error('This site is not in the library any more.');
        ({ restored } = await invoke('version:restore', { id: site.projectId, versionId: entry.id }));
      }
      toast(`Reverted ${restored} file${restored === 1 ? '' : 's'}`, { kind: 'ok' });
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

/* ---------- command palette ----------
   The app has no menu bar. Everything File/Edit/View/Sites/Help used to hold
   lives here instead, plus a row per site in the library, searchable from
   Ctrl+K. Rebuilt on open so hosted state is never stale. */
const cmdState = { items: [], sel: 0 };

function winAction(action) {
  return () => invoke('win:action', { action }).catch(failed);
}

function allCommands() {
  const list = [
    { group: 'extractor', icon: 'globe', label: 'New capture', keys: 'Ctrl N',
      fn: () => { setTab('extractor'); $('#url').focus(); $('#url').select(); } },
    { group: 'extractor', icon: 'more', label: 'Capture options',
      fn: () => {
        setTab('extractor');
        if ($('#options').classList.contains('hidden')) $('#btnOptions').click();
        $('#options').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } },
    { group: 'view', icon: 'unpack', label: 'Go to Extractor', keys: 'Ctrl 1', fn: () => setTab('extractor') },
    { group: 'view', icon: 'map', label: 'Go to Studio', keys: 'Ctrl 2', fn: () => setTab('studio') },
    { group: 'library', icon: 'refresh', label: 'Refresh library', keys: 'F5', fn: refreshLibrary },
    { group: 'library', icon: 'search', label: 'Filter the library', keys: '/',
      fn: () => { setTab('studio'); $('#libSearch').focus(); } },
    { group: 'library', icon: 'folder', label: 'Open captures folder', fn: winAction('capturesFolder') },
  ];

  for (const site of state.library.sites) {
    if (site.missing) continue;
    if (site.port) {
      list.push({ group: 'sites', icon: 'open', label: `Open ${site.name} — localhost:${site.port}`,
        fn: () => invoke('open:url', { url: `http://localhost:${site.port}/` }).catch(failed) });
      list.push({ group: 'sites', icon: 'stop', label: `Stop ${site.name}`, fn: () => stopSite(site.dir) });
      if (site.projectId) {
        list.push({ group: 'sites', icon: 'layers', label: `Snapshot ${site.name}`,
          fn: () => openSnapshotPrompt(site) });
      }
    } else if (site.kind !== 'raw') {
      list.push({ group: 'sites', icon: 'globe', label: `Host ${site.name}`, fn: () => hostSite(site.dir, site) });
    }
  }
  if (state.library.sites.some(s => s.port)) {
    list.push({ group: 'sites', icon: 'power', label: 'Stop all local servers',
      fn: async () => { await invoke('host:stopAll').catch(failed); await refreshLibrary(); } });
  }

  list.push(
    { group: 'app', icon: 'gear', label: 'Settings', keys: 'Ctrl ,', fn: openSettings },
    { group: 'app', icon: 'check', label: 'Setup & diagnostics', fn: () => refreshEnv().then(() => openDoctor()) },
    { group: 'app', icon: 'star', label: 'Calibration — taste memory', fn: openCalibration },
    { group: 'app', icon: 'note', label: 'View log', fn: openLogViewer },
    { group: 'app', icon: 'note', label: 'Open log file', fn: () => invoke('open:log').catch(failed) },
    { group: 'app', icon: 'info', label: 'About SiteSlurp Studio', fn: openAbout },
    { group: 'view', icon: 'zoom-in', label: 'Zoom in', keys: 'Ctrl +', fn: winAction('zoomIn') },
    { group: 'view', icon: 'zoom-out', label: 'Zoom out', keys: 'Ctrl −', fn: winAction('zoomOut') },
    { group: 'view', icon: 'search', label: 'Reset zoom', keys: 'Ctrl 0', fn: winAction('zoomReset') },
    { group: 'view', icon: 'expand', label: 'Toggle full screen', keys: 'F11', fn: winAction('fullscreen') },
    { group: 'app', icon: 'code', label: 'Developer tools', keys: 'Ctrl Shift I', fn: winAction('devtools') },
  );
  return list;
}

function renderCommands(query) {
  const needle = query.trim().toLowerCase();
  cmdState.items = allCommands().filter(cmd =>
    !needle || `${cmd.label} ${cmd.group}`.toLowerCase().includes(needle));
  cmdState.sel = 0;

  const list = $('#cmdList');
  list.innerHTML = '';
  if (!cmdState.items.length) {
    list.innerHTML = '<div class="cmd-empty">No command matches that.</div>';
    return;
  }
  cmdState.items.forEach((cmd, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmd-item' + (index === 0 ? ' sel' : '');
    row.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${cmd.icon}"/></svg>`
      + '<span class="cmd-label"></span>'
      + (cmd.keys ? '<kbd></kbd>' : '<span class="cmd-group"></span>');
    row.querySelector('.cmd-label').textContent = cmd.label;
    if (cmd.keys) row.querySelector('kbd').textContent = cmd.keys;
    else row.querySelector('.cmd-group').textContent = cmd.group;
    row.addEventListener('click', () => runCommand(index));
    row.addEventListener('mousemove', () => selectCommand(index));
    list.appendChild(row);
  });
}

function selectCommand(index) {
  const rows = $('#cmdList').querySelectorAll('.cmd-item');
  if (!rows.length) return;
  cmdState.sel = (index + rows.length) % rows.length;
  rows.forEach((row, i) => row.classList.toggle('sel', i === cmdState.sel));
  rows[cmdState.sel].scrollIntoView({ block: 'nearest' });
}

async function runCommand(index) {
  const cmd = cmdState.items[index];
  if (!cmd) return;
  closeCommands();
  try { await cmd.fn(); } catch (err) { failed(err); }
}

function openCommands() {
  $('#cmdModal').classList.remove('hidden');
  $('#cmdInput').value = '';
  renderCommands('');
  $('#cmdInput').focus();
}

function closeCommands() {
  $('#cmdModal').classList.add('hidden');
}

$('#btnPalette').addEventListener('click', openCommands);
$('#cmdInput').addEventListener('input', e => renderCommands(e.target.value));
$('#cmdInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); selectCommand(cmdState.sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selectCommand(cmdState.sel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); runCommand(cmdState.sel); }
});

/* ---------- events + keyboard ---------- */
window.snap.on('ui:palette', openCommands);
window.snap.on('ui:refresh', refreshLibrary);
window.snap.on('ui:settings', openSettings);
window.snap.on('ui:focus-url', () => { setTab('extractor'); $('#url').focus(); $('#url').select(); });
window.snap.on('env:changed', () => refreshEnv());

// The updater downloaded a new version in the background. Installing is the
// user's call — this toast is the only nudge, and it stays until acted on.
window.snap.on('update:ready', ({ version }) => {
  toast(`SiteSlurp ${version} is downloaded and ready`, {
    kind: 'ok', timeout: 0,
    action: { label: 'Restart to update', fn: () => invoke('update:install').catch(failed) },
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMenu();
    for (const sel of ['#cmdModal', '#settingsModal', '#doctorModal', '#aboutModal', '#paletteDrawer',
      '#historyModal', '#calibrationModal', '#logModal', '#entryModal', '#snapModal']) {
      $(sel).classList.add('hidden');
    }
    clearInterval(logTimer);
  }
  // Ctrl+K also arrives from the main process, but binding it here keeps the
  // palette working if focus is somewhere that swallows the accelerator.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommands();
    return;
  }
  if (e.key === 'Enter' && !$('#settingsModal').classList.contains('hidden')) $('#setSave').click();
  if ((e.ctrlKey || e.metaKey) && (e.key === '1' || e.key === '2')) {
    e.preventDefault();
    setTab(e.key === '1' ? 'extractor' : 'studio');
  }
  if (e.key === '/' && document.activeElement === document.body) {
    e.preventDefault();
    setTab('studio');
    $('#libSearch').focus();
  }
});

// Click the backdrop to dismiss a modal.
for (const id of ['cmdModal', 'settingsModal', 'doctorModal', 'aboutModal', 'historyModal', 'runtimeModal',
  'calibrationModal', 'logModal', 'entryModal', 'snapModal']) {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) e.target.classList.add('hidden');
  });
}

/* ---------- window controls fallback ----------
   The window is frameless and expects Windows to paint minimise/maximise/close
   into the slot the bar reserves. If that overlay never turns up, draw our own
   — an app you cannot close is a worse outcome than a slightly busier bar. */
function ensureWindowControls() {
  const wco = navigator.windowControlsOverlay;
  if (wco && wco.visible) return;
  if (document.querySelector('.win-controls')) return;

  const group = document.createElement('div');
  group.className = 'win-controls';
  const buttons = [
    ['minimize', '', 'Minimize'],
    ['maximize', '', 'Maximize'],
    ['close', '', 'Close'],
  ];
  for (const [action, glyph, label] of buttons) {
    const button = document.createElement('button');
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => invoke('win:action', { action }).catch(failed));
    group.appendChild(button);
  }
  $('.topbar').appendChild(group);
  // Nothing is reserved on the right any more, so take that padding back.
  $('.topbar').style.paddingRight = '0';
}

/* ---------- init ---------- */
(async () => {
  try {
    ensureWindowControls();
    const [{ settings }] = await Promise.all([invoke('settings:get'), refreshEnv()]);
    state.settings = settings;
    applyRememberedOptions(settings);
    $('#libSort').value = settings.sort;
    $('#libShowRaw').checked = settings.showRaw;
    setTab(settings.tab, { persist: false });
    await refreshLibrary();
    if (!settings.seenWelcome) {
      openDoctor(true);
      invoke('settings:set', { seenWelcome: true }).catch(() => {});
    }
    if (state.tab === 'extractor') $('#url').focus();
  } catch (err) {
    failed(err);
  }
})();
