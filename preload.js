// preload.js — the only bridge between the UI and the main process.
// Channels are allowlisted so a compromised page (a captured site is untrusted
// content, after all) can't reach anything that wasn't designed for it.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'env:get',
  'settings:get', 'settings:set', 'settings:browseRoot', 'settings:browseBrowser',
  'library:list',
  'project:addLocal', 'project:remove', 'project:setAutoStart',
  'capture:start', 'capture:cancel',
  'extract:run',
  'host:start', 'host:stop', 'host:stopAll',
  'zip:export',
  'palette:scan', 'palette:apply', 'palette:undo',
  'video:fix', 'thumb:make',
  'open:folder', 'open:editor', 'open:url', 'open:log', 'open:notices', 'log:tail',
  'site:delete', 'shell:confirm',
]);

const EVENTS = new Set([
  'run:log', 'run:status', 'run:progress', 'run:done', 'run:busy',
  'zip:progress', 'env:changed',
  'ui:refresh', 'ui:settings', 'ui:focus-url', 'ui:doctor', 'ui:about',
]);

// Electron wraps handler errors as "Error invoking remote method 'x': Error: real
// message" — strip the wrapper so toasts read like sentences.
function clean(err) {
  const message = String((err && err.message) || err || 'Unknown error');
  return new Error(message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
}

contextBridge.exposeInMainWorld('snap', {
  invoke(channel, data) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel: ${channel}`));
    return ipcRenderer.invoke(channel, data).catch(err => { throw clean(err); });
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`Blocked event: ${channel}`);
    ipcRenderer.on(channel, (event, data) => fn(data));
  },
  // Dropped File objects no longer carry a .path in the renderer; this is the
  // sanctioned way to recover the real filesystem path for a drag-dropped folder.
  pathForFile: file => webUtils.getPathForFile(file),
});
