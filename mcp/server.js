// mcp/server.js — Local Dev Studio's MCP server: the live wire between a coding agent
// and the running app.
//
// Plain Node, no Electron APIs, no SDK: MCP's stdio transport is line-delimited
// JSON-RPC 2.0, which is small enough to speak by hand. main.js relaunches the
// app binary with ELECTRON_RUN_AS_NODE=1 pointing here when it sees --mcp (the
// same trick lib/paths.js plays for single-file-cli), so `claude mcp add
// local-dev-studio -- "<exe>" --mcp` is the whole setup.
//
// Every tool call is a thin HTTP request to the control API the running app
// exposes on loopback (lib/control.js); this process holds no state of its
// own. If the app isn't running there is exactly one error, and it says what
// to do about it.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROTOCOL_VERSION = '2025-06-18';
const APP_NOT_RUNNING = 'Local Dev Studio isn\'t running. Start it and retry.';

// The launcher (main.js --mcp) passes where the app keeps its profile; a
// control.json lives there while the app runs.
const userData = process.env.SLURP_USERDATA || '';
const serverVersion = process.env.SLURP_VERSION || '0.0.0';

/* ---------- control API client ---------- */

function readControl() {
  if (!userData) throw new Error(APP_NOT_RUNNING);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(userData, 'control.json'), 'utf8')); }
  catch { throw new Error(APP_NOT_RUNNING); }
  if (!raw || !Number.isInteger(raw.port) || typeof raw.token !== 'string') {
    throw new Error(APP_NOT_RUNNING);
  }
  return raw;
}

function control(method, route, body = null) {
  // Re-read per call: the app restarting mid-session moves the port and
  // rotates the token, and the next call should just follow it.
  const { port, token } = readControl();
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty body */ }
        if (res.statusCode >= 400) reject(new Error(data.error || `Control API answered ${res.statusCode}.`));
        else resolve(data);
      });
    });
    // A stale control.json points at a port nothing listens on any more.
    req.on('error', () => reject(new Error(APP_NOT_RUNNING)));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- tools ---------- */

const str = (desc, extra = {}) => ({ type: 'string', description: desc, ...extra });

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List every project in the Local Dev Studio library: id, name, the library section it is filed under (e.g. "Client Websites", null when unsorted), whether it is hosted right now (and at what URL), and how many annotations are open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => control('GET', '/v1/projects'),
  },
  {
    name: 'list_annotations',
    description: 'List a project\'s review annotations — selector, why it\'s wrong, what\'s wanted, severity, screenshots. Fix what these describe, then resolve_annotation each one.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project id or name (from list_projects).'),
        status: str('Which annotations: "open" (default), "resolved" or "all".', { enum: ['open', 'resolved', 'all'] }),
      },
      required: ['project'],
      additionalProperties: false,
    },
    run: args => control('GET', `/v1/annotations?project=${encodeURIComponent(args.project)}&status=${encodeURIComponent(args.status || 'open')}`),
  },
  {
    name: 'get_annotation',
    description: 'One annotation with its full context: selectors, source file:line when known, computed styles, screenshots, console tail.',
    inputSchema: {
      type: 'object',
      properties: { id: str('The annotation id, e.g. ann_1a2b3c4d.') },
      required: ['id'],
      additionalProperties: false,
    },
    run: args => control('GET', `/v1/annotations/${encodeURIComponent(args.id)}`),
  },
  {
    name: 'resolve_annotation',
    description: 'Mark an annotation fixed after changing the code. Local Dev Studio re-screenshots the element and pixel-diffs it against the original — if nothing changed visually, the resolve is flagged for the reviewer.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('The annotation id.'),
        note: str('What was changed, in a sentence — shows up next to the resolve.'),
        afterRating: { type: 'number', description: 'Optional 1-10: how good the element is now.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: args => control('POST', `/v1/annotations/${encodeURIComponent(args.id)}/resolve`, {
      note: args.note, afterRating: args.afterRating,
    }),
  },
  {
    name: 'get_calibration',
    description: 'The reviewer\'s taste memory: standing preferences that always apply, and rating anchors that show what each score means to them. Read this before judging or fixing visual work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ markdown: (await control('GET', '/v1/calibration')).markdown }),
  },
  {
    name: 'create_snapshot',
    description: 'Snapshot a project\'s files as a restorable version — take one before a risky change.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project id or name.'),
        label: str('Optional label, e.g. "before header rework".'),
      },
      required: ['project'],
      additionalProperties: false,
    },
    run: args => control('POST', '/v1/snapshots', { project: args.project, label: args.label || '' }),
  },
  {
    name: 'export_review',
    description: 'Write the project\'s current review to disk as an agent-ready folder (REVIEW.md, annotations.json, calibration.md, shots/) and return the paths.',
    inputSchema: {
      type: 'object',
      properties: { project: str('Project id or name.') },
      required: ['project'],
      additionalProperties: false,
    },
    run: args => control('POST', '/v1/export', { project: args.project }),
  },
];

/* ---------- resources ---------- */

const CALIBRATION_URI = 'localdevstudio://calibration.md';
const reviewUri = id => `localdevstudio://projects/${id}/REVIEW.md`;

async function listResources() {
  const { projects } = await control('GET', '/v1/projects');
  const resources = projects.map(p => ({
    uri: reviewUri(p.id),
    name: `${p.name} — REVIEW.md`,
    description: `The current review of ${p.name}: every open annotation as an agent-ready spec.`,
    mimeType: 'text/markdown',
  }));
  resources.push({
    uri: CALIBRATION_URI,
    name: 'calibration.md',
    description: 'The reviewer\'s taste memory — standing preferences and rating anchors.',
    mimeType: 'text/markdown',
  });
  return { resources };
}

async function readResource(uri) {
  if (uri === CALIBRATION_URI) {
    const { markdown } = await control('GET', '/v1/calibration');
    return { contents: [{ uri, mimeType: 'text/markdown', text: markdown }] };
  }
  const match = /^localdevstudio:\/\/projects\/([^/]+)\/REVIEW\.md$/.exec(String(uri || ''));
  if (!match) throw new Error(`Unknown resource: ${uri}`);
  const { markdown } = await control('GET', `/v1/review?project=${encodeURIComponent(match[1])}`);
  return { contents: [{ uri, mimeType: 'text/markdown', text: markdown }] };
}

/* ---------- JSON-RPC over stdio ---------- */

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const notification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'local-dev-studio', version: serverVersion },
        });
        return;
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        return;
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === params.name);
        if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { rpcCode: -32602 });
        // Tool failures are results, not protocol errors — the agent should
        // read "start the app" as an answer, not a crash.
        try {
          const result = await tool.run(params.arguments || {});
          reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          reply(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        return;
      }
      case 'resources/list':
        reply(id, await listResources());
        return;
      case 'resources/read':
        reply(id, await readResource(params.uri));
        return;
      default:
        if (!notification) throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
      // Notifications we don't know (notifications/initialized, cancels) are
      // fine to ignore — that's what makes them notifications.
    }
  } catch (err) {
    if (!notification) replyError(id, err.rpcCode || -32603, err.message);
  }
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let at;
  while ((at = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, at).trim();
    pending = pending.slice(at + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { replyError(null, -32700, 'Parse error'); continue; }
    handle(msg).catch(() => { /* handle() already answered */ });
  }
});
process.stdin.on('end', () => process.exit(0));
