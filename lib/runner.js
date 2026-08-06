// lib/runner.js — supervise the process behind a project that isn't just files.
//
// A dev server is a long-lived child that fails in ways a file read never does:
// the toolchain isn't installed, dependencies are missing, the first compile
// takes half a minute, the process picks a different port than the one it was
// asked for, and on Windows the thing we spawned (npm.cmd) isn't the thing
// listening (node.exe) — so killing our own pid leaves the server running and
// the port held. All of that is handled here so the host manager can treat a
// running site as "a port that answers", the same as a folder of files.
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const MAX_LINES = 400;          // ring buffer — a dev server prints forever
const READY_TIMEOUT_MS = 180000; // Next's first cold compile is genuinely slow
const PROBE_EVERY_MS = 300;

/** A free port from the OS, for the child to bind and us to proxy to. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Is something accepting connections there yet? Both loopbacks count — dev
 *  servers disagree about which one "localhost" means. */
function portAnswers(port, timeout = 1000) {
  const tryHost = host => new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
  return tryHost('127.0.0.1').then(ok => ok || tryHost('::1'));
}

// A dev server that couldn't take the port we asked for usually says so, and
// says it as a URL. Reading the port back out of the log is what keeps the
// proxy pointed at the real server instead of a port nobody is listening on.
const URL_PORT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i;

// Electron's own environment leaks into children in ways that break them:
// ELECTRON_RUN_AS_NODE makes a spawned node behave like Electron's node, and
// NODE_OPTIONS meant for the app is rarely meant for a dev server.
const STRIP_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS'];

/** Launched from Explorer, a packaged app can inherit a PATH without the tools
 *  a terminal would have. Add the usual homes so "npm not found" isn't the
 *  first thing a user sees. */
function augmentedPath(env) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = process.platform === 'win32'
    ? [
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), '.bun', 'bin'),
    ]
    : ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')];
  const current = (env.PATH || env.Path || '').split(sep).filter(Boolean);
  const merged = [...current];
  for (const dir of extra) if (!current.some(p => p.toLowerCase() === dir.toLowerCase())) merged.push(dir);
  return merged.join(sep);
}

/**
 * One supervised command. Construct, `start()`, read `status`, `stop()`.
 * Never throws from start — a failure is a status plus a log the user can read.
 */
class Runner {
  /**
   * @param {object} opts
   * @param {string} opts.command shell line, `{port}` already substituted by the caller
   * @param {string} opts.cwd
   * @param {Object<string,string>} [opts.env]
   * @param {number} opts.port port the child is expected to listen on
   * @param {(line:string)=>void} [opts.onLog]
   * @param {()=>void} [opts.onChange] fired when status changes, so the UI can refresh
   */
  constructor({ command, cwd, env = {}, port, onLog, onChange }) {
    this.command = command;
    this.cwd = cwd;
    this.extraEnv = env;
    this.port = port;
    this.onLog = onLog || (() => {});
    this.onChange = onChange || (() => {});
    this.status = 'idle';   // idle | starting | ready | failed | stopped
    this.message = '';
    this.lines = [];
    this.child = null;
    this.startedAt = 0;
    this.stopping = false;
  }

  log(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim() && !this.lines.length) continue;
      this.lines.push(line);
      this.onLog(line);
    }
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  setStatus(status, message = '') {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.onChange(this);
  }

  start() {
    if (this.child) return this;
    this.stopping = false;
    this.startedAt = Date.now();
    this.setStatus('starting', 'Starting…');
    this.log(`$ ${this.command}`);

    const env = { ...process.env, ...this.extraEnv };
    for (const key of STRIP_ENV) delete env[key];
    env.PATH = augmentedPath(process.env);
    if (process.platform === 'win32') delete env.Path; // PATH and Path both set is asking for trouble
    // Dev servers love to open a browser and paint their logs; neither helps here.
    env.BROWSER = 'none';
    env.OPEN = 'none';
    env.FORCE_COLOR = '0';
    env.NO_COLOR = '1';
    env.NEXT_TELEMETRY_DISABLED = '1';
    env.ASTRO_TELEMETRY_DISABLED = '1';
    env.GATSBY_TELEMETRY_DISABLED = '1';

    // Through a shell on purpose: the commands are `npm run dev`, `bundle exec
    // …`, chained builds with `&&` — shell syntax, and on Windows npm is a .cmd
    // that Node refuses to spawn directly.
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', this.command] : ['-c', this.command];

    let child;
    try {
      child = spawn(shell, args, {
        cwd: this.cwd,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so the whole tree can be signalled
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.setStatus('failed', err.message);
      this.log(err.message);
      return this;
    }
    this.child = child;

    const onOutput = buf => {
      const text = buf.toString();
      this.log(text);
      // If it announced a port that isn't the one we asked for, follow it.
      const match = URL_PORT.exec(text);
      if (match) {
        const announced = parseInt(match[1], 10);
        if (announced && announced !== this.port && this.status === 'starting') {
          this.log(`  (server chose port ${announced} — proxying there instead)`);
          this.port = announced;
        }
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    child.on('error', err => {
      this.child = null;
      this.setStatus('failed', err.code === 'ENOENT'
        ? `Could not run the command — is ${this.command.split(/\s+/)[0]} installed and on PATH?`
        : err.message);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) { this.setStatus('stopped', 'Stopped.'); return; }
      // A dev server exiting on its own is always a failure worth reading about.
      const tail = this.lines.filter(l => l.trim()).slice(-3).join(' · ');
      this.setStatus('failed', code === 0 && this.status === 'ready'
        ? 'The server exited.'
        : `The server exited (${signal || 'code ' + code})${tail ? ' — ' + tail : ''}`);
    });

    this.probe();
    return this;
  }

  /** Poll until the port answers, the child dies, or we give up. */
  async probe() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.status === 'starting' && Date.now() < deadline) {
      if (await portAnswers(this.port)) {
        const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
        this.log(`  ready on port ${this.port} after ${seconds}s`);
        this.setStatus('ready', `Running on port ${this.port}`);
        return;
      }
      if (!this.child) return; // exit handler already set the status
      await new Promise(resolve => setTimeout(resolve, PROBE_EVERY_MS));
    }
    if (this.status === 'starting') {
      this.setStatus('failed', `The server didn't start listening on port ${this.port} within `
        + `${Math.round(READY_TIMEOUT_MS / 1000)}s. Check the log below.`);
      this.kill();
    }
  }

  /** Kill the whole tree. `npm run dev` is a shell that spawns npm that spawns
   *  node — killing only what we hold leaves the port occupied. */
  kill() {
    const child = this.child;
    if (!child || child.killed) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { child.kill(); }
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 4000).unref();
    }
  }

  stop() {
    this.stopping = true;
    if (!this.child) { this.setStatus('stopped', 'Stopped.'); return; }
    this.kill();
    this.setStatus('stopped', 'Stopped.');
  }

  /** What the UI and the boot page show. */
  state() {
    return {
      status: this.status,
      message: this.message,
      port: this.port,
      pid: this.child ? this.child.pid : null,
      command: this.command,
      log: this.lines.join('\n'),
      elapsed: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }
}

/**
 * Run a one-shot command (dependency install) to completion.
 * @returns {Promise<{code:number}>} rejects with a readable message on failure
 */
function runOnce(command, cwd, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of STRIP_ENV) delete env[key];
    env.PATH = augmentedPath(process.env);
    if (process.platform === 'win32') delete env.Path;
    env.FORCE_COLOR = '0';
    env.NO_COLOR = '1';

    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    onLog(`$ ${command}`);
    const child = spawn(shell, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const emit = buf => String(buf).split(/\r?\n/).forEach(line => { if (line.trim()) onLog(line); });
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', err => reject(new Error(err.code === 'ENOENT'
      ? `Could not run "${command.split(/\s+/)[0]}" — is it installed and on PATH?`
      : err.message)));
    child.on('exit', code => (code === 0
      ? resolve({ code })
      : reject(new Error(`"${command}" exited with code ${code}. See the log for what it printed.`))));
  });
}

module.exports = { Runner, runOnce, freePort, portAnswers };
