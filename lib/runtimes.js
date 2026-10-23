// lib/runtimes.js — work out how a folder wants to be served.
//
// Local Dev Studio started as a static file host: a "site" was a folder of HTML, and
// anything else was refused at the door ("No HTML pages found in that folder").
// Real client work isn't shaped like that. A Next.js app, a Vite SPA, a Django
// site, a Laravel shop and a Hugo blog all need their own process listening on
// a port before there is anything to look at.
//
// This module is the lookup that turns a folder into a runtime: either "serve
// these files" (static, the original behaviour) or "run this command and proxy
// to it" (command). It also names the install step, because a freshly cloned
// repo has no node_modules and running the dev server first would only produce
// a confusing crash.
//
// Detection is a suggestion, never a verdict — every runtime it returns is an
// editable command the user can correct, and `custom` covers anything the table
// has never heard of.
const fs = require('fs');
const path = require('path');

/**
 * @typedef {object} Runtime
 * @property {'static'|'command'} kind
 * @property {string} id            stable id for the detected shape ('next', 'static', 'custom'…)
 * @property {string} label         what the card and the runtime panel show
 * @property {string} [command]     command runtimes: shell line, `{port}` = the port we allocate
 * @property {Object<string,string>} [env] extra environment, values may contain `{port}`
 * @property {string} [install]     command that fetches dependencies
 * @property {string} [installed]   relative path that exists once install has been run
 * @property {string} [root]        static runtimes: subfolder to serve instead of the project root
 * @property {number} [appPort]     command runtimes whose command has no `{port}`: the port it binds
 * @property {string} [needs]       executable the command depends on, for a friendlier error
 * @property {string} [note]        one sentence shown under the command in the UI
 */

const exists = (dir, ...names) => names.some(name => {
  try { fs.statSync(path.join(dir, name)); return true; } catch { return false; }
});

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function readJson(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
}

function hasHtml(dir) {
  try { return fs.readdirSync(dir).some(f => f.toLowerCase().endsWith('.html') || f.toLowerCase().endsWith('.htm')); } catch { return false; }
}

function readText(dir, name) {
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; }
}

// A framework's dev server takes its port in its own way, so the table records
// both the scripts worth running (first one that exists in package.json wins)
// and how the port is handed over. Order matters: meta-frameworks come before
// the bundlers they are built on, because SvelteKit and Astro are Vite
// underneath but it's their own CLI that actually runs.
const NODE_FRAMEWORKS = [
  { dep: 'next', label: 'Next.js', scripts: ['dev'], args: '--port {port}', build: 'build', startScript: 'start' },
  { dep: 'nuxt', label: 'Nuxt', scripts: ['dev'], args: '--port {port}', build: 'build', startScript: 'preview' },
  { dep: 'astro', label: 'Astro', scripts: ['dev', 'start'], args: '--port {port}', build: 'build', startScript: 'preview' },
  { dep: '@sveltejs/kit', label: 'SvelteKit', scripts: ['dev'], args: '--port {port} --strictPort', build: 'build', startScript: 'preview' },
  { dep: '@angular/cli', label: 'Angular', scripts: ['start', 'dev'], args: '--port {port}' },
  { dep: '@docusaurus/core', label: 'Docusaurus', scripts: ['start', 'dev'], args: '--port {port}' },
  { dep: 'gatsby', label: 'Gatsby', scripts: ['develop', 'dev'], args: '--port {port}' },
  { dep: 'vitepress', label: 'VitePress', scripts: ['docs:dev', 'dev'], args: '--port {port} --strictPort' },
  { dep: 'vuepress', label: 'VuePress', scripts: ['docs:dev', 'dev'], args: '--port {port}' },
  { dep: '@11ty/eleventy', label: 'Eleventy', scripts: ['serve', 'start', 'dev'], args: '--port {port}' },
  { dep: 'react-scripts', label: 'Create React App', scripts: ['start', 'dev'], args: '', env: { PORT: '{port}' } },
  { dep: '@remix-run/dev', label: 'Remix', scripts: ['dev'], args: '', env: { PORT: '{port}' } },
  { dep: '@react-router/dev', label: 'React Router', scripts: ['dev'], args: '--port {port}' },
  { dep: 'parcel', label: 'Parcel', scripts: ['dev', 'start'], args: '--port {port}' },
  { dep: 'webpack-dev-server', label: 'webpack', scripts: ['dev', 'start', 'serve'], args: '--port {port}' },
  { dep: 'hexo', label: 'Hexo', scripts: ['server', 'dev'], args: '--port {port}' },
  { dep: 'vite', label: 'Vite', scripts: ['dev', 'start', 'serve'], args: '--port {port} --strictPort', build: 'build', startScript: 'preview' },
  { dep: 'express', label: 'Express', scripts: ['dev', 'start'], args: '', env: { PORT: '{port}' } },
  { dep: 'fastify', label: 'Fastify', scripts: ['dev', 'start'], args: '', env: { PORT: '{port}' } },
  { dep: 'koa', label: 'Koa', scripts: ['dev', 'start'], args: '', env: { PORT: '{port}' } },
  { dep: 'nest', label: 'NestJS', scripts: ['start:dev', 'dev', 'start'], args: '', env: { PORT: '{port}' } },
  { dep: '@nestjs/core', label: 'NestJS', scripts: ['start:dev', 'dev', 'start'], args: '', env: { PORT: '{port}' } },
];

// Folders a build tends to land in. Serving one of these is the fallback when a
// project can't (or shouldn't) run its dev server — and the whole answer for a
// repo whose output is committed.
const BUILD_DIRS = ['dist', 'build', 'out', '_site', 'public', 'site', 'www', 'docs'];

/** The package manager the lockfile says this project uses. */
function packageManager(dir) {
  if (exists(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

const RUN = { npm: 'npm run', pnpm: 'pnpm run', yarn: 'yarn', bun: 'bun run' };
const INSTALL = { npm: 'npm install', pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install' };
// npm and pnpm need `--` before flags meant for the script; yarn and bun don't.
const FORWARD = { npm: '-- ', pnpm: '-- ', yarn: '', bun: '' };

function nodeCandidates(dir, pkg) {
  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const pm = packageManager(dir);
  const out = [];

  const scriptCommand = (name, args) => {
    const tail = args ? ' ' + FORWARD[pm] + args : '';
    return `${RUN[pm]} ${name}${tail}`;
  };

  const framework = NODE_FRAMEWORKS.find(f => deps[f.dep]);
  const pick = framework && framework.scripts.find(s => scripts[s]);

  if (framework && pick) {
    out.push({
      kind: 'command',
      id: framework.dep,
      label: `${framework.label} dev server`,
      command: scriptCommand(pick, framework.args),
      env: framework.env,
      install: INSTALL[pm],
      installed: 'node_modules',
      needs: pm,
    });
    // A production build is the honest preview for anything animation- or
    // performance-sensitive, and the escape hatch when dev mode misbehaves.
    if (framework.build && scripts[framework.build] && scripts[framework.startScript]) {
      out.push({
        kind: 'command',
        id: framework.dep + ':prod',
        label: `${framework.label} production build`,
        command: `${RUN[pm]} ${framework.build} && ${scriptCommand(framework.startScript, framework.args)}`,
        env: framework.env,
        install: INSTALL[pm],
        installed: 'node_modules',
        needs: pm,
        note: 'Builds first — slower to start, closer to production.',
      });
    }
  } else {
    // No framework we know, but a script that clearly starts something. PORT is
    // the one convention nearly every hand-rolled Node server honours.
    const generic = ['dev', 'start', 'serve', 'develop'].find(s => scripts[s]);
    if (generic) {
      out.push({
        kind: 'command',
        id: 'node',
        label: `Node — ${RUN[pm]} ${generic}`,
        command: scriptCommand(generic, ''),
        env: { PORT: '{port}' },
        install: INSTALL[pm],
        installed: 'node_modules',
        needs: pm,
        note: 'Port is passed as the PORT environment variable. Edit the command if this server takes a flag instead.',
      });
    } else if (pkg.main || exists(dir, 'server.js', 'index.js', 'app.js')) {
      const file = pkg.main && exists(dir, pkg.main) ? pkg.main
        : ['server.js', 'index.js', 'app.js'].find(f => exists(dir, f));
      out.push({
        kind: 'command',
        id: 'node-file',
        label: `Node — node ${file}`,
        command: `node ${file}`,
        env: { PORT: '{port}' },
        install: INSTALL[pm],
        installed: 'node_modules',
        needs: 'node',
      });
    }
  }
  return out;
}

function pythonCandidates(dir) {
  const out = [];
  const requirements = readText(dir, 'requirements.txt') + readText(dir, 'pyproject.toml');
  const install = exists(dir, 'requirements.txt') ? 'python -m pip install -r requirements.txt'
    : exists(dir, 'pyproject.toml') ? 'python -m pip install -e .' : null;
  const common = { kind: 'command', install, needs: 'python' };

  if (exists(dir, 'manage.py')) {
    out.push({
      ...common, id: 'django', label: 'Django dev server',
      command: 'python manage.py runserver 127.0.0.1:{port}',
    });
  }
  const asgi = ['main.py', 'app.py', 'asgi.py', 'server.py'].find(f => exists(dir, f));
  if (asgi && /fastapi|uvicorn|starlette/i.test(requirements)) {
    out.push({
      ...common, id: 'fastapi', label: 'FastAPI (uvicorn)',
      command: `python -m uvicorn ${path.basename(asgi, '.py')}:app --port {port} --reload`,
    });
  }
  if (asgi && /flask/i.test(requirements)) {
    out.push({
      ...common, id: 'flask', label: 'Flask dev server',
      command: `python -m flask --app ${path.basename(asgi, '.py')} run --port {port} --debug`,
    });
  }
  if (/streamlit/i.test(requirements) && asgi) {
    out.push({
      ...common, id: 'streamlit', label: 'Streamlit',
      command: `python -m streamlit run ${asgi} --server.port {port} --server.headless true`,
    });
  }
  if (!out.length && asgi) {
    out.push({
      ...common, id: 'python', label: `Python — python ${asgi}`,
      command: `python ${asgi}`,
      env: { PORT: '{port}' },
      note: 'Guessed. Edit the command to match how this app starts.',
    });
  }
  return out;
}

function phpCandidates(dir) {
  const out = [];
  if (exists(dir, 'artisan')) {
    out.push({
      kind: 'command', id: 'laravel', label: 'Laravel dev server',
      command: 'php artisan serve --port {port}',
      install: 'composer install', installed: 'vendor', needs: 'php',
    });
  }
  const docroot = ['public', 'web', 'htdocs'].find(d => exists(dir, path.join(d, 'index.php')));
  if (docroot || exists(dir, 'index.php')) {
    out.push({
      kind: 'command', id: 'php', label: 'PHP built-in server',
      command: `php -S 127.0.0.1:{port}${docroot ? ' -t ' + docroot : ''}`,
      install: exists(dir, 'composer.json') ? 'composer install' : null,
      installed: 'vendor', needs: 'php',
    });
  }
  return out;
}

function rubyCandidates(dir) {
  const out = [];
  const bundled = exists(dir, 'Gemfile');
  const prefix = bundled ? 'bundle exec ' : '';
  if (exists(dir, '_config.yml')) {
    out.push({
      kind: 'command', id: 'jekyll', label: 'Jekyll',
      command: `${prefix}jekyll serve --port {port}`,
      install: bundled ? 'bundle install' : null, needs: 'ruby',
    });
  }
  if (exists(dir, 'bin/rails') || exists(dir, 'config/application.rb')) {
    out.push({
      kind: 'command', id: 'rails', label: 'Rails dev server',
      command: `${prefix}rails server -p {port}`,
      install: bundled ? 'bundle install' : null, needs: 'ruby',
    });
  } else if (exists(dir, 'config.ru')) {
    out.push({
      kind: 'command', id: 'rack', label: 'Rack (rackup)',
      command: `${prefix}rackup -p {port}`,
      install: bundled ? 'bundle install' : null, needs: 'ruby',
    });
  }
  return out;
}

function otherCandidates(dir) {
  const out = [];
  if (exists(dir, 'hugo.toml', 'hugo.yaml', 'hugo.json') || (exists(dir, 'config.toml') && exists(dir, 'content'))) {
    out.push({
      kind: 'command', id: 'hugo', label: 'Hugo',
      command: 'hugo server --port {port} --bind 127.0.0.1', needs: 'hugo',
    });
  }
  if (exists(dir, 'go.mod')) {
    out.push({
      kind: 'command', id: 'go', label: 'Go — go run .',
      command: 'go run .', env: { PORT: '{port}' }, needs: 'go',
      note: 'Port is passed as the PORT environment variable.',
    });
  }
  if (exists(dir, 'Cargo.toml')) {
    out.push({
      kind: 'command', id: 'rust', label: 'Rust — cargo run',
      command: 'cargo run', env: { PORT: '{port}' }, needs: 'cargo',
      note: 'Port is passed as the PORT environment variable.',
    });
  }
  if (exists(dir, 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml')) {
    out.push({
      kind: 'command', id: 'compose', label: 'Docker Compose',
      command: 'docker compose up', needs: 'docker', appPort: 0,
      note: 'Compose decides its own ports — set "App port" to the one the site is published on.',
    });
  }
  return out;
}

/** Static candidates: the folder itself when it has pages, plus any build
 *  output directory that already contains an index.html. */
function staticCandidates(dir) {
  const out = [];
  if (hasHtml(dir)) {
    out.push({ kind: 'static', id: 'static', label: 'Static files' });
  }
  for (const name of BUILD_DIRS) {
    const sub = path.join(dir, name);
    if (isDir(sub) && hasHtml(sub)) {
      out.push({ kind: 'static', id: 'static:' + name, label: `Static files — ${name}/`, root: name });
    }
  }
  return out;
}

/** Everything detectable about one folder, without looking below it. */
function ownCandidates(dir) {
  const pkg = readJson(dir, 'package.json');
  return [
    ...(pkg ? nodeCandidates(dir, pkg) : []),
    ...pythonCandidates(dir),
    ...phpCandidates(dir),
    ...rubyCandidates(dir),
    ...otherCandidates(dir),
    ...staticCandidates(dir),
  ];
}

// People drop the folder *above* the app all the time — a client folder whose
// Next.js project sits one level down. When the dropped folder itself is
// nothing we can serve, look one level down and carry the answer back up as
// `root`, so hosting runs the command (or serves the files) from the subfolder.
const SKIP_SCAN = new Set(['node_modules', 'vendor', '__pycache__', 'target', ...BUILD_DIRS]);
function subfolderCandidates(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_SCAN.has(e.name.toLowerCase()))
      .map(e => e.name).sort();
  } catch { return []; }
  const out = [];
  for (const name of names) {
    for (const c of ownCandidates(path.join(dir, name)).slice(0, 2)) {
      out.push({
        ...c,
        root: c.root ? path.join(name, c.root) : name,
        label: `${c.label} — in ${name}${path.sep}`,
      });
    }
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Every way this folder could plausibly be served, best guess first.
 * @param {string} dir
 * @returns {Runtime[]}
 */
function candidates(dir) {
  const found = ownCandidates(dir);
  if (!found.length) found.push(...subfolderCandidates(dir));
  // The custom command is always on the list — it's what makes "any website"
  // true rather than "any website we happened to think of".
  found.push({
    kind: 'command', id: 'custom', label: 'Custom command',
    command: '', note: 'Use {port} where the command takes a port, or set "App port" if it binds a fixed one.',
  });
  // So is attach: a dev server the developer already runs in their own
  // terminal shouldn't have to hand its process over to get Review Mode.
  found.push({ ...ATTACH_RUNTIME });
  return found;
}

// The attach runtime: no command, no spawn — Local Dev Studio just fronts a port that
// something else already answers on. Loopback only, always.
const ATTACH_RUNTIME = {
  kind: 'command', id: 'attach', label: 'Already running — just connect',
  command: '',
  note: 'Local Dev Studio starts nothing — it connects to a dev server you already run and fronts it '
    + 'on this project\'s stable port. Set "App port" to where your server listens.',
};

/**
 * Parse what the user typed into the attach port field: "3000", ":3000",
 * "localhost:3000", "127.0.0.1:3000", "[::1]:5173", or a pasted
 * "http://localhost:3000/" — anything naming a non-loopback host is refused,
 * because attach must never become an open proxy to other machines.
 * @param {string} text
 * @returns {number} the loopback port
 */
function parseAttachTarget(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) throw new Error('Enter the port your dev server is listening on, like 3000.');
  let host = '';
  let portText = raw;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  if (url) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('That address could not be read — try just the port, like 3000.'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http addresses can be attached to.');
    }
    host = parsed.hostname;
    portText = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } else {
    const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
    const hostPort = v6 || /^([^:]*):(\d+)$/.exec(raw);
    if (hostPort) { host = hostPort[1]; portText = hostPort[2]; }
  }
  const LOOPBACK = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);
  if (!LOOPBACK.has(host.toLowerCase())) {
    throw new Error(`Attach only connects to this machine — "${host}" was refused. `
      + 'Use localhost, 127.0.0.1 or ::1.');
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('That is not a port — use a number like 3000.');
  }
  return port;
}

/** The runtime a folder gets when nobody chooses one, or null when the folder
 *  holds nothing we recognise as a website. Custom and attach are choices a
 *  person makes, never a guess this table produces. */
function detect(dir) {
  return candidates(dir).find(c => c.id !== 'custom' && c.id !== 'attach') || null;
}

/** True when the runtime names an install step that hasn't been run yet.
 *  A runtime with a `root` lives (and installs) in that subfolder. */
function needsInstall(dir, runtime) {
  if (!runtime || !runtime.install || !runtime.installed) return false;
  return !exists(runtime.root ? path.join(dir, runtime.root) : dir, runtime.installed);
}

/** Substitute {port} through a command line or an env map. */
const withPort = (text, port) => String(text == null ? '' : text).replace(/\{port\}/g, String(port));

function envWithPort(env, port) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) out[key] = withPort(value, port);
  return out;
}

/** Does this command want a port from us, or does it bind its own? */
const takesPort = runtime => !!runtime && /\{port\}/.test(
  (runtime.command || '') + Object.values(runtime.env || {}).join(' '));

/** Keep only the fields worth persisting — a stored runtime must survive a
 *  detection table that changes underneath it. */
function normalize(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  const kind = runtime.kind === 'command' ? 'command' : 'static';
  const out = {
    kind,
    id: String(runtime.id || (kind === 'command' ? 'custom' : 'static')),
    label: String(runtime.label || (kind === 'command' ? 'Custom command' : 'Static files')),
  };
  if (kind === 'command') {
    out.command = String(runtime.command || '');
    if (runtime.env && typeof runtime.env === 'object') out.env = { ...runtime.env };
    if (runtime.install) out.install = String(runtime.install);
    if (runtime.installed) out.installed = String(runtime.installed);
    if (runtime.needs) out.needs = String(runtime.needs);
    if (Number.isInteger(runtime.appPort) && runtime.appPort > 0) out.appPort = runtime.appPort;
  }
  // Both kinds can live in a subfolder: a static build dir, or a command
  // detected one level below the folder the user actually dropped.
  if (runtime.root) out.root = String(runtime.root);
  if (runtime.note) out.note = String(runtime.note);
  return out;
}

module.exports = {
  candidates, detect, needsInstall, normalize, withPort, envWithPort, takesPort, packageManager,
  parseAttachTarget, ATTACH_RUNTIME,
};
