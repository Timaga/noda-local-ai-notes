"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDrafts, createSearch } = require("../../frontend/notes_library_tools");

test("drafts survive another renderer and are isolated by project and note identity", () => {
  const storage = new Map();
  const open = () => createDrafts(() => ({ getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key) }));
  const original = { title: "Title", tags: "example", content: "unsaved\nnew line", revision: "a".repeat(64) };
  assert.ok(open().write("project-a", "title-a", original));
  assert.deepEqual(open().read("project-a", "title-a"), original);
  assert.equal(open().read("project-b", "title-a"), null);
  assert.equal(open().read("project-a", "title-b"), null);
  assert.ok(open().write("project-a", "title-a", null));
  assert.equal(open().read("project-a", "title-a"), null);
});

test("an unavailable draft store keeps text in memory and reports temporary retention", () => {
  const drafts = createDrafts(() => { throw new Error("storage unavailable"); });
  const draft = { title: "Synthetic", tags: "", content: "source", revision: null };
  assert.equal(drafts.write("project-a", null, draft), false);
  assert.equal(drafts.isDurable("project-a", null), false);
  assert.deepEqual(drafts.read("project-a", null), draft);
  assert.equal(drafts.write("project-a", null, null), false);
  assert.equal(drafts.read("project-a", null), null);
});

test("search ignores prior query and project results and distinguishes failure from no matches", async () => {
  let current = "project-a";
  let sent;
  const states = [];
  const search = createSearch({ delay: 0, getVault: () => current, isCurrent: context => context === current,
    request: path => new Promise((resolve, reject) => sent({ path, resolve, reject })),
    onChange: () => states.push(search.getState().type) });
  const start = value => new Promise(resolve => { sent = resolve; search.search(value, current); });
  const first = await start("  первая  ");
  assert.match(first.path, /expected_vault_id=project-a/);
  const second = await start("second");
  first.resolve({ titles: ["obsolete"], vault_id: current });
  second.resolve({ titles: [], vault_id: current }); await Promise.resolve();
  assert.deepEqual(search.getState(), { type: "ready", titles: new Set() });
  const third = await start("third");
  third.reject(new Error("network unavailable")); await Promise.resolve();
  assert.equal(search.getState().type, "error");
  const oldProject = await start("old-project");
  current = "project-b"; search.reset();
  oldProject.resolve({ titles: ["forbidden"], vault_id: "project-a" }); await Promise.resolve();
  assert.equal(search.getState().type, "idle");
  assert.deepEqual(states, ["loading", "loading", "ready", "loading", "error", "loading"]);
});

test("refreshing the same query keeps the existing rows during the request", async () => {
  let sent;
  const search = createSearch({ delay: 0, getVault: () => "vault-a", isCurrent: () => true, onChange: () => {},
    request: () => new Promise((resolve, reject) => sent({ resolve, reject })) });
  const start = () => new Promise(resolve => { sent = resolve; search.search("original", "vault-a", true); });
  const first = await start();
  first.resolve({ titles: ["one"], vault_id: "vault-a" }); await Promise.resolve();
  const second = start();
  assert.deepEqual(search.getState(), { type: "ready", titles: new Set(["one"]) });
  (await second).resolve({ titles: ["one", "two"], vault_id: "vault-a" }); await Promise.resolve();
  assert.deepEqual(search.getState(), { type: "ready", titles: new Set(["one", "two"]) });
  (await start()).reject(new Error("offline")); await Promise.resolve();
  assert.deepEqual(search.getState(), { type: "error", titles: new Set(["one", "two"]) });
});
