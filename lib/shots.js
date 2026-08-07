// lib/shots.js — capture element + context screenshots for an annotation.
//
// Same trick as thumbs.js: Electron is Chromium, so render the hosted page in
// an offscreen window at the annotation's own viewport, find the element again
// by its stored selector, and capture two crops — the element itself and the
// element with ~200px of surroundings. Serialized queue; failures degrade to
// an annotation without screenshots, never to an error the user sees.
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const CONTEXT_PAD = 200;
let queue = Promise.resolve();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function render(annotation, { port, shotsDir, prefix = '' }) {
  const viewport = annotation.context.viewport || { width: 1440, height: 900 };
  const win = new BrowserWindow({
    show: false,
    width: Math.max(320, viewport.width || 1440),
    height: Math.max(400, viewport.height || 900),
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  try {
    const pageUrl = `http://127.0.0.1:${port}${annotation.context.pageUrl || '/'}`;
    const loaded = win.webContents.loadURL(pageUrl);
    await Promise.race([loaded.catch(() => {}), sleep(20000)]);
    await sleep(900); // fonts and lazy images

    // Re-locate by selector — the offscreen render may lay out slightly
    // differently than the tab the user annotated in. Regions (no selector)
    // fall back to the recorded box.
    const selector = annotation.context.selector || annotation.context.selectorFallback;
    const box = await win.webContents.executeJavaScript(`(() => {
      const stored = ${JSON.stringify(annotation.context.boundingBox || null)};
      const el = ${JSON.stringify(selector || '')} && document.querySelector(${JSON.stringify(selector || '')});
      if (!el) return stored;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height,
               vx: r.x, vy: r.y, vw: window.innerWidth, vh: window.innerHeight };
    })()`, true).catch(() => null);
    if (!box || !box.w || !box.h) return null;
    await sleep(250); // let scrollIntoView settle before capturing

    const vx = box.vx !== undefined ? box.vx : box.x;
    const vy = box.vy !== undefined ? box.vy : box.y;
    const vw = box.vw || viewport.width || 1440;
    const vh = box.vh || viewport.height || 900;

    const clamp = rect => ({
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.min(Math.round(rect.width), vw - Math.max(0, Math.round(rect.x)))),
      height: Math.max(1, Math.min(Math.round(rect.height), vh - Math.max(0, Math.round(rect.y)))),
    });

    const elementRect = clamp({ x: vx, y: vy, width: box.w, height: box.h });
    const contextRect = clamp({
      x: vx - CONTEXT_PAD, y: vy - CONTEXT_PAD,
      width: box.w + CONTEXT_PAD * 2, height: box.h + CONTEXT_PAD * 2,
    });

    fs.mkdirSync(shotsDir, { recursive: true });
    const files = {};
    for (const [suffix, rect] of [['el', elementRect], ['ctx', contextRect]]) {
      const image = await win.webContents.capturePage(rect);
      if (image.isEmpty()) continue;
      // A prefix names a variant of the same shot: the verification loop's
      // "after_" pair sits beside the originals as <id>_after_el.png.
      const name = `${annotation.id}_${prefix}${suffix}.png`;
      await fs.promises.writeFile(path.join(shotsDir, name), image.toPNG());
      files[suffix] = name;
    }
    return Object.keys(files).length ? files : null;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * @param {object} annotation
 * @param {{port:number, shotsDir:string, prefix?:string}} opts
 * @returns {Promise<{el?:string, ctx?:string}|null>} shot filenames, or null
 */
function captureAnnotationShots(annotation, opts) {
  const next = queue.then(() => render(annotation, opts).catch(() => null));
  queue = next.catch(() => {});
  return next;
}

module.exports = { captureAnnotationShots };
