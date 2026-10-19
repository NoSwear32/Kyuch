const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kyuch', {
  onWindowState: (cb) => ipcRenderer.on('win:state', (_e, maximized) => cb(maximized)), // the only event the page may subscribe to
  call: async (channel, arg) => {
    const r = await ipcRenderer.invoke(channel, arg);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
});
