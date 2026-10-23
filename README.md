# Local Dev Studio

**Local Developer Studio, by NightShyft. Website extractor, manager & presenter. [localdevstudio.com](https://localdevstudio.com)**

Capture any website into editable files, host it locally, manage every client site in one
place, and put any of them on the big screen — built for the client-site-update workflow:
extract a client's existing site, restyle it locally, review it with on-page annotations,
present it, redeliver. (Shipped as SiteSlurp Studio through 2.6, NightShyft Studio through 2.8 and OpenDevStudio in 2.9; same app, new name.)

## Install

Grab one of the two builds and run it. Nothing else to install.

| Download | Use it when |
| --- | --- |
| `LocalDevStudio-Setup-<version>.exe` | Normal install — Start-menu and desktop shortcuts, uninstall entry. Per-user, so no admin prompt. |
| `LocalDevStudio-<version>-portable.exe` | Running from a USB stick or a locked-down machine. No install, no registry entries. |

**Requirements:** Windows 10/11 (x64) and a Chromium-based browser. Microsoft Edge ships with
Windows, so that's almost always already satisfied. Chrome, Brave, Vivaldi, Opera and plain
Chromium work too — Local Dev Studio finds whichever you have and lets you pick in Settings.

You do **not** need Node.js, npm, or any command-line tools. The page-capture engine ships
inside the app and runs on Electron's own runtime.

> Windows SmartScreen will warn on first run, because these builds aren't code-signed
> (a certificate costs money). Click **More info → Run anyway**.

## What it does

1. **Capture** — drives a real browser, so React / Next / SPA sites fully render before they're
   saved. Whole-site crawl (depth 1–5) or a single page; desktop or emulated mobile device.
   Optionally strips cookie-consent overlays, scrolls the page first so lazy-loaded content
   makes it in, and can run the browser visibly for sites that block headless automation.
   Pages behind a login capture too: **Log in for capture…** opens a browser profile kept just
   for capturing — sign in once and every "signed in" capture reuses the session — or hand it a
   `cookies.txt`/JSON cookie export and extra request headers (staging basic-auth). Paste a
   list of URLs to queue captures one after another, or paste a `sitemap.xml` link to capture
   every page it lists into one project — scoped by include/exclude path patterns and a page
   cap. Later, **⋯ → Re-capture from the web…** runs the same capture again and keeps the old
   state as a snapshot, so "what changed on this site since May" is one diff away.
2. **Extract** — explodes the self-contained snapshot into an editable structure:
   `*.html` + `css/` (one file per unique style block) + `assets/images|fonts|media|misc/`,
   deduped by content hash across pages. Scroll-reveal content frozen at `opacity: 0` (its
   scripts having been stripped) is unhidden, so the page looks like it did live. The site's
   own absolute links (`https://site.com/about`, which SingleFile writes into every href) become
   root-relative, so clicking around a hosted copy stays on the hosted copy instead of leaving
   for the live site; the local server maps each pretty path — query string included, so
   `/shop?type=hats` lands on the page saved from that URL — onto the flat file it was saved as.
3. **Fix videos** — the capture engine drops `<video>` sources; Local Dev Studio downloads the
   originals, wires them in locally, and adds `muted` so autoplay works. With **Keep
   JavaScript** on, a second pass replays every captured page in a hidden browser with the
   network recorder running and saves everything the page fetched — script chunks, 3D meshes,
   compressed textures, decoder `.wasm`, web workers, audio — at its original path, then
   rewrites the references. That is what makes a WebGL site (a Vite + three.js experience whose
   whole world streams in at runtime) work from the local copy instead of coming up as an empty
   `<div>`. The recorder follows the site to wherever it really answers (`igloo.inc` 308s to
   `www.igloo.inc`) and files those responses as the site's own, and it records a desktop pass
   before the phone pass so the assets a desktop visitor gets are on disk too. When the
   server's page is an app shell (an empty body the scripts fill — every Vite/React/three.js
   experience), the capture serves that original document rather than the rendered snapshot:
   running the app again on top of its own built DOM leaves two apps fighting and a scroll that
   does nothing. The rendered DOM stays in the raw capture folder. The recorder visits one page
   of every kind (home, catalogue, product, policy…) rather than every page, then sweeps all the
   pages and scripts for files they still name by path — the chunks and images only a product
   page loads — and fetches those outright, so a 100-page store is complete without a 100-page
   replay. A script served from an extensionless path (Spotify's `/embed/iframe-api/v1`) keeps
   its recorded type in a dot-file the local server reads, so the browser still runs it. Grab bundles say so too: an
   element that is a `<canvas>` or an empty container gets a "Drawn by script" section pointing
   at the scripts and runtime files, because its HTML and CSS are the frame, not the picture.
4. **Host** — one click serves any site on localhost and opens it at its real homepage (the
   page whose URL you captured), with Range support so video seeks and no-cache headers so your
   edits show on refresh. Multiple sites at once on different ports. Both the IPv4 and IPv6
   loopback are bound, so a stray server on the other stack can't shadow a hosted site — if
   another process owns half a port, Local Dev Studio skips to the next one. The generated page list
   stays available via **⋯ → Open sitemap** (`/_index.html`).
5. **Host what isn't HTML** — a folder that needs a process to become a website is hosted the
   same way. Drop a Next.js, Vite, Astro, SvelteKit, Nuxt, Angular, Gatsby, Remix, CRA or
   Eleventy project — or Django, Flask, FastAPI, Laravel, plain PHP, Rails, Jekyll, Hugo, Go,
   Rust — and Local Dev Studio reads its `package.json` (or `manage.py`, `artisan`, `Gemfile`,
   `hugo.toml`…), works out the dev-server command and the install step, then runs it on a
   private port while keeping its own. Anything not in that list is a **custom command** away.
   Because Local Dev Studio keeps the public port and proxies, everything else still works: one stable
   address per project, hot-module-reload websockets pass straight through, and Review Mode
   annotates a running React app exactly as it annotates a folder of files — mapping notes back
   to the component that rendered them. See **⋯ → How to serve this…** on any dropped folder.
6. **Share publicly** — the share toggle on any hosted card puts that site on the internet
   through a Cloudflare quick tunnel and hands you an `https://….trycloudflare.com` link.
   No account, no router or firewall changes: the tunnel engine (cloudflared, ~60MB) is
   downloaded once on the first share, then it's one click. The address is random on purpose —
   shareable, not guessable — and dies the moment you stop sharing, stop hosting, or close the
   app. Visitors get the site and only the site: Review Mode, its API and live reload stay
   local-only, and dev servers behind the proxy see a localhost Host header so host checking
   (Vite 6+) doesn't reject tunneled requests.

   The share window adds two options on top of the plain link. **Guest review** lets the
   people you share with annotate the page — they get the overlay in a locked-down guest
   mode (notes signed with their name, everything else refused server-side by a per-share
   capability token, rate-limited per visitor). **Pin a version** locks the link to a
   snapshot so reviewers see a fixed state while you keep editing live; pinned guests can
   annotate until a newer snapshot exists, and their notes remember which version they saw.
   Guest notes land in the same review store as your own, marked with the author, so exports
   and the MCP loop treat them like any other feedback.
7. **Serve over HTTPS** — per-project toggle (⋯ menu) that adds a second, secure address at
   `https://<name>.slurp.localhost:<port>` for secure-context APIs and realistic cookie
   testing. Certificates come from a local CA the app writes itself with `node:crypto`
   (nothing installed, no openssl); trust the CA once — the toast and the command palette
   offer it — and every project's https address gets a clean padlock. `*.localhost` names
   resolve to loopback in every modern browser, so there are no hosts-file edits.
8. **Publish** — ⋯ → *Publish to the web…* uploads the site to Netlify (first adapter of a
   pluggable set): the first publish creates the site, every later one updates the same
   address, and you can publish the working tree or any snapshot — snapshots deploy
   byte-for-byte from their manifests, so a deploy is reproducible. The access token lives
   in the system keychain via Electron `safeStorage`, never in a plain file.
9. **Recolor** — scans the site's palette; click a swatch, pick a replacement, and it swaps
   that color across every css, html and svg file. Alpha and notation are preserved
   (`rgba(…, .5)` stays `rgba`, `#abc` stays shorthand), and every recolor is undoable.
10. **Extras** — homepage thumbnails, ZIP export, open in VS Code / Explorer, delete to the
   Recycle Bin (optionally together with the raw snapshot it was extracted from). Each card
   shows the primary actions; everything else is under the **⋯** menu.

## ShowCase

The third tab. Pick any site in your Studio and present it — on a projector, a second
screen, or the laptop lid turned to the client — or record it as an MP4 for your socials.

ShowCase doesn't just scroll. It **reads the page** and directs it. Before the camera rolls
the page is made presentable, then a storyboard is built from what's actually there, and
the show runs it shot by shot:

- **Opening** — hold on the top of the page.
- **Navigation** — a ghost pointer glides along the site's own nav, hovering each link
  (real hover: the site's hover styles fire).
- **Button** — the main call-to-action above the fold gets hovered and pressed.
- **Sections** — the page is read by shape (Tailwind divs, Webflow sections, whatever),
  and the camera glides to each one, names it in a lower-third caption, and holds.
- **Details** — a push-in on the biggest picture in each section: the view and its bezel
  grow around the focus, no reflow, the same layout, closer.
- **Cards** — three or more same-sized siblings in a row are a grid; the pointer sweeps
  across them so their hover states show.
- **Explore** — a page that doesn't scroll (a WebGL piece, an app shell) gets its
  pointer-sensitive elements hovered instead.
- **Flip** — before leaving, the page shows on a phone for a few seconds (optional).
- **Pages** — the pointer clicks through to the site's other pages, one after another.
  Captured sites keep their links pointing at the site they came from; the show maps those
  back onto the local copy, and the local server redirects pretty paths (`/about`) to the
  flat page the capture saved (`_about.html`).

**Polish** — what gets fixed before the camera rolls: content a reveal-on-scroll effect left
at opacity 0 (a capture without its scripts, or a page the camera moves through faster than
its observer fires) fades in as the camera reaches it; videos play muted while on screen and
lazy images load ahead; cookie bars, chat bubbles and pop-ups parked over the page are hidden;
scroll-snap is switched off so the glide owns the pace. Each of these is a switch.

**Styles** — Walkthrough (everything, for a client), Reel (a few highlights, a phone flip,
next site — thirty seconds each, for socials), Cinematic (slow glides, long push-ins, no
pointer), Scroll (a steady glide), Still (hold each page). A style sets the shots; you can
switch any shot back on or off.

**Frames** — Full, Laptop, Tablet, Phone, and **Duo**: laptop and phone side by side showing
the same page, the phone scrolling in step with the laptop — the responsive design in one
shot. A phone frame lays the site out at 390px wide and scales it up, so it's the real mobile
design, big.

**Cursor** — Hidden, Ghost (a glowing pointer that follows your mouse and the show's moves)
or Spotlight (dims everything but a circle around the pointer).

**Record** — the whole show (cards, bezels, motion, music) is captured straight to an H.264
MP4 in `<captures>/Reels/`. **Music** — pick an audio file to play under the show; it fades
in and out and is in the recording.

Also: a title card in and a thank-you card out with an optional tagline; a hairline progress
line; captions; a **reel** of several sites in the order you picked them; which display, full
screen or windowed.

The panel turns into a **remote** while a show runs: the storyboard for the current page
with the running shot lit (click any shot to jump to it), pause, previous/next shot,
previous/next page, speed, frame, cursor, blackout, restart, record, end. In the show itself:
`Space` pause · `←`/`→` shots · `N`/`P` pages · `↑`/`↓` speed · `1`–`5` frame ·
`C` cursor · `B` blackout · `F` full screen · `H` key hint · `Esc` end. Grabbing the
wheel pauses the show; the remote's Play picks it back up.

## The agent loop (MCP)

This is the pitch: your on-page feedback becomes work an agent does, and Local Dev Studio verifies it.

1. Open a site in Review Mode and annotate what's wrong — every note carries the selector, the
   `file:line` when known, computed styles, screenshots and your written reason.
2. Connect your coding agent once: **Settings → Agent access** has a paste-ready line for
   Claude Code (`claude mcp add local-dev-studio -- "<exe>" --mcp`) and a JSON snippet for Cursor or
   any other MCP client. The app must be running; the MCP server is a thin stdio client of a
   token-gated loopback control API (`userData/control.json`) — nothing is exposed off-machine.
3. The agent calls `list_annotations`, reads `get_calibration` to learn your taste (standing
   preferences + rating anchors), and fixes the code. The file watcher auto-snapshots the
   project as edits land, so every state is restorable.
4. The agent calls `resolve_annotation(id, note, afterRating)` — and Local Dev Studio closes the loop
   visually: the element is re-screenshotted and pixel-diffed against the original. Pins show
   before/after pairs; a resolve that changed nothing visually gets flagged for reopening; an
   element that drifted since you noted it comes up badged "changed since noted".

Tools: `list_projects`, `list_annotations`, `get_annotation`, `resolve_annotation`,
`get_calibration`, `create_snapshot`, `export_review`. Resources: each project's live
`REVIEW.md` plus `calibration.md`. Prefer files over a live connection? **Export** writes the
same thing as a folder.

**Run audits** (review toolbar, card ⋯ menu, or Ctrl+K) adds an automated pass: an
axe-core accessibility scan and an internal broken-link crawl, filed as `[auto]`-badged
annotations in the same review — same severity scale, same export, clearly separated from
your own judgment.

## Library

The library lists every capture folder under the captures root — `Documents\Local Dev Studio` by
default, or the existing `Desktop\Projects\Mockups\SiteReferences` folder if you already have
one from the older `crawl.ps1` / `capture.ps1` / `extract.ps1` scripts.

Raw captures get an **Extract** button; extracted ones get **Host** and the editing tools.
Once a raw capture has been extracted, it's hidden behind the **Raw snapshots** toggle to keep
the grid clean.

**Sections** sort the library into shelves of your own. It starts with Client Websites,
Concepts and Personal & Business; **+ New section** adds more, and each section's ⋯ renames,
reorders or deletes it (its sites go back to unsorted — nothing on disk is touched). Drag a
card onto a section chip or a section's block, or use **⋯ → Move to section…** on the card.
Anything not on a shelf shows under **Captures** (sites pulled in by the Extractor) or
**Unsorted** (folders you dropped in). Click a chip to see one section alone; click a section's
name in the All view to fold it away.

Drop any folder on the window to add it. It doesn't have to contain HTML — Local Dev Studio works out
what it is and shows that on the card ("Next.js dev server", "Django dev server", "Static
files"). If it needs dependencies, the card says **needs install** and hosting offers to fetch
them first. **⋯ → How to serve this…** shows every runtime detected for that folder, the exact
command that will run, and — while it's hosted — what the process is printing.

## Keyboard

There is no menu bar. `Ctrl+K` opens a command palette holding everything a menu would —
plus a row per site, so you can host, open or stop any capture without finding its card.

| Key | Action |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+N` | Focus the URL box |
| `Ctrl+1` / `Ctrl+2` | Extractor / Studio |
| `F5` | Refresh the library |
| `Ctrl+,` | Settings |
| `Ctrl+ +` / `Ctrl+ -` / `Ctrl+0` | Zoom |
| `F11` | Full screen |
| `/` | Filter the library |
| `Esc` | Close any panel |

## Troubleshooting

Click **Ready** in the title bar, or run **Setup & diagnostics** from `Ctrl+K`. It reports the
browser it found, the capture engine path, and whether the captures folder is writable.

**Help → Open log file** opens `%APPDATA%\Local Dev Studio\logs\local-dev-studio.log`, which records every
capture, failure and stack trace.

| Symptom | Fix |
| --- | --- |
| "No pages captured — the site may block automated browsers" | Open **Advanced** and tick **Show browser**. Some sites refuse headless Chrome. |
| Site looks broken or half-loaded | Raise **Extra wait** in Advanced so lazy content finishes loading before the snapshot. |
| A cookie banner covers everything | Leave **Strip cookie banners** on; for an unusual consent tool, delete the overlay element in the extracted HTML. |
| Deep links 404 while hosting | Those pages were beyond the crawl depth and never got saved. Recapture with a higher depth. |
| A scripts-kept capture (Next.js, React) shows the framework's own "This page couldn't load" / error screen | The app booted and then threw. Before 2.8.1 the asset scan could corrupt the inline page-data scripts of a Next.js capture (a swallowed `\"` escape); re-extract the raw capture (**⋯ → Re-extract**) with 2.8.1 or later. If it persists, the browser console (F12) names the missing file or the failing call. |
| Hosting shows a completely different website | Another program is serving that port on the other network stack (a leftover `python -m http.server`, a dev server, …). Local Dev Studio now binds both loopbacks and skips such ports automatically — stop the other program, or just re-host and use the port Local Dev Studio reports. |
| Port already in use | Local Dev Studio walks forward from the default port automatically; change the default in Settings if you want a different range. |
| A dropped project says "failed to start" | Open **⋯ → How to serve this…** — the process's own output is at the bottom of the panel. Usually a missing install step, a command that wants a different flag, or an app that needs its `.env`. The command is editable; Save and host again. |
| The dev server needs a toolchain Local Dev Studio can't find | The command runs through your shell, so it needs `npm` / `python` / `php` / `docker` on PATH. Launching Local Dev Studio from a terminal where the tool works is the quickest way to confirm it. |

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
node scripts/smoke.js "dist\win-unpacked\Local Dev Studio.exe" --capture
```

That drives a real capture through the built exe's own UI and IPC — renderer → main → browser →
extract → thumbnail — and fails the exit code if any step doesn't finish.

### Layout

```
main.js          window, IPC, pipelines
preload.js       the only renderer bridge (allowlisted channels)
lib/accelerators.js  keyboard shortcuts (the app has no menu bar)
lib/browsers.js  Chromium detection
lib/capture.js   drives the bundled SingleFile CLI
lib/extract.js   snapshot -> editable files
lib/entry.js     which page is a capture's real homepage
lib/server.js    local host — files off disk, or a proxy to a project's dev server
lib/runtimes.js  what a folder needs to become a website (detection + commands + attach)
lib/runner.js    supervises that process: spawn, readiness, logs, kill the tree
lib/proxy.js     forwards requests (and HMR websockets) to it, injecting as it goes
lib/studioBrowser.js  the per-project browsing window (console capture, presets, Copy for agent)
lib/checklists.js     the built-in review checklists
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

### The overlay's embed API — `window.__ssBridge`

Pages served in review mode expose a small scripting surface on `window.__ssBridge`. It is how
Studio Browser's chrome drives the overlay, and how the acceptance tests script a review; treat
it as a public contract, not a debug hook. The useful calls:

| Call | What it does |
|---|---|
| `setAnnotating(on)` / `isAnnotating()` | flip or read annotate mode |
| `select(selector)` | select an element and open the annotation panel |
| `setInput({rating, severity, axes, why, want})` / `save()` | fill and save the open draft |
| `agentContext()` | the current selection/draft, shaped for "Copy for agent" |
| `editAnnotation(id)` / `openPin(id)` / `resolve(id, rating, asAnchor)` | work with saved notes |
| `export()` / `refresh()` / `cyclePins(step)` | what the toolbar buttons do |
| `embedded` | true inside a Studio Browser window |

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
