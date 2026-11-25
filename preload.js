'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  status: (refresh) => ipcRenderer.invoke('app:status', Boolean(refresh)),
  list: (remote, remotePath) => ipcRenderer.invoke('fs:list', { remote, path: remotePath }),
  connect: (payload) => ipcRenderer.invoke('auth:connect', payload),
  cancelConnect: () => ipcRenderer.invoke('auth:cancel'),
  move: (payload) => ipcRenderer.invoke('transfer:start', payload),
  resumeMove: (id) => ipcRenderer.invoke('transfer:resume', id),
  cancelMove: () => ipcRenderer.invoke('transfer:cancel'),
  ackMove: (id) => ipcRenderer.invoke('transfer:ack', id),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    test: (payload) => ipcRenderer.invoke('settings:test', payload),
    save: (payload) => ipcRenderer.invoke('settings:save', payload),
  },
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('transfer:progress', listener);
    return () => ipcRenderer.removeListener('transfer:progress', listener);
  },
});
