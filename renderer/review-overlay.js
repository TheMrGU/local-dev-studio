/* SiteSnap Review Mode overlay.
 *
 * Injected at serve time into pages hosted in review mode. Everything lives in
 * a closed shadow root so the host page's CSS can't touch it and ours can't
 * leak out. Talks to the app over same-origin HTTP (/__sitesnap__/review/).
 * The page being reviewed is arbitrary third-party markup — never trust it,
 * never modify it; we only read geometry and styles.
 */
(() => {
  'use strict';
  if (window.__ssReviewLoaded) return;
  window.__ssReviewLoaded = true;

  const API = '/__sitesnap__/review/';
  const state = {
    config: null,          // GET state payload
    annotating: true,      // select-mode toggle
    selected: [],          // [Element]
    region: null,          // {x,y,w,h} page coords
    draft: null,           // open panel context
    hoverEl: null,
    dragStart: null,
  };

  const api = {
    get: route => fetch(API + route).then(r => r.json()),
    post: (route, body) => fetch(API + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }),
  };

  /* ---------- selector generation ---------- */
  const cssEscape = s => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const semanticClasses = el => [...el.classList].filter(c =>
    /^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/.test(c) && !/\d{3,}|^(js-|is-|has-)/.test(c)).slice(0, 3);

  function uniqueIn(doc, sel) {
    try { return doc.querySelectorAll(sel).length === 1; } catch { return false; }
  }

  /** Readable selector: ids and meaningful classes, shortest unique path. */
  function goodSelector(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && uniqueIn(document, '#' + cssEscape(el.id))) {
      return '#' + cssEscape(el.id);
    }
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 5) {
      let seg = node.tagName.toLowerCase();
      if (node.id && /^[a-zA-Z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + cssEscape(node.id) + (seg === 'div' ? '' : ''));
        const sel = parts.join(' > ');
        if (uniqueIn(document, sel)) return sel;
        node = node.parentElement;
        continue;
      }
      const classes = semanticClasses(node);
      if (classes.length) seg += '.' + classes.map(cssEscape).join('.');
      // Disambiguate against same-tag siblings when needed.
      const parent = node.parentElement;
      if (parent && [...parent.children].filter(c => c.tagName === node.tagName).length > 1 && !classes.length) {
        seg += `:nth-of-type(${[...parent.children].filter(c => c.tagName === node.tagName).indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      if (uniqueIn(document, sel)) return sel;
      node = node.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  /** Mechanical fallback: exact nth-child path from body. Always resolvable. */
  function fallbackSelector(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body && node.parentElement) {
      const idx = [...node.parentElement.children].indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
      node = node.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  }

  /* ---------- context capture ---------- */
  const STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing',
    'color', 'backgroundColor', 'margin', 'padding', 'display'];

  function captureContext(elements, region) {
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      label: window.innerWidth <= 500 ? 'mobile' : window.innerWidth <= 900 ? 'tablet' : 'desktop',
    };
    const base = { viewport, pageUrl: location.pathname + location.search };
    if (region) return { ...base, boundingBox: region, selector: '', selectorFallback: '' };
    if (!elements.length) return base;

    const first = elements[0];
    const style = getComputedStyle(first);
    const styles = {};
    for (const key of STYLE_KEYS) styles[key] = style[key];
    const boxes = elements.map(el => el.getBoundingClientRect());
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const section = first.closest('section, header, footer, main, article, aside, nav');
    return {
      ...base,
      selector: elements.map(goodSelector).join(', '),
      selectorFallback: elements.map(fallbackSelector).join(', '),
      outerHTML: first.outerHTML.slice(0, 4000),
      boundingBox: {
        x: Math.round(x + window.scrollX), y: Math.round(y + window.scrollY),
        w: Math.round(Math.max(...boxes.map(b => b.x + b.width)) - x),
        h: Math.round(Math.max(...boxes.map(b => b.y + b.height)) - y),
      },
      computedStyles: styles,
      parentSection: section ? section.tagName.toLowerCase()
        + (section.className && typeof section.className === 'string'
          ? '.' + section.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '',
      siblingCount: first.parentElement ? first.parentElement.children.length : 0,
      sourceFile: location.pathname !== '/' ? decodeURIComponent(location.pathname.replace(/^\//, '')) : '',
    };
  }

  /* ---------- shadow UI ---------- */
  const host = document.createElement('div');
  host.id = '__ss-review-host';
  const root = host.attachShadow({ mode: 'open' });
  const ACCENT = '#ff3e00';

  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
    .hl { position: fixed; pointer-events: none; z-index: 2147483600;
          border: 1.5px solid ${ACCENT}; background: rgba(255,62,0,0.06); border-radius: 2px; display: none; }
    .hl-tag { position: fixed; pointer-events: none; z-index: 2147483601; background: #111; color: #fff;
          font-size: 11px; padding: 2px 7px; border-radius: 4px; display: none; white-space: nowrap; font-family: Consolas, monospace; }
    .sel { position: fixed; pointer-events: none; z-index: 2147483599;
          border: 2px solid ${ACCENT}; border-radius: 2px; background: rgba(255,62,0,0.04); }
    .rgn { position: absolute; pointer-events: none; z-index: 2147483599;
          border: 1.5px dashed ${ACCENT}; background: rgba(255,62,0,0.05); }
    .bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2147483646;
          display: flex; gap: 4px; align-items: center; background: rgba(17,17,17,0.94); color: #eee;
          padding: 8px 10px; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.35);
          font-size: 12.5px; backdrop-filter: blur(10px); }
    .bar .brand { color: ${ACCENT}; font-weight: 700; margin: 0 6px 0 2px; letter-spacing: .02em; }
    .bar button { background: none; border: none; color: #ddd; font-size: 12.5px; padding: 6px 9px;
          border-radius: 8px; cursor: pointer; }
    .bar button:hover { background: rgba(255,255,255,0.1); }
    .bar button.on { background: ${ACCENT}; color: #fff; }
    .bar .sep { width: 1px; height: 18px; background: rgba(255,255,255,0.16); margin: 0 3px; }
    .bar .count { color: #999; padding: 0 6px; }
    .panel { position: fixed; z-index: 2147483647; width: 330px; background: #fff; color: #1d1d1f;
          border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.3); padding: 14px; }
    .panel h3 { margin: 0 0 2px; font-size: 13px; font-weight: 650; }
    .panel .sel-label { font-family: Consolas, monospace; font-size: 11px; color: #86868b;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 10px; }
    .row { display: flex; gap: 4px; margin: 6px 0; flex-wrap: wrap; }
    .rate { flex: 1; min-width: 24px; height: 26px; border: 1px solid #d2d2d7; background: #fff; border-radius: 6px;
          font-size: 11.5px; cursor: pointer; padding: 0; }
    .rate.on { background: #111; color: #fff; border-color: #111; }
    .chip { border: 1px solid #d2d2d7; background: #fff; border-radius: 999px; font-size: 11.5px;
          padding: 4px 10px; cursor: pointer; }
    .chip.on { background: #111; color: #fff; border-color: #111; }
    .chip.sev-on { background: ${ACCENT}; color: #fff; border-color: ${ACCENT}; }
    textarea { width: 100%; border: 1px solid #d2d2d7; border-radius: 8px; padding: 7px 9px; font-size: 12.5px;
          resize: vertical; min-height: 44px; margin-top: 2px; }
    textarea:focus { outline: 2px solid #111; border-color: transparent; }
    .lbl { font-size: 11px; font-weight: 600; color: #6e6e73; margin-top: 8px; display: flex; justify-content: space-between; align-items: center; }
    .mic { border: none; background: none; cursor: pointer; font-size: 13px; padding: 0 4px; }
    .mic.rec { color: ${ACCENT}; }
    .actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .save { background: #111; color: #fff; border: none; border-radius: 8px; padding: 8px 16px;
          font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .save:disabled { opacity: .4; cursor: default; }
    .ghost { background: none; border: none; color: #6e6e73; font-size: 12.5px; cursor: pointer; padding: 8px 6px; }
    .err { color: #c62828; font-size: 11.5px; margin-top: 8px; display: none; }
    .toast { position: fixed; left: 50%; bottom: 74px; transform: translateX(-50%); z-index: 2147483647;
          background: #111; color: #fff; font-size: 12.5px; padding: 10px 16px; border-radius: 10px;
          display: flex; gap: 12px; align-items: center; box-shadow: 0 10px 40px rgba(0,0,0,0.35); }
    .toast button { background: none; border: none; color: ${ACCENT}; font-weight: 650; cursor: pointer; font-size: 12.5px; }
    .modal { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.4);
          display: flex; align-items: center; justify-content: center; }
    .modal-card { width: 360px; max-height: 70vh; overflow: auto; background: #fff; border-radius: 14px; padding: 16px; color: #1d1d1f; }
    .modal-card h3 { margin: 0 0 10px; font-size: 14px; }
    .proj { display: block; width: 100%; text-align: left; padding: 9px 10px; border: 1px solid #e5e5ea;
          background: #fff; border-radius: 8px; margin-bottom: 6px; cursor: pointer; font-size: 13px; }
    .proj:hover { border-color: #111; }
    .proj .kind { color: #86868b; font-size: 11px; margin-left: 6px; }
    .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646; background: ${ACCENT}; color: #fff;
          font-size: 13px; font-weight: 600; text-align: center; padding: 9px; }
    .pin { position: fixed; z-index: 2147483645; width: 21px; height: 21px; border-radius: 50%;
          background: ${ACCENT}; color: #fff; font-size: 10.5px; font-weight: 700; border: 2px solid #fff;
          box-shadow: 0 2px 8px rgba(0,0,0,0.35); cursor: pointer; padding: 0; line-height: 17px; text-align: center; }
    .pin.resolved { background: #23a55a; }
    .pin-why { font-size: 12.5px; margin: 8px 0 0; }
    .pin-want { font-size: 12.5px; margin: 4px 0 0; color: #6e6e73; }
    .pin-res { font-size: 12.5px; font-weight: 650; color: #23a55a; margin: 8px 0 0; }
    .anchor-row { display: flex; gap: 7px; align-items: center; font-size: 12px; margin-top: 10px; cursor: pointer; }
    .orphan-row { display: flex; justify-content: space-between; gap: 8px; align-items: center;
          padding: 8px 0; border-bottom: 1px solid #e5e5ea; font-size: 12.5px; }
  </style>`;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const hl = el('div', 'hl');
  const hlTag = el('div', 'hl-tag');
  root.appendChild(hl);
  root.appendChild(hlTag);

  let toastEl = null;
  function toast(message, actions = [], sticky = false) {
    if (toastEl) toastEl.remove();
    toastEl = el('div', 'toast');
    toastEl.appendChild(el('span', '', message));
    for (const action of actions) {
      const b = el('button', '', action.label);
      b.addEventListener('click', action.fn);
      toastEl.appendChild(b);
    }
    root.appendChild(toastEl);
    if (!sticky) setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 6000);
  }

  /* ---------- selection visuals ---------- */
  const selBoxes = [];
  function redrawSelection() {
    for (const box of selBoxes.splice(0)) box.remove();
    for (const target of state.selected) {
      const r = target.getBoundingClientRect();
      const box = el('div', 'sel');
      Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
      root.appendChild(box);
      selBoxes.push(box);
    }
  }
  window.addEventListener('scroll', () => requestAnimationFrame(() => { redrawSelection(); renderPins(); }), { passive: true, capture: true });
  window.addEventListener('resize', () => requestAnimationFrame(() => { redrawSelection(); renderPins(); }), { passive: true });

  function clearSelection() {
    state.selected = [];
    state.region = null;
    redrawSelection();
    for (const rgn of root.querySelectorAll('.rgn')) rgn.remove();
  }

  /* ---------- input panel ---------- */
  let panel = null;
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    state.draft = null;
    clearSelection();
  }

  function openPanel(scope, context) {
    if (panel) panel.remove();
    state.draft = {
      scope,
      context,
      input: { rating: null, severity: 'should-fix', axes: [], why: '', want: '' },
      annotationId: null,
    };
    panel = el('div', 'panel');

    const titles = { element: 'Annotate element', region: 'Annotate region', page: 'Page note', global: 'Site-wide note' };
    panel.appendChild(el('h3', '', titles[scope] || 'Annotate'));
    if (context.selector) panel.appendChild(el('div', 'sel-label', context.selector));

    // rating 1–10, one tap
    panel.appendChild(el('div', 'lbl', 'Rating (optional — needs a reason)'));
    const rateRow = el('div', 'row');
    for (let i = 1; i <= 10; i++) {
      const b = el('button', 'rate', String(i));
      b.addEventListener('click', () => {
        state.draft.input.rating = state.draft.input.rating === i ? null : i;
        rateRow.querySelectorAll('.rate').forEach((x, idx) => x.classList.toggle('on', idx + 1 === state.draft.input.rating));
        refreshSave();
      });
      rateRow.appendChild(b);
    }
    panel.appendChild(rateRow);

    // severity
    const sevRow = el('div', 'row');
    for (const sev of ['blocking', 'should-fix', 'nitpick']) {
      const b = el('button', 'chip' + (sev === 'should-fix' ? ' sev-on' : ''), sev);
      b.addEventListener('click', () => {
        state.draft.input.severity = sev;
        sevRow.querySelectorAll('.chip').forEach(x => x.classList.toggle('sev-on', x.textContent === sev));
      });
      sevRow.appendChild(b);
    }
    panel.appendChild(sevRow);

    // axes
    const axesRow = el('div', 'row');
    for (const axis of (state.config ? state.config.axes : [])) {
      const b = el('button', 'chip', axis);
      b.addEventListener('click', () => {
        const list = state.draft.input.axes;
        const at = list.indexOf(axis);
        if (at === -1) list.push(axis); else list.splice(at, 1);
        b.classList.toggle('on', at === -1);
      });
      axesRow.appendChild(b);
    }
    panel.appendChild(axesRow);

    // why + want
    const whyLbl = el('div', 'lbl');
    whyLbl.appendChild(el('span', '', 'Why it\'s wrong'));
    const mic = el('button', 'mic', '🎤');
    mic.title = 'Dictate';
    whyLbl.appendChild(mic);
    panel.appendChild(whyLbl);
    const why = document.createElement('textarea');
    why.placeholder = 'The diagnosis — what specifically fails here?';
    why.addEventListener('input', () => { state.draft.input.why = why.value; refreshSave(); });
    panel.appendChild(why);
    wireVoice(mic, why, () => { state.draft.input.why = why.value; refreshSave(); });

    panel.appendChild(el('div', 'lbl', 'What I want'));
    const want = document.createElement('textarea');
    want.placeholder = 'The direction — what should it become?';
    want.addEventListener('input', () => { state.draft.input.want = want.value; });
    panel.appendChild(want);

    const err = el('div', 'err');
    panel.appendChild(err);

    const actions = el('div', 'actions');
    const save = el('button', 'save', 'Save');
    save.addEventListener('click', () => submit(false));
    actions.appendChild(save);
    if (scope === 'element') {
      const ref = el('button', 'ghost', 'Save + add reference…');
      ref.addEventListener('click', () => submit(true));
      actions.appendChild(ref);
    }
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', closePanel);
    actions.appendChild(cancel);
    panel.appendChild(actions);

    function refreshSave() {
      const d = state.draft.input;
      const blocked = d.rating !== null && d.why.trim().length < (state.config ? state.config.minWhy : 10);
      save.disabled = blocked;
      err.style.display = blocked ? 'block' : 'none';
      err.textContent = blocked ? 'A rating needs a reason — a number alone isn\'t actionable.' : '';
    }
    refreshSave();

    async function submit(pickReference) {
      try {
        const { annotation } = await api.post('annotate', {
          scope: state.draft.scope, context: state.draft.context, input: state.draft.input,
        });
        state.draft.annotationId = annotation.id;
        await refreshState();
        if (pickReference) {
          openReferencePicker(annotation.id);
        } else {
          toast(`Saved — ${countLabel()}`);
          closePanel();
        }
      } catch (e) {
        err.style.display = 'block';
        err.textContent = e.message;
      }
    }

    // position near selection, clamped
    const anchor = context.boundingBox
      ? { x: context.boundingBox.x - window.scrollX, y: context.boundingBox.y - window.scrollY, w: context.boundingBox.w }
      : { x: window.innerWidth / 2 - 165, y: window.innerHeight / 2 - 200, w: 0 };
    const left = Math.max(10, Math.min(anchor.x + anchor.w + 14, window.innerWidth - 344));
    const top = Math.max(10, Math.min(anchor.y, window.innerHeight - 420));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    root.appendChild(panel);
    why.focus();
  }

  function wireVoice(button, textarea, onChange) {
    const Recognition = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!Recognition) { button.style.display = 'none'; return; }
    let rec = null;
    button.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new Recognition();
      rec.continuous = true;
      rec.interimResults = false;
      button.classList.add('rec');
      rec.onresult = event => {
        const text = [...event.results].slice(event.resultIndex).map(r => r[0].transcript).join(' ');
        textarea.value = (textarea.value + ' ' + text).trim();
        onChange();
      };
      rec.onend = () => { button.classList.remove('rec'); rec = null; };
      rec.onerror = () => { button.classList.remove('rec'); rec = null; };
      rec.start();
    });
  }

  /* ---------- reference picker ---------- */
  function openReferencePicker(annotationId) {
    api.get('projects').then(({ projects }) => {
      const modal = el('div', 'modal');
      const card = el('div', 'modal-card');
      card.appendChild(el('h3', '', 'Reference an extracted site'));
      if (!projects.length) card.appendChild(el('p', '', 'No other projects in the library yet.'));
      for (const project of projects) {
        const b = el('button', 'proj');
        b.appendChild(el('span', '', project.name));
        b.appendChild(el('span', 'kind', project.kind));
        b.addEventListener('click', async () => {
          try {
            const { url } = await api.post('reference/open', { annotationId, projectId: project.id });
            window.open(url, '_blank');
            modal.remove();
            toast('Pick the element in the new tab — it saves automatically.');
            closePanel();
          } catch (e) { toast(e.message); }
        });
        card.appendChild(b);
      }
      const cancel = el('button', 'ghost', 'Cancel');
      cancel.addEventListener('click', () => modal.remove());
      card.appendChild(cancel);
      modal.appendChild(card);
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
      root.appendChild(modal);
    }).catch(e => toast(e.message));
  }

  /* ---------- pick mode (this tab IS the reference) ---------- */
  function enterPickMode() {
    root.appendChild(el('div', 'banner',
      'Reference pick — click the element you want to point at. It saves automatically.'));
    state.annotating = true;
  }

  async function pickElement(target) {
    const styles = {};
    const computed = getComputedStyle(target);
    for (const key of STYLE_KEYS) styles[key] = computed[key];
    try {
      await api.post('reference/set', {
        selector: goodSelector(target),
        styles,
        outerHTML: target.outerHTML.slice(0, 2000),
      });
      toast('Reference saved — you can close this tab and return to your review.');
      clearSelection();
    } catch (e) { toast(e.message); }
  }

  /* ---------- pins: the resolve loop ---------- */
  const pinEls = [];
  let pinPop = null;

  function annotationsForPage() {
    if (!state.config) return [];
    const here = location.pathname + location.search;
    return state.config.annotations.filter(a =>
      (a.scope === 'element' || a.scope === 'region')
      && (a.context.pageUrl || '/') === here);
  }

  function locate(annotation) {
    for (const sel of [annotation.context.selector, annotation.context.selectorFallback]) {
      if (!sel) continue;
      try {
        const target = document.querySelector(sel);
        if (target) return target;
      } catch { /* selector list with commas can be invalid after edits */ }
    }
    return null;
  }

  function renderPins() {
    for (const pin of pinEls.splice(0)) pin.remove();
    const list = annotationsForPage();
    list.forEach((annotation, index) => {
      let x, y;
      if (annotation.scope === 'region' && annotation.context.boundingBox) {
        const b = annotation.context.boundingBox;
        x = b.x - window.scrollX + b.w;
        y = b.y - window.scrollY;
      } else {
        const target = locate(annotation);
        if (!target) return; // orphaned — lives in the toolbar list instead
        const r = target.getBoundingClientRect();
        x = r.right;
        y = r.top;
      }
      const pin = el('button', 'pin' + (annotation.resolved ? ' resolved' : ''),
        annotation.resolved ? '✓' : String(index + 1));
      pin.title = (annotation.input.why || '').slice(0, 120);
      Object.assign(pin.style, { left: Math.round(x - 10) + 'px', top: Math.round(y - 10) + 'px' });
      pin.addEventListener('click', () => openPinPopup(annotation));
      root.appendChild(pin);
      pinEls.push(pin);
    });
  }

  function closePinPop() {
    if (pinPop) { pinPop.remove(); pinPop = null; }
  }

  function openPinPopup(annotation) {
    closePinPop();
    pinPop = el('div', 'panel');
    const head = `${annotation.input.severity}`
      + (annotation.input.rating ? ` · ${annotation.input.rating}/10` : '')
      + (annotation.input.axes.length ? ` · ${annotation.input.axes.join(', ')}` : '');
    pinPop.appendChild(el('h3', '', head));
    if (annotation.context.selector) pinPop.appendChild(el('div', 'sel-label', annotation.context.selector));
    if (annotation.input.why) pinPop.appendChild(el('p', 'pin-why', annotation.input.why));
    if (annotation.input.want) pinPop.appendChild(el('p', 'pin-want', '→ ' + annotation.input.want));

    const actions = el('div', 'actions');
    if (annotation.resolved) {
      pinPop.appendChild(el('p', 'pin-res', 'Resolved'
        + (annotation.resolvedRating && annotation.input.rating
          ? ` — ${annotation.input.rating} → ${annotation.resolvedRating}` : '')));
    } else {
      pinPop.appendChild(el('div', 'lbl', 'Mark resolved — how is it now?'));
      const row = el('div', 'row');
      let newRating = null;
      for (let i = 1; i <= 10; i++) {
        const b = el('button', 'rate', String(i));
        b.addEventListener('click', () => {
          newRating = i;
          row.querySelectorAll('.rate').forEach((x, idx) => x.classList.toggle('on', idx + 1 === i));
        });
        row.appendChild(b);
      }
      pinPop.appendChild(row);
      const anchorLabel = el('label', 'anchor-row');
      const anchorBox = document.createElement('input');
      anchorBox.type = 'checkbox';
      anchorLabel.appendChild(anchorBox);
      anchorLabel.appendChild(el('span', '', 'Save the after as a calibration anchor'));
      pinPop.appendChild(anchorLabel);

      const resolveBtn = el('button', 'save', 'Resolve');
      resolveBtn.addEventListener('click', async () => {
        try {
          await api.post('resolve', { id: annotation.id, resolvedRating: newRating, asAnchor: anchorBox.checked });
          await refreshState();
          closePinPop();
          renderPins();
          toast(newRating && annotation.input.rating
            ? `Resolved — ${annotation.input.rating} → ${newRating}` : 'Resolved');
        } catch (e) { toast(e.message); }
      });
      actions.appendChild(resolveBtn);
    }
    const del = el('button', 'ghost', 'Delete');
    del.addEventListener('click', async () => {
      await api.post('delete', { id: annotation.id }).catch(() => {});
      await refreshState();
      closePinPop();
      renderPins();
    });
    actions.appendChild(del);
    const close = el('button', 'ghost', 'Close');
    close.addEventListener('click', closePinPop);
    actions.appendChild(close);
    pinPop.appendChild(actions);

    const box = annotation.context.boundingBox;
    const anchor = box
      ? { x: box.x - window.scrollX, y: box.y - window.scrollY, w: box.w }
      : { x: window.innerWidth / 2 - 165, y: 120, w: 0 };
    pinPop.style.left = Math.max(10, Math.min(anchor.x + anchor.w + 14, window.innerWidth - 344)) + 'px';
    pinPop.style.top = Math.max(10, Math.min(anchor.y, window.innerHeight - 380)) + 'px';
    root.appendChild(pinPop);
  }

  /** After code changes, selectors may die. Flag those annotations as orphaned
   *  (never delete) and un-flag ones whose element came back. */
  async function reconcileOrphans() {
    let changed = false;
    for (const annotation of annotationsForPage()) {
      if (annotation.scope !== 'element') continue;
      const found = !!locate(annotation);
      if (found === !annotation.orphaned) continue;
      changed = true;
      await api.post('update', { id: annotation.id, patch: { orphaned: !found } }).catch(() => {});
    }
    if (changed) await refreshState().catch(() => {});
  }

  function showOrphans() {
    const orphans = state.config.annotations.filter(a => a.orphaned && !a.resolved);
    const modal = el('div', 'modal');
    const card = el('div', 'modal-card');
    card.appendChild(el('h3', '', 'Orphaned annotations'));
    card.appendChild(el('p', 'pin-want',
      'Their elements no longer exist — the note is kept, the pin has nowhere to sit.'));
    for (const annotation of orphans) {
      const row = el('div', 'orphan-row');
      const label = el('span', '', `${annotation.context.selector || annotation.scope} — ${(annotation.input.why || '').slice(0, 70)}`);
      row.appendChild(label);
      const del = el('button', 'ghost', 'Delete');
      del.addEventListener('click', async () => {
        await api.post('delete', { id: annotation.id }).catch(() => {});
        await refreshState();
        row.remove();
      });
      row.appendChild(del);
      card.appendChild(row);
    }
    const close = el('button', 'ghost', 'Close');
    close.addEventListener('click', () => modal.remove());
    card.appendChild(close);
    modal.appendChild(card);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    root.appendChild(modal);
  }

  /* ---------- toolbar ---------- */
  const bar = el('div', 'bar');
  const countLabel = () => {
    const mine = state.config ? state.config.annotations.filter(a => a.reviewId === state.config.review.id).length : 0;
    return `${mine} note${mine === 1 ? '' : 's'}`;
  };

  function buildBar() {
    bar.innerHTML = '';
    bar.appendChild(el('span', 'brand', 'Review'));
    bar.appendChild(el('span', '', state.config ? state.config.project.name : ''));
    bar.appendChild(el('span', 'sep'));

    const annotate = el('button', state.annotating ? 'on' : '', 'Annotate');
    annotate.title = 'Toggle element selection (browse the site normally when off)';
    annotate.addEventListener('click', () => {
      state.annotating = !state.annotating;
      annotate.classList.toggle('on', state.annotating);
      hideHover();
    });
    bar.appendChild(annotate);

    const pageNote = el('button', '', 'Page note');
    pageNote.addEventListener('click', () => openPanel('page', captureContext([], null)));
    bar.appendChild(pageNote);
    const siteNote = el('button', '', 'Site note');
    siteNote.addEventListener('click', () => openPanel('global', captureContext([], null)));
    bar.appendChild(siteNote);

    bar.appendChild(el('span', 'sep'));
    for (const [label, w, h] of [['375', 375, 812], ['768', 768, 1024], ['1440', 1440, 900]]) {
      const b = el('button', '', label);
      b.title = `Open this page at ${w}px to annotate that breakpoint`;
      b.addEventListener('click', () => window.open(location.href, '_blank',
        `width=${w},height=${h},noopener`));
      bar.appendChild(b);
    }

    bar.appendChild(el('span', 'sep'));
    const count = el('span', 'count', countLabel());
    count.id = 'ss-count';
    bar.appendChild(count);

    const orphaned = state.config
      ? state.config.annotations.filter(a => a.orphaned && !a.resolved).length : 0;
    if (orphaned) {
      const b = el('button', '', `${orphaned} orphaned`);
      b.title = 'Annotations whose element no longer exists';
      b.addEventListener('click', showOrphans);
      bar.appendChild(b);
    }

    const exportBtn = el('button', '', 'Export');
    exportBtn.addEventListener('click', doExport);
    bar.appendChild(exportBtn);

    const done = el('button', '', 'Done');
    done.title = 'Leave review mode';
    done.addEventListener('click', async () => {
      await api.post('done').catch(() => {});
      location.reload();
    });
    bar.appendChild(done);
  }

  async function doExport() {
    try {
      const result = await api.post('export');
      toast(`Exported to ${result.folder}`, [
        { label: 'Copy path', fn: () => navigator.clipboard.writeText(result.folder) },
        { label: 'Open folder', fn: () => api.post('export/reveal').catch(() => {}) },
      ], true);
      await refreshState();
    } catch (e) { toast(e.message); }
  }

  /* ---------- hover + selection events ---------- */
  function hideHover() {
    hl.style.display = 'none';
    hlTag.style.display = 'none';
    state.hoverEl = null;
  }

  const ownNode = target => target === host || host.contains(target);

  document.addEventListener('mousemove', event => {
    if (!state.annotating || state.dragStart || panel) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || ownNode(target) || target === document.body || target === document.documentElement) {
      hideHover();
      return;
    }
    state.hoverEl = target;
    const r = target.getBoundingClientRect();
    Object.assign(hl.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
    const classes = semanticClasses(target).map(c => '.' + c).join('');
    hlTag.textContent = target.tagName.toLowerCase() + classes;
    Object.assign(hlTag.style, {
      display: 'block',
      left: Math.min(r.x, window.innerWidth - 160) + 'px',
      top: Math.max(2, r.y - 22) + 'px',
    });
  }, true);

  document.addEventListener('mousedown', event => {
    if (!state.annotating || panel || ownNode(event.target)) return;
    state.dragStart = { x: event.clientX, y: event.clientY, moved: false };
  }, true);

  document.addEventListener('mousemove', event => {
    if (!state.dragStart) return;
    const dx = event.clientX - state.dragStart.x, dy = event.clientY - state.dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) < 8 && !state.dragStart.moved) return;
    state.dragStart.moved = true;
    hideHover();
    let rgn = root.querySelector('.rgn');
    if (!rgn) { rgn = el('div', 'rgn'); root.appendChild(rgn); }
    const x = Math.min(event.clientX, state.dragStart.x), y = Math.min(event.clientY, state.dragStart.y);
    Object.assign(rgn.style, {
      position: 'fixed',
      left: x + 'px', top: y + 'px',
      width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px',
    });
  }, true);

  document.addEventListener('mouseup', event => {
    if (!state.annotating || !state.dragStart || panel) { state.dragStart = null; return; }
    const drag = state.dragStart;
    state.dragStart = null;
    if (ownNode(event.target)) return;

    if (drag.moved) {
      const x = Math.min(event.clientX, drag.x), y = Math.min(event.clientY, drag.y);
      const region = {
        x: Math.round(x + window.scrollX), y: Math.round(y + window.scrollY),
        w: Math.round(Math.abs(event.clientX - drag.x)), h: Math.round(Math.abs(event.clientY - drag.y)),
      };
      if (region.w > 12 && region.h > 12) {
        state.region = region;
        openPanel('region', captureContext([], region));
      }
      return;
    }

    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || ownNode(target) || target === document.body || target === document.documentElement) return;
    event.preventDefault();
    event.stopPropagation();

    if (state.config && state.config.pick) { pickElement(target); return; }

    if (event.shiftKey && state.selected.length) {
      if (!state.selected.includes(target)) state.selected.push(target);
      redrawSelection();
      openPanel('element', captureContext(state.selected, null));
      return;
    }
    state.selected = [target];
    redrawSelection();
    openPanel('element', captureContext(state.selected, null));
  }, true);

  // Swallow the click that follows our handled mouseup so links don't navigate.
  document.addEventListener('click', event => {
    if (state.annotating && !ownNode(event.target) && !state.config?.pick) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (panel) closePanel();
      else clearSelection();
      hideHover();
    }
    if (event.key === 'ArrowUp' && state.selected.length === 1 && panel) {
      const parent = state.selected[0].parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        event.preventDefault();
        state.selected = [parent];
        redrawSelection();
        openPanel('element', captureContext(state.selected, null));
      }
    }
  }, true);

  /* ---------- boot ---------- */
  async function refreshState() {
    state.config = await api.get('state');
    if (bar.isConnected) buildBar(); // counts and the orphan chip stay honest
    return state.config;
  }

  async function boot() {
    try {
      await refreshState();
    } catch {
      return; // review mode ended between injection and load
    }
    buildBar();
    root.appendChild(bar);
    document.documentElement.appendChild(host);
    if (state.config.pick) enterPickMode();
    await reconcileOrphans();
    renderPins();
  }

  // Debug/automation surface — the acceptance test drives review through this.
  window.__ssReview = {
    state,
    api,
    select: selector => {
      const target = document.querySelector(selector);
      if (!target) throw new Error('no element: ' + selector);
      state.selected = [target];
      redrawSelection();
      openPanel('element', captureContext(state.selected, null));
      return true;
    },
    openScope: scope => openPanel(scope, captureContext([], null)),
    setInput: fields => { Object.assign(state.draft.input, fields); return state.draft.input; },
    save: () => api.post('annotate', {
      scope: state.draft.scope, context: state.draft.context, input: state.draft.input,
    }).then(r => { closePanel(); return r; }),
    export: doExport,
    refresh: refreshState,
    goodSelector,
    fallbackSelector,
    pins: () => pinEls.length,
    openPin: id => {
      const annotation = state.config.annotations.find(a => a.id === id);
      if (!annotation) throw new Error('no annotation: ' + id);
      openPinPopup(annotation);
      return true;
    },
    resolve: (id, resolvedRating, asAnchor) =>
      api.post('resolve', { id, resolvedRating, asAnchor })
        .then(async r => { await refreshState(); renderPins(); return r; }),
    renderPins,
    reconcileOrphans,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
