"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events"), { pathToFileURL } = require("node:url");
const trust = require("../frontend/renderer_trust");
const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");

function windowFor(name) {
  const file = path.resolve("synthetic", name), wc = new EventEmitter();
  wc.mainFrame = { url: pathToFileURL(file).href }; wc.getURL = () => wc.mainFrame.url;
  wc.setWindowOpenHandler = () => {};
  const window = { isDestroyed: () => false, webContents: wc };
  trust.protectRenderer(window, file);
  return window;
}

for (const channel of ["get-startup-status", "get-hotkey", "resize-capture", "toggle-window"]) {
  test(`actual ${channel} handler denies foreign frames before side effects`, async () => {
    const handlers = new Map(), calls = [], quickWindow = windowFor("index.html");
    const context = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      quickWindow, startupWindow: windowFor("startup.html"), notesWindow: windowFor("notes.html"),
      isGenerationSender: trust.isTrustedSender, denyInvalidNotesSender: () => ({ ok: false, error: "forbidden" }),
      getStartupStatusPayload: () => { calls.push("status"); return { ok: true }; },
      desktopHotkey: { get: () => { calls.push("hotkey"); return "Ctrl+Shift+Space"; } },
      quickCapture: { resize: () => { calls.push("resize"); return { ok: true }; } }, toggleQuickWindow: () => calls.push("toggle") };
    const block = source.match(new RegExp(`ipcMain.handle\\("quick-note:${channel}"[\\s\\S]*?\\n}\\);`));
    assert.ok(block, `Missing handler ${channel}`);
    vm.runInNewContext(block[0], context);
    const handler = handlers.get(`quick-note:${channel}`), sender = quickWindow.webContents;
    assert.equal((await handler({ sender, senderFrame: { url: sender.mainFrame.url } }, 220)).error, "forbidden");
    assert.equal((await handler({ sender }, 220)).error, "forbidden");
    assert.deepEqual(calls, []);
    await handler({ sender, senderFrame: sender.mainFrame }, 220);
    assert.equal(calls.length, 1);
  });
}
