/* SiteSlurp Review Mode overlay.
 *
 * Injected at serve time into pages hosted in review mode. Everything lives in
 * a closed shadow root so the host page's CSS can't touch it and ours can't
 * leak out. Talks to the app over same-origin HTTP (/__siteslurp__/review/).
 * The page being reviewed is arbitrary third-party markup — never trust it,
 * never modify it; we only read geometry and styles.
 */
(() => {
  'use strict';
  if (window.__ssBridgeLoaded) return;
  window.__ssBridgeLoaded = true;

  const API = '/__siteslurp__/review/';
  // Inside Studio Browser the window IS the viewport instrument — its presets
  // supersede the popup-size buttons, so those hide themselves there.
  const EMBEDDED = /SiteSlurpStudioBrowser/.test(navigator.userAgent);
  const state = {
    config: null,          // GET state payload
    annotating: true,      // select-mode toggle
    selected: [],          // [Element]
    region: null,          // {x,y,w,h} page coords
    draft: null,           // open panel context
    hoverEl: null,
    dragStart: null,
    childTrail: [],        // elements left behind by ArrowUp, for ArrowDown
    lastSaved: null,       // {scope, context, input} of the last saved note
    pinCycle: -1,          // index for [ / ] pin cycling
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
  // Same scheme as the Studio window: near-black surfaces, gray type, white for
  // the live thing. Shadow DOM keeps all of it off the page being reviewed.
  // Everything drawn *over* the page (highlights, pins) pairs white with a dark
  // ring, because a white hairline alone disappears on a white site.
  const ACCENT = '#FFFFFF';
  const WASH = 'rgba(255,255,255,0.14)';
  const RING = '0 0 0 1px rgba(0,0,0,0.85)';
  const INK = '#0A0A0B';
  const SURFACE = '#111113';
  const RAISED = '#18181B';
  const LINE = 'rgba(255,255,255,0.14)';
  const GRAY = '#A8A8B0';
  const DIM = '#78787F';

  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
    .hl { position: fixed; pointer-events: none; z-index: 2147483600;
          border: 1.5px solid ${ACCENT}; background: ${WASH}; border-radius: 2px; display: none;
          box-shadow: ${RING}, inset ${RING}; }
    .hl-tag { position: fixed; pointer-events: none; z-index: 2147483601; background: ${INK}; color: ${ACCENT};
          font-size: 11px; padding: 2px 7px; border-radius: 4px; display: none; white-space: nowrap; font-family: Consolas, monospace; }
    .sel { position: fixed; pointer-events: none; z-index: 2147483599;
          border: 2px solid ${ACCENT}; border-radius: 2px; background: rgba(255,255,255,0.10);
          box-shadow: ${RING}, inset ${RING}; }
    .rgn { position: absolute; pointer-events: none; z-index: 2147483599;
          border: 1.5px dashed ${ACCENT}; background: rgba(255,255,255,0.10); box-shadow: ${RING}; }
    .bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2147483646;
          display: flex; gap: 4px; align-items: center; background: rgba(10,10,11,0.93); color: ${GRAY};
          border: 1px solid ${LINE};
          padding: 8px 10px; border-radius: 14px; box-shadow: 0 14px 44px rgba(0,0,0,0.55);
          font-size: 12.5px; backdrop-filter: blur(14px) saturate(140%); }
    .bar .brand { color: ${ACCENT}; font-weight: 700; margin: 0 6px 0 2px; letter-spacing: -.02em; }
    .bar button { background: none; border: none; color: ${GRAY}; font-size: 12.5px; padding: 6px 9px;
          border-radius: 8px; cursor: pointer; }
    .bar button:hover { background: rgba(255,255,255,0.09); color: #fff; }
    .bar button.on { background: ${ACCENT}; color: ${INK}; font-weight: 600; }
    .bar .sep { width: 1px; height: 18px; background: ${LINE}; margin: 0 3px; }
    .bar .count { color: ${DIM}; padding: 0 6px; font-family: Consolas, monospace; }
    .panel { position: fixed; z-index: 2147483647; width: 330px; background: ${SURFACE}; color: ${GRAY};
          border: 1px solid ${LINE};
          border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.6); padding: 14px; }
    .panel h3 { margin: 0 0 2px; font-size: 13px; font-weight: 600; color: #fff; letter-spacing: -.02em; }
    .panel .sel-label { font-family: Consolas, monospace; font-size: 11px; color: ${DIM};
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 10px; }
    .row { display: flex; gap: 4px; margin: 6px 0; flex-wrap: wrap; }
    .rate { flex: 1; min-width: 24px; height: 26px; border: 1px solid ${LINE}; background: ${RAISED}; color: ${GRAY};
          border-radius: 6px; font-size: 11.5px; cursor: pointer; padding: 0; }
    .rate:hover { border-color: rgba(255,255,255,0.3); color: #fff; }
    .rate.on { background: #fff; color: ${INK}; border-color: #fff; font-weight: 600; }
    .chip { border: 1px solid ${LINE}; background: ${RAISED}; color: ${GRAY}; border-radius: 999px; font-size: 11.5px;
          padding: 4px 10px; cursor: pointer; }
    .chip:hover { border-color: rgba(255,255,255,0.3); color: #fff; }
    .chip.on { background: #fff; color: ${INK}; border-color: #fff; font-weight: 600; }
    /* Severity used to be told apart from a plain selected chip by hue. With one
       color left, the ring does that job instead. */
    .chip.sev-on { background: ${ACCENT}; color: ${INK}; border-color: ${ACCENT}; font-weight: 700;
          box-shadow: 0 0 0 2px rgba(255,255,255,0.22); }
    textarea { width: 100%; border: 1px solid ${LINE}; border-radius: 8px; padding: 7px 9px; font-size: 12.5px;
          background: ${RAISED}; color: #fff; resize: vertical; min-height: 44px; margin-top: 2px; }
    textarea::placeholder { color: #55555E; }
    textarea:focus { outline: 2px solid ${ACCENT}; outline-offset: 1px; border-color: transparent; }
    .lbl { font-size: 11px; font-weight: 600; color: ${DIM}; margin-top: 8px; display: flex; justify-content: space-between; align-items: center; }
    .mic { border: none; background: none; cursor: pointer; font-size: 13px; padding: 0 4px; }
    .mic.rec { color: ${ACCENT}; }
    .actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .save { background: ${ACCENT}; color: ${INK}; border: none; border-radius: 999px; padding: 8px 18px;
          font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .save:hover:not(:disabled) { background: #DEDEE3; }
    .save:disabled { opacity: .38; cursor: default; }
    .ghost { background: none; border: none; color: ${DIM}; font-size: 12.5px; cursor: pointer; padding: 8px 6px; }
    .ghost:hover { color: #fff; }
    .err { color: #FF5A4E; font-size: 11.5px; margin-top: 8px; display: none; }
    .toast { position: fixed; left: 50%; bottom: 74px; transform: translateX(-50%); z-index: 2147483647;
          background: ${RAISED}; color: ${GRAY}; border: 1px solid ${LINE}; font-size: 12.5px; padding: 10px 16px; border-radius: 12px;
          display: flex; gap: 12px; align-items: center; box-shadow: 0 14px 44px rgba(0,0,0,0.5); }
    .toast button { background: none; border: none; color: ${ACCENT}; font-weight: 600; cursor: pointer; font-size: 12.5px; }
    .modal { position: fixed; inset: 0; z-index: 2147483647; background: rgba(4,4,6,0.68);
          backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center; }
    .modal-card { width: 360px; max-height: 70vh; overflow: auto; background: ${SURFACE}; border: 1px solid ${LINE};
          border-radius: 16px; padding: 16px; color: ${GRAY}; box-shadow: 0 30px 80px rgba(0,0,0,0.62); }
    .modal-card h3 { margin: 0 0 10px; font-size: 14px; color: #fff; font-weight: 600; letter-spacing: -.02em; }
    .proj { display: block; width: 100%; text-align: left; padding: 9px 10px; border: 1px solid ${LINE};
          background: ${RAISED}; color: #fff; border-radius: 8px; margin-bottom: 6px; cursor: pointer; font-size: 13px; }
    .proj:hover { border-color: ${ACCENT}; }
    .proj .kind { color: ${DIM}; font-size: 11px; margin-left: 6px; }
    .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646; background: ${ACCENT}; color: ${INK};
          font-size: 13px; font-weight: 600; text-align: center; padding: 9px; }
    .pin { position: fixed; z-index: 2147483645; width: 21px; height: 21px; border-radius: 50%;
          background: ${ACCENT}; color: ${INK}; font-size: 10.5px; font-weight: 700; border: 2px solid ${INK};
          box-shadow: 0 2px 10px rgba(0,0,0,0.5); cursor: pointer; padding: 0; line-height: 17px; text-align: center; }
    .pin.resolved { background: #3A3A43; color: ${GRAY}; }
    /* Grayscale stays grayscale: a stale pin (element changed since noted)
       goes dashed instead of colored. */
    .pin.stale { border-style: dashed; }
    .ba-row { display: flex; gap: 6px; margin-top: 8px; }
    .ba-row figure { margin: 0; flex: 1; min-width: 0; }
    .ba-row img { display: block; width: 100%; border-radius: 6px; border: 1px solid ${LINE}; }
    .ba-row figcaption { font-size: 10px; color: ${DIM}; margin-top: 3px; text-align: center; }
    .pin-flag { display: flex; gap: 8px; align-items: center; justify-content: space-between;
          font-size: 12px; color: ${GRAY}; border: 1px dashed ${LINE}; border-radius: 8px;
          padding: 6px 8px; margin-top: 8px; }
    .pin-why { font-size: 12.5px; margin: 8px 0 0; color: #fff; }
    .pin-want { font-size: 12.5px; margin: 4px 0 0; color: ${DIM}; }
    .pin-res { font-size: 12.5px; font-weight: 600; color: ${ACCENT}; margin: 8px 0 0; }
    .anchor-row { display: flex; gap: 7px; align-items: center; font-size: 12px; margin-top: 10px; cursor: pointer; }
    .anchor-row input[type="checkbox"] { accent-color: ${ACCENT}; }
    .orphan-row { display: flex; justify-content: space-between; gap: 8px; align-items: center;
          padding: 8px 0; border-bottom: 1px solid ${LINE}; font-size: 12.5px; }
    .crumbs { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 8px; }
    .crumb { border: 1px solid ${LINE}; background: none; color: ${DIM}; border-radius: 5px;
          font-size: 10.5px; padding: 2px 6px; cursor: pointer; font-family: Consolas, monospace; }
    .crumb:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
    .crumb.here { background: ${RAISED}; color: #fff; cursor: default; }
    .ref-img { display: block; max-width: 100%; max-height: 140px; border-radius: 8px;
          border: 1px solid ${LINE}; margin-top: 8px; }
    .cheat { position: fixed; z-index: 2147483647; right: 18px; bottom: 64px; width: 280px;
          background: ${SURFACE}; color: ${GRAY}; border: 1px solid ${LINE}; border-radius: 14px;
          box-shadow: 0 24px 70px rgba(0,0,0,0.6); padding: 14px; font-size: 12px; }
    .cheat h3 { margin: 0 0 8px; font-size: 12.5px; color: #fff; }
    .cheat .k { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; }
    .cheat kbd { background: ${RAISED}; border: 1px solid ${LINE}; border-radius: 4px;
          padding: 1px 6px; font-family: Consolas, monospace; font-size: 10.5px; color: #fff; }
    .check-item { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; padding: 4px 0; cursor: pointer; }
    .check-item input[type="checkbox"] { accent-color: ${ACCENT}; margin-top: 2px; flex: none; }
    select.picker { width: 100%; background: ${RAISED}; color: #fff; border: 1px solid ${LINE};
          border-radius: 8px; padding: 6px 8px; font-size: 12px; margin-top: 4px; }
    .imgtool { position: fixed; z-index: 2147483644; right: 18px; top: 18px; display: flex; gap: 8px;
          align-items: center; background: rgba(10,10,11,0.93); color: ${GRAY}; border: 1px solid ${LINE};
          padding: 8px 12px; border-radius: 12px; font-size: 12px; box-shadow: 0 14px 44px rgba(0,0,0,0.5); }
    .imgtool input[type="range"] { width: 110px; accent-color: ${ACCENT}; }
    .imgtool .grip { cursor: move; user-select: none; padding: 2px 6px; border: 1px solid ${LINE};
          border-radius: 6px; }
    .imgtool button { background: none; border: none; color: ${GRAY}; cursor: pointer; font-size: 12px; padding: 2px 6px; }
    .imgtool button:hover { color: #fff; }
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
    state.childTrail = [];
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

  /** Short readable tag for a breadcrumb chip. */
  const crumbLabel = node => node.tagName.toLowerCase()
    + (node.id && /^[a-zA-Z][\w-]*$/.test(node.id) ? '#' + node.id
      : semanticClasses(node).slice(0, 1).map(c => '.' + c).join(''));

  /**
   * @param {string} scope
   * @param {object} context
   * @param {{annotation?: object}} [opts] pass a saved annotation to edit it in
   *   place — same panel, pre-filled, saving through the update endpoint.
   */
  function openPanel(scope, context, opts = {}) {
    if (panel) panel.remove();
    const editing = opts.annotation || null;
    state.draft = {
      scope,
      context,
      input: editing
        ? {
          rating: editing.input.rating, severity: editing.input.severity,
          axes: editing.input.axes.slice(), why: editing.input.why, want: editing.input.want,
        }
        : { rating: null, severity: 'should-fix', axes: [], why: '', want: '' },
      annotationId: editing ? editing.id : null,
      editing: !!editing,
    };
    panel = el('div', 'panel');

    const titles = { element: 'Annotate element', region: 'Annotate region', page: 'Page note', global: 'Site-wide note' };
    panel.appendChild(el('h3', '', editing ? 'Edit annotation' : (titles[scope] || 'Annotate')));

    // Ancestor breadcrumb: where this element sits, each chip clickable to
    // re-aim the note one level up or back down.
    if (!editing && scope === 'element' && state.selected.length === 1) {
      const chain = [];
      for (let node = state.selected[0]; node && node !== document.body; node = node.parentElement) chain.unshift(node);
      const crumbs = el('div', 'crumbs');
      for (const node of chain.slice(-6)) {
        const chip = el('button', 'crumb' + (node === state.selected[0] ? ' here' : ''), crumbLabel(node));
        if (node !== state.selected[0]) {
          chip.addEventListener('click', () => {
            state.childTrail = [];
            state.selected = [node];
            redrawSelection();
            openPanel('element', captureContext(state.selected, null));
          });
        }
        crumbs.appendChild(chip);
      }
      panel.appendChild(crumbs);
    }
    if (context.selector) panel.appendChild(el('div', 'sel-label', context.selector));

    // rating 1–10, one tap
    panel.appendChild(el('div', 'lbl', 'Rating (optional — needs a reason)'));
    const rateRow = el('div', 'row');
    for (let i = 1; i <= 10; i++) {
      const b = el('button', 'rate' + (state.draft.input.rating === i ? ' on' : ''), String(i));
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
      const b = el('button', 'chip' + (sev === state.draft.input.severity ? ' sev-on' : ''), sev);
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
      const b = el('button', 'chip' + (state.draft.input.axes.includes(axis) ? ' on' : ''), axis);
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
    why.value = state.draft.input.why;
    why.addEventListener('input', () => { state.draft.input.why = why.value; refreshSave(); });
    panel.appendChild(why);
    wireVoice(mic, why, () => { state.draft.input.why = why.value; refreshSave(); });

    panel.appendChild(el('div', 'lbl', 'What I want'));
    const want = document.createElement('textarea');
    want.placeholder = 'The direction — what should it become?';
    want.value = state.draft.input.want;
    want.addEventListener('input', () => { state.draft.input.want = want.value; });
    panel.appendChild(want);

    // Site-wide notes can pull from a built-in checklist: every ticked prompt
    // saves as its own global note, so exports treat them like typed feedback.
    let collectTicked = () => [];
    if (scope === 'global' && state.config && Array.isArray(state.config.checklists) && state.config.checklists.length) {
      panel.appendChild(el('div', 'lbl', 'Checklist (optional)'));
      const picker = document.createElement('select');
      picker.className = 'picker';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'No checklist';
      picker.appendChild(none);
      for (const list of state.config.checklists) {
        const option = document.createElement('option');
        option.value = list.id;
        option.textContent = list.name;
        picker.appendChild(option);
      }
      const itemsBox = el('div', '');
      picker.addEventListener('change', () => {
        itemsBox.innerHTML = '';
        const list = state.config.checklists.find(c => c.id === picker.value);
        if (!list) return;
        for (const item of list.items) {
          const row = el('label', 'check-item');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.text = `[${list.name}] ${item}`;
          row.appendChild(box);
          row.appendChild(el('span', '', item));
          itemsBox.appendChild(row);
        }
      });
      panel.appendChild(picker);
      panel.appendChild(itemsBox);
      collectTicked = () => [...itemsBox.querySelectorAll('input:checked')].map(box => box.dataset.text);
    }

    const err = el('div', 'err');
    panel.appendChild(err);

    const actions = el('div', 'actions');
    const save = el('button', 'save', editing ? 'Save changes' : 'Save');
    save.addEventListener('click', () => submit({}));
    actions.appendChild(save);
    if (scope === 'element' && !editing) {
      const ref = el('button', 'ghost', '+ reference…');
      ref.title = 'Save, then point at an element on another site in the library';
      ref.addEventListener('click', () => submit({ reference: true }));
      actions.appendChild(ref);
      const img = el('button', 'ghost', '+ image…');
      img.title = 'Save, then attach a reference image (a design, a screenshot of how it should look)';
      img.addEventListener('click', () => submit({ image: true }));
      actions.appendChild(img);
    }
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', closePanel);
    actions.appendChild(cancel);
    panel.appendChild(actions);

    function refreshSave() {
      const d = state.draft.input;
      // A pinned snapshot view is read-only: notes describe the live version.
      const pinnedView = !!(state.config && state.config.pinned);
      const blocked = d.rating !== null && d.why.trim().length < (state.config ? state.config.minWhy : 10);
      save.disabled = blocked || pinnedView;
      save.title = pinnedView ? 'Annotations target the live version — use "Back to live" first.' : '';
      err.style.display = (blocked || pinnedView) ? 'block' : 'none';
      err.textContent = pinnedView
        ? 'Viewing a snapshot — annotations target the live version.'
        : blocked ? 'A rating needs a reason — a number alone isn\'t actionable.' : '';
    }
    refreshSave();

    async function submit({ reference = false, image = false }) {
      try {
        const draft = state.draft;
        if (draft.editing) {
          await api.post('update', { id: draft.annotationId, patch: { input: draft.input } });
          await refreshState();
          renderPins();
          toast('Annotation updated');
          closePanel();
          return;
        }
        const ticked = collectTicked();
        const typed = draft.input.why.trim() || draft.input.want.trim() || draft.input.rating !== null;
        let annotation = null;
        if (typed || !ticked.length) {
          ({ annotation } = await api.post('annotate', {
            scope: draft.scope, context: draft.context, input: draft.input,
          }));
          draft.annotationId = annotation.id;
          state.lastSaved = { scope: draft.scope, context: draft.context, input: draft.input };
        }
        for (const text of ticked) {
          await api.post('annotate', {
            scope: 'global', context: draft.context,
            input: { severity: 'should-fix', why: text },
          });
        }
        await refreshState();
        if (reference && annotation) {
          openReferencePicker(annotation.id);
        } else if (image && annotation) {
          closePanel();
          attachImage(annotation.id);
        } else {
          toast(ticked.length
            ? `Saved — ${ticked.length} checklist note${ticked.length === 1 ? '' : 's'}${typed ? ' + your note' : ''}`
            : `Saved — ${countLabel()}`);
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

  /* ---------- reference image upload ---------- */
  // A file from disk, pushed through the same-origin API (2 MB cap server-side
  // and here). The page never sees the picker — it lives in the shadow root.
  function attachImage(annotationId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      if (file.size > 1.4 * 1024 * 1024) {
        toast('That image is over the 2 MB upload cap — resize it first.');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await api.post('image', { id: annotationId, dataUrl: reader.result });
          await refreshState();
          toast('Reference image attached — it exports with the annotation.');
        } catch (e) { toast(e.message); }
      };
      reader.readAsDataURL(file);
    });
    root.appendChild(input);
    input.click();
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
      const pin = el('button', 'pin' + (annotation.resolved ? ' resolved' : '')
        + (annotation.stale && !annotation.resolved ? ' stale' : ''),
        annotation.resolved ? '✓' : String(index + 1));
      pin.title = (annotation.input.why || '').slice(0, 120)
        + (annotation.stale && !annotation.resolved ? ' — changed since noted' : '');
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
      + (annotation.auto ? ' · auto' : '')
      + (annotation.input.rating ? ` · ${annotation.input.rating}/10` : '')
      + (annotation.input.axes.length ? ` · ${annotation.input.axes.join(', ')}` : '');
    pinPop.appendChild(el('h3', '', head));
    if (annotation.context.selector) pinPop.appendChild(el('div', 'sel-label', annotation.context.selector));
    if (annotation.stale && !annotation.resolved) {
      pinPop.appendChild(el('div', 'pin-flag',
        'This element changed visually since it was noted — re-check before fixing.'));
    }
    if (annotation.input.why) pinPop.appendChild(el('p', 'pin-why', annotation.input.why));
    if (annotation.input.want) pinPop.appendChild(el('p', 'pin-want', '→ ' + annotation.input.want));
    if (annotation.context.referenceImage) {
      const img = document.createElement('img');
      img.className = 'ref-img';
      img.alt = 'Reference image';
      img.src = API + 'image/' + encodeURIComponent(annotation.id);
      pinPop.appendChild(img);
    }

    const actions = el('div', 'actions');
    if (annotation.resolved) {
      pinPop.appendChild(el('p', 'pin-res', 'Resolved'
        + (annotation.resolvedRating && annotation.input.rating
          ? ` — ${annotation.input.rating} → ${annotation.resolvedRating}` : '')));
      if (annotation.resolvedNote) {
        pinPop.appendChild(el('p', 'pin-want', 'Fixer: ' + annotation.resolvedNote));
      }
      // The verification loop's receipts: the element as it was noted next to
      // the element after the resolve, with the pixel score.
      if (annotation.context.screenshotElement && annotation.context.screenshotAfterElement) {
        const row = el('div', 'ba-row');
        for (const [kind, label] of [['el', 'before'], ['after_el', 'after']]) {
          const fig = document.createElement('figure');
          const img = document.createElement('img');
          img.alt = label;
          img.src = API + 'image/' + encodeURIComponent(annotation.id) + '/' + kind;
          fig.appendChild(img);
          const caption = kind === 'after_el' && typeof annotation.diffScore === 'number' && annotation.diffScore > 0
            ? `after · ${Math.max(1, Math.round(annotation.diffScore * 100))}% changed`
            : label;
          fig.appendChild(el('figcaption', '', caption));
          row.appendChild(fig);
        }
        pinPop.appendChild(row);
      }
      if (annotation.diffScore === 0) {
        const flag = el('div', 'pin-flag', 'Resolved, but nothing changed visually — reopen?');
        const reopen = el('button', 'ghost', 'Reopen');
        reopen.addEventListener('click', async () => {
          await api.post('update', { id: annotation.id, patch: { resolved: false } }).catch(() => {});
          await refreshState();
          closePinPop();
          renderPins();
        });
        flag.appendChild(reopen);
        pinPop.appendChild(flag);
      }
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
    const edit = el('button', 'ghost', 'Edit');
    edit.title = 'Reopen this note pre-filled and change it';
    edit.addEventListener('click', () => {
      closePinPop();
      openPanel(annotation.scope, annotation.context, { annotation });
    });
    actions.appendChild(edit);
    const img = el('button', 'ghost', annotation.context.referenceImage ? 'Replace image…' : 'Attach image…');
    img.title = 'Attach a reference image (a design, how it should look)';
    img.addEventListener('click', () => { closePinPop(); attachImage(annotation.id); });
    actions.appendChild(img);
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

  function setAnnotating(on) {
    state.annotating = !!on;
    if (bar.isConnected) buildBar();
    hideHover();
    return state.annotating;
  }

  function buildBar() {
    bar.innerHTML = '';
    bar.appendChild(el('span', 'brand', 'Review'));
    bar.appendChild(el('span', '', state.config ? state.config.project.name : ''));
    bar.appendChild(el('span', 'sep'));

    const annotate = el('button', state.annotating ? 'on' : '', 'Annotate');
    annotate.title = 'Toggle element selection (browse the site normally when off) — A';
    annotate.addEventListener('click', () => setAnnotating(!state.annotating));
    bar.appendChild(annotate);

    const pageNote = el('button', '', 'Page note');
    pageNote.addEventListener('click', () => openPanel('page', captureContext([], null)));
    bar.appendChild(pageNote);
    const siteNote = el('button', '', 'Site note');
    siteNote.title = 'A site-wide note — checklists live here too';
    siteNote.addEventListener('click', () => openPanel('global', captureContext([], null)));
    bar.appendChild(siteNote);

    const imgTool = el('button', imageTool.active ? 'on' : '', 'Overlay');
    imgTool.title = 'Lay a reference image over the page at adjustable opacity';
    imgTool.addEventListener('click', () => (imageTool.active ? imageTool.close() : imageTool.open()));
    bar.appendChild(imgTool);

    // Popup-size buttons only outside Studio Browser — its viewport presets
    // do this job properly (they resize the view, not a popup).
    if (!EMBEDDED) {
      bar.appendChild(el('span', 'sep'));
      for (const [label, w, h] of [['375', 375, 812], ['768', 768, 1024], ['1440', 1440, 900]]) {
        const b = el('button', '', label);
        b.title = `Open this page at ${w}px to annotate that breakpoint`;
        b.addEventListener('click', () => window.open(location.href, '_blank',
          `width=${w},height=${h},noopener`));
        bar.appendChild(b);
      }
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

    const auditBtn = el('button', '', 'Audits');
    auditBtn.title = 'Run automated checks — accessibility (axe) and broken links become [auto] pins';
    auditBtn.addEventListener('click', async () => {
      auditBtn.disabled = true;
      toast('Auditing — accessibility scan + link crawl…');
      try {
        const s = await api.post('audit');
        await refreshState();
        renderPins();
        toast(`Audits done — ${s.axeViolations} accessibility, ${s.brokenLinks} broken link${s.brokenLinks === 1 ? '' : 's'}`
          + (s.added ? `, ${s.added} new pin${s.added === 1 ? '' : 's'}` : ', nothing new'));
      } catch (e) { toast(e.message); } finally { auditBtn.disabled = false; }
    });
    bar.appendChild(auditBtn);

    const exportBtn = el('button', '', 'Export');
    exportBtn.title = 'Write REVIEW.md + annotations.json + shots for an agent — E';
    exportBtn.addEventListener('click', doExport);
    bar.appendChild(exportBtn);

    const done = el('button', '', 'Done');
    done.title = 'Leave review mode';
    done.addEventListener('click', async () => {
      await api.post('done').catch(() => {});
      location.reload();
    });
    bar.appendChild(done);

    const cheat = el('button', '', '?');
    cheat.title = 'Keyboard shortcuts';
    cheat.addEventListener('click', toggleCheatsheet);
    bar.appendChild(cheat);
  }

  /* ---------- keyboard cheatsheet ---------- */
  let cheatEl = null;
  function toggleCheatsheet() {
    if (cheatEl) { cheatEl.remove(); cheatEl = null; return; }
    cheatEl = el('div', 'cheat');
    cheatEl.appendChild(el('h3', '', 'Keyboard'));
    const rows = [
      ['A', 'Toggle annotate mode'],
      ['E', 'Export the review'],
      ['[ and ]', 'Cycle through the pins'],
      ['Esc', 'Close the panel / clear selection'],
      ['↑', 'Select the parent element'],
      ['↓', 'Back into the child you came from'],
      ['Shift+click', 'Add to the selection'],
      ['Drag', 'Annotate a region'],
      ['?', 'This cheatsheet'],
    ];
    for (const [key, what] of rows) {
      const row = el('div', 'k');
      row.appendChild(el('span', '', what));
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      row.appendChild(kbd);
      cheatEl.appendChild(row);
    }
    root.appendChild(cheatEl);
  }

  /* ---------- page-level reference image overlay ----------
   * A design comp at 0–100% opacity over the live page. pointer-events: none
   * throughout — it is a lens, never a layer you can click. Nothing persists;
   * it lives and dies with the tab. */
  const imageTool = {
    active: false,
    wrap: null,
    panel: null,
    offset: { x: 0, y: 0 },
    open() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => this.show(reader.result);
        reader.readAsDataURL(file);
      });
      root.appendChild(input);
      input.click();
    },
    show(dataUrl) {
      this.close();
      this.active = true;
      this.offset = { x: 0, y: 0 };
      this.wrap = el('div', '');
      Object.assign(this.wrap.style, {
        position: 'fixed', inset: '0', zIndex: '2147483590', pointerEvents: 'none',
        overflow: 'hidden',
      });
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = '';
      Object.assign(img.style, {
        position: 'absolute', left: '0', top: '0', opacity: '0.5',
        width: '100%', height: 'auto', pointerEvents: 'none',
      });
      this.wrap.appendChild(img);
      root.appendChild(this.wrap);

      this.panel = el('div', 'imgtool');
      this.panel.appendChild(el('span', '', 'Overlay'));
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = '50';
      slider.title = 'Opacity';
      slider.addEventListener('input', () => { img.style.opacity = String(slider.value / 100); });
      this.panel.appendChild(slider);
      const fit = el('button', '', '1:1');
      fit.title = 'Toggle between fit-to-width and the image\'s own size';
      fit.addEventListener('click', () => {
        const natural = img.style.width !== '100%';
        img.style.width = natural ? '100%' : 'auto';
        fit.textContent = natural ? '1:1' : 'fit';
      });
      this.panel.appendChild(fit);
      const grip = el('span', 'grip', 'move');
      grip.title = 'Drag to move the image';
      grip.addEventListener('mousedown', down => {
        down.preventDefault();
        const start = { x: down.clientX - this.offset.x, y: down.clientY - this.offset.y };
        const move = e => {
          this.offset = { x: e.clientX - start.x, y: e.clientY - start.y };
          img.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px)`;
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      this.panel.appendChild(grip);
      const close = el('button', '', '✕');
      close.title = 'Remove the overlay image';
      close.addEventListener('click', () => this.close());
      this.panel.appendChild(close);
      root.appendChild(this.panel);
      if (bar.isConnected) buildBar();
    },
    close() {
      if (this.wrap) { this.wrap.remove(); this.wrap = null; }
      if (this.panel) { this.panel.remove(); this.panel = null; }
      this.active = false;
      if (bar.isConnected) buildBar();
    },
  };

  /* ---------- pin cycling ([ and ]) ---------- */
  function cyclePins(step) {
    const list = annotationsForPage().filter(a => locate(a) || a.context.boundingBox);
    if (!list.length) { toast('No pins on this page yet.'); return; }
    state.pinCycle = ((state.pinCycle + step) % list.length + list.length) % list.length;
    const annotation = list[state.pinCycle];
    const target = locate(annotation);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    openPinPopup(annotation);
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
    state.childTrail = []; // a fresh click starts a fresh ladder
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

  /** True when the key press belongs to a field the user is typing in —
   *  ours in the shadow root or the page's own. */
  function typingIn(event) {
    const target = (event.composedPath ? event.composedPath()[0] : event.target) || null;
    if (!target || !target.tagName) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!target.isContentEditable;
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (cheatEl) { toggleCheatsheet(); return; }
      if (panel) closePanel();
      else clearSelection();
      hideHover();
      return;
    }
    const typing = typingIn(event);

    // Element ladder: ArrowUp climbs to the parent, ArrowDown steps back into
    // the child it came from — the trail remembers the way down.
    if (event.key === 'ArrowUp' && !typing && state.selected.length === 1 && panel) {
      const parent = state.selected[0].parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        event.preventDefault();
        state.childTrail.push(state.selected[0]);
        state.selected = [parent];
        redrawSelection();
        openPanel('element', captureContext(state.selected, null));
      }
      return;
    }
    if (event.key === 'ArrowDown' && !typing && state.selected.length === 1 && panel) {
      const child = state.childTrail.pop();
      if (child && child.isConnected && state.selected[0].contains(child)) {
        event.preventDefault();
        state.selected = [child];
        redrawSelection();
        openPanel('element', captureContext(state.selected, null));
      }
      return;
    }

    if (typing || event.ctrlKey || event.metaKey || event.altKey || panel) return;
    switch (event.key) {
      case 'a': case 'A':
        event.preventDefault();
        setAnnotating(!state.annotating);
        break;
      case 'e': case 'E':
        event.preventDefault();
        doExport();
        break;
      case '[':
        event.preventDefault();
        cyclePins(-1);
        break;
      case ']':
        event.preventDefault();
        cyclePins(1);
        break;
      case '?':
        event.preventDefault();
        toggleCheatsheet();
        break;
      default:
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

  // The official embed API. Studio Browser's chrome drives the overlay through
  // it (annotate toggle, Copy for agent), and the acceptance tests script it.
  // Formerly a debug-only surface — same shape, now a contract.
  window.__ssBridge = {
    state,
    api,
    embedded: EMBEDDED,
    /** Turn element selection on or off; returns the resulting state. */
    setAnnotating,
    isAnnotating: () => state.annotating,
    /** What "Copy for agent" needs: the open draft, else the live selection,
     *  else the last note saved this page-load. Null when there is nothing. */
    agentContext: () => {
      if (state.draft) {
        return { scope: state.draft.scope, context: state.draft.context, input: state.draft.input };
      }
      if (state.selected.length) {
        return { scope: 'element', context: captureContext(state.selected, null), input: null };
      }
      return state.lastSaved;
    },
    select: selector => {
      const target = document.querySelector(selector);
      if (!target) throw new Error('no element: ' + selector);
      state.childTrail = [];
      state.selected = [target];
      redrawSelection();
      openPanel('element', captureContext(state.selected, null));
      return true;
    },
    openScope: scope => openPanel(scope, captureContext([], null)),
    setInput: fields => { Object.assign(state.draft.input, fields); return state.draft.input; },
    save: () => api.post('annotate', {
      scope: state.draft.scope, context: state.draft.context, input: state.draft.input,
    }).then(r => {
      state.lastSaved = { scope: state.draft.scope, context: state.draft.context, input: state.draft.input };
      closePanel();
      return r;
    }),
    editAnnotation: id => {
      const annotation = state.config.annotations.find(a => a.id === id);
      if (!annotation) throw new Error('no annotation: ' + id);
      openPanel(annotation.scope, annotation.context, { annotation });
      return true;
    },
    export: doExport,
    refresh: refreshState,
    goodSelector,
    fallbackSelector,
    pins: () => pinEls.length,
    cyclePins,
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
