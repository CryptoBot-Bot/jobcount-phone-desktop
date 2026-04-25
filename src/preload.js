// src/preload.js
//
// Secure bridge between the main process (Node, disk, keychain) and the
// renderer (sandboxed browser). Exposes only the methods the UI needs.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jobcountPhone", {
  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),
  getDeviceToken: () => ipcRenderer.invoke("config:device-token"),
  savePairing: (payload) => ipcRenderer.invoke("config:save-pairing", payload),
  setLabel: (label) => ipcRenderer.invoke("config:set-label", label),
  clearConfig: () => ipcRenderer.invoke("config:clear"),

  // HTTP
  apiRequest: ({ method, path, body, authenticated } = {}) =>
    ipcRenderer.invoke("api:request", { method, path, body, authenticated }),
  getVoiceToken: () => ipcRenderer.invoke("api:voice-token"),
  pairRedeem: ({ serverUrl, body } = {}) =>
    ipcRenderer.invoke("api:pair-redeem", { serverUrl, body }),

  // System info for pairing payload
  systemInfo: () => ipcRenderer.invoke("system:info"),

  // Window controls
  minimizeToTray: () => ipcRenderer.invoke("window:minimize-to-tray"),
  alertIncoming:  () => ipcRenderer.invoke("window:alert-incoming"),
  quit: () => ipcRenderer.invoke("app:quit"),

  // Group conference window
  openGroupWindow:  (payload) => ipcRenderer.invoke("window:group-open",  payload),
  closeGroupWindow: () => ipcRenderer.invoke("window:group-close"),

  // System wake events (OS resume / session unlock / user-active).
  // Renderer subscribes and can e.g. re-verify its Twilio connection
  // because a long suspend tends to expire the token.
  onSystemWake: (handler) => {
    const listener = (_evt, payload) => { try { handler(payload); } catch {} };
    ipcRenderer.on("system:wake", listener);
    return () => ipcRenderer.removeListener("system:wake", listener);
  },

  // Auto-update: electron-updater pulls new installers from GitHub
  // Releases. The renderer shows progress + prompts the user to install.
  onUpdateState: (handler) => {
    const listener = (_evt, payload) => { try { handler(payload); } catch {} };
    ipcRenderer.on("app:update-state", listener);
    return () => ipcRenderer.removeListener("app:update-state", listener);
  },
  checkForUpdates:   () => ipcRenderer.invoke("app:check-for-updates"),
  installUpdateNow:  () => ipcRenderer.invoke("app:install-update-now"),
  getUpdateState:    () => ipcRenderer.invoke("app:get-update-state"),

  // Dev-only: bump version + commit + tag + push to trigger a release.
  // Returns { ok, jobId, version, tagName } when complete; renderer
  // subscribes to onPublishLog for live progress.
  publishUpdate:     (payload) => ipcRenderer.invoke("app:publish-update", payload),
  publishReadiness:  () => ipcRenderer.invoke("app:publish-readiness"),
  onPublishLog: (handler) => {
    const listener = (_evt, payload) => { try { handler(payload); } catch {} };
    ipcRenderer.on("app:publish-log", listener);
    return () => ipcRenderer.removeListener("app:publish-log", listener);
  },
});
