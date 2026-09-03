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
const READY_CONFIRM_MS = 350;   // a bound port isn't a live server — see probe()

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

// Next 16 won't share a project folder: a second `next dev` binds its port,
// prints "Ready", announces this line, then exits. Until it exits the bound
// port answers — so this line, not the exit, is the earliest true signal.
const DUP_SERVER = /another (?:\w+ )?dev server is already running/i;

// Lines that print a URL for something other than the site itself — a proxy
// forwarding rule, a backend/upstream target. The port on these is never ours
// to follow.
const FORWARD_LINE = /proxy|->|→|upstream|target|forward|backend|\bapi\b|storybook/i;

// Dev servers paint their output; NO_COLOR spares us the colors but not the
// cursor management, which reads as junk («[?25h») in a card message. Escape
// sequences are dropped at the door.
const ANSI = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;?]*[A-Za-z]', 'g');

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
    for (const line of String(text).replace(ANSI, '').split(/\r?\n/)) {
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
      // The refusal is printed before the process exits; believe it the
      // moment it arrives so no request is ever proxied to the corpse.
      if (!this.stopping && this.status !== 'failed' && DUP_SERVER.test(text)) {
        this.failDuplicate();
        return;
      }
      // If it announced a port that isn't the one we asked for, follow it — but
      // only on the server's own "here's your site" line. Dev servers also
      // print URLs for things we must NOT proxy to: an API/backend a proxy
      // forwards to, a Storybook/docs address, a database console. Following one
      // of those would front the wrong service entirely.
      if (this.status !== 'starting') return;
      for (const line of text.split(/\r?\n/)) {
        if (FORWARD_LINE.test(line)) continue;
        const match = URL_PORT.exec(line);
        if (!match) continue;
        const announced = parseInt(match[1], 10);
        if (announced && announced !== this.port) {
          this.log(`  (server chose port ${announced} — proxying there instead)`);
          this.port = announced;
        }
        break;
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
      // Next.js (and friends) hold a per-project dev lock: a second dev server
      // refuses to start while one is running — usually the user's own
      // terminal, or a survivor from an earlier session. Attach mode exists
      // for exactly this, so say so instead of echoing the stack's error.
      // (onOutput usually caught the announcement first; running it again here
      // picks up lines — the PID — that arrived after the first sighting.)
      if (/already running|address already in use|EADDRINUSE/i.test(this.lines.slice(-25).join('\n'))) {
        this.failDuplicate();
        return;
      }
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
        // Answering once isn't ready. Next 16 binds its port and prints its
        // banner, then exits when another `next dev` already owns this folder
        // — flipping ready on the first answer points the proxy at a corpse.
        // So the child gets a beat to die honestly, then must answer again.
        await new Promise(resolve => setTimeout(resolve, READY_CONFIRM_MS));
        if (this.status !== 'starting') return; // the exit handler spoke first
        if (this.child && await portAnswers(this.port)) {
          const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
          this.log(`  ready on port ${this.port} after ${seconds}s`);
          this.setStatus('ready', `Running on port ${this.port}`);
          return;
        }
        continue; // died or went quiet — keep watching until the deadline
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

  /** Another dev server already owns this folder (see DUP_SERVER) — usually
   *  the user's own terminal. Attach mode exists for exactly this, so say so
   *  instead of echoing the stack's error — and put the doomed child down
   *  rather than letting its bound port answer meanwhile. */
  failDuplicate() {
    const pid = /\bPID:?\s+(\d+)/i.exec(this.lines.join('\n'));
    this.setStatus('failed', 'A dev server for this project is already running somewhere else'
      + `${pid ? ` (PID ${pid[1]})` : ''} — your own terminal, or one left over from earlier. `
      + 'Stop that one and host again, or set this project\'s runtime to '
      + '"Already running — just connect" to use it as-is.');
    this.kill();
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

  /** Stop the child and resolve once it has actually exited — a restart must
   *  wait for the old process to release its port before spawning the next,
   *  and `this.child` is only cleared in the async exit handler. */
  stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) { this.setStatus('stopped', 'Stopped.'); return Promise.resolve(); }
    const exited = new Promise(resolve => child.once('exit', resolve));
    this.kill();
    this.setStatus('stopped', 'Stopped.');
    return exited;
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
 * The attach-mode counterpart of Runner: no child process at all. The
 * developer already runs their dev server in their own terminal; this just
 * watches whether the port answers, so the proxy and the card can treat
 * "a server somebody else started" exactly like one we supervise. Ready when
 * the port accepts connections, failed (with a friendly sentence, not a stack
 * trace) when it stops — and back to ready on its own if the server returns,
 * because restarting `npm run dev` shouldn't require touching SiteSlurp.
 */
class AttachRunner {
  /**
   * @param {object} opts
   * @param {number} opts.port the loopback port the user's own server listens on
   * @param {(runner:AttachRunner)=>void} [opts.onChange]
   * @param {number} [opts.pollMs] probe interval (tests shorten it)
   */
  constructor({ port, onChange, pollMs = 1500 }) {
    this.port = port;
    this.onChange = onChange || (() => {});
    this.pollMs = pollMs;
    this.status = 'idle';
    this.message = '';
    this.lines = [];
    this.child = null;        // never set — same shape as Runner for callers
    this.command = '';
    this.startedAt = 0;
    this.stopping = false;
    this.timer = null;
  }

  log(text) {
    this.lines.push(String(text));
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  setStatus(status, message = '') {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.onChange(this);
  }

  start() {
    if (this.timer) return this;
    this.stopping = false;
    this.startedAt = Date.now();
    this.setStatus('starting', `Looking for a server on port ${this.port}…`);
    this.log(`attached to localhost:${this.port} — SiteSlurp did not start this server`);
    const tick = async () => {
      if (this.stopping) return;
      const answers = await portAnswers(this.port, 900);
      if (this.stopping) return;
      if (answers && this.status !== 'ready') {
        this.log(`  port ${this.port} is answering`);
        this.setStatus('ready', `Connected to port ${this.port}`);
      } else if (!answers && this.status === 'ready') {
        this.log(`  port ${this.port} stopped answering`);
        this.setStatus('failed', `Nothing is answering on port ${this.port} any more — `
          + 'is your dev server still running? It reconnects by itself when the server is back.');
      } else if (!answers && this.status === 'starting'
          && Date.now() - this.startedAt > READY_TIMEOUT_MS) {
        this.setStatus('failed', `Nothing is listening on port ${this.port}. `
          + 'Start your dev server in its own terminal — this card connects as soon as it answers.');
      }
    };
    this.timer = setInterval(tick, this.pollMs);
    this.timer.unref?.();
    tick();
    return this;
  }

  kill() { /* nothing was spawned; nothing to kill */ }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    this.setStatus('stopped', 'Disconnected. The server keeps running — it was never ours.');
    return Promise.resolve();
  }

  state() {
    return {
      status: this.status,
      message: this.message,
      port: this.port,
      pid: null,
      command: '',
      attached: true,
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

module.exports = { Runner, AttachRunner, runOnce, freePort, portAnswers };
