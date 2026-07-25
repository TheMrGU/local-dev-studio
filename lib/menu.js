// lib/menu.js — a real application menu. The default Electron menu exposes
// developer chrome and no app actions, which reads as unfinished software.
const { Menu, shell, app } = require('electron');

function buildMenu({ win, send, onStopAllHosts, openCapturesFolder, logPath }) {
  const template = [
    {
      label: '&File',
      submenu: [
        {
          label: 'New capture',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('ui:focus-url'),
        },
        {
          label: 'Refresh library',
          accelerator: 'F5',
          click: () => send('ui:refresh'),
        },
        { type: 'separator' },
        { label: 'Open captures folder', click: openCapturesFolder },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send('ui:settings'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '&Sites',
      submenu: [
        { label: 'Stop all local servers', click: onStopAllHosts },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Setup & diagnostics', click: () => send('ui:doctor') },
        { label: 'Open log file', click: () => shell.openPath(logPath()) },
        { type: 'separator' },
        { label: 'Toggle developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: `About ${app.getName()}`, click: () => send('ui:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
