(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NotesDesktopPreferences = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";
  const DEFAULT_PREFERENCES = Object.freeze({
    quickNoteHotkey: "Control+Shift+Space", editorFontSize: 16,
    interfaceDensity: "comfortable", editorAutoSave: true, editorAutoSaveDelayMs: 1000,
  });
  const failure = key => Object.assign(new Error(key), { code: key });
  const modifierAliases = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift",
    meta: "Meta", super: "Super", command: "Command", cmd: "Command", commandorcontrol: "CommandOrControl", cmdorctrl: "CommandOrControl" };
  const namedKeys = Object.fromEntries(["Space", "Tab", "Escape", "Enter", "Backspace", "Delete", "Insert", "Home", "End",
    "PageUp", "PageDown", "Up", "Down", "Left", "Right"].map(key => [key.toLowerCase(), key]));
  const ownValue = (values, key) => Object.hasOwn(values, key) ? values[key] : null;

  function normalizeHotkey(value) {
    if (typeof value !== "string" || value.length > 80 || value !== value.trim()) throw failure("quickNoteHotkey");
    const pieces = value.split("+");
    if (pieces.length < 2 || pieces.length > 5 || pieces.some(piece => !piece || piece !== piece.trim())) throw failure("quickNoteHotkey");
    const modifiers = pieces.slice(0, -1).map(piece => ownValue(modifierAliases, piece.toLowerCase()));
    if (modifiers.some(modifier => !modifier) || new Set(modifiers).size !== modifiers.length
        || !modifiers.some(modifier => modifier !== "Shift")) throw failure("quickNoteHotkey");
    if (modifiers.filter(modifier => ["Control", "Command", "CommandOrControl"].includes(modifier)).length > 1) throw failure("quickNoteHotkey");
    const raw = pieces.at(-1), key = /^[a-z0-9]$/i.test(raw) ? raw.toUpperCase()
      : /^F(?:[1-9]|1\d|2[0-4])$/i.test(raw) ? raw.toUpperCase() : ownValue(namedKeys, raw.toLowerCase());
    if (!key) throw failure("quickNoteHotkey");
    return [...modifiers, key].join("+");
  }

  function normalizePreferences(payload = {}, defaults = DEFAULT_PREFERENCES) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("preferences");
    const result = {};
    for (const key of Object.keys(DEFAULT_PREFERENCES)) result[key] = payload[key] === undefined
      ? defaults?.[key] ?? DEFAULT_PREFERENCES[key] : payload[key];
    result.quickNoteHotkey = normalizeHotkey(result.quickNoteHotkey);
    if (!Number.isInteger(result.editorFontSize) || result.editorFontSize < 14 || result.editorFontSize > 24) throw failure("editorFontSize");
    if (!["comfortable", "compact"].includes(result.interfaceDensity)) throw failure("interfaceDensity");
    if (typeof result.editorAutoSave !== "boolean") throw failure("editorAutoSave");
    if (!Number.isInteger(result.editorAutoSaveDelayMs) || result.editorAutoSaveDelayMs < 500 || result.editorAutoSaveDelayMs > 10000) {
      throw failure("editorAutoSaveDelayMs");
    }
    return result;
  }
  return { DEFAULT_PREFERENCES, normalizeHotkey, normalizePreferences };
});
