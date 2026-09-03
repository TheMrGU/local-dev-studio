// renderer/grab-client.js — the asset dragger, injected into hosted pages at
// serve time.
//
// Two ways in: hold Alt for a quick grab, or flip "Asset dragger" on in the
// SiteSlurp menu (bottom-right) to keep it armed. Whatever is under the cursor
// becomes draggable. Media elements drop their file's real path on disk (a
// terminal or AI CLI can open it directly); anything else drops the path of a
// grab bundle — HTML + matching CSS + asset locations — that the app writes
// the moment the drag starts. Alt+Shift forces the bundle even on an image.
// Alt+scroll walks up and back down the ancestor chain to pick a bigger or
// smaller piece.
//
// The config line is prepended by lib/grab.js when the script is served:
// self.__SLURP_GRAB__ = { root, sep, grabs, api, mapped }.
(() => {
  'use strict';
  if (window.__slurpGrab) return;
  const CFG = self.__SLURP_GRAB__ || {};

  const MIME = {
    webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    glb: 'model/gltf-binary', woff2: 'font/woff2', woff: 'font/woff', pdf: 'application/pdf',
  };

  /* ---------- URL → disk ---------- */

  // Mirrors the static server's resolution, so the path names the exact file
  // the browser fetched. Behind a dev-server proxy (mapped: false) there is no
  // such mapping and everything grabs as a bundle instead.
  function localPath(pathname) {
    if (!CFG.mapped || !CFG.root) return null;
    let decoded;
    try { decoded = decodeURIComponent(pathname.split(/[?#]/)[0]); } catch { return null; }
    const segs = decoded.split('/').filter(Boolean);
    if (!segs.length || segs.some(s => s === '.' || s === '..')) return null;
    return CFG.root + CFG.sep + segs.join(CFG.sep);
  }

  const filename = url => {
    const segs = url.pathname.split('/').filter(Boolean);
    try { return decodeURIComponent(segs[segs.length - 1] || 'file'); } catch { return segs[segs.length - 1] || 'file'; }
  };

  /* ---------- what an element "is" ---------- */

  function assetOf(el) {
    const tag = el.tagName;
    let raw = null;
    if (tag === 'IMG') raw = el.currentSrc || el.src;
    else if (tag === 'PICTURE') { const img = el.querySelector('img'); raw = img ? (img.currentSrc || img.src) : null; }
    else if (tag === 'VIDEO' || tag === 'AUDIO') raw = el.currentSrc || el.src || (el.querySelector('source[src]') || {}).src;
    else if (tag === 'SOURCE') raw = el.src;
    else if (tag === 'OBJECT') raw = el.data;
    else if (tag === 'EMBED') raw = el.src;
    else {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg !== 'none' && /url\((['"]?)(.*?)\1\)/.exec(bg);
      if (m) raw = m[2];
    }
    if (!raw || /^data:|^blob:/i.test(raw)) return null;
    let url;
    try { url = new URL(raw, location.href); } catch { return null; }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  }

  const describe = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + el.classList[0];
    return s;
  };

  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.tagName === node.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      if (parts.length > 7) break;
    }
    return parts.join(' > ');
  }

  /* ---------- CSS that touches the element ---------- */

  // Interaction and pseudo-element suffixes never match a resting DOM node, so
  // they're stripped for the match test only — the rule text keeps them.
  const PSEUDO = /::?(hover|focus|focus-within|focus-visible|active|visited|checked|disabled|placeholder-shown|before|after|selection|first-line|first-letter|marker|placeholder)\b(\([^)]*\))?/g;
  const escapeReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function matchedCss(root) {
    const scope = [root, ...root.querySelectorAll('*')].slice(0, 400);
    // :root/html/body rules come along too — that's where the design tokens,
    // base font and variables a component leans on are defined.
    const context = [document.documentElement, document.body].filter(Boolean);
    const out = [];
    const keyframes = [];
    const fontFaces = [];

    const matchesScope = selector => {
      const bare = selector.replace(PSEUDO, '').trim() || '*';
      const test = el => { try { return el.matches(bare); } catch { return false; } };
      return scope.some(test) || context.some(test);
    };

    const walk = (rules, wrap) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.STYLE_RULE) {
          if (String(rule.selectorText).split(',').some(matchesScope)) {
            out.push(wrap ? `${wrap} {\n${rule.cssText}\n}` : rule.cssText);
          }
        } else if (rule.type === CSSRule.MEDIA_RULE) {
          walk(rule.cssRules, wrap || `@media ${rule.conditionText}`);
        } else if (rule.type === CSSRule.SUPPORTS_RULE) {
          walk(rule.cssRules, wrap || `@supports ${rule.conditionText}`);
        } else if (rule.type === CSSRule.KEYFRAMES_RULE) {
          keyframes.push(rule);
        } else if (rule.type === CSSRule.FONT_FACE_RULE) {
          fontFaces.push(rule);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
      walk(rules, '');
    }

    let css = out.join('\n\n');
    for (const rule of keyframes) {
      if (new RegExp(`\\b${escapeReg(rule.name)}\\b`).test(css)) css += '\n\n' + rule.cssText;
    }
    for (const rule of fontFaces) {
      const fam = /font-family:\s*([^;}]+)/.exec(rule.cssText);
      if (fam && css.includes(fam[1].replace(/['"]/g, '').trim())) css += '\n\n' + rule.cssText;
    }
    const inline = root.getAttribute && root.getAttribute('style');
    if (inline) css = `/* inline style attribute on the element itself */\n${describe(root)} { ${inline} }\n\n` + css;
    return css;
  }

  function collectAssets(root) {
    const nodes = [root, ...root.querySelectorAll('*')].slice(0, 400);
    const seen = new Set();
    for (const el of nodes) {
      const raws = [];
      const tag = el.tagName;
      if (tag === 'IMG') raws.push(el.currentSrc || el.src);
      else if (tag === 'SOURCE' || tag === 'AUDIO' || tag === 'EMBED') raws.push(el.src);
      else if (tag === 'VIDEO') raws.push(el.currentSrc || el.src, el.poster);
      else if (tag === 'OBJECT') raws.push(el.data);
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') for (const m of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) raws.push(m[2]);
      for (const raw of raws) {
        if (!raw || /^data:|^blob:/i.test(raw)) continue;
        try { seen.add(new URL(raw, location.href).href); } catch { /* not a URL */ }
      }
      if (seen.size >= 60) break;
    }
    return [...seen];
  }

  /* ---------- payloads ---------- */

  const slugFor = el => {
    const base = describe(el).replace(/[^a-z0-9_-]+/gi, '-').replace(/^[-_]+/, '').slice(0, 50) || 'el';
    return `${base}-${Date.now().toString(36)}`;
  };

  const post = body => {
    try {
      return fetch(CFG.api + 'save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json()).catch(() => null);
    } catch { return null; }
  };

  // What lands in the drop target. Order matters on Windows: Chromium's URL
  // format also writes a plain-text representation, so text/plain has to be the
  // LAST format set or dropping into a terminal pastes the localhost URL
  // instead of the path — the exact bug this file exists to prevent.
  function doGrab(el, forceBundle) {
    const asset = forceBundle ? null : assetOf(el);
    if (asset) {
      const local = asset.origin === location.origin ? localPath(asset.pathname) : null;
      const name = filename(asset);
      const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
      const data = {
        'text/html': el.outerHTML.slice(0, 500000),
        DownloadURL: `${MIME[(ext || '').toLowerCase()] || 'application/octet-stream'}:${name}:${asset.href}`,
      };
      // Only a remote asset (no file on disk) is allowed to drop as a URL.
      if (!local) data['text/uri-list'] = asset.href;
      data['text/plain'] = local || asset.href;
      return { folder: null, saved: null, label: name, data };
    }

    const slug = slugFor(el);
    const folder = CFG.grabs + CFG.sep + slug;
    const rect = el.getBoundingClientRect();
    const saved = post({
      slug,
      pageUrl: location.href,
      selector: cssPath(el),
      tag: describe(el),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      html: el.outerHTML.slice(0, 2000000),
      css: matchedCss(el).slice(0, 2000000),
      assets: collectAssets(el),
    });
    return {
      folder,
      saved,
      label: describe(el),
      data: {
        'text/html': el.outerHTML.slice(0, 500000),
        'text/plain': folder + CFG.sep + 'GRAB.md',
      },
    };
  }

  /* ---------- highlight ---------- */

  const host = document.createElement('div');
  host.setAttribute('data-slurp-ui', '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    #box { position: fixed; display: none; pointer-events: none;
           box-shadow: 0 0 0 1.5px #fff, 0 0 0 3px #111; border-radius: 2px; }
    #tip { position: fixed; display: none; pointer-events: none;
           font: 500 11px/1 system-ui, sans-serif; color: #fff; background: #111;
           padding: 5px 9px; border-radius: 999px; white-space: nowrap;
           box-shadow: 0 1px 4px rgba(0,0,0,.35); }
    #tip span { opacity: .55; font-weight: 400; }
    #note { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%) translateY(6px);
           display: none; opacity: 0; pointer-events: none;
           font: 500 12px/1 system-ui, sans-serif; color: #fff; background: rgba(10,10,11,.94);
           border: 1px solid rgba(255,255,255,.16); padding: 9px 14px; border-radius: 999px;
           box-shadow: 0 10px 30px rgba(0,0,0,.45);
           transition: opacity .18s ease, transform .18s ease; }
    #note.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  </style><div id="box"></div><div id="tip"></div><div id="note"></div>`;
  const box = shadow.getElementById('box');
  const tip = shadow.getElementById('tip');
  const note = shadow.getElementById('note');
  const mounted = () => { if (!host.isConnected) document.documentElement.appendChild(host); };

  let noteTimer = null;
  function flash(message) {
    mounted();
    note.textContent = message;
    note.style.display = 'block';
    requestAnimationFrame(() => note.classList.add('show'));
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note.classList.remove('show');
      setTimeout(() => { note.style.display = 'none'; }, 200);
    }, 2600);
  }

  function paint(el) {
    if (!el) { box.style.display = tip.style.display = 'none'; return; }
    mounted();
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    const asset = assetOf(el);
    tip.innerHTML = '';
    tip.append(asset ? filename(asset) : describe(el));
    const hint = document.createElement('span');
    hint.textContent = asset ? '  drag = file path · ⇧ bundle' : '  drag = GRAB.md bundle';
    tip.append(hint);
    tip.style.display = 'block';
    tip.style.left = Math.max(4, r.left) + 'px';
    tip.style.top = (r.top > 30 ? r.top - 26 : r.top + 4) + 'px';
  }

  /* ---------- mode state ---------- */

  let altHeld = false;
  let sticky = false;    // the menu's "Asset dragger" toggle — armed without Alt
  let hoverEl = null;
  let restore = null;    // { el, hadAttr, value, style }
  let lastGrab = null;   // the payload of the drag in flight
  const trail = [];      // children stepped out of via Alt+scroll
  const mouse = { x: 0, y: 0 };

  const engaged = () => altHeld || sticky;

  // The dragger must never grab SiteSlurp's own surfaces — the menu button,
  // the review toolbar — only the page.
  const ownUi = el => !!(el.closest && el.closest('[data-slurp-ui], #__ss-review-host'));

  function setHover(el) {
    if (el === hoverEl) { paint(el); return; }
    unsetHover();
    if (!el || el === host || ownUi(el)) return;
    hoverEl = el;
    restore = {
      el,
      hadAttr: el.hasAttribute('draggable'),
      value: el.getAttribute('draggable'),
      style: el.getAttribute('style'),
    };
    el.draggable = true;
    // Text selection and page-set user-drag rules both fight drag initiation.
    el.style.userSelect = 'none';
    el.style.webkitUserDrag = 'element';
    paint(el);
  }

  function unsetHover() {
    if (restore) {
      if (restore.hadAttr) restore.el.setAttribute('draggable', restore.value);
      else restore.el.removeAttribute('draggable');
      if (restore.style === null) restore.el.removeAttribute('style');
      else restore.el.setAttribute('style', restore.style);
    }
    restore = null;
    hoverEl = null;
    paint(null);
  }

  // Arming has to pick up whatever is already under the cursor: pressing Alt
  // without moving the mouse used to leave the native link-drag in charge,
  // which is how a drop pasted a localhost URL.
  function hoverUnderCursor() {
    const el = document.elementFromPoint(mouse.x, mouse.y);
    setHover(el instanceof Element ? el : null);
  }

  const disarm = () => { trail.length = 0; unsetHover(); };
  const arm = () => { hoverUnderCursor(); };

  function setSticky(on) {
    sticky = !!on;
    if (sticky) arm();
    else if (!altHeld) disarm();
    return sticky;
  }

  /* ---------- events ---------- */

  addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; }, { capture: true, passive: true });

  addEventListener('keydown', e => {
    if (e.key === 'Alt' && !e.repeat) { altHeld = true; arm(); }
  }, true);
  addEventListener('keyup', e => {
    if (e.key === 'Alt' && altHeld) {
      altHeld = false;
      if (!sticky) disarm(); else hoverUnderCursor();
      e.preventDefault(); // keep the browser menu unfocused
    }
  }, true);
  addEventListener('blur', () => { altHeld = false; if (!sticky) disarm(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { altHeld = false; if (!sticky) disarm(); } });

  addEventListener('mouseover', e => {
    if (!engaged()) return;
    trail.length = 0;
    setHover(e.target instanceof Element ? e.target : null);
  }, true);

  // The page's own mousedown handlers commonly preventDefault (buttons,
  // sliders, drag libraries) — which cancels drag initiation and made whole
  // classes of elements ungrabbable. While the dragger is engaged the page
  // doesn't get a say.
  addEventListener('mousedown', e => {
    if (!engaged() || !hoverEl || ownUi(e.target instanceof Element ? e.target : null)) return;
    e.stopImmediatePropagation();
  }, true);

  // A grab is not a click: links must not navigate, buttons must not fire.
  addEventListener('click', e => {
    if (!engaged() || ownUi(e.target instanceof Element ? e.target : null)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Alt+scroll widens the grab to the parent (and back down), instead of
  // scrolling the page — the same gesture inspectors use to pick containers.
  addEventListener('wheel', e => {
    if (!engaged() || !hoverEl) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      const parent = hoverEl.parentElement;
      if (parent && parent !== document.documentElement) { trail.push(hoverEl); setHover(parent); }
    } else if (trail.length) {
      setHover(trail.pop());
    }
  }, { capture: true, passive: false });

  ['scroll', 'resize'].forEach(type =>
    addEventListener(type, () => { if (engaged() && hoverEl) paint(hoverEl); }, { capture: true, passive: true }));

  addEventListener('dragstart', e => {
    if (!engaged() || !e.dataTransfer) return;
    // Arming and hovering can race a fast drag — fall back to the drag target.
    const el = hoverEl || (e.target instanceof Element ? e.target : null);
    if (!el || ownUi(el)) return;
    e.stopImmediatePropagation(); // the page's own drag handlers don't apply to a grab
    const grabbed = doGrab(el, e.shiftKey);
    lastGrab = grabbed;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.clearData();
    for (const [type, value] of Object.entries(grabbed.data)) e.dataTransfer.setData(type, value);
  }, true);

  addEventListener('dragend', () => {
    if (!lastGrab) return;
    const grabbed = lastGrab;
    lastGrab = null;
    if (!grabbed.folder) { flash(`Dropped ${grabbed.label} — file path`); return; }
    Promise.resolve(grabbed.saved).then(result => {
      flash(result && result.folder
        ? `Grab bundle saved — ${grabbed.label}`
        : 'Grab dropped — the bundle could not be written');
    });
  }, true);

  window.__slurpGrab = {
    cfg: CFG,
    arm, disarm, setSticky,
    sticky: () => sticky,
    grab: (el, bundle) => doGrab(el, !!bundle),
  };
  console.info('SiteSlurp asset dragger: hold Alt (or flip it on in the SiteSlurp menu) and drag any element. '
    + 'Media drops its local file path, anything else drops a GRAB.md bundle path; '
    + 'Alt+Shift forces a bundle, Alt+scroll widens the selection.');
})();
