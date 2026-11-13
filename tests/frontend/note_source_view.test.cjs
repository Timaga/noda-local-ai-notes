const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const path = require("node:path");
const { createRequire } = require("node:module");
const marked = createRequire(path.join(__dirname, "../../frontend/package.json"))("marked");

const context = { window: {} };
const parserFile = path.join(__dirname, "../../frontend/notes_markdown.js");
vm.runInNewContext(fs.readFileSync(parserFile, "utf8"), context, { filename: parserFile });
const { presentation } = context.window.notesMarkdown;
context.window.marked = marked;
context.noteAssetUrl = () => "";
const rendererSource = fs.readFileSync(path.join(__dirname, "../../frontend/notes_renderer.js"), "utf8");
for (const name of ["escapeHtml", "preprocessObsidianMarkdown"]) {
  const fn = new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(rendererSource);
  assert(fn, `actual renderer function ${name}`);
  vm.runInNewContext(fn[0], context);
}
function wrap(source, related = [], { version = "faithful-v1", tags = [], title = "Проверка исходника" } = {}) {
  return ["---", `title: ${JSON.stringify(title)}`, `tags: ${JSON.stringify(tags)}`, `related: ${JSON.stringify(related)}`,
    `noda_source_version: ${JSON.stringify(version)}`, `noda_source_sha256: "${crypto.createHash("sha256").update(source).digest("hex")}"`,
    `noda_source_length: ${Array.from(source).length}`, "---", ""].join("\n") + source;
}

test("preview keeps source whitespace, CRLF, BOM and astral characters", () => {
  const source = "\ufeff  Текст 😀\r\n\r\n```\r\n[[Пример]]\r\n```\r\n ";
  const view = presentation(wrap(source));
  assert.equal(view.source, source);
  assert.equal(view.title, "Проверка исходника");
});

test("RU pipeline preview strips only its wrapper and exposes exact existing tags and links", () => {
  const source = "  Проверить заявки курьера.\r\n\r\nПример 😀\r\n ";
  const tags = ["crm", "проекты/Оплата-2", "_тег"];
  const related = ["Проекты/Заявки", 'Курьер "два"'];
  const view = presentation(wrap(source, related, { version: "ru-pipeline-v1", tags }));
  assert.equal(view.source, source);
  assert.equal(view.title, "Проверка исходника");
  assert.deepEqual(Array.from(view.tags), tags);
  assert.deepEqual(Array.from(view.related), related);
  const html = context.preprocessObsidianMarkdown(wrap(source, related, { version: "ru-pipeline-v1", tags }));
  assert(!html.includes("noda_source_"));
  assert(!html.includes("tags:"));
  assert.equal((html.match(/data-note-title=/g) || []).length, related.length);
});

test("both shipped wrapper versions render current author edits and retry headline", () => {
  for (const version of ["faithful-v1", "ru-pipeline-v1"]) {
    const current = "  Отредактированный текст\r\n ";
    const metadata = wrap("Original", [], { version, title: "Новый заголовок того же файла" });
    const view = presentation(metadata.slice(0, -"Original".length) + current);
    assert.equal(view.source, current);
    assert.equal(view.title, "Новый заголовок того же файла");
    assert.deepEqual(Array.from(view.tags), []);
  }
});

test("RU tags use Unicode code-point boundaries and the backend nested-tag grammar", () => {
  const letter = "\u{10400}";
  const accepted = ["café", "Ёж/Отчёт-2026", letter.repeat(80)];
  const view = presentation(wrap("Исходник", [], { version: "ru-pipeline-v1", tags: accepted }));
  assert.deepEqual(Array.from(view.tags), accepted);
  for (const tags of [null, {}, [null], [5], [""], [" тег"], ["тег "], ["а\tб"],
    ["а\u007fб"], ["2026"], ["___"], ["#crm"], ["/тег"], ["тег/"], ["тег//два"],
    ["e\u0301"], ["<b>тег</b>"], ["тег", "тег"], [letter.repeat(81)]]) {
    const malformed = wrap("Исходник", [], { version: "ru-pipeline-v1", tags });
    const raw = presentation(malformed);
    assert.equal(raw.source, malformed);
    assert.equal(raw.tags, null);
  }
});

test("RU related IDs remain unlimited and escape literal labels safely", () => {
  const ids = Array.from({ length: 35 }, (_, i) => `Каталог/${i} Полная заметка`);
  ids.push('<img src=x onerror="attack()">');
  const source = wrap("Авторский текст", ids, { version: "ru-pipeline-v1", tags: ["проект"] });
  assert.deepEqual(Array.from(presentation(source).related), ids);
  const html = context.preprocessObsidianMarkdown(source);
  assert.equal((html.match(/data-note-title=/g) || []).length, ids.length);
  assert(html.includes("&lt;img src=x onerror=&quot;attack()&quot;&gt;"));
  assert(!html.includes("<img"));
  for (const related of [null, {}, [5], [null], [""], [" заметка"], ["заметка "],
    ["а\nб"], ["а\u007fб"], ["а", "а"]]) {
    const malformed = wrap("Исходник", related, { version: "ru-pipeline-v1" });
    assert.equal(presentation(malformed).source, malformed);
  }
});

test("only the exact application schema hides service metadata", () => {
  const valid = wrap("Текст", [], { version: "ru-pipeline-v1" });
  const malformed = [
    valid.replace('"ru-pipeline-v1"', '"future-v2"'),
    valid.replace('"ru-pipeline-v1"', "false"),
    valid.replace('tags: []', 'tags: []\ndisplay_title: "extra field"'),
    valid.replace('tags: []', 'tags: []\ntags: []'),
    valid.replace('tags: []', 'tags: []\n'),
    valid.replace('tags: []', 'Tags: []'),
    valid.replace('tags: []\n', ""),
    valid.replace('tags: []', 'malformed header line'),
    valid.replace('title: "Проверка исходника"', 'title: false'),
    valid.replace('title: "Проверка исходника"', 'title: ""'),
    valid.replace('tags: []', 'tags: invalid'),
    valid.replace('noda_source_length: 5', 'noda_source_length: -1'),
    valid.replace('noda_source_length: 5', 'noda_source_length: 05'),
    valid.replace(/noda_source_sha256: "[a-f0-9]+"/, 'noda_source_sha256: "not-a-digest"'),
  ];
  for (const raw of malformed) {
    const view = presentation(raw);
    assert.equal(view.source, raw);
    assert.equal(view.title, null);
    assert.equal(view.tags, null);
    assert.deepEqual(Array.from(view.related), []);
  }
});

test("CRLF wrappers preserve the exact body and ordinary frontmatter keeps DTO authority", () => {
  const source = "\ufeff  Авторский текст 😀\r\n\r\n```yaml\r\ntags: []\r\n```\r\n ";
  const wrapped = wrap(source, [], { version: "ru-pipeline-v1", tags: ["пример"] });
  const crlf = wrapped.slice(0, -source.length).replaceAll("\n", "\r\n") + source;
  assert.equal(presentation(crlf).source, source);
  assert.deepEqual(Array.from(presentation(crlf).tags), ["пример"]);
  for (const original of [source, "---\ntags: [обычный]\n---\nТекст", "Текст\n" + wrapped, "\ufeff" + wrapped]) {
    const view = presentation(original);
    assert.equal(view.source, original);
    assert.equal(view.tags, null);
  }
});

test("preview exposes every exact relative ID without a quota", () => {
  const ids = Array.from({ length: 35 }, (_, i) => `${i}/Одинаковое имя, файл`);
  const view = presentation(wrap("Исходник", ids));
  assert.deepEqual(Array.from(view.related), ids);
});

test("actual preview renders all related links separately and escapes their labels and IDs", () => {
  const ids = ['Каталог/Файл "кавычки"', '<img src=x onerror=alert(1)>', "x".repeat(230)];
  const html = context.preprocessObsidianMarkdown(wrap("Авторский текст", ids));
  assert.equal((html.match(/data-note-title=/g) || []).length, 3);
  assert(html.includes("&quot;кавычки&quot;"));
  assert(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert(html.includes("x".repeat(230)));
  assert(!html.includes("<img"));
  assert(!html.includes("noda_source_"));
  assert(html.includes("Авторский текст"));
});

test("author edits display the current body while keeping the creation receipt", () => {
  const original = "Original body";
  const current = "  Edited body\r\n ";
  const edited = wrap(original).replace(original, current);
  assert.equal(presentation(edited).source, current);
});

test("ordinary author frontmatter remains author text", () => {
  const source = "---\ntitle: Авторский заголовок\n---\n  Текст\r\n";
  assert.equal(presentation(source).source, source);
});

test("malformed application wrapper stays visibly raw instead of hiding text", () => {
  const valid = wrap("Исходник", ["Архив"]);
  for (const invalid of [valid.replace('tags: []', 'tags: ["tag"]'),
    valid.replace('noda_source_length: 8', 'noda_source_length: invalid'),
    valid.replace('related: ["Архив"]', 'related: ["Архив", "Архив"]'),
    valid.replace('tags: []', 'tags: []\ntags: []')]) {
    const view = presentation(invalid);
    assert.equal(view.source, invalid);
    assert.equal(view.title, null);
  }
});
