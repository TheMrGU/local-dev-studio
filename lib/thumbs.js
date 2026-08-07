// lib/thumbs.js — render a site's homepage to thumb.png.
//
// Electron *is* Chromium, so previews are rendered in an offscreen window instead
// of shelling out to an external Chrome install. That drops a dependency, avoids
// the shared temp profile two concurrent screenshots used to fight over, and is
// noticeably faster.
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { resolveEntry } = require('./entry');

const WIDTH = 1440;
const HEIGHT = 900;
const THUMB_WIDTH = 760;

let queue = Promise.resolve(); // one render at a time — each spins up a renderer

function homePage(dir, chosen = null) {
  // The project's chosen entry wins when it still exists; a stale choice falls
  // back to the folder's own resolution rather than a blank preview.
  if (chosen && typeof chosen === 'string') {
    const full = path.resolve(dir, chosen);
    if (full.startsWith(path.resolve(dir) + path.sep)) {
      try { if (fs.statSync(full).isFile()) return full; } catch { /* fall through */ }
    }
  }
  const entry = resolveEntry(dir);
  return entry ? path.join(dir, entry) : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function render(dir, out, { url = null, entry = null } = {}) {
  // A generated site has no homepage file to load — but if it's hosted, the
  // running server has the real thing, which is a better preview anyway.
  const page = url || homePage(dir, entry);
  if (!page) return null;

  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    webPreferences: {
      offscreen: true,          // paints without ever being on screen
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webgl: false,
      backgroundThrottling: false,
    },
  });

  try {
    const loaded = url ? win.webContents.loadURL(url) : win.webContents.loadFile(page);
    // A capture that references a dead remote font shouldn't hang the queue.
    await Promise.race([loaded.catch(() => {}), sleep(20000)]);
    await sleep(1200); // let webfonts and lazy images settle

    let image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      await sleep(1500);
      image = await win.webContents.capturePage();
    }
    if (image.isEmpty()) return null;

    const target = out || path.join(dir, 'thumb.png');
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, image.resize({ width: THUMB_WIDTH, quality: 'good' }).toPNG());
    return target;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Serialized so a bulk refresh doesn't spawn a renderer per site at once.
 *  `out` overrides where the PNG lands (default: thumb.png inside the site);
 *  `opts.url` renders a hosted site instead of a file on disk. */
function makeThumb(dir, out, opts) {
  const next = queue.then(() => render(dir, out, opts).catch(() => null));
  queue = next.catch(() => {});
  return next;
}

module.exports = { makeThumb, homePage };
