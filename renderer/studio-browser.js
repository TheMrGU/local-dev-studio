/* Studio Browser chrome. The site itself lives in a WebContentsView the main
   process positions over #sbFrame — this page draws the instruments around it
   and reports where the hole is. All state arrives over the same preload
   bridge as the main window. */
const $ = sel => document.querySelector(sel);
const invoke = (channel, data) => window.snap.invoke(channel, data);

/* ---------- toasts (small copy of the main window's) ---------- */
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
const failed = err => toast(err && err.message ? err.message : String(err), { kind: 'err', timeout: 8000 });

const state = {
  info: null,          // sb:hello payload
  annotating: true,    // the overlay boots with annotate on
  filter: 'all',
  entries: [],
  lastPath: '/',
};

/* ---------- layout: tell main where the view goes ---------- */
const frame = $('#sbFrame');
let layoutQueued = false;
function sendLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    const r = frame.getBoundingClientRect();
    invoke('sb:layout', { x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
    $('#sbWidth').textContent = Math.round(r.width) + 'px';
  });
}
new ResizeObserver(sendLayout).observe(frame);
window.addEventListener('resize', sendLayout);

/* ---------- viewport presets + free resize ---------- */
function setPreset(width) {
  for (const b of document.querySelectorAll('.sb-presets button')) {
    b.classList.toggle('on', b.dataset.w === String(width));
  }
  if (width === 'full') {
    frame.classList.remove('narrow');
  } else {
    frame.classList.add('narrow');
    frame.style.setProperty('--sb-w', width + 'px');
  }
  sendLayout();
}
for (const b of document.querySelectorAll('.sb-presets button')) {
  b.addEventListener('click', () => setPreset(b.dataset.w));
}

// Dragging the handle is a free-width preset: the buttons stop being "on".
const handle = $('#sbHandle');
handle.addEventListener('mousedown', down => {
  down.preventDefault();
  handle.classList.add('dragging');
  const startX = down.clientX;
  const startW = frame.getBoundingClientRect().width;
  const move = e => {
    // the frame is centered, so each pixel of mouse travel is two of width
    const width = Math.max(320, Math.min(window.innerWidth, startW + (e.clientX - startX) * 2));
    frame.style.setProperty('--sb-w', Math.round(width) + 'px');
    for (const b of document.querySelectorAll('.sb-presets button')) b.classList.remove('on');
    sendLayout();
  };
  const up = () => {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

/* ---------- navigation ---------- */
$('#sbBack').addEventListener('click', () => invoke('sb:nav', { action: 'back' }).catch(failed));
$('#sbForward').addEventListener('click', () => invoke('sb:nav', { action: 'forward' }).catch(failed));
$('#sbReload').addEventListener('click', () => invoke('sb:nav', { action: 'reload' }).catch(failed));
$('#sbPath').addEventListener('click', async () => {
  try {
    await invoke('sb:copyText', { text: (state.info ? state.info.url : '') + state.lastPath });
    toast('Address copied', { kind: 'ok', timeout: 2200 });
  } catch (err) { failed(err); }
});

window.snap.on('sb:state', ({ path, canGoBack, canGoForward, pinnedId }) => {
  state.lastPath = path || '/';
  $('#sbPath').textContent = state.lastPath;
  $('#sbBack').disabled = !canGoBack;
  $('#sbForward').disabled = !canGoForward;
  const pick = $('#sbVersion');
  if (!pick.classList.contains('hidden')) {
    pick.value = pinnedId && [...pick.options].some(o => o.value === pinnedId) ? pinnedId : 'live';
  }
});

/* ---------- version picker (static projects only) ---------- */
async function fillVersions() {
  if (!state.info || !state.info.canPin) return;
  const pick = $('#sbVersion');
  let result;
  try {
    result = await invoke('version:list', { id: state.info.projectId });
  } catch { return; } // no snapshots is not an error worth a toast
  pick.innerHTML = '';
  const live = document.createElement('option');
  live.value = 'live';
  live.textContent = 'Live';
  pick.appendChild(live);
  for (const snap of result.snapshots) {
    const opt = document.createElement('option');
    opt.value = snap.id;
    const when = new Date(snap.timestamp);
    opt.textContent = (snap.label || (isNaN(when.getTime()) ? snap.id
      : when.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))) + ` · ${snap.source}`;
    pick.appendChild(opt);
  }
  pick.classList.remove('hidden');
}
$('#sbVersion').addEventListener('change', e => {
  invoke('sb:pin', { versionId: e.target.value }).catch(failed);
});

/* ---------- annotate toggle + copy for agent ---------- */
$('#sbAnnotate').addEventListener('click', async () => {
  state.annotating = !state.annotating;
  $('#sbAnnotate').classList.toggle('on', state.annotating);
  const reached = await invoke('sb:annotate', { on: state.annotating }).catch(() => false);
  if (!reached && state.annotating) {
    toast('The overlay isn\'t on this page yet — reload once if annotate does nothing.', { timeout: 6000 });
  }
});

$('#sbCopy').addEventListener('click', async () => {
  try {
    await invoke('sb:copyAgent');
    toast('Copied — paste it into any agent chat', { kind: 'ok' });
  } catch (err) { failed(err); }
});

/* ---------- screenshot ---------- */
$('#sbShot').addEventListener('click', async () => {
  const b = $('#sbShot');
  b.disabled = true;
  try {
    const { file } = await invoke('sb:shot');
    toast('Full-page screenshot saved', {
      kind: 'ok', timeout: 9000,
      action: { label: 'Open folder', fn: () => invoke('sb:revealShot', { file }).catch(failed) },
    });
  } catch (err) { failed(err); } finally { b.disabled = false; }
});

/* ---------- console drawer ---------- */
const logBox = $('#sbLog');
function lineFor(entry) {
  const div = document.createElement('div');
  div.className = 'sb-line ' + entry.kind;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = entry.ts;
  div.appendChild(ts);
  div.append(entry.text);
  return div;
}
function matches(entry) {
  return state.filter === 'all' || entry.kind === state.filter;
}
function renderLog() {
  logBox.innerHTML = '';
  const visible = state.entries.filter(matches);
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = state.entries.length ? 'Nothing matches that filter.' : 'Console is clean.';
    logBox.appendChild(empty);
    return;
  }
  for (const entry of visible) logBox.appendChild(lineFor(entry));
  logBox.scrollTop = logBox.scrollHeight;
}
window.snap.on('sb:console', entry => {
  state.entries.push(entry);
  if (state.entries.length > 500) state.entries.splice(0, state.entries.length - 500);
  if ($('#sbDrawer').classList.contains('hidden') || !matches(entry)) return;
  const atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
  logBox.querySelector('.sb-empty')?.remove();
  logBox.appendChild(lineFor(entry));
  if (atBottom) logBox.scrollTop = logBox.scrollHeight;
});
$('#sbConsole').addEventListener('click', () => {
  const drawer = $('#sbDrawer');
  const open = drawer.classList.toggle('hidden') === false;
  $('#sbConsole').classList.toggle('on', open);
  if (open) renderLog();
  sendLayout();
});
$('#sbChips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.filter = b.dataset.kind;
  for (const chip of document.querySelectorAll('.sb-chips button')) chip.classList.toggle('on', chip === b);
  renderLog();
});
$('#sbClear').addEventListener('click', () => { state.entries = []; renderLog(); });

/* ---------- init ---------- */
(async () => {
  try {
    state.info = await invoke('sb:hello');
    document.title = `${state.info.name} — Studio Browser`;
    const existing = await invoke('sb:consoleTail').catch(() => ({ entries: [] }));
    state.entries = existing.entries || [];
    await fillVersions();
    sendLayout();
  } catch (err) {
    failed(err);
  }
})();
