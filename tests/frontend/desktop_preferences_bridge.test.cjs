"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { registerPreferencesBridge } = require("../../frontend/desktop_preferences_bridge");
function fixture() {
  const handlers = {}, calls = []; let busy = false, confirmed = true;
  registerPreferencesBridge({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    allowed: event => event === "notes", getPreferences: () => ({ editorFontSize: 18 }),
    busy: () => busy, confirmRestart: async () => confirmed, flushDrafts: async () => calls.push("flush"),
    app: { relaunch: () => calls.push("relaunch") }, restart: () => calls.push("quit"),
    scheduleSearch: async () => { calls.push("search"); return { ok: true }; }, deny: () => ({ ok: false, code: "forbidden" }) });
  return { call: (name, event = "notes") => handlers[`quick-note:${name}`](event), calls,
    busy: value => { busy = value; }, confirm: value => { confirmed = value; } };
}
test("only the notes window may invoke preferences operations", async () => {
  const f = fixture(); for (const name of ["get-preferences", "restart-for-settings", "setup-semantic-search"]) {
    assert.deepEqual(await f.call(name, "untrusted"), { ok: false, code: "forbidden" });
  } assert.deepEqual(f.calls, []);
});
test("restart flushes drafts first and requires confirmation without busy work", async () => {
  const f = fixture(); f.busy(true); assert.equal((await f.call("restart-for-settings")).code, "busy");
  f.busy(false); f.confirm(false); assert.equal((await f.call("restart-for-settings")).canceled, true);
  f.confirm(true); assert.equal((await f.call("restart-for-settings")).ok, true);
  assert.deepEqual(f.calls, ["flush", "relaunch", "quit"]);
});
test("semantic search setup cannot interrupt a running settings operation", async () => {
  const f = fixture(); f.busy(true); assert.equal((await f.call("setup-semantic-search")).code, "busy");
  f.busy(false); assert.equal((await f.call("setup-semantic-search")).ok, true);
});
test("the actual restart dialog respects cancel and checks busy work again after confirmation", async () => {
  const handlers = {}, calls = []; let answer = 1, busy = false, becomeBusy = false;
  registerPreferencesBridge({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, allowed: () => true,
    getPreferences: () => ({}), busy: () => busy, appName: "Noda", uiText: (_ru, en) => en,
    dialog: { showMessageBox: async options => {
      assert.deepEqual(options.buttons, ["Restart", "Cancel"]); assert.equal(options.cancelId, 1);
      busy = becomeBusy; return { response: answer };
    } }, flushDrafts: async () => calls.push("flush"), app: { relaunch: () => calls.push("relaunch") }, restart: () => calls.push("quit") });
  const restart = handlers["quick-note:restart-for-settings"];
  assert.equal((await restart()).canceled, true); assert.deepEqual(calls, []);
  answer = 0; becomeBusy = true; assert.equal((await restart()).code, "busy"); assert.deepEqual(calls, []);
  busy = false; becomeBusy = false; assert.equal((await restart()).ok, true); assert.deepEqual(calls, ["flush", "relaunch", "quit"]);
});
test("draft flush failure cannot relaunch or quit the application", async () => {
  const handlers = {}, calls = [];
  registerPreferencesBridge({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, allowed: () => true,
    busy: () => false, confirmRestart: async () => true, flushDrafts: async () => { throw new Error("synthetic storage failure"); },
    app: { relaunch: () => calls.push("relaunch") }, restart: () => calls.push("quit") });
  await assert.rejects(handlers["quick-note:restart-for-settings"](), /storage failure/); assert.deepEqual(calls, []);
});
