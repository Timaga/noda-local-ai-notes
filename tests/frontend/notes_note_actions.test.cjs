"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { create } = require("../../frontend/notes_note_actions");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(extra = {}) {
  let epoch = 1, active = true;
  const calls = [], requests = [], copied = [];
  const state = { creatingNote: false, selectedNoteTitle: "Проект / A", selectedNoteDetail: { content: "Исходный текст" } };
  const input = (value, name) => ({ value, focus: () => calls.push(["focus", name]) });
  const inputs = { title: input("  Новая заметка  ", "title"), content: input("  Исходный текст  ", "content"),
    tags: input("работа;сроки, план\nидея", "tags"), save: { disabled: false }, delete: { disabled: false } };
  const controls = Object.fromEntries(["created", "status", "editor", "moved"].map(name =>
    [name, (...args) => calls.push([name, ...args])]));
  controls.refresh = async () => { calls.push(["refresh"]); return extra.refresh?.(); };
  controls.select = async title => { calls.push(["select", title]); return extra.select?.(title); };
  const options = {
    context: { snapshot: () => epoch, isCurrent: value => active && value === epoch },
    request: async (...args) => { requests.push(args); return extra.request ? extra.request(...args) : { note: { title: "Название от сервера", id: "synthetic-1" } }; },
    getState: () => state, inputs, controls, text: ru => ru,
    clipboard: { writeText: async source => { copied.push(source); return extra.writeText?.(source); } },
    confirm: prompt => { calls.push(["confirm", prompt]); return extra.confirm ?? true; },
    ...extra.options,
  };
  return { actions: create(options), calls, requests, copied, state, inputs,
    invalidate: () => { epoch += 1; }, deactivate: () => { active = false; } };
}

test("create validates missing title and content before requesting, and focuses the missing field", async () => {
  for (const field of ["title", "content"]) {
    const f = fixture(); f.inputs[field].value = " \n ";
    await f.actions.createNote();
    assert.equal(f.requests.length, 0); assert.equal(f.inputs.save.disabled, false);
    assert.equal(f.calls[0][0], "status"); assert.equal(f.calls[0][1], "warn");
    assert.deepEqual(f.calls[1], ["focus", field]);
  }
});

test("create preserves entered content, splits existing tags, refreshes and selects server title", async () => {
  const f = fixture(), content = "    первая строка кода\n    вторая строка\n\nСтрока с переносом  \nследующая строка\n";
  f.inputs.content.value = content;
  await f.actions.createNote();
  const [url, init] = f.requests[0]; assert.equal(url, "/notes"); assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(init.body), { title: "Новая заметка", content, tags: ["работа", "сроки", "план", "идея"] });
  assert.deepEqual(f.calls[0], ["created", { title: "Название от сервера", id: "synthetic-1", content }]);
  assert.deepEqual(f.calls.map(call => call[0]), ["created", "status", "refresh", "select", "editor"]);
  assert.deepEqual(f.calls[3], ["select", "Название от сервера"]);
  assert.deepEqual(f.calls[4], ["editor", false]); assert.equal(f.inputs.save.disabled, false);
});

test("create uses entered title when server omits note and accepts an empty tag list", async () => {
  const f = fixture({ request: async () => ({}) }); f.inputs.tags.value = " ,; \n";
  await f.actions.createNote(); assert.deepEqual(JSON.parse(f.requests[0][1].body).tags, []);
  assert.deepEqual(f.calls[0], ["created", { title: "Новая заметка", content: f.inputs.content.value }]);
  assert.deepEqual(f.calls[3], ["select", "Новая заметка"]);
});

test("active create request failure is propagated and the current editor is restored", async () => {
  const error = new Error("synthetic request failure"), f = fixture({ request: async () => { throw error; } });
  f.state.creatingNote = true; await assert.rejects(f.actions.createNote(), candidate => candidate === error);
  assert.deepEqual(f.calls, [["editor", true]]); assert.equal(f.inputs.save.disabled, false);
});

test("late create responses and failures cannot write into another project or reset its editor", async () => {
  for (const fails of [false, true]) {
    const pending = deferred(), f = fixture({ request: () => pending.promise });
    const work = f.actions.createNote(); assert.equal(f.inputs.save.disabled, true); f.invalidate();
    if (fails) pending.reject(new Error("old project request")); else pending.resolve({ note: { title: "Старый проект" } });
    await work; assert.deepEqual(f.calls, []); assert.equal(f.inputs.save.disabled, true);
  }
});

test("create refresh or selection failures warn that the note remains saved", async () => {
  for (const phase of ["refresh", "select"]) {
    const f = fixture({ [phase]: async () => { throw new Error("synthetic reload failure"); } });
    await f.actions.createNote();
    const warning = f.calls.find(call => call[0] === "status" && call[1] === "warn");
    assert.match(warning[2], /Заметка сохранена: Название от сервера/);
    assert.equal(f.calls.filter(call => call[0] === "created").length, 1); assert.equal(f.inputs.save.disabled, false);
  }
});

test("project changes during create refresh or selection suppress later selection, warning and finally effects", async () => {
  for (const phase of ["refresh", "select"]) for (const fails of [false, true]) {
    const pending = deferred(), reached = deferred(), f = fixture({ [phase]: () => { reached.resolve(); return pending.promise; } });
    const work = f.actions.createNote(); await reached.promise;
    const snapshot = [...f.calls]; assert.ok(snapshot.some(call => call[0] === phase)); f.invalidate();
    if (fails) pending.reject(new Error("old project refresh")); else pending.resolve();
    await work;
    assert.deepEqual(f.calls, snapshot); assert.equal(f.inputs.save.disabled, true);
  }
});

test("inactive operations do not read, request, prompt, copy or change controls", async () => {
  const f = fixture(); f.deactivate();
  await f.actions.createNote(); await f.actions.deleteNote(); await f.actions.copyNote();
  assert.deepEqual([f.calls, f.requests, f.copied], [[], [], []]);
});

test("delete requires a selected title and explicit confirmation", async () => {
  const missing = fixture(); missing.state.selectedNoteTitle = ""; await missing.actions.deleteNote();
  assert.deepEqual(missing.calls, []); assert.deepEqual(missing.requests, []);
  const cancelled = fixture({ confirm: false }); await cancelled.actions.deleteNote();
  assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.calls[0][0], "confirm");
  assert.deepEqual(cancelled.requests, []); assert.equal(cancelled.inputs.delete.disabled, false);
});

test("canceling trash never prepares or writes the note body", async () => {
  let prepared = 0;
  const f = fixture({ confirm: false, options: { beforeDelete: async () => { prepared++; return true; } } });
  await f.actions.deleteNote();
  assert.equal(prepared, 0); assert.deepEqual(f.requests, []);
});

test("trash waits for confirmed preparation and preserves unsaved changes on refusal", async () => {
  const pending = deferred(), reached = deferred();
  const f = fixture({ options: { beforeDelete: async () => { reached.resolve(); return pending.promise; } } });
  const work = f.actions.deleteNote(); await reached.promise;
  assert.equal(f.calls[0][0], "confirm"); assert.deepEqual(f.requests, []);
  pending.resolve(false); await work;
  assert.deepEqual(f.requests, []); assert.equal(f.state.selectedNoteTitle, "Проект / A");
  assert.equal(f.calls.at(-1)[0], "editor");
});

test("trash cannot delete a note when preparation changes project or selection", async () => {
  for (const mode of ["project", "selection"]) {
    let f;
    f = fixture({ options: { beforeDelete: async () => {
      if (mode === "project") f.invalidate(); else f.state.selectedNoteTitle = "Another note";
      return true;
    } } });
    await f.actions.deleteNote(); assert.deepEqual(f.requests, []);
    assert.equal(f.calls.some(([name]) => name === "moved"), false);
  }
});

test("failed trash preparation reports failure without deleting the note", async () => {
  const error = new Error("synthetic preparation error");
  const f = fixture({ options: { beforeDelete: async () => { throw error; } } });
  await assert.rejects(f.actions.deleteNote(), value => value === error);
  assert.deepEqual(f.requests, []); assert.equal(f.calls.at(-1)[0], "editor");
});

test("delete encodes the title, clears the removed selection and reports reversible trash", async () => {
  const f = fixture({ request: async () => ({ deleted: { qdrant_deleted: true } }) }); await f.actions.deleteNote();
  assert.deepEqual(f.requests, [[`/note-detail/${encodeURIComponent("Проект / A")}`, { method: "DELETE" }]]);
  assert.deepEqual(f.calls.map(call => call[0]), ["confirm", "moved", "refresh", "status", "editor"]);
  assert.equal(f.calls[3][1], "ok"); assert.match(f.calls[3][2], /Заметка в корзине: Проект \/ A/);
});

test("failed move preserves selection while failed refresh warns that the note is already in trash", async () => {
  const error = new Error("synthetic delete failure"), rejected = fixture({ request: async () => { throw error; } });
  await assert.rejects(rejected.actions.deleteNote(), candidate => candidate === error);
  assert.deepEqual(rejected.calls.map(call => call[0]), ["confirm", "editor"]);
  const moved = fixture({ refresh: async () => { throw error; } });
  await moved.actions.deleteNote();
  assert.deepEqual(moved.calls.map(call => call[0]), ["confirm", "moved", "refresh", "status", "editor"]);
  assert.equal(moved.calls.at(-2)[1], "warn");
  assert.match(moved.calls.at(-2)[2], /Заметка в корзине/);
});

test("late delete request and refresh results cannot mutate another project", async () => {
  for (const phase of ["request", "refresh"]) for (const fails of [false, true]) {
    const pending = deferred(), reached = deferred(), f = fixture({ [phase]: () => { reached.resolve(); return pending.promise; } });
    const work = f.actions.deleteNote(); await reached.promise;
    const snapshot = [...f.calls]; f.invalidate();
    if (fails) pending.reject(new Error("old project delete")); else pending.resolve({});
    await work; assert.deepEqual(f.calls, snapshot); assert.equal(f.inputs.delete.disabled, true);
  }
});

test("copy uses parsed source rather than metadata wrapper and raw text when parser is absent", async () => {
  const wrapper = "---\ntitle: synthetic\n---\nИсходный текст";
  const f = fixture({ options: { presentation: value => { assert.equal(value, wrapper); return { source: "Исходный текст" }; } } });
  f.state.selectedNoteDetail.content = wrapper; await f.actions.copyNote();
  assert.deepEqual(f.copied, ["Исходный текст"]); assert.equal(f.calls[0][1], "ok");
  const raw = fixture(); await raw.actions.copyNote(); assert.deepEqual(raw.copied, ["Исходный текст"]);
});

test("copy handles missing detail, empty raw content and authoritative empty parsed source", async () => {
  const missing = fixture(); missing.state.selectedNoteDetail = null; await missing.actions.copyNote(); assert.deepEqual(missing.calls, []);
  for (const content of ["", undefined]) {
    const f = fixture(); f.state.selectedNoteDetail = { content }; await f.actions.copyNote();
    assert.deepEqual(f.copied, []); assert.equal(f.calls[0][1], "warn");
  }
  const f = fixture({ options: { presentation: () => ({ source: "" }) } }); await f.actions.copyNote();
  assert.deepEqual(f.copied, []); assert.equal(f.calls[0][1], "warn");
});

test("clipboard unavailable or failed yields a safe active error", async () => {
  for (const clipboard of [null, {}]) {
    const f = fixture({ options: { clipboard } }); await f.actions.copyNote();
    assert.equal(f.calls[0][1], "error"); assert.match(f.calls[0][2], /Буфер обмена недоступен/);
  }
  const f = fixture({ writeText: async () => { throw new Error("synthetic clipboard failure"); } });
  await f.actions.copyNote(); assert.equal(f.calls[0][1], "error"); assert.match(f.calls[0][2], /Не удалось скопировать/);
});

test("clipboard completion or failure after project change cannot overwrite the new project status", async () => {
  for (const fails of [false, true]) {
    const pending = deferred(), f = fixture({ writeText: () => pending.promise });
    const work = f.actions.copyNote(); f.invalidate();
    if (fails) pending.reject(new Error("old clipboard request")); else pending.resolve();
    await work; assert.deepEqual(f.copied, ["Исходный текст"]); assert.deepEqual(f.calls, []);
  }
});

test("browser entry exposes the same action factory without requiring Node APIs", () => {
  const browser = { window: {} };
  const filename = require.resolve("../../frontend/notes_note_actions");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), browser, { filename });
  assert.equal(typeof browser.window.NotesNoteActions.create, "function");
});
