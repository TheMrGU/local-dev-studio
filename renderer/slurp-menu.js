// renderer/slurp-menu.js — the Local Dev Studio menu, injected into every locally
// hosted page at serve time.
//
// One quiet button in the corner of a hosted site, wearing the Local Dev Studio mark.
// It opens a small mod menu where the in-page tools live as toggles: the asset
// dragger (drag any element or file off the page) and audit mode (annotate the
// page and export a spec). Everything renders in a shadow root so the page's
// CSS can't touch it; everything talks same-origin HTTP to the app's server.
// Never injected into pages leaving through a public share link.
//
// The config line is prepended by lib/menu.js when the script is served:
// self.__SLURP_MENU__ = { api, name, port, audit: { active, available, reason } }.
(() => {
  'use strict';
  if (window.__slurpMenu) return;
  if (window !== window.top) return; // one menu per tab, never inside iframes
  const CFG = self.__SLURP_MENU__ || {};
  const API = CFG.api || '/__siteslurp__/menu/';
  const DRAGGER_KEY = '__slurp_dragger_on';

  const state = {
    open: false,
    dragger: false,
    audit: !!(CFG.audit && CFG.audit.active),
    auditBusy: false,
  };

  const post = route => fetch(API + route, { method: 'POST' }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  });

  /* ---------- shadow UI ---------- */

  const host = document.createElement('div');
  host.setAttribute('data-slurp-ui', '');
  host.style.cssText = 'position:fixed;z-index:2147483645;right:0;bottom:0;';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }

    .fab { position: fixed; right: 18px; bottom: 18px; width: 48px; height: 48px;
           border-radius: 50%; border: 1px solid rgba(255,255,255,.22); background: #0A0A0B;
           display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); opacity: .55;
           transition: opacity .2s ease, transform .2s cubic-bezier(.2,.9,.3,1.4), border-color .2s ease; }
    .fab:hover, .fab.open { opacity: 1; transform: scale(1.06); border-color: rgba(255,255,255,.55); }
    .fab img { width: 30px; height: 30px; border-radius: 50%; pointer-events: none; }
    .fab.armed::after { content: ""; position: absolute; top: 2px; right: 2px; width: 9px; height: 9px;
           border-radius: 50%; background: #fff; border: 2px solid #0A0A0B; }

    .panel { position: fixed; right: 18px; bottom: 76px; width: 272px;
           background: rgba(10,10,11,.96); color: #A8A8B0; border: 1px solid rgba(255,255,255,.14);
           border-radius: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.6);
           backdrop-filter: blur(14px) saturate(140%);
           opacity: 0; transform: translateY(10px) scale(.97); pointer-events: none;
           transition: opacity .18s ease, transform .18s cubic-bezier(.2,.9,.3,1.2); }
    .panel.open { opacity: 1; transform: none; pointer-events: auto; }

    .head { display: flex; align-items: center; gap: 10px; padding: 13px 15px 11px;
           border-bottom: 1px solid rgba(255,255,255,.08); }
    .head img { width: 24px; height: 24px; border-radius: 7px; }
    .head .word { color: #fff; font-size: 13.5px; font-weight: 700; letter-spacing: -.02em; }
    .head .site { margin-left: auto; color: #78787F; font-size: 11px;
           font-family: Consolas, ui-monospace, monospace; max-width: 110px;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .row { display: flex; align-items: flex-start; gap: 11px; width: 100%; text-align: left;
           padding: 12px 15px; background: none; border: none; cursor: pointer; }
    .row:hover { background: rgba(255,255,255,.05); }
    .row[disabled] { cursor: default; opacity: .45; }
    .row[disabled]:hover { background: none; }
    .row + .row { border-top: 1px solid rgba(255,255,255,.06); }
    .row .body { flex: 1; min-width: 0; }
    .row .name { color: #fff; font-size: 12.5px; font-weight: 600; letter-spacing: -.01em; }
    .row .desc { color: #78787F; font-size: 11px; line-height: 1.45; margin-top: 2px; }
    .row .kbd { color: #A8A8B0; font-family: Consolas, ui-monospace, monospace; font-size: 10.5px;
           border: 1px solid rgba(255,255,255,.16); border-radius: 4px; padding: 0 4px; }

    .switch { flex: none; width: 34px; height: 20px; border-radius: 999px; margin-top: 1px;
           background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.1);
           position: relative; transition: background .18s ease; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
           border-radius: 50%; background: #8E8E96; transition: transform .18s cubic-bezier(.2,.9,.3,1.3), background .18s; }
    .row.on .switch { background: #fff; border-color: #fff; }
    .row.on .switch::after { transform: translateX(14px); background: #0A0A0B; }

    .foot { padding: 10px 15px 12px; border-top: 1px solid rgba(255,255,255,.08);
           color: #55555E; font-size: 10.5px; line-height: 1.5; }
    .foot b { color: #78787F; font-weight: 600; }

    .toast { position: fixed; right: 18px; bottom: 76px; max-width: 272px;
           background: rgba(10,10,11,.96); color: #fff; border: 1px solid rgba(255,255,255,.16);
           font-size: 12px; padding: 9px 13px; border-radius: 12px;
           box-shadow: 0 10px 30px rgba(0,0,0,.45); opacity: 0; transform: translateY(6px);
           transition: opacity .18s ease, transform .18s ease; pointer-events: none; }
    .toast.show { opacity: 1; transform: none; }
  </style>`;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* ---------- toast ---------- */
  let toastEl = null;
  let toastTimer = null;
  function toast(message) {
    if (toastEl) toastEl.remove();
    toastEl = el('div', 'toast', message);
    if (state.open) toastEl.style.bottom = (76 + panel.offsetHeight + 10) + 'px';
    root.appendChild(toastEl);
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 4200);
  }

  /* ---------- rows ---------- */

  function featureRow({ name, desc, kbd, on, disabled, onToggle }) {
    const row = el('button', 'row' + (on ? ' on' : ''));
    row.type = 'button';
    if (disabled) row.disabled = true;
    const body = el('div', 'body');
    const title = el('div', 'name', name);
    if (kbd) {
      title.append(' ');
      title.appendChild(el('span', 'kbd', kbd));
    }
    body.appendChild(title);
    body.appendChild(el('div', 'desc', desc));
    row.appendChild(body);
    row.appendChild(el('span', 'switch'));
    if (!disabled) row.addEventListener('click', () => onToggle(row));
    return row;
  }

  /* ---------- audit mode plumbing ---------- */

  // Mid-session enable: the server started routing the review API the moment
  // audit/start answered, so the overlay can be pulled in without a reload.
  function injectAuditOverlay() {
    if (window.__ssReviewLoaded) return;
    const script = document.createElement('script');
    script.src = '/__siteslurp__/review/client.js';
    document.documentElement.appendChild(script);
  }

  async function toggleAudit(row) {
    if (state.auditBusy) return;
    state.auditBusy = true;
    try {
      if (!state.audit) {
        await post('audit/start');
        state.audit = true;
        row.classList.add('on');
        injectAuditOverlay();
        toast('Audit mode on — click any element to annotate, Export lives in the bottom toolbar');
      } else {
        await post('audit/stop');
        state.audit = false;
        row.classList.remove('on');
        location.reload(); // the overlay only leaves with the page
      }
    } catch (err) {
      toast(err.message);
    } finally {
      state.auditBusy = false;
    }
  }

  /* ---------- dragger plumbing ---------- */

  function setDragger(on, row) {
    const grab = window.__slurpGrab;
    if (!grab) { toast('The asset dragger did not load on this page.'); return; }
    state.dragger = grab.setSticky(on);
    row.classList.toggle('on', state.dragger);
    fab.classList.toggle('armed', state.dragger);
    try { sessionStorage.setItem(DRAGGER_KEY, state.dragger ? '1' : ''); } catch { /* storage may be blocked */ }
    if (state.dragger) toast('Asset dragger on — drag anything off the page; scroll to widen, ⇧ for a bundle');
  }

  /* ---------- build ---------- */

  const fab = el('button', 'fab');
  fab.type = 'button';
  fab.title = 'Local Dev Studio menu';
  fab.setAttribute('aria-label', 'Local Dev Studio menu');
  const logo = document.createElement('img');
  logo.src = API + 'logo.png';
  logo.alt = '';
  fab.appendChild(logo);

  const panel = el('div', 'panel');

  const head = el('div', 'head');
  const headLogo = document.createElement('img');
  headLogo.src = API + 'logo.png';
  headLogo.alt = '';
  head.appendChild(headLogo);
  head.appendChild(el('span', 'word', 'Local Dev Studio'));
  head.appendChild(el('span', 'site', CFG.name || location.host));
  panel.appendChild(head);

  const draggerRow = featureRow({
    name: 'Asset dragger',
    kbd: 'Alt',
    desc: 'Drag any element, image or video straight off the page — it drops as a real file path or a GRAB.md bundle.',
    on: false,
    onToggle: row => setDragger(!state.dragger, row),
  });
  panel.appendChild(draggerRow);

  const auditAvailable = !!(CFG.audit && CFG.audit.available);
  const auditRow = featureRow({
    name: 'Audit mode',
    desc: auditAvailable
      ? 'Annotate elements, rate them, and export the whole review as a spec an AI agent can build from.'
      : (CFG.audit && CFG.audit.reason) || 'Not available for this site.',
    on: state.audit,
    disabled: !auditAvailable,
    onToggle: toggleAudit,
  });
  panel.appendChild(auditRow);

  const foot = el('div', 'foot');
  foot.append('Hold ');
  foot.appendChild(el('b', '', 'Alt'));
  foot.append(' anytime for a quick grab · ');
  foot.appendChild(el('b', '', location.host));
  panel.appendChild(foot);

  root.appendChild(panel);
  root.appendChild(fab);

  /* ---------- open / close ---------- */

  function setOpen(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    fab.classList.toggle('open', open);
  }

  fab.addEventListener('click', () => setOpen(!state.open));
  document.addEventListener('mousedown', e => {
    if (state.open && e.target !== host) setOpen(false);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.open) setOpen(false);
  }, true);

  /* ---------- boot ---------- */

  function boot() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    // The dragger toggle survives reloads within this tab.
    let remembered = false;
    try { remembered = sessionStorage.getItem(DRAGGER_KEY) === '1'; } catch { /* storage may be blocked */ }
    if (remembered && window.__slurpGrab) {
      state.dragger = window.__slurpGrab.setSticky(true);
      draggerRow.classList.toggle('on', state.dragger);
      fab.classList.toggle('armed', state.dragger);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__slurpMenu = { cfg: CFG, open: () => setOpen(true), close: () => setOpen(false), state };
})();
