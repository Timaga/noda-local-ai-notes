// Who: Tim Buglaev
// When: 2026-05-28
// What: Rebuilt the Electron main process file with repaired Russian tray labels, preserved
//       secure renderer isolation, local .env bootstrap, backend startup, and tray hotkey behavior.
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  dialog,
  nativeImage,
  screen,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");

// Who: Tim Buglaev
// When: 2026-06-24
// What: Enforce one desktop owner for the fixed loopback ports and managed child
//       processes so a second launcher cannot race the first backend during startup.
const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) {
  app.quit();
}
// Who: Tim Buglaev
// When: 2026-06-21
// What: Reuse the focused readiness helper so cold vLLM startup can be tested
//       independently from Electron window and process orchestration.
const { formatDuration, resolveWslHfHome, waitForRuntimeEndpoint } = require("./runtime_readiness");
// Who: Tim Buglaev
// When: 2026-06-23
// What: Keep preference validation and atomic disk writes outside the Electron orchestrator.
const {
  DEFAULT_LANGUAGE,
  DEFAULT_THEME,
  loadDesktopSettings,
  normalizeNotesDirectory,
  saveDesktopSettings,
  validateDesktopSettings,
} = require("./desktop_settings");
const { createStartupLanguageSelection } = require("./startup_language");
const { translate: translateUi } = require("./ui_languages");
const { localizeDesktopMenu } = require("./desktop_menu");
// Who: Tim Buglaev
// When: 2026-07-02
// What: Combine bounded Electron and nvidia-smi diagnostics, then evaluate
//       TurboQuant only from trusted runtime, catalog, and hardware metadata.
const { buildHardwareProfile, detectNvidiaGpu } = require("./hardware_profile");
const { evaluateTurboQuantCapability } = require("./turboquant_capability");
const { initializeOwnedProfileEnvironment, applyOwnedProfileSettings, assertProfileMutable } = require("./owned_note_profile");
const { usesRuNotePipeline, shouldStartManagedAtStartup, startupReadyStatus, ensureChatRuntimeReady, ensureGenerationRuntimeReady } = require("./ru_note_startup");
const { protectRenderer, isTrustedRenderer, isTrustedSender: isGenerationSender } = require("./renderer_trust");
const { createStartupNoteSelection, saveNotePairs } = require("./note_pair_selection");
const {
  NoteModelDownloadError, prepareNoteModels, previewNoteModel, importNoteModel, downloadChatModel, downloadPortableChatPreset,
} = require("./note_model_download");
const { resolveProjectRoot, findPortableSource } = require("./project_paths");
const { portablePaths, reserveLoopbackPort, setupPortableRuntime, saveEmbeddingChoice } = require("./portable_runtime");
const { createDesktopProjectBridge } = require("./desktop_project_bridge");
const { waitForBackendPortRelease } = require("./backend_port");
const { ensureTray } = require("./tray_controller");
const { createHotkeyController } = require("./desktop_hotkey");
const { registerPreferencesBridge, broadcastPreferences } = require("./desktop_preferences_bridge");
const { normalizePreferences } = require("./desktop_preferences");
const { QUICK_CAPTURE_WINDOW, createQuickCaptureController } = require("./quick_capture_window");

// Who: Tim Buglaev
// When: 2026-06-15
// What: Keep backend and managed vLLM readiness independently bounded; vLLM gets
//       a longer deadline because first-run Hugging Face verification and GPU weight
//       loading can legitimately exceed the old three-minute attempt window.
const BACKEND_READY_ATTEMPTS = parsePositiveIntEnv("BACKEND_READY_ATTEMPTS", 480);
const BACKEND_READY_DELAY_MS = parsePositiveIntEnv("BACKEND_READY_DELAY_MS", 1000);
const MANAGED_RUNTIME_READY_DELAY_MS = 1000;
const MANAGED_RUNTIME_READY_TIMEOUT_MS = 30 * 60 * 1000;
const MANAGED_RUNTIME_PROBE_TIMEOUT_MS = 2000;
const MANAGED_RUNTIME_PROGRESS_INTERVAL_MS = 15000;
const PROCESS_STOP_TIMEOUT_MS = 15000;
const HTTP_REQUEST_TIMEOUT_MS = 5000;
const BACKEND_PING_TIMEOUT_MS = 1000;
const PROJECT_ROOT = resolveProjectRoot({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  frontendDir: __dirname,
});
const PORTABLE_RUNTIME = app.isPackaged && process.platform === "win32" && findPortableSource(process.resourcesPath)
  ? portablePaths(PROJECT_ROOT, process.env.LOCALAPPDATA) : null;
const BACKEND_PORT = PORTABLE_RUNTIME ? 18741 : 5000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
let portableSetupController = null;
let portableDependenciesReady = false;
const BACKEND_PACKAGE_DIR = path.join(PROJECT_ROOT, "backend");
const BACKEND_RUNTIME_MODULE = "backend.app_runtime";
// Who: Tim Buglaev
// When: 2026-07-09
// What: Use transparent rounded Noda artwork for native windows, taskbar, installer,
//       and tray; paths remain application-local and renderer input cannot replace them.
const APP_NAME = "Noda";
const APP_USER_MODEL_ID = "ai.buglai.noda";
const APP_ICON_PATH = path.join(__dirname, "assets", "noda-icon.ico");
const TRAY_ICON_PATH = path.join(__dirname, "assets", "noda-tray.png");
app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
// Who: Tim Buglaev
// When: 2026-06-22
// What: Create a per-launch secret for the loopback lifecycle endpoint; it is passed only
//       to the owned backend process and is never exposed to renderers or application logs.
const BACKEND_SHUTDOWN_TOKEN = crypto.randomBytes(32).toString("hex");
// Who: Tim Buglaev
// When: 2026-06-24
// What: Tag the managed Flask child with a non-secret per-launch identity so readiness
//       probes reject stale or foreign processes that happen to own port 5000.
const BACKEND_INSTANCE_ID = crypto.randomUUID();

function loadLocalEnvFile() {
  const envPath = path.join(BACKEND_PACKAGE_DIR, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(envPath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!key) {
        return;
      }
      // Who: Tim Buglaev
      // When: 2026-06-15
      // What: Treat backend/.env as the desktop app runtime source of truth so
      //       stale PowerShell environment variables cannot silently switch local
      //       GGUF startup back to WSL/vLLM or an old TurboQuant profile.
      process.env[key] = value;
    });
  } catch (error) {
    console.warn(`[env] Failed to load ${envPath}:`, error);
  }
}

const OWNED_NOTE_PROFILE = initializeOwnedProfileEnvironment(process.env, PROJECT_ROOT, loadLocalEnvFile);

const HOTKEY = process.env.QUICK_NOTE_HOTKEY || "CommandOrControl+Shift+Space";
const CLOSE_TO_TRAY = parseBoolEnv(process.env.QUICK_NOTE_CLOSE_TO_TRAY, true);
const MANAGED_VLLM_AUTOSTART = parseBoolEnv(process.env.RAG_VLLM_AUTOSTART, true);
const WSL_TERMINATE_ON_EXIT = !PORTABLE_RUNTIME && parseBoolEnv(process.env.RAG_VLLM_WSL_TERMINATE_ON_EXIT, false);
const AUTO_QUIT_AFTER_READY_MS = parsePositiveIntEnv("TEST_GUI_AUTO_QUIT_AFTER_READY_MS", 0);
// Who: Tim Buglaev
// When: 2026-06-15
// What: Added startup model-selection controls before model warmup, with
//       explicit timeouts for catalog reads, large HF downloads, and GGUF swaps.
const MODEL_SELECTION_ON_STARTUP = parseBoolEnv(process.env.RAG_MODEL_SELECTION_ON_STARTUP, true);
const MODEL_CATALOG_TIMEOUT_MS = parsePositiveIntEnv("RAG_MODEL_CATALOG_TIMEOUT_MS", 15000);
const MODEL_DOWNLOAD_TIMEOUT_MS = parsePositiveIntEnv("RAG_MODEL_DOWNLOAD_TIMEOUT_MS", 3600000);
const MODEL_SWAP_TIMEOUT_MS = parsePositiveIntEnv("RAG_MODEL_SWAP_TIMEOUT_MS", 900000);
const GPU_INFO_TIMEOUT_MS = 3000;
const STARTUP_SURFACE_READY_TIMEOUT_MS = 5000;
// Who: Tim Buglaev
// When: 2026-06-23
// What: Load user-specific startup and vault preferences before spawning backend so every
//       child receives one validated notes path and renderer input cannot alter process env.
const DEFAULT_NOTES_DIRECTORY = PORTABLE_RUNTIME
  ? path.join(app.getPath("userData"), "notes") : path.join(BACKEND_PACKAGE_DIR, "notes", "Мои заметки");
const DESKTOP_SETTINGS_DEFAULTS = Object.freeze({
  notesDirectory: process.env.NOTES_DIR || DEFAULT_NOTES_DIRECTORY,
  skipModelSelection: !MODEL_SELECTION_ON_STARTUP,
  skipNotesDirectorySelection: false,
  skipTurboQuantSelection: false,
  theme: DEFAULT_THEME,
  language: DEFAULT_LANGUAGE,
  quickNoteHotkey: HOTKEY,
});
const DESKTOP_SETTINGS_PATH = path.join(app.getPath("userData"), "desktop-settings.json");
let desktopSettings = loadDesktopSettings(DESKTOP_SETTINGS_PATH, DESKTOP_SETTINGS_DEFAULTS);
desktopSettings = applyOwnedProfileSettings(OWNED_NOTE_PROFILE, desktopSettings, process.env);
const desktopHotkey = createHotkeyController({ shortcuts: globalShortcut,
  initial: desktopSettings.quickNoteHotkey, toggle: () => toggleQuickWindow(), text: uiText });
const startupLanguage = createStartupLanguageSelection({
  initialLanguage: desktopSettings.language,
  bypass: AUTO_QUIT_AFTER_READY_MS > 0 || Boolean(OWNED_NOTE_PROFILE),
  persist: (language) => {
    desktopSettings = saveDesktopSettings(DESKTOP_SETTINGS_PATH, { ...desktopSettings, language },
      DESKTOP_SETTINGS_DEFAULTS, { allowUnavailableDirectory: true });
  },
  showPrompt: () => {
    broadcastStartupStatus({ state: "language-select", phase: "language-select", progress: 1 });
    showStartupWindow();
  },
});

function uiText(ru, en) {
  return translateUi(startupLanguage.getLanguage() || "en", ru, en);
}

async function ensurePortableDependencies() {
  if (portableDependenciesReady) return;
  portableSetupController = new AbortController();
  const setup = portableSetupController;
  const component = {
    validation: ["Проверяем файлы установки", "Checking setup files"],
    python: ["Python", "Python"], qdrant: ["Поиск Qdrant", "Qdrant search"],
    llama: ["Движок локальных моделей", "Local model engine"],
    dependencies: ["Пакеты приложения", "Application packages"],
    prerequisite: ["Библиотеки Windows", "Windows libraries"],
    embedding: ["Модель смыслового поиска", "Semantic search model"],
    ready: ["Проверяем установку", "Checking the installation"],
  };
  const phases = ["prerequisite", "python", "qdrant", "llama", "dependencies", "embedding"];
  const publishSetup = (detail, completed, total, installing = false) => broadcastStartupStatus({
    state: "loading", phase: "backend", message: installing
      ? uiText("Устанавливаем Noda", "Setting up Noda") : uiText("Запускаем Noda", "Starting Noda"), detail,
    progress: Math.round(completed / total * 20),
    provisioning: { completed, total },
  });
  publishSetup(uiText("Проверяем локальные компоненты.", "Checking local components."), 0, 5);
  try {
    const environment = await setupPortableRuntime(PORTABLE_RUNTIME, {
      signal: setup.signal,
      forceEmbedding: process.argv.includes("--install-semantic-search"),
      approveVcRuntime: async () => {
        const { response } = await dialog.showMessageBox(startupWindow, {
          type: "warning", title: APP_NAME,
          message: uiText("Нужны библиотеки Microsoft Visual C++", "Microsoft Visual C++ is required"),
          detail: uiText("Noda скачает и запустит подписанный установщик Microsoft. Windows может запросить разрешение администратора.",
            "Noda will download and run the signed Microsoft installer. Windows may ask for administrator approval."),
          buttons: [uiText("Установить", "Install"), uiText("Выйти", "Quit")],
          defaultId: 0, cancelId: 1, noLink: true,
        });
        return response === 0;
      },
      ...(AUTO_QUIT_AFTER_READY_MS <= 0 && {
        continueWithoutEmbedding: async () => {
          const { response } = await dialog.showMessageBox(startupWindow, {
            type: "warning", title: APP_NAME,
            message: uiText("Модель смыслового поиска недоступна", "Semantic search model unavailable"),
            detail: uiText("Можно открыть заметки с текстовым поиском. Чтобы позже установить модель, выберите «Настроить смысловой поиск» в меню Noda у часов Windows.",
              "You can open your notes with text search. To install the model later, select Set up semantic search in the Noda menu by the Windows clock."),
            buttons: [uiText("Открыть заметки", "Open notes"), uiText("Выйти", "Quit")],
            defaultId: 0, cancelId: 1, noLink: true,
          });
          return response === 0;
        },
      }),
      onProgress: ({ phase, status, includeEmbedding }) => {
        if (isQuitting || !["started", "cached", "complete"].includes(status)) return;
        const total = includeEmbedding ? phases.length : phases.length - 1;
        const index = phases.indexOf(phase);
        const completed = phase === "ready" ? total : index < 0 ? 0 : index + (status === "started" ? 0 : 1);
        publishSetup(uiText(...component[phase]), completed, total, status === "started");
      },
    });
    if (!environment) {
      requestAppQuit();
      throw new Error("Setup canceled");
    }
    Object.assign(process.env, environment);
    fs.mkdirSync(DEFAULT_NOTES_DIRECTORY, { recursive: true });
    portableDependenciesReady = true;
  } finally {
    if (!isQuitting) broadcastStartupStatus({ provisioning: null });
    if (portableSetupController === setup) portableSetupController = null;
  }
}

let settingsRuntimeUpdateInProgress = false;
let desktopProjectBridge = null;
let projectInitializationError = null;
function projects() {
  if (!desktopProjectBridge) desktopProjectBridge = createDesktopProjectBridge({
    userData: app.getPath("userData"), environment: process.env,
    backendUrl: BACKEND_URL, shutdownToken: BACKEND_SHUTDOWN_TOKEN,
    fetchWithTimeout, readJsonResponse, ownedProfile: OWNED_NOTE_PROFILE,
    text: uiText, dialog, openProjectFolder: directory => shell.openPath(directory), ensureReady: ensureBackendReady,
    isReadSender: event => isGenerationSender(event, [quickWindow, notesWindow]),
    isNotesSender: isNotesWindowSender, getNotesWindow: () => notesWindow,
    windows: () => [notesWindow, quickWindow],
    assertMutable: () => assertProfileMutable(OWNED_NOTE_PROFILE),
    isBusy: () => settingsRuntimeUpdateInProgress,
    setBusy: value => { settingsRuntimeUpdateInProgress = value; },
    persistDirectory: directory => {
      desktopSettings = saveDesktopSettings(DESKTOP_SETTINGS_PATH,
        { ...desktopSettings, notesDirectory: directory }, DESKTOP_SETTINGS_DEFAULTS);
    },
    stopBackend: async previousContext => {
      startupBroadcastSuppressionDepth += 1;
      try {
        if (backendProcess && backendHttpReadyConfirmed) await stopBackendManagedServices(previousContext, true);
        await stopBackendProcess();
        await waitForBackendPortRelease({ port: BACKEND_PORT, reserve: reserveLoopbackPort, delay });
      } finally { startupBroadcastSuppressionDepth = Math.max(0, startupBroadcastSuppressionDepth - 1); }
    },
    restartBackend: async () => {
      startupBroadcastSuppressionDepth += 1;
      try {
        return await ensureBackendHttpReady();
      } finally { startupBroadcastSuppressionDepth = Math.max(0, startupBroadcastSuppressionDepth - 1); }
    },
    completeBackendStart: async () => {
      const runtime = await fetchRuntimeConfig({ announceStartup: false });
      appReadyPromise = Promise.resolve({ ok: true, runtime });
      return runtime;
    },
  });
  return desktopProjectBridge;
}
try {
  const restored = projects().restoredDirectory();
  if (restored) desktopSettings = { ...desktopSettings, notesDirectory: restored };
} catch (_) {
  projectInitializationError = new Error(uiText("Не удалось прочитать реестр проектов Noda. Сохранённые папки не изменены.",
    "Could not read the Noda project registry. Saved folders are unchanged."));
}
process.env.NOTES_DIR = desktopSettings.notesDirectory;
// Who: Tim Buglaev
// When: 2026-07-02
// What: Pass the validated theme into every sandboxed renderer before first paint;
//       the preload can apply it without exposing filesystem or process primitives.
function createSecureWindowPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [`--noda-theme=${desktopSettings.theme}`, `--noda-language=${startupLanguage.getLanguage() || "en"}`,
      `--noda-backend-port=${BACKEND_PORT}`, `--noda-preferences=${JSON.stringify(normalizePreferences(desktopSettings))}`],
  };
}
// Who: Tim Buglaev
// When: 2026-07-02
// What: Render normal startup as a small portrait card while retaining automatic
//       expansion for the full model and notes-directory selection screens.
const STARTUP_COMPACT_WINDOW = { width: 360, height: 400, minWidth: 360, minHeight: 400 };
const STARTUP_MODEL_SELECT_WINDOW = { width: 1448, height: 1086, minWidth: 900, minHeight: 680 };
const STARTUP_NOTES_DIRECTORY_WINDOW = { width: 1120, height: 820, minWidth: 760, minHeight: 620 };
const STARTUP_TURBOQUANT_WINDOW = { width: 680, height: 620, minWidth: 620, minHeight: 560 };
// Who: Tim Buglaev
// When: 2026-06-16
// What: Defined compact hotkey popup bounds separately from startup/model windows
//       so quick capture opens as a small bottom-centered panel after services are ready.

let quickWindow = null;
const quickCapture = createQuickCaptureController({ getWindow: () => quickWindow, screen });
// Who: Tim Buglaev
// When: 2026-06-15
// What: Track the dedicated startup progress window separately from quick capture
//       so launch loading/model selection never opens the hotkey note editor.
let startupWindow = null;
let startupWindowMode = "compact";
// Who: Tim Buglaev
// When: 2026-06-13
// What: Tracked the full notes management window separately from quick capture so users can
//       inspect, create, and delete indexed notes without changing hotkey capture behavior.
let notesWindow = null;
let tray = null;
// Who: Tim Buglaev
// When: 2026-07-02
// What: Apply a newly saved allowlisted theme to every live application surface;
//       destroyed windows are ignored and will receive it through startup arguments.
function broadcastTheme(theme) {
  [startupWindow, quickWindow, notesWindow].forEach((window) => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send("quick-note:theme-changed", theme);
      } catch (error) {
        console.warn(`[settings theme broadcast] ${error?.message || "unknown error"}`);
      }
    }
  });
}
// Who: Tim Buglaev
// When: 2026-07-02
// What: Track delayed global-hotkey registration so cold startup cannot intercept
//       CommandOrControl+Shift+Space before every required service is ready.
let hotkeyRegistered = false;
let backendProcess = null;
let managedBackendPid = null;
let managedQdrantPid = null;
let backendReadyPromise = null;
let backendHttpReadyConfirmed = false;
let appReadyPromise = null;
let managedRuntimeProcess = null;
let managedRuntimeReadyPromise = null;
let managedRuntimeKey = null;
let managedRuntimeMode = null;
// Who: Tim Buglaev
// When: 2026-06-21
// What: Preserve a safe child-exit reason after the process reference is cleared so
//       readiness polling fails immediately instead of waiting until its full deadline.
let managedRuntimeFailure = null;
// Who: Tim Buglaev
// When: 2026-06-14
// What: Track intentional shutdown output suppression so normal app close does
//       not show vLLM/Flask teardown noise while startup/runtime failures stay visible.
let suppressBackendOutput = false;
let suppressManagedRuntimeOutput = false;
let startupModelSelection = null;
let startupModelSelectionPromise = null;
const activeModelDownloads = new Map();

async function runModelDownload(sender, operation) {
  if (activeModelDownloads.has(sender)) throw new NoteModelDownloadError("busy");
  const controller = new AbortController();
  const abort = () => controller.abort();
  activeModelDownloads.set(sender, controller);
  sender.once("destroyed", abort);
  try {
    return await operation(controller.signal);
  } finally {
    sender.removeListener("destroyed", abort);
    activeModelDownloads.delete(sender);
  }
}

const startupNoteSelection = createStartupNoteSelection({
  show: (notePipeline) => {
    broadcastStartupStatus({
      state: "model-select",
      phase: "model-select",
      message: uiText("Выберите связки для заметок", "Choose model pairs for notes"),
      detail: uiText("Отдельная связка для каждого этапа.", "Choose a pair for each stage."),
      progress: 52,
      notePipeline,
      models: [],
    });
    showStartupWindow();
  },
  prepare: (selection, { signal } = {}) => prepareNoteModels(selection, {
    backendUrl: BACKEND_URL, fetchWithTimeout, signal,
    onProgress: progress => broadcastStartupStatus({
      noteModelDownload: progress && { ...progress, cancellable: Boolean(signal) },
    }),
  }),
  save: postNotePairSelection,
});
// Who: Tim Buglaev
// When: 2026-07-02
// What: Hold one startup TurboQuant decision at a time; only the trusted launcher
//       IPC can resolve it after server-side compatibility is rechecked.
let startupTurboQuantSelection = null;
let startupTurboQuantSelectionPromise = null;
// Who: Tim Buglaev
// When: 2026-06-30
// What: Coordinate one pre-backend vault selection and one renderer-ready handshake
//       so the loading screen paints before an optional interactive startup step.
let startupNotesDirectorySelection = null;
let startupNotesDirectorySelectionPromise = null;
let startupRendererReady = false;
let startupRendererReadyResolve = null;
const startupRendererReadyPromise = new Promise((resolve) => {
  startupRendererReadyResolve = resolve;
});
// Who: Tim Buglaev
// When: 2026-06-14
// What: Keep a main-process startup state machine for renderer loading screens so
//       windows stay blocked until backend, Qdrant indexing, and managed vLLM are ready.
let startupStatus = {
  state: "idle",
  phase: "idle",
  message: uiText("Ожидаем запуск приложения", "Waiting for Noda to start"),
  detail: uiText("Рабочие действия станут доступны после готовности сервисов.", "You can use the app once the local services are ready."),
  progress: 0,
  updatedAt: Date.now(),
};
// Who: Tim Buglaev
// When: 2026-07-01
// What: Distinguish the first application launch from later readiness rechecks so
//       prompt skips show startup progress without reopening it after settings changes.
let coldStartupPending = true;
// Who: Tim Buglaev
// When: 2026-06-24
// What: Suppress startup-only renderer broadcasts while an already running app
//       changes models from Settings, without altering runtime process ownership.
let startupBroadcastSuppressionDepth = 0;
let isQuitting = false;
let shutdownInProgress = false;
let shutdownComplete = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Added shared boolean parsing for runtime lifecycle toggles so Electron can
//       safely honor explicit env settings without treating malformed values as enabled.
function parseBoolEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parsePositiveIntEnv(name, defaultValue) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

// Who: Tim Buglaev
// When: 2026-06-24
// What: Broadcast startup progress to every renderer while keeping settings-time
//       model switches isolated from the already completed application launch.
function getStartupStatusPayload() {
  return { ...startupStatus, language: startupLanguage.getLanguage() || "en" };
}

function sendStartupStatusToWindow(win) {
  if (!win || win.isDestroyed()) {
    return;
  }
  win.webContents.send("quick-note:startup-status", getStartupStatusPayload());
}

function broadcastStartupStatus(partialStatus = {}) {
  if (startupBroadcastSuppressionDepth > 0) {
    return;
  }
  const parsedProgress = Number(partialStatus.progress);
  startupStatus = {
    ...startupStatus,
    ...partialStatus,
    progress: Number.isFinite(parsedProgress)
      ? Math.max(0, Math.min(100, parsedProgress))
      : startupStatus.progress,
    updatedAt: Date.now(),
  };
  applyStartupWindowSizeForStatus(startupStatus);
  sendStartupStatusToWindow(startupWindow);
  sendStartupStatusToWindow(quickWindow);
  sendStartupStatusToWindow(notesWindow);
}

// Who: Tim Buglaev
// When: 2026-06-24
// What: Send narrow settings-only model progress so runtime switching does not
//       reuse or mutate the application startup overlay.
function sendSettingsModelProgress(partialStatus = {}) {
  if (!notesWindow || notesWindow.isDestroyed() || notesWindow.webContents.isDestroyed()) {
    return;
  }
  const allowedStates = new Set(["loading", "ready", "error"]);
  const state = allowedStates.has(partialStatus.state) ? partialStatus.state : "loading";
  try {
    notesWindow.webContents.send("quick-note:settings-model-progress", {
      state,
      message: String(partialStatus.message || uiText("Переключаем модель", "Switching models")).slice(0, 160),
      detail: String(partialStatus.detail || "").slice(0, 500),
      progress: Math.max(0, Math.min(100, Number(partialStatus.progress) || 0)),
      ...(partialStatus.download && { download: partialStatus.download }),
    });
  } catch (error) {
    console.warn(`[settings model progress] renderer unavailable: ${error?.message || "unknown error"}`);
  }
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Added explicit fetch timeouts for backend/vLLM readiness probes so process
//       shutdown cannot hang behind an unbounded local HTTP request.
async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const scoped = typeof desktopProjectBridge === "object" && desktopProjectBridge
      ? desktopProjectBridge.decorateRequest(url, options) : options;
    return await fetch(url, {
      ...scoped,
      signal: scoped.signal ? AbortSignal.any([controller.signal, scoped.signal]) : controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Who: Tim Buglaev
// When: 2026-07-09
// What: Load the transparent rounded high-contrast tray asset and retain a rounded
//       SVG fallback so packaging failure cannot remove the application's tray control.
function createTrayIcon() {
  const trayImage = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (!trayImage.isEmpty()) {
    return trayImage.resize({ width: 16, height: 16 });
  }
  console.warn(`[tray icon] Failed to load ${TRAY_ICON_PATH}; using embedded fallback.`);
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <rect x="1" y="1" width="30" height="30" rx="7" fill="#121113"/>
    <path d="M5 16 15 6c3 0 5 2 7 4l3 3" fill="none" stroke="#ff5f57" stroke-width="2" stroke-linecap="round"/>
    <path d="M5 16 15 26c3 0 5-2 7-4l3-3" fill="none" stroke="#d9423b" stroke-width="2" stroke-linecap="round"/>
    <path d="M9 16 15 10c2 0 4 2 6 4" fill="none" stroke="#ff7a70" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M9 16 15 22c2 0 4-2 6-4" fill="none" stroke="#ff7a70" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="26" cy="16" r="3" fill="#ff6a57"/>
    <circle cx="26" cy="16" r="1.2" fill="#fff0c9"/>
  </svg>`;
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 16, height: 16 });
}

// Who: Tim Buglaev
// When: 2026-06-30
// What: Prefer the windowless Python launcher on Windows so starting the managed
//       backend cannot open a terminal; retain python.exe as a compatibility fallback.
function getPythonExecutable() {
  if (PORTABLE_RUNTIME) return PORTABLE_RUNTIME.backendPython;
  const localVenvExecutables = process.platform === "win32"
    ? [
      path.join(PROJECT_ROOT, ".venv", "Scripts", "pythonw.exe"),
      path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe"),
    ]
    : [path.join(PROJECT_ROOT, ".venv", "bin", "python")];
  const localExecutable = localVenvExecutables.find((candidate) => fs.existsSync(candidate));
  if (localExecutable) {
    return localExecutable;
  }
  return process.platform === "win32" ? "pythonw.exe" : "python3";
}

function startBackendProcess() {
  if (backendProcess && !backendProcess.killed) {
    return;
  }
  if (projectInitializationError) throw projectInitializationError;
  projects().prepareBackendStart(process.env.NOTES_DIR || desktopSettings.notesDirectory);

  broadcastStartupStatus({
    state: "loading",
    phase: "backend",
    message: uiText("Запускаем локальные сервисы", "Starting local services"),
    detail: uiText("Запускаем API, Qdrant и индекс заметок.", "Starting the API, Qdrant, and the notes index."),
    progress: 10,
  });
  suppressBackendOutput = false;
  const pythonPath = getPythonExecutable();
  const pythonPathEntries = [PROJECT_ROOT, BACKEND_PACKAGE_DIR];
  if (process.env.PYTHONPATH) {
    pythonPathEntries.push(process.env.PYTHONPATH);
  }

  // Who: Tim Buglaev
  // When: 2026-06-22
  // What: Isolate the Windows backend from terminal Ctrl+C so Electron can first call
  //       authenticated service cleanup; the hidden child remains owned and taskkill-safe.
  backendProcess = spawn(pythonPath, ["-u", "-m", BACKEND_RUNTIME_MODULE], {
    cwd: PORTABLE_RUNTIME?.root || PROJECT_ROOT,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONPATH: pythonPathEntries.join(path.delimiter),
      TEST_GUI_SHUTDOWN_TOKEN: BACKEND_SHUTDOWN_TOKEN,
      TEST_GUI_INSTANCE_ID: BACKEND_INSTANCE_ID,
      NODA_BACKEND_PORT: String(BACKEND_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform === "win32",
    windowsHide: true,
  });
  const spawnedBackendProcess = backendProcess;
  managedBackendPid = Number.isInteger(backendProcess.pid) && backendProcess.pid > 0
    ? backendProcess.pid
    : null;

  backendProcess.stdout.on("data", (data) => {
    if (suppressBackendOutput) {
      return;
    }
    console.log(`[backend stdout] ${data.toString().trimEnd()}`);
  });

  backendProcess.stderr.on("data", (data) => {
    if (suppressBackendOutput) {
      return;
    }
    console.error(`[backend stderr] ${data.toString().trimEnd()}`);
  });

  backendProcess.on("error", (error) => {
    if (backendProcess !== spawnedBackendProcess) return;
    console.error("[backend process error]", error);
    backendProcess = null;
    managedBackendPid = null;
    backendReadyPromise = null;
    backendHttpReadyConfirmed = false;
    // Who: Tim Buglaev
    // When: 2026-06-15
    // What: Drop the full readiness cache on unexpected backend process errors so
    //       later UI/hotkey actions do not reuse a stale resolved startup promise.
    appReadyPromise = null;
  });

  backendProcess.on("exit", (code, signal) => {
    if (backendProcess !== spawnedBackendProcess) return;
    if (!suppressBackendOutput) {
      console.log(`[backend exit] code=${code} signal=${signal}`);
    }
    backendProcess = null;
    managedBackendPid = null;
    backendReadyPromise = null;
    backendHttpReadyConfirmed = false;
    // Who: Tim Buglaev
    // When: 2026-06-15
    // What: Drop the full readiness cache when Flask exits so the next request
    //       performs a fresh backend/Qdrant/model readiness sequence.
    appReadyPromise = null;
  });
}

async function waitForBackendReady() {
  for (let attempt = 1; attempt <= BACKEND_READY_ATTEMPTS; attempt += 1) {
    if (attempt === 1 || attempt % 12 === 0) {
      broadcastStartupStatus({
        state: "loading",
        phase: "backend",
        message: uiText("Ждём запуск сервера", "Waiting for the server"),
        detail: uiText("Инициализируем Flask, Qdrant и индекс заметок…", "Initializing Flask, Qdrant, and the notes index…"),
        progress: Math.min(38, 12 + Math.round((attempt / BACKEND_READY_ATTEMPTS) * 24)),
      });
    }
    try {
      const response = await fetchWithTimeout(`${BACKEND_URL}/ping`, {}, BACKEND_PING_TIMEOUT_MS);
      const payload = await readJsonResponse(response);
      if (response.ok && payload.instance_id === BACKEND_INSTANCE_ID) {
        await projects().verifyBackend();
        await projects().activateInitial();
        broadcastStartupStatus({
          state: "loading",
          phase: "qdrant",
          message: uiText("Сервер готов", "Server ready"),
          detail: uiText("Сервисы готовы. Читаем настройки модели.", "Local services are ready. Reading model settings."),
          progress: 42,
        });
        return;
      }
    } catch (_) {
      // Backend is still starting up.
    }
    if (!backendProcess) {
      throw new Error("Backend process exited before it became ready.");
    }
    await delay(BACKEND_READY_DELAY_MS);
  }
  broadcastStartupStatus({
    state: "error",
    phase: "backend",
    message: uiText("Сервер не запустился", "Server did not start"),
    detail: uiText("Flask API не ответил за отведённое время.", "The local API did not respond in time."),
    progress: 100,
  });
  throw new Error("Backend did not become ready in time.");
}

async function ensureBackendHttpReady(options = {}) {
  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Revalidate a previously resolved backend before startup model actions;
  //       a refused or foreign endpoint resets only the readiness cache, not ownership.
  if (options.forceProbe === true && backendHttpReadyConfirmed) {
    try {
      const response = await fetchWithTimeout(`${BACKEND_URL}/ping`, {}, BACKEND_PING_TIMEOUT_MS);
      const payload = await readJsonResponse(response);
      if (!response.ok || payload.instance_id !== BACKEND_INSTANCE_ID) {
        backendReadyPromise = null;
        backendHttpReadyConfirmed = false;
      }
    } catch (_) {
      backendReadyPromise = null;
      backendHttpReadyConfirmed = false;
    }
  }
  if (!backendReadyPromise) {
    backendReadyPromise = (async () => {
      if (!backendProcess) {
        let port;
        try {
          port = await reserveLoopbackPort(Number(new URL(BACKEND_URL).port));
        } catch (error) {
          if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
          throw Object.assign(new Error("Local API port unavailable"), { code: "backend_port_busy" });
        }
        await port.release();
      }
      startBackendProcess();
      await waitForBackendReady();
      backendHttpReadyConfirmed = true;
      return { ok: true };
    })();
  }

  try {
    return await backendReadyPromise;
  } catch (error) {
    backendReadyPromise = null;
    throw error;
  }
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Added managed local vLLM lifecycle helpers so Electron starts the configured
//       loopback runtime, keeps TurboQuant command args synchronized, and stops WSL/direct
//       child processes on app shutdown without exposing shell access to the renderer.
function readJsonResponse(response) {
  return response.json().catch(() => ({}));
}

// Who: Tim Buglaev
// When: 2026-06-24
// What: Allow read-only settings refreshes to fetch runtime state silently while
//       preserving startup progress broadcasts for actual initialization flows.
async function fetchRuntimeConfig(options = {}) {
  if (options.announceStartup !== false) {
    broadcastStartupStatus({
      state: "loading",
      phase: "runtime-config",
      message: uiText("Читаем настройки модели", "Reading model settings"),
      detail: uiText("Проверяем среду выполнения, TurboQuant и параметры vLLM.", "Checking the runtime, TurboQuant, and vLLM settings."),
      progress: 48,
    });
  }
  const response = await fetchWithTimeout(`${BACKEND_URL}/runtime/config`);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.error || `Runtime config request failed: HTTP ${response.status}`);
  }
  // Who: Tim Buglaev
  // When: 2026-06-22
  // What: Retain the backend-owned Qdrant PID for abnormal-exit cleanup while rejecting
  //       missing, negative, or non-integer process identifiers from the HTTP response.
  const qdrantPid = Number.parseInt(payload?.managed_processes?.qdrant_pid, 10);
  managedQdrantPid = Number.isInteger(qdrantPid) && qdrantPid > 0 ? qdrantPid : null;
  return payload;
}

async function postRuntimeConfig(payload) {
  const response = await fetchWithTimeout(`${BACKEND_URL}/runtime/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, reload_model: false }),
  });
  const responsePayload = await readJsonResponse(response);
  if (!response.ok || responsePayload.success === false) {
    throw new Error(responsePayload.error || `Runtime config update failed: HTTP ${response.status}`);
  }
  return responsePayload;
}

function postNotePairSelection(selection) {
  return saveNotePairs(selection, {
    backendUrl: BACKEND_URL, fetchWithTimeout, readJsonResponse,
    invalid: () => uiText("Некорректный выбор связок.", "Invalid model pair selection."),
    failed: () => uiText("Не удалось сохранить связки. Повторите попытку.", "Could not save model pairs. Try again."),
  });
}

// Who: Tim Buglaev
// When: 2026-06-15
// What: Added backend model-catalog calls for startup selection, keeping the
//       renderer away from direct backend process and Hugging Face download control.
async function fetchModelCatalog() {
  const response = await fetchWithTimeout(`${BACKEND_URL}/models/catalog`, {}, MODEL_CATALOG_TIMEOUT_MS);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.error || `Model catalog request failed: HTTP ${response.status}`);
  }
  return payload;
}

async function postModelDownload(modelId) {
  const response = await fetchWithTimeout(`${BACKEND_URL}/models/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: modelId }),
  }, MODEL_DOWNLOAD_TIMEOUT_MS);
  const payload = await readJsonResponse(response);
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Model download failed: HTTP ${response.status}`);
  }
  return payload;
}

// Who: Tim Buglaev
// When: 2026-06-15
// What: Added a bounded GGUF model-swap call for startup selection so downloaded
//       llama.cpp profiles are applied through the backend instead of being sent to vLLM.
async function postModelSwap(ggufPath) {
  assertProfileMutable(OWNED_NOTE_PROFILE);
  const response = await fetchWithTimeout(`${BACKEND_URL}/model/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gguf_path: ggufPath }),
  }, MODEL_SWAP_TIMEOUT_MS);
  const payload = await readJsonResponse(response);
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Model swap failed: HTTP ${response.status}`);
  }
  return payload;
}

// Who: Tim Buglaev
// When: 2026-06-23
// What: Respect the validated persisted startup preference while retaining automated
//       test bypass and support for both local GGUF and managed vLLM providers.
function shouldPromptForStartupModel(runtimePayload) {
  return !usesRuNotePipeline(runtimePayload)
    && !desktopSettings.skipModelSelection
    && AUTO_QUIT_AFTER_READY_MS <= 0
    && ["local", "vllm_local"].includes(runtimePayload?.provider);
}

function findStartupCatalogModel(models, requestedModelId) {
  const normalized = String(requestedModelId || "").trim();
  if (!normalized) {
    return null;
  }
  return (models || []).find((model) => (
    normalized === model.id
    || normalized === model.hf_model_id
    || normalized === model.gguf_filename
    || normalized === model.local_path
    || normalized === `${model.hf_model_id}:${model.quantization}`
  )) || null;
}

function isGgufCatalogModel(model) {
  return model?.artifact === "gguf" || model?.model_format === "llama_cpp" || Boolean(model?.gguf_filename);
}

// Who: Tim Buglaev
// When: 2026-06-15
// What: Normalize local GGUF paths before comparing startup selections, avoiding
//       redundant /model/swap calls when the selected model is already active.
function normalizePathForCompare(value) {
  const raw = String(value || "").trim();
  return raw ? path.normalize(raw).toLowerCase() : "";
}

function isSelectedGgufAlreadyActive(model, runtimePayload) {
  if (!isGgufCatalogModel(model) || runtimePayload?.provider !== "local") {
    return false;
  }
  const selectedPath = normalizePathForCompare(model?.local_path);
  const activePath = normalizePathForCompare(runtimePayload?.runtime_model_id);
  return Boolean(selectedPath && activePath && selectedPath === activePath);
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Detect RAM, Electron GPU data, and verified NVIDIA compute capability under
//       independent deadlines; missing diagnostics remain explicit and fail closed.
async function getHardwareProfile() {
  let timeoutId = null;
  let gpuInfo = null;
  try {
    const [electronGpuInfo, nvidiaProfile] = await Promise.all([
      Promise.race([
        app.getGPUInfo("complete"),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(null), GPU_INFO_TIMEOUT_MS);
        }),
      ]),
      detectNvidiaGpu(),
    ]);
    gpuInfo = electronGpuInfo;
    return buildHardwareProfile(os.totalmem(), gpuInfo, nvidiaProfile);
  } catch (error) {
    console.warn(`[hardware profile] GPU information unavailable: ${error?.message || "unknown error"}`);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
  return buildHardwareProfile(os.totalmem(), gpuInfo);
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Resolve TurboQuant support from the active allowlisted model and bounded
//       hardware profile so renderers receive a display result, never authority.
function resolveActiveCatalogModel(models, runtime) {
  const modelId = runtime?.provider === "vllm_local"
    ? runtime.vllm?.source_model_id || runtime.runtime_model_id
    : runtime?.runtime_model_id;
  return modelId ? findStartupCatalogModel(models, modelId) : models.find((model) => model.active) || null;
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Build one capability context shared by startup and settings so both
//       surfaces use the same active-model and hardware decision.
function buildTurboQuantContext(runtime, models, hardware) {
  const activeModel = resolveActiveCatalogModel(models, runtime);
  return {
    activeModel,
    capability: evaluateTurboQuantCapability({ runtime, model: activeModel, hardware }),
  };
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Return settings data from trusted backend/runtime sources with a server-side
//       TurboQuant compatibility verdict and validated user preferences.
async function getDesktopSettingsPayload() {
  await ensureBackendHttpReady();
  const [runtime, catalog, hardware] = await Promise.all([
    fetchRuntimeConfig({ announceStartup: false }),
    fetchModelCatalog(),
    getHardwareProfile(),
  ]);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const { activeModel, capability } = buildTurboQuantContext(runtime, models, hardware);
  return {
    ok: true,
    settings: { ...desktopSettings },
    runtime,
    models,
    activeModelId: activeModel?.id || "",
    hardware,
    turboquantCapability: capability,
  };
}

// Who: Tim Buglaev
// When: 2026-06-23
// What: Apply only allowlisted catalog models through existing download/config/swap paths;
//       concurrent changes are rejected and managed runtime ownership stays in main process.
async function applySettingsModelSelection(payload, sender) {
  if (settingsRuntimeUpdateInProgress) {
    throw new Error(uiText("Смена модели уже выполняется.", "A model switch is already in progress."));
  }
  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Isolate runtime-switch progress from startup renderers for the full
  //       operation and always release the guard through the existing finally block.
  settingsRuntimeUpdateInProgress = true;
  startupBroadcastSuppressionDepth += 1;
  sendSettingsModelProgress({
    state: "loading",
    message: uiText("Переключаем модель", "Switching models"),
    detail: uiText("Проверяем каталог и подготавливаем среду выполнения.", "Checking the catalog and preparing the runtime."),
    progress: 10,
  });
  try {
    await ensureBackendHttpReady();
    let catalog = await fetchModelCatalog();
    let models = Array.isArray(catalog.models) ? catalog.models : [];
    let selectedModel = findStartupCatalogModel(models, payload?.model_id || payload?.modelId);
    if (!selectedModel) {
      throw new Error(uiText("Выбранной модели нет в каталоге.", "The selected model is no longer in the catalog."));
    }
    const needsDownload = !selectedModel.downloaded;
    if (needsDownload) {
      sendSettingsModelProgress({
        state: "loading",
        message: uiText("Подготавливаем модель", "Preparing the model"),
        detail: uiText(`${selectedModel.name || selectedModel.id} скачивается в локальный кэш.`,
          `Downloading ${selectedModel.name || selectedModel.id} to the local cache.`),
        progress: 28,
      });
      if (PORTABLE_RUNTIME && selectedModel.id === "qwen35_4b_portable") {
        await runModelDownload(sender, signal => downloadPortableChatPreset({ id: selectedModel.id }, {
          backendUrl: BACKEND_URL, fetchWithTimeout, signal,
          onProgress(progress) {
            if (!progress) return;
            sendSettingsModelProgress({
              message: uiText("Скачиваем модель", "Downloading model"),
              detail: uiText("Веса сохраняются на этом компьютере.", "Saving model weights on this computer."),
              download: { bytes: progress.bytes, total: progress.total },
            });
          },
        }));
        catalog = await fetchModelCatalog();
        models = catalog.models;
        selectedModel = findStartupCatalogModel(models, selectedModel.id);
        if (!selectedModel?.downloaded) throw new NoteModelDownloadError("integrity");
      } else {
        const downloadResult = await postModelDownload(selectedModel.id);
        models = Array.isArray(downloadResult.models) ? downloadResult.models : models;
        selectedModel = {
          ...selectedModel,
          ...(downloadResult.model || {}),
          ...(findStartupCatalogModel(models, selectedModel.id) || {}),
        };
      }
    }

    let runtime = await fetchRuntimeConfig();
    sendSettingsModelProgress({
      state: "loading",
      message: uiText("Переключаем модель", "Switching models"),
      detail: uiText(`Запускаем ${selectedModel.name || selectedModel.id} и ждём готовности.`,
        `Starting ${selectedModel.name || selectedModel.id}.`),
      progress: 62,
    });
    if (isGgufCatalogModel(selectedModel)) {
      if (!selectedModel.local_path) {
        throw new Error(uiText("Локальный файл выбранной GGUF-модели отсутствует.", "The selected GGUF model file is missing."));
      }
      if (needsDownload || selectedModel.ready === false || !isSelectedGgufAlreadyActive(selectedModel, runtime)) {
        if (!PORTABLE_RUNTIME && !selectedModel.imported) await updateRuntimeConfig({ provider: "local" });
        const swapResult = await postModelSwap(selectedModel.local_path);
        runtime = swapResult.runtime || await fetchRuntimeConfig();
        if (selectedModel.imported) await restartManagedRuntime(runtime);
      }
    } else {
      const alreadyActive = runtime?.provider === "vllm_local"
        && runtime?.vllm?.source_model_id === selectedModel.hf_model_id;
      if (!alreadyActive) {
        const result = await updateRuntimeConfig({
          provider: "vllm_local",
          vllm_model_id: selectedModel.served_model_name || "local-model",
          vllm_source_model_id: selectedModel.hf_model_id,
          vllm_max_model_len: selectedModel.max_model_len,
          vllm_gpu_memory_utilization: selectedModel.gpu_memory_utilization,
          vllm_enforce_eager: selectedModel.enforce_eager,
        });
        runtime = result.runtime || await fetchRuntimeConfig();
      }
    }
    appReadyPromise = Promise.resolve({ ok: true, runtime });
    catalog = await fetchModelCatalog();
    // Who: Tim Buglaev
    // When: 2026-06-24
    // What: Complete the settings-only waiting state after runtime readiness without
    //       reopening or mutating the application startup screen.
    sendSettingsModelProgress({
      state: "ready",
      message: uiText("Модель подключена", "Model ready"),
      detail: uiText(`${selectedModel.name || selectedModel.id} готова к работе.`, `${selectedModel.name || selectedModel.id} is ready.`),
      progress: 100,
    });
    return {
      ok: true,
      runtime,
      models: Array.isArray(catalog.models) ? catalog.models : models,
      activeModelId: selectedModel.id,
    };
  } catch (error) {
    if (error instanceof NoteModelDownloadError && error.code === "canceled") {
      return { ok: false, canceled: true };
    }
    // Who: Tim Buglaev
    // When: 2026-06-24
    // What: Report a settings-local failure and keep the startup lifecycle untouched,
    //       allowing the user to close the wait screen and choose another model.
    sendSettingsModelProgress({
      state: "error",
      message: uiText("Смена модели не завершена", "Could not switch models"),
      detail: uiText("Повторите выбор или вернитесь к предыдущей конфигурации.", "Try again or return to the previous configuration."),
      progress: 100,
    });
    if (error instanceof NoteModelDownloadError) return { ok: false, downloadError: error.code };
    throw error;
  } finally {
    startupBroadcastSuppressionDepth = Math.max(0, startupBroadcastSuppressionDepth - 1);
    settingsRuntimeUpdateInProgress = false;
  }
}

async function applyStartupModelSelection(payload) {
  if (!startupModelSelection) {
    throw new Error("Model selection is not active.");
  }
  if (startupModelSelection.working) {
    throw new Error("Model selection is already being applied.");
  }

  let selectedModel = findStartupCatalogModel(startupModelSelection.models, payload?.model_id || payload?.modelId);
  if (!selectedModel) {
    throw new Error("Selected model is not available in the startup catalog.");
  }

  startupModelSelection.working = true;
  try {
    // Who: Tim Buglaev
    // When: 2026-06-24
    // What: Keep the selected model queued while a cold or restarted owned backend
    //       finishes initialization instead of failing immediately with ECONNREFUSED.
    broadcastStartupStatus({
      state: "loading",
      phase: "backend",
      message: uiText("Проверяем сервер", "Checking local services"),
      detail: uiText("Ждём готовности API и индекса заметок.", "Waiting for the API and the notes index."),
      progress: 46,
      models: startupModelSelection.models,
      selectedModelId: selectedModel.id,
    });
    await ensureBackendHttpReady({ forceProbe: true });
    const [verifiedCatalog, verifiedRuntime] = await Promise.all([
      fetchModelCatalog(),
      fetchRuntimeConfig(),
    ]);
    if (Array.isArray(verifiedCatalog.models)) {
      startupModelSelection.models = verifiedCatalog.models;
    }
    selectedModel = findStartupCatalogModel(startupModelSelection.models, selectedModel.id);
    if (!selectedModel) {
      throw new Error("Selected model is no longer available in the startup catalog.");
    }
    startupModelSelection.runtimePayload = verifiedRuntime;
    if (!selectedModel.downloaded) {
      broadcastStartupStatus({
        state: "loading",
        phase: "model-download",
        message: uiText("Скачиваем модель", "Downloading the model"),
        detail: uiText(`${selectedModel.name} скачивается из Hugging Face в локальный кэш.`,
          `Downloading ${selectedModel.name} from Hugging Face to the local cache.`),
        progress: 54,
        models: startupModelSelection.models,
        selectedModelId: selectedModel.id,
      });
      const downloadPayload = await postModelDownload(selectedModel.id);
      if (Array.isArray(downloadPayload.models)) {
        startupModelSelection.models = downloadPayload.models;
      }
      selectedModel = {
        ...selectedModel,
        ...(downloadPayload.model || {}),
        ...(findStartupCatalogModel(startupModelSelection.models, selectedModel.id) || {}),
      };
    }

    broadcastStartupStatus({
      state: "loading",
      phase: "runtime-config",
      message: uiText("Применяем выбранную модель", "Applying the selected model"),
      detail: uiText(`Подготавливаем локальный запуск ${selectedModel.name}.`, `Preparing to run ${selectedModel.name} locally.`),
      progress: 57,
      models: startupModelSelection.models,
      selectedModelId: selectedModel.id,
    });

    const currentRuntime = startupModelSelection.runtimePayload || {};
    if (isGgufCatalogModel(selectedModel)) {
      const localPath = selectedModel.local_path;
      if (!localPath) {
        throw new Error("Selected GGUF model does not expose a local_path.");
      }
      if (isSelectedGgufAlreadyActive(selectedModel, currentRuntime)) {
        broadcastStartupStatus({
          state: "loading",
          phase: "vllm",
          message: uiText("Модель уже выбрана", "Model already selected"),
          detail: uiText(`Проверяем готовность ${selectedModel.name}.`, `Checking that ${selectedModel.name} is ready.`),
          progress: 72,
          models: startupModelSelection.models,
          selectedModelId: selectedModel.id,
        });
        startupModelSelection.resolve(currentRuntime);
        startupModelSelection = null;
        return { ok: true, runtime: currentRuntime, model: selectedModel, skippedSwap: true };
      }
      if (!selectedModel.imported) await postRuntimeConfig({ provider: "local" });
      broadcastStartupStatus({
        state: "loading",
        phase: "vllm",
        message: uiText("Загружаем GGUF-модель", "Loading the GGUF model"),
        detail: uiText(`${selectedModel.name} загружается из ${localPath}.`, `Loading ${selectedModel.name} from ${localPath}.`),
        progress: 72,
        models: startupModelSelection.models,
        selectedModelId: selectedModel.id,
      });
      const swapResult = await postModelSwap(localPath);
      const runtimePayload = swapResult.runtime || await fetchRuntimeConfig();
      startupModelSelection.resolve(runtimePayload);
      startupModelSelection = null;
      return { ok: true, runtime: runtimePayload, model: selectedModel, swap: swapResult };
    }

    // Who: Tim Buglaev
    // When: 2026-06-21
    // What: Use a stable served-model alias for vLLM selections instead of carrying
    //       an unrelated previous GGUF file path into the OpenAI model contract.
    const runtimeResult = await postRuntimeConfig({
      provider: "vllm_local",
      vllm_model_id: selectedModel.served_model_name || "local-model",
      vllm_source_model_id: selectedModel.hf_model_id,
      vllm_max_model_len: selectedModel.max_model_len,
      vllm_gpu_memory_utilization: selectedModel.gpu_memory_utilization,
      vllm_enforce_eager: selectedModel.enforce_eager,
    });
    const runtimePayload = runtimeResult.runtime || await fetchRuntimeConfig();
    startupModelSelection.resolve(runtimePayload);
    startupModelSelection = null;
    return { ok: true, runtime: runtimePayload, model: selectedModel };
  } catch (error) {
    startupModelSelection.working = false;
    broadcastStartupStatus({
      state: "model-select",
      phase: "model-select",
      message: uiText("Модель не подготовлена", "Could not prepare the model"),
      detail: uiText(error?.message || "Не удалось скачать или применить выбранную модель.",
        "Could not download or apply the selected model. Choose a model and try again."),
      progress: 52,
      models: startupModelSelection.models,
      selectedModelId: selectedModel.id,
    });
    throw error;
  }
}

async function waitForStartupModelSelection(runtimePayload) {
  if (usesRuNotePipeline(runtimePayload)) {
    if (AUTO_QUIT_AFTER_READY_MS > 0) return runtimePayload;
    return await startupNoteSelection.wait(runtimePayload, desktopSettings);
  }
  if (!shouldPromptForStartupModel(runtimePayload)) {
    return runtimePayload;
  }
  if (startupModelSelectionPromise) {
    return startupModelSelectionPromise;
  }

  startupModelSelectionPromise = (async () => {
    const catalogPayload = await fetchModelCatalog();
    const models = Array.isArray(catalogPayload.models) ? catalogPayload.models : [];
    if (!models.length) {
      return runtimePayload;
    }
    const activeModel = models.find((model) => model.active) || models.find((model) => model.recommended) || models[0];
    broadcastStartupStatus({
      state: "model-select",
      phase: "model-select",
      message: uiText("Выберите локальную модель", "Choose a local model"),
      detail: uiText("Приложение скачает недостающие файлы перед запуском модели.", "Noda will download any missing files before starting the model."),
      progress: 52,
      models,
      notePipeline: null,
      selectedModelId: activeModel?.id,
    });
    // Who: Tim Buglaev
    // When: 2026-06-15
    // What: Route launch-time model selection to the startup window instead of
    //       opening the quick-note capture UI before the app is ready.
    showStartupWindow();
    return await new Promise((resolve, reject) => {
      startupModelSelection = {
        resolve,
        reject,
        runtimePayload,
        models,
        working: false,
      };
    });
  })();

  try {
    return await startupModelSelectionPromise;
  } finally {
    startupModelSelectionPromise = null;
  }
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Ask about TurboQuant only for a verified compatible vLLM model, validate
//       exact booleans in main, persist the skip choice atomically, and roll back
//       runtime configuration if preference persistence fails.
async function applyStartupTurboQuantSelection(payload) {
  const selection = startupTurboQuantSelection;
  if (!selection) {
    throw new Error(uiText("Выбор TurboQuant сейчас недоступен.", "The TurboQuant prompt is no longer active."));
  }
  if (selection.working) {
    throw new Error(uiText("Настройка TurboQuant уже применяется.", "The TurboQuant setting is being applied."));
  }
  if (typeof payload?.enabled !== "boolean" || typeof payload?.skipFuturePrompt !== "boolean") {
    throw new Error(uiText("Некорректный выбор TurboQuant.", "Invalid TurboQuant selection."));
  }
  const capability = evaluateTurboQuantCapability({
    runtime: selection.runtimePayload,
    model: selection.activeModel,
    hardware: selection.hardware,
  });
  if (payload.enabled && !capability.supported) {
    throw new Error(uiText(capability.reason || "TurboQuant не поддерживается этим компьютером.", "TurboQuant is unavailable for this configuration."));
  }

  selection.working = true;
  const previousEnabled = Boolean(selection.runtimePayload?.turboquant?.enabled);
  let runtimePayload = selection.runtimePayload;
  try {
    if (payload.enabled !== previousEnabled) {
      const runtimeResult = await postRuntimeConfig({ turboquant_enabled: payload.enabled });
      runtimePayload = runtimeResult.runtime || await fetchRuntimeConfig({ announceStartup: false });
    }
    const nextSettings = {
      ...desktopSettings,
      skipTurboQuantSelection: payload.skipFuturePrompt,
    };
    desktopSettings = saveDesktopSettings(
      DESKTOP_SETTINGS_PATH,
      nextSettings,
      DESKTOP_SETTINGS_DEFAULTS
    );
    console.info(
      `[turboquant startup] applied enabled=${payload.enabled} skip_prompt=${payload.skipFuturePrompt}`
    );
    broadcastStartupStatus({
      state: "loading",
      phase: "runtime-config",
      message: payload.enabled ? uiText("TurboQuant включён", "TurboQuant enabled") : uiText("TurboQuant выключен", "TurboQuant disabled"),
      detail: uiText("Продолжаем запуск выбранной модели.", "Continuing to start the selected model."),
      progress: 62,
    });
    selection.resolve(runtimePayload);
    startupTurboQuantSelection = null;
    return { ok: true, runtime: runtimePayload, settings: { ...desktopSettings } };
  } catch (error) {
    if (payload.enabled !== previousEnabled) {
      try {
        await postRuntimeConfig({ turboquant_enabled: previousEnabled });
      } catch (rollbackError) {
        console.error(`[turboquant startup rollback] ${rollbackError?.message || "unknown error"}`);
      }
    }
    selection.working = false;
    broadcastStartupStatus({
      state: "turboquant-select",
      phase: "turboquant-select",
      message: uiText("Не удалось применить TurboQuant", "Could not apply TurboQuant"),
      detail: uiText(error?.message || "Повторите выбор.", "Try choosing a TurboQuant option again."),
      progress: 60,
      turboquantCapability: capability,
      turboquantEnabled: previousEnabled,
    });
    throw error;
  }
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Skip the launch question for non-vLLM, unsupported, automated, or saved
//       skip states; otherwise pause startup until the trusted renderer decides.
async function waitForStartupTurboQuantSelection(runtimePayload) {
  if (usesRuNotePipeline(runtimePayload)
    || runtimePayload?.provider !== "vllm_local"
    || desktopSettings.skipTurboQuantSelection
    || AUTO_QUIT_AFTER_READY_MS > 0) {
    return runtimePayload;
  }
  if (startupTurboQuantSelectionPromise) {
    return startupTurboQuantSelectionPromise;
  }

  startupTurboQuantSelectionPromise = (async () => {
    const [catalogPayload, hardware] = await Promise.all([
      fetchModelCatalog(),
      getHardwareProfile(),
    ]);
    const models = Array.isArray(catalogPayload.models) ? catalogPayload.models : [];
    const { activeModel, capability } = buildTurboQuantContext(runtimePayload, models, hardware);
    if (!capability.supported) {
      console.info(`[turboquant startup] prompt skipped capability=${capability.code}`);
      return runtimePayload;
    }
    broadcastStartupStatus({
      state: "turboquant-select",
      phase: "turboquant-select",
      message: uiText("Использовать TurboQuant?", "Use TurboQuant?"),
      detail: uiText("Он сжимает кэш диалога модели, экономит видеопамять и помогает работать с более длинным контекстом.", "It compresses the chat cache and saves GPU memory for longer conversations."),
      progress: 60,
      turboquantCapability: capability,
      turboquantEnabled: Boolean(runtimePayload?.turboquant?.enabled),
    });
    showStartupWindow();
    return await new Promise((resolve, reject) => {
      startupTurboQuantSelection = {
        resolve,
        reject,
        runtimePayload,
        activeModel,
        hardware,
        working: false,
      };
    });
  })();

  try {
    return await startupTurboQuantSelectionPromise;
  } finally {
    startupTurboQuantSelectionPromise = null;
  }
}

// Who: Tim Buglaev
// When: 2026-06-23
// What: Open a native directory picker owned by the requesting app window; cancelled
//       selection keeps the current validated vault and never returns arbitrary files.
async function chooseNotesDirectory(ownerWindow) {
  const options = {
    title: uiText("Выберите папку с заметками", "Choose your notes folder"),
    buttonLabel: uiText("Выбрать папку", "Select Folder"),
    defaultPath: desktopSettings.notesDirectory,
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
  };
  const result = ownerWindow && !ownerWindow.isDestroyed()
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths?.length) {
    return null;
  }
  return normalizeNotesDirectory(result.filePaths[0]);
}

// Who: Tim Buglaev
// When: 2026-06-30
// What: Present an in-window vault step before backend startup; the native dialog is
//       opened only on user action and the promise resolves only after confirmation.
async function waitForStartupNotesDirectory() {
  let directoryExists = false;
  try {
    normalizeNotesDirectory(desktopSettings.notesDirectory);
    directoryExists = true;
  } catch {
    // An unavailable vault requires an explicit replacement before the backend starts.
  }
  const directoryAvailable = directoryExists && projects().currentDirectoryAvailable(desktopSettings.notesDirectory);
  if (directoryAvailable && (desktopSettings.skipNotesDirectorySelection || AUTO_QUIT_AFTER_READY_MS > 0)) {
    return desktopSettings.notesDirectory;
  }
  if (startupNotesDirectorySelectionPromise) {
    return startupNotesDirectorySelectionPromise;
  }
  startupNotesDirectorySelectionPromise = new Promise((resolve, reject) => {
    startupNotesDirectorySelection = {
      resolve,
      reject,
      selectedDirectory: PORTABLE_RUNTIME && directoryAvailable ? desktopSettings.notesDirectory : "",
      working: false,
    };
    broadcastStartupStatus({
      state: "notes-directory-select",
      phase: "notes-directory-select",
      message: uiText("Выберите папку с заметками", "Choose your notes folder"),
      detail: directoryAvailable
        ? uiText("Она будет использоваться для индексации, поиска и сохранения новых заметок.", "Noda uses this folder to index, find, and save notes.")
        : uiText("Сохранённая папка недоступна. Выберите другую папку проекта, чтобы продолжить.", "The saved folder is unavailable. Choose another project folder to continue."),
      progress: 3,
    });
    showStartupWindow();
  });
  try {
    return await startupNotesDirectorySelectionPromise;
  } finally {
    startupNotesDirectorySelectionPromise = null;
  }
}

async function waitForStartupSurfaceReady() {
  if (!startupRendererReady) {
    await Promise.race([
      startupRendererReadyPromise,
      delay(STARTUP_SURFACE_READY_TIMEOUT_MS),
    ]);
  }
  if (!desktopSettings.skipNotesDirectorySelection) {
    await delay(250);
  }
}

// Who: Tim Buglaev
// When: 2026-06-30
// What: Accept startup vault choices only from the trusted native dialog, serialize
//       dialog/confirmation actions, and persist atomically before backend spawn.
async function chooseStartupNotesDirectory() {
  const selection = startupNotesDirectorySelection;
  if (!selection) {
    return { ok: false, code: "selection_inactive", error: uiText("Выбор папки сейчас недоступен.", "The folder prompt is no longer active.") };
  }
  if (selection.working) {
    return { ok: false, code: "selection_busy", error: uiText("Дождитесь завершения текущего действия.", "Wait for the current action to finish.") };
  }
  selection.working = true;
  try {
    const notesDirectory = await chooseNotesDirectory(startupWindow);
    if (!notesDirectory) {
      return { ok: true, canceled: true, notesDirectory: "" };
    }
    selection.selectedDirectory = notesDirectory;
    return { ok: true, canceled: false, notesDirectory };
  } finally {
    if (startupNotesDirectorySelection === selection) {
      selection.working = false;
    }
  }
}

function confirmStartupNotesDirectory() {
  const selection = startupNotesDirectorySelection;
  if (!selection) {
    return { ok: false, code: "selection_inactive", error: uiText("Выбор папки сейчас недоступен.", "The folder prompt is no longer active.") };
  }
  if (selection.working) {
    return { ok: false, code: "selection_busy", error: uiText("Дождитесь завершения текущего действия.", "Wait for the current action to finish.") };
  }
  if (!selection.selectedDirectory) {
    return { ok: false, code: "directory_required", error: uiText("Сначала выберите папку с заметками.", "Choose a notes folder first.") };
  }
  selection.working = true;
  try {
    desktopSettings = saveDesktopSettings(
      DESKTOP_SETTINGS_PATH,
      { ...desktopSettings, notesDirectory: selection.selectedDirectory },
      DESKTOP_SETTINGS_DEFAULTS
    );
    process.env.NOTES_DIR = desktopSettings.notesDirectory;
    broadcastStartupStatus({
      state: "loading",
      phase: "backend",
      message: uiText("Папка выбрана", "Folder selected"),
      detail: uiText("Запускаем backend и индексируем выбранные заметки.", "Starting local services and indexing your notes."),
      progress: 6,
    });
    startupNotesDirectorySelection = null;
    selection.resolve(desktopSettings.notesDirectory);
    return { ok: true, notesDirectory: desktopSettings.notesDirectory };
  } catch (error) {
    selection.working = false;
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sanitizeWslPidFile(value) {
  const rawValue = String(value || ".test_gui_vllm_runtime.pid").trim();
  if (!rawValue || !/^[A-Za-z0-9._/-]+$/.test(rawValue)) {
    return ".test_gui_vllm_runtime.pid";
  }
  return rawValue;
}

function buildWslPidFileAssignment() {
  const pidFile = sanitizeWslPidFile(process.env.RAG_VLLM_WSL_PID_FILE);
  if (pidFile.startsWith("/")) {
    return `PID_FILE=${shellQuote(pidFile)}`;
  }
  return `PID_FILE="$HOME/${pidFile}"`;
}

// Who: Tim Buglaev
// When: 2026-06-14
// What: Export WSL-only vLLM environment fixes and the shared Hugging Face cache
//       inside the bash launcher so CUDA settings are deterministic and startup does
//       not duplicate multi-gigabyte model downloads across Windows and WSL.
function buildWslRuntimeEnvExports() {
  const wslHfHome = resolveWslHfHome();
  const envValues = {
    VLLM_USE_FLASHINFER_SAMPLER: process.env.VLLM_USE_FLASHINFER_SAMPLER || "0",
    CUDA_HOME: process.env.CUDA_HOME || "/usr/local/cuda",
  };
  if (wslHfHome) {
    envValues.HF_HOME = wslHfHome;
    envValues.HUGGINGFACE_HUB_CACHE = `${wslHfHome}/hub`;
  }
  return [
    ...Object.entries(envValues).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    'export PATH="$CUDA_HOME/bin:/usr/local/bin:$PATH"',
  ];
}

function buildWslArgs(script) {
  const args = [];
  const distro = String(process.env.RAG_VLLM_WSL_DISTRO || "").trim();
  if (distro) {
    args.push("-d", distro);
  }
  args.push("--exec", "bash", "-lc", script);
  return args;
}

function runtimeBaseUrl(runtimePayload) {
  return String(runtimePayload?.vllm?.base_url || "").trim().replace(/\/+$/, "");
}

function runtimeModelsUrl(runtimePayload) {
  const baseUrl = runtimeBaseUrl(runtimePayload);
  return baseUrl ? `${baseUrl}/models` : null;
}

function validateServeCommand(runtimePayload) {
  const serveCommand = runtimePayload?.vllm?.serve_command;
  if (!Array.isArray(serveCommand) || !serveCommand.length) {
    throw new Error("vLLM serve command is not available.");
  }
  const command = serveCommand.map((part) => String(part || "").trim()).filter(Boolean);
  if (!command.length || command[0] !== "vllm") {
    throw new Error("Unsupported vLLM serve command.");
  }
  return command;
}

function buildManagedRuntimeKey(runtimePayload, serveCommand, mode) {
  return JSON.stringify({
    mode,
    provider: runtimePayload?.provider,
    baseUrl: runtimeBaseUrl(runtimePayload),
    serveCommand,
  });
}

function resolveManagedRuntimeMode() {
  const configured = String(process.env.RAG_VLLM_START_MODE || "").trim().toLowerCase();
  if (["wsl", "direct", "external", "off"].includes(configured)) {
    return configured;
  }
  // Who: Tim Buglaev
  // When: 2026-06-14
  // What: Keep Windows on managed WSL by default because vLLM is a Linux runtime; missing
  //       distros must fail visibly so setup can be repaired instead of silently downgrading.
  return process.platform === "win32" ? "wsl" : "direct";
}

function buildWslRuntimeScript(serveCommand) {
  const commandLine = serveCommand.map(shellQuote).join(" ");
  return [
    "set -e",
    buildWslPidFileAssignment(),
    ...buildWslRuntimeEnvExports(),
    'mkdir -p "$(dirname "$PID_FILE")"',
    "cleanup_pid() {",
    '  target="$1"',
    '  case "$target" in ""|*[!0-9]*) return 0 ;; esac',
    '  if kill -0 "$target" 2>/dev/null; then',
    '    kill -TERM "-$target" 2>/dev/null || kill -TERM "$target" 2>/dev/null || true',
    "    i=0",
    '    while kill -0 "$target" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done',
    '    kill -KILL "-$target" 2>/dev/null || kill -KILL "$target" 2>/dev/null || true',
    "  fi",
    "}",
    'if [ -s "$PID_FILE" ]; then cleanup_pid "$(cat "$PID_FILE" 2>/dev/null || true)"; fi',
    "export TEST_GUI_MANAGED_RUNTIME=1",
    `if command -v setsid >/dev/null 2>&1; then setsid ${commandLine} & else ${commandLine} & fi`,
    "child=$!",
    'echo "$child" > "$PID_FILE"',
    'trap \'cleanup_pid "$child"; rm -f "$PID_FILE"; exit 0\' INT TERM EXIT',
    "status=0",
    'wait "$child" || status=$?',
    "trap - INT TERM EXIT",
    'rm -f "$PID_FILE"',
    'exit "$status"',
  ].join("\n");
}

function buildWslRuntimeStopScript() {
  return [
    "set +e",
    buildWslPidFileAssignment(),
    "cleanup_pid() {",
    '  target="$1"',
    '  case "$target" in ""|*[!0-9]*) return 0 ;; esac',
    '  if kill -0 "$target" 2>/dev/null; then',
    '    kill -TERM "-$target" 2>/dev/null || kill -TERM "$target" 2>/dev/null || true',
    "    i=0",
    '    while kill -0 "$target" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done',
    '    kill -KILL "-$target" 2>/dev/null || kill -KILL "$target" 2>/dev/null || true',
    "  fi",
    "}",
    'if [ -s "$PID_FILE" ]; then cleanup_pid "$(cat "$PID_FILE" 2>/dev/null || true)"; fi',
    'rm -f "$PID_FILE"',
    "exit 0",
  ].join("\n");
}

// Who: Tim Buglaev
// When: 2026-06-30
// What: Hide bounded maintenance subprocesses on Windows so WSL, taskkill, and Docker
//       cleanup never create user-visible console windows while retaining captured logs.
function runProcess(file, args, timeoutMs, label, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
    });
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    // Who: Tim Buglaev
    // When: 2026-06-14
    // What: Buffer cleanup command output and print it only on failure so localized
    //       taskkill/wsl success messages cannot appear as mojibake in normal logs;
    //       allow callers to suppress expected races when a process already exited.
    const logBufferedOutput = (isFailure) => {
      if (!isFailure || options.suppressFailureOutput) {
        return;
      }
      if (stdoutBuffer.trim()) {
        console.log(`[${label} stdout] ${stdoutBuffer.trimEnd()}`);
      }
      if (stderrBuffer.trim()) {
        console.error(`[${label} stderr] ${stderrBuffer.trimEnd()}`);
      }
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill();
      } catch (_) {
        // Process may have already exited.
      }
      console.warn(`[${label}] timeout after ${timeoutMs}ms`);
      logBufferedOutput(true);
      resolve({ ok: false, code: null, signal: "timeout" });
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      console.error(`[${label} error]`, error);
      logBufferedOutput(true);
      resolve({ ok: false, error });
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      logBufferedOutput(code !== 0);
      resolve({ ok: code === 0, code, signal });
    });
  });
}

async function terminateProcessTree(childProcess, label) {
  if (
    !childProcess ||
    childProcess.killed ||
    childProcess.exitCode !== null ||
    childProcess.signalCode !== null
  ) {
    return;
  }
  const pid = childProcess.pid;
  if (process.platform === "win32" && pid) {
    const result = await runProcess(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      PROCESS_STOP_TIMEOUT_MS,
      `${label} taskkill`,
      { suppressFailureOutput: true }
    );
    if (!result.ok && (result.error || result.signal === "timeout")) {
      console.warn(
        `[${label}] process tree already stopped or taskkill failed (code=${result.code ?? "unknown"} signal=${result.signal ?? "none"})`
      );
    }
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve();
    };
    timer = setTimeout(() => {
      try {
        if (childProcess._killProcessGroup && childProcess.pid) {
          process.kill(-childProcess.pid, "SIGKILL");
        } else {
          childProcess.kill("SIGKILL");
        }
      } catch (_) {
        // Process may have already exited.
      }
      finish();
    }, PROCESS_STOP_TIMEOUT_MS);
    childProcess.once("exit", finish);
    try {
      if (childProcess._killProcessGroup && childProcess.pid) {
        process.kill(-childProcess.pid, "SIGTERM");
      } else {
        childProcess.kill("SIGTERM");
      }
    } catch (_) {
      finish();
    }
  });
}

async function startManagedRuntimeProcess(runtimePayload) {
  if (!MANAGED_VLLM_AUTOSTART || runtimePayload?.provider !== "vllm_local") {
    broadcastStartupStatus({
      state: "loading",
      phase: "runtime",
      message: uiText("Внешний runtime не требуется", "No external runtime needed"),
      detail: uiText("Модель будет использовать текущий локальный provider.", "The model will use the current local runtime."),
      progress: 78,
    });
    return;
  }

  const mode = resolveManagedRuntimeMode();
  if (mode === "external" || mode === "off") {
    console.log(`[runtime] Managed vLLM autostart skipped: mode=${mode}`);
    broadcastStartupStatus({
      state: "loading",
      phase: "runtime",
      message: uiText("Автозапуск vLLM отключен", "vLLM auto-start is disabled"),
      detail: uiText("Ожидаем уже запущенный внешний vLLM endpoint.", "Waiting for the external vLLM server."),
      progress: 64,
    });
    return;
  }

  const serveCommand = validateServeCommand(runtimePayload);
  const nextRuntimeKey = buildManagedRuntimeKey(runtimePayload, serveCommand, mode);
  if (managedRuntimeProcess && !managedRuntimeProcess.killed && managedRuntimeKey === nextRuntimeKey) {
    broadcastStartupStatus({
      state: "loading",
      phase: "vllm",
      message: uiText("vLLM уже запущен", "vLLM is already running"),
      detail: uiText("Проверяем готовность OpenAI-compatible endpoint.", "Checking API readiness."),
      progress: 72,
    });
    return;
  }

  await stopManagedRuntimeProcess({ terminateWsl: false, cleanupStaleWsl: mode === "wsl" });
  suppressManagedRuntimeOutput = false;
  managedRuntimeFailure = null;

  let executable = serveCommand[0];
  let args = serveCommand.slice(1);
  // Who: Tim Buglaev
  // When: 2026-06-30
  // What: Keep managed direct and WSL runtimes windowless on Windows; stdout/stderr
  //       remain piped to Electron for startup diagnostics and failure reporting.
  const spawnOptions = {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TEST_GUI_MANAGED_RUNTIME: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: mode === "direct" && process.platform !== "win32",
    windowsHide: process.platform === "win32",
  };

  if (mode === "wsl") {
    if (process.platform !== "win32") {
      throw new Error("WSL managed runtime mode is only supported on Windows.");
    }
    broadcastStartupStatus({
      state: "loading",
      phase: "wsl",
      message: uiText("Запускаем WSL runtime", "Starting WSL"),
      detail: uiText("Готовим Ubuntu, CUDA окружение и процесс vLLM.", "Preparing Ubuntu, CUDA, and vLLM."),
      progress: 58,
    });
    executable = "wsl.exe";
    args = buildWslArgs(buildWslRuntimeScript(serveCommand));
    spawnOptions.detached = false;
  } else {
    broadcastStartupStatus({
      state: "loading",
      phase: "runtime",
      message: uiText("Запускаем локальный vLLM runtime", "Starting local vLLM"),
      detail: uiText("Поднимаем OpenAI-compatible endpoint для генерации.", "Starting the local generation API."),
      progress: 58,
    });
  }

  const runtimeProcess = spawn(executable, args, spawnOptions);
  managedRuntimeProcess = runtimeProcess;
  runtimeProcess._killProcessGroup = Boolean(spawnOptions.detached);
  managedRuntimeKey = nextRuntimeKey;
  managedRuntimeMode = mode;

  broadcastStartupStatus({
    state: "loading",
    phase: "vllm",
    message: uiText("Загружаем vLLM", "Loading vLLM"),
    detail: uiText("Модель и TurboQuant KV-cache инициализируются, это может занять около минуты.", "Preparing the model and TurboQuant cache may take about a minute."),
    progress: 64,
  });

  runtimeProcess.stdout.on("data", (data) => {
    if (suppressManagedRuntimeOutput) {
      return;
    }
    console.log(`[runtime stdout] ${data.toString().trimEnd()}`);
  });

  runtimeProcess.stderr.on("data", (data) => {
    if (suppressManagedRuntimeOutput) {
      return;
    }
    console.error(`[runtime stderr] ${data.toString().trimEnd()}`);
  });

  // Who: Tim Buglaev
  // When: 2026-06-21
  // What: Associate exit state with the exact spawned child so delayed events from
  //       an old runtime cannot clear or fail a newly restarted process.
  runtimeProcess.on("error", (error) => {
    console.error("[runtime process error]", error);
    if (managedRuntimeProcess !== runtimeProcess) {
      return;
    }
    managedRuntimeFailure = {
      code: null,
      signal: null,
      reason: String(error?.message || "process spawn failed"),
    };
    managedRuntimeProcess = null;
    managedRuntimeKey = null;
    managedRuntimeMode = null;
  });

  runtimeProcess.on("exit", (code, signal) => {
    if (!suppressManagedRuntimeOutput) {
      console.log(`[runtime exit] code=${code} signal=${signal}`);
    }
    if (managedRuntimeProcess !== runtimeProcess) {
      return;
    }
    if (!isQuitting && !suppressManagedRuntimeOutput) {
      managedRuntimeFailure = { code, signal, reason: "runtime process stopped" };
    }
    managedRuntimeProcess = null;
    managedRuntimeKey = null;
    managedRuntimeMode = null;
  });
}

// Who: Tim Buglaev
// When: 2026-06-21
// What: Resolve a deadline-based readiness policy while retaining compatibility
//       with the legacy attempts setting when operators explicitly configured it.
function resolveManagedRuntimeReadyTimeoutMs(delayMs) {
  if (String(process.env.RAG_VLLM_READY_TIMEOUT_MS || "").trim()) {
    return parsePositiveIntEnv("RAG_VLLM_READY_TIMEOUT_MS", MANAGED_RUNTIME_READY_TIMEOUT_MS);
  }
  if (String(process.env.RAG_VLLM_READY_ATTEMPTS || "").trim()) {
    return parsePositiveIntEnv("RAG_VLLM_READY_ATTEMPTS", 1) * delayMs;
  }
  return MANAGED_RUNTIME_READY_TIMEOUT_MS;
}

async function waitForManagedRuntimeReady(runtimePayload) {
  if (runtimePayload?.provider !== "vllm_local") {
    return;
  }
  const modelsUrl = runtimeModelsUrl(runtimePayload);
  if (!modelsUrl) {
    throw new Error("vLLM models endpoint is not configured.");
  }

  const delayMs = parsePositiveIntEnv("RAG_VLLM_READY_DELAY_MS", MANAGED_RUNTIME_READY_DELAY_MS);
  const timeoutMs = resolveManagedRuntimeReadyTimeoutMs(delayMs);
  const probeTimeoutMs = parsePositiveIntEnv("RAG_VLLM_PROBE_TIMEOUT_MS", MANAGED_RUNTIME_PROBE_TIMEOUT_MS);
  const progressIntervalMs = parsePositiveIntEnv(
    "RAG_VLLM_PROGRESS_INTERVAL_MS",
    MANAGED_RUNTIME_PROGRESS_INTERVAL_MS
  );

  try {
    const result = await waitForRuntimeEndpoint({
      modelsUrl,
      fetchWithTimeout,
      delay,
      timeoutMs,
      delayMs,
      probeTimeoutMs,
      progressIntervalMs,
      isQuitting: () => isQuitting,
      getProcessFailure: () => managedRuntimeFailure,
      onProgress: ({ elapsedMs }) => {
        const progressRatio = Math.min(1, elapsedMs / timeoutMs);
        console.log(`[runtime readiness] waiting elapsed=${Math.round(elapsedMs / 1000)}s timeout=${Math.round(timeoutMs / 1000)}s`);
        // Who: Tim Buglaev
        // When: 2026-06-21
        // What: Show elapsed cold-start time without pretending download/load progress
        //       is exact; the bar remains bounded below completion until /v1/models responds.
        broadcastStartupStatus({
          state: "loading",
          phase: "vllm",
          message: uiText("Ждем готовность vLLM", "Waiting for vLLM"),
          detail: uiText(`Загружаем веса модели и TurboQuant. Прошло: ${formatDuration(elapsedMs)}.`,
            `Loading the model and TurboQuant. Elapsed time: ${formatDuration(elapsedMs, "en")}.`),
          progress: Math.min(96, 66 + Math.round(progressRatio * 30)),
        });
      },
    });

    broadcastStartupStatus({
      state: "loading",
      phase: "vllm",
      message: uiText("vLLM готов", "vLLM ready"),
      detail: uiText(`Модель ответила на /v1/models за ${formatDuration(result.elapsedMs)}.`,
        `The model responded in ${formatDuration(result.elapsedMs, "en")}.`),
      progress: 98,
    });
  } catch (error) {
    const failureDetail = error?.code === "MANAGED_RUNTIME_EXITED"
      ? "Процесс vLLM завершился во время загрузки. Причина выведена в runtime stderr."
      : error?.message || "OpenAI-compatible endpoint не ответил за отведенное время.";
    broadcastStartupStatus({
      state: "error",
      phase: "vllm",
      message: uiText("vLLM не запустился", "vLLM did not start"),
      detail: uiText(failureDetail, "The local model server did not become ready. Try again."),
      progress: 100,
    });
    throw error;
  }
}

async function ensureManagedRuntimeReady(runtimePayload) {
  if (!managedRuntimeReadyPromise) {
    managedRuntimeReadyPromise = (async () => {
      await startManagedRuntimeProcess(runtimePayload);
      await waitForManagedRuntimeReady(runtimePayload);
      return { ok: true };
    })();
  }
  try {
    return await managedRuntimeReadyPromise;
  } catch (error) {
    // Who: Tim Buglaev
    // When: 2026-06-21
    // What: Stop the app-owned runtime after timeout or process failure so retries
    //       start from a deterministic state and no failed vLLM worker stays behind.
    await stopManagedRuntimeProcess({ terminateWsl: false });
    managedRuntimeReadyPromise = null;
    throw error;
  }
}

// Who: Tim Buglaev
// When: 2026-07-01
// What: Keep the startup progress window visible for every cold readiness sequence;
//       saved skip preferences bypass only interactive folder/model selection screens.
async function runBackendReadySequence() {
  try {
    broadcastStartupStatus({
      state: "loading",
      phase: "startup",
      message: uiText("Готовим приложение", "Preparing Noda"),
      detail: uiText("Проверяем backend, Qdrant, индекс заметок и runtime модели.", "Checking local services, the notes index, and the model."),
      progress: Math.max(2, startupStatus.progress || 0),
    });
    if (coldStartupPending) {
      showStartupWindow();
    }
    await waitForStartupSurfaceReady();
    const language = await startupLanguage.wait();
    if (process.platform === "win32") {
      const menu = Menu.getApplicationMenu();
      if (menu) {
        localizeDesktopMenu(menu, language);
        Menu.setApplicationMenu(menu);
      }
    }
    createTray();
    if (PORTABLE_RUNTIME) await ensurePortableDependencies();
    await waitForStartupNotesDirectory();
    await ensureBackendHttpReady();
    let runtimePayload = await fetchRuntimeConfig();
    runtimePayload = await waitForStartupModelSelection(runtimePayload);
    runtimePayload = await waitForStartupTurboQuantSelection(runtimePayload);
    if (shouldStartManagedAtStartup(runtimePayload)) {
      await ensureManagedRuntimeReady(runtimePayload);
    }
    createQuickWindow();
    broadcastStartupStatus({
      state: "ready",
      phase: "ready",
      ...startupReadyStatus(runtimePayload, startupLanguage.getLanguage()),
      progress: 100,
    });
    // Who: Tim Buglaev
    // When: 2026-07-02
    // What: Claim the global shortcut only after the complete readiness state has
    //       been published; failed or interrupted startup leaves it untouched.
    registerHotkey();
    coldStartupPending = false;
    return { ok: true, runtime: runtimePayload };
  } catch (error) {
    if (isQuitting) throw error;
    broadcastStartupStatus({
      state: "error",
      phase: startupStatus.phase || "startup",
      message: uiText("Приложение не готово", "Noda could not start"),
      detail: error.code === "backend_port_busy"
        ? uiText(`Порт ${new URL(BACKEND_URL).port} занят. Закройте использующее его приложение и нажмите «Повторить».`,
          `Port ${new URL(BACKEND_URL).port} is busy. Close the app using it, then select Retry.`)
        : error.code === "provision_restart_required"
          ? uiText("Перезапустите Windows, затем откройте Noda снова.", "Restart Windows, then open Noda again.")
          : error.code === "provision_failed" && error.phase === "validation"
            ? uiText("Не удалось проверить файлы установки. Распакуйте всю папку Noda заново и проверьте доступ к профилю Windows.",
              "Setup files could not be checked. Extract the entire Noda folder again and check access to your Windows profile.")
          : error.code === "provision_failed"
          ? uiText("Не удалось установить компоненты. Проверьте подключение и свободное место, затем нажмите «Повторить».",
            "Setup could not install the components. Check your connection and free space, then select Retry.")
          : uiText("Не удалось запустить локальные службы. Попробуйте перезапустить Noda.", "Local services could not start. Try restarting Noda."),
      progress: 100,
    });
    throw error;
  }
}

// Who: Tim Buglaev
// When: 2026-06-15
// What: Serialize the full desktop readiness sequence so hotkey, startup, and
//       renderer requests wait for the same backend/Qdrant/model warmup instead
//       of racing and reporting a false timeout during cold GGUF loads.
async function ensureBackendReady() {
  if (!appReadyPromise) {
    appReadyPromise = runBackendReadySequence().catch((error) => {
      appReadyPromise = null;
      throw error;
    });
  }
  return appReadyPromise;
}

async function stopManagedRuntimeProcess(options = {}) {
  const terminateWsl = options.terminateWsl !== false;
  const cleanupStaleWsl = options.cleanupStaleWsl === true;
  const processToStop = managedRuntimeProcess;
  const stopMode = managedRuntimeMode;
  suppressManagedRuntimeOutput = Boolean(processToStop || stopMode === "wsl" || cleanupStaleWsl);
  managedRuntimeProcess = null;
  managedRuntimeReadyPromise = null;
  managedRuntimeKey = null;
  managedRuntimeMode = null;
  // Who: Tim Buglaev
  // When: 2026-06-21
  // What: Clear the recorded failure only after detaching the failed child so a
  //       deliberate retry begins with clean state and cannot inherit a stale exit.
  managedRuntimeFailure = null;

  if (stopMode === "wsl" || cleanupStaleWsl) {
    await runProcess("wsl.exe", buildWslArgs(buildWslRuntimeStopScript()), PROCESS_STOP_TIMEOUT_MS, "runtime wsl cleanup");
  }
  if (processToStop) {
    await terminateProcessTree(processToStop, "runtime");
  }
  if (terminateWsl && WSL_TERMINATE_ON_EXIT && process.platform === "win32") {
    // Who: Tim Buglaev
    // When: 2026-06-21
    // What: Shut down the complete WSL VM after allowlisted project containers stop;
    //       terminating only Ubuntu left docker-desktop active and consuming resources.
    await runProcess("wsl.exe", ["--shutdown"], PROCESS_STOP_TIMEOUT_MS, "runtime wsl terminate");
  }
}

async function restartManagedRuntime(runtimePayload) {
  await stopManagedRuntimeProcess({ terminateWsl: false });
  if (runtimePayload?.provider === "vllm_local") {
    await ensureManagedRuntimeReady(runtimePayload);
  }
}

async function updateRuntimeConfig(payload) {
  assertProfileMutable(OWNED_NOTE_PROFILE);
  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Invalidate the shared app readiness promise before runtime changes so
  //       subsequent UI actions wait for the restarted local/vLLM model state.
  appReadyPromise = null;
  await ensureBackendHttpReady();
  const result = await postRuntimeConfig(payload || {});
  await restartManagedRuntime(result.runtime);
  return result;
}

async function stopBackendProcess() {
  const processToStop = backendProcess;
  const backendPid = managedBackendPid || processToStop?.pid || null;
  suppressBackendOutput = Boolean(processToStop);
  backendProcess = null;
  managedBackendPid = null;
  backendReadyPromise = null;
  backendHttpReadyConfirmed = false;
  appReadyPromise = null;
  // Who: Tim Buglaev
  // When: 2026-06-22
  // What: On Windows, stop the separately grouped backend by its trusted launch PID even
  //       if Node already marked the ChildProcess handle as killed or disconnected.
  if (process.platform === "win32" && backendPid) {
    await runProcess(
      "taskkill",
      ["/PID", String(backendPid), "/T", "/F"],
      PROCESS_STOP_TIMEOUT_MS,
      "backend taskkill",
      { suppressFailureOutput: true }
    );
    return;
  }
  if (!processToStop || processToStop.killed) {
    return;
  }
  await terminateProcessTree(processToStop, "backend");
}

// Who: Tim Buglaev
// When: 2026-06-22
// What: Ask the owned backend to stop Qdrant gracefully before Flask termination; if the
//       backend already died, remove only the previously reported managed Qdrant PID.
async function stopBackendManagedServices(context, strict = false) {
  if (!backendProcess || !backendHttpReadyConfirmed) {
    if (strict) throw new Error("Project services could not stop safely");
    return;
  }
  let gracefulShutdown = false;
  try {
    const response = await fetchWithTimeout(
      `${BACKEND_URL}/runtime/shutdown-managed`,
      {
        method: "POST",
        headers: {
          "X-Test-Gui-Shutdown-Token": BACKEND_SHUTDOWN_TOKEN,
          "X-Test-Gui-Stop-Backend": "1",
          ...(context ? { "X-Noda-Project-Id": context.project_id,
            "X-Noda-Project-Context": context.context_token } : {}),
        },
      },
      strict ? 20000 : HTTP_REQUEST_TIMEOUT_MS
    );
    gracefulShutdown = response.ok;
    if (strict && !gracefulShutdown) throw new Error("Project services could not stop safely");
  } catch (error) {
    if (strict) throw error;
    gracefulShutdown = false;
  }

  if (!gracefulShutdown && process.platform === "win32" && managedQdrantPid) {
    await runProcess(
      "taskkill",
      ["/PID", String(managedQdrantPid), "/T", "/F"],
      PROCESS_STOP_TIMEOUT_MS,
      "managed qdrant fallback",
      { suppressFailureOutput: true }
    );
  }
  managedQdrantPid = null;
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Validate all renderer settings, recheck TurboQuant support in main, serialize
//       runtime changes, and roll back runtime changes if atomic preference
//       persistence fails; disabling remains possible on unsupported hardware.
async function rollbackDesktopSettingsChanges({
  runtimeChanged,
  previousRuntime,
}) {
  if (runtimeChanged && previousRuntime) {
    try {
      await updateRuntimeConfig({
        turboquant_enabled: Boolean(previousRuntime?.turboquant?.enabled),
      });
    } catch (error) {
      console.error(`[settings turboquant rollback] ${error?.message || "unknown error"}`);
    }
  }
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Apply validated TurboQuant, vault, and theme preferences as one serialized
//       operation; broadcast visual changes only after atomic persistence succeeds.
async function saveDesktopSettingsFromRenderer(payload) {
  assertProfileMutable(OWNED_NOTE_PROFILE);
  if (settingsRuntimeUpdateInProgress) {
    throw new Error(uiText("Изменение runtime уже выполняется.", "Settings are already being applied."));
  }
  if (typeof payload?.turboquantEnabled !== "boolean") {
    throw new Error(uiText("Некорректное значение TurboQuant.", "Invalid TurboQuant setting."));
  }
  if (payload.language === null) {
    throw new Error(uiText("Некорректный язык интерфейса.", "Invalid interface language."));
  }
  const validated = validateDesktopSettings(payload, desktopSettings);
  const previous = { ...desktopSettings };
  const pathChanged = path.normalize(validated.notesDirectory) !== path.normalize(previous.notesDirectory);
  if (pathChanged) {
    throw new Error(uiText("Папки теперь выбираются в разделе «Проекты». Выберите проект там.",
      "Folders are now selected in Projects. Choose the project there."));
  }
  const themeChanged = validated.theme !== previous.theme;
  settingsRuntimeUpdateInProgress = true;
  startupBroadcastSuppressionDepth += 1;
  let runtimeChanged = false;
  let previousRuntime = null;
  let runtime = null;
  let models = [];
  let hardware = null;
  let shortcutChange = null;
  try {
    shortcutChange = desktopHotkey.prepare(validated.quickNoteHotkey);
    await ensureBackendHttpReady();
    const [runtimePayload, catalogPayload, hardwarePayload] = await Promise.all([
      fetchRuntimeConfig({ announceStartup: false }),
      fetchModelCatalog(),
      getHardwareProfile(),
    ]);
    previousRuntime = runtimePayload;
    runtime = runtimePayload;
    models = Array.isArray(catalogPayload.models) ? catalogPayload.models : [];
    hardware = hardwarePayload;
    const { capability } = buildTurboQuantContext(runtime, models, hardware);
    if (payload.turboquantEnabled && !capability.supported) {
      throw new Error(uiText(capability.reason || "TurboQuant не поддерживается этим компьютером.", "TurboQuant is unavailable for this configuration."));
    }

    runtimeChanged = payload.turboquantEnabled !== Boolean(runtime?.turboquant?.enabled);
    if (runtimeChanged) {
      console.info(`[settings turboquant] applying enabled=${payload.turboquantEnabled}`);
      const runtimeResult = await updateRuntimeConfig({
        turboquant_enabled: payload.turboquantEnabled,
      });
      runtime = runtimeResult.runtime || await fetchRuntimeConfig({ announceStartup: false });
    }
    const { capability: updatedCapability } = buildTurboQuantContext(runtime, models, hardware);
    desktopSettings = saveDesktopSettings(
      DESKTOP_SETTINGS_PATH,
      validated,
      DESKTOP_SETTINGS_DEFAULTS
    );
    process.env.NOTES_DIR = desktopSettings.notesDirectory;
    shortcutChange.commit();
    broadcastPreferences([quickWindow, notesWindow, startupWindow], normalizePreferences(desktopSettings));
    if (themeChanged) {
      broadcastTheme(desktopSettings.theme);
      console.info(`[settings theme] applied theme=${desktopSettings.theme}`);
    }
    return {
      ok: true,
      settings: { ...desktopSettings },
      runtime,
      turboquantCapability: updatedCapability,
    };
  } catch (error) {
    shortcutChange?.rollback();
    await rollbackDesktopSettingsChanges({
      runtimeChanged,
      previousRuntime,
    });
    throw error;
  } finally {
    startupBroadcastSuppressionDepth = Math.max(0, startupBroadcastSuppressionDepth - 1);
    settingsRuntimeUpdateInProgress = false;
  }
}

async function shutdownManagedProcesses() {
  portableSetupController?.abort();
  for (const controller of activeModelDownloads.values()) controller.abort();
  // Who: Tim Buglaev
  // When: 2026-06-22
  // What: Stop every owned dependency independently so one failed cleanup cannot skip
  //       Qdrant/backend teardown; finish with an explicit configured WSL shutdown.
  const shutdownSteps = [
    ["quick capture draft", () => quickCapture.flushDraftStorage()],
    ["managed runtime", () => stopManagedRuntimeProcess()],
    ["backend services", () => stopBackendManagedServices()],
    ["backend", () => stopBackendProcess()],
  ];
  for (const [label, action] of shutdownSteps) {
    try {
      await action();
    } catch (error) {
      console.error(`[shutdown ${label} error]`, error);
    }
  }
  if (WSL_TERMINATE_ON_EXIT && process.platform === "win32") {
    await runProcess("wsl.exe", ["--shutdown"], PROCESS_STOP_TIMEOUT_MS, "final wsl terminate");
  }
}

function requestAppQuit() {
  isQuitting = true;
  app.quit();
}

// Who: Tim Buglaev
// When: 2026-06-21
// What: Monitor the validated dev-launcher PID from Electron's separate Windows
//       process group; if npm/PTY dies before IPC delivery, trigger the same
//       before-quit cleanup instead of leaving WSL and Qdrant running.
const launcherPid = Number.parseInt(process.env.TEST_GUI_LAUNCHER_PID || "", 10);
let launcherWatchTimer = null;
if (Number.isInteger(launcherPid) && launcherPid > 0 && launcherPid !== process.pid) {
  launcherWatchTimer = setInterval(() => {
    try {
      process.kill(launcherPid, 0);
    } catch (_) {
      clearInterval(launcherWatchTimer);
      launcherWatchTimer = null;
      requestAppQuit();
    }
  }, 1000);
  launcherWatchTimer.unref?.();
}

// Who: Tim Buglaev
// When: 2026-06-21
// What: Accept only the dedicated launcher shutdown message (or direct process
//       signals) and route it through Electron before-quit cleanup; renderer IPC
//       cannot access this channel or bypass the existing window checks.
process.on("message", (message) => {
  if (message?.type === "test-gui-shutdown") {
    requestAppQuit();
  }
});
process.on("SIGINT", requestAppQuit);
process.on("SIGTERM", requestAppQuit);

// Who: Tim Buglaev
// When: 2026-07-02
// What: Use a transparent launcher without visible window chrome; interactive
//       selection phases still expand programmatically because transparent windows
//       are not reliably user-resizable on Windows.
function createStartupWindow() {
  if (startupWindow && !startupWindow.isDestroyed()) {
    return startupWindow;
  }

  startupWindow = new BrowserWindow({
    width: STARTUP_COMPACT_WINDOW.width,
    height: STARTUP_COMPACT_WINDOW.height,
    minWidth: STARTUP_COMPACT_WINDOW.minWidth,
    minHeight: STARTUP_COMPACT_WINDOW.minHeight,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    thickFrame: false,
    movable: true,
    resizable: false,
    maximizable: false,
    title: uiText("Запуск Noda", "Noda startup"),
    // Who: Tim Buglaev
    // When: 2026-07-02
    // What: Apply the native Noda icon and hardened themed renderer preferences
    //       before the transparent startup card becomes visible.
    icon: APP_ICON_PATH,
    webPreferences: createSecureWindowPreferences(),
  });

  protectRenderer(startupWindow, path.join(__dirname, "startup.html"), { openExternal: url => shell.openExternal(url) });
  startupWindow.loadFile(path.join(__dirname, "startup.html"));
  startupWindow.webContents.on("did-finish-load", () => {
    sendStartupStatusToWindow(startupWindow);
  });

  startupWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    requestStartupCloseConfirmation();
  });

  startupWindow.on("closed", () => {
    startupWindow = null;
    startupWindowMode = "compact";
  });

  return startupWindow;
}

function showStartupWindow() {
  const win = createStartupWindow();
  applyStartupWindowSizeForStatus(startupStatus);
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

function hideStartupWindow() {
  if (!startupWindow || startupWindow.isDestroyed()) {
    return;
  }
  startupWindow.hide();
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Complete automatic startup by hiding the launcher and opening the notes
//       panel only after readiness; the transition remains atomic and main-owned.
function completeStartupAndOpenNotesPanel() {
  hideStartupWindow();
  showNotesWindow();
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Expand interactive launcher phases programmatically, then restore the fixed
//       360x400 rounded card for loading, ready, and recoverable error states.
function applyStartupWindowSizeForStatus(status) {
  if (!startupWindow || startupWindow.isDestroyed()) {
    return;
  }
  const nextMode = status?.phase === "model-select"
    ? "model-select"
    : status?.phase === "notes-directory-select"
      ? "notes-directory-select"
      : status?.phase === "turboquant-select" ? "turboquant-select" : "compact";
  if (startupWindowMode === nextMode) {
    return;
  }
  const target = nextMode === "model-select"
    ? STARTUP_MODEL_SELECT_WINDOW
    : nextMode === "notes-directory-select"
      ? STARTUP_NOTES_DIRECTORY_WINDOW
      : nextMode === "turboquant-select" ? STARTUP_TURBOQUANT_WINDOW : STARTUP_COMPACT_WINDOW;
  const workArea = screen.getPrimaryDisplay()?.workAreaSize || target;
  const width = Math.min(target.width, Math.max(target.minWidth, workArea.width));
  const height = Math.min(target.height, Math.max(target.minHeight, workArea.height));
  startupWindowMode = nextMode;
  startupWindow.setMinimumSize(target.minWidth, target.minHeight);
  startupWindow.setSize(width, height);
  startupWindow.center();
}

// Who: Tim Buglaev
// When: 2026-06-15
// What: Route startup-window close attempts through the renderer confirmation UI
//       during initialization, while ready windows can be acknowledged and hidden.
function requestStartupCloseConfirmation() {
  if (!startupWindow || startupWindow.isDestroyed()) {
    return;
  }
  if (startupStatus.state === "ready") {
    startupWindow.hide();
    return;
  }
  startupWindow.show();
  startupWindow.focus();
  startupWindow.webContents.send("quick-note:startup-close-request");
}

function minimizeStartupWindow() {
  if (!startupWindow || startupWindow.isDestroyed()) {
    return;
  }
  startupWindow.minimize();
}

// Who: Tim Buglaev
// When: 2026-06-15
// What: Restrict startup window-control IPC to the dedicated startup renderer so
//       other windows cannot stop launch or manipulate startup state directly.
function isStartupWindowSender(event) {
  return isTrustedRenderer(event, startupWindow);
}

function denyInvalidStartupSender(action) {
  console.warn(`[startup ipc denied] action=${action}`);
  return { ok: false, error: "forbidden" };
}

// Who: Tim Buglaev
// When: 2026-06-23
// What: Restrict settings filesystem/model IPC to the dedicated notes window so quick
//       capture and startup renderers cannot mutate vault or runtime preferences.
function isNotesWindowSender(event) {
  return isTrustedRenderer(event, notesWindow);
}

function denyInvalidNotesSender(action) {
  console.warn(`[notes settings ipc denied] action=${action}`);
  return { ok: false, error: "forbidden" };
}

function createQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    return quickWindow;
  }

  // Who: Tim Buglaev
  // When: 2026-06-16
  // What: Converted quick capture to a frameless, always-on-top popup with fixed
  //       compact dimensions so the hotkey UI matches the requested bottom overlay.
  quickWindow = new BrowserWindow({
    width: QUICK_CAPTURE_WINDOW.width,
    height: QUICK_CAPTURE_WINDOW.height,
    minWidth: QUICK_CAPTURE_WINDOW.minWidth,
    minHeight: QUICK_CAPTURE_WINDOW.minHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    movable: true,
    resizable: false,
    title: uiText("Noda — быстрая заметка", "Noda — Quick note"),
    // Who: Tim Buglaev
    // When: 2026-07-02
    // What: Apply the native Noda icon and hardened preferences so quick capture
    //       receives the current allowlisted theme before its first paint.
    icon: APP_ICON_PATH,
    webPreferences: createSecureWindowPreferences(),
  });

  protectRenderer(quickWindow, path.join(__dirname, "index.html"), { openExternal: url => shell.openExternal(url) });
  quickWindow.loadFile(path.join(__dirname, "index.html"));
  // Who: Tim Buglaev
  // When: 2026-06-14
  // What: Send the latest startup state after the quick window loads so the
  //       loading screen is accurate even when the window opens mid-startup.
  quickWindow.webContents.on("did-finish-load", () => {
    sendStartupStatusToWindow(quickWindow);
    quickCapture.focusInput(quickWindow);
  });

  quickWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    if (!CLOSE_TO_TRAY) {
      event.preventDefault();
      requestAppQuit();
      return;
    }
    event.preventDefault();
    quickWindow.hide();
  });

  return quickWindow;
}

// Who: Tim Buglaev
// When: 2026-06-16
// What: Added a dedicated fullscreen-style notes-management BrowserWindow that
//       reuses the secure preload bridge, opens maximized on the active display,
//       and hides on close so the quick hotkey workflow keeps running until exit.
function createNotesWindow() {
  if (notesWindow && !notesWindow.isDestroyed()) {
    return notesWindow;
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;

  notesWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 860,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    title: "Noda",
    // Who: Tim Buglaev
    // When: 2026-07-02
    // What: Apply the native Noda icon and hardened preferences so notes/settings
    //       start with the persisted theme and no renderer process access.
    icon: APP_ICON_PATH,
    webPreferences: createSecureWindowPreferences(),
  });

  protectRenderer(notesWindow, path.join(__dirname, "notes.html"), { openExternal: url => shell.openExternal(url) });
  notesWindow.loadFile(path.join(__dirname, "notes.html"));
  // Who: Tim Buglaev
  // When: 2026-06-14
  // What: Send the latest startup state after the notes window loads so the
  //       full panel remains blocked until shared services are ready.
  notesWindow.webContents.on("did-finish-load", () => {
    sendStartupStatusToWindow(notesWindow);
  });

  notesWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    notesWindow.hide();
  });

  notesWindow.on("closed", () => {
    notesWindow = null;
  });

  return notesWindow;
}

function showQuickWindow() {
  const win = createQuickWindow();
  quickCapture.show(win);
}

function showNotesWindow() {
  const win = createNotesWindow();
  // Who: Tim Buglaev
  // When: 2026-06-16
  // What: Re-apply the active display work area before showing the notes panel
  //       so reopening after monitor changes still uses the whole screen without
  //       entering exclusive fullscreen mode or removing window controls.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  if (win.isMaximized()) {
    win.unmaximize();
  }
  win.setBounds(display.workArea, false);
  win.show();
  win.maximize();
  win.focus();
  ensureBackendReady().catch((error) => {
    console.error("[notes panel ensure error]", error);
  });
}

function toggleQuickWindow() {
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Keep every quick-window toggle path inert before readiness, including
  //       defensive protection for tray or IPC calls outside the global shortcut.
  if (startupStatus.state !== "ready") {
    return false;
  }
  if (!quickWindow || quickWindow.isDestroyed()) {
    showQuickWindow();
    return true;
  }
  if (quickWindow.isVisible()) {
    quickWindow.hide();
    return true;
  }
  showQuickWindow();
  return true;
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Register the global shortcut once and only after full startup readiness;
//       the callback still uses the guarded toggle as defense against stale state.
function registerHotkey() {
  if (hotkeyRegistered || startupStatus.state !== "ready") {
    return false;
  }
  const success = desktopHotkey.register();
  hotkeyRegistered = success;
  if (!success) {
    console.warn(`[hotkey] Failed to register: ${HOTKEY}`);
    tray?.setToolTip(uiText("Noda · Горячая клавиша занята. Используйте значок в трее.",
      "Noda · Shortcut is already in use. Use the tray icon to capture a note."));
  } else {
    console.log(`[hotkey] Registered: ${HOTKEY}`);
  }
  return success;
}

function createTray() {
  tray = ensureTray({
    tray, Tray, Menu, createTrayIcon, appName: APP_NAME, uiText,
    isReady: () => startupStatus.state === "ready",
    showStartupWindow, showQuickWindow, showNotesWindow, toggleQuickWindow,
    installSemanticSearch: PORTABLE_RUNTIME ? scheduleSemanticSearch : null,
    ensureBackendReady, requestAppQuit,
    onBackendError: (error) => console.error("[backend ensure error]", error),
  });
}

async function scheduleSemanticSearch() {
  if (!PORTABLE_RUNTIME) return { ok: false, code: "unavailable" };
  try {
    const { response } = await dialog.showMessageBox({
      type: "info", title: APP_NAME,
      message: uiText("Установить модель смыслового поиска?", "Install the semantic search model?"),
      detail: uiText("При следующем запуске Noda скачает около 1,1 ГБ. Текущая работа продолжится.",
        "Noda will download about 1.1 GB at the next launch. You can keep working now."),
      buttons: [uiText("Скачать при следующем запуске", "Download on next launch"), uiText("Отмена", "Cancel")],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 0) saveEmbeddingChoice(PORTABLE_RUNTIME, true);
    return { ok: true, canceled: response !== 0 };
  } catch {
    dialog.showErrorBox(APP_NAME, uiText("Не удалось сохранить выбор. Проверьте доступ к папке Noda.",
      "Could not save your choice. Check access to the Noda folder."));
    return { ok: false, code: "choice_save_failed" };
  }
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Exposed only a narrow IPC command for opening the notes panel so renderers cannot
//       control backend, vLLM, WSL, or process-tree lifecycle directly.
registerPreferencesBridge({ ipcMain, allowed: isNotesWindowSender,
  getPreferences: () => ({ ...desktopSettings }), app, dialog, uiText, appName: APP_NAME,
  busy: () => settingsRuntimeUpdateInProgress || activeModelDownloads.size > 0 || projects().isTransitioning(),
  flushDrafts: () => quickCapture.flushDraftStorage(), restart: requestAppQuit,
  scheduleSearch: scheduleSemanticSearch, deny: () => denyInvalidNotesSender("preferences"),
});
projects().register(ipcMain);
ipcMain.handle("quick-note:ensure-backend", async (event, context) => {
  if (!isGenerationSender(event, [quickWindow, notesWindow]) && !isStartupWindowSender(event)) return denyInvalidNotesSender("ensure-backend");
  return projects().runWithContext(context, ensureBackendReady, false);
});
ipcMain.handle("quick-note:ensure-chat-runtime", async (event, context) => projects().runWithContext(context, () => ensureChatRuntimeReady({
  allowed: isNotesWindowSender(event),
  deny: () => denyInvalidNotesSender("ensure-chat-runtime"),
  ensureBackendReady,
  fetchRuntimeConfig: () => fetchRuntimeConfig({ announceStartup: false }),
  ensureManagedRuntimeReady,
  startupProgress: {
    get: () => startupBroadcastSuppressionDepth,
    set: (value) => { startupBroadcastSuppressionDepth = value; },
  },
})));
ipcMain.handle("quick-note:ensure-generation-runtime", async (event, draft) => projects().runWithContext(draft, () => ensureGenerationRuntimeReady({
  allowed: isGenerationSender(event, [quickWindow, notesWindow]),
  deny: () => denyInvalidNotesSender("ensure-generation-runtime"),
  draft,
  ensureBackendReady,
  fetchRuntimeConfig: () => fetchRuntimeConfig({ announceStartup: false }),
  fetchWithTimeout: projects().fetchFor(draft),
  readJsonResponse,
  backendUrl: BACKEND_URL,
  ensureManagedRuntimeReady,
  startupProgress: {
    get: () => startupBroadcastSuppressionDepth,
    set: (value) => { startupBroadcastSuppressionDepth = value; },
  },
})));
// Who: Tim Buglaev
// When: 2026-06-14
// What: Expose a read-only startup snapshot for renderer loading gates without
//       giving renderers direct access to backend, WSL, or process controls.
ipcMain.handle("quick-note:get-startup-status", async event => {
  if (!isGenerationSender(event, [startupWindow, quickWindow, notesWindow])) return denyInvalidNotesSender("get-startup-status");
  return getStartupStatusPayload();
});
ipcMain.handle("quick-note:select-startup-language", (event, language) => {
  if (!isStartupWindowSender(event)) return denyInvalidStartupSender("select-startup-language");
  return startupLanguage.select(language);
});
// Who: Tim Buglaev
// When: 2026-06-30
// What: Let only the startup renderer announce its first paint and drive the
//       pre-backend native vault picker; arbitrary renderer paths are never accepted.
ipcMain.handle("quick-note:startup-renderer-ready", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("startup-renderer-ready");
  }
  startupRendererReady = true;
  startupRendererReadyResolve?.();
  startupRendererReadyResolve = null;
  return { ok: true };
});
ipcMain.handle("quick-note:choose-startup-notes-directory", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("choose-startup-notes-directory");
  }
  return await chooseStartupNotesDirectory();
});
ipcMain.handle("quick-note:confirm-startup-notes-directory", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("confirm-startup-notes-directory");
  }
  return confirmStartupNotesDirectory();
});
ipcMain.handle("quick-note:open-notes-panel", async event => {
  if (!isGenerationSender(event, [startupWindow, quickWindow, notesWindow])) return denyInvalidNotesSender("open-notes-panel");
  showNotesWindow();
  return { ok: true };
});
// Who: Tim Buglaev
// When: 2026-06-24
// What: Restrict startup model selection to the dedicated launcher renderer; model
//       identifiers remain allowlisted and all process/download control stays in main.
ipcMain.handle("quick-note:select-startup-model", async (event, payload) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("select-startup-model");
  }
  return await applyStartupModelSelection(payload);
});
ipcMain.handle("quick-note:apply-startup-note-pairs", async (event, selection) => {
  if (!isStartupWindowSender(event)) return denyInvalidStartupSender("apply-startup-note-pairs");
  try {
    return await runModelDownload(event.sender, signal => startupNoteSelection.apply(selection, { signal }));
  } catch (error) {
    if (error instanceof NoteModelDownloadError) return { ok: false, downloadError: error.code };
    throw error;
  }
});
ipcMain.handle("quick-note:cancel-model-download", (event) => {
  if (!isStartupWindowSender(event) && !isNotesWindowSender(event)) return denyInvalidNotesSender("cancel-model-download");
  activeModelDownloads.get(event.sender)?.abort();
  return { ok: true };
});
ipcMain.handle("quick-note:preview-note-model", async (event, payload) => {
  const startup = isStartupWindowSender(event);
  if (!startup && !isNotesWindowSender(event)) return denyInvalidNotesSender("preview-note-model");
  async function preview() {
    assertProfileMutable(OWNED_NOTE_PROFILE);
    try {
      return await previewNoteModel(payload, { backendUrl: BACKEND_URL, fetchWithTimeout });
    } catch (error) {
      if (error instanceof NoteModelDownloadError) return { ok: false, code: error.code };
      return { ok: false, code: "network" };
    }
  }
  return startup ? preview() : projects().runWithContext(payload, preview);
});
ipcMain.handle("quick-note:import-note-model", async (event, payload) => {
  const startup = isStartupWindowSender(event);
  if (!startup && !isNotesWindowSender(event)) return denyInvalidNotesSender("import-note-model");
  const importForWindow = async () => {
    assertProfileMutable(OWNED_NOTE_PROFILE);
    try {
      const model = await runModelDownload(event.sender, signal => importNoteModel(payload, {
        backendUrl: BACKEND_URL, fetchWithTimeout, signal,
        onProgress(progress) {
          if (progress && !event.sender.isDestroyed()) {
            event.sender.send("quick-note:note-model-import-progress", progress);
          }
        },
      }));
      return { ok: true, model };
    } catch (error) {
      if (error instanceof NoteModelDownloadError) return { ok: false, code: error.code };
      throw error;
    }
  };
  return startup ? importForWindow() : projects().runMutationWithContext(payload, importForWindow);
});
// Who: Tim Buglaev
// When: 2026-07-02
// What: Restrict the launch-time TurboQuant decision to the startup renderer;
//       main rechecks capability and accepts only exact boolean choices.
ipcMain.handle("quick-note:select-startup-turboquant", async (event, payload) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("select-startup-turboquant");
  }
  return await applyStartupTurboQuantSelection(payload);
});
ipcMain.handle("quick-note:update-runtime-config", async (event, payload) => {
  if (!isGenerationSender(event, [quickWindow, notesWindow])) return denyInvalidNotesSender("update-runtime-config");
  const { projectId, contextToken, ...runtime } = payload || {};
  return projects().runMutationWithContext({ projectId, contextToken },
    () => updateRuntimeConfig(runtime));
});
// Who: Tim Buglaev
// When: 2026-06-23
// What: Expose narrow settings operations with sender checks; directory dialogs,
//       persistence, downloads, and process restarts remain in Electron main.
ipcMain.handle("quick-note:get-app-settings", async (event) => {
  if (!isNotesWindowSender(event)) {
    return denyInvalidNotesSender("get-app-settings");
  }
  return await getDesktopSettingsPayload();
});
ipcMain.handle("quick-note:choose-notes-directory", async (event) => {
  if (!isNotesWindowSender(event)) {
    return denyInvalidNotesSender("choose-notes-directory");
  }
  const notesDirectory = await chooseNotesDirectory(notesWindow);
  return { ok: true, canceled: !notesDirectory, notesDirectory };
});
ipcMain.handle("quick-note:preview-chat-model", async (event, payload) => {
  if (!isNotesWindowSender(event)) return denyInvalidNotesSender("preview-chat-model");
  const { url } = payload || {};
  if (typeof url !== "string" || url.length > 1800) return { ok: false, code: "import_url" };
  return projects().runWithContext(payload, async () => {
    assertProfileMutable(OWNED_NOTE_PROFILE);
    await ensureBackendHttpReady();
    const response = await fetchWithTimeout(`${BACKEND_URL}/models/chat-import/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    return readJsonResponse(response);
  });
});

ipcMain.handle("quick-note:download-chat-model", async (event, payload) => {
  if (!isNotesWindowSender(event)) return denyInvalidNotesSender("download-chat-model");
  const { url, id } = payload || {};
  if (typeof url !== "string" || url.length > 1800 || typeof id !== "string" || !/^hfc_[a-f0-9]{16}$/.test(id)) {
    return { ok: false, code: "import_url" };
  }
  return projects().runMutationWithContext(payload, async () => {
    assertProfileMutable(OWNED_NOTE_PROFILE);
    await ensureBackendHttpReady();
    try {
      const imported = await runModelDownload(event.sender, signal => downloadChatModel({ url, id }, {
        backendUrl: BACKEND_URL, fetchWithTimeout, signal,
        onProgress(progress) {
          if (!event.sender.isDestroyed()) event.sender.send("quick-note:chat-model-import-progress", progress);
        },
      }));
      if (imported?.id !== id) return { ok: false, code: "configuration" };
      const catalog = await fetchModelCatalog();
      const model = findStartupCatalogModel(catalog.models, id);
      return model?.imported && model.downloaded ? { ok: true, model } : { ok: false, code: "configuration" };
    } catch (error) {
      if (error instanceof NoteModelDownloadError) return { ok: false, code: error.code };
      throw error;
    }
  });
});

ipcMain.handle("quick-note:save-app-settings", async (event, payload) => {
  if (!isNotesWindowSender(event)) {
    return denyInvalidNotesSender("save-app-settings");
  }
  const { projectId, contextToken, ...settings } = payload || {};
  return projects().runWithContext({ projectId, contextToken },
    () => saveDesktopSettingsFromRenderer(settings));
});
ipcMain.handle("quick-note:apply-settings-model", async (event, payload) => {
  if (!isNotesWindowSender(event)) {
    return denyInvalidNotesSender("apply-settings-model");
  }
  const { projectId, contextToken, ...model } = payload || {};
  return projects().runWithContext({ projectId, contextToken },
    () => applySettingsModelSelection(model, event.sender));
});
ipcMain.handle("quick-note:apply-settings-note-pairs", async (event, selection) => {
  if (!isNotesWindowSender(event)) return denyInvalidNotesSender("apply-settings-note-pairs");
  const { projectId, contextToken, ...pairs } = selection || {};
  return projects().runMutationWithContext({ projectId, contextToken }, async () => {
    assertProfileMutable(OWNED_NOTE_PROFILE);
    await ensureBackendHttpReady();
    try {
      await runModelDownload(event.sender, signal => prepareNoteModels(pairs, {
        backendUrl: BACKEND_URL, fetchWithTimeout, signal,
        onProgress(progress) {
          if (!event.sender.isDestroyed()) {
            event.sender.send("quick-note:settings-note-download-progress", progress && { ...progress, cancellable: true });
          }
        },
      }));
    } catch (error) {
      if (error instanceof NoteModelDownloadError) return { ok: false, downloadError: error.code };
      throw error;
    }
    return postNotePairSelection(pairs);
  });
});
// Who: Tim Buglaev
// When: 2026-06-15
// What: Let only the dedicated startup renderer acknowledge readiness and hide
//       its own window; process lifecycle remains owned by Electron main.
ipcMain.handle("quick-note:close-startup-window", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("close-startup-window");
  }
  hideStartupWindow();
  return { ok: true };
});

// Who: Tim Buglaev
// When: 2026-07-02
// What: Let only the dedicated startup renderer trigger automatic notes opening;
//       reject early calls so unfinished startup cannot expose the notes UI.
ipcMain.handle("quick-note:complete-startup", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("complete-startup");
  }
  if (startupStatus.state !== "ready") {
    return { ok: false, error: "not_ready" };
  }
  completeStartupAndOpenNotesPanel();
  return { ok: true };
});

// Who: Tim Buglaev
// When: 2026-06-15
// What: Expose narrow custom titlebar controls for the frameless startup window,
//       including confirmed launch cancellation through the normal app shutdown path.
ipcMain.handle("quick-note:minimize-startup-window", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("minimize-startup-window");
  }
  minimizeStartupWindow();
  return { ok: true };
});
ipcMain.handle("quick-note:stop-startup", async (event) => {
  if (!isStartupWindowSender(event)) {
    return denyInvalidStartupSender("stop-startup");
  }
  requestAppQuit();
  return { ok: true };
});
ipcMain.handle("quick-note:get-hotkey", async event => {
  if (!isGenerationSender(event, [startupWindow, quickWindow, notesWindow])) return denyInvalidNotesSender("get-hotkey");
  return desktopHotkey.get();
});
ipcMain.handle("quick-note:resize-capture", (event, height) => {
  if (!isGenerationSender(event, [quickWindow])) return denyInvalidNotesSender("resize-capture");
  return quickCapture.resize(event, height);
});
ipcMain.handle("quick-note:toggle-window", async event => {
  if (!isGenerationSender(event, [startupWindow, quickWindow, notesWindow])) return denyInvalidNotesSender("toggle-window");
  toggleQuickWindow();
  return { ok: true };
});

if (HAS_SINGLE_INSTANCE_LOCK) app.whenReady().then(() => {
  createTray();
  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Show the launch progress window immediately, while keeping quick
  //       capture hidden until tray/hotkey activation after startup.
  showStartupWindow();
  // Who: Tim Buglaev
  // When: 2026-06-14
  // What: Add an opt-in smoke-test auto-quit path that exercises the normal Electron
  //       shutdown cleanup after backend and managed WSL/vLLM runtime readiness.
  const startupReadyPromise = ensureBackendReady().catch((error) => {
    console.error("[startup ensure error]", error);
  });
  if (AUTO_QUIT_AFTER_READY_MS > 0) {
    startupReadyPromise.finally(() => {
      setTimeout(() => requestAppQuit(), AUTO_QUIT_AFTER_READY_MS);
    });
  }
});

// Who: Tim Buglaev
// When: 2026-06-24
// What: Bring the primary launcher forward when the user starts the app again;
//       the secondary process exits before spawning backend, Qdrant, or WSL children.
app.on("second-instance", () => {
  if (!app.isReady()) {
    return;
  }
  if (startupStatus.state !== "ready") {
    showStartupWindow();
  } else if (notesWindow && !notesWindow.isDestroyed() && notesWindow.isVisible()) {
    notesWindow.restore();
    notesWindow.focus();
  } else {
    showQuickWindow();
  }
});

app.on("activate", () => {
  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Reopen startup progress while services are still loading; once ready,
  //       platform activation returns to the quick-note workflow.
  if (startupStatus.state !== "ready") {
    showStartupWindow();
    return;
  }
  showQuickWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (shutdownComplete) {
    return;
  }
  event.preventDefault();
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  shutdownManagedProcesses()
    .catch((error) => {
      console.error("[shutdown cleanup error]", error);
    })
    .finally(() => {
      shutdownComplete = true;
      // Who: Tim Buglaev
      // When: 2026-06-22
      // What: Force Electron termination only after managed cleanup completes so tray,
      //       renderer, and GPU subprocesses cannot survive and retain hotkeys or caches.
      app.exit(0);
    });
});

app.on("will-quit", () => {
  if (launcherWatchTimer) {
    clearInterval(launcherWatchTimer);
    launcherWatchTimer = null;
  }
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault();
});
