"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { validateDesktopSettings, saveDesktopSettings } = require("../../frontend/desktop_settings");
const { createHotkeyController } = require("../../frontend/desktop_hotkey");
const { normalizePreferences } = require("../../frontend/desktop_preferences");
const { broadcastPreferences } = require("../../frontend/desktop_preferences_bridge");
const source = fs.readFileSync(path.join(__dirname, "../../frontend/main.js"), "utf8");
const body = source.slice(source.indexOf("async function saveDesktopSettingsFromRenderer("), source.indexOf("async function shutdownManagedProcesses("));
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noda-preferences-runtime-")), vault = path.join(root, "notes"); fs.mkdirSync(vault);
  try {
    const entries = new Map(), messages = [], calls = [], settingsPath = path.join(root, "desktop-settings.json");
    const defaults = { notesDirectory: vault, skipModelSelection: false, skipNotesDirectorySelection: false,
      skipTurboQuantSelection: false, theme: "classic-blue", language: "ru", quickNoteHotkey: "Control+Shift+Space" };
    const initial = saveDesktopSettings(settingsPath, defaults, defaults);
    const hotkey = createHotkeyController({ initial: initial.quickNoteHotkey, toggle() {},
      shortcuts: { register: (key, fn) => { if (entries.has(key)) return false; entries.set(key, fn); return true; }, unregister: key => entries.delete(key) } });
    hotkey.register();
    const context = vm.createContext({ path, assertProfileMutable() {}, OWNED_NOTE_PROFILE: null, settingsRuntimeUpdateInProgress: false,
      uiText: (ru) => ru, validateDesktopSettings, normalizePreferences, broadcastPreferences, desktopSettings: initial, startupBroadcastSuppressionDepth: 0,
      DESKTOP_SETTINGS_DEFAULTS: defaults, DESKTOP_SETTINGS_PATH: settingsPath, desktopHotkey: hotkey,
      ensureBackendHttpReady: async () => calls.push("backend"), fetchRuntimeConfig: async () => ({ turboquant: { enabled: false } }),
      fetchModelCatalog: async () => ({ models: [] }), getHardwareProfile: async () => ({}),
      buildTurboQuantContext: () => ({ capability: { supported: true } }),
      updateRuntimeConfig: async value => { calls.push(value); return { runtime: { turboquant: { enabled: value.turboquant_enabled } } }; },
      saveDesktopSettings: (...args) => saveDesktopSettings(...args), process: { env: {} }, broadcastTheme: value => calls.push(value),
      quickWindow: null, startupWindow: null, notesWindow: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
      rollbackDesktopSettingsChanges: async value => calls.push({ rollback: value }), console: { info() {}, error() {} },
    });
    vm.runInContext(body, context);
    await run({ context, entries, messages, calls, hotkey, settingsPath,
      save: changes => context.saveDesktopSettingsFromRenderer({ ...initial, turboquantEnabled: false, ...changes }) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test("the actual settings IPC path commits the shortcut and broadcasts only persisted preferences", () => fixture(async f => {
  const result = await f.save({ quickNoteHotkey: "Control+Alt+N", editorFontSize: 20, editorAutoSave: false });
  assert.equal(result.settings.editorFontSize, 20); assert.equal(f.hotkey.get(), "Control+Alt+N");
  assert.equal(f.entries.has("Control+Shift+Space"), false);
  assert.equal(JSON.parse(fs.readFileSync(f.settingsPath)).editorAutoSave, false);
  assert.equal(f.messages[0][0], "quick-note:preferences-changed"); assert.equal(f.messages[0][1].editorFontSize, 20);
  assert.equal(f.context.settingsRuntimeUpdateInProgress, false);
}));
test("a busy shortcut cannot save preferences or drop the working shortcut", () => fixture(async f => {
  f.entries.set("Control+Alt+N", () => {}); const before = fs.readFileSync(f.settingsPath);
  await assert.rejects(f.save({ quickNoteHotkey: "Control+Alt+N" }), { code: "hotkey_unavailable" });
  assert.equal(f.hotkey.get(), "Control+Shift+Space"); assert.deepEqual(fs.readFileSync(f.settingsPath), before);
  assert.equal(f.messages.length, 0); assert.equal(f.calls.includes("backend"), false);
}));
test("persistence failure releases the reserved shortcut and requests runtime rollback", () => fixture(async f => {
  f.context.saveDesktopSettings = () => { throw new Error("synthetic disk unavailable"); };
  await assert.rejects(f.save({ quickNoteHotkey: "Control+Alt+N", turboquantEnabled: true }), /disk unavailable/);
  assert.equal(f.hotkey.get(), "Control+Shift+Space"); assert.equal(f.entries.has("Control+Alt+N"), false);
  assert.equal(f.calls.find(value => value.rollback)?.rollback.runtimeChanged, true);
  assert.equal(f.messages.length, 0); assert.equal(f.context.settingsRuntimeUpdateInProgress, false);
}));
test("a closing renderer cannot turn committed preferences into a runtime rollback", () => fixture(async f => {
  f.context.notesWindow.webContents.send = () => { throw new Error("synthetic renderer closed"); };
  const result = await f.save({ editorFontSize: 22, turboquantEnabled: true });
  assert.equal(result.ok, true); assert.equal(JSON.parse(fs.readFileSync(f.settingsPath)).editorFontSize, 22);
  assert.equal(f.calls.some(value => value.rollback), false);
}));
