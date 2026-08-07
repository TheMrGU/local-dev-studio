// lib/secrets.js — [PRO] the app's one place for secrets (deploy tokens).
//
// Values go through Electron's safeStorage — the OS keychain / DPAPI does the
// actual encryption — and the ciphertext lands in userData/secrets.json with
// the same atomic tmp+rename discipline as every other file this app writes.
// Secrets never travel to the renderer: IPC answers "is one stored", never
// the value.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'secrets.json');

function loadRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function saveRaw(data) {
  const target = file();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

/** Store (or, with an empty value, forget) a secret. */
function set(key, value) {
  const data = loadRaw();
  if (!value) {
    delete data[String(key)];
    saveRaw(data);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system offers no safe place for the token (no keychain available) — it was not saved.');
  }
  data[String(key)] = safeStorage.encryptString(String(value)).toString('base64');
  saveRaw(data);
}

/** The secret, or null when missing or no longer decryptable. */
function get(key) {
  const raw = loadRaw()[String(key)];
  if (!raw) return null;
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    return null; // OS profile changed — the ciphertext is dead, treat as absent
  }
}

const has = key => !!loadRaw()[String(key)];

module.exports = { set, get, has };
