const { contextBridge, ipcRenderer } = require("electron");

const versionArg = process.argv.find((arg) =>
  arg.startsWith("--forma-version="),
);
const version = versionArg ? versionArg.slice("--forma-version=".length) : "";

contextBridge.exposeInMainWorld("formaDesktop", {
  version,
  platform: process.platform,
  onMenuAction(listener) {
    const handler = (_event, action) => listener(action);
    ipcRenderer.on("forma:menu-action", handler);
    return () => ipcRenderer.removeListener("forma:menu-action", handler);
  },
  localLibraryAddress() {
    return ipcRenderer.invoke("forma:local-library-address");
  },
  readPendingChunk() {
    return ipcRenderer.invoke("forma:read-pending-chunk");
  },
  consumePendingFile() {
    return ipcRenderer.invoke("forma:consume-pending-file");
  },
});
