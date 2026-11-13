"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createHotkeyController } = require("../../frontend/desktop_hotkey");
function fixture() {
  const entries = new Map(); let toggles = 0;
  const controller = createHotkeyController({ initial: "Control+Shift+Space", toggle: () => toggles++,
    shortcuts: { register: (key, callback) => { if (entries.has(key)) return false; entries.set(key, callback); return true; }, unregister: key => entries.delete(key) } });
  return { controller, entries, toggles: () => toggles };
}
test("a shortcut is changed only after the settings transaction commits", () => {
  const f = fixture(); assert.equal(f.controller.register(), true);
  const change = f.controller.prepare("Control+Alt+N");
  f.entries.get("Control+Alt+N")(); assert.equal(f.toggles(), 0);
  f.entries.get("Control+Shift+Space")(); assert.equal(f.toggles(), 1);
  change.commit(); assert.equal(f.entries.has("Control+Shift+Space"), false);
  f.entries.get("Control+Alt+N")(); assert.equal(f.toggles(), 2);
  change.commit(); assert.equal(f.controller.get(), "Control+Alt+N");
});
test("failed persistence rolls back the reserved key and preserves the working shortcut", () => {
  const f = fixture(); f.controller.register();
  f.controller.prepare("Control+Alt+N").rollback();
  assert.equal(f.entries.has("Control+Alt+N"), false);
  assert.equal(f.controller.get(), "Control+Shift+Space");
  f.entries.get("Control+Shift+Space")(); assert.equal(f.toggles(), 1);
});
test("a busy shortcut cannot replace the old shortcut", () => {
  const f = fixture(); f.controller.register(); f.entries.set("Control+Alt+N", () => {});
  assert.throws(() => f.controller.prepare("Control+Alt+N"), { code: "hotkey_unavailable" });
  assert.equal(f.controller.get(), "Control+Shift+Space");
});
test("equivalent platform accelerators do not reserve a second shortcut or break the callback", () => {
  const registrations = []; let callback, toggles = 0;
  const controller = createHotkeyController({ initial: "CommandOrControl+Shift+Space", platform: "win32", toggle: () => toggles++,
    shortcuts: { register: (key, fn) => { registrations.push(key); callback = fn; return registrations.length === 1; }, unregister() {} } });
  controller.register(); controller.prepare("Shift+Control+Space").commit(); callback();
  assert.equal(registrations.length, 1); assert.equal(toggles, 1);
  assert.equal(controller.get(), "Shift+Control+Space");
});
