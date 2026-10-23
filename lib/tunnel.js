// lib/tunnel.js — a public https link for a hosted site, through a Cloudflare
// quick tunnel.
//
// "Share" has to mean one switch: no account, no config file, no router or
// firewall changes. A quick tunnel is the one primitive that delivers that —
// cloudflared dials out to Cloudflare's edge and is handed a random
// https://….trycloudflare.com address that forwards to a local port. Nothing
// on the machine listens for inbound connections; killing the process kills
// the link. The address is random by design (Cloudflare only hands out named
// hostnames to accounts with a domain), so the link is shareable but not
// guessable — which is the right default for "show a client the site".
//
// The binary is ~60MB — too heavy to ship in every installer for a feature
// many users never touch — so it's fetched once from Cloudflare's GitHub
// releases on first share and kept in the app's data folder.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const ASSETS = {
  'win32:x64': 'cloudflared-windows-amd64.exe',
  'win32:arm64': 'cloudflared-windows-amd64.exe', // no native arm64 build; x64 runs emulated
  'darwin:x64': 'cloudflared-darwin-amd64.tgz',
  'darwin:arm64': 'cloudflared-darwin-arm64.tgz',
  'linux:x64': 'cloudflared-linux-amd64',
  'linux:arm64': 'cloudflared-linux-arm64',
};

// The URL is printed inside an ASCII box on stderr, some builds vary the text
// around it — the hostname shape is the only stable thing to match.
const PUBLIC_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

const URL_TIMEOUT_MS = 45000;  // edge handshake is normally 2-5s; 45 means "broken"
const MAX_LINES = 120;

/** A request that entered through the tunnel carries Cloudflare's edge headers.
 *  The server uses this to keep app-internal endpoints (Review Mode, its POST
 *  API, the folder-revealing export) local-only: a shared link shows the site,
 *  not the tooling around it. */
const viaTunnel = req => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

function parsePublicUrl(text) {
  const match = PUBLIC_URL.exec(String(text));
  return match ? match[0].toLowerCase() : null;
}

/** cloudflared already on PATH (winget, brew, scoop…) beats downloading it. */
function findOnPath() {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = spawnSync(probe, ['cloudflared'], { windowsHide: true, encoding: 'utf8' });
    const first = (out.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
    return out.status === 0 && first ? first : null;
  } catch { return null; }
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects fetching cloudflared.')); return; }
    https.get(url, { headers: { 'User-Agent': 'LocalDevStudio' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        download(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (HTTP ${res.statusCode}) — check your connection and try again.`));
        return;
      }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let done = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', chunk => { done += chunk.length; if (onProgress) onProgress({ done, total }); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', err => { res.destroy(); fs.rm(dest, { force: true }, () => reject(err)); });
      res.on('error', err => { out.destroy(); fs.rm(dest, { force: true }, () => reject(err)); });
    }).on('error', err => reject(new Error(err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
      ? 'Could not reach GitHub to fetch the tunnel engine — are you online?'
      : err.message)));
  });
}

/** One tunnel: spawn cloudflared, wait for it to print the public address. */
class Tunnel {
  constructor({ bin, port, onChange }) {
    this.bin = bin;
    this.port = port;
    this.onChange = onChange || (() => {});
    this.status = 'starting';  // starting | up | failed | stopped
    this.url = '';
    this.message = '';
    this.lines = [];
    this.child = null;
    this.stopping = false;
  }

  log(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim()) this.lines.push(line);
    }
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  setStatus(status, message = '') {
    this.status = status;
    this.message = message;
    this.onChange(this);
  }

  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = message => {
        if (!settled) { settled = true; reject(new Error(message)); }
        this.setStatus('failed', message);
        this.kill();
      };

      let child;
      try {
        child = spawn(this.bin, [
          'tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate',
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        fail(err.message);
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        const tail = this.lines.slice(-3).join(' · ');
        fail(`Cloudflare didn't answer within ${Math.round(URL_TIMEOUT_MS / 1000)}s`
          + (tail ? ` — ${tail}` : '') + '. Try again in a minute.');
      }, URL_TIMEOUT_MS);

      const onOutput = buf => {
        const text = buf.toString();
        this.log(text);
        const url = parsePublicUrl(text);
        if (url && !settled) {
          settled = true;
          clearTimeout(timer);
          this.url = url;
          this.setStatus('up', url);
          resolve(url);
        }
      };
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);

      child.on('error', err => {
        clearTimeout(timer);
        this.child = null;
        fail(err.code === 'ENOENT'
          ? 'The tunnel engine went missing — it will be re-downloaded on the next try.'
          : err.message);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        if (this.stopping) { this.setStatus('stopped', 'Stopped.'); return; }
        const tail = this.lines.slice(-3).join(' · ');
        fail(`The tunnel exited (${signal || 'code ' + code})${tail ? ' — ' + tail : ''}`);
      });
    });
  }

  kill() {
    const child = this.child;
    if (!child || child.killed) return;
    try { child.kill(); } catch { /* already gone */ }
  }

  stop() {
    this.stopping = true;
    if (!this.child) { this.setStatus('stopped', 'Stopped.'); return; }
    this.kill();
    this.setStatus('stopped', 'Stopped.');
  }

  state() {
    return { status: this.status, url: this.url, message: this.message, port: this.port };
  }
}

class TunnelManager {
  /** @param {{binDir: string, onChange?: (dir:string, state:object)=>void}} opts */
  constructor({ binDir, onChange }) {
    this.binDir = binDir;
    this.onChange = onChange || (() => {});
    this.tunnels = new Map();  // dir -> Tunnel
    this.fetching = null;      // in-flight binary download, shared across calls
  }

  binaryPath() {
    return path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  /** The cloudflared to run: PATH, the copy we keep, or a fresh download. */
  async ensureBinary(onProgress) {
    const onPath = findOnPath();
    if (onPath) return onPath;
    const local = this.binaryPath();
    if (fs.existsSync(local)) return local;

    const asset = ASSETS[`${process.platform}:${os.arch()}`];
    if (!asset) throw new Error(`Sharing isn't supported on ${process.platform}/${os.arch()} yet.`);
    if (asset.endsWith('.tgz')) {
      // macOS ships a tarball; not worth a tar dependency until the app does.
      throw new Error('On macOS, install cloudflared first: brew install cloudflared');
    }
    if (!this.fetching) {
      fs.mkdirSync(this.binDir, { recursive: true });
      const tmp = local + '.download';
      this.fetching = download(RELEASES + asset, tmp, onProgress)
        .then(() => {
          fs.renameSync(tmp, local);
          if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
          return local;
        })
        .finally(() => { this.fetching = null; });
    }
    return this.fetching;
  }

  /** Open (or return) the public link for a hosted port. */
  async start(dir, port, { onDownload } = {}) {
    const existing = this.tunnels.get(dir);
    if (existing && (existing.status === 'up' || existing.status === 'starting')) {
      return existing.url || existing.start();
    }
    const bin = await this.ensureBinary(onDownload);
    const tunnel = new Tunnel({
      bin, port,
      onChange: t => this.onChange(dir, t.state()),
    });
    this.tunnels.set(dir, tunnel);
    try {
      return await tunnel.start();
    } catch (err) {
      this.tunnels.delete(dir);
      throw err;
    }
  }

  stop(dir) {
    const tunnel = this.tunnels.get(dir);
    if (!tunnel) return false;
    tunnel.stop();
    this.tunnels.delete(dir);
    return true;
  }

  stopAll() {
    for (const dir of [...this.tunnels.keys()]) this.stop(dir);
  }

  state(dir) {
    const tunnel = this.tunnels.get(dir);
    return tunnel ? tunnel.state() : null;
  }
}

module.exports = { TunnelManager, Tunnel, parsePublicUrl, viaTunnel, download };
