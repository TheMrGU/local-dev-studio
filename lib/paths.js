// lib/paths.js — locate bundled resources in both dev and packaged builds.
const path = require('path');
const { app } = require('electron');

// electron-builder packs the app into resources/app.asar; anything matched by
// build.asarUnpack lands in resources/app.asar.unpacked instead. Node's ESM loader
// can't read from inside an asar, so the bundled SingleFile CLI must live unpacked.
function unpackedRoot() {
  return app.getAppPath().replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
}

function bundledModule(...segments) {
  return path.join(unpackedRoot(), 'node_modules', ...segments);
}

// Electron's own binary doubles as a Node runtime when ELECTRON_RUN_AS_NODE is set,
// which is why users don't need Node.js installed.
function nodeEnv(extra = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extra };
  // Never let a stray NODE_OPTIONS from the user's shell break the child.
  delete env.NODE_OPTIONS;
  return env;
}

module.exports = {
  unpackedRoot,
  bundledModule,
  nodeEnv,
  nodeBinary: () => process.execPath,
};
