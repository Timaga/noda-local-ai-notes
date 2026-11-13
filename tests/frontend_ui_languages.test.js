"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createStartupLanguageSelection } = require("../frontend/startup_language");
const { languages, supported, translate } = require("../frontend/ui_languages");
const catalogs = require("../frontend/ui_translations");

test("the startup chooser persists each of the ten supported languages", async () => {
  const codes = ["en", "ru", "es", "fr", "de", "pt", "it", "zh", "ja", "ko"];
  assert.deepEqual(Object.keys(languages), codes);
  for (const code of codes) {
    const calls = [];
    const chooser = createStartupLanguageSelection({ initialLanguage: null,
      showPrompt: () => calls.push("prompt"), persist: selected => calls.push(selected) });
    const pending = chooser.wait();
    assert.deepEqual(chooser.select(code), { ok: true, language: code });
    assert.equal(await pending, code);
    assert.deepEqual(calls, ["prompt", code]);
  }
  for (const code of ["__proto__", "constructor", "zh-CN", ["zh"], null]) assert.equal(supported(code), false);
});

test("localizations cover each catalog key and preserve template placeholders", () => {
  const keys = Object.keys(catalogs.es).sort();
  const markers = (value) => value.match(/\{\d+\}/g)?.sort() || [];
  assert.ok(keys.length > 900);
  for (const [code, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, code);
    for (const key of ["Support email", "Copy email", "Email copied.", "Could not copy the email."]) {
      assert.ok(Object.hasOwn(catalog, key), `${code}: ${key}`);
    }
    for (const [source, target] of Object.entries(catalog)) {
      assert.ok(target.trim().length, `${code}: ${source}`);
      assert.deepEqual(markers(target), markers(source), `${code}: ${source}`);
      if (!/[<>]/u.test(source)) assert.doesNotMatch(target, /[<>]/u, `${code}: ${source}`);
    }
  }
});

test("interface text uses the selected locale and interpolates existing values unchanged", () => {
  assert.equal(translate("en", "Все заметки", "All notes"), "All notes");
  assert.equal(translate("ru", "Все заметки", "All notes"), "Все заметки");
  assert.equal(translate("zh", "Все заметки", "All notes"), "所有笔记");
  assert.equal(translate("ko", "Все заметки", "All notes"), "모든 노트");
  const value = "F:\\test notes\\Q1 $& 123";
  const source = `Backup verified and saved to ${value}`;
  for (const code of Object.keys(catalogs)) {
    const result = translate(code, "Резервная копия сохранена", source);
    assert.ok(result.includes(value), code);
    assert.notEqual(result, source, code);
  }
});
