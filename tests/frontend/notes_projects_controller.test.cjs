"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../../frontend/notes_projects_controller");
const A = "a".repeat(32), B = "b".repeat(32), T = "1".repeat(32);
const project = id => ({ id, name: id === A ? "Alpha" : "Beta", notesDirectory: `F:/synthetic/${id}`, noteCount: null });
function snapshot(id = A, epoch = 1, status = "ready") {
  return { projectId: id, contextToken: T, epoch, status,
    projectState: { mode: "projects", projects: [project(A), project(B)], activeProjectId: id,
      activeProject: id ? project(id) : null, status, pendingProjectId: status === "switching" ? B : null } };
}
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fixture(initial = snapshot(), text = ru => ru) {
  const elements = new Map(), listeners = new Set(), calls = [], renders = [], reports = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, value: "", textContent: "", scrollTop: 0, scrollLeft: 0,
      style: {}, events: new Map(), classList: { remove() {} }, parentElement: { classList: { remove() {} } },
      addEventListener(name, callback) { this.events.set(name, callback); },
      removeEventListener(name, callback) { if (this.events.get(name) === callback) this.events.delete(name); },
      replaceChildren() { this.textContent = ""; }, showModal() { this.open = true; }, close() { this.open = false; },
      focus() { this.focused = true; } });
    return elements.get(id);
  }
  let current = initial, handlers, nextRefresh = async () => { data.notes = [{ title: "CRM", content: current.projectId }]; };
  let data = { notes: [], selectedNoteTitle: "", selectedNoteDetail: null, creatingNote: false, activeNotesFilter: "all", noteSelectionVersion: 0 };
  const context = { snapshot: () => current, ready: async () => {
    if (current.status !== "ready") throw new Error("unavailable"); return current;
  }, isCurrent: bound => bound.epoch === current.epoch && current.status === "ready",
  subscribe: callback => { listeners.add(callback); callback(current); return () => listeners.delete(callback); } };
  const bridge = { switchProject: async id => { calls.push(["switch", id]); return { ok: true }; },
    createProject: async payload => { calls.push(["create", payload]); return { ok: true }; },
    connectProject: async () => { calls.push(["connect"]); return { ok: true, canceled: true }; },
    reportProjectCount: async payload => { reports.push(payload); return { ok: true }; } };
  const notes = { read: () => data, write: value => { data = { notes: [], selectedNoteTitle: "", selectedNoteDetail: null,
    creatingNote: false, activeNotesFilter: "all", ...value, noteSelectionVersion: data.noteSelectionVersion + 1 }; },
    pause: () => calls.push(["pause"]), reset: () => calls.push(["reset"]), resume: () => calls.push(["resume"]),
    status: (type, message) => { element("notes-status-text").textContent = message; element("notes-status-card").status = type; },
    refresh: () => { calls.push(["refresh", current.projectId]); return nextRefresh(); },
    select: async title => { data.selectedNoteTitle = title; calls.push(["select", title]); }, newNote: () => { data.creatingNote = true; } };
  const controller = create({ doc: { getElementById: element, querySelector: element }, context, bridge, notes, text,
    createView: callbacks => { handlers = callbacks; return { render: state => renders.push(state), dispose: () => calls.push(["view-dispose"]) }; } });
  return { controller, bridge, context, get: element, calls, renders, reports,
    get data() { return data; }, get handlers() { return handlers; },
    reply: handler => { nextRefresh = handler; },
    emit: value => { current = value; for (const listener of listeners) listener(value); }, listenerCount: () => listeners.size };
}

test("project startup is single, loads once and never guesses a note selection", async () => {
  const f = fixture(); await Promise.all([f.controller.start(), f.controller.start()]);
  assert.equal(f.calls.filter(call => call[0] === "refresh").length, 1);
  assert.equal(f.data.selectedNoteTitle, ""); assert.equal(f.data.creatingNote, false);
  assert.equal(f.get(".notes-viewer").inert, false);
  assert.equal(f.renders.at(-1).projects[0].count, 1);
  f.controller.notesChanged(); await settle();
  assert.deepEqual(f.reports, [{ projectId: A, contextToken: T, count: 1 }]);
  f.emit(snapshot(A, 1)); await settle();
  assert.equal(f.calls.filter(call => call[0] === "refresh").length, 1);
});

test("switching clears old text/images, then restores only the intended project's draft, filter and scroll", async () => {
  const f = fixture(); await f.controller.start();
  Object.assign(f.data, { creatingNote: true, activeNotesFilter: "tagged" });
  f.get("note-content-input").value = "Exact Alpha draft\r\nuntouched";
  f.get("notes-search").value = "Alpha query"; f.get("notes-sort-select").value = "oldest";
  f.get("notes-list").scrollTop = 120; f.get("note-view-content").scrollTop = 90; f.get("notes-viewer").scrollTop = 75;
  f.get("note-view-content").textContent = "private Alpha body/image";
  f.emit(snapshot(A, 2, "switching"));
  assert.equal(f.get("note-content-input").value, ""); assert.equal(f.get("note-view-content").textContent, "");
  assert.equal(f.get(".notes-viewer").inert, true);
  f.emit(snapshot(B, 3)); await settle();
  assert.equal(f.data.selectedNoteTitle, ""); assert.equal(f.data.creatingNote, false);
  assert.equal(f.get("notes-search").value, "");
  f.get("note-content-input").value = "Beta draft";
  f.emit(snapshot(B, 4, "switching")); f.emit(snapshot(A, 5)); await settle();
  assert.equal(f.data.creatingNote, true); assert.equal(f.data.activeNotesFilter, "tagged");
  assert.equal(f.get("note-content-input").value, "Exact Alpha draft\r\nuntouched");
  assert.equal(f.get("notes-search").value, "Alpha query"); assert.equal(f.get("notes-sort-select").value, "oldest");
  assert.equal(f.get("notes-list").scrollTop, 120); assert.equal(f.get("note-view-content").scrollTop, 90);
  assert.equal(f.get("notes-viewer").scrollTop, 75);
});

test("a late old activation cannot unmask or resume over a newer project", async () => {
  const f = fixture(); let release;
  f.reply(() => new Promise(resolve => { release = resolve; }));
  const first = f.controller.start(); await settle();
  f.reply(async () => {}); f.emit(snapshot(A, 2, "switching")); f.emit(snapshot(B, 3)); await settle();
  const resumed = f.calls.filter(call => call[0] === "resume").length;
  release(); await first;
  assert.equal(f.renders.at(-1).activeProjectId, B);
  assert.equal(f.calls.filter(call => call[0] === "resume").length, resumed);
  assert.equal(f.get(".notes-viewer").inert, false);
});

test("failed loading is recoverable but an unconfirmed context blocks project mutations until restart", async () => {
  const f = fixture(); f.reply(async () => { throw new Error("offline"); }); await f.controller.start();
  assert(f.renders.at(-1).error.includes("Не удалось загрузить"));
  f.reply(async () => {}); f.controller.notesChanged(); assert.equal(f.renders.at(-1).error, "");
  f.emit(snapshot(null, 2, "error"));
  assert.equal(f.get(".notes-viewer").inert, true); assert.equal(f.renders.at(-1).busy, false);
  assert.equal(f.renders.at(-1).ready, false); assert(f.renders.at(-1).error.includes("Перезапустите"));
  await f.handlers.onSelect(A); assert.equal(f.calls.some(call => call[0] === "switch"), false);
  f.emit(snapshot(A, 3)); await settle(); assert.equal(f.get(".notes-viewer").inert, false);
});

test("load failure names the visible retry action in every supported language", async () => {
  const fs = require("node:fs"), path = require("node:path");
  const languages = require("../../frontend/ui_languages");
  const html = fs.readFileSync(path.join(__dirname, "../../frontend/notes.html"), "utf8");
  const button = html.match(/<button id="notes-library-retry-btn"[^>]*data-en="([^"]+)"[^>]*>([^<]+)<\/button>/);
  assert.ok(button, "The project library must expose its retry action");
  for (const code of Object.keys(languages.languages)) {
    const translate = (ru, en) => languages.translate(code, ru, en);
    const f = fixture(snapshot(), translate);
    f.reply(async () => { throw new Error("synthetic unavailable library"); });
    await f.controller.start();
    const action = translate(button[2], button[1]);
    assert.ok(f.renders.at(-1).error.includes(action), `${code}: the error must name the visible “${action}” button`);
    f.controller.dispose();
  }
});

test("native folder actions serialize, cancel safely and validate names before invoking main", async () => {
  const f = fixture(); await f.controller.start(); f.handlers.onCreate(); assert.equal(f.get("project-name-dialog").open, true);
  const submit = f.get("project-name-form").events.get("submit"), event = { preventDefault() {} };
  f.get("project-name-input").value = "../other"; await submit(event);
  assert.equal(f.get("project-name-error").hidden, false); assert.equal(f.calls.some(call => call[0] === "create"), false);
  f.get("project-name-input").value = "Project One";
  f.bridge.createProject = async payload => { f.calls.push(["create", payload]); return { ok: true, canceled: true }; };
  await submit(event); assert.equal(f.get("project-name-dialog").open, true);
  f.bridge.createProject = async () => ({ ok: true }); await submit(event);
  assert.equal(f.get("project-name-dialog").open, false); assert.equal(f.get("project-name-input").value, "");
  let release, connected = 0;
  f.bridge.connectProject = () => { connected++; return new Promise(resolve => { release = resolve; }); };
  const pending = f.handlers.onConnect(); await f.handlers.onConnect(); assert.equal(connected, 1);
  assert.equal(f.renders.at(-1).busy, true); release({ ok: true, canceled: true }); await pending;
  assert.equal(f.renders.at(-1).busy, false);
  f.bridge.connectProject = async () => { throw new Error("native failure with sensitive detail"); };
  await f.handlers.onConnect(); assert.equal(f.renders.at(-1).error.includes("sensitive"), false);
});

test("a bootstrap error blocks mutations; teardown removes subscriptions and form listeners", async () => {
  const f = fixture(snapshot(null, 1, "error")); await f.controller.start();
  assert.equal(f.renders.at(-1).ready, false); assert.equal(f.get(".notes-sidebar").inert, true);
  assert.equal(f.listenerCount(), 1); f.controller.dispose(); assert.equal(f.listenerCount(), 0);
  assert.equal(f.get("project-name-form").events.has("submit"), false);
  const count = f.renders.length; f.emit(snapshot(A, 2)); f.controller.update(); assert.equal(f.renders.length, count);
});

test("a failed switch keeps its localized rollback error after reloading and background count updates", async () => {
  const f = fixture(); await f.controller.start(); let release;
  f.reply(() => new Promise(resolve => { release = resolve; }));
  const error = "Не удалось открыть проект. Прежний проект сохранён.";
  f.bridge.switchProject = async () => {
    f.emit(snapshot(A, 2, "switching"));
    const rollback = snapshot(A, 3); rollback.projectState.error = error; f.emit(rollback);
    return { ok: false, code: "project_switch_failed", error };
  };
  await f.handlers.onSelect(B); assert.equal(f.renders.at(-1).error, error);
  release(); await settle(); f.controller.notesChanged();
  assert.equal(f.renders.at(-1).error, error);
  const update = snapshot(A, 3); update.projectState.error = error; f.emit(update);
  assert.equal(f.renders.at(-1).error, error);
  await f.handlers.onConnect(); assert.equal(f.renders.at(-1).error, "");
});

test("main preflight errors remain literal, bounded and visible without replacing the active note", async () => {
  const f = fixture(); await f.controller.start(); f.data.selectedNoteTitle = "CRM";
  const fresh = snapshot(A, 1); fresh.projectState.error = '<img src=x onerror="bad()">' + "x".repeat(700);
  f.emit(fresh); assert.equal(f.renders.at(-1).error.length, 600);
  assert(f.renders.at(-1).error.startsWith("<img")); assert.equal(f.data.selectedNoteTitle, "CRM");
  f.controller.notesChanged(); assert.equal(f.renders.at(-1).error.length, 600);
});

test("a failed optional count report preserves the usable project and logs no payload", async () => {
  const f = fixture(), warnings = [], warn = console.warn;
  f.bridge.reportProjectCount = async () => { throw new Error("synthetic private payload"); };
  console.warn = message => warnings.push(message);
  try { await f.controller.start(); await settle(); }
  finally { console.warn = warn; }
  assert.deepEqual(warnings, ["Project note count could not be saved"]);
  assert.equal(f.renders.at(-1).error, ""); assert.equal(f.get(".notes-viewer").inert, false);
});

test("disposal while bootstrap is pending cannot start a notes request", async () => {
  const f = fixture(); let release;
  f.context.ready = () => new Promise(resolve => { release = resolve; });
  const pending = f.controller.start(); f.controller.dispose(); release(snapshot()); await pending;
  assert.equal(f.calls.some(call => call[0] === "refresh"), false);
});

test("switching and hard-error clear the old opened title and green status immediately", async () => {
  const f = fixture(); await f.controller.start();
  for (const [epoch, status] of [[2, "switching"], [3, "error"]]) {
    f.get("notes-status-text").textContent = "Открыта заметка: OLD-PROJECT-UNIQUE-TITLE";
    f.get("notes-status-card").status = "ok";
    f.emit(snapshot(status === "error" ? null : A, epoch, status));
    assert.equal(f.get("notes-status-text").textContent, "");
    assert.equal(f.get("notes-status-card").status, "");
    assert(!f.renders.at(-1).noteTitle.includes("OLD-PROJECT-UNIQUE-TITLE"));
  }
});

test("explicit legacy mode preserves the former initial list/select flow", async () => {
  const initial = snapshot(null); initial.projectState = { mode: "legacy", projects: [] };
  const f = fixture(initial); await f.controller.start();
  assert.equal(f.get("notes-projects-panel").hidden, true); assert.equal(f.data.selectedNoteTitle, "CRM");
  const empty = fixture(initial); empty.reply(async () => {}); await empty.controller.start(); assert.equal(empty.data.creatingNote, true);
});

test("count reports serialize and keep only the latest actual count without post-dispose writes", async () => {
  const f = fixture(); let release;
  f.bridge.reportProjectCount = payload => {
    f.reports.push(payload);
    return f.reports.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true });
  };
  await f.controller.start(); await settle(); assert.equal(f.reports.length, 1);
  f.data.notes.push({ title: "Second" }); f.controller.notesChanged();
  f.data.notes.push({ title: "Third" }); f.controller.notesChanged();
  assert.equal(f.reports.length, 1); release({ ok: true }); await settle();
  assert.deepEqual(f.reports.map(report => report.count), [1, 3]);
  assert(f.reports.every(report => report.projectId === A && report.contextToken === T));
  f.controller.dispose(); f.data.notes.push({ title: "Disposed" }); f.controller.notesChanged();
  await settle(); assert.equal(f.reports.length, 2);
});
