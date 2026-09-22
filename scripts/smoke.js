/* Launch SiteSlurp, screenshot the UI, make sure it actually rendered.
 * With --capture, it also drives the capture form for real and waits for the result,
 * which exercises renderer -> ipc -> browser -> extract -> thumbnail end to end.
 *
 *   npm run smoke                                        # dev build, UI only
 *   node scripts/smoke.js "dist\win-unpacked\SiteSlurp Studio.exe" --capture
 *   node scripts/smoke.js "dist\win-unpacked\SiteSlurp Studio.exe" --capture https://site.com
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const captureIndex = argv.indexOf('--capture');
const captureUrl = captureIndex === -1
  ? null
  : (argv[captureIndex + 1] && !argv[captureIndex + 1].startsWith('--') ? argv[captureIndex + 1] : 'https://example.com');
const target = argv.find((arg, i) => i !== captureIndex && arg !== captureUrl && !arg.startsWith('--'));
const out = path.join(os.tmpdir(), 'siteslurp-smoke.png');
fs.rmSync(out, { force: true });

// In plain Node, require('electron') resolves to the path of the binary —
// electron.exe, Electron.app/…/Electron or electron, whichever this OS uses.
const [command, args] = target
  ? [path.resolve(target), ['--selftest']]
  : [require('electron'), [path.join(__dirname, '..'), '--selftest']];

if (!fs.existsSync(command)) {
  console.error(`Not found: ${command}`);
  process.exit(1);
}

console.log(`launching ${path.basename(command)}${captureUrl ? ` and capturing ${captureUrl}` : ''}…`);
const child = spawn(command, args, {
  env: {
    ...process.env,
    SLURP_SELFTEST_OUT: out,
    ...(captureUrl ? { SLURP_SELFTEST_URL: captureUrl } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', d => { output += d; });
child.stderr.on('data', d => { output += d; });

const budget = captureUrl ? 420000 : 90000;
const timer = setTimeout(() => {
  console.error(`timed out after ${budget / 1000}s — killing`);
  child.kill();
}, budget);

child.on('close', code => {
  clearTimeout(timer);
  const lines = output.split(/\r?\n/).filter(l => /ERROR|Error|error/.test(l) && !/^\s*$/.test(l));
  if (code !== 0) {
    console.error(`FAIL — exited ${code}`);
    if (output.trim()) console.error(output.trim().slice(-2000));
    process.exit(1);
  }
  if (!fs.existsSync(out)) {
    console.error(`FAIL — no screenshot written (exit ${code})`);
    if (output.trim()) console.error(output.trim().slice(-2000));
    process.exit(1);
  }
  const bytes = fs.statSync(out).size;
  // A blank or unpainted window compresses to almost nothing.
  if (bytes < 15000) {
    console.error(`FAIL — screenshot is only ${bytes} bytes, the window probably never painted`);
    process.exit(1);
  }
  console.log(`ok — window rendered${captureUrl ? ' and the capture pipeline finished' : ''}, `
    + `screenshot ${Math.round(bytes / 1024)} KB at ${out}`);
  const ipc = /selftest ipc: (.+)/.exec(output);
  if (ipc) console.log(`     ipc: ${ipc[1].trim()}`);
  if (lines.length) {
    console.log('\nmessages worth a look:');
    for (const line of lines.slice(0, 12)) console.log('  ' + line.trim());
  }
});
