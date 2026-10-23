# Third-party notices

Local Dev Studio itself is MIT licensed (see `LICENSE`). The distributed application also
contains the following components under their own terms.

## single-file-cli — AGPL-3.0

- Upstream: https://github.com/gildas-lormeau/single-file-cli
- Version: see `node_modules/single-file-cli/package.json`
- Full license text ships with the app at
  `resources/app.asar.unpacked/node_modules/single-file-cli/LICENSE`
- Included **unmodified**, and invoked as a **separate process** through its documented
  command-line interface. Local Dev Studio does not link against it, share memory with it, or
  expose it over a network.

**If you redistribute a Local Dev Studio build**, the AGPL-3.0 obligations for this component travel
with it: recipients must get the license text (it ships inside the app) and must be able to
obtain the corresponding source. Because the copy is unmodified, linking to the upstream
repository at the version shipped is the usual way to satisfy that — pin the version in your
release notes.

Whether bundling an AGPL tool that is invoked at arm's length as a subprocess makes the whole
distribution a single combined work is a judgment call, not a settled fact. Separate-process
CLI invocation is the conventional aggregation pattern, but if you plan to sell or widely
distribute Local Dev Studio and want that risk at zero, the alternative is to stop bundling it: remove
`single-file-cli` from `dependencies` and `build.asarUnpack`, and let users install it
themselves with `npm i -g single-file-cli` (Local Dev Studio already detects a global install and
falls back to it). That trade costs you the zero-install setup.

### Its own dependencies

| Component | License | Role |
| --- | --- | --- |
| `simple-cdp` | MIT | Chrome DevTools Protocol client |
| `ws` | MIT | WebSocket transport for CDP |

## axe-core — MPL-2.0

- Upstream: https://github.com/dequelabs/axe-core
- Version: **4.13.0**, vendored **unmodified** as `vendor/axe.min.js`
  (sha256 `c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1`)
- License: Mozilla Public License 2.0 — https://www.mozilla.org/en-US/MPL/2.0/
- Role: injected into an offscreen window by the "Run audits" feature to scan hosted
  pages for accessibility violations. It is a pinned single-file distribution, not an
  npm dependency; the file is used as-is (MPL's file-level copyleft is satisfied by
  shipping it unmodified with this notice pointing at the upstream source).

## Electron — MIT

- License text: `LICENSE.electron.txt` next to the executable.

## Chromium and its dependencies — BSD-3-Clause and others

- Full notices: `LICENSES.chromium.html` next to the executable.

## The browser Local Dev Studio drives

Local Dev Studio launches a Chromium-based browser already installed on the user's machine (Edge,
Chrome, Brave, Vivaldi, Opera or Chromium). That browser is not redistributed with Local Dev Studio.

## Captured content

Captured websites are third-party content and remain the property of their owners. Local Dev Studio is
a tool for reference captures and client work on sites you are authorised to copy; respect
copyright, terms of service and `robots.txt` when deciding what to capture.
