"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/notes_semantic_controls.js"), "utf8");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const nodes = new Map(), listeners = new Map(), calls = [];
  let owner = {}, subscriber, response = Promise.resolve({ ok: true });
  const doc = { activeElement: null, getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: id.endsWith("section") || id.startsWith("chat-"), disabled: false, textContent: "",
      addEventListener: (_type, fn) => listeners.set(id, fn),
      contains: element => element?.id === "settings-semantic-setup",
      focus() { doc.activeElement = this; } });
    return nodes.get(id);
  } };
  const win = { nodaI18n: { t: (_ru, en) => en },
    quickNoteBridge: { setupSemanticSearch: () => { calls.push("setup"); return response; } },
    NodaProjectContext: { snapshot: () => owner, isCurrent: value => value === owner,
      subscribe: fn => { subscriber = fn; return () => {}; } }, addEventListener: () => {} };
  vm.runInNewContext(source, { window: win, document: doc });
  return { get: doc.getElementById, doc, calls, update: win.notesSemanticControls.update,
    click: id => listeners.get(id)(), response: value => { response = value; },
    switchProject() { owner = {}; subscriber({ status: "switching" }); } };
}

test("semantic setup stays hidden during startup and after the model is ready", () => {
  const f = fixture();
  for (const state of [{}, { embedding_status: "ready", available: true }, { embedding_status: "ready", available: false }]) {
    f.update(state);
    assert.equal(f.get("settings-semantic-section").hidden, true);
  }
  assert.deepEqual(f.calls, []);
});

test("only disabled or unavailable embeddings expose the recovery card", () => {
  const f = fixture();
  for (const embedding_status of ["disabled", "unavailable"]) {
    f.update({ embedding_status });
    assert.equal(f.get("settings-semantic-section").hidden, false);
  }
  f.update({ embedding_status: "ready" });
  assert.equal(f.get("settings-semantic-section").hidden, true);
});

test("recovery cannot start from a hidden card and duplicate clicks are ignored", async () => {
  const f = fixture(), pending = deferred();
  await f.click("settings-semantic-setup");
  assert.equal(f.calls.length, 0);
  f.update({ embedding_status: "disabled" }); f.response(pending.promise);
  const first = f.click("settings-semantic-setup");
  await f.click("settings-semantic-setup");
  assert.equal(f.calls.length, 1);
  assert.equal(f.get("settings-semantic-setup").disabled, true);
  pending.resolve({ ok: true }); await first;
  assert.match(f.get("settings-semantic-status").textContent, /next time Noda starts/);
  assert.equal(f.get("settings-semantic-setup").disabled, false);
});

test("ready state restores focus and clears a pending setup message", async () => {
  const f = fixture(), pending = deferred();
  f.update({ embedding_status: "unavailable" }); f.response(pending.promise);
  f.get("settings-semantic-setup").focus();
  const request = f.click("settings-semantic-setup");
  f.update({ embedding_status: "ready" });
  pending.resolve({ ok: true }); await request;
  assert.equal(f.get("settings-semantic-section").hidden, true);
  assert.equal(f.doc.activeElement.id, "notes-settings-tab");
  assert.equal(f.get("settings-semantic-status").textContent, "");
});

test("a project change discards a stale setup result", async () => {
  const f = fixture(), pending = deferred();
  f.update({ embedding_status: "disabled" }); f.response(pending.promise);
  const request = f.click("settings-semantic-setup");
  f.switchProject(); f.update({ embedding_status: "disabled" });
  pending.resolve({ ok: true }); await request;
  assert.equal(f.get("settings-semantic-status").textContent, "");
});

test("setup failures retain useful feedback and permit retry", async () => {
  const f = fixture(); f.update({ embedding_status: "unavailable" });
  f.response(Promise.reject(new Error("synthetic setup failure")));
  await f.click("settings-semantic-setup");
  assert.equal(f.get("settings-semantic-status").textContent, "Could not set up semantic search.");
  assert.equal(f.get("settings-semantic-setup").disabled, false);
});
