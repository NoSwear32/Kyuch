const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kyuch', {
  // the only events the page may subscribe to
  onWindowState: (cb) => ipcRenderer.on('win:state', (_e, maximized) => cb(maximized)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, u) => cb(u)),
  onAutoLock: (cb) => ipcRenderer.on('app:autolock', () => cb()),
  onLocked: (cb) => ipcRenderer.on('app:locked', () => cb()),
  onStateChanged: (cb) => ipcRenderer.on('state:changed', (_e, s) => cb(s)),
  onCfgChanged: (cb) => ipcRenderer.on('cfg:changed', (_e, c) => cb(c)),
  onActivity: (cb) => ipcRenderer.on('app:activity', () => cb()),
  call: async (channel, arg) => {
    const r = await ipcRenderer.invoke(channel, arg);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
});
