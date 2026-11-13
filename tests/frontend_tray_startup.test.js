"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { ensureTray } = require("../frontend/tray_controller");

function fixture() {
  const calls = [];
  let ready = false;
  let english = false;
  const options = {
    Tray: class {
      constructor(icon) { calls.push(["icon", icon]); this.handlers = {}; }
      on(name, handler) { this.handlers[name] = handler; calls.push(["event", name]); }
      setToolTip(value) { this.tooltip = value; }
      setContextMenu(menu) { this.menu = menu; }
    },
    Menu: { buildFromTemplate: template => template },
    createTrayIcon: () => "local-icon",
    appName: "Noda",
    uiText: (ru, en) => english ? en : ru,
    isReady: () => ready,
    showStartupWindow: () => calls.push("startup"),
    showQuickWindow: () => calls.push("quick"),
    showNotesWindow: () => calls.push("notes"),
    toggleQuickWindow: () => calls.push("toggle"),
    ensureBackendReady: async () => calls.push("backend"),
    requestAppQuit: () => calls.push("quit"),
    onBackendError: error => calls.push(error),
  };
  return { options, calls, setReady: value => { ready = value; }, setEnglish: () => { english = true; } };
}

test("startup tray opens setup from its icon and menu without creating notes or services", async () => {
  const f = fixture();
  const tray = ensureTray(f.options);
  assert.equal(tray.tooltip, "Noda");
  assert.deepEqual(f.calls, [["icon", "local-icon"], ["event", "click"]]);
  tray.handlers.click();
  for (const item of tray.menu.slice(0, 3)) await item.click();
  assert.deepEqual(f.calls.slice(2), ["startup", "startup", "startup", "startup"]);
  tray.menu[4].click();
  assert.equal(f.calls.at(-1), "quit");
});

test("readiness is checked when actions run and localization reuses the same tray", async () => {
  const f = fixture();
  const tray = ensureTray(f.options);
  const originalClick = tray.handlers.click;
  f.setEnglish();
  assert.equal(ensureTray({ ...f.options, tray }), tray);
  assert.equal(tray.handlers.click, originalClick);
  assert.deepEqual(tray.menu.filter(item => item.label).map(item => item.label),
    ["Quick note…", "Notes panel", "Start local services", "Quit"]);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "icon").length, 1);
  f.setReady(true);
  tray.handlers.click();
  for (const item of tray.menu.slice(0, 3)) await item.click();
  assert.deepEqual(f.calls.slice(2), ["toggle", "quick", "notes", "backend"]);
  f.setReady(false);
  tray.menu[0].click();
  assert.equal(f.calls.at(-1), "startup");
});

test("service failure reaches the existing error handler", async () => {
  const f = fixture();
  const failure = new Error("Synthetic service failure");
  f.options.ensureBackendReady = async () => { throw failure; };
  f.setReady(true);
  const tray = ensureTray(f.options);
  await tray.menu[2].click();
  assert.equal(f.calls.at(-1), failure);
});

test("actual main creates the tray before displaying or waiting for startup", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
  const begin = source.indexOf("if (HAS_SINGLE_INSTANCE_LOCK) app.whenReady().then(");
  const end = source.indexOf('app.on("second-instance"', begin);
  assert.ok(begin >= 0 && end > begin);
  const calls = [];
  let onReady;
  const context = vm.createContext({
    HAS_SINGLE_INSTANCE_LOCK: true,
    app: { whenReady: () => ({ then: callback => { onReady = callback; } }) },
    createTray: () => calls.push("tray"),
    showStartupWindow: () => calls.push("startup"),
    ensureBackendReady: () => { calls.push("readiness"); return new Promise(() => {}); },
    AUTO_QUIT_AFTER_READY_MS: 0,
  });
  vm.runInContext(source.slice(begin, end), context);
  onReady();
  assert.deepEqual(calls, ["tray", "startup", "readiness"]);
});
