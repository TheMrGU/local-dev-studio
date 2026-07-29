# SiteSlurp Studio

**Website extractor & management, by [NightShyft Studios](https://siteslurp.com).**

Slurp any website into editable files, host it locally, and manage every client site in one
place — built for the client-site-update workflow: extract a client's existing site, restyle
it locally, review it with on-page annotations, redeliver.

## Install

Grab one of the two builds and run it. Nothing else to install.

| Download | Use it when |
| --- | --- |
| `SiteSlurp-Setup-<version>.exe` | Normal install — Start-menu and desktop shortcuts, uninstall entry. Per-user, so no admin prompt. |
| `SiteSlurp-<version>-portable.exe` | Running from a USB stick or a locked-down machine. No install, no registry entries. |

**Requirements:** Windows 10/11 (x64) and a Chromium-based browser. Microsoft Edge ships with
Windows, so that's almost always already satisfied. Chrome, Brave, Vivaldi, Opera and plain
Chromium work too — SiteSlurp finds whichever you have and lets you pick in Settings.

You do **not** need Node.js, npm, or any command-line tools. The page-capture engine ships
inside the app and runs on Electron's own runtime.

> Windows SmartScreen will warn on first run, because these builds aren't code-signed
> (a certificate costs money). Click **More info → Run anyway**.

## What it does

1. **Capture** — drives a real browser, so React / Next / SPA sites fully render before they're
   saved. Whole-site crawl (depth 1–5) or a single page; desktop or emulated mobile device.
   Optionally strips cookie-consent overlays, and can run the browser visibly for sites that
   block headless automation.
2. **Extract** — explodes the self-contained snapshot into an editable structure:
   `*.html` + `css/` (one file per unique style block) + `assets/images|fonts|media|misc/`,
   deduped by content hash across pages. Scroll-reveal content frozen at `opacity: 0` (its
   scripts having been stripped) is unhidden, so the page looks like it did live.
3. **Fix videos** — the capture engine drops `<video>` sources; SiteSlurp downloads the
   originals, wires them in locally, and adds `muted` so autoplay works.
4. **Host** — one click serves any site on localhost and opens it at its real homepage (the
   page whose URL you captured), with Range support so video seeks and no-cache headers so your
   edits show on refresh. Multiple sites at once on different ports. Both the IPv4 and IPv6
   loopback are bound, so a stray server on the other stack can't shadow a hosted site — if
   another process owns half a port, SiteSlurp skips to the next one. The generated page list
   stays available via **⋯ → Open sitemap** (`/_index.html`).
5. **Recolor** — scans the site's palette; click a swatch, pick a replacement, and it swaps
   that color across every css, html and svg file. Alpha and notation are preserved
   (`rgba(…, .5)` stays `rgba`, `#abc` stays shorthand), and every recolor is undoable.
6. **Extras** — homepage thumbnails, ZIP export, open in VS Code / Explorer, delete to the
   Recycle Bin (optionally together with the raw snapshot it was extracted from). Each card
   shows the primary actions; everything else is under the **⋯** menu.

## Library

The library lists every capture folder under the captures root — `Documents\SiteSlurp` by
default, or the existing `Desktop\Projects\Mockups\SiteReferences` folder if you already have
one from the older `crawl.ps1` / `capture.ps1` / `extract.ps1` scripts.

Raw captures get an **Extract** button; extracted ones get **Host** and the editing tools.
Once a raw capture has been extracted, it's hidden behind the **Raw snapshots** toggle to keep
the grid clean.

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+N` | Focus the URL box |
| `F5` | Refresh the library |
| `Ctrl+,` | Settings |
| `/` | Filter the library |
| `Esc` | Close any panel |

## Troubleshooting

Open **Help → Setup & diagnostics**, or click the status pills in the title bar. It reports the
browser it found, the capture engine path, and whether the captures folder is writable.

**Help → Open log file** opens `%APPDATA%\SiteSlurp Studio\logs\siteslurp.log`, which records every
capture, failure and stack trace.

| Symptom | Fix |
| --- | --- |
| "No pages captured — the site may block automated browsers" | Open **Advanced** and tick **Show browser**. Some sites refuse headless Chrome. |
| Site looks broken or half-loaded | Raise **Extra wait** in Advanced so lazy content finishes loading before the snapshot. |
| A cookie banner covers everything | Leave **Strip cookie banners** on; for an unusual consent tool, delete the overlay element in the extracted HTML. |
| Deep links 404 while hosting | Those pages were beyond the crawl depth and never got saved. Recapture with a higher depth. |
| Hosting shows a completely different website | Another program is serving that port on the other network stack (a leftover `python -m http.server`, a dev server, …). SiteSlurp now binds both loopbacks and skips such ports automatically — stop the other program, or just re-host and use the port SiteSlurp reports. |
| Port already in use | SiteSlurp walks forward from the default port automatically; change the default in Settings if you want a different range. |

## Development

```powershell
npm install
npm start                # run from source
npm test                 # library checks — palette, extract, zip, static server, settings
npm run smoke            # launch, screenshot, verify the window painted
npm run e2e              # full pipeline against a live site, on the packaged runtime
npm run dist             # build installer + portable into dist\
```

Before shipping a build, run the one check that covers everything:

```powershell
node scripts/smoke.js "dist\win-unpacked\SiteSlurp Studio.exe" --capture
```

That drives a real capture through the built exe's own UI and IPC — renderer → main → browser →
extract → thumbnail — and fails the exit code if any step doesn't finish.

### Layout

```
main.js          window, menu, IPC, pipelines
preload.js       the only renderer bridge (allowlisted channels)
lib/browsers.js  Chromium detection
lib/capture.js   drives the bundled SingleFile CLI
lib/extract.js   snapshot -> editable files
lib/entry.js     which page is a capture's real homepage
lib/server.js    local static host (binds both loopbacks)
lib/palette.js   color scan / swap / undo
lib/videofix.js  restores stripped <video> sources
lib/zip.js       dependency-free ZIP writer
lib/thumbs.js    offscreen thumbnail rendering
lib/library.js   capture enumeration
lib/settings.js  validated, atomically written settings
lib/logger.js    rotating log file
renderer/        the UI
scripts/         test, smoke and e2e harnesses
```

Two constraints worth knowing before you refactor:

- The bundled capture CLI runs on Electron's own Node runtime (`ELECTRON_RUN_AS_NODE`), which
  is why end users need no Node install. It must stay in `build.asarUnpack` — Node's ESM loader
  cannot read from inside an asar archive.
- The main process also runs the local web servers, so anything slow must not block it. Extract
  yields between pages for that reason.

## License

MIT — see [LICENSE](LICENSE).

The distributed app bundles [single-file-cli](https://github.com/gildas-lormeau/single-file-cli),
which is **AGPL-3.0**. Read [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) before
redistributing a build — it explains what the AGPL asks of you and how to drop the bundling if
you'd rather not carry it.
