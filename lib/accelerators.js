// lib/accelerators.js — the window has no menu bar, so the shortcuts the old
// File/Edit/View menu owned are bound straight to the webContents instead.
// Discoverability lives in the command palette (Ctrl+K); this file is only the
// muscle memory half. Keys we don't claim fall through to the renderer, which
// is where tab switching, Escape and "/" are handled.
const { Menu } = require('electron');

const ZOOM_MIN = -2;
const ZOOM_MAX = 4;

function zoomBy(win, delta) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, win.webContents.getZoomLevel() + delta));
  win.webContents.setZoomLevel(next);
}

function attachAccelerators({ win, send }) {
  // Removing the application menu is what actually deletes the File/Edit/View/
  // Sites/Help strip — a frameless window still draws it otherwise.
  Menu.setApplicationMenu(null);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '');
    const mod = input.control || input.meta;
    const fire = fn => { event.preventDefault(); fn(); };

    if (key === 'F5' && !mod) return fire(() => send('ui:refresh'));
    if (key === 'F11') return fire(() => win.setFullScreen(!win.isFullScreen()));
    if (!mod) return;

    // Ctrl+Shift+I is the only chord we take; every other shift combination is
    // ordinary text editing and must reach the input the user is typing in.
    if (input.shift) {
      if (key.toLowerCase() === 'i') fire(() => win.webContents.toggleDevTools());
      return;
    }

    switch (key.toLowerCase()) {
      case 'n': return fire(() => send('ui:focus-url'));
      case 'k': return fire(() => send('ui:palette'));
      case ',': return fire(() => send('ui:settings'));
      case '=':
      case '+': return fire(() => zoomBy(win, 0.5));
      case '-': return fire(() => zoomBy(win, -0.5));
      case '0': return fire(() => win.webContents.setZoomLevel(0));
      default:
    }
  });
}

module.exports = { attachAccelerators, zoomBy };
