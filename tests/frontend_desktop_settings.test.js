// Who: Tim Buglaev
// When: 2026-07-10
// What: Verify desktop settings validation, atomic persistence, backward-compatible
//       TurboQuant preferences, blue defaults, and rejection of malformed input.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_THEME,
  loadDesktopSettings,
  normalizeNotesDirectory,
  saveDesktopSettings,
  validateDesktopSettings,
} = require("../frontend/desktop_settings");
const autoSkipPairs = { skipNoteTitleSelection: true, skipNoteTagsSelection: true, skipNoteLinksSelection: true };
const { DEFAULT_PREFERENCES } = require("../frontend/desktop_preferences");

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gui-settings-"));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("settings round-trip preserves validated startup choices", () => withWorkspace((root) => {
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const settingsPath = path.join(root, "profile", "desktop-settings.json");
  const defaults = {
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: false,
    theme: "noda-red",
  };

  const saved = saveDesktopSettings(settingsPath, {
    notesDirectory: vault,
    skipModelSelection: true,
    skipNotesDirectorySelection: false,
    skipTurboQuantSelection: true,
    theme: "classic-blue",
  }, defaults);
  const updated = saveDesktopSettings(settingsPath, {
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: false,
    theme: "noda-red",
  }, defaults);

  assert.notDeepEqual(updated, saved);
  assert.deepEqual(loadDesktopSettings(settingsPath, defaults), updated);
  assert.deepEqual(
    fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.endsWith(".tmp")),
    []
  );
}));

test("invalid persisted JSON falls back without escaping the configured vault", () => withWorkspace((root) => {
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const settingsPath = path.join(root, "desktop-settings.json");
  fs.writeFileSync(settingsPath, "{invalid", "utf8");

  const loaded = loadDesktopSettings(settingsPath, {
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
  });

  assert.equal(loaded.notesDirectory, path.resolve(vault));
  assert.equal(loaded.skipNotesDirectorySelection, true);
  assert.equal(loaded.skipTurboQuantSelection, false);
  assert.equal(DEFAULT_THEME, "classic-blue");
  assert.equal(loaded.theme, "classic-blue");
}));

test("a fresh Windows profile can save its language before setup creates the default notes folder", () => withWorkspace(root => {
  const settingsPath = path.join(root, "profile", "desktop-settings.json");
  const notesDirectory = path.join(root, "profile", "notes");
  const defaults = { notesDirectory, skipNotesDirectorySelection: false };

  const fresh = loadDesktopSettings(settingsPath, defaults);
  assert.equal(fresh.notesDirectory, notesDirectory);
  const saved = saveDesktopSettings(settingsPath, { ...fresh, language: "en" }, defaults,
    { allowUnavailableDirectory: true });
  assert.equal(loadDesktopSettings(settingsPath, defaults).language, "en");
  assert.equal(fs.existsSync(notesDirectory), false);
  assert.throws(() => saveDesktopSettings(settingsPath, saved, defaults), /не существует/);

  fs.mkdirSync(notesDirectory);
  assert.deepEqual(saveDesktopSettings(settingsPath, saved, defaults), saved);
}));

test("an unavailable saved vault keeps its path and preferences until the user chooses a replacement", () => withWorkspace(root => {
  const notesDirectory = path.join(root, "external-vault");
  const settingsPath = path.join(root, "desktop-settings.json");
  const defaults = { notesDirectory: root };
  const previous = { notesDirectory, language: "en", skipModelSelection: false, skipNotesDirectorySelection: true };
  fs.writeFileSync(settingsPath, JSON.stringify(previous), "utf8");

  const loaded = loadDesktopSettings(settingsPath, defaults);
  assert.equal(loaded.notesDirectory, notesDirectory);
  assert.equal(loaded.language, "en");
  assert.equal(loaded.skipNotesDirectorySelection, true);
  assert.equal(fs.existsSync(notesDirectory), false);
}));

test("renderer-shaped settings reject malformed flags and unsafe paths", () => withWorkspace((root) => {
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const defaults = {
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: false,
    theme: "noda-red",
  };

  assert.throws(() => normalizeNotesDirectory("relative/vault"), /абсолютным/);
  assert.throws(() => normalizeNotesDirectory(path.join(root, "missing")), /не существует/);
  assert.throws(() => validateDesktopSettings({
    notesDirectory: vault,
    skipModelSelection: "yes",
    skipNotesDirectorySelection: true,
  }, defaults), /выбора модели/);
  assert.throws(() => validateDesktopSettings({
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: "yes",
  }, defaults), /TurboQuant/);
  assert.throws(() => validateDesktopSettings({
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: false,
    theme: "untrusted-theme",
  }, defaults), /тема/);
}));

test("legacy settings without TurboQuant preference inherit the safe prompt default", () => withWorkspace((root) => {
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const settingsPath = path.join(root, "desktop-settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    notesDirectory: vault,
    skipModelSelection: true,
    skipNotesDirectorySelection: true,
  }), "utf8");

  const loaded = loadDesktopSettings(settingsPath, {
    notesDirectory: vault,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: false,
    theme: "noda-red",
  });
  assert.equal(loaded.skipTurboQuantSelection, false);
  assert.equal(loaded.skipModelSelection, true);
  assert.equal(loaded.theme, "noda-red");
}));

test("legacy profiles retain their preferences and default to English until a language is saved", () => withWorkspace((root) => {
  const settingsPath = path.join(root, "desktop-settings.json");
  const legacy = {
    notesDirectory: root,
    skipModelSelection: true,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: true,
    theme: "noda-red",
  };
  const defaults = { ...legacy, skipNotesDirectorySelection: false, theme: "classic-blue" };
  fs.writeFileSync(settingsPath, JSON.stringify(legacy), "utf8");

  const loaded = loadDesktopSettings(settingsPath, defaults);
  assert.deepEqual(loaded, { ...DEFAULT_PREFERENCES, ...legacy, ...autoSkipPairs, language: "en" });
  const english = saveDesktopSettings(settingsPath, { ...loaded, language: "en" }, defaults);
  assert.deepEqual(loadDesktopSettings(settingsPath, defaults), english);

  const updatedByLegacyRenderer = saveDesktopSettings(settingsPath, { ...legacy, theme: "classic-blue" }, english);
  assert.equal(updatedByLegacyRenderer.language, "en");
  assert.equal(loadDesktopSettings(settingsPath, defaults).language, "en");
  saveDesktopSettings(settingsPath, { ...updatedByLegacyRenderer, language: "ru" }, defaults);
  assert.equal(loadDesktopSettings(settingsPath, defaults).language, "ru");
}));

test("invalid language values are rejected before writing desktop settings", () => withWorkspace((root) => {
  const settingsPath = path.join(root, "desktop-settings.json");
  const settings = {
    notesDirectory: root,
    skipModelSelection: false,
    skipNotesDirectorySelection: true,
    language: "en",
  };
  saveDesktopSettings(settingsPath, settings, settings);
  const before = fs.readFileSync(settingsPath, "utf8");

  for (const language of ["EN", "en-US", "ru ", "__proto__", ["ru"], 1, true]) {
    assert.throws(() => saveDesktopSettings(settingsPath, { ...settings, language }, settings), /язык|language/i);
  }
  assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
}));

test("an unsupported saved language keeps the vault and the other preferences", () => withWorkspace((root) => {
  const vault = path.join(root, "existing-vault");
  fs.mkdirSync(vault);
  const settingsPath = path.join(root, "desktop-settings.json");
  const preferences = {
    notesDirectory: vault,
    skipModelSelection: true,
    skipNotesDirectorySelection: true,
    skipTurboQuantSelection: true,
    theme: "noda-red",
  };
  fs.writeFileSync(settingsPath, JSON.stringify({ ...preferences, language: "uk" }), "utf8");

  assert.deepEqual(loadDesktopSettings(settingsPath, { notesDirectory: root }), {
    ...DEFAULT_PREFERENCES,
    ...preferences,
    ...autoSkipPairs,
    language: null,
  });
}));

test("independent note-stage skips default on for legacy profiles and round-trip explicit false", () => withWorkspace((root) => {
  const settingsPath = path.join(root, "desktop-settings.json");
  const legacy = { notesDirectory: root, skipModelSelection: false, skipNotesDirectorySelection: true };
  const fresh = loadDesktopSettings(settingsPath, legacy);
  for (const key of Object.keys(autoSkipPairs)) assert.equal(fresh[key], true);
  const saved = saveDesktopSettings(settingsPath, {
    ...fresh, skipNoteTitleSelection: false, skipNoteTagsSelection: true, skipNoteLinksSelection: false,
  }, legacy);
  assert.equal(saved.skipModelSelection, false);
  assert.equal(saved.skipNoteTitleSelection, false);
  assert.equal(saved.skipNoteTagsSelection, true);
  assert.equal(saved.skipNoteLinksSelection, false);
  assert.deepEqual(loadDesktopSettings(settingsPath, legacy), saved);
  const preserved = saveDesktopSettings(settingsPath, legacy, saved);
  assert.equal(preserved.skipNoteTitleSelection, false);
  assert.equal(preserved.skipNoteTagsSelection, true);
  assert.equal(preserved.skipNoteLinksSelection, false);
}));

test("invalid stage skip flags cannot mutate persisted settings", () => withWorkspace((root) => {
  const settingsPath = path.join(root, "desktop-settings.json");
  const settings = { notesDirectory: root, skipModelSelection: true, skipNotesDirectorySelection: false };
  saveDesktopSettings(settingsPath, settings, settings);
  const before = fs.readFileSync(settingsPath, "utf8");
  for (const key of Object.keys(autoSkipPairs)) {
    for (const invalid of [null, "false", 0, 1, [], {}]) {
      assert.throws(() => saveDesktopSettings(settingsPath, { ...settings, [key]: invalid }, settings), /выбора связки/);
      assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
    }
  }
}));

test("editor preferences round-trip atomically and malformed values leave the saved file intact", () => withWorkspace(root => {
  const settingsPath = path.join(root, "desktop-settings.json");
  const settings = { notesDirectory: root, skipModelSelection: true, skipNotesDirectorySelection: true,
    quickNoteHotkey: "Alt+N", editorFontSize: 21, interfaceDensity: "compact", editorAutoSave: false, editorAutoSaveDelayMs: 3000 };
  const saved = saveDesktopSettings(settingsPath, settings, { notesDirectory: root });
  assert.deepEqual(loadDesktopSettings(settingsPath, { notesDirectory: root }), saved);
  assert.equal(saved.editorAutoSave, false); assert.equal(saved.quickNoteHotkey, "Alt+N");
  const before = fs.readFileSync(settingsPath, "utf8");
  for (const patch of [{ quickNoteHotkey: "Shift+A" }, { editorFontSize: 13 }, { interfaceDensity: "hidden" },
    { editorAutoSave: "false" }, { editorAutoSaveDelayMs: 10001 }]) {
    assert.throws(() => saveDesktopSettings(settingsPath, { ...settings, ...patch }, saved));
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
  }
  assert.deepEqual(fs.readdirSync(root), ["desktop-settings.json"]);
  const legacyWrite = saveDesktopSettings(settingsPath, { notesDirectory: root, skipModelSelection: false, skipNotesDirectorySelection: true }, saved);
  for (const key of Object.keys(DEFAULT_PREFERENCES)) assert.equal(legacyWrite[key], saved[key]);
}));
