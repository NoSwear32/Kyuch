const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keeper', {
  call: async (channel, arg) => {
    const r = await ipcRenderer.invoke(channel, arg);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
});
