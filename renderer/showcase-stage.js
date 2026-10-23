/* ShowCase stage chrome. The site lives in a WebContentsView the main process
   positions inside this window; this page reports how much room there is and
   paints the bezel(s), the title/end cards and the blackout around the
   answer. It also holds the recorder (this window, captured as a screen
   share, into an MP4) and the music bed — both stay here because a renderer
   is where MediaRecorder and <audio> live. */
const $ = sel => document.querySelector(sel);
const invoke = (channel, data) => window.snap.invoke(channel, data);

const stage = $('#stage');
const bezel = $('#bezel');
const bezel2 = $('#bezel2');
const slate = $('#slate');
const hint = $('#hint');
const music = $('#music');

/* ---------- room for the site ---------- */
let queued = false;
function report() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const r = stage.getBoundingClientRect();
    invoke('sc:stage', { x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
  });
}
new ResizeObserver(report).observe(stage);
window.addEventListener('resize', report);

/* ---------- bezels around the fitted view(s) ---------- */
function placeBezel(el, box, kind) {
  if (!box || kind === 'none') { el.classList.add('hidden'); return; }
  const s = Math.max(0.35, Math.min(2.5, box.scale || 1));
  const edge = Math.round((kind === 'phone' ? 14 : kind === 'tablet' ? 22 : 12) * s);
  el.className = 'bezel ' + kind + (box.moving ? ' moving' : '');
  el.style.setProperty('--s', String(s));
  el.style.left = (box.x - edge) + 'px';
  el.style.top = (box.y - edge) + 'px';
  el.style.width = (box.width + edge * 2) + 'px';
  el.style.height = (box.height + edge * 2) + 'px';
}
window.snap.on('sc:frame', box => {
  if (!box) { bezel.classList.add('hidden'); bezel2.classList.add('hidden'); return; }
  placeBezel(bezel, box, box.kind === 'duo' ? 'laptop' : box.kind);
  if (box.kind === 'duo' && box.phone) placeBezel(bezel2, box.phone, 'phone');
  else bezel2.classList.add('hidden');
});

/* ---------- cards ---------- */
let leaveTimer = 0;
window.snap.on('sc:slate', card => {
  clearTimeout(leaveTimer);
  if (!card) {
    if (slate.classList.contains('hidden')) return;
    slate.classList.add('leaving');
    leaveTimer = setTimeout(() => { slate.classList.add('hidden'); slate.classList.remove('leaving'); }, 480);
    return;
  }
  slate.classList.remove('hidden', 'leaving', 'error');
  if (card.kind === 'error') slate.classList.add('error');
  const brand = card.brand || {};
  $('#slateBrand').textContent = brand.name || 'NightShyft Studio';
  $('#slateEyebrow').textContent = card.kind === 'end' ? 'thank you' : card.kind === 'error' ? 'could not open' : 'presents';
  $('#slateTitle').textContent = card.title || '';
  $('#slateTagline').textContent = card.tagline || '';
  $('#slateUrl').textContent = card.url || '';
  $('#slateFoot').textContent = card.kind === 'end' ? (brand.site || '') : '';
  if (card.kind === 'end') fadeMusic(0, 2600);
});

window.snap.on('sc:black', on => $('#black').classList.toggle('hidden', !on));

/* ---------- key hint: shown for a moment at the start, H brings it back ---------- */
let hintTimer = setTimeout(() => hint.classList.add('off'), 6000);
window.snap.on('sc:hint', value => {
  clearTimeout(hintTimer);
  const show = value === 'toggle' ? hint.classList.contains('off') : !!value;
  hint.classList.toggle('off', !show);
  if (show) hintTimer = setTimeout(() => hint.classList.add('off'), 6000);
});

/* ---------- music bed ---------- */
let musicTarget = 0;
let fadeTimer = 0;
function fadeMusic(to, ms) {
  clearInterval(fadeTimer);
  const from = music.volume;
  const t0 = performance.now();
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - t0) / ms);
    music.volume = Math.max(0, Math.min(1, from + (to - from) * t));
    if (t >= 1) { clearInterval(fadeTimer); if (to === 0) music.pause(); }
  }, 50);
}
function startMusic(bed) {
  if (!bed || !bed.path) return;
  musicTarget = Math.max(0, Math.min(1, Number(bed.volume) || 0.6));
  music.src = 'file:///' + String(bed.path).replace(/\\/g, '/').replace(/^\/+/, '');
  music.volume = 0;
  music.play().then(() => fadeMusic(musicTarget, 2200)).catch(() => {});
}

/* ---------- recorder ---------- */
const MIMES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
let recorder = null;
let recStream = null;
async function startRecording() {
  if (recorder) return;
  try {
    const mime = MIMES.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('This build cannot encode video.');
    recStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    recorder = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: 14e6 });
    await invoke('sc:chunk', { start: true, mime });
    recorder.ondataavailable = async e => {
      if (!e.data || !e.data.size) return;
      const buf = new Uint8Array(await e.data.arrayBuffer());
      invoke('sc:chunk', buf).catch(() => {});
    };
    recorder.onstop = () => {
      // The last dataavailable lands before onstop; give it a beat to be sent.
      setTimeout(() => invoke('sc:chunk', { done: true }).catch(() => {}), 250);
      for (const t of recStream.getTracks()) t.stop();
      recorder = null;
      recStream = null;
      $('#rec').classList.add('hidden');
    };
    recorder.start(1000);
    $('#rec').classList.remove('hidden');
  } catch (err) {
    recorder = null;
    if (recStream) for (const t of recStream.getTracks()) t.stop();
    recStream = null;
    invoke('sc:chunk', { error: err.message || String(err) }).catch(() => {});
  }
}
function stopRecording() {
  if (!recorder) { invoke('sc:chunk', { done: true }).catch(() => {}); return; }
  if (recorder.state !== 'inactive') recorder.stop();
}
window.snap.on('sc:record', ({ on }) => { if (on) startRecording(); else stopRecording(); });
// The screen share stops the moment the window is captured no more; tidy up.
window.addEventListener('beforeunload', () => { if (recorder && recorder.state !== 'inactive') recorder.stop(); });

/* ---------- init ---------- */
(async () => {
  try {
    const info = await invoke('sc:hello');
    if (info && info.brand && info.brand.name) $('#slateBrand').textContent = info.brand.name;
    if (info && info.music) startMusic(info.music);
  } catch { /* not a ShowCase window */ }
  report();
})();
