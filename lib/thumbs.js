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

function homePage(dir) {
  const entry = resolveEntry(dir);
  return entry ? path.join(dir, entry) : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function render(dir) {
  const page = homePage(dir);
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
    const loaded = win.webContents.loadFile(page);
    // A capture that references a dead remote font shouldn't hang the queue.
    await Promise.race([loaded.catch(() => {}), sleep(20000)]);
    await sleep(1200); // let webfonts and lazy images settle

    let image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      await sleep(1500);
      image = await win.webContents.capturePage();
    }
    if (image.isEmpty()) return null;

    const out = path.join(dir, 'thumb.png');
    await fs.promises.writeFile(out, image.resize({ width: THUMB_WIDTH, quality: 'good' }).toPNG());
    return out;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Serialized so a bulk refresh doesn't spawn a renderer per site at once. */
function makeThumb(dir) {
  const next = queue.then(() => render(dir).catch(() => null));
  queue = next.catch(() => {});
  return next;
}

module.exports = { makeThumb, homePage };
