const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "startup",
  Object.freeze({
    onProgress(callback) {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("startup:progress", listener);
      return () => ipcRenderer.removeListener("startup:progress", listener);
    },
    cancel: () => ipcRenderer.send("startup:cancel"),
  }),
);
