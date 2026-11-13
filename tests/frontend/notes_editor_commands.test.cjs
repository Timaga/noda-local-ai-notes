"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { format, shortcut, linkAddress, insertLink } = require("../../frontend/notes_editor_commands");
test("formatting surrounds only the selection and toggles without losing surrounding text", () => {
  const first = format("one two three", 4, 7, "bold");
  assert.deepEqual(first, { value: "one **two** three", start: 6, end: 9 });
  assert.deepEqual(format(first.value, first.start, first.end, "bold"), { value: "one two three", start: 4, end: 7 });
  for (const command of ["italic", "strike", "code", "link"]) {
    const result = format("word", 0, 4, command);
    assert.equal(result.value.slice(result.start, result.end), "word");
  }
});

test("editor shortcuts use physical keys across layouts and leave IME and Alt combinations alone", () => {
  for (const [key, code, expected] of [["ы", "KeyS", "save"], ["и", "KeyB", "bold"], ["ш", "KeyI", "italic"], ["л", "KeyK", "link"]]) {
    assert.equal(shortcut({ key, code, ctrlKey: true }), expected);
    assert.equal(shortcut({ key, code, metaKey: true }), expected);
    assert.equal(shortcut({ key, code, ctrlKey: true, isComposing: true }), null);
    assert.equal(shortcut({ key, code, ctrlKey: true, altKey: true }), null);
    assert.equal(shortcut({ key, code }), null);
  }
  assert.equal(shortcut({ key: "S", ctrlKey: true }), "save");
  assert.equal(shortcut({ key: "s", code: "KeyQ", ctrlKey: true }), null);
  assert.equal(shortcut({ code: "KeyQ", ctrlKey: true }), null);
});

test("links accept safe explicit protocols and reject executable, credentialed and malformed addresses", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,bad", "file:///C:/private", "//example.com", "https://user:pass@example.com",
    "https://example.com/\nattack", "https://example.com/a b", "mailto:", "not-a-url", null, "https://example.com/" + "a".repeat(2048)]) {
    assert.equal(linkAddress(bad), null, String(bad).slice(0, 40));
    assert.equal(insertLink("source", 0, 6, bad), null);
  }
  assert.equal(linkAddress("https://example.com/a?q=1&n=2"), "https://example.com/a?q=1&n=2");
  assert.equal(linkAddress("http://example.com"), "http://example.com/");
  assert.equal(linkAddress("mailto:team@example.com"), "mailto:team@example.com");
  assert.equal(insertLink("before [label] after", 7, 14, "https://example.com/a(b)").value,
    "before [\\[label\\]](<https://example.com/a(b)>) after");
  assert.equal(insertLink("text", 0, 0, "https://example.com").value, "[https://example.com/](<https://example.com/>)text");
  assert.deepEqual(format("label", 0, 5, "link"), { value: "label", start: 0, end: 5 });
});
test("line styles preserve adjacent lines, newlines and empty first lines", () => {
  assert.equal(format("\nsecond", 0, 0, "h1").value, "# \nsecond");
  assert.equal(format("one\ntwo\nthree", 0, 8, "numbered").value, "1. one\n2. two\nthree");
  assert.equal(format("one\ntwo\nthree", 5, 6, "bullet").value, "one\n- two\nthree");
  assert.equal(format("## heading", 3, 3, "paragraph").value, "heading");
  assert.equal(format("- [x] done", 0, 10, "h2").value, "## done");
  assert.equal(format("text", 0, 4, "task").value, "- [ ] text");
  assert.equal(format("text", 0, 4, "h3").value, "### text");
  assert.equal(format("text", 0, 4, "quote").value, "> text");
  assert.deepEqual(format("text", 1, 2, "unknown"), { value: "text", start: 1, end: 2 });
});
