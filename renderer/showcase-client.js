// renderer/showcase-client.js — the ShowCase in-page engine, injected into every
// page the presentation view lands on (executeJavaScript from lib/showcase.js).
//
// Three jobs, all of which have to happen *inside* the page:
//
//   1. Make the page presentable. A capture that lost its scripts — or a live
//      site whose scroll-reveal library only fires on a hand-scroll — leaves
//      content sitting at opacity 0. `prepare()` finds those leftovers and
//      reveals them as the camera reaches them, wakes muted videos, forces lazy
//      images, drops cookie bars and chat bubbles, and switches scroll-snap off
//      so the glide owns the pace.
//   2. Read the page. `analyze()` reports what a director can build a story
//      from: how far it scrolls, where its sections start (and what each is
//      called), the navigation, the primary buttons, card grids, the biggest
//      picture in each section, and — for pages that don't scroll at all —
//      whatever responds to a pointer.
//   3. Move. Glides, holds, and the ghost cursor are promises the director
//      awaits, gated by pause and cut short by abort(). The progress line,
//      the lower-third caption and the spotlight live here too.
//
// It never decides what happens next — the director in the main process does —
// and it never navigates on its own. Everything sits under one shadow-DOM host
// so the site's CSS can't touch it, and one global (__nsShowcase). Injected
// once per document. In `mirror` mode (the phone half of the Duo frame) it
// keeps only job 1 and a scroll-follower.
(() => {
  'use strict';
  if (window.__nsShowcase) return;

  const cfg = {
    speed: 90, dwell: 2.5, pageDwell: 4,
    cursor: 'ghost', progress: true, captions: true, brand: 'NightShyft Studio',
    tidy: true, reveal: true, media: true,
    mirror: false,
  };

  const st = {
    playing: true,       // the gate: motion waits while false
    userPaused: false,
    scroller: null,
    y: 0,
    busy: false,         // a primitive is running
    aborted: false,      // set by abort(); the running primitive winds up
    gen: 0,              // bumps per primitive so an aborted one can't outlive its successor
    label: '',
    cursorAnim: null,
    mouse: { x: -100, y: -100 },
    refs: [],            // elements handed to the director by index
    revealed: 0,
    follow: null,        // mirror: target fraction
  };

  /* ---------- chrome ---------- */

  const host = document.createElement('ns-showcase');
  host.setAttribute('data-slurp-ui', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
<style>
  :host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
  .bar { position: absolute; left: 0; top: 0; height: 3px; width: 0; background: #fff; mix-blend-mode: difference; transition: width .25s linear; opacity: 0; }
  .bar.on { opacity: 1; }
  .cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
            background: rgba(255,255,255,.92); box-shadow: 0 0 0 4px rgba(255,255,255,.22), 0 0 28px rgba(255,255,255,.55), 0 2px 8px rgba(0,0,0,.45);
            transform: translate(-100px,-100px); opacity: 0; transition: opacity .3s; will-change: transform; }
  .cursor.on { opacity: 1; }
  .cursor::after { content: ""; position: absolute; inset: 9px; border-radius: 50%; background: #0A0A0B; }
  .cursor.press { animation: press .45s ease-out; }
  @keyframes press { 0% { box-shadow: 0 0 0 4px rgba(255,255,255,.22), 0 0 28px rgba(255,255,255,.55); }
                     40% { box-shadow: 0 0 0 18px rgba(255,255,255,.28), 0 0 40px rgba(255,255,255,.8); }
                     100% { box-shadow: 0 0 0 4px rgba(255,255,255,.22), 0 0 28px rgba(255,255,255,.55); } }
  .spot { position: absolute; inset: 0; opacity: 0; transition: opacity .35s;
          background: radial-gradient(circle var(--r, 190px) at var(--x, 50%) var(--y, 50%), rgba(0,0,0,0) 0, rgba(0,0,0,0) 62%, rgba(0,0,0,.72) 100%); }
  .spot.on { opacity: 1; }
  .cap { position: absolute; left: 34px; bottom: 34px; display: flex; flex-direction: column; gap: 3px; padding: 12px 18px 13px;
         background: rgba(10,10,11,.86); color: #fff; border: 1px solid rgba(255,255,255,.14); border-radius: 14px;
         -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); box-shadow: 0 14px 44px rgba(0,0,0,.5);
         transform: translateY(14px); opacity: 0; transition: transform .45s cubic-bezier(.22,.9,.28,1), opacity .45s; max-width: 46vw; }
  .cap.on { transform: none; opacity: 1; }
  .cap b { font-size: 17px; font-weight: 600; letter-spacing: -.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cap span { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: #A8A8B0; font-weight: 500; }
  .paused { position: absolute; right: 30px; top: 26px; padding: 7px 13px; border-radius: 999px; font-size: 12px; font-weight: 600;
            color: #0A0A0B; background: #fff; letter-spacing: -.01em; opacity: 0; transform: translateY(-6px); transition: opacity .25s, transform .25s; }
  .paused.on { opacity: 1; transform: none; }
  .paused i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #0A0A0B; margin-right: 7px; vertical-align: 0; opacity: .7; }
</style>
<div class="spot"></div>
<div class="bar"></div>
<div class="cap"><span></span><b></b></div>
<div class="paused"><i></i>Paused</div>
<div class="cursor"></div>`;
  const $ = sel => shadow.querySelector(sel);
  const bar = $('.bar');
  const cursor = $('.cursor');
  const spot = $('.spot');
  const cap = $('.cap');
  const paused = $('.paused');

  // The page's own cursor never shows in a presentation; ours does (or nothing).
  const style = document.createElement('style');
  style.setAttribute('data-slurp-ui', '');
  style.textContent = `
    html, html * { cursor: none !important; }
    /* A projector doesn't need a scrollbar; the progress line says where we are. */
    html, body, * { scrollbar-width: none !important; }
    ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    /* Other in-page tools (the site menu, live-reload badges) stay out of the show. */
    [data-slurp-ui]:not(ns-showcase) { display: none !important; }
    html { scroll-behavior: auto !important; }
    /* Content the show revealed comes in the way its author meant it to. */
    [data-ns-reveal] { transition: opacity .9s cubic-bezier(.22,.9,.28,1), transform .9s cubic-bezier(.22,.9,.28,1) !important; }
    [data-ns-reveal="on"] { opacity: 1 !important; transform: none !important; visibility: visible !important; clip-path: none !important; }
    [data-ns-hide] { display: none !important; }`;

  const mount = () => {
    const root = document.documentElement;
    if (!host.isConnected) root.appendChild(host);
    if (!style.isConnected) (document.head || root).appendChild(style);
  };
  mount();
  // Frameworks that replace <html> children on hydrate would drop us; come back.
  new MutationObserver(() => { if (!host.isConnected || !style.isConnected) mount(); })
    .observe(document.documentElement, { childList: true });

  const ours = el => el === host || host.contains(el);
  const cls = el => (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '');
  const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

  /* ---------- scrolling ---------- */

  /** The element that actually scrolls: the document normally, else the
   *  biggest overflow box on the page (app shells that lock <body>). */
  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight - doc.clientHeight > 40) return doc;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (ours(el)) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (el.scrollHeight - el.clientHeight < 80) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best || doc;
  }

  const isDoc = el => el === document.scrollingElement || el === document.documentElement || el === document.body;
  const viewportH = () => (isDoc(st.scroller) ? window.innerHeight : st.scroller.clientHeight);
  const maxY = () => Math.max(0, st.scroller.scrollHeight - viewportH());
  const currentY = () => (isDoc(st.scroller) ? (window.scrollY || st.scroller.scrollTop) : st.scroller.scrollTop);
  function scrollTo(y) {
    if (isDoc(st.scroller)) window.scrollTo(0, y);
    else st.scroller.scrollTop = y;
  }
  /** Document y of an element's top (in the scroller's coordinates). */
  function pageTop(el) {
    const r = el.getBoundingClientRect();
    const base = isDoc(st.scroller) ? 0 : st.scroller.getBoundingClientRect().top;
    return r.top - base + currentY();
  }

  function updateBar() {
    const max = maxY();
    const p = max > 0 ? Math.min(1, currentY() / max) : 0;
    bar.style.width = (p * 100).toFixed(2) + '%';
  }

  /* ---------- prepare: make the page presentable ---------- */

  const HINT_RE = /(^|[\s_-])(reveal|aos|sal|fade|animate|anim|wow|inview|in-view|appear|slide|scroll|motion|enter|show-on|lazy)([\s_-]|$)/i;
  const KEEP_HIDDEN_RE = /(menu|modal|popup|pop-up|overlay|drawer|dropdown|tooltip|lightbox|preloader|loader|loading|cursor|toast|backdrop|offcanvas|off-canvas|sidebar|search|dialog|hover|poster|placeholder|skeleton)/i;
  const OVERLAY_RE = /(cookie|consent|gdpr|privacy notice|accept all|we use cookies)/i;
  const WIDGET_RE = /(intercom|crisp|tawk|drift|hubspot|tidio|zendesk|zopim|livechat|messenger|chat-widget|chatwidget|gorgias|freshchat|olark|smartsupp|whatsapp)/i;

  const translated = tr => {
    const m = /matrix\(([^)]+)\)/.exec(tr || '');
    if (!m) return /matrix3d/.test(tr || '');
    const [a, , , d, tx, ty] = m[1].split(',').map(Number);
    return Math.abs(tx) > 1 || Math.abs(ty) > 1 || Math.abs(a - 1) > 0.02 || Math.abs(d - 1) > 0.02;
  };

  /** Elements a scroll-reveal library left at opacity 0 (or hidden with a
   *  slide-in translate) — the things a capture without its scripts, or a
   *  page the camera moves through faster than its observer fires, never
   *  shows. Menus, modals, posters and the like are hidden on purpose and
   *  stay so. */
  function revealCandidates() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (ours(el) || out.length >= 400) continue;
      if (el.closest('[aria-hidden="true"], [hidden], dialog, template')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const op = parseFloat(cs.opacity);
      const hiddenVis = cs.visibility === 'hidden';
      if (op >= 0.05 && !hiddenVis) continue;
      if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      const names = cls(el) + ' ' + el.id;
      if (KEEP_HIDDEN_RE.test(names)) continue;
      if (el.matches('video, audio, canvas, iframe, input, textarea, select, script, style, noscript')) continue;
      const hinted = HINT_RE.test(names) || [...el.attributes].some(a => /^data-(aos|sal|scroll|reveal|animate|animation|framer|motion|inview|w-id)/i.test(a.name));
      const moved = translated(cs.transform);
      // An opacity-0 element with a slide transform is a reveal in waiting; one
      // without needs a name that says so — plain opacity:0 can mean anything.
      if (hiddenVis && !hinted) continue;
      if (!hinted && !moved) continue;
      // Reveal the outermost hidden box; its children come with it.
      let dup = false;
      for (const p of out) if (p.contains(el)) { dup = true; break; }
      if (dup || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  let revealObserver = null;
  function armReveal() {
    if (!cfg.reveal) return 0;
    const els = revealCandidates();
    if (revealObserver) revealObserver.disconnect();
    if (!els.length) return 0;
    let order = 0;
    revealObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        revealObserver.unobserve(el);
        // Siblings arriving together stagger in, like the library would.
        const delay = Math.min(360, (order++ % 6) * 70);
        setTimeout(() => { el.setAttribute('data-ns-reveal', 'on'); st.revealed++; }, delay);
        setTimeout(() => { order = Math.max(0, order - 1); }, 700);
      }
    }, { root: isDoc(st.scroller) ? null : st.scroller, threshold: 0.08, rootMargin: '0px 0px -8% 0px' });
    for (const el of els) {
      el.setAttribute('data-ns-reveal', '');
      revealObserver.observe(el);
    }
    return els.length;
  }

  /** Cookie bars, chat bubbles, and a modal parked over the page. */
  function tidy() {
    if (!cfg.tidy) return 0;
    let n = 0;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const hide = el => { if (!el.hasAttribute('data-ns-hide')) { el.setAttribute('data-ns-hide', ''); n++; } };
    for (const el of document.querySelectorAll('body *')) {
      if (ours(el)) continue;
      const names = cls(el) + ' ' + el.id + ' ' + (el.getAttribute('aria-label') || '');
      if (WIDGET_RE.test(names) && (el.matches('iframe, [class*="widget" i], [id*="widget" i], [class*="launcher" i], [id*="launcher" i]') || getComputedStyle(el).position === 'fixed')) { hide(el); continue; }
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || parseFloat(cs.opacity) < 0.05 || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 40) continue;
      const t = text(el).slice(0, 400);
      const banner = OVERLAY_RE.test(t) && r.height < vh * 0.5 && /accept|agree|got it|ok|allow|decline|settings|preferences/i.test(t);
      if (banner) { hide(el); continue; }
      // A modal or newsletter pop-up covering most of the page after load.
      const covers = r.width > vw * 0.5 && r.height > vh * 0.5;
      const modalish = /(modal|popup|pop-up|dialog|newsletter|subscribe|overlay)/i.test(names) || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
      if (covers && modalish && !/(header|nav|hero|menu)/i.test(names) && el.querySelector('button, [role="button"], a') && text(el).length < 1200) {
        hide(el);
        for (const lock of [document.documentElement, document.body]) {
          if (/hidden/.test(getComputedStyle(lock).overflowY) && lock.scrollHeight > vh + 200) lock.style.setProperty('overflow', 'auto', 'important');
        }
      }
    }
    return n;
  }

  let mediaObserver = null;
  /** Videos play (muted, looping) while on screen; lazy images load now. */
  function wakeMedia() {
    if (!cfg.media) return 0;
    let n = 0;
    for (const img of document.querySelectorAll('img[loading="lazy"]')) { img.loading = 'eager'; n++; }
    for (const img of document.querySelectorAll('img[data-src]:not([src]), img[data-lazy-src]:not([src]), img[data-original]:not([src])')) {
      img.src = img.dataset.src || img.dataset.lazySrc || img.dataset.original; n++;
    }
    for (const img of document.querySelectorAll('img[data-srcset]:not([srcset])')) { img.srcset = img.dataset.srcset; n++; }
    if (mediaObserver) mediaObserver.disconnect();
    mediaObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        const v = e.target;
        if (e.isIntersecting) {
          v.muted = true;
          v.defaultMuted = true;
          v.playsInline = true;
          v.loop = true;
          if (v.preload === 'none') v.preload = 'auto';
          if (v.paused) v.play().catch(() => {});
        } else if (!v.paused && !v.hasAttribute('data-ns-keep')) {
          v.pause();
        }
      }
    }, { threshold: 0.15 });
    for (const v of document.querySelectorAll('video')) { mediaObserver.observe(v); n++; }
    return n;
  }

  function unsnap() {
    for (const el of [document.documentElement, document.body, st.scroller]) {
      if (el && /(mandatory|proximity)/.test(getComputedStyle(el).scrollSnapType)) el.style.setProperty('scroll-snap-type', 'none', 'important');
    }
  }

  function prepare() {
    st.scroller = findScroller();
    unsnap();
    const hidden = tidy();
    const media = wakeMedia();
    const reveal = armReveal();
    // Lazy sections appear as the page settles; look again shortly.
    setTimeout(() => { if (!st.aborted) { tidy(); armReveal(); } }, 1200);
    return { hidden, media, reveal };
  }

  /* ---------- analyze: what a story can be made from ---------- */

  const ref = el => { let i = st.refs.indexOf(el); if (i < 0) { i = st.refs.push(el) - 1; } return i; };
  const headingOf = el => {
    const h = el.matches('h1, h2, h3') ? el : el.querySelector('h1, h2, h3');
    const t = h ? text(h) : (el.getAttribute('aria-label') || '');
    return t.slice(0, 60);
  };

  /** Section starts down the page — where a reader's eye would pause — each
   *  with its heading, its biggest picture and any card grid inside it.
   *  Markup can't be trusted for this (a Tailwind page is divs all the way
   *  down), so the page is read by shape: descend from <body> through the
   *  wrappers until a container holds several tall blocks stacked down the
   *  page — those are the sections, whatever they're called. */
  function blocks() {
    const vh = viewportH();
    const root = isDoc(st.scroller) ? document.body : st.scroller;
    const out = [];
    const height = el => el.getBoundingClientRect().height;
    const kidsOf = el => [...el.children].filter(k => {
      if (ours(k) || k.matches('script, style, link, template, noscript')) return false;
      const cs = getComputedStyle(k);
      if (cs.display === 'none' || cs.position === 'fixed') return false;
      const r = k.getBoundingClientRect();
      return r.height >= 60 && r.width >= 200;
    });
    // Stacked = each child starts where the one before it ended; side by
    // side (columns, a masonry) is a grid, and a grid's items are read as
    // one section's cards, not as sections of their own.
    const stacked = kids => {
      const tops = kids.map(k => k.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      for (let i = 1; i < tops.length; i++) if (tops[i].top < tops[i - 1].bottom - 40) return false;
      return true;
    };
    const walk = (el, depth, grid) => {
      const kids = kidsOf(el);
      const tall = kids.filter(k => height(k) >= vh * 0.3);
      if (depth < 9 && tall.length >= 2) {
        const inGrid = grid || !stacked(kids);
        for (const k of kids) {
          if (height(k) > vh * 2.2 && k.children.length >= 1) walk(k, depth + 1, inGrid);
          else out.push({ el: k, grid: inGrid });
        }
        return;
      }
      if (depth < 9 && tall.length === 1 && height(tall[0]) > height(el) * 0.75 && kids.length <= 4) {
        for (const k of kids) if (k !== tall[0]) out.push({ el: k, grid: !!grid });
        walk(tall[0], depth + 1, grid);
        return;
      }
      out.push({ el, grid: !!grid });
    };
    walk(root, 0, false);
    return out;
  }

  function sections() {
    const vh = viewportH();
    const max = maxY();
    let found = blocks().map(({ el, grid }) => ({ el, grid, y: Math.round(pageTop(el) - vh * 0.12), h: el.getBoundingClientRect().height }));
    if (found.length < 2) {
      // A page with no shape to read: fall back to what it calls its parts.
      found = [];
      for (const el of document.querySelectorAll('section, article, main > *, h1, h2, [id], footer')) {
        if (ours(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if ((r.height < 120 && !/^H[12]$/.test(el.tagName)) || r.width < 200) continue;
        found.push({ el, y: Math.round(pageTop(el) - vh * 0.12), h: r.height });
      }
    }
    found = found.filter(s => s.y > vh * 0.4 && s.y < max - 40).map(s => ({ ...s, y: Math.max(0, Math.min(max, s.y)) }));
    found.sort((a, b) => a.y - b.y);
    // Two stops within a third of a screen read as one (keep the bigger
    // box); items of a grid are worth a stop only every screen or so.
    const spaced = [];
    for (const s of found) {
      const last = spaced[spaced.length - 1];
      const gap = s.grid && last && last.grid ? vh * 1.2 : vh / 3;
      if (last && s.y - last.y <= gap) { if (s.h > last.h && !s.grid) spaced[spaced.length - 1] = s; continue; }
      spaced.push(s);
    }
    const stops = spaced.map(s => ({
      y: s.y,
      h: s.h,
      label: headingOf(s.el),
      key: keyElementIn(s.el, vh),
      cards: cardsIn(s.el),
    }));
    // A block taller than two screens that wouldn't split (a sticky-stacked
    // list, a long masonry) still gets a pause every screen and a half, so
    // no stretch of the page rolls by unread.
    const withChecks = [];
    for (const [i, s] of stops.entries()) {
      withChecks.push(s);
      const until = Math.min(s.y + s.h - vh * 0.8, (stops[i + 1] ? stops[i + 1].y : max) - vh * 0.5, max);
      for (let y = s.y + vh * 1.6; s.h > vh * 2.2 && y < until; y += vh * 1.6) {
        withChecks.push({ y: Math.round(y), h: 0, label: '', key: null, cards: [] });
      }
    }
    return withChecks.slice(0, 40).map(({ y, label, key, cards }) => ({ y, label, key, cards }));
  }

  /** The picture worth pushing into: the biggest image, video or figure in
   *  the box that isn't the whole box. */
  function keyElementIn(box, vh) {
    let best = null;
    let bestArea = 0;
    for (const el of box.querySelectorAll('img, video, picture, figure, canvas, svg, [class*="card" i], [class*="image" i], [class*="media" i], [class*="screenshot" i], [class*="mockup" i]')) {
      if (ours(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 160 || r.height < 110 || r.height > vh * 1.4) continue;
      if (getComputedStyle(el).display === 'none') continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best ? ref(best) : null;
  }

  /** Three or more siblings the same size in a row — a card grid to sweep. */
  function cardsIn(box) {
    const parents = new Set();
    for (const el of box.querySelectorAll('*')) {
      if (ours(el) || !el.parentElement) continue;
      if (el.children.length === 0) continue;
      parents.add(el.parentElement);
      if (parents.size > 200) break;
    }
    let best = [];
    for (const parent of parents) {
      const kids = [...parent.children].filter(k => !ours(k) && k.getBoundingClientRect().width >= 140 && k.getBoundingClientRect().height >= 100);
      if (kids.length < 3) continue;
      const w = kids[0].getBoundingClientRect().width;
      const same = kids.filter(k => Math.abs(k.getBoundingClientRect().width - w) < w * 0.12);
      if (same.length >= 3 && same.length > best.length) best = same;
    }
    return best.slice(0, 8).map(ref);
  }

  /** Visible links in the site's top navigation, left to right. */
  function navItems() {
    const out = [];
    const seen = new Set();
    const vh = window.innerHeight;
    for (const a of document.querySelectorAll('header a[href], nav a[href], [role="navigation"] a[href], [class*="nav" i] a[href], [class*="menu" i] a[href]')) {
      if (ours(a)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 20 || r.height < 12 || r.top < 0 || r.bottom > vh * 0.25) continue;
      if (getComputedStyle(a).visibility === 'hidden' || parseFloat(getComputedStyle(a).opacity) < 0.05) continue;
      const t = text(a).slice(0, 30) || (a.getAttribute('aria-label') || '').slice(0, 30);
      if (!t || seen.has(t.toLowerCase())) continue;
      if (a.querySelector('img, svg') && t.length < 3) continue;   // the logo
      seen.add(t.toLowerCase());
      out.push({ ref: ref(a), label: t, href: a.href, x: r.left });
    }
    out.sort((a, b) => a.x - b.x);
    return out.slice(0, 8).map(({ ref: r, label, href }) => ({ ref: r, label, href }));
  }

  /** The buttons above the fold, biggest first. */
  function buttons(navRefs) {
    const out = [];
    const vh = window.innerHeight;
    const navSet = new Set(navRefs.map(n => st.refs[n.ref]));
    for (const el of document.querySelectorAll('a[href], button, [role="button"]')) {
      if (ours(el) || navSet.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 70 || r.width > 480 || r.height < 30 || r.height > 96) continue;
      if (r.top < 0 || pageTop(el) > vh * 1.6) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
      const t = text(el);
      if (!t || t.split(' ').length > 5 || t.length > 32) continue;
      const styled = (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') || parseFloat(cs.borderTopWidth) > 0 || /(btn|button|cta)/i.test(cls(el));
      if (!styled) continue;
      out.push({ ref: ref(el), label: t.slice(0, 32), area: r.width * r.height, y: r.top });
    }
    out.sort((a, b) => (b.area - a.area) || (a.y - b.y));
    return out.slice(0, 3).map(({ ref: r, label }) => ({ ref: r, label }));
  }

  /** Whatever answers a pointer on a page that doesn't scroll. */
  function interactive() {
    const out = [];
    const seen = new Set();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    for (const el of document.querySelectorAll('a, button, [role="button"], [onclick], [tabindex], [class*="tag" i], [class*="item" i], [class*="card" i], [data-hover], [data-cursor]')) {
      if (ours(el) || el.closest('nav, header')) continue;
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer' && !el.matches('a[href], button, [role="button"]')) continue;
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
      const key = Math.round(r.left / 40) + ':' + Math.round(r.top / 40);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: ref(el), label: (text(el) || el.getAttribute('aria-label') || '').slice(0, 30), y: r.top, x: r.left });
    }
    out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return out.slice(0, 8).map(({ ref: r, label }) => ({ ref: r, label }));
  }

  function analyze() {
    st.refs = [];
    st.scroller = findScroller();
    const vh = viewportH();
    const max = maxY();
    const nav = navItems();
    const hero = keyElementIn(document.body, vh);
    const heroRect = hero !== null ? st.refs[hero].getBoundingClientRect() : null;
    return {
      title: document.title || '',
      height: st.scroller.scrollHeight,
      vh,
      max,
      scrolls: max > vh * 0.35,
      sections: sections(),
      nav,
      buttons: buttons(nav),
      hero: heroRect && heroRect.top < vh ? hero : null,
      interactive: interactive(),
      textLength: (document.body.textContent || '').length,   // innerText would lay out the whole page
      images: document.images.length,
      videos: document.querySelectorAll('video').length,
    };
  }

  /* ---------- motion primitives ---------- */

  const nextFrame = () => new Promise(r => requestAnimationFrame(r));
  const settle = ms => new Promise(r => setTimeout(r, ms));

  /** Wait out a pause; true when the caller should carry on, false when cut. */
  async function gate(cut) {
    while (!st.playing && !cut()) await settle(80);
    return !cut();
  }

  /** Run one primitive. It gets a `cut()` to poll: true once abort() was
   *  called or a newer primitive started, so a superseded glide stops
   *  scrolling instead of fighting the next one. */
  function run(fn) {
    const gen = ++st.gen;
    st.busy = true;
    st.aborted = false;
    const cut = () => st.aborted || st.gen !== gen;
    return Promise.resolve().then(() => fn(cut)).then(
      result => { if (st.gen === gen) st.busy = false; return { ok: true, aborted: cut(), ...(result || {}) }; },
      err => { if (st.gen === gen) st.busy = false; return { ok: false, error: String(err && err.message || err) }; },
    );
  }

  /** Ease down (or up) the page to `target`, at cfg.speed px/s with a soft
   *  start and a soft landing; `boost` multiplies the pace for a flyover. */
  function glideTo(target, { boost = 1, label = '', maxMs = 0 } = {}) {
    return run(async cut => {
      const max = maxY();
      const to = Math.max(0, Math.min(max, Number(target) || 0));
      st.y = currentY();
      const dir = to >= st.y ? 1 : -1;
      let startedAt = performance.now();
      let last = startedAt;
      const deadline = maxMs > 0 ? startedAt + maxMs : Infinity;
      while (!cut() && performance.now() < deadline) {
        if (!st.playing) { if (!(await gate(cut))) break; last = startedAt = performance.now(); st.y = currentY(); }
        const now = await nextFrame();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const y = currentY();
        // Someone else (the site itself, a hash jump) moved the page: follow it.
        if (Math.abs(y - st.y) > 4) st.y = y;
        const ahead = Math.abs(to - st.y);
        if (ahead < 0.5) break;
        const since = (now - startedAt) / 1000;
        const easeIn = Math.min(1, 0.15 + since / 0.9);
        const easeOut = Math.min(1, 0.12 + ahead / 220);
        const step = cfg.speed * boost * easeIn * easeOut * dt;
        st.y = dir > 0 ? Math.min(to, st.y + step) : Math.max(to, st.y - step);
        scrollTo(st.y);
        updateBar();
        if (dir > 0 && currentY() >= maxY() - 0.5) break;
      }
      updateBar();
      if (label && !cut()) caption(label);
      return { y: Math.round(currentY()) };
    });
  }

  /** Stay put for `ms` (pause stretches it). */
  function hold(ms) {
    return run(async cut => {
      let left = Math.max(0, Number(ms) || 0);
      let last = performance.now();
      while (!cut() && left > 0) {
        if (!st.playing) { if (!(await gate(cut))) break; last = performance.now(); continue; }
        await settle(Math.min(120, left));
        const now = performance.now();
        left -= now - last;
        last = now;
      }
      return {};
    });
  }

  /** Where an element is on screen, brought there first if it isn't (a glide,
   *  not a jump, so the audience follows). Null when it's gone. */
  async function pointFor(r) {
    const el = st.refs[r];
    if (!el || !el.isConnected) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    let rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const vh = window.innerHeight;
    if (rect.top < vh * 0.08 || rect.bottom > vh * 0.95) {
      const want = pageTop(el) - Math.max(vh * 0.1, (vh - rect.height) / 2);
      await glideTo(want, { boost: 1.6 });
      await settle(120);
      rect = el.getBoundingClientRect();
    }
    return {
      x: Math.round(Math.max(2, Math.min(window.innerWidth - 2, rect.left + rect.width / 2))),
      y: Math.round(Math.max(2, Math.min(vh - 2, rect.top + rect.height / 2))),
      w: Math.round(rect.width), h: Math.round(rect.height),
      left: Math.round(rect.left), top: Math.round(rect.top),
    };
  }

  function abort() {
    st.aborted = true;
    st.follow = null;
    return true;
  }

  /** Back to the top with a glide. */
  function restart() {
    return glideTo(0, { boost: 4 });
  }

  // A hand on the wheel means the presenter is taking over.
  const takeOver = () => { if (st.playing && !cfg.mirror) { st.playing = false; st.userPaused = true; paused.classList.add('on'); } };
  window.addEventListener('wheel', takeOver, { passive: true, capture: true });
  window.addEventListener('touchmove', takeOver, { passive: true, capture: true });

  function play() {
    st.playing = true;
    st.userPaused = false;
    paused.classList.remove('on');
    return true;
  }
  function pause() {
    st.playing = false;
    paused.classList.add('on');
    return true;
  }

  /* ---------- mirror (the phone half of a Duo frame) ---------- */

  let followRaf = 0;
  function follow(fraction) {
    st.follow = Math.max(0, Math.min(1, Number(fraction) || 0));
    if (!followRaf) {
      const step = () => {
        followRaf = 0;
        if (st.follow === null) return;
        const target = st.follow * maxY();
        const y = currentY();
        const next = y + (target - y) * 0.12;
        if (Math.abs(target - y) > 0.5) { scrollTo(next); followRaf = requestAnimationFrame(step); }
      };
      followRaf = requestAnimationFrame(step);
    }
    return true;
  }

  /* ---------- cursor & spotlight ---------- */

  function placeCursor(x, y) {
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    spot.style.setProperty('--x', x + 'px');
    spot.style.setProperty('--y', y + 'px');
  }
  function applyCursor() {
    cursor.classList.toggle('on', cfg.cursor !== 'hidden' && !cfg.mirror);
    spot.classList.toggle('on', cfg.cursor === 'spotlight' && !cfg.mirror);
  }
  window.addEventListener('mousemove', e => {
    st.mouse = { x: e.clientX, y: e.clientY };
    if (!st.cursorAnim) placeCursor(e.clientX, e.clientY);
  }, { passive: true, capture: true });

  /** Glide the ghost cursor to a viewport point over `ms`. */
  function cursorTo(x, y, ms = 700) {
    const from = st.cursorAnim ? st.cursorAnim.at : st.mouse;
    const start = from && from.x > -50 ? from : { x: window.innerWidth * 0.5, y: window.innerHeight * 0.6 };
    const t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    return new Promise(resolve => {
      const anim = { at: { ...start } };
      st.cursorAnim = anim;
      const tween = now => {
        const t = Math.min(1, (now - t0) / ms);
        const k = ease(t);
        // A slight arc so it reads as a hand, not a robot.
        const bow = Math.sin(t * Math.PI) * Math.min(40, Math.hypot(x - start.x, y - start.y) * 0.08);
        anim.at = { x: start.x + (x - start.x) * k, y: start.y + (y - start.y) * k - bow };
        placeCursor(anim.at.x, anim.at.y);
        if (t < 1 && st.cursorAnim === anim) requestAnimationFrame(tween);
        else { if (st.cursorAnim === anim) st.cursorAnim = null; resolve(true); }
      };
      requestAnimationFrame(tween);
    });
  }
  function cursorPress() {
    cursor.classList.remove('press');
    void cursor.offsetWidth;
    cursor.classList.add('press');
    return true;
  }
  function cursorAway() {
    return cursorTo(window.innerWidth * 0.5, window.innerHeight * 0.62, 500);
  }

  /* ---------- links (page hops) ---------- */

  const sameDoc = (a, b) => {
    try {
      const u = new URL(a, location.href);
      const v = new URL(b, location.href);
      return u.origin === v.origin && u.pathname.replace(/\/+$/, '') === v.pathname.replace(/\/+$/, '') && u.search === v.search;
    } catch { return false; }
  };

  /** Every link on the page, with whether it sits in the site's navigation. */
  function navTargets() {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (out.length >= 300) break;
      if (ours(a)) continue;
      const href = a.getAttribute('href') || '';
      if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      out.push({
        href: a.href,
        text: (a.getAttribute('aria-label') || a.textContent || a.title || '').trim().slice(0, 80),
        inNav: !!a.closest('nav, header, [role="navigation"], [class*="nav" i], [id*="nav" i], [class*="menu" i]'),
      });
    }
    return out;
  }

  /** A hamburger, when the nav is folded away (the phone frame). */
  async function openMenu() {
    const btn = [...document.querySelectorAll('button, [role="button"], a, [class*="burger" i], [class*="toggle" i]')].find(el => {
      if (ours(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20 || r.top > 160) return false;
      const names = cls(el) + ' ' + el.id + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-controls') || '');
      return /(burger|hamburger|menu|nav-toggle|navbar-toggle|open-nav|toggle)/i.test(names) && el.getAttribute('aria-expanded') !== 'true';
    });
    if (!btn) return false;
    btn.click();
    await settle(650);
    return true;
  }

  /** The on-screen centre of the link to any of `hrefs` (the hosted address
   *  and, for a capture, the original one its markup still carries). Brought
   *  on screen first; a folded menu is opened for it. */
  async function targetFor(hrefs) {
    const wanted = Array.isArray(hrefs) ? hrefs : [hrefs];
    const find = () => [...document.querySelectorAll('a[href]')].filter(a => !ours(a) && wanted.some(h => sameDoc(a.href, h)));
    let anchors = find();
    if (!anchors.length) return null;
    const visible = a => {
      const r = a.getBoundingClientRect();
      const cs = getComputedStyle(a);
      return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
    };
    if (!anchors.some(visible) && await openMenu()) anchors = find();
    const inNav = anchors.find(a => visible(a) && a.closest('nav, header, [role="navigation"]'));
    const el = inNav || anchors.find(visible) || anchors[0];
    let r = el.getBoundingClientRect();
    const off = r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth;
    if (off) {
      await glideTo(pageTop(el) - window.innerHeight * 0.4, { boost: 2.5 });
      // Wait for the link to stop moving before reporting where it is.
      let lastTop = null;
      for (let i = 0; i < 20; i++) {
        await settle(100);
        const top = el.getBoundingClientRect().top;
        if (lastTop !== null && Math.abs(top - lastTop) < 0.5 && i > 1) break;
        lastTop = top;
      }
      r = el.getBoundingClientRect();
    }
    if (r.width < 1 || r.height < 1) return null;
    const x = Math.round(Math.max(2, Math.min(window.innerWidth - 2, r.left + r.width / 2)));
    const y = Math.round(Math.max(2, Math.min(window.innerHeight - 2, r.top + r.height / 2)));
    return { x, y, href: el.href };
  }

  /** Last-resort click without the devtools protocol. */
  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const a = el && (el.closest ? el.closest('a[href]') : null);
    (a || el || document.body).click();
    return true;
  }

  /* ---------- caption ---------- */

  let capTimer = 0;
  function caption(label, eyebrow) {
    if (!cfg.captions || !label || cfg.mirror) return false;
    $('.cap span').textContent = eyebrow || cfg.brand;
    $('.cap b').textContent = label;
    cap.classList.add('on');
    clearTimeout(capTimer);
    capTimer = setTimeout(() => cap.classList.remove('on'), 3400);
    return true;
  }

  /* ---------- director API ---------- */

  function configure(next) {
    Object.assign(cfg, next || {});
    bar.classList.toggle('on', !!cfg.progress && !cfg.mirror);
    applyCursor();
    return true;
  }

  /** A page is up: make it presentable, start from the top, say its name. */
  function begin({ playing = true, label = '' } = {}) {
    st.aborted = false;
    st.busy = false;
    const fixed = prepare();
    scrollTo(0);
    st.y = 0;
    st.label = label;
    if (!cfg.mirror) caption(label || document.title);
    if (playing) play(); else pause();
    updateBar();
    return fixed;
  }

  function state() {
    const max = maxY();
    return {
      y: Math.round(currentY()),
      max: Math.round(max),
      progress: max > 0 ? Math.min(1, currentY() / max) : 0,
      playing: st.playing,
      userPaused: st.userPaused,
      busy: st.busy,
      title: document.title || '',
      revealed: st.revealed,
    };
  }

  /** What the reader saw and how long each part took — for tuning. */
  function debug() {
    st.refs = [];
    st.scroller = findScroller();
    const t = {};
    const time = (name, fn) => { const t0 = performance.now(); const v = fn(); t[name] = Math.round(performance.now() - t0); return v; };
    const bl = time('blocks', blocks);
    const out = {
      blocks: bl.map(({ el, grid }) => ({ tag: el.tagName, cls: cls(el).slice(0, 40), y: Math.round(pageTop(el)), h: Math.round(el.getBoundingClientRect().height), grid })),
      sections: time('sections', sections).map(s => ({ y: s.y, label: s.label, key: s.key !== null, cards: s.cards.length })),
      nav: time('nav', navItems).map(n => n.label),
      buttons: time('buttons', () => buttons(navItems())).map(b => b.label),
      interactive: time('interactive', interactive).map(i => i.label),
      reveal: time('reveal', revealCandidates).length,
      elements: document.getElementsByTagName('*').length,
      ms: t,
    };
    return out;
  }

  window.__nsShowcase = {
    configure, begin, prepare, analyze, state, debug,
    play, pause, abort, restart,
    glideTo, hold, pointFor, follow,
    setSpeed: v => { cfg.speed = Math.max(10, Math.min(800, Number(v) || 90)); return cfg.speed; },
    setCursor: mode => { cfg.cursor = mode; applyCursor(); return true; },
    navTargets, targetFor, cursorTo, cursorPress, cursorAway, clickAt, caption,
  };

  st.scroller = findScroller();
  applyCursor();
})();
