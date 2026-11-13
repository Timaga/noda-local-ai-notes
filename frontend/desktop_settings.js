// Who: Tim Buglaev
// When: 2026-07-02
// What: Provide validated, atomic desktop preference storage for startup prompts,
//       including the optional TurboQuant question, and the local notes directory.
const fs = require("fs");
const path = require("path");
const { supported: isSupportedLanguage } = require("./ui_languages");
const { normalizePreferences } = require("./desktop_preferences");

const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_NOTES_PATH_CHARS = 1024;

// Who: Tim Buglaev
// When: 2026-07-10
// What: Keep both shipped theme keys allowlisted. Existing classic-blue
//       preferences use the current Graphite palette.
const DEFAULT_THEME = "classic-blue";
const DEFAULT_LANGUAGE = "en";
const SUPPORTED_THEMES = Object.freeze(["noda-red", "classic-blue"]);
const NOTE_STAGE_SKIP_KEYS = Object.freeze([
  "skipNoteTitleSelection", "skipNoteTagsSelection", "skipNoteLinksSelection",
]);

function normalizeTheme(value, fallback = DEFAULT_THEME) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || !SUPPORTED_THEMES.includes(candidate)) {
    throw new Error("Некорректная тема интерфейса.");
  }
  return candidate;
}

function normalizeLanguage(value, fallback = null) {
  const candidate = value === undefined ? fallback : value;
  if (candidate === null || isSupportedLanguage(candidate)) return candidate;
  throw new Error("Некорректный язык интерфейса.");
}

function normalizeNotesDirectory(value, options = {}) {
  const mustExist = options.mustExist !== false;
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_NOTES_PATH_CHARS || raw.includes("\0")) {
    throw new Error("Некорректный путь к заметкам.");
  }
  if (!path.isAbsolute(raw)) {
    throw new Error("Путь к заметкам должен быть абсолютным.");
  }
  const resolved = path.resolve(raw);
  if (mustExist) {
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      throw new Error("Выбранная папка с заметками не существует.");
    }
  }
  return resolved;
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Add safe defaults for TurboQuant and the Noda visual theme while preserving
//       compatibility with preference files created by older app versions.
function normalizeDefaults(defaults) {
  return {
    ...normalizePreferences(defaults || {}),
    skipModelSelection: Boolean(defaults?.skipModelSelection),
    skipNotesDirectorySelection: defaults?.skipNotesDirectorySelection !== false,
    skipTurboQuantSelection: Boolean(defaults?.skipTurboQuantSelection),
    ...Object.fromEntries(NOTE_STAGE_SKIP_KEYS.map(key => [key, defaults?.[key] !== false])),
    theme: normalizeTheme(defaults?.theme),
    language: normalizeLanguage(defaults?.language, DEFAULT_LANGUAGE),
    notesDirectory: normalizeNotesDirectory(defaults?.notesDirectory, { mustExist: false }),
  };
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Validate the allowlisted theme together with existing startup settings;
//       missing legacy theme values inherit the trusted current/default choice.
function validateDesktopSettings(payload, defaults, { allowUnavailableDirectory = false } = {}) {
  const fallback = normalizeDefaults(defaults);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Настройки должны быть объектом.");
  }
  if (typeof payload.skipModelSelection !== "boolean") {
    throw new Error("Некорректное значение пропуска выбора модели.");
  }
  if (typeof payload.skipNotesDirectorySelection !== "boolean") {
    throw new Error("Некорректное значение пропуска выбора папки.");
  }
  if (payload.skipTurboQuantSelection !== undefined
    && typeof payload.skipTurboQuantSelection !== "boolean") {
    throw new Error("Некорректное значение пропуска вопроса TurboQuant.");
  }
  for (const key of NOTE_STAGE_SKIP_KEYS) {
    if (payload[key] !== undefined && typeof payload[key] !== "boolean") {
      throw new Error("Некорректное значение пропуска выбора связки.");
    }
  }
  return {
    ...normalizePreferences(payload, fallback),
    skipModelSelection: payload.skipModelSelection,
    skipNotesDirectorySelection: payload.skipNotesDirectorySelection,
    skipTurboQuantSelection: payload.skipTurboQuantSelection ?? fallback.skipTurboQuantSelection,
    ...Object.fromEntries(NOTE_STAGE_SKIP_KEYS.map(key => [key, payload[key] ?? fallback[key]])),
    theme: normalizeTheme(payload.theme, fallback.theme),
    language: normalizeLanguage(payload.language, fallback.language),
    notesDirectory: normalizeNotesDirectory(payload.notesDirectory || fallback.notesDirectory, {
      mustExist: !allowUnavailableDirectory,
    }),
  };
}

function loadDesktopSettings(filePath, defaults) {
  const fallback = normalizeDefaults(defaults);
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      return fallback;
    }
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
      throw new Error("Некорректный файл настроек.");
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.language != null && !isSupportedLanguage(parsed.language)) {
      parsed.language = null;
    }
    return validateDesktopSettings(parsed, fallback, { allowUnavailableDirectory: true });
  } catch (error) {
    console.warn(`[settings] ${error.message}; используются безопасные значения по умолчанию.`);
    return fallback;
  }
}

function saveDesktopSettings(filePath, settings, defaults, options) {
  const validated = validateDesktopSettings(settings, defaults, options);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return validated;
}

module.exports = {
  DEFAULT_LANGUAGE,
  DEFAULT_THEME,
  SUPPORTED_THEMES,
  loadDesktopSettings,
  normalizeLanguage,
  normalizeNotesDirectory,
  normalizeTheme,
  saveDesktopSettings,
  validateDesktopSettings,
};
