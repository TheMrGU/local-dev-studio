# Third-party notices

SiteSlurp itself is MIT licensed (see `LICENSE`). The distributed application also
contains the following components under their own terms.

## single-file-cli — AGPL-3.0

- Upstream: https://github.com/gildas-lormeau/single-file-cli
- Version: see `node_modules/single-file-cli/package.json`
- Full license text ships with the app at
  `resources/app.asar.unpacked/node_modules/single-file-cli/LICENSE`
- Included **unmodified**, and invoked as a **separate process** through its documented
  command-line interface. SiteSlurp does not link against it, share memory with it, or
  expose it over a network.

**If you redistribute a SiteSlurp build**, the AGPL-3.0 obligations for this component travel
with it: recipients must get the license text (it ships inside the app) and must be able to
obtain the corresponding source. Because the copy is unmodified, linking to the upstream
repository at the version shipped is the usual way to satisfy that — pin the version in your
release notes.

Whether bundling an AGPL tool that is invoked at arm's length as a subprocess makes the whole
distribution a single combined work is a judgment call, not a settled fact. Separate-process
CLI invocation is the conventional aggregation pattern, but if you plan to sell or widely
distribute SiteSlurp and want that risk at zero, the alternative is to stop bundling it: remove
`single-file-cli` from `dependencies` and `build.asarUnpack`, and let users install it
themselves with `npm i -g single-file-cli` (SiteSlurp already detects a global install and
falls back to it). That trade costs you the zero-install setup.

### Its own dependencies

| Component | License | Role |
| --- | --- | --- |
| `simple-cdp` | MIT | Chrome DevTools Protocol client |
| `ws` | MIT | WebSocket transport for CDP |

## Electron — MIT

- License text: `LICENSE.electron.txt` next to the executable.

## Chromium and its dependencies — BSD-3-Clause and others

- Full notices: `LICENSES.chromium.html` next to the executable.

## The browser SiteSlurp drives

SiteSlurp launches a Chromium-based browser already installed on the user's machine (Edge,
Chrome, Brave, Vivaldi, Opera or Chromium). That browser is not redistributed with SiteSlurp.

## Captured content

Captured websites are third-party content and remain the property of their owners. SiteSlurp is
a tool for reference captures and client work on sites you are authorised to copy; respect
copyright, terms of service and `robots.txt` when deciding what to capture.
