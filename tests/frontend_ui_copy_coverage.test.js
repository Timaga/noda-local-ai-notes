"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const catalogs = require("../frontend/ui_translations");
const { translate } = require("../frontend/ui_languages");
const required = require("./fixtures/ui_localization_required.json");
const codes = ["es", "fr", "de", "pt", "it", "zh", "ja", "ko"];
const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const call = new RegExp(String.raw`\b(?:t|text|noteText|uiText)\(\s*(${literal})\s*,\s*(${literal})\s*\)`, "g");
const pair = new RegExp(String.raw`\[\s*(${literal})\s*,\s*(${literal})\s*\]`, "g");
const source = file => fs.readFileSync(path.join(__dirname, "../frontend", file), "utf8");
// Tokens are limited to quoted string literals, never complete source expressions.
const stringValue = token => vm.runInNewContext(token);
const hasTranslation = (code, key) => Object.hasOwn(catalogs[code], key) || translate(code, "", key) !== key;

test("copy scanner recognizes escaped quotes and leaves source expressions unevaluated", () => {
  const example = String.raw`t("Удалить чат?", "Delete the chat \"{0}\"?")`;
  const matches = [...example.matchAll(call)];
  assert.equal(matches.length, 1);
  assert.equal(stringValue(matches[0][2]), 'Delete the chat "{0}"?');
  assert.equal([...String.raw`t("text", executeExternalCode())`.matchAll(call)].length, 0);
});

test("reviewed editor, queue, settings and recovery copy exists in every additional language", () => {
  assert.ok(required.length >= 140);
  assert.equal(new Set(required).size, required.length);
  for (const key of required) for (const code of codes) {
    assert.ok(Object.hasOwn(catalogs[code], key), `${code}: ${key}`);
    assert.ok(catalogs[code][key].trim(), `${code}: ${key}`);
    assert.ok(!catalogs[code][key].includes("\uFFFD"), `${code}: ${key}`);
  }
});

test("current UI call sites and localized status arrays have catalog coverage", () => {
  const files = ["notes_related.js", "notes_inline_editor.js", "notes_metadata_editor.js", "notes_settings_preferences.js",
    "notes_semantic_controls.js", "quick_capture_view.js", "desktop_preferences_bridge.js", "notes_renderer.js"];
  let count = 0;
  for (const file of files) {
    const content = source(file), keys = new Set();
    for (const match of content.matchAll(call)) keys.add(stringValue(match[2]));
    for (const match of content.matchAll(pair)) {
      if (/[А-Яа-яЁё]/u.test(stringValue(match[1]))) keys.add(stringValue(match[2]));
    }
    for (const key of keys) for (const code of codes) assert.ok(hasTranslation(code, key), `${file}: ${code}: ${key}`);
    count += keys.size;
  }
  assert.ok(count > 110, "Call-site coverage must include the actual UI copy");
});

test("static notes and quick-capture labels and tooltips are translated, including template values", () => {
  let count = 0;
  const decode = value => value.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const file of ["notes.html", "index.html"]) {
    const keys = new Set(Array.from(source(file).matchAll(/\bdata-en(?:-placeholder|-title|-aria-label|-aria-description|-alt)?="([^"]*)"/g), match => decode(match[1])));
    for (const key of keys) for (const code of codes) assert.ok(hasTranslation(code, key), `${file}: ${code}: ${key}`);
    count += keys.size;
  }
  assert.ok(count > 120);
});

test("reviewed action translations retain their interface meanings and queue counts", () => {
  const actions = {
    Close: ["Cerrar", "Fermer", "Schließen", "Fechar", "Chiudi", "关闭", "閉じる", "닫기"],
    Quit: ["Salir", "Quitter", "Beenden", "Sair", "Esci", "退出", "終了", "종료"],
    Retry: ["Reintentar", "Réessayer", "Erneut versuchen", "Tentar novamente", "Riprova", "重试", "再試行", "다시 시도"],
    Trash: ["Papelera", "Corbeille", "Papierkorb", "Lixeira", "Cestino", "回收站", "ゴミ箱", "휴지통"],
    "Loading…": ["Cargando…", "Chargement…", "Wird geladen…", "Carregando…", "Caricamento…", "正在加载…", "読み込み中…", "로드 중…"],
  };
  for (const [key, values] of Object.entries(actions)) for (const [index, code] of codes.entries()) {
    assert.equal(translate(code, "", key), values[index], `${code}: ${key}`);
  }
  const queues = ["Cola: 7", "File d’attente : 7", "Warteschlange: 7", "Fila: 7", "Coda: 7", "队列：7", "キュー：7", "대기열: 7"];
  for (const [index, code] of codes.entries()) assert.equal(translate(code, "", "Queue: 7"), queues[index], code);
});
