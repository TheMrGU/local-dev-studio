/* Build the MSIX/AppX package for a Microsoft Store submission.
 *
 * The Store re-signs whatever you upload with Microsoft's own certificate, which is why a
 * Store build is the only distribution path that never shows SmartScreen or an "unknown
 * publisher" prompt — and why it needs no code-signing certificate of your own.
 *
 * Three values have to match your Partner Center listing exactly, or the upload is rejected.
 * Get them from Partner Center -> your app -> Product identity, then either export them or
 * pass them inline:
 *
 *   set APPX_IDENTITY_NAME=1234NightShyftStudios.SiteSlurpStudio
 *   set APPX_PUBLISHER=CN=ABCD1234-5678-90EF-1234-567890ABCDEF
 *   npm run dist:store
 *
 * Without them you still get a package, but one that is only good for local sideload testing.
 * Requires Windows: the appx target shells out to makeappx.exe from the Windows SDK.
 */
'use strict';
const { spawnSync } = require('child_process');

const identityName = process.env.APPX_IDENTITY_NAME;
const publisher = process.env.APPX_PUBLISHER;
const publisherDisplayName = process.env.APPX_PUBLISHER_DISPLAY_NAME;

if (process.platform !== 'win32') {
  console.error('The appx target needs makeappx.exe from the Windows SDK, so this only runs on Windows.');
  process.exit(1);
}

const args = ['--win', 'appx'];
if (identityName) args.push(`-c.appx.identityName=${identityName}`);
if (publisher) args.push(`-c.appx.publisher=${publisher}`);
if (publisherDisplayName) args.push(`-c.appx.publisherDisplayName=${publisherDisplayName}`);

if (!identityName || !publisher) {
  console.warn('');
  console.warn('  ! APPX_IDENTITY_NAME and/or APPX_PUBLISHER are not set.');
  console.warn('  ! electron-builder will substitute development values, so the package that comes');
  console.warn('  ! out is sideload-test-only — Partner Center will reject it. See docs/windows-signing.md.');
  console.warn('');
}

const result = spawnSync('npx', ['electron-builder', ...args], { stdio: 'inherit', shell: true });
process.exit(result.status === null ? 1 : result.status);
