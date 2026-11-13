// Who: Tim Buglaev
// When: 2026-06-13
// What: Extended the secure IPC bridge with narrow runtime-config and notes-panel methods so
//       renderers can toggle TurboQuant/open UI while process control stays in Electron main.
const { contextBridge, ipcRenderer } = require("electron");

// Who: Tim Buglaev
// When: 2026-07-10
// What: Apply only allowlisted main-process theme arguments before first paint,
//       default missing arguments to Graphite, and retain narrow one-way IPC updates.
const SUPPORTED_THEMES = new Set(["noda-red", "classic-blue"]);
const THEME_ARGUMENT_PREFIX = "--noda-theme=";
const LANGUAGE_ARGUMENT_PREFIX = "--noda-language=";
const interfaceLanguage = process.argv.find((argument) => argument.startsWith(LANGUAGE_ARGUMENT_PREFIX))
  ?.slice(LANGUAGE_ARGUMENT_PREFIX.length) || "en";
let currentPreferences = {};
try {
  currentPreferences = JSON.parse(process.argv.find(argument => argument.startsWith("--noda-preferences="))
    ?.slice("--noda-preferences=".length) || "{}");
} catch { /* Renderer validation retains safe defaults for malformed launch arguments. */ }
ipcRenderer.on("quick-note:preferences-changed", (_event, preferences) => { currentPreferences = preferences; });
const backendOrigin = process.argv.includes("--noda-backend-port=18741")
  ? "http://127.0.0.1:18741" : "http://127.0.0.1:5000";
let currentTheme = process.argv
  .find((argument) => argument.startsWith(THEME_ARGUMENT_PREFIX))
  ?.slice(THEME_ARGUMENT_PREFIX.length);
if (!SUPPORTED_THEMES.has(currentTheme)) {
  currentTheme = "classic-blue";
}

function applyTheme(theme) {
  if (!SUPPORTED_THEMES.has(theme)) {
    return;
  }
  currentTheme = theme;
  const applyToRoot = () => {
    if (!document.documentElement) {
      return;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = "dark";
  };
  if (document.documentElement) {
    applyToRoot();
  } else {
    window.addEventListener("DOMContentLoaded", applyToRoot, { once: true });
  }
}

applyTheme(currentTheme);
ipcRenderer.on("quick-note:theme-changed", (_event, theme) => applyTheme(theme));

contextBridge.exposeInMainWorld("quickNoteBridge", {
  getBackendOrigin: () => backendOrigin,
  onQuickNoteFocusInput: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = () => callback();
    ipcRenderer.on("quick-note:focus-input", handler);
    return () => ipcRenderer.removeListener("quick-note:focus-input", handler);
  },
  ensureBackendReady: (context) => ipcRenderer.invoke("quick-note:ensure-backend", context),
  ensureChatRuntimeReady: (context) => ipcRenderer.invoke("quick-note:ensure-chat-runtime", context),
  ensureGenerationRuntimeReady: (draft) => ipcRenderer.invoke("quick-note:ensure-generation-runtime", {
    prompt: draft?.prompt, mode: draft?.mode,
    ...(draft?.projectId != null ? { projectId: draft.projectId, contextToken: draft.contextToken } : {}),
  }),
  // Who: Tim Buglaev
  // When: 2026-06-14
  // What: Expose read-only startup status updates so renderers can block their
  //       UI until backend, Qdrant, and managed vLLM are ready.
  getStartupStatus: () => ipcRenderer.invoke("quick-note:get-startup-status"),
  getLanguage: () => interfaceLanguage,
  getPreferences: () => currentPreferences,
  restartAppForSettings: () => ipcRenderer.invoke("quick-note:restart-for-settings"),
  setupSemanticSearch: () => ipcRenderer.invoke("quick-note:setup-semantic-search"),
  onPreferencesChanged: callback => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, preferences) => callback(preferences);
    ipcRenderer.on("quick-note:preferences-changed", handler);
    return () => ipcRenderer.removeListener("quick-note:preferences-changed", handler);
  },
  selectStartupLanguage: (language) => ipcRenderer.invoke("quick-note:select-startup-language", language),
  onStartupStatus: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quick-note:startup-status", handler);
    return () => ipcRenderer.removeListener("quick-note:startup-status", handler);
  },
  // Who: Tim Buglaev
  // When: 2026-06-30
  // What: Expose only the startup-folder handshake and native-dialog commands;
  //       renderer input never supplies a filesystem path to the main process.
  notifyStartupRendererReady: () => ipcRenderer.invoke("quick-note:startup-renderer-ready"),
  chooseStartupNotesDirectory: () => ipcRenderer.invoke("quick-note:choose-startup-notes-directory"),
  confirmStartupNotesDirectory: () => ipcRenderer.invoke("quick-note:confirm-startup-notes-directory"),
  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Expose read-only settings model-switch progress separately from startup
  //       state so the notes renderer can show its own lightweight animation.
  onSettingsModelProgress: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quick-note:settings-model-progress", handler);
    return () => ipcRenderer.removeListener("quick-note:settings-model-progress", handler);
  },
  // Who: Tim Buglaev
  // When: 2026-06-13
  // What: Added a narrow window-opening bridge for the notes panel while keeping all
  //       filesystem and process controls outside renderer-accessible APIs.
  openNotesPanel: () => ipcRenderer.invoke("quick-note:open-notes-panel"),
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Expose only typed startup model and TurboQuant choices; backend downloads,
  //       compatibility checks, persistence, and runtime lifecycle remain in main.
  selectStartupModel: (payload) => ipcRenderer.invoke("quick-note:select-startup-model", payload),
  applyStartupNotePairs: (selection) => ipcRenderer.invoke("quick-note:apply-startup-note-pairs", selection),
  previewNoteModel: (payload) => ipcRenderer.invoke("quick-note:preview-note-model", payload),
  cancelModelDownload: () => ipcRenderer.invoke("quick-note:cancel-model-download"),
  importNoteModel: (payload) => ipcRenderer.invoke("quick-note:import-note-model", payload),
  onNoteModelImportProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("quick-note:note-model-import-progress", handler);
    return () => ipcRenderer.removeListener("quick-note:note-model-import-progress", handler);
  },
  selectStartupTurboQuant: (payload) => ipcRenderer.invoke("quick-note:select-startup-turboquant", payload),
  updateRuntimeConfig: (payload) => ipcRenderer.invoke("quick-note:update-runtime-config", payload),
  // Who: Tim Buglaev
  // When: 2026-06-23
  // What: Expose typed settings commands only; renderers never receive fs, dialog,
  //       download, environment, or process-control primitives.
  getAppSettings: () => ipcRenderer.invoke("quick-note:get-app-settings"),
  getProjects: () => ipcRenderer.invoke("quick-note:get-projects"),
  createProject: (payload) => ipcRenderer.invoke("quick-note:create-project", payload),
  connectProject: () => ipcRenderer.invoke("quick-note:connect-project"),
  switchProject: (id) => ipcRenderer.invoke("quick-note:switch-project", id),
  reportProjectCount: (payload) => ipcRenderer.invoke("quick-note:report-project-count", payload),
  openProjectFolder: (payload) => ipcRenderer.invoke("quick-note:open-project-folder", payload),
  renameProject: (payload) => ipcRenderer.invoke("quick-note:rename-project", payload),
  detachProject: (payload) => ipcRenderer.invoke("quick-note:detach-project", payload),
  backupProject: (payload) => ipcRenderer.invoke("quick-note:backup-project", payload),
  onProjectState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("quick-note:project-state", handler);
    return () => ipcRenderer.removeListener("quick-note:project-state", handler);
  },
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Expose the current validated theme as read-only state for UI diagnostics.
  getTheme: () => currentTheme,
  chooseNotesDirectory: () => ipcRenderer.invoke("quick-note:choose-notes-directory"),
  saveAppSettings: (payload) => ipcRenderer.invoke("quick-note:save-app-settings", payload),
  applySettingsModel: (payload) => ipcRenderer.invoke("quick-note:apply-settings-model", payload),
  previewChatModel: payload => ipcRenderer.invoke("quick-note:preview-chat-model", payload),
  downloadChatModel: payload => ipcRenderer.invoke("quick-note:download-chat-model", payload),
  onChatModelImportProgress: callback => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("quick-note:chat-model-import-progress", handler);
    return () => ipcRenderer.removeListener("quick-note:chat-model-import-progress", handler);
  },
  applySettingsNotePairs: (selection) => ipcRenderer.invoke("quick-note:apply-settings-note-pairs", selection),
  onSettingsNoteDownloadProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("quick-note:settings-note-download-progress", handler);
    return () => ipcRenderer.removeListener("quick-note:settings-note-download-progress", handler);
  },
  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Expose narrow startup-window controls for a custom frameless titlebar;
  //       Electron main still validates the sender before hiding or stopping launch.
  closeStartupWindow: () => ipcRenderer.invoke("quick-note:close-startup-window"),
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Expose one automatic-completion command so the startup renderer can open
  //       notes only through main-process sender and readiness validation.
  completeStartup: () => ipcRenderer.invoke("quick-note:complete-startup"),
  minimizeStartupWindow: () => ipcRenderer.invoke("quick-note:minimize-startup-window"),
  stopStartup: () => ipcRenderer.invoke("quick-note:stop-startup"),
  onStartupCloseRequest: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = () => callback();
    ipcRenderer.on("quick-note:startup-close-request", handler);
    return () => ipcRenderer.removeListener("quick-note:startup-close-request", handler);
  },
  getHotkey: () => ipcRenderer.invoke("quick-note:get-hotkey"),
  setQuickCaptureHeight: (height) => ipcRenderer.invoke("quick-note:resize-capture", height),
  toggleWindow: () => ipcRenderer.invoke("quick-note:toggle-window"),
});
