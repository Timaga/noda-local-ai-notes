"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const { DEFAULT_PREFERENCES, normalizeHotkey, normalizePreferences } = require("../../frontend/desktop_preferences");

test("legacy profiles inherit editor defaults while explicit preferences remain intact", () => {
  assert.deepEqual(normalizePreferences({}), DEFAULT_PREFERENCES);
  const chosen = { quickNoteHotkey: "Ctrl+Alt+n", editorFontSize: 24, interfaceDensity: "compact", editorAutoSave: false, editorAutoSaveDelayMs: 10000 };
  const expected = { ...chosen, quickNoteHotkey: "Control+Alt+N" };
  assert.deepEqual(normalizePreferences(chosen), expected);
  assert.deepEqual(normalizePreferences({}, expected), expected);
  assert.equal(normalizePreferences({ editorFontSize: 14 }).editorFontSize, 14);
  assert.equal(normalizePreferences({ editorAutoSaveDelayMs: 500 }).editorAutoSaveDelayMs, 500);
});

test("shortcut validation accepts Electron accelerators and rejects malformed or typing-only combinations", () => {
  for (const [source, expected] of [["Ctrl+Shift+Space", "Control+Shift+Space"], ["CmdOrCtrl+F12", "CommandOrControl+F12"],
    ["CommandOrControl+Shift+Space", "CommandOrControl+Shift+Space"], ["Alt+PageDown", "Alt+PageDown"], ["Meta+9", "Meta+9"], ["Super+Tab", "Super+Tab"]]) {
    assert.equal(normalizeHotkey(source), expected);
  }
  for (const value of [null, 12, "N", "Shift+N", "Ctrl+", "Ctrl++N", "Ctrl+Ctrl+N", "Control+CommandOrControl+N", "Ctrl +N", " Ctrl+N", "Ctrl+F25", "Ctrl+;", "Ctrl+__proto__", "constructor+N", "Ctrl+constructor", "$(bad)", "Ctrl+Shift+Alt+Meta+Super+N"]) {
    assert.throws(() => normalizeHotkey(value), error => error.code === "quickNoteHotkey", String(value));
  }
});

test("preference boundaries are strict and unknown keys cannot bypass validation", () => {
  const cases = {
    editorFontSize: [null, "16", 13, 25, 16.5, NaN, Infinity],
    interfaceDensity: [null, "dense", "COMPACT", {}, []],
    editorAutoSave: [null, "false", 0, 1],
    editorAutoSaveDelayMs: [null, "1000", 499, 10001, 500.5, NaN, Infinity],
  };
  for (const [key, values] of Object.entries(cases)) for (const value of values) {
    assert.throws(() => normalizePreferences({ [key]: value }), error => error.code === key, `${key}:${value}`);
  }
  for (const payload of [null, [], true, "settings"]) assert.throws(() => normalizePreferences(payload));
  assert.deepEqual(normalizePreferences({ ignored: true }), DEFAULT_PREFERENCES);
});
