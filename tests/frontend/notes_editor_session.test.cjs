"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../../frontend/notes_editor_session");
const { createDrafts } = require("../../frontend/notes_library_tools");
const A = "a".repeat(32), B = "b".repeat(32), R1 = "1".repeat(64), R2 = "2".repeat(64);
const detail = (body = "original", revision = R1) => ({ editable_body: body, edit_revision: revision, title: "note", tags: [], vault_id: A });
function fixture() {
  let project = A, epoch = 1, server = detail(), handler, readHandler, timer, timerDelay;
  const calls = [], changes = [], saved = [], busy = [], memory = new Map();
  const drafts = createDrafts(() => ({ getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) }));
  const session = create({ context: { snapshot: () => ({ project, epoch }), isCurrent: bound => bound.project === project && bound.epoch === epoch },
    drafts, getProject: () => project, getVault: () => project,
    request: async (url, options) => { calls.push({ url, ...JSON.parse(options.body) });
      if (handler) return handler(options);
      server = detail(JSON.parse(options.body).content, R2); return { title: "note", cache_updated: true }; },
    readDetail: async (...args) => readHandler ? readHandler(...args) : server, onChange: value => changes.push(value), onSaved: value => saved.push(value), onBusy: value => busy.push(value),
    timers: { setTimeout: (fn, ms) => { timer = fn; timerDelay = ms; return fn; }, clearTimeout: () => { timer = null; } } });
  return { session, calls, changes, saved, busy, drafts, fire: () => timer?.(),
    setHandler: value => { handler = value; }, setServer: value => { server = value; }, setReadHandler: value => { readHandler = value; }, timerDelay: () => timerDelay,
    switchProject: () => { project = B; epoch += 1; } };
}

test("returning to a note during its write keeps that operation and the newest input", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("first"); const pending = f.session.flush();
  f.session.open("other", detail()); f.session.open("note", detail()); f.session.input("newest");
  f.setServer(detail("first", R2)); release({ title: "note" }); await pending;
  assert.equal(f.session.getState().content, "newest");
  assert.equal(f.session.getState().revision, R2);
  assert.equal(f.calls.length, 1); f.session.close();
});

test("simultaneous flush triggers serialize and never submit the same revision twice", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("first"); const one = f.session.flush();
  f.session.input("next"); const two = f.session.flush(), three = f.session.flush();
  f.setServer(detail("first", R2)); f.setHandler(null); release({ title: "note" });
  await Promise.all([one, two, three]);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].revision, R2);
  assert.equal(f.session.getState().content, "next"); assert.equal(f.session.isDirty(), false); f.session.close();
});
test("opening does not rewrite a file, typing saves source and the current revision", async () => {
  const f = fixture(); f.session.open("note", detail());
  assert.equal(f.calls.length, 0);
  f.session.input("  first\r\n\r\nnext  ");
  assert.equal(f.drafts.read(A, "note").content, "  first\n\nnext  ");
  await f.session.flush();
  assert.deepEqual(f.calls, [{ url: `/note-detail/note?expected_vault_id=${A}`, content: "  first\n\nnext  ", revision: R1 }]);
  assert.equal(f.session.getState().status, "saved");
  assert.equal(f.session.getState().revision, R2);
  assert.equal(f.drafts.read(A, "note"), null);
});
test("typing during a save stays editable and the next save uses the confirmed revision", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("first");
  const first = f.session.flush(); f.session.input("second");
  assert.equal(f.session.getState().content, "second");
  f.setServer(detail("first", R2)); release({ title: "note", cache_updated: true }); await first;
  assert.equal(f.session.getState().status, "draft");
  assert.equal(f.drafts.read(A, "note").revision, R2);
  f.setHandler(null); await f.session.flush();
  assert.equal(f.calls[1].revision, R2);
  assert.equal(f.calls[1].content, "second");
});
test("a disk conflict preserves the draft and never retries automatically", async () => {
  const f = fixture(); f.setHandler(() => { throw Object.assign(new Error("changed"), { code: "note_edit_conflict" }); });
  f.session.open("note", detail()); f.session.input("local"); await f.session.flush();
  f.session.input("local revised"); f.fire(); await f.session.retry();
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.getState().status, "conflict");
  assert.equal(f.drafts.read(A, "note").content, "local revised");
});
test("navigation restores per-note drafts without leaking them to a new project", () => {
  const f = fixture(); f.session.open("note", detail()); f.session.input("local");
  f.session.open("other", detail("other")); assert.equal(f.session.getState().content, "other");
  f.session.open("note", detail()); assert.equal(f.session.getState().content, "local");
  f.switchProject(); f.session.close(); f.session.open("note", detail("project B"));
  assert.equal(f.session.getState().content, "project B");
  assert.equal(f.drafts.read(A, "note").content, "local");
});
test("a delayed response after switching projects does not repaint the new editor", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("A draft"); const pending = f.session.flush();
  f.switchProject(); f.session.open("note", detail("B body"));
  release({ title: "note", cache_updated: true }); await pending;
  assert.equal(f.session.getState().content, "B body"); assert.equal(f.saved.length, 0);
  assert.equal(f.drafts.read(A, "note").content, "A draft");
});
test("reverting while a write is pending still leaves a durable recovery draft", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("changed"); const pending = f.session.flush();
  f.session.input("original"); assert.equal(f.drafts.read(A, "note").content, "original");
  f.setServer(detail("changed", R2)); release({ title: "note", cache_updated: true }); await pending;
  assert.equal(f.session.getState().dirty, true);
  assert.equal(f.drafts.read(A, "note").content, "original");
});
test("a timed out committed write is reconciled before retry and not duplicated", async () => {
  const f = fixture(); f.setHandler(() => { f.setServer(detail("changed", R2)); throw new Error("timeout"); });
  f.session.open("note", detail()); f.session.input("changed"); await f.session.flush();
  assert.equal(f.session.getState().status, "error");
  await f.session.retry(); assert.equal(f.calls.length, 1);
  assert.equal(f.session.getState().status, "saved");
});
test("external changes during a failed write cannot be overwritten by retry", async () => {
  const f = fixture(); f.setHandler(() => { throw new Error("offline"); });
  f.session.open("note", detail()); f.session.input("local"); await f.session.flush();
  f.setServer(detail("external", R2)); await f.session.retry();
  assert.equal(f.calls.length, 1); assert.equal(f.session.getState().status, "conflict");
});
test("a restored stale draft is shown as a conflict without a write", async () => {
  const f = fixture(); f.drafts.write(A, "note", { title: "note", tags: "", content: "draft", revision: R1 });
  f.session.open("note", detail("external", R2)); f.fire(); await f.session.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.session.getState().content, "draft");
  assert.equal(f.session.getState().status, "conflict");
});

test("a restored draft already matching the file adopts its fresh revision before the next edit", async () => {
  const f = fixture();
  f.drafts.write(A, "note", { title: "note", tags: "", content: "already saved\r\n", revision: R1 });
  f.session.open("note", detail("already saved\n", R2));
  assert.equal(f.session.getState().status, "saved");
  assert.equal(f.session.getState().revision, R2); assert.equal(f.drafts.read(A, "note"), null);
  assert.equal(f.calls.length, 0);
  f.session.input("next edit"); await f.session.flush();
  assert.equal(f.calls[0].revision, R2); assert.equal(f.calls[0].content, "next edit");
  assert.equal(f.session.getState().status, "saved");
});
test("unmanaged notes are read-only and IME composition never triggers an intermediate write", async () => {
  const f = fixture(); f.session.open("unmanaged", { content: "read only" });
  f.session.input("forbidden"); await f.session.flush(); assert.equal(f.calls.length, 0);
  f.session.open("note", detail()); f.session.composition(true); f.session.input("日本語");
  await f.session.flush(); assert.equal(f.calls.length, 0);
  f.session.composition(false); await f.session.flush(); assert.equal(f.calls[0].content, "日本語");
});

test("disabled autosave keeps drafts on typing and blur while manual save still works", async () => {
  const f = fixture(); f.session.open("note", detail());
  assert.equal(f.session.configure({ editorAutoSave: false, editorAutoSaveDelayMs: 3000 }), true);
  f.session.input("manual draft"); f.fire();
  assert.equal(await f.session.autoSave(), false);
  assert.equal(f.calls.length, 0); assert.equal(f.drafts.read(A, "note").content, "manual draft");
  assert.equal(f.session.getState().autoSaveEnabled, false);
  await f.session.flush(); assert.equal(f.calls[0].content, "manual draft");
  assert.equal(f.session.isDirty(), false);
});

test("changing delay reschedules an existing draft and invalid preferences cannot silently change it", () => {
  const f = fixture(); f.session.open("note", detail()); f.session.input("draft");
  assert.equal(f.session.configure({ editorAutoSaveDelayMs: 2500 }), true); assert.equal(f.timerDelay(), 2500);
  for (const invalid of [{ editorAutoSave: "false" }, { editorAutoSaveDelayMs: 0 }, { editorAutoSaveDelayMs: 499 }, { editorAutoSaveDelayMs: 10001 }, { editorAutoSaveDelayMs: 1.5 }]) {
    assert.equal(f.session.configure(invalid), false);
    assert.equal(f.session.getState().autoSaveEnabled, true); assert.equal(f.session.getState().autoSaveDelayMs, 2500);
  }
  f.session.close();
});

test("discard reload clears a stale draft only after a valid fresh file is received", async () => {
  const f = fixture(); f.drafts.write(A, "note", { title: "note", content: "my draft", tags: "", revision: R1 });
  f.session.open("note", detail("external", R2));
  let release; f.setReadHandler(() => new Promise(resolve => { release = resolve; }));
  const reload = f.session.reloadFromDisk();
  assert.equal(f.session.getState().reloading, true); assert.equal(f.session.isDirty(), true);
  assert.equal(f.drafts.read(A, "note").content, "my draft");
  f.session.input("cannot change during explicit discard");
  assert.equal(f.session.getState().content, "my draft");
  release(detail("external", R2)); assert.equal(await reload, true);
  assert.equal(f.session.getState().content, "external"); assert.equal(f.session.getState().blocked, false);
  assert.equal(f.session.getState().revision, R2); assert.equal(f.drafts.read(A, "note"), null);
  f.session.close(); f.session.open("note", detail("external", R2));
  assert.equal(f.session.getState().status, "saved"); assert.equal(f.calls.length, 0);
});

test("failed or invalid reload preserves recoverable text and the old revision", async () => {
  const f = fixture(); f.session.open("note", detail()); f.session.input("my draft");
  f.setReadHandler(() => { throw new Error("offline"); });
  assert.equal(await f.session.reloadFromDisk(), false);
  assert.equal(f.session.getState().reloadError, true); assert.equal(f.session.getState().reloading, false);
  assert.equal(f.session.getState().content, "my draft"); assert.equal(f.drafts.read(A, "note").revision, R1);
  for (const invalid of [{ editable_body: "unsafe", edit_revision: "bad" }, { edit_revision: R2 }]) {
    f.setReadHandler(() => invalid); assert.equal(await f.session.reloadFromDisk(), false);
    assert.equal(f.drafts.read(A, "note").content, "my draft");
  }
  f.session.close(); assert.equal(await f.session.reloadFromDisk(), false);
});

test("a late reload cannot erase a draft after note or project navigation", async () => {
  for (const switchProject of [false, true]) {
    const f = fixture(); let release;
    f.session.open("note", detail()); f.session.input("my draft");
    f.setReadHandler(() => new Promise(resolve => { release = resolve; }));
    const reload = f.session.reloadFromDisk();
    if (switchProject) f.switchProject();
    f.session.open("other", detail("new view")); release(detail("external", R2));
    assert.equal(await reload, false); assert.equal(f.session.getState().content, "new view");
    assert.equal(f.drafts.read(A, "note").content, "my draft"); assert.equal(f.saved.length, 0);
    f.session.close();
  }
});

test("reload waits for an admitted save before reading the file and never issues another write", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("written"); const write = f.session.flush();
  const reload = f.session.reloadFromDisk(); assert.equal(await f.session.reloadFromDisk(), false);
  f.setServer(detail("written", R2)); release({ title: "note" }); await write;
  assert.equal(await reload, true); assert.equal(f.session.getState().status, "saved");
  assert.equal(f.calls.length, 1); assert.equal(f.drafts.read(A, "note"), null);
});

test("an older waiting flush cannot publish after explicit reload locks the editor", async () => {
  const f = fixture(); let release;
  f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.session.open("note", detail()); f.session.input("first"); const write = f.session.flush();
  f.session.input("second"); const waiting = f.session.flush(), reload = f.session.reloadFromDisk();
  f.setServer(detail("first", R2)); f.setHandler(null); release({ title: "note" });
  await write; assert.equal(await waiting, false); assert.equal(await reload, true);
  assert.equal(f.calls.length, 1); assert.equal(f.session.getState().content, "first");
});
