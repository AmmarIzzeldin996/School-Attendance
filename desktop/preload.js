'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  if (typeof callback !== 'function') return function () {};
  const listener = (_event, payload) => {
    try { callback(payload); } catch (error) { console.error(error); }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopSA', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  onSyncApplied: (callback) => on('desktop:sync-applied', callback),
  onBackupFinished: (callback) => on('desktop:backup-finished', callback),
  onStatusChanged: (callback) => on('desktop:status-changed', callback),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', String(url || '')),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data-folder'),
  openFile: (path) => ipcRenderer.invoke('desktop:open-file', String(path || '')),
  openBackups: () => ipcRenderer.invoke('desktop:open-backups'),
  recoverAdmin: () => ipcRenderer.invoke('desktop:recover-admin'),
  quit: () => ipcRenderer.invoke('desktop:quit')
});
