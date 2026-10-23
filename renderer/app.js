/* Local Dev Studio renderer */
const $ = sel => document.querySelector(sel);
const invoke = (channel, data) => window.snap.invoke(channel, data);

const state = {
  library: { root: '', sites: [], sections: [], missing: false },
  libraryLoaded: false,
  env: null,
  settings: null,
  busy: false,
  tab: 'extractor',
  paletteDir: null,
  paletteFrom: null,
  filter: '',
  section: 'all',         // the library section the Studio tab is showing
  collapsed: new Set(),   // sections folded shut in the "all" view
  dropTipDismissed: false,
  runStarted: 0,
  runTimer: null,
  zipToast: null,
};

/* ---------- tabs ----------
   Extractor owns capturing and the run log; Studio owns hosting and the
   library. Anything that starts a run pulls the user back to Extractor so the
   log is never running behind a hidden tab. ShowCase owns presenting. */
const TABS = ['extractor', 'studio', 'showcase'];

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
  updateDropTip();
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
        : 'Local Dev Studio drives a real browser so React and other JS-heavy sites render before they are saved. Install Microsoft Edge or Google Chrome, then reopen this dialog.',
    });
  } else {
    list.push({ ok: true, title: `Browser: ${env.browser.name}`, detail: env.browser.path });
  }
  list.push(env.singleFile.ok
    ? { ok: true, title: `Capture engine ready${env.singleFile.bundled ? ' (bundled)' : ''}`, detail: env.singleFile.path }
    : { ok: false, title: 'Capture engine missing', detail: 'Reinstall Local Dev Studio, or point Settings → Advanced at a single-file-cli install.' });
  list.push(env.capturesRoot.ok
    ? { ok: true, title: 'Captures folder writable', detail: env.capturesRoot.path }
    : { ok: false, title: 'Captures folder is not writable', detail: `${env.capturesRoot.path} — pick another folder in Settings.` });
  return list;
}

function openDoctor(firstRun = false) {
  const list = problems();
  $('#doctorTitle').textContent = firstRun ? 'Welcome to Local Dev Studio' : 'Setup & diagnostics';
  $('#doctorIntro').textContent = firstRun
    ? 'Paste any URL and Local Dev Studio saves the whole site, unpacks it into editable files, and hosts it on localhost. Here is what it found on this machine:'
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

  // Agent access: paste-ready MCP configs built from how this very binary is
  // launched. The exe path differs per machine, so they're composed here.
  if (env.agent) {
    const quoted = /\s/.test(env.agent.exe) ? `"${env.agent.exe}"` : env.agent.exe;
    $('#agentClaude').value = `claude mcp add local-dev-studio -- ${quoted} ${env.agent.args.join(' ')}`;
    $('#agentCursor').value = JSON.stringify({
      mcpServers: { 'local-dev-studio': { command: env.agent.exe, args: env.agent.args } },
    });
  }
  $('#settingsModal').classList.remove('hidden');
}

/** The palette's "Agent access" lands on Settings with that section open. */
async function openAgentAccess() {
  await openSettings();
  const block = $('#agentAccess');
  block.open = true;
  block.scrollIntoView({ block: 'nearest' });
}

for (const [btn, input] of [['#agentClaudeCopy', '#agentClaude'], ['#agentCursorCopy', '#agentCursor']]) {
  $(btn).addEventListener('click', async () => {
    await navigator.clipboard.writeText($(input).value);
    toast('Copied — paste it in a terminal or your MCP config', { kind: 'ok', timeout: 3000 });
  });
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
  $('#keepScripts').checked = settings.keepScripts;
  $('#stripBanners').checked = settings.stripBanners;
  $('#showBrowser').checked = !settings.headless;
  $('#waitDelay').value = String(settings.waitDelay || 0);
  $('#scrollPage').checked = !!settings.scrollPage;
  $('#useProfile').checked = !!settings.useProfile;
  $('#cookiesFile').value = settings.cookiesFile || '';
  $('#captureHeaders').value = settings.captureHeaders || '';
  $('#includeGlobs').value = settings.includeGlobs || '';
  $('#excludeGlobs').value = settings.excludeGlobs || '';
  $('#maxPages').value = String(settings.maxPages || 100);
  syncOptions();
}

/* The options panel is collapsed by default, so this one line has to say
   everything the old row of checkboxes said — in words, not ticks. */
function syncOptions() {
  const crawl = $('#crawl').checked;
  const bits = [crawl ? `whole site, depth ${$('#depth').value}` : 'single page'];
  bits.push($('#mobile').checked ? 'mobile' : 'desktop');
  if ($('#useProfile').checked) bits.push('signed in');
  if ($('#cookiesFile').value.trim()) bits.push('cookies file');
  if ($('#captureHeaders').value.trim()) bits.push('extra headers');
  if ($('#scrollPage').checked) bits.push('scrolled first');
  if ($('#fixVideos').checked) bits.push('videos restored');
  if ($('#keepScripts').checked) bits.push('scripts kept');
  if ($('#stripBanners').checked) bits.push('banners stripped');
  if ($('#showBrowser').checked) bits.push('browser visible');
  const wait = parseInt($('#waitDelay').value, 10) || 0;
  if (wait) bits.push(`${wait / 1000}s wait`);
  if (crawl) {
    if ($('#includeGlobs').value.trim() || $('#excludeGlobs').value.trim()) bits.push('scoped');
    const cap = parseInt($('#maxPages').value, 10) || 100;
    bits.push(`max ${cap} pages`);
  }
  const name = $('#siteName').value.trim();
  if (name) bits.push(`saved as "${name}"`);
  $('#optsSummary').textContent = bits.join('  ·  ');

  // Depth is meaningless on a single-page capture — show it that way.
  $('#depthRow').classList.toggle('off', !crawl);
  $('#depth').disabled = !crawl;
  // Scope applies to crawls and sitemap captures — dim it only for plain
  // single-page grabs, where there is nothing to scope.
  $('#scopeRow').classList.toggle('off', !crawl);
}

/** Everything the Options panel says, in the shape capture:start expects. */
function captureOptionsPayload() {
  return {
    crawl: $('#crawl').checked,
    depth: parseInt($('#depth').value, 10),
    mobile: $('#mobile').checked,
    fixVideos: $('#fixVideos').checked,
    keepScripts: $('#keepScripts').checked,
    stripBanners: $('#stripBanners').checked,
    headless: !$('#showBrowser').checked,
    waitDelay: parseInt($('#waitDelay').value, 10) || 0,
    scrollPage: $('#scrollPage').checked,
    useProfile: $('#useProfile').checked,
    cookiesFile: $('#cookiesFile').value.trim(),
    captureHeaders: $('#captureHeaders').value,
    includeGlobs: $('#includeGlobs').value.trim(),
    excludeGlobs: $('#excludeGlobs').value.trim(),
    maxPages: parseInt($('#maxPages').value, 10) || 100,
  };
}

$('#options').addEventListener('change', syncOptions);
// Text fields (globs, headers, cookies path) update the summary as you type,
// not just on blur.
$('#options').addEventListener('input', syncOptions);
$('#siteName').addEventListener('input', syncOptions);

$('#btnOptions').addEventListener('click', () => {
  const panel = $('#options');
  const open = panel.classList.toggle('hidden') === false;
  $('#btnOptions').setAttribute('aria-expanded', String(open));
});

async function startCaptures(urlText) {
  startRunPanel('Starting…');
  try {
    const { queued } = await invoke('capture:start', {
      url: urlText,
      name: $('#siteName').value.trim() || undefined,
      ...captureOptionsPayload(),
    });
    if (queued > 1) toast(`Queued ${queued} captures — they run one at a time`, { kind: 'ok', timeout: 5000 });
    return true;
  } catch (err) {
    stopRunPanel('fail', err.message);
    failed(err);
    return false;
  }
}

$('#captureForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#url').value.trim();
  if (!url) return;
  await startCaptures(url);
});

/* A multi-line paste into the URL box is a list of captures — hand it to the
   batch panel instead of letting the input flatten it into garbage. */
$('#url').addEventListener('paste', e => {
  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    e.preventDefault();
    openBatch(text);
  }
});

/* ---------- batch capture ---------- */
function openBatch(prefill = '') {
  $('#batchUrls').value = prefill || '';
  $('#batchModal').classList.remove('hidden');
  $('#batchUrls').focus();
}
$('#batchCancel').addEventListener('click', () => $('#batchModal').classList.add('hidden'));
$('#batchStart').addEventListener('click', async () => {
  const text = $('#batchUrls').value.trim();
  if (!text) return;
  $('#batchModal').classList.add('hidden');
  await startCaptures(text);
});

/* ---------- capture sessions: log in + cookies file ---------- */
$('#btnLogin').addEventListener('click', async () => {
  const button = $('#btnLogin');
  button.disabled = true;
  toast('Sign in to the site in the browser window, then close that window when you\'re done', {
    kind: 'ok', timeout: 10000,
  });
  try {
    await invoke('capture:login', { url: $('#url').value.trim() || undefined });
    $('#useProfile').checked = true;
    syncOptions();
    toast('Login saved — captures with "signed in" on will use it', { kind: 'ok', timeout: 7000 });
  } catch (err) {
    failed(err);
  } finally {
    button.disabled = false;
  }
});

$('#btnCookies').addEventListener('click', async () => {
  const file = await invoke('settings:browseCookies').catch(() => null);
  if (!file) return;
  $('#cookiesFile').value = file;
  syncOptions();
});

/* ---------- capture queue ---------- */
window.snap.on('run:queue', ({ items }) => {
  // How many captures are still waiting — so run:done knows a batch isn't over
  // and keeps the panel cancellable for the next item.
  state.queueLength = items.length;
  const box = $('#runQueue');
  const list = $('#queueList');
  list.innerHTML = '';
  box.classList.toggle('hidden', !items.length);
  if (!items.length) return;
  $('#runPanel').classList.remove('hidden');
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const pos = document.createElement('span');
    pos.className = 'queue-pos';
    pos.textContent = String(index + 1);
    const label = document.createElement('span');
    label.className = 'queue-url';
    label.textContent = item.url;
    label.title = item.url;
    row.appendChild(pos);
    row.appendChild(label);
    row.appendChild(iconBtn('stop', 'Remove this one from the queue', () =>
      invoke('capture:dequeue', { qid: item.qid })));
    list.appendChild(row);
  });
});
$('#queueClear').addEventListener('click', async () => {
  await invoke('capture:dequeue', { qid: 'all' }).catch(failed);
  toast('Queue cleared — the capture already running finishes on its own', { timeout: 4000 });
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

window.snap.on('run:done', async ({ ok, dir, stats, error, canceled, seconds, install, audit, recapture }) => {
  // An install has no capture stats to summarise — it either worked or it said why.
  if (install) {
    stopRunPanel(ok ? 'done' : 'fail', ok ? 'Dependencies installed.' : 'Install failed: ' + error);
    await refreshLibrary();
    return;
  }
  // Audits never open the run panel; whoever started one toasts its summary.
  if (audit) {
    await refreshLibrary();
    return;
  }
  if (recapture) {
    if (ok) {
      stopRunPanel('done', `Done — re-captured ${stats.pages} page${stats.pages === 1 ? '' : 's'}${seconds ? ` in ${seconds}s` : ''}`);
      toast('Re-captured — the previous version is in history', {
        kind: 'ok', timeout: 12000,
        action: { label: 'History', fn: () => {
          const site = state.library.sites.find(s => s.dir === dir);
          if (site) openHistory(site, 'versions');
        } },
      });
    } else {
      stopRunPanel(canceled ? '' : 'fail', canceled ? 'Canceled.' : 'Failed: ' + error);
      if (!canceled) failed(new Error(error));
    }
    await refreshLibrary();
    return;
  }
  // A batch isn't finished until the queue drains. While items remain, keep the
  // panel live and cancellable for the next one instead of stopping it (which
  // used to hide Cancel and freeze the timer after the very first item).
  const more = state.queueLength > 0;
  if (ok) {
    const summary = `${stats.pages} page${stats.pages === 1 ? '' : 's'}, ${stats.images} images, `
      + `${stats.fonts} fonts, ${stats.css} css${seconds ? ` — ${seconds}s` : ''}`;
    if (more) {
      $('#runStatus').textContent = `Done — ${summary}. Next in queue…`;
      $('#btnCancel').disabled = false;
    } else {
      stopRunPanel('done', `Done — ${summary}`);
    }
    toast('Site captured & extracted', {
      kind: 'ok', timeout: 12000,
      action: { label: 'Host now', fn: () => hostSite(dir) },
    });
  } else if (more) {
    $('#runStatus').textContent = canceled ? 'Canceled — moving to the next…' : `Failed: ${error} — moving on`;
    $('#btnCancel').disabled = false;
    if (!canceled) failed(new Error(error));
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
    const attaching = site && site.runtime && site.runtime.id === 'attach';
    const booting = !attaching && site && site.runtime && site.runtime.kind === 'command';
    toast(attaching
      ? `Connected — fronting your server on localhost:${port}`
      : booting
        ? `Starting ${site.runtime.label} on localhost:${port} — the page turns into the site when it's up`
        : `Hosting on localhost:${port} — the Local Dev Studio button on the page holds the asset dragger & audit mode`,
    { kind: 'ok', timeout: booting ? 9000 : undefined, action: { label: 'Open', fn: () => invoke('open:url', { url }) } });
    await refreshLibrary();
  } catch (err) {
    // "Set one in Runtime settings" as a dead-end toast is a scavenger hunt —
    // take them there.
    if (site && site.projectId && /Runtime settings/.test(err.message || '')) {
      toast(err.message, { kind: 'err', timeout: 9000, action: { label: 'Runtime settings', fn: () => openRuntime(site) } });
      return;
    }
    failed(err);
  }
}

async function stopSite(dir) {
  await invoke('host:stop', { dir }).catch(failed);
  await refreshLibrary();
}

/* ---------- public sharing ---------- */
// The share modal: two ways to be online. A tunnel from this machine (free,
// as shipped — live, guests can annotate, dies with the app) or the 24/7
// link — the files pushed to a real host, up with this PC off, until taken
// down. Plus the Pro options: guest review and a version pin.
const shareState = { site: null, hasToken: false };

const shareMode = () => ($('#shareModeCloud').checked ? 'cloud' : 'tunnel');

/** "12 min ago" for the 24/7 block — how far behind the files the link is. */
function sinceText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

async function openShare(site, prefer = null) {
  shareState.site = site;
  $('#shareName').textContent = '— ' + site.name;
  $('#shareToken').value = '';

  // Which modes this site can use: the tunnel needs the site hosted, the
  // 24/7 link needs a static project in the library. A mode this site can't
  // use stays visible with its reason, so the fix is obvious.
  const command = site.runtime && site.runtime.kind === 'command';
  const sharing = !!(site.share && site.share.status === 'up');
  const cloudUp = !!(site.deploy && site.deploy.url);
  const tunnelWhy = site.port ? '' : 'Host the site first — the tunnel puts the hosted address online.';
  const cloudWhy = !site.projectId ? 'Needs a project in the library — this folder is only hosted.'
    : site.attachOnly ? 'A folderless attach project has no files to put online.'
      : command ? 'Needs static files — a dev-server project shares its build output, not its source. Add the build folder to the library and share that.'
        : '';
  $('#shareModeTunnel').disabled = !!tunnelWhy;
  $('#shareModeCloud').disabled = !!cloudWhy;
  $('#shareTunnelWhy').textContent = tunnelWhy;
  $('#shareTunnelWhy').classList.toggle('hidden', !tunnelWhy);
  $('#shareCloudWhy').textContent = cloudWhy;
  $('#shareCloudWhy').classList.toggle('hidden', !cloudWhy);
  // Open on what was asked for, else on what's already up, else on the first
  // mode this site can use.
  let mode = prefer || (cloudUp && !sharing ? 'cloud' : 'tunnel');
  if (mode === 'cloud' && cloudWhy) mode = 'tunnel';
  if (mode === 'tunnel' && tunnelWhy && !cloudWhy) mode = 'cloud';
  $(mode === 'cloud' ? '#shareModeCloud' : '#shareModeTunnel').checked = true;
  // Annotation follows what is already on; a fresh 24/7 link starts with it
  // on, because auditing whenever they have a chance is what the link is for.
  $('#shareGuest').checked = mode === 'cloud'
    ? (site.deploy ? !!site.deploy.audit : true)
    : !!(site.share && site.share.guest);

  try {
    const { has } = await invoke('deploy:token', { provider: 'netlify' });
    shareState.hasToken = !!has;
  } catch { shareState.hasToken = false; }
  $('#shareTokenState').textContent = shareState.hasToken ? '(saved — paste to replace)' : '';

  // A version pin only makes sense for a static project with snapshots.
  const row = $('#shareVersionRow');
  const pick = $('#shareVersion');
  pick.innerHTML = '';
  const live = document.createElement('option');
  live.value = '';
  pick.appendChild(live);
  let hasVersions = false;
  if (site.projectId && !command && !site.attachOnly) {
    try {
      const { snapshots } = await invoke('version:list', { id: site.projectId });
      for (const snap of snapshots) {
        const option = document.createElement('option');
        option.value = snap.id;
        option.textContent = `${snap.label || snap.source} · ${snap.id}`;
        pick.appendChild(option);
        hasVersions = true;
      }
    } catch { /* no snapshots is fine */ }
  }
  row.classList.toggle('hidden', command || !hasVersions);
  const pinned = mode === 'cloud' ? (site.deploy && site.deploy.version) : (site.share && site.share.version);
  if (pinned) pick.value = pinned;

  $('#shareCurrent').classList.toggle('hidden', !sharing);
  $('#shareStopBtn').classList.toggle('hidden', !sharing);
  if (sharing) $('#shareLinkText').value = site.share.shareUrl || site.share.url;
  $('#shareCloudCurrent').classList.toggle('hidden', !cloudUp);
  $('#shareCloudStopBtn').classList.toggle('hidden', !cloudUp);
  if (cloudUp) {
    $('#shareCloudLinkText').value = site.deploy.url;
    const since = site.deploy.at ? sinceText(site.deploy.at) : '';
    $('#shareCloudLabel').textContent = 'Up 24/7' + (since ? ` — files pushed ${since}` : '')
      + (site.deploy.version ? ` from snapshot ${site.deploy.version}` : '')
      + (site.deploy.audit ? ' · reviewers can annotate' : ' · view only') + ':';
  }
  syncShareMode();
  $('#shareModal').classList.remove('hidden');
}

/** The window follows the chosen mode: guest review belongs to the tunnel,
 *  the token to the 24/7 link, and the button says what will happen. */
function syncShareMode() {
  const site = shareState.site;
  const cloud = shareMode() === 'cloud';
  $('#shareCloudOpts').classList.toggle('hidden', !cloud);
  $('#shareGuestHint').textContent = cloud
    ? 'Reviewers open the link whenever they have a chance and leave notes on the page, signed with their name. Their notes stay in their browser until they press Send audit, which downloads a file — read it in with Import audit… in Project history.'
    : 'Guests leave notes on the page, signed with their name. Exports, resolving and your files stay locked to this machine.';
  $('#shareVersionHint').textContent = cloud
    ? 'Put a snapshot online instead of the files as they are now — byte-for-byte, so the link is reproducible.'
    : 'Pin the link to a snapshot and reviewers see that exact state while you keep editing live. Pinned guests can annotate until a newer snapshot exists.';
  const first = $('#shareVersion').options[0];
  if (first) first.textContent = cloud ? 'The files as they are right now' : 'Live — changes as you edit';
  const sharing = !!(site && site.share && site.share.status === 'up');
  const cloudUp = !!(site && site.deploy && site.deploy.url);
  $('#shareGo').textContent = cloud ? (cloudUp ? 'Push an update' : 'Put it up 24/7') : (sharing ? 'Update link' : 'Share');
  $('#shareGo').disabled = cloud ? $('#shareModeCloud').disabled : $('#shareModeTunnel').disabled;
}
$('#shareModeTunnel').addEventListener('change', syncShareMode);
$('#shareModeCloud').addEventListener('change', syncShareMode);

$('#shareCancel').addEventListener('click', () => $('#shareModal').classList.add('hidden'));
$('#shareCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#shareLinkText').value);
  toast('Share link copied', { kind: 'ok', timeout: 2500 });
});
$('#shareCloudCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#shareCloudLinkText').value);
  toast('24/7 link copied', { kind: 'ok', timeout: 2500 });
});
$('#shareCloudOpen').addEventListener('click', () =>
  invoke('open:url', { url: $('#shareCloudLinkText').value }).catch(failed));
$('#shareStopBtn').addEventListener('click', async () => {
  const site = shareState.site;
  $('#shareModal').classList.add('hidden');
  if (site) await unshareSite(site);
});
// Taking the 24/7 link down deletes the site at the host — for everyone, for
// good — so it asks once. Sharing 24/7 again makes a new address.
$('#shareCloudStopBtn').addEventListener('click', async () => {
  const site = shareState.site;
  if (!site || !site.deploy) return;
  const yes = await invoke('shell:confirm', {
    title: 'Take the 24/7 link down',
    message: `Take ${site.deploy.url.replace(/^https?:\/\//, '')} offline?`,
    detail: 'The address stops answering and the site leaves your Netlify account. Sharing 24/7 again makes a new address.',
    confirmLabel: 'Take it down',
  }).catch(() => false);
  if (!yes) return;
  $('#shareModal').classList.add('hidden');
  try {
    await invoke('share:stop', { dir: site.dir, mode: 'cloud' });
    toast('24/7 link taken down', { kind: 'ok', timeout: 3000 });
  } catch (err) { failed(err); }
  await refreshLibrary();
});
$('#shareGo').addEventListener('click', async () => {
  const site = shareState.site;
  if (!site) return;
  const button = $('#shareGo');
  const cloud = shareMode() === 'cloud';
  const version = $('#shareVersion').value || null;
  const guestReview = $('#shareGuest').checked;
  button.disabled = true;
  if (cloud) {
    // The token saves first, so a mistyped one fails here — not mid-upload.
    try {
      const token = $('#shareToken').value.trim();
      if (token) {
        await invoke('deploy:setToken', { provider: 'netlify', token });
        $('#shareToken').value = '';
        shareState.hasToken = true;
        $('#shareTokenState').textContent = '(saved — paste to replace)';
      }
      if (!shareState.hasToken) throw new Error('Paste a Netlify access token first — a free account at netlify.com takes a minute.');
    } catch (err) {
      button.disabled = false;
      failed(err);
      return;
    }
  }
  $('#shareModal').classList.add('hidden');
  const pending = toast(cloud ? `Putting "${site.name}" online 24/7…` : `Creating a public link for "${site.name}"…`, { timeout: 0 });
  state.shareToast = pending.querySelector('span');
  try {
    const { url } = await invoke('share:start', { dir: site.dir, mode: cloud ? 'cloud' : 'tunnel', guestReview, version });
    pending.remove();
    const host = url.replace('https://', '').split('/?')[0];
    toast(cloud
      ? `${site.name} is up 24/7 at ${host}` + (guestReview ? ' — reviewers can annotate and send you an audit file' : '')
        + (version ? ' · from a snapshot' : '') + ' — it stays online with this PC off, until you take it down'
      : `${site.name} is public at ${host}` + (guestReview ? ' — guests can annotate' : '')
        + (version ? ' · pinned to a snapshot' : '') + ' — the link works until sharing or hosting stops', {
      kind: 'ok', timeout: 15000,
      action: { label: 'Copy link', fn: () => navigator.clipboard.writeText(url) },
    });
  } catch (err) {
    pending.remove();
    failed(err);
  } finally {
    state.shareToast = null;
    button.disabled = false;
  }
  await refreshLibrary();
});

async function unshareSite(site) {
  await invoke('share:stop', { dir: site.dir }).catch(failed);
  toast('Public link taken down', { kind: 'ok', timeout: 3000 });
  await refreshLibrary();
}

// Publish progress ("Uploading the site…") lands in the pending share toast.
window.snap.on('deploy:progress', ({ msg }) => {
  if (state.shareToast) state.shareToast.textContent = msg;
});

/* ---------- local https ---------- */
// The https toggle: an extra, secure address for this project at
// <name>.slurp.localhost. The certificate is minted locally; trusting the
// local CA is a one-time step the toast offers right away.
async function toggleHttps(site) {
  try {
    const result = await invoke('project:setHttps', { id: site.projectId, https: !site.https });
    if (result.https) {
      toast(result.httpsUrl
        ? `HTTPS on — ${result.httpsUrl.replace('https://', '')}`
        : 'HTTPS on — host the site to open the secure address', {
        kind: 'ok', timeout: 12000,
        action: { label: 'Trust certificate', fn: trustHttpsCa },
      });
    } else {
      toast('HTTPS off for this project', { kind: 'ok', timeout: 3000 });
    }
    await refreshLibrary();
  } catch (err) {
    failed(err);
  }
}

async function trustHttpsCa() {
  try {
    const { trusted } = await invoke('https:trust');
    toast(trusted
      ? 'The local certificate is trusted — the https address now shows a clean padlock'
      : 'Could not add it automatically — the certificate file was revealed; import "ca.crt" into your system\'s trusted roots', {
      kind: trusted ? 'ok' : '', timeout: 9000,
    });
  } catch (err) {
    failed(err);
  }
}

$('#btnStopAll').addEventListener('click', async () => {
  await invoke('host:stopAll').catch(failed);
  await refreshLibrary();
});

/* ---------- attach to a dev server ----------
   The developer's own `npm run dev` keeps its terminal; Local Dev Studio fronts the
   port it answers on. Loopback only — the main process refuses anything else. */
function openAttach() {
  $('#attachTarget').value = '';
  $('#attachFolder').value = '';
  $('#attachName').value = '';
  $('#attachModal').classList.remove('hidden');
  $('#attachTarget').focus();
}
$('#attachCancel').addEventListener('click', () => $('#attachModal').classList.add('hidden'));
$('#attachBrowse').addEventListener('click', async () => {
  const dir = await invoke('project:browseFolder').catch(() => null);
  if (dir) $('#attachFolder').value = dir;
});
$('#attachTarget').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#attachSave').click(); }
});
$('#attachSave').addEventListener('click', async () => {
  const button = $('#attachSave');
  button.disabled = true;
  try {
    const project = await invoke('project:addAttach', {
      target: $('#attachTarget').value,
      folder: $('#attachFolder').value.trim() || null,
      name: $('#attachName').value.trim(),
    });
    $('#attachModal').classList.add('hidden');
    const { port, url } = await invoke('host:start', { dir: project.path });
    toast(`Connected — fronting your server on localhost:${port}`, {
      kind: 'ok', timeout: 9000,
      action: { label: 'Open', fn: () => invoke('open:url', { url }) },
    });
    setTab('studio');
    await refreshLibrary();
  } catch (err) {
    failed(err);
  } finally {
    button.disabled = false;
  }
});

/* ---------- studio browser ---------- */
async function openStudioBrowser(site) {
  await invoke('studio:open', { id: site.projectId });
  await refreshLibrary();
}

/* ---------- re-capture as a version ---------- */
async function recaptureSite(site) {
  const yes = await invoke('shell:confirm', {
    title: 'Re-capture',
    message: `Capture "${site.name}" again from ${site.sourceUrl}?`,
    detail: 'The same capture options run again. The site as it is right now is snapshotted first, '
      + 'so the old version stays restorable and diffable from Project history.',
    confirmLabel: 'Re-capture',
  });
  if (!yes) return;
  startRunPanel('Re-capturing…');
  try {
    await invoke('capture:recapture', { id: site.projectId });
  } catch (err) {
    stopRunPanel('fail', err.message);
    failed(err);
  }
}

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
// A background ui:refresh (a thumbnail finishing, a snapshot restoring) must not
// yank an open ⋯ menu closed under the user's cursor. renderLibrary defers while
// a menu is open; closing it flushes whatever refresh was held back.
let pendingRender = false;
function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  if (pendingRender) { pendingRender = false; renderLibrary(); }
}
document.addEventListener('click', e => {
  if (openMenu && !openMenu.contains(e.target) && e.target.closest('.menu-btn') !== openMenu.anchor) closeMenu();
});

/* An item with `submenu` swaps the popover's rows for the ones it returns, with
   a Back row on top — "Move to section…" lists every section that way instead
   of growing the card's menu by one row per section. */
function fillMenu(pop, items, back = null) {
  pop.innerHTML = '';
  const rows = back ? [{ icon: 'arrow-left', label: 'Back', stay: true, fn: back }, ...items] : items;
  for (const item of rows) {
    const row = document.createElement('button');
    row.innerHTML = `<svg class="icon"><use href="#i-${item.icon}"/></svg><span></span>`;
    row.querySelector('span').textContent = item.label;
    if (item.current) row.classList.add('current');
    if (item.submenu) row.classList.add('has-sub');
    row.addEventListener('click', async e => {
      // The row is about to leave the DOM; letting the click reach the document
      // would read as "clicked outside the menu" and close it.
      if (item.submenu || item.stay) {
        e.stopPropagation();
        if (item.submenu) fillMenu(pop, item.submenu(), () => fillMenu(pop, items, back));
        else item.fn();
        return;
      }
      closeMenu();
      try { await item.fn(); } catch (err) { failed(err); }
    });
    pop.appendChild(row);
  }
}

function menuButton(items, title = 'More actions') {
  const b = document.createElement('button');
  b.className = 'icon-btn menu-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = '<svg><use href="#i-more"/></svg>';
  b.addEventListener('click', () => {
    if (openMenu && openMenu.anchor === b) { closeMenu(); return; }
    closeMenu();
    const pop = document.createElement('div');
    pop.className = 'menu-pop';
    pop.anchor = b;
    fillMenu(pop, typeof items === 'function' ? items() : items);
    b.closest('.card-actions, .group-actions').appendChild(pop);
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
  // Anything in the registry can be dragged onto another section.
  if (site.projectId) makeDraggable(card, site);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (site.thumb) {
    const img = document.createElement('img');
    img.src = site.thumb;
    img.loading = 'lazy';
    img.alt = '';
    // A dragged <img> carries its file along, which the window's drop handler
    // would try to add as a project. The card is what gets dragged.
    img.draggable = false;
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
  const always = site.deploy && site.deploy.url ? site.deploy : null;
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
  // Up on a real host: this chip stays whether or not the site is hosted or
  // the app is even open — that's the point of it.
  if (always) {
    const up = document.createElement('span');
    up.className = 'badge public always' + (shared ? ' second' : '');
    up.textContent = '24/7';
    up.title = always.url + ' — up around the clock, with this PC off too. Click to open.';
    up.addEventListener('click', e => {
      e.stopPropagation();
      invoke('open:url', { url: always.url }).catch(failed);
    });
    thumb.appendChild(up);
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
  const attach = command && command.id === 'attach' ? command : null;
  meta.textContent = site.missing
    ? 'folder not found on disk'
    : attach
      ? `attached → :${attach.appPort}${site.attachOnly ? '' : ' · ' + fileSize(site.sizeBytes)}`
      : command
        ? `${command.label}${site.needsInstall ? ' · needs install' : ''} · ${fileSize(site.sizeBytes)}`
        : `${site.pages} page${site.pages === 1 ? '' : 's'} · ${fileSize(site.sizeBytes)} · `
          + new Date(site.mtime).toLocaleDateString();
  if (attach) meta.title = `Fronting the dev server you run yourself on port ${attach.appPort}`;
  else if (command) meta.title = command.command || '';
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
  if (site.projectId) {
    more.push({ icon: 'move', label: 'Move to section…', submenu: () => sectionMenuFor(site) });
  }
  // For a folder that isn't just HTML, "how does this get served" is the first
  // thing anyone needs — it comes before the file-manager actions.
  if (site.kind === 'local' && site.projectId) {
    more.push({ icon: 'gear', label: 'How to serve this…', fn: () => openRuntime(site) });
    if (site.port && site.runtime && site.runtime.kind === 'command') {
      more.push({ icon: 'refresh', label: attach ? 'Reconnect' : 'Restart server', fn: async () => {
        await invoke('runtime:restart', { dir: site.dir });
        toast(attach ? 'Reconnecting…' : 'Restarting…', { kind: 'ok', timeout: 3000 });
        await refreshLibrary();
      } });
    }
  }
  // Studio Browser already has its own icon button in the card's action row —
  // no ⋯ duplicate.
  if (shared) {
    more.push({ icon: 'share', label: 'Copy public link', fn: async () => {
      await navigator.clipboard.writeText(shared.shareUrl || shared.url);
      toast('Public link copied', { kind: 'ok', timeout: 2500 });
    } });
  }
  // An extra, secure address for this project — needed for APIs that demand a
  // secure context and for realistic cookie testing.
  if (site.projectId && !site.missing && !site.attachOnly) {
    more.push({ icon: 'globe', label: site.https ? 'Serve over HTTPS: on' : 'Serve over HTTPS: off',
      fn: () => toggleHttps(site) });
    if (site.https && site.httpsUrl) {
      more.push({ icon: 'open', label: 'Open the HTTPS address', fn: () =>
        invoke('open:url', { url: site.httpsUrl }).catch(failed) });
    }
  }
  // The 24/7 link: the files on a real host, up with this PC off. Static file
  // sets only — a dev-server project shares its build output, not its source.
  if (site.projectId && !site.missing && !site.attachOnly && !command) {
    more.push({ icon: 'share', label: site.deploy ? 'Push an update to the 24/7 link…' : 'Share 24/7 — up with this PC off…',
      fn: () => openShare(site, 'cloud') });
  }
  if (site.deploy && site.deploy.url) {
    more.push({ icon: 'share', label: 'Copy 24/7 link', fn: async () => {
      await navigator.clipboard.writeText(site.deploy.url);
      toast('24/7 link copied', { kind: 'ok', timeout: 2500 });
    } });
  }
  if (site.port && site.hasSitemap) {
    more.push({ icon: 'map', label: 'Open sitemap', fn: () =>
      invoke('open:url', { url: `http://localhost:${site.port}/_index.html` }) });
  }
  // A folderless attach project has only a placeholder dir — nothing there to open.
  if (!site.attachOnly) {
    more.push({ icon: 'folder', label: 'Open folder', fn: () => invoke('open:folder', { dir: site.dir }) });
    more.push({ icon: 'code', label: 'Open in VS Code', fn: () => invoke('open:editor', { dir: site.dir }) });
  }
  // Fresh content from the web, previous state kept as a snapshot — only a
  // capture that remembers where it came from can offer this.
  if (site.kind === 'extracted' && site.sourceUrl && site.projectId && !site.missing) {
    more.push({ icon: 'refresh', label: 'Re-capture from the web…', fn: () => recaptureSite(site) });
  }
  if (site.kind === 'extracted') {
    more.push({ icon: 'film', label: 'Restore stripped videos', fn: async () => {
      const fixed = await invoke('video:fix', { dir: site.dir });
      toast(fixed ? `Restored ${fixed} video(s)` : 'No stripped videos found', { kind: fixed ? 'ok' : '' });
    } });
  }
  if (!site.missing && !site.attachOnly && (site.kind === 'extracted' || site.kind === 'local')) {
    more.push({ icon: 'camera', label: 'Refresh preview', fn: async () => {
      await invoke('thumb:make', { dir: site.dir });
      await refreshLibrary();
    } });
  }
  // Which page "/" opens on — a static-serving question; a dev server routes itself.
  if (site.projectId && !site.missing && !command) {
    more.push({ icon: 'home', label: 'Set entry page…', fn: () => openEntry(site) });
  }
  if (site.projectId && !site.missing) {
    more.push({ icon: 'present', label: 'Present in ShowCase', fn: () => presentSite(site) });
  }
  if (site.projectId) {
    // Audit mode's home is the Local Dev Studio menu on the hosted page itself; these
    // stay as the app-side mirror of that toggle.
    if (site.reviewActive) {
      more.push({ icon: 'stop', label: 'End audit mode', fn: async () => {
        await invoke('review:stop', { dir: site.dir });
        toast('Audit mode off — the overlay is gone on next reload', { kind: 'ok', timeout: 4000 });
        await refreshLibrary();
      } });
    } else if (!site.missing) {
      more.push({ icon: 'note', label: 'Start audit mode', fn: async () => {
        await invoke('review:start', { dir: site.dir });
        toast('Audit mode on — annotate in the browser, then Export from the toolbar', { kind: 'ok', timeout: 7000 });
        await refreshLibrary();
      } });
    }
    // A restorable copy of the files as they are right now. A folderless
    // attach project has no files to snapshot.
    if (!site.missing && !site.attachOnly) {
      more.push({ icon: 'layers', label: 'Snapshot now…', fn: () => openSnapshotPrompt(site) });
    }
    more.push({ icon: 'history', label: 'Project history', fn: () => openHistory(site) });
    // Automated pass: axe accessibility scan + internal broken-link crawl.
    // Findings arrive as [auto] pins in Review Mode, ready for the export.
    if (!site.missing && !site.attachOnly) {
      more.push({ icon: 'check', label: 'Run audits (accessibility + links)', fn: () => runSiteAudits(site) });
    }
    // A dev server does its own hot reload — Local Dev Studio's file watcher would only
    // fight it, so the toggle is a static-hosting option.
    if (!command) {
      more.push({ icon: 'refresh', label: site.liveReload ? 'Live reload: on' : 'Live reload: off', fn: async () => {
        await invoke('project:setLiveReload', { id: site.projectId, liveReload: !site.liveReload });
        await refreshLibrary();
      } });
    }
    // Snapshot on its own after edits go quiet, while the site is hosted.
    if (!site.missing && !site.attachOnly) {
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
    const up247 = !!(site.deploy && site.deploy.url);
    const shareBtn = iconBtn('share', shared || up247
      ? 'Sharing is on — open the link options or stop sharing'
      : 'Share publicly — a tunnel while this PC is on, or a 24/7 link that stays up with it off', () =>
      openShare(site));
    if (shared || up247) shareBtn.classList.add('sharing');
    actions.appendChild(shareBtn);
  } else if (!site.missing) {
    actions.appendChild(textButton('globe', 'Host', () => hostSite(site.dir, site)));
    // A 24/7 link needs no hosting: a card that is up around the clock keeps
    // its share button so the link and the take-down stay one click away.
    if (site.deploy && site.deploy.url) {
      const shareBtn = iconBtn('share', 'Up 24/7 — open the link options or take it down', () => openShare(site));
      shareBtn.classList.add('sharing');
      actions.appendChild(shareBtn);
    }
  }
  if (site.projectId && !site.missing) {
    actions.appendChild(iconBtn('monitor', 'Open in Studio Browser — annotate with a console, viewports and versions', () =>
      openStudioBrowser(site)));
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

function visibleSites({ search = true } = {}) {
  const showRaw = $('#libShowRaw').checked;
  const needle = search ? state.filter.toLowerCase() : '';
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

/* ---------- library sections ----------
   The user's own shelves (client sites, concepts, their own business). A site
   on none of them falls into one of two built-in groups that can't be renamed
   or deleted: Captures (other people's sites, pulled in by the Extractor) and
   Unsorted (folders dropped in and not shelved yet). */
const GROUP_CAPTURES = '_captures';
const GROUP_UNSORTED = '_unsorted';
const BUILT_IN = {
  [GROUP_CAPTURES]: { name: 'Captures', hint: 'Sites pulled in from the web' },
  [GROUP_UNSORTED]: { name: 'Unsorted', hint: 'Folders not in a section yet' },
};

const userSections = () => state.library.sections || [];
const sectionNamed = id => (userSections().find(s => s.id === id) || BUILT_IN[id] || {}).name || '';

function groupOf(site) {
  if (site.section && userSections().some(s => s.id === site.section)) return site.section;
  return site.kind === 'local' ? GROUP_UNSORTED : GROUP_CAPTURES;
}

/** Every group in display order: the user's sections, then the built-ins. */
function libraryGroups() {
  return [
    ...userSections().map(s => ({ id: s.id, name: s.name, user: true })),
    ...Object.entries(BUILT_IN).map(([id, g]) => ({ id, ...g, user: false })),
  ];
}

function setSection(id) {
  state.section = id;
  invoke('settings:set', { libSection: id }).catch(() => {});
  renderLibrary();
}

function toggleGroup(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  invoke('settings:set', { collapsedSections: [...state.collapsed] }).catch(() => {});
  renderLibrary();
}

/** Put a site on a section (null = back to Captures/Unsorted), with an undo. */
async function moveToSection(site, sectionId, { undoable = true } = {}) {
  const from = groupOf(site);
  const to = sectionId || (site.kind === 'local' ? GROUP_UNSORTED : GROUP_CAPTURES);
  if (from === to) return;
  await invoke('project:setSection', { id: site.projectId, section: sectionId });
  const back = BUILT_IN[from] ? null : from;
  toast(`Moved "${site.name}" to ${sectionNamed(to)}`, {
    kind: 'ok',
    timeout: 4000,
    action: undoable
      ? { label: 'Undo', fn: () => moveToSection({ ...site, section: sectionId }, back, { undoable: false }).catch(failed) }
      : null,
  });
  await refreshLibrary();
}

/** The rows behind a card's "Move to section…". */
function sectionMenuFor(site) {
  const here = groupOf(site);
  const rows = userSections().map(sec => ({
    icon: here === sec.id ? 'check' : 'folder',
    label: sec.name,
    current: here === sec.id,
    fn: () => moveToSection(site, sec.id),
  }));
  // Off its shelf, a site goes back to the built-in group for its kind.
  if (!BUILT_IN[here]) {
    const home = site.kind === 'local' ? GROUP_UNSORTED : GROUP_CAPTURES;
    rows.push({ icon: 'undo', label: `Take out — back to ${BUILT_IN[home].name}`, fn: () => moveToSection(site, null) });
  }
  rows.push({ icon: 'plus', label: 'New section…', fn: () => openSectionModal(null, sec => moveToSection(site, sec.id)) });
  return rows;
}

/* Drag a card onto a section chip or a section's block to move it. `dragged`
   is the site in flight; while it is set, background refreshes wait (the card
   being dragged must not be replaced mid-drag) — same rule as an open ⋯ menu. */
let dragged = null;

// A capture dropped on Unsorted, or a folder on Captures, would land in the
// other built-in group — not where the user aimed, so neither takes it.
function accepts(groupId, site) {
  if (!site || !site.projectId || groupOf(site) === groupId) return false;
  if (groupId === GROUP_CAPTURES) return site.kind !== 'local';
  if (groupId === GROUP_UNSORTED) return site.kind === 'local';
  return true;
}

function makeDraggable(card, site) {
  card.draggable = true;
  card.addEventListener('dragstart', e => {
    closeMenu();
    dragged = site;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', site.name);
    card.classList.add('dragging');
    document.body.classList.add('sorting');
  });
  card.addEventListener('dragend', () => {
    dragged = null;
    card.classList.remove('dragging');
    document.body.classList.remove('sorting');
    for (const el of document.querySelectorAll('.drop-over')) el.classList.remove('drop-over');
    if (pendingRender) { pendingRender = false; renderLibrary(); }
  });
}

function dropTarget(el, groupId) {
  el.addEventListener('dragover', e => {
    if (!accepts(groupId, dragged)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', e => {
    if (!accepts(groupId, dragged)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-over');
    const site = dragged;
    moveToSection(site, BUILT_IN[groupId] ? null : groupId).catch(failed);
  });
}

function renderSectionBar(groups, counts, present, total) {
  const bar = $('#libSections');
  bar.innerHTML = '';
  bar.classList.toggle('hidden', !state.library.sites.length);
  const chip = (id, name, count, target) => {
    const b = document.createElement('button');
    const on = state.section === id;
    b.className = 'sec-chip' + (on ? ' on' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.innerHTML = '<span class="sec-name"></span><span class="sec-count"></span>';
    b.querySelector('.sec-name').textContent = name;
    b.querySelector('.sec-count').textContent = count;
    b.addEventListener('click', () => setSection(id));
    if (target) dropTarget(b, id);
    bar.appendChild(b);
  };
  chip('all', 'All', total, false);
  for (const group of groups) {
    // A built-in group gets a chip only while something belongs to it.
    if (!group.user && !present.has(group.id) && state.section !== group.id) continue;
    chip(group.id, group.name, counts.get(group.id).length, true);
  }
  const add = document.createElement('button');
  add.className = 'sec-add';
  add.title = 'Add a section to sort the library into';
  add.innerHTML = '<svg class="icon"><use href="#i-plus"/></svg><span>New section</span>';
  add.addEventListener('click', () => openSectionModal());
  bar.appendChild(add);
}

function renderGroup(group, sites, inAll) {
  const block = document.createElement('section');
  block.className = 'lib-group';
  block.dataset.group = group.id;
  const folded = inAll && state.collapsed.has(group.id);
  block.classList.toggle('folded', folded);
  dropTarget(block, group.id);

  const head = document.createElement('div');
  head.className = 'group-head';
  const title = document.createElement(inAll ? 'button' : 'div');
  title.className = 'group-title';
  title.innerHTML = (inAll ? '<svg class="icon chevron"><use href="#i-chevron"/></svg>' : '')
    + '<span class="group-name"></span><span class="lib-count"></span>';
  title.querySelector('.group-name').textContent = group.name;
  title.querySelector('.lib-count').textContent = sites.length;
  if (inAll) {
    title.setAttribute('aria-expanded', String(!folded));
    title.title = folded ? 'Show this section' : 'Fold this section away';
    title.addEventListener('click', () => toggleGroup(group.id));
  }
  head.appendChild(title);
  if (group.hint) {
    const hint = document.createElement('span');
    hint.className = 'group-hint';
    hint.textContent = group.hint;
    head.appendChild(hint);
  }
  const rule = document.createElement('span');
  rule.className = 'group-rule';
  head.appendChild(rule);
  if (group.user) {
    const actions = document.createElement('div');
    actions.className = 'group-actions';
    actions.appendChild(menuButton(() => sectionActions(group), 'Section actions'));
    head.appendChild(actions);
  }
  block.appendChild(head);

  if (sites.length) {
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const site of sites) grid.appendChild(renderCard(site));
    block.appendChild(grid);
  } else {
    const drop = document.createElement('div');
    drop.className = 'group-drop';
    drop.textContent = 'Empty — drag sites here, or use ⋯ → Move to section on any card.';
    block.appendChild(drop);
  }
  return block;
}

/** The ⋯ on a section's header: rename, reorder, delete. */
function sectionActions(group) {
  const list = userSections();
  const idx = list.findIndex(s => s.id === group.id);
  const move = offset => async () => {
    await invoke('section:move', { id: group.id, offset });
    await refreshLibrary();
  };
  const rows = [{ icon: 'edit', label: 'Rename…', fn: () => openSectionModal(list[idx]) }];
  if (idx > 0) rows.push({ icon: 'arrow-left', label: 'Move earlier', fn: move(-1) });
  if (idx < list.length - 1) rows.push({ icon: 'arrow-right', label: 'Move later', fn: move(1) });
  rows.push({ icon: 'trash', label: 'Delete section…', fn: () => deleteSection(list[idx]) });
  return rows;
}

async function deleteSection(section) {
  const inIt = state.library.sites.filter(s => s.section === section.id).length;
  const yes = await invoke('shell:confirm', {
    title: 'Delete section',
    message: `Delete the "${section.name}" section?`,
    detail: inIt
      ? `The ${inIt} site${inIt === 1 ? '' : 's'} in it go back to Unsorted or Captures. Nothing on disk is touched.`
      : 'It is empty. Nothing on disk is touched.',
    confirmLabel: 'Delete',
  });
  if (!yes) return;
  await invoke('section:remove', { id: section.id });
  state.collapsed.delete(section.id);
  if (state.section === section.id) setSection('all');
  toast(`Deleted "${section.name}"`, { kind: 'ok', timeout: 3000 });
  await refreshLibrary();
}

/* The section-name dialog: new (optionally followed by `then`, e.g. moving the
   card that asked for it) or rename. */
const sectionModal = { editing: null, then: null };

function openSectionModal(section = null, then = null) {
  sectionModal.editing = section;
  sectionModal.then = then;
  $('#sectionTitle').textContent = section ? 'Rename section' : 'New section';
  $('#sectionSave').textContent = section ? 'Rename' : 'Create section';
  $('#sectionName').value = section ? section.name : '';
  $('#sectionModal').classList.remove('hidden');
  $('#sectionName').focus();
  $('#sectionName').select();
}

$('#sectionCancel').addEventListener('click', () => $('#sectionModal').classList.add('hidden'));
$('#sectionName').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#sectionSave').click(); }
});
$('#sectionSave').addEventListener('click', async () => {
  const button = $('#sectionSave');
  const { editing, then } = sectionModal;
  const name = $('#sectionName').value.trim();
  button.disabled = true;
  try {
    const saved = editing
      ? await invoke('section:rename', { id: editing.id, name })
      : await invoke('section:create', { name });
    $('#sectionModal').classList.add('hidden');
    if (then) {
      await refreshLibrary();
      await then(saved);
    } else {
      if (!editing) toast(`Added "${saved.name}" — drag cards onto it to sort them`, { kind: 'ok', timeout: 4000 });
      await refreshLibrary();
    }
  } catch (err) {
    failed(err);
  } finally {
    button.disabled = false;
  }
});

/* Until the first folder is dropped in, a popup says that's how. Dismissing
   it holds for this session; a dropped folder retires it for good. */
function updateDropTip() {
  const dropped = state.library.sites.some(s => s.kind === 'local' && !s.attachOnly);
  const show = state.libraryLoaded && !dropped && !state.dropTipDismissed && state.tab !== 'showcase';
  $('#dropTip').classList.toggle('hidden', !show);
}
$('#dropTipClose').addEventListener('click', () => {
  state.dropTipDismissed = true;
  updateDropTip();
});

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
  // Don't re-render out from under an open menu or a card mid-drag — hold it
  // until the menu closes or the drag ends.
  if (openMenu || dragged) { pendingRender = true; return; }
  const sites = visibleSites();
  const groups = libraryGroups();
  if (state.section !== 'all' && !groups.some(g => g.id === state.section)) state.section = 'all';
  const counts = new Map(groups.map(g => [g.id, []]));
  for (const site of sites) counts.get(groupOf(site)).push(site);
  // Which built-in groups hold anything at all, search aside — so their chips
  // don't blink in and out while the user types in the filter.
  const present = new Set(visibleSites({ search: false }).map(groupOf));
  renderSectionBar(groups, counts, present, sites.length);

  const inAll = state.section === 'all';
  const searching = !!state.filter;
  const wrap = $('#libGroups');
  wrap.innerHTML = '';
  let shownSites = 0;
  if (state.library.sites.length) {
    for (const group of inAll ? groups : groups.filter(g => g.id === state.section)) {
      const list = counts.get(group.id);
      // Built-in groups only show while something is in them. An empty section
      // of the user's own stays up as a place to drop cards — unless a search
      // is narrowing things, when an empty shelf is only noise.
      if (!list.length && (!group.user || searching)) continue;
      wrap.appendChild(renderGroup(group, list, inAll));
      shownSites += list.length;
    }
  }

  const empty = $('#empty');
  const nothing = !wrap.children.length;
  empty.classList.toggle('hidden', !nothing);
  if (nothing) {
    empty.innerHTML = '';
    const line = document.createElement('p');
    line.textContent = !state.library.sites.length
      ? 'Nothing here yet — capture a site in the Extractor tab, or drop a folder to add your own.'
      : inAll
        ? 'Nothing matches that filter.'
        : searching
          ? `Nothing in ${sectionNamed(state.section)} matches that filter.`
          : `Nothing in ${sectionNamed(state.section)} yet.`;
    empty.appendChild(line);
    if (!state.library.sites.length) {
      const attach = document.createElement('button');
      attach.className = 'small';
      attach.style.marginTop = '10px';
      attach.textContent = 'Attach to a dev server…';
      attach.title = 'Already running npm run dev? Front it with Review Mode without restarting anything.';
      attach.addEventListener('click', openAttach);
      empty.appendChild(attach);
    }
  }
  $('#libCount').textContent = shownSites || '';
  updateDropTip();
  renderShowcasePicker();

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
    state.libraryLoaded = true;
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
    list.innerHTML = '<div class="history-empty">No audits yet — host the site and flip on Audit mode from the Local Dev Studio menu on the page.</div>';
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
// The offline half of guest review: read a guest's downloaded audit file into
// the open review. Duplicates (notes that already arrived live) are skipped.
$('#histImport').addEventListener('click', async () => {
  const site = hist.site;
  if (!site || !site.projectId) return;
  try {
    const result = await invoke('review:import', { id: site.projectId });
    if (!result) return; // picker cancelled
    toast(result.imported
      ? `Audit imported — ${result.imported} note${result.imported === 1 ? '' : 's'}`
        + (result.skipped ? `, ${result.skipped} already here or unreadable` : '')
      : 'Nothing new in that file — every note was already here.', { kind: 'ok', timeout: 6000 });
    await renderReviewHistory(site);
  } catch (err) { failed(err); }
});
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

// Always diff and label older → newer, whichever of the two the user picked as
// the comparison target. Otherwise choosing an older snapshot inverts Before/
// After and makes the adds/removes read backwards. 'working' is always "now".
function diffOrder() {
  const a = hist.diff.a;
  const b = $('#diffAgainst').value;
  if (b === 'working') return { older: a, newer: b };
  const timeOf = id => {
    const s = hist.snapshots.find(x => x.id === id);
    return s ? Date.parse(s.timestamp) || 0 : 0;
  };
  return timeOf(b) < timeOf(a) ? { older: b, newer: a } : { older: a, newer: b };
}

async function renderDiffFiles() {
  if (!hist.diff) return;
  const { site } = hist.diff;
  const { older: a, newer: b } = diffOrder();
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
  const { site } = hist.diff;
  const { older: a, newer: b } = diffOrder();
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
   process. This panel is where that choice lives: what Local Dev Studio detected,
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
  // Attach runs nothing: no command to edit, and the port field is the point.
  const isAttach = isCommand && runtime.id === 'attach';
  $('#rtCommandRow').classList.toggle('hidden', !isCommand || isAttach);
  $('#rtPortRow').classList.toggle('hidden', !isCommand);
  $('#rtPortHint').textContent = isAttach
    ? 'The port your own dev server is listening on. Loopback only.'
    : 'Only when the command binds a port of its own (docker, a hard-coded server).';
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
    // A just-finished install leaves its output here; the project isn't hosted,
    // so state is null on the next poll. Keep anything already printed — only
    // an empty log box is worth hiding.
    if (!rt.capturing && !logEl.textContent.trim()) logEl.classList.add('hidden');
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
    const appPort = parseInt($('#rtAppPort').value, 10);
    if (appPort > 0) runtime.appPort = appPort; else delete runtime.appPort;
    if (runtime.id === 'attach') {
      runtime.command = '';
      if (!runtime.appPort) { failed(new Error('Enter the port your dev server is listening on.')); return; }
    } else {
      runtime.command = $('#rtCommand').value.trim();
      if (!runtime.command) { failed(new Error('Enter the command that starts this site.')); return; }
    }
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

/* ---------- audits ---------- */
// One long toast while it runs (it claims the job slot like a capture), then
// the counts. The findings themselves land as [auto] pins in Review Mode.
async function runSiteAudits(site) {
  const pending = toast(`Auditing ${site.name} — accessibility scan + link crawl…`, { timeout: 0 });
  try {
    const s = await invoke('audit:run', { id: site.projectId });
    const bits = [
      `${s.axeViolations} accessibility finding${s.axeViolations === 1 ? '' : 's'}`,
      `${s.brokenLinks} broken link${s.brokenLinks === 1 ? '' : 's'}`,
    ];
    toast(`Audits done — ${bits.join(', ')} across ${s.pages} page${s.pages === 1 ? '' : 's'}`
      + (s.added ? ` · ${s.added} new pin${s.added === 1 ? '' : 's'} in Review Mode` : ' · nothing new'),
    { kind: 'ok', timeout: 10000 });
  } finally {
    pending.remove();
  }
}

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
    { group: 'extractor', icon: 'map', label: 'Capture a list of URLs or a sitemap…',
      fn: () => { setTab('extractor'); openBatch(); } },
    { group: 'extractor', icon: 'globe', label: 'Log in for capture — save a site login for captures',
      fn: () => { setTab('extractor'); $('#btnLogin').click(); } },
    { group: 'view', icon: 'unpack', label: 'Go to Extractor', keys: 'Ctrl 1', fn: () => setTab('extractor') },
    { group: 'view', icon: 'map', label: 'Go to Studio', keys: 'Ctrl 2', fn: () => setTab('studio') },
    { group: 'view', icon: 'present', label: 'Go to ShowCase', keys: 'Ctrl 3', fn: () => setTab('showcase') },
    { group: 'library', icon: 'refresh', label: 'Refresh library', keys: 'F5', fn: refreshLibrary },
    { group: 'library', icon: 'search', label: 'Filter the library', keys: '/',
      fn: () => { setTab('studio'); $('#libSearch').focus(); } },
    { group: 'library', icon: 'folder', label: 'Open captures folder', fn: winAction('capturesFolder') },
    { group: 'library', icon: 'plus', label: 'New library section…', fn: () => { setTab('studio'); openSectionModal(); } },
    ...libraryGroups().map(g => ({ group: 'library', icon: 'layers', label: `Show ${g.name}`,
      fn: () => { setTab('studio'); setSection(g.id); } })),
    { group: 'studio', icon: 'plug', label: 'Attach to a dev server…', fn: openAttach },
  ];

  for (const site of state.library.sites) {
    if (site.missing) continue;
    if (site.port) {
      list.push({ group: 'sites', icon: 'open', label: `Open ${site.name} — localhost:${site.port}`,
        fn: () => invoke('open:url', { url: `http://localhost:${site.port}/` }).catch(failed) });
      list.push({ group: 'sites', icon: 'stop', label: `Stop ${site.name}`, fn: () => stopSite(site.dir) });
      list.push({ group: 'sites', icon: 'share', label: `Share ${site.name} publicly…`, fn: () => openShare(site) });
      if (site.https && site.httpsUrl) {
        list.push({ group: 'sites', icon: 'open', label: `Open ${site.name} over HTTPS`,
          fn: () => invoke('open:url', { url: site.httpsUrl }).catch(failed) });
      }
      if (site.projectId && !site.attachOnly) {
        list.push({ group: 'sites', icon: 'layers', label: `Snapshot ${site.name}`,
          fn: () => openSnapshotPrompt(site) });
      }
    } else if (site.kind !== 'raw') {
      list.push({ group: 'sites', icon: 'globe', label: `Host ${site.name}`, fn: () => hostSite(site.dir, site) });
    }
    if (site.projectId) {
      list.push({ group: 'sites', icon: 'monitor', label: `Open ${site.name} in Studio Browser`,
        fn: () => openStudioBrowser(site) });
      list.push({ group: 'sites', icon: 'present', label: `Present ${site.name} in ShowCase`,
        fn: () => presentSite(site) });
      if (!site.missing && !site.attachOnly) {
        list.push({ group: 'sites', icon: 'check', label: `Run audits on ${site.name}`,
          fn: () => runSiteAudits(site) });
        list.push({ group: 'sites', icon: 'globe',
          label: `Serve ${site.name} over HTTPS: ${site.https ? 'on' : 'off'}`,
          fn: () => toggleHttps(site) });
        if (!(site.runtime && site.runtime.kind === 'command')) {
          list.push({ group: 'sites', icon: 'share', label: `Share ${site.name} 24/7 — up with this PC off…`,
            fn: () => openShare(site, 'cloud') });
        }
      }
      if (site.kind === 'extracted' && site.sourceUrl && !site.missing) {
        list.push({ group: 'sites', icon: 'refresh', label: `Re-capture ${site.name} from the web`,
          fn: () => recaptureSite(site) });
      }
    }
  }
  if (sc.live.active) {
    list.push({ group: 'showcase', icon: sc.live.playing ? 'pause' : 'play',
      label: sc.live.playing ? 'ShowCase: pause' : 'ShowCase: resume', fn: () => scControl('toggle') });
    list.push({ group: 'showcase', icon: 'stop', label: 'ShowCase: end the show', fn: () => scControl('close') });
  }
  if (state.library.sites.some(s => s.port)) {
    list.push({ group: 'sites', icon: 'power', label: 'Stop all local servers',
      fn: async () => { await invoke('host:stopAll').catch(failed); await refreshLibrary(); } });
  }

  list.push(
    { group: 'app', icon: 'gear', label: 'Settings', keys: 'Ctrl ,', fn: openSettings },
    { group: 'app', icon: 'plug', label: 'Agent access — connect Claude Code or Cursor', fn: openAgentAccess },
    { group: 'app', icon: 'check', label: 'Setup & diagnostics', fn: () => refreshEnv().then(() => openDoctor()) },
    { group: 'app', icon: 'globe', label: 'Trust the local HTTPS certificate — one-time setup for https addresses',
      fn: trustHttpsCa },
    { group: 'app', icon: 'star', label: 'Calibration — taste memory', fn: openCalibration },
    { group: 'app', icon: 'note', label: 'View log', fn: openLogViewer },
    { group: 'app', icon: 'note', label: 'Open log file', fn: () => invoke('open:log').catch(failed) },
    { group: 'app', icon: 'info', label: 'About Local Dev Studio', fn: openAbout },
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
  toast(`Local Dev Studio ${version} is downloaded and ready`, {
    kind: 'ok', timeout: 0,
    action: { label: 'Restart to update', fn: () => invoke('update:install').catch(failed) },
  });
});

// Every dismissable modal, in one place so Escape and backdrop-click can never
// drift apart (they used to — Share/Publish/Runtime were missing from one list
// or the other, leaving them closeable only by their Cancel button).
const MODAL_IDS = ['cmdModal', 'settingsModal', 'doctorModal', 'aboutModal', 'historyModal', 'runtimeModal',
  'calibrationModal', 'logModal', 'entryModal', 'snapModal', 'sectionModal', 'attachModal', 'batchModal',
  'shareModal'];

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMenu();
    $('#paletteDrawer').classList.add('hidden');
    for (const id of MODAL_IDS) $('#' + id).classList.add('hidden');
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
  if ((e.ctrlKey || e.metaKey) && (e.key === '1' || e.key === '2' || e.key === '3')) {
    e.preventDefault();
    setTab(TABS[Number(e.key) - 1]);
  }
  if (e.key === '/' && document.activeElement === document.body) {
    e.preventDefault();
    setTab('studio');
    $('#libSearch').focus();
  }
});

// Click the backdrop to dismiss a modal — same canonical list as Escape.
for (const id of MODAL_IDS) {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) e.target.classList.add('hidden');
  });
}

/* ---------- ShowCase ----------
   The picker mirrors the library (projects only — a raw snapshot has nothing
   to present); the director panel holds the options, remembered in settings;
   the remote is the same column's other face while a show is on. Every
   control on the remote is one of the show's own keys, so the laptop can
   drive a projector without touching it. The storyboard the show built for
   the current page is listed on the remote; any shot is one click away. */
const SC_DEFAULTS = {
  style: 'walkthrough', speed: 90, sections: true, dwell: 2.5, pageDwell: 4, loop: true,
  nav: true, buttons: true, details: true, cards: true, flip: false, pages: true,
  tidy: true, reveal: true, media: true,
  frame: 'none', cursor: 'ghost', zoom: 100, slates: true, tagline: '', progress: true,
  captions: true, siteSeconds: 0, fullscreen: true, display: null,
  record: false, music: '', musicVolume: 60,
};
// What each style switches on when chosen (mirrors STYLE_BEATS in lib/showcase.js).
const SC_STYLE_BEATS = {
  walkthrough: { nav: true, buttons: true, details: true, cards: true, flip: false, pages: true },
  reel: { nav: false, buttons: false, details: true, cards: false, flip: true, pages: false },
  cinematic: { nav: false, buttons: false, details: true, cards: false, flip: false, pages: true },
  scroll: { nav: false, buttons: false, details: false, cards: false, flip: false, pages: false },
  still: { nav: false, buttons: false, details: false, cards: false, flip: false, pages: true },
};
const SC_STYLE_HINT = {
  walkthrough: 'Every section, the navigation, the buttons, then the next page. A client presentation.',
  reel: 'Opening, a few highlights, a flip to the phone, next site. Thirty seconds each — made for socials.',
  cinematic: 'Slow glides and long push-ins, no pointer. Let the design speak.',
  scroll: 'One steady glide down the page, stopping at sections. Nothing else moves.',
  still: 'No motion. Hold each page for a while, then move on.',
};
const SC_SHOT_ICON = {
  establish: '◦', nav: '⋯', button: '◉', glide: '↓', detail: '⊕', cards: '⋮', wander: '✦', flip: '▯', hold: '■',
};
const sc = { picked: [], opts: { ...SC_DEFAULTS }, live: { active: false }, saveTimer: 0, toldRecording: '' };

const scPresentable = () => state.library.sites.filter(s => s.projectId && !s.missing && s.kind !== 'raw');

function segSet(el, value) {
  for (const b of el.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(value));
}
function segBind(el, fn) {
  el.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    segSet(el, b.dataset.v);
    fn(b.dataset.v);
  });
}

function renderShowcasePicker() {
  const sites = scPresentable();
  const ids = new Set(sites.map(s => s.projectId));
  sc.picked = sc.picked.filter(id => ids.has(id));
  const grid = $('#scGrid');
  grid.innerHTML = '';
  for (const site of sites) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sc-tile';
    const at = sc.picked.indexOf(site.projectId);
    if (at >= 0) tile.classList.add('on');
    tile.title = at >= 0 ? 'Click to drop it from the show' : 'Click to present this site';
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
    if (site.port) {
      const badge = document.createElement('span');
      badge.className = 'badge live';
      badge.textContent = 'live';
      thumb.appendChild(badge);
    }
    const order = document.createElement('span');
    order.className = 'sc-tile-order';
    order.textContent = at >= 0 ? String(at + 1) : '';
    thumb.appendChild(order);
    tile.appendChild(thumb);
    const name = document.createElement('span');
    name.className = 'sc-tile-name';
    name.textContent = site.name;
    tile.appendChild(name);
    tile.addEventListener('click', () => {
      const i = sc.picked.indexOf(site.projectId);
      if (i >= 0) sc.picked.splice(i, 1); else sc.picked.push(site.projectId);
      renderShowcasePicker();
    });
    grid.appendChild(tile);
  }
  $('#scEmpty').classList.toggle('hidden', sites.length > 0);
  const n = sc.picked.length;
  $('#scPickCount').textContent = n ? (n === 1 ? '1 site' : `${n} sites · reel`) : '';
  $('#scClear').classList.toggle('hidden', n === 0);
  $('#scReelGroup').classList.toggle('hidden', n < 2);
  const present = $('#scPresent');
  present.disabled = n === 0;
  present.textContent = n > 1 ? `Present reel (${n})` : (sc.opts.record ? 'Present & record' : 'Present');
}
$('#scClear').addEventListener('click', () => { sc.picked = []; renderShowcasePicker(); });

/** "Present in ShowCase" from a card or the palette: this site, on its own. */
function presentSite(site) {
  sc.picked = [site.projectId];
  renderShowcasePicker();
  setTab('showcase');
  $('#scPresent').focus();
}

function scSave() {
  clearTimeout(sc.saveTimer);
  sc.saveTimer = setTimeout(() => invoke('settings:set', { showcase: sc.opts }).catch(() => {}), 400);
}

const scMusicLabel = p => (p ? String(p).split(/[\\/]/).pop() : 'No music');

/** Options → controls. */
function scApply() {
  const o = sc.opts;
  segSet($('#scStyle'), o.style);
  $('#scStyleHint').textContent = SC_STYLE_HINT[o.style] || '';
  $('#scSpeed').value = o.speed;
  $('#scSpeedValue').textContent = `${o.speed} px/s`;
  const still = o.style === 'still';
  $('#scSpeedGroup').classList.toggle('off', still);
  $('#scBeatsGroup').classList.toggle('off', still);
  $('#scSectionsGroup').classList.toggle('off', still);
  for (const key of ['nav', 'buttons', 'details', 'cards', 'flip', 'pages', 'tidy', 'reveal', 'media']) {
    $('#sc' + key[0].toUpperCase() + key.slice(1)).checked = !!o[key];
  }
  $('#scSections').checked = o.sections;
  $('#scDwell').value = String(o.dwell);
  $('#scPageDwell').value = String(o.pageDwell);
  $('#scLoop').checked = o.loop;
  segSet($('#scFrame'), o.frame);
  segSet($('#scCursor'), o.cursor);
  $('#scZoom').value = String(o.zoom);
  $('#scSlates').checked = o.slates;
  $('#scTagline').value = o.tagline;
  $('#scProgress').checked = o.progress;
  $('#scCaptions').checked = o.captions;
  $('#scSiteSeconds').value = String(o.siteSeconds);
  $('#scRecord').checked = o.record;
  $('#scMusicName').textContent = scMusicLabel(o.music);
  $('#scMusicName').title = o.music || '';
  $('#scMusicClear').classList.toggle('hidden', !o.music);
  $('#scMusicVolumeRow').classList.toggle('hidden', !o.music);
  $('#scMusicVolume').value = String(o.musicVolume);
  $('#scFullscreen').checked = o.fullscreen;
  $('#scDisplay').value = o.display === null ? '' : String(o.display);
  if ($('#scDisplay').selectedIndex < 0) $('#scDisplay').value = '';
  renderShowcasePicker();
}

function scBind() {
  const num = (id, key) => $(id).addEventListener('change', e => { sc.opts[key] = Number(e.target.value); scSave(); });
  const bool = (id, key) => $(id).addEventListener('change', e => { sc.opts[key] = e.target.checked; scSave(); });
  segBind($('#scStyle'), v => {
    sc.opts.style = v;
    Object.assign(sc.opts, SC_STYLE_BEATS[v] || {});
    if (v === 'reel' && sc.picked.length > 1 && !sc.opts.siteSeconds) sc.opts.siteSeconds = 30;
    scApply();
    scSave();
  });
  $('#scSpeed').addEventListener('input', e => {
    sc.opts.speed = Number(e.target.value);
    $('#scSpeedValue').textContent = `${sc.opts.speed} px/s`;
    scSave();
    if (sc.live.active) scControl('speed', sc.opts.speed);
  });
  for (const key of ['nav', 'buttons', 'details', 'cards', 'flip', 'pages', 'tidy', 'reveal', 'media']) {
    bool('#sc' + key[0].toUpperCase() + key.slice(1), key);
  }
  bool('#scSections', 'sections');
  num('#scDwell', 'dwell');
  num('#scPageDwell', 'pageDwell');
  bool('#scLoop', 'loop');
  segBind($('#scFrame'), v => { sc.opts.frame = v; scSave(); });
  segBind($('#scCursor'), v => { sc.opts.cursor = v; scSave(); });
  num('#scZoom', 'zoom');
  bool('#scSlates', 'slates');
  $('#scTagline').addEventListener('input', e => { sc.opts.tagline = e.target.value.slice(0, 160); scSave(); });
  bool('#scProgress', 'progress');
  bool('#scCaptions', 'captions');
  num('#scSiteSeconds', 'siteSeconds');
  $('#scRecord').addEventListener('change', e => { sc.opts.record = e.target.checked; renderShowcasePicker(); scSave(); });
  $('#scMusic').addEventListener('click', async () => {
    try {
      const file = await invoke('showcase:pickMusic');
      if (!file) return;
      sc.opts.music = file;
      scApply();
      scSave();
    } catch (err) { failed(err); }
  });
  $('#scMusicClear').addEventListener('click', () => { sc.opts.music = ''; scApply(); scSave(); });
  num('#scMusicVolume', 'musicVolume');
  bool('#scFullscreen', 'fullscreen');
  $('#scDisplay').addEventListener('change', e => {
    sc.opts.display = e.target.value === '' ? null : Number(e.target.value);
    scSave();
  });

  $('#scPresent').addEventListener('click', async () => {
    if (!sc.picked.length) return;
    const b = $('#scPresent');
    b.disabled = true;
    try {
      scRender(await invoke('showcase:start', { ids: sc.picked, options: sc.opts }));
    } catch (err) {
      failed(err);
    } finally {
      b.disabled = sc.picked.length === 0;
    }
  });

  // The remote.
  $('#scPlay').addEventListener('click', () => scControl('toggle'));
  $('#scPrev').addEventListener('click', () => scControl('prev'));
  $('#scNext').addEventListener('click', () => scControl('next'));
  $('#scPrevPage').addEventListener('click', () => scControl('prevPage'));
  $('#scNextPage').addEventListener('click', () => scControl('nextPage'));
  $('#scSlower').addEventListener('click', () => scControl('speed', Math.max(10, (sc.live.speed || 90) - 20)));
  $('#scFaster').addEventListener('click', () => scControl('speed', Math.min(800, (sc.live.speed || 90) + 20)));
  segBind($('#scRemoteFrame'), v => scControl('frame', v));
  segBind($('#scRemoteCursor'), v => scControl('cursor', v));
  $('#scBlack').addEventListener('click', () => scControl('blackout'));
  $('#scFull').addEventListener('click', () => scControl('fullscreen'));
  $('#scRestart').addEventListener('click', () => scControl('restart'));
  $('#scRecordBtn').addEventListener('click', () => scControl('record'));
  $('#scRemoteFocus').addEventListener('click', () => scControl('focus'));
  $('#scEnd').addEventListener('click', () => scControl('close'));
  $('#scBoard').addEventListener('click', e => {
    const b = e.target.closest('button[data-shot]');
    if (b) scControl('shot', Number(b.dataset.shot));
  });
}

async function scControl(action, value) {
  try {
    scRender(await invoke('showcase:control', { action, value }));
  } catch (err) { failed(err); }
}

async function scFillDisplays() {
  const pick = $('#scDisplay');
  pick.innerHTML = '';
  const same = document.createElement('option');
  same.value = '';
  same.textContent = 'Same screen as this window';
  pick.appendChild(same);
  let displays = [];
  try { displays = await invoke('showcase:displays'); } catch { /* single screen, then */ }
  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = `${d.label} · ${d.width}×${d.height}${d.primary ? ' · main' : ''}`;
    pick.appendChild(opt);
  }
  pick.value = sc.opts.display === null ? '' : String(sc.opts.display);
  if (pick.selectedIndex < 0) pick.value = '';
}

/** A finished recording gets one toast, with the way to it. */
function scTellRecording(rec) {
  if (!rec) return;
  if (rec.error) {
    if (sc.toldRecording !== 'err:' + rec.error) { sc.toldRecording = 'err:' + rec.error; toast(`Recording failed: ${rec.error}`, { kind: 'err', timeout: 9000 }); }
    return;
  }
  if (!rec.path || sc.toldRecording === rec.path) return;
  sc.toldRecording = rec.path;
  const name = rec.path.split(/[\\/]/).pop();
  toast(`Recording saved · ${name} (${fileSize(rec.bytes)}, ${rec.seconds}s)`, {
    kind: 'ok', timeout: 12000,
    action: { label: 'Show in folder', fn: () => invoke('showcase:revealRecording', { file: rec.path }).catch(failed) },
  });
}

/** Show state → the remote (or back to the director when it's over). */
function scRender(live) {
  sc.live = live && typeof live === 'object' ? live : { active: false };
  const on = !!sc.live.active;
  $('#scDirector').classList.toggle('hidden', on);
  $('#scRemote').classList.toggle('hidden', !on);
  $('#tab-showcase').classList.toggle('busy', on);
  scTellRecording(sc.live.lastRecording);
  if (!on) return;
  const s = sc.live;
  $('#scNowSite').textContent = s.site ? s.site.name : '';
  let page = '';
  if (s.phase === 'slate') page = 'Title card…';
  else if (s.phase === 'end') page = 'Finished — play to run it again';
  else if (s.busy) page = 'Moving to the next page…';
  else {
    const shot = s.board && s.shot >= 0 && s.board[s.shot];
    page = shot ? shot.label : (s.page && (s.page.title || s.page.label)) || '';
    if (s.fixed && (s.fixed.reveal || s.fixed.hidden)) {
      const bits = [];
      if (s.fixed.reveal) bits.push(`${s.fixed.reveal} revealed`);
      if (s.fixed.hidden) bits.push(`${s.fixed.hidden} tidied`);
      page += ` · ${bits.join(', ')}`;
    }
  }
  $('#scNowPage').textContent = page;
  $('#scProgressBar').style.width = `${Math.round((s.progress || 0) * 100)}%`;
  const play = $('#scPlay');
  const playing = s.playing && s.phase !== 'end';
  play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  play.querySelector('span').textContent = playing ? 'Pause' : (s.phase === 'end' ? 'Again' : 'Play');
  $('#scRemoteSpeedValue').textContent = s.style === 'still' ? 'held' : `${s.speed} px/s`;
  segSet($('#scRemoteFrame'), s.frame);
  segSet($('#scRemoteCursor'), s.cursor);
  $('#scBlack').classList.toggle('on', !!s.blackout);
  $('#scFull').classList.toggle('on', !!s.fullscreen);
  $('#scRecordBtn').classList.toggle('on', !!s.recording);
  $('#scRecordBtn').textContent = s.recording ? `Recording ${s.recording.seconds}s` : 'Record';
  $('#scRec').classList.toggle('hidden', !s.recording);
  // Pages.
  const pages = s.page && s.page.count > 1;
  $('#scPageRow').classList.toggle('hidden', !pages);
  if (pages) $('#scPageCount').textContent = `Page ${s.page.index + 1} of ${s.page.count}${s.page.label ? ' · ' + s.page.label : ''}`;
  // The storyboard.
  const board = $('#scBoard');
  const key = (s.board || []).map(b => b.kind + b.label).join('|');
  if (board.dataset.key !== key) {
    board.dataset.key = key;
    board.innerHTML = '';
    (s.board || []).forEach((shot, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-shot';
      b.dataset.shot = String(i);
      b.title = 'Jump to this shot';
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = SC_SHOT_ICON[shot.kind] || '·';
      b.appendChild(ic);
      b.append(shot.label);
      board.appendChild(b);
    });
  }
  board.classList.toggle('hidden', !(s.board && s.board.length));
  for (const b of board.querySelectorAll('.sc-shot')) {
    const i = Number(b.dataset.shot);
    b.classList.toggle('on', i === s.shot);
    b.classList.toggle('done', i < s.shot);
  }
  const current = board.querySelector('.sc-shot.on');
  if (current) current.scrollIntoView({ block: 'nearest' });
  // Sites of a reel.
  const sitesBox = $('#scRemoteSites');
  sitesBox.classList.toggle('hidden', !(s.sites && s.sites.length > 1));
  if (s.sites && s.sites.length > 1) {
    sitesBox.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'sc-sites';
    s.sites.forEach((site, i) => {
      const b = document.createElement('button');
      b.className = 'sc-site-btn' + (i === s.siteIndex ? ' on' : '');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(i + 1);
      b.appendChild(n);
      b.append(site.name);
      b.addEventListener('click', () => scControl('site', i));
      list.appendChild(b);
    });
    sitesBox.appendChild(list);
  }
}
window.snap.on('showcase:state', scRender);

async function initShowcase(settings) {
  const saved = settings.showcase && typeof settings.showcase === 'object' ? settings.showcase : {};
  sc.opts = { ...SC_DEFAULTS, ...saved };
  // A panel saved by 2.7.0 called the style "mode".
  if (!saved.style && saved.mode) sc.opts.style = { scroll: 'scroll', tour: 'walkthrough', still: 'still' }[saved.mode] || 'walkthrough';
  delete sc.opts.mode;
  scBind();
  await scFillDisplays();
  scApply();
  scRender(await invoke('showcase:state').catch(() => ({ active: false })));
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
    state.section = settings.libSection || 'all';
    state.collapsed = new Set(settings.collapsedSections || []);
    setTab(settings.tab, { persist: false });
    await initShowcase(settings);
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
