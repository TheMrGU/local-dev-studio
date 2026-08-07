# SiteSlurp Studio — Master Implementation Plan (v2.2.0 → 3.x)

**Audience:** a fresh coding agent with zero prior context, working in the SiteSlurp source repository.
**Repo:** `C:\Users\Gu\Desktop\Projects\SiteSnap` (the folder kept the pre-2.0 project name; it IS SiteSlurp Studio). Workflow: `npm test` (eslint + plain-node checks in `scripts/test.js`), `npm run smoke` (windowed selftest), `npm run e2e`, `npm run dist:installer` (NSIS → `dist/`). Gotcha: an installed copy of the app holds the single-instance lock — close it (`taskkill /IM "SiteSlurp Studio.exe"`) before `npm run smoke` or reinstalling.
**Scope:** every feature agreed for the next generation, tagged by edition. The open-source Lite build is cut from this same codebase (Part 8), so build order matters — Lite-tagged work comes first within each phase.

> This plan was drafted against v2.1.0 and reconciled against the v2.2.0 source, which already shipped run-any-stack runtimes (`lib/runtimes.js`, `lib/runner.js`, `lib/proxy.js`) and public sharing (`lib/tunnel.js`). Cited line numbers are v2.1.0-era — treat each as "search for the named symbol", never as an address. Work in the source repo, never in an installed build.

---

## Part 0 — Orientation (read fully before writing code)

### 0.1 What SiteSlurp is

SiteSlurp Studio captures any website into editable local files, hosts and manages those sites locally, and turns on-page design feedback into AI-ready specs. Two-tab Electron app:

- **Extractor tab** — paste URL → SingleFile CLI capture → extract into editable `html/css/assets` structure → thumbnail → library.
- **Studio tab** — library of projects (captured or drag-dropped local folders) → host each on its own localhost port → live-reload while editing → **Review Mode** (in-browser annotation overlay) → export `REVIEW.md` + `annotations.json` + `calibration.md` + `shots/` for an AI coding agent.

Since v2.2.0, a "project" is no longer only static files: `lib/runtimes.js` detects how a folder wants to be served (Next.js, Nuxt, Astro, SvelteKit, Angular, CRA, Remix, Vite, Express, Django, FastAPI, Flask, Streamlit, Laravel, plain PHP, Rails, Jekyll, Hugo, Go, Rust, Docker Compose, build-output dirs, or a custom command), `lib/runner.js` supervises the dev-server process on a private port, and `lib/proxy.js` fronts it on the project's stable SiteSlurp port with the overlay injected — so Review Mode works on real app stacks, not just captures. `lib/tunnel.js` adds one-switch public sharing via Cloudflare quick tunnels (cloudflared fetched on first use into `userData/bin`), with review tooling deliberately kept local-only on shared links.

### 0.2 Product thesis — what it is and is NOT

SiteSlurp is **a tool of its own class: the site bench.** It is where a developer *looks at, hosts, versions, annotates, and hands off* a website. It is deliberately **not** an editor, not an IDE, and not a Cursor/VS Code competitor. Editors edit; agents fix; SiteSlurp is where you look at the site and talk about it. Every feature must strengthen the loop **capture → host → review → hand off → verify** or be rejected.

Hard non-goals (do not build, even if easy):
- No embedded code editor of any kind. "Open in VS Code" is the editing story.
- No cloud requirement for the core loop. Everything single-player works offline.
- No framework rewrite of the renderer. It is vanilla JS + one CSS file, and stays that way.
- No feature that requires an account to use a local capability.

### 0.3 Architecture map

| File | Role |
|---|---|
| `main.js` | App lifecycle, IPC handlers, job lock (`claimJob`/`releaseJob`), review enrichment hook, `--selftest` |
| `preload.js` | contextBridge; **allowlists** every invoke channel and every main→renderer event |
| `renderer/app.js` | All UI logic (vanilla JS): tabs, library cards, modals, command palette, toasts |
| `renderer/index.html` | Strict CSP: `default-src 'none'; script-src 'self'; connect-src 'none'` — all I/O via preload bridge |
| `renderer/review-overlay.js` | Injected into hosted pages at serve time; shadow-root overlay; talks same-origin HTTP to `/__siteslurp__/review/*` |
| `lib/capture.js` | SingleFile CLI spawn, URL normalization, cancel via AbortController + `killTree` |
| `lib/extract.js` | Raw single-file HTML → editable structure; sha1 content-hash dedupe of assets |
| `lib/browsers.js` | Chromium-family detection (Win/mac/Linux tables + Win registry fallback) |
| `lib/server.js` | One `http.Server` per hosted folder; binds 127.0.0.1 **and** ::1; Range; no-store; refuses dot-segment paths |
| `lib/livereload.js` | SSE (`/__siteslurp__/events`), `fs.watch` recursive, 150ms debounce, CSS hot-swap |
| `lib/review.js` / `lib/reviews.js` | Review HTTP API + store (`userData/reviews/<projectId>/store.json`) |
| `lib/reviewExport.js` | Writes `_reviews/review-<slug>-<date>/` (REVIEW.md, annotations.json, calibration.md, shots/) |
| `lib/calibration.js` | Global taste memory: anchors + standing preferences (`userData/calibration.json`) |
| `lib/shots.js` | Offscreen element + context screenshots, serialized queue |
| `lib/thumbs.js` | Offscreen 1440×900 → 760px thumbnails, serialized queue |
| `lib/palette.js` | Color scan/apply/undo; undo snapshots in `<site>/.siteslurp/undo/<ts>/` (max 10) |
| `lib/library.js` / `lib/projects.js` | Library scan + registry (`userData/projects.json`); ports allocated from 4300 |
| `lib/sourceline.js` | Annotation element → `file:line` (unique matches only) |
| `lib/videofix.js` | Re-downloads videos SingleFile stripped |
| `lib/zip.js` | Hand-written streaming ZIP writer (deliberately no shell, no dep) |
| `lib/runtimes.js` | v2.2.0: detection table folder → runtime (static / command / custom), install steps, `{port}` substitution |
| `lib/runner.js` | v2.2.0: supervises dev-server children — free-port allocation, ready-probing, log ring buffer, port re-detection from logs, Windows tree-kill |
| `lib/proxy.js` | v2.2.0: fronts a running dev server on the project's stable port; buffers+injects HTML only, streams the rest, raw websocket upgrade passthrough (HMR), boot/failure page while starting |
| `lib/tunnel.js` | v2.2.0: Cloudflare quick tunnels (`share:*` IPC); fetches cloudflared on first use into `userData/bin`; `viaTunnel(req)` marks tunneled requests |
| `lib/entry.js` | Entry-page resolution (extracted from server/library — verify current shape) |
| `lib/settings.js` | `userData/settings.json`, atomic tmp+rename writes, every value sanitized/clamped |
| `lib/paths.js` | Resolves single-file-cli (must be asar-**unpacked**); runs it on Electron via `ELECTRON_RUN_AS_NODE=1` |
| `lib/accelerators.js` | Global shortcuts (native menu is removed entirely) |
| `lib/logger.js` | `userData/logs/siteslurp.log`, 1 MB rotation |

### 0.4 Non-negotiable invariants (violating any of these is a bug)

1. **Every new IPC channel** is added to the allowlist in `preload.js` AND its handler rejects senders whose frame URL isn't `file://` (see the guard around `main.js:342`).
2. **Renderer CSP stays strict.** No inline scripts, no remote resources, no `connect-src` — new UI talks only through the bridge.
3. **In-page code (overlay, injected clients) talks same-origin only** under the `/__siteslurp__/` prefix; cross-origin requests are refused (403). Body cap 2 MB.
4. **The server never serves a path segment starting with `.`** — snapshot/undo internals must never be URL-addressable directly.
5. **Path-safety gates**: mutating ops go through `assertInRoot`; host/review/thumb-class ops through `assertManaged`. New ops pick the correct gate.
6. **All settings writes are atomic** (tmp + rename) and **all values are clamped/sanitized on load** — copy the existing patterns in `lib/settings.js`.
7. **One heavyweight browser job at a time** (`claimJob`/`releaseJob`); offscreen render queues (thumbs, shots) stay serialized.
8. **Files on disk are never modified by hosting.** Live-reload/overlay/version scripts are injected at serve time only.
9. **Zero-dependency culture.** The app has ONE runtime dep (`single-file-cli`). Do not add a dependency for anything you can hand-write in <500 lines (they hand-wrote a ZIP writer; you can hand-write a line differ). Exceptions must be justified in the PR description (electron-updater is a granted exception, Phase 1.3).
10. **Windows filenames**: no `:` in folder names — timestamp folders use `2026-08-06T14-30-05Z` form, never raw ISO.
11. **Deleting user content goes to the OS trash** with a confirm dialog, never `rm -rf`.
12. **Tunneled requests never reach the tooling.** `viaTunnel(req)` gates Review Mode injection, the review POST API, and folder-revealing endpoints to local requests only. Guest review (Phase 5.1) may relax specific capabilities server-side, deliberately and with its own auth — never by removing the gate.
13. **Spawned dev servers get a clean environment**: `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE`, and `NODE_OPTIONS` are stripped (see `runner.js`); any new child-process feature must do the same.

### 0.5 House style — what "tastefully added" means here

- Every feature is reachable from the **command palette** (Ctrl+K) and, where relevant, a **card action or ⋯ overflow item**. Register commands in the palette data structure in `renderer/app.js`.
- Options get **plain-English labels with an explanatory sentence**, like the Extractor options disclosure. No jargon toggles.
- Long operations report via the **toast stack** (with optional action button, e.g. "Host now") and/or the run panel; never a blocking dialog.
- New surfaces reuse existing primitives: cards, right-side drawers (palette drawer), modals (settings/doctor/history), chips (hosting strip). Match `style.css` tokens; dark UI; `--titlebar-h` stays in sync with `TITLEBAR_HEIGHT`.
- **Settings sprawl is a smell.** Prefer per-project toggles in the card ⋯ menu (like Auto-start / Live reload) over global settings. New global settings need a clamp + default in `lib/settings.js`.
- Remove what you obsolete. Dead code (`ui:doctor`/`ui:about`/`ui:tab` events) gets deleted, not accreted.

### 0.6 Edition tags

- **[LITE]** — ships in the open-source build (MIT).
- **[PRO]** — paid Studio Pro only.
- **[BOTH]** — core plumbing both editions need.

Gating mechanism is Phase 7; until then, build everything in one tree behind `lib/edition.js`.

---

## Part 1 — Phase overview and build order

| Phase | Title | Tier weight | Depends on |
|---|---|---|---|
| 1 | Housekeeping, half-built finishers, cross-platform | LITE | — |
| 2 | **Versioning engine (Snapshots)** | LITE core, PRO extras | 1 |
| 3 | **Review mode: attach mode, Studio Browser, MCP handoff** | LITE core, PRO extras | 1 (3.5 needs 2) |
| 4 | Capture power (auth, batch, lazy content, recapture-as-version) | LITE core | 2 for 4.4 |
| 5 | Sharing & deploy (guest review, HTTPS, deploy — base tunnel already shipped) | PRO | 2, 3 |
| 6 | Library organization (tags, search, git-aware) | LITE | 1 |
| 7 | Edition split, packaging, AGPL resolution, CLI | BOTH | all |

Work phases in order; within a phase, items are ordered by dependency. Phases 2 and 3 are the product's heart — do not rush them.

---

## Phase 1 — Housekeeping & platform [LITE]

### 1.1 Finish the half-built surfaces

Small, high-trust wins. All plumbing already exists.

1. **Calibration manager UI.** Today anchors and standing preferences are write-only (only visible in exported `calibration.md`). Add a "Calibration" modal (command palette + Settings link): list standing preferences (edit/delete), list anchors with their screenshot, rating, axis, summary (delete; edit summary). New IPC: `calibration:get`, `calibration:update`, `calibration:removeAnchor`, `calibration:removePreference`. This is the product's moat — it deserves a first-class screen.
2. **In-app log viewer.** `log:tail` IPC already exists (`main.js:627`) with no consumer. Add a simple modal (command palette: "View log") rendering the tail with auto-refresh while open. Keep "Open log file" for the full file.
3. **Re-export historical reviews.** `exportReview({reviewId})` already supports it; the review-history modal (`renderer/app.js:964` area) gets a "Re-export" button per exported review and an "Export" button per open one.
4. **Entry page picker.** `projects.entryFile` is stored but has no UI. Card ⋯ menu → "Set entry page…" listing the project's HTML files; selection updates the registry and re-renders the thumbnail.
5. **Delete dead code**: `ui:doctor`, `ui:about`, `ui:tab` events — still in the v2.2.0 `preload.js` EVENTS allowlist; grep main for emitters to confirm they're still never sent before deleting. Helper exports that exist only as test seams — leave those.
6. **Surface `review:stop`** or remove it: add "End review mode" to the card ⋯ menu while a review is active (calls the existing handler).

### 1.2 Cross-platform (macOS first, Linux second)

The browser tables for mac/Linux already exist in `lib/browsers.js`. Fix the rest:

- `killTree`: `taskkill /T /F` is Windows-only; POSIX path exists — verify it on mac (process-group kill requires `detached: true`, which is already set for non-win32 spawns).
- Editor detection (`main.js:679-685`): hard-coded 5 Windows paths. Replace with per-platform candidate lists (VS Code, Insiders, Cursor on all three OSes) + `PATH` lookup for `code`/`cursor` as fallback.
- Registry probing must be skipped off-Windows (guard exists — verify).
- Trash wording: "Recycle Bin" → platform-neutral "system trash" (Electron `shell.trashItem` is already cross-platform).
- Titlebar: `titleBarOverlay` behaves differently on mac — use `hiddenInset` traffic lights on darwin; the JS fallback controls (`app.js:1133`) cover Linux.
- Default captures root probes (`lib/settings.js:40-52`) are Windows-shaped; keep them Windows-only and default to `~/Documents/SiteSlurp` elsewhere.
- CI: add mac + Linux runners for the `--selftest` smoke.

### 1.3 Update & crash pipeline

- `electron-updater` (approved dependency) with GitHub Releases feed; "A new version is ready" toast with Restart action. No silent restarts.
- Crash reporting stays **local-first**: the existing fatal-dialog + log is fine for Lite; Pro may add opt-in submission later. Do not add telemetry.

---

## Phase 2 — Versioning engine ("Snapshots") [LITE core]

The user-specified design, verbatim intent: reuse the `.siteslurp/` convention; generalize the palette-undo code rather than copying it; restores are non-destructive.

### 2.1 `lib/versions.js` — the core engine

**Storage layout** (per project):

```
<store>/blobs/<aa>/<sha1>            content-addressed file blobs (aa = first 2 hex chars)
<store>/versions/<stamp>/meta.json   one manifest per snapshot
```

- `<store>` = `<siteFolder>/.siteslurp/` for captures (inside captures root), but `userData/versions/<projectId>/` for **local** drag-dropped projects — mirroring the existing thumbs decision to never write into a user's own repo.
- `<stamp>` = UTC `YYYY-MM-DDTHH-mm-ssZ` (Windows-safe, sortable). Collision → append `-2`.
- `meta.json`: `{ id, label, source: 'manual'|'auto'|'palette'|'pre-restore'|'capture', timestamp, files: [{path, sha1, size, mtime}], stats: {files, bytes, newBlobs} }`.

**API** (all async, all cancel-safe):
- `createSnapshot(projectId, {label, source})` — walk site files (reuse the walk/skip rules from `lib/library.js` size-walk: skip dotfiles, `node_modules`, and also skip `thumb.png`); sha1 each file (hash helper already exists in `lib/extract.js` — export and share it, don't copy); write blobs that don't exist yet; write manifest. Return `{id, stats}`. **Skip if identical**: if the manifest would equal the latest snapshot's (same file set + hashes), return `{unchanged: true}` and write nothing.
- `listSnapshots(projectId)` — manifests sorted desc, cheap (no blob reads).
- `diffSnapshots(projectId, idA, idB)` — `{added, removed, changed}` from manifests only. `idB` may be `'working'` (hash the working tree).
- `readFileAt(projectId, id, relPath)` — stream a blob (for diff view and pinned serving).
- `restoreSnapshot(projectId, id)` — **first** `createSnapshot(source:'pre-restore', label:'Before restore')`, then make the working tree match the manifest (write blobs over files, delete files not in the manifest — safe because the pre-restore snapshot holds them). Never touch `.siteslurp/` itself. Refresh thumbnail after.
- `pruneSnapshots(projectId)` — policy: keep ALL `manual`/`pre-restore`/`capture` snapshots up to 50; keep the last 20 `auto` snapshots or 14 days, whichever is more; then garbage-collect blobs unreferenced by any surviving manifest. Model the code on palette's existing prune (`pruneUndo` pattern), generalized.

**Concurrency**: one snapshot op per project at a time (per-project promise queue, like the shots queue). Snapshot creation must tolerate files changing mid-walk (read errors on a file → skip it with a WARN, don't abort).

**IPC** (allowlist + `file://` guard, gate `assertInRoot` for captures / registry check for local): `version:create`, `version:list`, `version:diff`, `version:readFile`, `version:restore`.

### 2.2 Snapshot on demand — UI

- Card ⋯ menu: **"Snapshot now…"** → small prompt for an optional label → toast "Snapshot saved · 14:30" with action "History".
- Command palette: "Snapshot this site" (per-hosted-site dynamic rows already exist — extend that block).
- Keyboard: none globally (don't burn a chord); `Ctrl+S`-like behavior is deliberately NOT used (we are not an editor).

### 2.3 Auto-snapshot on idle

The `fs.watch` machinery in `lib/livereload.js` already sees every change. Generalize, don't duplicate:

- Extract the watcher into `lib/watch.js` exposing `watchFolder(dir, onEvent)` (same 150ms debounce, same ignore rules); livereload and versions both consume it. Live-reload behavior must remain byte-identical.
- `lib/versions.js` subscribes when a project is **hosted** (that's when edits happen): after a change burst, start an idle timer (default **45s**, clamp 10–600 via one global setting `autoSnapshotIdleSec`); on idle → `createSnapshot({source:'auto', label:''})`. The identical-content check in 2.1 makes this free when nothing really changed.
- Per-project toggle in card ⋯ menu: **"Auto-snapshot"** (registry field `autoSnapshot`, default `true` for extracted captures, default `false` for local projects — and if the local project contains `.git`, leave it off and don't nag: git users have history).
- Command-runtime projects (v2.2.0 dev-server projects): the watcher must additionally ignore common build-output churn (`.next`, `.nuxt`, `.astro`, `dist`, `build`, `out`, `.cache`, `vendor`, `__pycache__`, `target`) on top of the existing dotfile/`node_modules` rules — a dev server rebuilding must not trigger snapshots of its own output.
- Suppress auto-snapshots while a palette apply, restore, extract, or videofix is running (those create their own `source`-tagged snapshots or churn files transiently).
- Run `pruneSnapshots` after every auto-snapshot.

### 2.4 History & diff view

Extend the existing history modal (shell at `renderer/app.js:964`) into a two-tab **Project History** modal: **Reviews** (current content) and **Versions**.

Versions tab:
- List: stamp, label, source badge (manual/auto/palette/pre-restore/capture), file count, delta size. Actions per row: **Restore**, **Pin & view** (2.5), **Diff against…**.
- Diff view: pick two versions (or version ↔ working). File list grouped added/removed/changed. Clicking a changed text file (`.html/.css/.js/.json/.svg`) shows a line diff; clicking an image shows before/after side-by-side (blobs streamed via `version:readFile`).
- **Write the line differ by hand** in `lib/diff.js` (LCS on lines, standard O(ND) Myers is ~150 lines) — no dependency. Render with minimal styling: green/red line backgrounds, context collapsed to 3 lines with expanders.
- Palette drawer's History list migrates to read palette-sourced snapshots from the new engine (see 2.6).

### 2.5 Pinned serving — `?v=<id>`

Reviewers (and share links, Phase 5) can view a pinned snapshot:

- `lib/server.js`: on request, resolve the pin: `?v=<id>` sets cookie `__ss_version=<id>; Path=/` and redirects to the clean URL; `?v=live` clears it. With a pin cookie present, file resolution goes through `versions.readFileAt` instead of disk (same MIME table, same Range support; still refuse dot-segments in the *requested* path — blob paths are internal only).
- Inject a slim **pin banner** (same injection point as live-reload client): "Viewing snapshot *label · stamp* — Back to live". Serve-time only, per invariant 8.
- While pinned: live-reload client is NOT injected; review overlay IS injected but **annotation saving is disabled** with a tooltip ("annotations target the live version") — the overlay's state endpoint gains a `pinned: true` flag.
- Studio: "Pin & view" in the Versions tab opens the browser at `?v=<id>`.
- **Static/extracted projects only.** A command-runtime project's rendered output isn't a function of its files alone, so pinned *serving* is meaningless there — hide "Pin & view" and the share version picker for command runtimes (snapshot/restore/diff of the source folder still works).

### 2.6 Palette migration

- `lib/palette.js` stops writing `.siteslurp/undo/` — pre-apply it calls `versions.createSnapshot({source:'palette', label:'Before recolor #a1b2c3 → #d4e5f6'})`; revert = `restoreSnapshot`.
- Keep **read-only** support for legacy `.siteslurp/undo/` and `.sitesnap/` entries in the history list (label "legacy"), restorable via the old code path. No migration rewrite of old sites.

**Done when:** snapshot → edit → auto-snapshot → diff shows the edit → restore brings it back AND leaves a pre-restore snapshot → `?v=` serves the old state while live serving is unchanged → palette undo works through the new engine → selftest covers create/diff/restore/prune.

---

## Phase 3 — Review mode: best-in-class

This phase is the product. Budget the most care here.

### 3.1 Attach to an already-running server + proxy polish [LITE]

**Mostly shipped in v2.2.0** — read `lib/runtimes.js`, `lib/runner.js`, `lib/proxy.js` before touching this. SiteSlurp already *runs* a project's dev server itself (detected or custom command, supervised, private port) and fronts it on the project's stable port with overlay injection, streaming passthrough, raw websocket upgrade forwarding (HMR works), and a self-refreshing boot page. Do NOT rebuild any of that.

What remains:

1. **Attach mode — front a server the developer started themselves.** A developer already running `npm run dev` in their own terminal shouldn't have to let SiteSlurp own the process to get Review Mode. Add a runtime `{kind:'command', id:'attach', appPort:<port>}` variant with no command: `runner` skips spawning and reports `ready` when `portAnswers(appPort)` (helper already exists in `runner.js`), `failed` with a friendly message when it stops answering. UI: the runtime panel's candidate list gains **"Already running — just connect"** with a port field; Studio empty-state and command palette gain **"Attach to a dev server…"** creating a local project of that shape (folder optional — without one, sourceline and snapshots are disabled and the card says `attached → :3000`).
2. **Loopback guard:** attach targets are restricted to `127.0.0.1`/`localhost`/`::1`. Refuse anything else — this must not become an open proxy.
3. **CSP header handling in the proxy.** `proxy.js` injects into HTML but does not touch upstream CSP headers; a dev server sending a strict CSP could block the overlay script. Test against Next.js and Vite defaults; if blocked, minimally rewrite the header (the overlay is same-origin, so a `script-src 'self'` allowance usually suffices) and log a WARN whenever a rewrite happens.
4. **Sourceline honesty for command runtimes:** `file:line` mapping doesn't apply to framework-served pages. Verify what `sourceline.js` does for command/attach projects (it grew in v2.2.0) — `sourceFile` must stay empty rather than guessed, and REVIEW.md should say "selector-only (dev server)".

### 3.2 Studio Browser — the Cursor-browser analog, SiteSlurp-flavored [LITE]

A dedicated browsing window that makes SiteSlurp the best place to *look at* a site. Not an editor, not devtools — a review instrument.

**Shape:** separate `BrowserWindow` per project ("Open in Studio Browser" — card thumb click alternative, ⋯ item, command palette). Custom top chrome (reuse titlebar patterns) + a `WebContentsView` filling the rest, loaded on the project's hosted/proxied URL (overlay auto-injected by the server as always).

**Top chrome, left → right:**
- Back / forward / reload; current path (read-only, click to copy).
- **Viewport presets** 375 / 768 / 1440 / Full + free-drag resize handle; presets resize the *view*, not popups (supersedes the overlay's popup buttons — remove those from the overlay toolbar when running inside Studio Browser; keep them for external-browser review).
- **Version picker** (Phase 2.5): dropdown of snapshots → pins/unpins via the cookie mechanism.
- **Annotate toggle** (drives the overlay via `window.__ssReview` — the debug surface at `review-overlay.js:871-903` becomes the official embed API; rename to `window.__ssBridge` and document it).
- **Screenshot** (full-page PNG → `userData/shots/manual/`, toast with "Open folder").
- **Console drawer toggle**.

**Console & network drawer (bottom):**
- Capture via `webContents` `'console-message'` events (main-side listener; nothing injected — invariant 8) into a ring buffer (last 500). Filter chips: errors / warnings / logs / network failures (`did-fail-load`, response codes ≥400 via `webRequest`).
- **Every annotation saved while the drawer has errors** automatically attaches the last 20 console entries (timestamped) to the annotation's context (`consoleTail` field). REVIEW.md renders them in a fenced block under the annotation. Agents love a stack trace next to "this button is broken".

**"Copy for agent" (the headline interaction):** with an element selected in annotate mode, one button copies a self-contained markdown block to the clipboard — selector, fallback selector, `file:line` (when known), viewport, computed-styles one-liner, outerHTML snippet, screenshot file path, recent console errors. Exactly the REVIEW.md per-annotation format (reuse `reviewExport`'s renderer — extract the per-annotation formatter into a shared function; do not duplicate it). This is the Cursor-browser moment: point at a thing, paste it into any agent chat.

**Done when:** open Studio Browser → resize through presets → annotate an element → console error attached → Copy-for-agent pastes a complete spec block → version picker flips between live and a snapshot.

### 3.3 Overlay refinements [LITE]

Targeted, tasteful upgrades to `review-overlay.js`:

- **Element navigation**: ArrowUp exists (parent); add ArrowDown (back into the previously-selected child) and a small ancestor breadcrumb strip in the panel (click to jump).
- **Edit** a saved annotation (currently only resolve/delete): reopen the panel pre-filled; `review:update` endpoint exists (`POST update`).
- **Design reference overlay**: annotation panel gains "Attach reference image…" (file picker via a new same-origin upload endpoint, 2 MB cap applies) → shown in the panel and exported; plus a page-level "Overlay image" tool: position a reference at 0–100% opacity over the page (serve-time-injected UI, CSS `pointer-events: none`), with a slider. Generalizes the existing reference-picker (which stays for cross-project element references).
- **Checklists**: optional review template — a small set of built-in checklists (a11y basics, responsive pass, pre-launch) shown as tickable prompts in the site-note panel; ticked items export as global notes. Templates are JSON in `lib/checklists.js`; Pro can add custom ones later. Keep it to 3 built-ins.
- Keyboard pass: `A` toggles annotate, `E` export, `[`/`]` cycle pins — document in a `?` cheatsheet popover on the toolbar.

### 3.4 Agent handoff — MCP server [LITE] + control API [BOTH]

Ship the folder export AND a live connection.

**Control API (`lib/control.js`):** the app already runs HTTP servers; add one loopback **control server** on a random port, bearer token; write `{port, token}` to `userData/control.json` (0600 perms where supported, rewritten each launch). Endpoints (JSON, token-gated): list projects; list/get annotations (full context incl. shot paths); resolve/update annotation; get/append calibration; list/create snapshots; get review export (runs `exportReview`, returns paths); host/stop project. This is a thin wrapper over existing managers — no new logic.

**MCP server (`mcp/` entry):** a pure-Node stdio script (run via the Electron binary with `ELECTRON_RUN_AS_NODE=1`, same trick as single-file — `lib/paths.js`), thin client of the control API. If `control.json` is stale/app not running → single clear error: "SiteSlurp Studio isn't running. Start it and retry." (v1 requires the app running; do not build headless mode yet).

Tools to expose: `list_projects`, `list_annotations(project, status)`, `get_annotation(id)`, `resolve_annotation(id, note, afterRating?)`, `get_calibration`, `create_snapshot(project, label)`, `export_review(project)`. Resources: latest `REVIEW.md` and `calibration.md` per project.

**Setup UX:** Settings → "Agent access" section with the ready-to-paste config snippet for Claude Code / Cursor (`claude mcp add siteslurp -- "<exe>" --mcp`), and a copy button. Add `--mcp` argv handling in `main.js` (before app init: if `--mcp`, run the stdio client and exit — never open a window).

**The loop this enables:** agent reads open annotations → fixes code → file watcher auto-snapshots (Phase 2.3) → agent calls `resolve_annotation` → resolve flow feeds calibration. Document this loop in the README — it's the pitch.

### 3.5 Verification loop [PRO]

Close the loop visually:

- On `resolve_annotation` (or manual resolve), re-shoot the element with `lib/shots.js` (queue already serialized) → `<id>_after_el.png` / `_after_ctx.png`.
- **Pixel diff in main**: `nativeImage` → `toBitmap()` → per-pixel BGRA compare (count of pixels differing beyond a threshold / total) — ~40 lines, no dependency. Store `diffScore` on the annotation.
- Pin popup and REVIEW.md show before/after pairs; `diffScore === 0` on a visual annotation triggers a gentle flag: "resolved but nothing changed visually — reopen?".
- **Stale detection**: on review-mode start, re-shoot each open annotation's element cheaply (existing orphan check already re-resolves selectors); if the element changed visually since annotation, badge the pin "changed since noted".

### 3.6 Automated audits [PRO]

- Run against the hosted port, merge into the export with the same severity/axis schema, clearly badged `[auto]`.
- **Accessibility**: inject axe-core (vendored, pinned) into an offscreen window; map violations → annotations (selector included — they slot straight into the existing pipeline).
- **Broken links**: crawl the hosted site's internal links (cheap HEAD requests to self) — this one is nearly free, consider [LITE].
- **Lighthouse**: spawn against the local port using the detected Chrome; parse JSON output; summarize scores in REVIEW.md header. Heavier — keep behind a "Run audits" button in the review toolbar, never automatic.

---

## Phase 4 — Capture power [LITE core]

### 4.1 Sessions & authenticated capture

The #1 capture gap. Two mechanisms, in order:

1. **Persistent capture profile**: add `--browser-data-dir` style profile reuse — a per-app (later per-project) Chromium profile directory under `userData/capture-profile/`. Flow: "Log in for capture…" button (Extractor options) launches the browser headed on that profile (via single-file-cli's browser args or a direct spawn) so the user logs in once; subsequent captures (headed or headless) reuse the profile → cookies/sessions persist. Check single-file-cli's supported flags first (`options.js` in the dep) — prefer its documented options over raw Chromium args.
2. **Cookie import**: accept a Netscape `cookies.txt` / JSON cookie file per capture (single-file-cli has cookie flags — verify exact names in its `options.js`). UI: Extractor options → "Use cookies file…".

Custom headers (e.g. staging basic-auth) if single-file-cli supports header injection; otherwise document the headed-profile path as the answer and skip.

### 4.2 Batch capture & crawl scoping

- **URL queue**: the Extractor input accepts multiple lines / paste of a URL list; each becomes a queued job (sequential — keep the single-browser-job invariant; show queue position in the run panel; per-item cancel).
- **Sitemap ingestion**: if the pasted URL is `…/sitemap.xml` (or "Crawl from sitemap" toggle), fetch it, list URLs into the queue as a single project's page set (capture with `--crawl-links=false` per page into one folder).
- **Scope controls** in Options: include/exclude URL patterns (simple `*` globs, matched against pathname) passed to the crawl via single-file-cli's rewrite/filter options if available, else post-filtered; **max pages** cap (default 100, clamp 1–1000) — the crawl is killed cleanly when reached, partial capture kept and marked in the manifest.
- Registry: batch/sitemap captures still produce ONE project.

### 4.3 Lazy-content handling

- Check single-file-cli's auto-scroll/behavior flags (`options.js`); expose as "Scroll the page before saving (for lazy-loaded content)" with none/full choices. If the CLI lacks it, add a scroll behavior via its scripts hook if present; otherwise defer — do NOT hand-roll CDP scrolling in v1.

### 4.4 Re-capture as version (ties into Phase 2)

- Card ⋯ menu on captures with a `sourceUrl`: **"Re-capture…"** → runs the same capture config into a temp folder, then: `createSnapshot(source:'capture', label:'Before re-capture')` on the extracted project → replace working files with the fresh extract → thumbnail refresh. Old state is fully restorable and diffable through the Versions tab — "what changed on this site since May" falls out of the Phase 2.4 diff view for free.
- Store capture options used in `siteslurp.json` so re-capture repeats them exactly.

### 4.5 Archive formats [deferred]

WARC/WACZ and MHTML export: park until after Lite launch. Leave a stub note in the roadmap; do not scaffold.

---

## Phase 5 — Sharing & deploy [PRO]

Requires 2 (pinning) and 3 (overlay). Build after the Lite cut is stable.

### 5.1 Guest review over share links

**The tunnel itself shipped in v2.2.0** (`lib/tunnel.js`, `share:start/stop/state` IPC): Cloudflare quick tunnels, cloudflared found on PATH or fetched once into `userData/bin`, random `trycloudflare.com` URL, and — invariant 12 — tunneled requests are locked out of all review tooling via `viaTunnel(req)`. Basic sharing stays **[LITE]** (it already shipped free; never claw a shipped feature back into Pro).

What remains, all [PRO]:

- **Guest overlay mode**: a shared origin gets the overlay in guest mode — annotate-only (no export, no reference picker, no resolve/delete, no version restore), a "Reviewing as guest" banner, and a name prompt stored per-annotation (`author` field; local annotations default to "me"). Implementation: a per-share capability token embedded in the share URL (`?review=<token>`), checked server-side on every `/__siteslurp__/review/*` request arriving via tunnel — the `viaTunnel` gate stays; the token selectively re-enables `state` + `annotate` only. Strip capabilities server-side, not in UI.
- **Version-pinned share links** (user requirement): the Share modal gains a version picker — the generated link carries `?v=<id>` (Phase 2.5), so reviewers see a pinned state while work continues on live. Pinned guest views allow annotations **only if** the pinned version is still the latest at save time; otherwise the API answers a friendly "this page has moved on" and stores the pinned version id on the note for context.
- **Hardening**: rate-limit review endpoints for tunneled requests (token bucket per cf-connecting-ip); body cap already 2 MB; annotation flood cap per guest per hour; a "Shared — 3 guests viewing" indicator on the hosting chip would be tasteful but optional.
- **macOS parity**: `ensureBinary` currently refuses the `.tgz` cloudflared asset (points at `brew install cloudflared`). Acceptable for now — revisit with Phase 1.2 platform work.

### 5.2 HTTPS & local domains

Self-signed local CA (generated once, user-installable cert) + `*.slurp.localhost` names (resolve to 127.0.0.1 without hosts-file edits on modern OSes). Opt-in per project. Needed for secure-context APIs and realistic cookie testing.

### 5.3 Deploy

"Publish…" card action: Netlify / Vercel / GitHub Pages / plain SFTP adapters, deploying the working tree or a chosen snapshot (manifest → file set — snapshots make deploys reproducible). Store tokens in OS keychain (`safeStorage`). One adapter first (Netlify), interface designed for more.

---

## Phase 6 — Library & organization [LITE]

### 6.1 Tags, clients, search

- `projects.tags` already exists in the registry — surface it: card ⋯ → "Tags…" (freeform chips, autocomplete from existing), filter bar gains tag pills, sort/group by tag. An agency's "client" is just a tag — do not build a separate client entity.
- **Full-text search**: build a lightweight index at extract time (`.siteslurp/search.json`: per page, title + visible text, stripped of tags — extraction already parses every page, hook it there). Library filter searches names/URLs/tags; a "Search inside sites" mode (command palette: "Search site contents") queries the indexes and lists matching pages with a snippet, click → hosts + opens the page. Hand-rolled inverted index or even linear scan is fine at this scale; no dependency.

### 6.2 Git-aware behavior

Not git integration — git *awareness* (snapshots are the zero-config history; git users already have history):
- If a local project contains `.git`: auto-snapshot defaults off (done in 2.3), and the Versions tab shows a hint "This project uses git — snapshots are still available for quick pin/diff".
- Card ⋯ → "Open in VS Code" already exists; add nothing else. Do NOT shell out to git.

---

## Phase 7 — Edition split, packaging, AGPL [BOTH]

### 7.1 Edition gating

- `lib/edition.js`: `{ edition: 'lite'|'pro', has(feature) }`, driven by a build-time define + (pro) license file check. Every PRO feature checks `edition.has('verify')` etc. at its entry points (IPC handler + UI registration), so the Lite build simply never registers those commands/menu items — no greyed-out upsell chrome in the OSS app beyond a single "Studio Pro" line in About.
- Repo strategy: **open-core, one public repo** (`siteslurp`) containing everything Lite; Pro modules live in a private repo consumed as a build overlay (`pro/` folder injected at package time). Keep Pro modules' surface small: verify-loop, audits, tunnels/share, deploy, custom checklists.

### 7.2 AGPL resolution (before charging money)

`single-file-cli` is AGPL-3.0, currently bundled (see `THIRD-PARTY-NOTICES.md`, which documents the reasoning). Decision for Pro: **stop bundling** — first-run "Setup" step downloads/installs single-file-cli (`npm i -g` or a direct fetch into `userData/tools/`, checksum-pinned), with the doctor modal reflecting it. `lib/paths.js` already falls back to a global install, so this is mostly installer/doctor work. Lite may keep bundling (its MIT source satisfies the source-availability spirit), but unifying both on install-on-first-run is simpler — do that.

### 7.3 CLI companion [LITE]

`siteslurp` bin (the Electron exe with argv modes, like `--mcp`): `siteslurp capture <url> [--depth N …]`, `siteslurp host <path>`, `siteslurp snapshot <path> [--label]`, `siteslurp export-review <project>`. Headless (`app.dock`/window suppressed). Enables CI usage and scripting. Reuse the selftest plumbing (`main.js:781`) for the windowless bootstrap.

### 7.4 Packaging & release

- electron-builder targets: Windows NSIS (exists), macOS dmg+notarization, Linux AppImage+deb.
- Release checklist: version bump, selftest matrix green on 3 OSes, THIRD-PARTY-NOTICES regenerated, updater feed published, pinned single-file-cli version noted in release notes (AGPL source pointer).

---

## Part 8 — Lite (OSS) launch checklist

The Lite cut = everything tagged [LITE] above. Launch gate:

- [ ] Phases 1, 2, 3.1–3.4, 4.1–4.4, 6 complete; 3.5/3.6 and the PRO parts of 5 absent (not stubbed — absent). Run-any-stack runtimes and basic tunnel sharing stay in Lite (they shipped free in v2.2.0).
- [ ] mac + Windows builds green; Linux best-effort.
- [ ] README: the agent-loop pitch (annotate → MCP → fix → auto-snapshot → resolve), 90-second GIF, comparison table vs SingleFile/HTTrack/ArchiveBox (capture) and Agentation (review).
- [ ] `CONTRIBUTING.md` documenting Part 0 invariants verbatim — they are the review bar for PRs.
- [ ] License: MIT app + install-on-first-run single-file-cli (7.2).
- [ ] `--selftest` extended to cover: snapshot lifecycle, proxy attach + overlay injection, MCP tool round-trip, capture with profile.
- [ ] No telemetry, no account, no upsell nags. One "Studio Pro" line in About.

## Part 9 — Testing strategy

- Extend the existing `--selftest`/`npm run smoke` harness (env-driven: `SLURP_SELFTEST_*`) — it already drives the real app; add scenario flags per phase (`SLURP_SELFTEST_SHOW=versions|proxy|mcp`).
- Unit-testable pure modules (`diff.js`, `versions.js` manifest logic, `zip.js`) get plain `node:test` files — no framework.
- Manual test matrix per release: capture a JS-heavy site, a cookie-walled site (profile flow), attach to a Vite dev server (HMR must survive), full review→export→MCP resolve loop, snapshot/restore/pin on Windows paths with spaces.
- Every phase's "Done when" block is the acceptance test — implement it as a selftest scenario where feasible.

## Part 10 — Working agreements for the implementing agent

1. Read Part 0 before every phase; re-read invariants before touching `server.js`, `preload.js`, or the overlay.
2. One phase per PR-sized chunk; each chunk leaves the app fully working (`npm run smoke` green).
3. When this plan references a line number, verify it in the current tree first.
4. When single-file-cli capabilities are assumed (4.1, 4.2, 4.3), read `node_modules/single-file-cli/options.js` and confirm flag names before designing UI around them.
5. Prefer generalizing existing code over adding parallel implementations (watcher → `watch.js`, hash → shared helper, exporter → shared formatter). If you find yourself copying a function, stop and extract it.
6. Anything ambiguous: choose the option that keeps SiteSlurp *an instrument for looking at sites*, not an editor.
