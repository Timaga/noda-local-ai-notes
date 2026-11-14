"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), { pathToFileURL } = require("node:url"), { EventEmitter } = require("node:events");
const { protectRenderer, isTrustedRenderer, isTrustedSender } = require("../../frontend/renderer_trust");

function fixture() {
  const document = path.resolve("synthetic app/notes.html"), contents = new EventEmitter(), opened = [];
  const frame = { url: pathToFileURL(document).href };
  contents.mainFrame = frame; contents.getURL = () => frame.url;
  contents.setWindowOpenHandler = fn => { contents.open = fn; };
  const window = { webContents: contents, isDestroyed: () => false };
  protectRenderer(window, document, { openExternal: url => { opened.push(url); } });
  return { window, contents, frame, opened, event: { sender: contents, senderFrame: frame } };
}

test("only the registered local main document can call privileged IPC", () => {
  const f = fixture();
  assert.equal(isTrustedRenderer(f.event, f.window), true);
  f.frame.url += "?language=en#note";
  assert.equal(isTrustedRenderer(f.event, f.window), true);
  assert.equal(isTrustedSender(f.event, [null, f.window]), true);
  assert.equal(isTrustedRenderer({ sender: f.contents }, f.window), false);
  assert.equal(isTrustedRenderer({ ...f.event, sender: {} }, f.window), false);
  assert.equal(isTrustedRenderer({ ...f.event, senderFrame: { url: f.frame.url } }, f.window), false);
  assert.equal(isTrustedRenderer(f.event, { webContents: f.contents, isDestroyed: () => false }), false);
  f.window.isDestroyed = () => true;
  assert.equal(isTrustedRenderer(f.event, f.window), false);
});

for (const url of ["https://example.invalid/notes.html", "data:text/html,untrusted", "file:///other/notes.html", "not a URL"]) {
  test(`a same-window document replacement is rejected: ${url}`, () => {
    const f = fixture(); f.frame.url = url;
    assert.equal(isTrustedRenderer(f.event, f.window), false);
    assert.equal(isTrustedSender(f.event, [f.window]), false);
  });
}

test("disposed frame access fails closed", () => {
  const f = fixture(), event = { sender: f.contents, get senderFrame() { throw new Error("disposed"); } };
  assert.equal(isTrustedRenderer(event, f.window), false);
});

test("navigation, subframes and webviews cannot replace the trusted app document", () => {
  const f = fixture();
  for (const [name, params] of [["will-navigate", { url: "data:text/html,untrusted" }],
    ["will-frame-navigate", { isMainFrame: false, url: f.frame.url }], ["will-attach-webview", {}]]) {
    let prevented = false;
    f.contents.emit(name, { ...params, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, name);
  }
  let prevented = false;
  f.contents.emit("will-frame-navigate", { isMainFrame: true, url: f.frame.url, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test("web links open in the external browser and never create privileged windows", () => {
  const f = fixture();
  assert.deepEqual(f.contents.open({ url: "https://example.invalid/note" }), { action: "deny" });
  assert.deepEqual(f.opened, ["https://example.invalid/note"]);
  f.contents.open({ url: "mailto:tim@buglai.com" });
  assert.equal(f.opened[1], "mailto:tim@buglai.com");
});

for (const url of ["file:///C:/Windows/System32/cmd.exe", "data:text/html,untrusted", "javascript:alert(1)",
  "ms-settings:privacy", "https://user:password@example.invalid/", "mailto:tim@buglai.com?body=untrusted"]) {
  test(`unsafe external schemes or credentials remain blocked: ${url}`, () => {
    const f = fixture();
    assert.deepEqual(f.contents.open({ url }), { action: "deny" });
    assert.deepEqual(f.opened, []);
  });
}

test("a foreign document cannot use the external-link opener", () => {
  const f = fixture(); f.frame.url = "https://example.invalid/";
  f.contents.open({ url: "https://example.invalid/another" });
  assert.deepEqual(f.opened, []);
});
