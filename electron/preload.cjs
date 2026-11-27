const { contextBridge, ipcRenderer } = require("electron");

const versionArg = process.argv.find((arg) =>
  arg.startsWith("--forma-version="),
);
const version = versionArg ? versionArg.slice("--forma-version=".length) : "";
const fileActions = new Set([
  "save",
  "saveAs",
  "newTab",
  "closeTab",
  "reopenTab",
]);
const openFileListeners = new Set();
const bufferedOpens = [];

// A loaded document can receive native opens before its workspace has mounted.
ipcRenderer.on("forma:open-file-in-tab", (_event, info) => {
  if (!openFileListeners.size) bufferedOpens.push(info);
  else for (const listener of openFileListeners) listener(info);
});

contextBridge.exposeInMainWorld("formaDesktop", {
  version,
  platform: process.platform,
  agentConfigured: process.argv.includes("--forma-agent-configured=1"),
  hasConfiguredAgent() {
    return ipcRenderer.invoke("forma:has-configured-agent");
  },
  bindPendingFile(fileKey) {
    return ipcRenderer.invoke("forma:bind-pending-file", fileKey);
  },
  getBoundFile(fileKey) {
    return ipcRenderer.invoke("forma:get-bound-file", fileKey);
  },
  saveNativeFile(options) {
    return ipcRenderer.invoke("forma:save-native-file", options);
  },
  openInNewWindow(query) {
    return ipcRenderer.invoke("forma:open-in-new-window", query);
  },
  closeCurrentWindow() {
    return ipcRenderer.invoke("forma:close-current-window");
  },
  onOpenFileInTab(listener) {
    openFileListeners.add(listener);
    void ipcRenderer.invoke("forma:open-file-in-tab-ready").catch(() => {});
    for (const info of bufferedOpens.splice(0)) listener(info);
    return () => openFileListeners.delete(listener);
  },
  onMenuAction(listener, fileActionListener) {
    // Existing edit handlers pass every event to the canvas action dispatcher.
    // File operations belong to the document owner and have a separate callback.
    const handler = (_event, action) => {
      if (fileActions.has(action)) fileActionListener?.(action);
      else listener(action);
    };
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
