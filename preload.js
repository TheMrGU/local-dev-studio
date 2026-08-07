// preload.js — the only bridge between the UI and the main process.
// Channels are allowlisted so a compromised page (a captured site is untrusted
// content, after all) can't reach anything that wasn't designed for it.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'env:get',
  'settings:get', 'settings:set', 'settings:browseRoot', 'settings:browseBrowser',
  'library:list',
  'project:addLocal', 'project:addAttach', 'project:browseFolder',
  'project:remove', 'project:setAutoStart', 'project:setLiveReload',
  'project:setAutoSnapshot',
  'project:runtimes', 'project:setRuntime', 'project:install',
  'project:pages', 'project:setEntry',
  'studio:open',
  'sb:hello', 'sb:layout', 'sb:nav', 'sb:annotate', 'sb:pin', 'sb:shot', 'sb:revealShot',
  'sb:consoleTail', 'sb:copyAgent', 'sb:copyText',
  'version:create', 'version:list', 'version:diff', 'version:readFile', 'version:restore',
  'runtime:state', 'runtime:restart',
  'review:start', 'review:stop', 'review:history', 'review:export',
  'audit:run',
  'calibration:promote', 'calibration:get', 'calibration:update',
  'calibration:removeAnchor', 'calibration:removePreference',
  'capture:start', 'capture:cancel', 'capture:dequeue', 'capture:login', 'capture:recapture',
  'settings:browseCookies',
  'extract:run',
  'host:start', 'host:stop', 'host:stopAll',
  'share:start', 'share:stop', 'share:state',
  'project:setHttps', 'https:trust',
  'deploy:token', 'deploy:setToken', 'deploy:run',
  'zip:export',
  'palette:scan', 'palette:apply', 'palette:undo',
  'video:fix', 'thumb:make',
  'open:folder', 'open:editor', 'open:url', 'open:log', 'open:notices', 'log:tail',
  'site:delete', 'shell:confirm',
  'update:install',
  'win:action',
]);

const EVENTS = new Set([
  'run:log', 'run:status', 'run:progress', 'run:done', 'run:busy', 'run:queue', 'runtime:state',
  'share:state', 'share:download', 'deploy:progress',
  'zip:progress', 'env:changed', 'review:exported', 'review:promote',
  'ui:refresh', 'ui:settings', 'ui:focus-url',
  'ui:palette',
  'update:ready',
  'sb:state', 'sb:console',
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
