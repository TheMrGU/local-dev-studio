// lib/logger.js — append-only log file in userData, rotated at 1 MB.
// Anything that goes wrong in a packaged build has to land somewhere the user
// (or we) can read afterwards; there's no console attached to a windowed exe.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 1024 * 1024;
let stream = null;
let cachedPath = null;

function logPath() {
  if (!cachedPath) cachedPath = path.join(app.getPath('userData'), 'logs', 'siteslurp.log');
  return cachedPath;
}

function open() {
  if (stream) return stream;
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, '.prev.log'));
  } catch { /* no existing log */ }
  stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => { stream = null; }); // never let logging crash the app
  return stream;
}

function format(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function write(level, args) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${args.map(format).join(' ')}\n`;
  try { open().write(line); } catch { /* disk full / read-only — keep going */ }
  if (level === 'ERROR') console.error(line.trimEnd());
  else console.log(line.trimEnd());
}

// Last N lines, for the in-app log viewer.
function tail(lines = 400) {
  try {
    const text = fs.readFileSync(logPath(), 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

module.exports = {
  logPath,
  tail,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
