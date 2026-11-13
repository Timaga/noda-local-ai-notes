"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { DEFAULT_LANGUAGE, DEFAULT_THEME, loadDesktopSettings, saveDesktopSettings } = require("../frontend/desktop_settings");
const { createStartupLanguageSelection } = require("../frontend/startup_language");
const { localizeDesktopMenu } = require("../frontend/desktop_menu");
const { ensureTray } = require("../frontend/tray_controller");
const nodaLanguages = require("../frontend/ui_languages");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noda-english-default-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, settingsPath: path.join(root, "profile", "desktop-settings.json") };
}

function ui(language, page = "notes.html") {
  const html = fs.readFileSync(path.join(__dirname, "../frontend", page), "utf8");
  const document = {
    documentElement: { lang: html.match(/<html\b[^>]*\blang="([^"]+)"/u)?.[1] },
    querySelectorAll: () => [],
  };
  const window = { nodaLanguages };
  if (language !== undefined) window.quickNoteBridge = { getLanguage: () => language };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../frontend/i18n.js"), "utf8"), { window, document, Intl });
  return { document, i18n: window.nodaI18n };
}

test("fresh desktop settings start in English without a language prompt or profile write", async t => {
  const { root, settingsPath } = workspace(t);
  const defaults = { notesDirectory: path.join(root, "notes"), skipNotesDirectorySelection: false };
  const fresh = loadDesktopSettings(settingsPath, defaults);
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.equal(fresh.language, "en");
  assert.equal(fresh.skipNotesDirectorySelection, false);
  assert.equal(fresh.skipModelSelection, false);
  assert.equal(fresh.skipTurboQuantSelection, false);
  const startup = createStartupLanguageSelection({ initialLanguage: fresh.language,
    showPrompt: () => assert.fail("A fresh profile must not require a language choice"),
    persist: () => assert.fail("Reading default settings must not create or replace a profile") });
  assert.equal(await startup.wait(), "en");
  assert.equal(startup.getLanguage(), "en");
  assert.equal(fs.existsSync(settingsPath), false);
  assert.equal(fs.existsSync(defaults.notesDirectory), false);
  assert.equal(ui(startup.getLanguage()).i18n.t("Все заметки", "All notes"), "All notes");
});

test("the Electron entry point passes the English default without bypassing other setup choices", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
  const declaration = source.match(/const DESKTOP_SETTINGS_DEFAULTS = Object\.freeze\((\{[\s\S]*?\})\);/u);
  assert.ok(declaration, "The entry point must declare its desktop defaults");
  const defaults = vm.runInNewContext(`(${declaration[1]})`, {
    DEFAULT_LANGUAGE, DEFAULT_THEME, DEFAULT_NOTES_DIRECTORY: path.resolve("notes"),
    process: { env: {} }, MODEL_SELECTION_ON_STARTUP: true, HOTKEY: "Control+Alt+N",
  });
  assert.equal(defaults.language, "en");
  assert.equal(defaults.skipNotesDirectorySelection, false);
  assert.equal(defaults.skipModelSelection, false);
  assert.equal(defaults.skipTurboQuantSelection, false);
});

test("the actual preload bridge defaults to English and forwards each saved language without invoking IPC", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/preload.js"), "utf8");
  for (const language of [undefined, ...Object.keys(nodaLanguages.languages)]) {
    const exposed = {};
    vm.runInNewContext(source, {
      require: name => {
        assert.equal(name, "electron");
        return { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
          ipcRenderer: { on: () => {}, invoke: () => assert.fail("Preload must not start services") } };
      },
      process: { argv: language ? ["electron", `--noda-language=${language}`] : ["electron"] },
      document: { documentElement: { dataset: {}, style: {} } },
    });
    assert.equal(exposed.quickNoteBridge.getLanguage(), language ?? "en");
  }
});

test("English desktop defaults reach tray labels and nested native menu roles", () => {
  const translate = (ru, en) => nodaLanguages.translate(DEFAULT_LANGUAGE, ru, en);
  const tray = ensureTray({ Tray: class {
    on() {}
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }, Menu: { buildFromTemplate: value => value }, createTrayIcon: () => "synthetic-icon",
  appName: "Noda", uiText: translate, isReady: () => false });
  assert.deepEqual(tray.menu.filter(item => item.label).map(item => item.label),
    ["Quick note…", "Notes panel", "Start local services", "Quit"]);
  const menu = { items: [{ role: "editmenu", submenu: { items: [{ role: "copy" }] } }, { role: "quit" }] };
  localizeDesktopMenu(menu, DEFAULT_LANGUAGE);
  assert.equal(menu.items[0].label, "Edit");
  assert.equal(menu.items[0].submenu.items[0].label, "Copy");
  assert.equal(menu.items[1].label, "Exit");
});

for (const language of Object.keys(nodaLanguages.languages)) {
  test(`saved ${language} language survives settings round-trip and startup`, async t => {
    const { root, settingsPath } = workspace(t);
    const defaults = { notesDirectory: root, skipNotesDirectorySelection: false };
    const fresh = loadDesktopSettings(settingsPath, defaults);
    const saved = saveDesktopSettings(settingsPath, { ...fresh, language }, defaults);
    const before = fs.readFileSync(settingsPath, "utf8");
    const loaded = loadDesktopSettings(settingsPath, defaults);
    assert.deepEqual(loaded, saved);
    const startup = createStartupLanguageSelection({ initialLanguage: loaded.language,
      showPrompt: () => assert.fail("A saved language must not require a new choice"),
      persist: () => assert.fail("Startup must preserve the saved settings") });
    assert.equal(await startup.wait(), language);
    const rendered = ui(startup.getLanguage());
    assert.equal(rendered.document.documentElement.lang, language);
    assert.equal(rendered.i18n.locale(), nodaLanguages.languages[language][1]);
    assert.equal(rendered.i18n.t("Все заметки", "All notes"), nodaLanguages.translate(language, "Все заметки", "All notes"));
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before);
  });
}

test("an explicit null language still allows the existing optional chooser", async t => {
  const { root, settingsPath } = workspace(t);
  const defaults = { notesDirectory: root };
  const fresh = loadDesktopSettings(settingsPath, defaults);
  saveDesktopSettings(settingsPath, { ...fresh, language: null }, defaults);
  const loaded = loadDesktopSettings(settingsPath, defaults);
  assert.equal(loaded.language, null);
  const calls = [];
  const startup = createStartupLanguageSelection({ initialLanguage: loaded.language,
    showPrompt: () => calls.push("prompt"),
    persist: language => saveDesktopSettings(settingsPath, { ...loaded, language }, defaults) });
  const pending = startup.wait();
  assert.deepEqual(calls, ["prompt"]);
  assert.equal(startup.getLanguage(), null);
  assert.deepEqual(startup.select("es"), { ok: true, language: "es" });
  assert.equal(await pending, "es");
  assert.equal(loadDesktopSettings(settingsPath, defaults).language, "es");
});

for (const page of ["startup.html", "index.html", "notes.html"]) {
  test(`${page} renders English before any saved language is supplied`, () => {
    for (const language of [undefined, "unsupported"]) {
      const { document, i18n } = ui(language, page);
      assert.equal(document.documentElement.lang, "en");
      assert.equal(i18n.getLanguage(), "en");
      assert.equal(i18n.locale(), "en-US");
      assert.equal(i18n.t("Сохранить", "Save"), "Save");
      assert.equal(i18n.count(2, ["заметка", "заметки", "заметок"], "note", "notes"), "2 notes");
    }
  });
}
