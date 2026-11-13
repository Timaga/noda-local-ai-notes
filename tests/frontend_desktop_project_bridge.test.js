"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const test = require("node:test");
const { createDesktopProjects } = require("../frontend/desktop_projects");
const { createDesktopProjectBridge } = require("../frontend/desktop_project_bridge");
const { normalizeNotesDirectory } = require("../frontend/desktop_settings");
const { NoteModelDownloadError } = require("../frontend/note_model_download");
const policy = require("../frontend/ru_note_startup");
const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "../frontend/preload.js"), "utf8");
const origin = "http://127.0.0.1:5000";
const payload = state => ({ projectId: state.context.project_id, contextToken: state.context.context_token });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function section(source, begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `Missing source section ${begin}`);
  return source.slice(start, finish);
}

async function fixture(run, { owned = false, corrupt = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "noda-project-bridge-")));
  const a = path.join(root, "A"), b = path.join(root, "B"), userData = path.join(root, "profile");
  fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(a, "CRM.md"), "A source"); fs.writeFileSync(path.join(b, "CRM.md"), "B source");
  const file = path.join(userData, "knowledge-projects.json");
  const registry = createDesktopProjects(file);
  let initial;
  if (corrupt) fs.writeFileSync(file, "{corrupt");
  else if (!owned) {
    const first = registry.bootstrap({ name: "A", notesDirectory: a, collectionName: "old_notes" });
    initial = registry.commit(first, registry.activate(registry.addExisting(first, { name: "B", notesDirectory: b }), first.activeProjectId));
  }
  const environment = { QDRANT_COLLECTION_NAME: "old_notes" }, handlers = new Map(), sent = [], calls = [];
  const window = name => ({ name, isDestroyed: () => false, webContents: { isDestroyed: () => false,
    send: (channel, value) => sent.push({ name, channel, value }) } });
  const notes = window("notes"), quick = window("quick"), dead = { isDestroyed: () => true };
  const event = target => ({ sender: target.webContents });
  const h = { root, a, b, userData, file, registry, initial, environment, handlers, sent, calls,
    notes, quick, event, readyCalls: 0, mutableCalls: 0, restartCalls: 0, stopCalls: 0, picker: null, busy: false };
  const options = {
    userData, environment, backendUrl: origin, shutdownToken: "synthetic-control-token", ownedProfile: owned ? { fixture: true } : null,
    text: ru => ru, isBusy: () => h.busy, setBusy: value => { h.busy = value; calls.push(["busy", value]); },
    isReadSender: evt => policy.isGenerationSender(evt, [notes, quick]), isNotesSender: evt => evt.sender === notes.webContents,
    getNotesWindow: () => notes, windows: () => [notes, quick, null, dead],
    ensureReady: async () => { h.readyCalls += 1; if (h.onReady) await h.onReady(); },
    assertMutable: () => { h.mutableCalls += 1; if (h.mutableError) throw h.mutableError; },
    dialog: { showOpenDialog: async (parent, config) => { calls.push(["dialog", parent, config]); return h.picker || { canceled: true, filePaths: [] }; } },
    openProjectFolder: async directory => { calls.push(["openFolder", directory]); return h.folderError || ""; },
    persistDirectory: async directory => { h.persisted = directory; calls.push(["prefs", directory]); },
    stopBackend: async context => { h.stopCalls += 1; calls.push(["stop", { ...context }]); },
    restartBackend: async () => { h.restartCalls += 1; calls.push(["restart", { ...environment }]); if (h.onRestart) await h.onRestart(); },
    completeBackendStart: async () => { calls.push(["runtime-ready"]); },
    readJsonResponse: response => response.json(),
    fetchWithTimeout: async (url, init = {}) => {
      const decorated = h.bridge.decorateRequest(url, init);
      const headers = new Headers(decorated.headers);
      calls.push(["http", url, { ...decorated, headers }]);
      const endpoint = new URL(url).pathname;
      let value;
      if (endpoint === "/projects/context") {
        const normalized = process.platform === "win32" ? path.resolve(environment.NOTES_DIR).toLowerCase() : path.resolve(environment.NOTES_DIR);
        value = { ready: true, project_id: environment.NODA_PROJECT_ID, context_token: environment.NODA_PROJECT_CONTEXT,
          collection_name: environment.QDRANT_COLLECTION_NAME, root_sha256: crypto.createHash("sha256").update(normalized).digest("hex"), vault_id: "a".repeat(32) };
      } else value = { ok: true, project_id: headers.get("X-Noda-Project-Id"), context_token: headers.get("X-Noda-Project-Context"),
        ...(endpoint.endsWith("activate") ? { activated: true } : { frozen: endpoint.endsWith("prepare-switch") }) };
      if (h.onRpc) value = h.onRpc(endpoint, value);
      return { ok: !value.httpFailure, json: async () => value };
    },
  };
  h.options = options; h.bridge = createDesktopProjectBridge(options);
  h.bridge.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  h.invoke = (channel, value, target = notes) => handlers.get(`quick-note:${channel}`)(event(target), value);
  h.start = () => h.bridge.prepareBackendStart(a);
  try { await run(h); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("project read IPC accepts notes and quick only; all mutations require notes sender", () => fixture(async h => {
  h.start();
  for (const target of [h.notes, h.quick]) assert.equal((await h.invoke("get-projects", undefined, target)).mode, "projects");
  const foreign = { webContents: {} };
  assert.equal((await h.invoke("get-projects", undefined, foreign)).code, "invalid_sender");
  const before = fs.readFileSync(h.file), ready = h.readyCalls;
  for (const channel of ["create-project", "connect-project", "switch-project", "report-project-count",
    "open-project-folder", "rename-project", "detach-project", "backup-project"]) {
    assert.equal((await h.invoke(channel, {}, h.quick)).code, "invalid_sender");
    assert.equal((await h.invoke(channel, {}, foreign)).code, "invalid_sender");
  }
  assert.equal(h.readyCalls, ready); assert.equal(h.mutableCalls, 0);
  assert.deepEqual(fs.readFileSync(h.file), before);
}));

test("project management preserves files, stable identity, chat scope and an active context on reconnect", () => fixture(async h => {
  h.start();
  const initial = await h.invoke("get-projects");
  const project = initial.projects[1], target = { ...payload(initial), targetId: project.id };
  assert.equal((await h.invoke("open-project-folder", target)).ok, true);
  assert.deepEqual(h.calls.at(-1), ["openFolder", h.b]);
  assert.equal((await h.invoke("rename-project", { ...target, name: "Boreal archive" })).ok, true);
  assert.equal((await h.invoke("detach-project", { ...target, targetId: initial.activeProjectId })).code, "ACTIVE_PROJECT");
  assert.equal((await h.invoke("detach-project", target)).ok, true);
  const detached = await h.invoke("get-projects");
  assert.deepEqual(detached.projects.map(entry => entry.id), [initial.activeProjectId]);
  assert.deepEqual(detached.context, initial.context);
  assert.equal(h.registry.load().projects[1].detached, true);
  assert.equal((await h.invoke("switch-project", project.id)).code, "UNKNOWN_PROJECT");
  assert.equal((await h.invoke("open-project-folder", target)).code, "UNKNOWN_PROJECT");
  assert.equal(h.restartCalls, 0);
  assert.equal(fs.readFileSync(path.join(h.b, "CRM.md"), "utf8"), "B source");
  h.picker = { canceled: false, filePaths: [h.b] };
  const restored = await h.invoke("connect-project");
  assert.equal(restored.activeProjectId, project.id);
  assert.equal(restored.activeProject.name, "Boreal archive");
  assert.equal(restored.activeProject.collectionName, project.collectionName);
  assert.equal(h.environment.NODA_PROJECT_STORAGE, path.join(h.userData, "projects", project.id));
  assert.equal(h.registry.load().projects[1].detached, undefined);
  assert.equal((await h.invoke("rename-project", { ...target, name: "Stale" })).code, "project_changed");
}));

test("folder action rejects paths from the renderer, invalid names and folders that became files", () => fixture(async h => {
  h.start();
  const initial = await h.invoke("get-projects");
  const target = { ...payload(initial), targetId: initial.projects[1].id };
  assert.equal((await h.invoke("open-project-folder", { ...target, path: h.root })).code, "UNKNOWN_PROJECT");
  assert.equal((await h.invoke("open-project-folder", { ...target, targetId: h.a })).code, "UNKNOWN_PROJECT");
  assert.equal((await h.invoke("rename-project", { ...target, name: "../elsewhere" })).code, "INVALID_NAME");
  assert.equal(h.calls.some(call => call[0] === "openFolder"), false);
  h.folderError = "synthetic shell details";
  const result = await h.invoke("open-project-folder", target);
  assert.equal(result.code, "project_folder_open_failed");
  assert.doesNotMatch(result.error, /synthetic/);
  fs.renameSync(h.b, path.join(h.root, "B-offline"));
  fs.writeFileSync(h.b, "Not a project folder");
  assert.equal((await h.invoke("open-project-folder", target)).code, "UNSAFE_DIRECTORY");
  assert.equal(h.calls.filter(call => call[0] === "openFolder").length, 1);
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("notes backup copies Markdown bytes and supported attachments to a new chosen directory only", () => fixture(async h => {
  h.start();
  const state = await h.invoke("get-projects");
  const target = { ...payload(state), targetId: state.projects[1].id };
  const destination = path.join(h.root, "Backups");
  const attachment = path.join(h.b, "images");
  fs.mkdirSync(destination); fs.mkdirSync(attachment);
  fs.mkdirSync(path.join(h.b, ".noda-queue"));
  const content = Buffer.from("---\r\ntags: [sample]\r\n---\r\nТекст\r\n");
  const image = Buffer.from([0, 6, 255, 5]);
  fs.writeFileSync(path.join(h.b, "CRM.md"), content);
  fs.writeFileSync(path.join(h.b, "Empty.md"), "");
  fs.writeFileSync(path.join(attachment, "sample.png"), image);
  fs.writeFileSync(path.join(h.b, ".noda-queue", "private.md"), "queued");
  fs.writeFileSync(path.join(h.b, "service.sqlite"), "cache");
  fs.symlinkSync(h.a, path.join(h.b, "external"), "junction");
  assert.equal((await h.invoke("backup-project", { ...target, destination })).code, "UNKNOWN_PROJECT");
  assert.equal((await h.invoke("backup-project", target)).canceled, true);
  h.picker = { canceled: false, filePaths: [attachment] };
  assert.equal((await h.invoke("backup-project", target)).code, "BACKUP_INSIDE_PROJECT");
  h.picker = { canceled: false, filePaths: [destination] };
  const result = await h.invoke("backup-project", target);
  assert.equal(result.ok, true, result.error);
  assert.equal(path.dirname(result.directory), destination);
  assert.equal(result.files, 3);
  assert.deepEqual(fs.readdirSync(result.directory).sort(), ["CRM.md", "Empty.md", "images"].sort());
  assert.deepEqual(fs.readFileSync(path.join(result.directory, "CRM.md")), content);
  assert.equal(fs.readFileSync(path.join(result.directory, "Empty.md")).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(result.directory, "images", "sample.png")), image);
  assert.deepEqual(fs.readFileSync(path.join(h.b, "CRM.md")), content);
  assert.deepEqual(h.registry.load(), h.initial);
  assert.equal(h.restartCalls, 0);
  assert.equal(h.busy, false);
  h.picker = { canceled: false, filePaths: [result.directory] };
  const restored = await h.invoke("connect-project");
  assert.equal(restored.ok, true, restored.error);
  assert.notEqual(restored.activeProjectId, target.targetId);
  assert.equal(restored.activeProject.notesDirectory, result.directory);
  assert.equal(h.environment.NOTES_DIR, result.directory);
  assert.deepEqual(fs.readFileSync(path.join(restored.activeProject.notesDirectory, "CRM.md")), content);
  assert.deepEqual(fs.readFileSync(path.join(restored.activeProject.notesDirectory, "images", "sample.png")), image);
}));

test("backup rejects a note moved out of a nested folder after the copy has started", t => fixture(async h => {
  h.start();
  const state = await h.invoke("get-projects");
  const target = { ...payload(state), targetId: state.projects[1].id };
  const destination = path.join(h.root, "Backups"), nested = path.join(h.b, "nested");
  fs.mkdirSync(destination); fs.mkdirSync(nested);
  const source = path.join(nested, "Moved.md"), moved = path.join(h.root, "Moved.md");
  fs.writeFileSync(source, "Move while the first file is copied");
  h.picker = { canceled: false, filePaths: [destination] };
  const originalWrite = fs.createWriteStream;
  t.mock.method(fs, "createWriteStream", (filename, options) => {
    if (path.basename(filename) === "CRM.md") fs.renameSync(source, moved);
    return originalWrite(filename, options);
  });
  const result = await h.invoke("backup-project", target);
  assert.equal(result.ok, false);
  assert.equal(result.code, "backup_source_changed");
  assert.match(result.error, /Готовая копия не создана/);
  assert.equal(result.directory, undefined);
  assert.deepEqual(fs.readdirSync(destination), []);
  assert.equal(fs.readFileSync(moved, "utf8"), "Move while the first file is copied");
  assert.equal(h.busy, false);
}));

test("backup rejects a project folder that was moved and replaced while choosing the destination", () => fixture(async h => {
  h.start();
  const state = await h.invoke("get-projects");
  const target = { ...payload(state), targetId: state.projects[1].id };
  const destination = path.join(h.root, "Backups"), moved = path.join(h.root, "Moved B");
  fs.mkdirSync(destination);
  h.options.dialog.showOpenDialog = async () => {
    fs.renameSync(h.b, moved);
    fs.mkdirSync(h.b);
    fs.writeFileSync(path.join(h.b, "CRM.md"), "Replacement");
    return { canceled: false, filePaths: [destination] };
  };
  const result = await h.invoke("backup-project", target);
  assert.equal(result.ok, false);
  assert.equal(result.code, "backup_source_changed");
  assert.deepEqual(fs.readdirSync(destination), []);
  assert.equal(fs.readFileSync(path.join(moved, "CRM.md"), "utf8"), "B source");
  assert.equal(h.busy, false);
}));

test("backup checks the original inventory again after every file has been copied", t => fixture(async h => {
  h.start();
  const state = await h.invoke("get-projects");
  const target = { ...payload(state), targetId: state.projects[1].id };
  const destination = path.join(h.root, "Backups"), moved = path.join(h.root, "Moved CRM.md");
  fs.mkdirSync(destination);
  h.picker = { canceled: false, filePaths: [destination] };
  const originalRead = fs.promises.readdir;
  let movedDuringVerification = false;
  t.mock.method(fs.promises, "readdir", (directory, options) => {
    if (!movedDuringVerification && path.basename(directory).startsWith(".noda-copy-")) {
      assert.equal(fs.readFileSync(path.join(directory, "CRM.md"), "utf8"), "B source");
      fs.renameSync(path.join(h.b, "CRM.md"), moved);
      movedDuringVerification = true;
    }
    return originalRead(directory, options);
  });
  const result = await h.invoke("backup-project", target);
  assert.equal(movedDuringVerification, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "backup_source_changed");
  assert.deepEqual(fs.readdirSync(destination), []);
  assert.equal(fs.readFileSync(moved, "utf8"), "B source");
}));

test("backup rejects a staging file with changed bytes even when the size matches", t => fixture(async h => {
  h.start();
  const state = await h.invoke("get-projects");
  const target = { ...payload(state), targetId: state.projects[1].id };
  const destination = path.join(h.root, "Backups");
  fs.mkdirSync(destination);
  h.picker = { canceled: false, filePaths: [destination] };
  const originalRead = fs.promises.readdir;
  t.mock.method(fs.promises, "readdir", (directory, options) => {
    if (path.basename(directory).startsWith(".noda-copy-")) {
      fs.writeFileSync(path.join(directory, "CRM.md"), "Changed!");
    }
    return originalRead(directory, options);
  });
  const result = await h.invoke("backup-project", target);
  assert.equal(result.ok, false);
  assert.equal(result.code, "backup_verification_failed");
  assert.match(result.error, /Копия не прошла проверку/);
  assert.deepEqual(fs.readdirSync(destination), []);
  assert.equal(fs.readFileSync(path.join(h.b, "CRM.md"), "utf8"), "B source");
  assert.equal(h.busy, false);
}));

test("actual registry selection sets backend projects/id layout and sends state only to live windows", () => fixture(async h => {
  h.start(); await h.bridge.verifyBackend(); await h.bridge.activateInitial();
  const initial = await h.invoke("get-projects");
  assert.equal(h.environment.NODA_PROJECT_STORAGE, path.join(h.userData, "projects", initial.activeProjectId));
  const next = await h.invoke("switch-project", h.initial.projects[1].id);
  assert.equal(next.ok, true); assert.equal(next.activeProject.notesDirectory, h.b);
  assert.equal(h.environment.NODA_PROJECT_STORAGE, path.join(h.userData, "projects", next.activeProjectId));
  assert.deepEqual(new Set(h.sent.map(item => item.name)), new Set(["notes", "quick"]));
  assert.ok(h.sent.every(item => item.channel === "quick-note:project-state"));
  assert.equal(fs.readFileSync(path.join(h.a, "CRM.md"), "utf8"), "A source");
  assert.equal(fs.readFileSync(path.join(h.b, "CRM.md"), "utf8"), "B source");
}));

test("required context is checked before and after awaited readiness and no old result is returned", () => fixture(async h => {
  h.start(); const before = await h.invoke("get-projects"); let ran = 0;
  for (const value of [null, {}, { ...payload(before), contextToken: "wrong" }]) {
    await assert.rejects(h.bridge.runWithContext(value, async () => { ran += 1; }), { code: "project_changed" });
  }
  assert.equal(ran, 0);
  const gate = deferred();
  const pending = h.bridge.runWithContext(payload(before), async () => { ran += 1; await gate.promise; return "old result"; });
  await h.invoke("switch-project", h.initial.projects[1].id);
  gate.resolve();
  await assert.rejects(pending, { code: "project_changed" });
  assert.equal(ran, 1);
}));

test("optional startup readiness cannot run while another project transition is pending", () => fixture(async h => {
  h.start();
  assert.equal(await h.bridge.runWithContext(null, async () => "ready", false), "ready");
  const freeze = deferred();
  h.onRestart = () => freeze.promise;
  const pending = h.invoke("switch-project", h.initial.projects[1].id);
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  assert.equal(h.bridge.isTransitioning(), true);
  await assert.rejects(h.bridge.runWithContext(null, async () => {}, false), { code: "project_busy" });
  freeze.resolve(); await pending;
}));

test("decorator uses new backend binding while public context is old and preserves explicit shutdown context", () => fixture(async h => {
  h.start(); const old = await h.invoke("get-projects"); let observed;
  h.onRestart = () => {
    observed = new Headers(h.bridge.decorateRequest(`${origin}/projects/context`).headers);
    assert.equal(observed.get("X-Noda-Project-Id"), h.initial.projects[1].id);
    assert.notEqual(observed.get("X-Noda-Project-Context"), old.context.context_token);
    const previous = h.bridge.decorateRequest(`${origin}/runtime/shutdown-managed`, { headers: {
      "X-Noda-Project-Id": old.context.project_id, "X-Noda-Project-Context": old.context.context_token,
    } });
    assert.equal(previous.headers.get("X-Noda-Project-Context"), old.context.context_token);
    assert.equal(previous.redirect, "error");
  };
  await h.invoke("switch-project", h.initial.projects[1].id);
  assert.ok(observed);
}));

test("scoped fetch forbids foreign origins, replaces caller context, blocks redirects and rejects stale capture", () => fixture(async h => {
  h.start(); const state = await h.invoke("get-projects");
  const scoped = h.bridge.fetchFor(payload(state));
  assert.throws(() => scoped("https://evil.example/notes"), /local backend/);
  await scoped(`${origin}/generate/runtime`, { redirect: "follow", headers: { "X-Noda-Project-Id": "foreign" } });
  const call = h.calls.filter(item => item[0] === "http").at(-1);
  assert.equal(call[2].redirect, "error");
  assert.equal(call[2].headers.get("X-Noda-Project-Id"), state.activeProjectId);
  await h.invoke("switch-project", h.initial.projects[1].id);
  assert.throws(() => scoped(`${origin}/notes`), { code: "project_changed" });
}));

test("decorator cannot leak explicit project headers to external origin and never adds them there", () => fixture(async h => {
  h.start();
  const clean = h.bridge.decorateRequest("https://example.invalid/download", { headers: { Accept: "application/json" } });
  assert.equal(new Headers(clean.headers).has("X-Noda-Project-Id"), false);
  for (const headers of [{ "X-Noda-Project-Id": "explicit" }, { "X-Noda-Project-Context": "explicit" }]) {
    assert.throws(() => h.bridge.decorateRequest("https://example.invalid/download", { headers }));
  }
}));

test("prepare acknowledgement requires matching project/token and exact frozen true", () => fixture(async h => {
  h.start();
  for (const invalid of [{ ok: false }, { project_id: "foreign" }, { context_token: "foreign" }, { frozen: false }, { frozen: "true" }]) {
    h.onRpc = (endpoint, value) => endpoint.endsWith("prepare-switch") ? { ...value, ...invalid } : value;
    const result = await h.invoke("switch-project", h.initial.projects[1].id);
    assert.equal(result.code, "project_context_invalid"); assert.equal(result.status, "ready");
    assert.equal(h.restartCalls, 0); assert.deepEqual(h.registry.load(), h.initial);
  }
}));

test("cancel acknowledgement failure after uncertain prepare closes context", () => fixture(async h => {
  h.start();
  h.onRpc = (endpoint, value) => endpoint.endsWith("prepare-switch") ? { ...value, ok: false }
    : endpoint.endsWith("cancel-switch") ? { ...value, frozen: true } : value;
  const result = await h.invoke("switch-project", h.initial.projects[1].id);
  assert.equal(result.code, "project_switch_unconfirmed"); assert.equal(result.context, null);
  assert.equal(h.restartCalls, 0); assert.deepEqual(h.registry.load(), h.initial);
}));

test("activation acknowledgement failure keeps committed target and does not restart unknown running work", () => fixture(async h => {
  h.start();
  h.onRpc = (endpoint, value) => endpoint.endsWith("activate") ? { ...value, activated: false } : value;
  const result = await h.invoke("switch-project", h.initial.projects[1].id);
  assert.equal(result.code, "project_activation_failed"); assert.equal(result.context, null);
  assert.equal(h.registry.load().activeProjectId, h.initial.projects[1].id);
  assert.equal(h.restartCalls, 1); assert.equal(h.stopCalls, 1);
}));

test("HTTP busy failure is returned without changing project or starting target", () => fixture(async h => {
  h.start();
  h.onRpc = (endpoint, value) => endpoint.endsWith("prepare-switch") ? { ...value, httpFailure: true, code: "project_busy" } : value;
  assert.equal((await h.invoke("switch-project", h.initial.projects[1].id)).code, "project_busy");
  assert.equal(h.restartCalls, 0); assert.deepEqual(h.registry.load(), h.initial);
}));

test("native dialogs only accept trusted selected paths, cancellation and count reports preserve contracts", () => fixture(async h => {
  h.start(); const state = await h.invoke("get-projects");
  assert.equal((await h.invoke("connect-project")).canceled, true);
  h.picker = { canceled: false, filePaths: [h.b] };
  assert.equal((await h.invoke("connect-project")).activeProjectId, h.initial.projects[1].id);
  h.picker = { canceled: false, filePaths: [h.root] };
  const created = await h.invoke("create-project", { name: "New" });
  assert.equal(created.activeProject.notesDirectory, path.join(h.root, "New"));
  const counted = await h.invoke("report-project-count", { ...payload(created), count: 0 });
  assert.equal(counted.activeProject.noteCount, 0);
  await assert.rejects(h.invoke("report-project-count", { ...payload(state), count: 9 }), { code: "project_changed" });
  assert.ok(h.calls.filter(item => item[0] === "dialog").every(item => item[1] === h.notes && item[2].properties.includes("openDirectory")));
}));

test("corrupt registry does not crash module initialization and denied IPC cannot inspect it", () => fixture(async h => {
  assert.equal(h.bridge.isEnabled(), false);
  const before = fs.readFileSync(h.file);
  assert.equal((await h.invoke("get-projects", undefined, { webContents: {} })).code, "invalid_sender");
  await assert.rejects(h.invoke("get-projects", undefined, h.quick), /реестр проектов/);
  await assert.rejects(h.invoke("connect-project"), /реестр проектов/);
  assert.throws(() => h.bridge.prepareBackendStart(h.a), /реестр проектов/);
  assert.equal(h.readyCalls, 0); assert.equal(h.restartCalls, 0);
  assert.deepEqual(fs.readFileSync(h.file), before);
}, { corrupt: true }));

test("owned profile is trusted explicit legacy, never writes registry, and rejects mutable project operations", () => fixture(async h => {
  assert.equal(h.bridge.isEnabled(), false); assert.equal(h.bridge.restoredDirectory(), undefined);
  assert.equal(h.bridge.currentDirectoryAvailable(h.a), true);
  h.start(); await h.bridge.verifyBackend(); await h.bridge.activateInitial();
  const state = await h.invoke("get-projects", undefined, h.quick);
  assert.equal(state.mode, "legacy"); assert.equal(state.context, null);
  assert.equal((await h.invoke("connect-project")).code, "projects_unavailable");
  assert.equal(await h.bridge.runWithContext(null, async () => "legacy"), "legacy");
  const decorated = h.bridge.decorateRequest(`${origin}/notes`, { redirect: "follow" });
  assert.equal(decorated.redirect, "error");
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.calls.some(item => item[0] === "http"), false);
}, { owned: true }));

test("bridge directory availability is read-only and disconnected active root does not hide other projects", () => fixture(async h => {
  const before = fs.readFileSync(h.file);
  assert.equal(h.bridge.currentDirectoryAvailable(h.a), true);
  fs.renameSync(h.a, path.join(h.root, "offline-A"));
  assert.equal(h.bridge.currentDirectoryAvailable(h.a), false);
  assert.equal(h.bridge.currentDirectoryAvailable(h.b), true);
  assert.equal(h.bridge.restoredDirectory(), h.a);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.equal(h.readyCalls, 0); assert.equal(h.restartCalls, 0);
}));

test("actual preload exports the narrow bridge, forwards camel context and strips arbitrary generation fields", async () => {
  let bridge; const calls = [], listeners = new Map();
  const ipcRenderer = { invoke: async (channel, value) => { calls.push([channel, value]); return { ok: true }; },
    on: (channel, handler) => listeners.set(channel, handler), removeListener: (channel, handler) => { assert.equal(listeners.get(channel), handler); listeners.delete(channel); } };
  vm.runInNewContext(preload, { require: name => { assert.equal(name, "electron"); return {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "quickNoteBridge"); bridge = value; } }, ipcRenderer }; },
  process: { argv: [] }, document: { documentElement: { dataset: {}, style: {} } }, window: {} });
  await bridge.ensureGenerationRuntimeReady({ prompt: "source", mode: "organize", projectId: "a".repeat(32), contextToken: "b".repeat(32),
    path: "C:/untrusted", headers: { forged: true }, command: "no", project_id: "wrong" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["quick-note:ensure-generation-runtime", {
    prompt: "source", mode: "organize", projectId: "a".repeat(32), contextToken: "b".repeat(32) }]);
  let received; const off = bridge.onProjectState(value => { received = value; });
  listeners.get("quick-note:project-state")({}, { mode: "projects" }); assert.equal(received.mode, "projects"); off();
  assert.equal(listeners.has("quick-note:project-state"), false);
  assert.equal(bridge.fs, undefined); assert.equal(bridge.process, undefined);
});

test("actual main factory passes real lifecycle boundaries and strict shutdown never kills after rejection", async () => {
  let options; const calls = [];
  const context = { app: { getPath: () => "synthetic-profile" }, process: { env: {} }, BACKEND_URL: origin,
    BACKEND_SHUTDOWN_TOKEN: "synthetic", fetchWithTimeout() {}, readJsonResponse() {}, OWNED_NOTE_PROFILE: null,
    uiText: ru => ru, dialog: {}, ensureBackendReady() {}, isGenerationSender() {}, isNotesWindowSender() {},
    quickWindow: {}, notesWindow: {}, assertProfileMutable() {}, settingsRuntimeUpdateInProgress: false,
    desktopSettings: { notesDirectory: "A" }, DESKTOP_SETTINGS_PATH: "synthetic", DESKTOP_SETTINGS_DEFAULTS: {},
    saveDesktopSettings: (_, value) => value, startupBroadcastSuppressionDepth: 0, backendProcess: {}, backendHttpReadyConfirmed: true,
    stopBackendManagedServices: async (...args) => { calls.push(["stop-services", ...args]); throw new Error("uncertain shutdown"); },
    stopBackendProcess: async () => { calls.push(["kill"]); }, ensureBackendHttpReady: async () => { calls.push(["start-paused"]); },
    fetchRuntimeConfig: async () => ({ ok: true }), createDesktopProjectBridge: value => { options = value; return {}; } };
  vm.createContext(context);
  vm.runInContext(`let desktopProjectBridge = null; ${section(main, "function projects() {", "\ntry {\n  const restored")}; projects();`, context);
  const previous = { project_id: "old", context_token: "old-token" };
  await assert.rejects(options.stopBackend(previous), /uncertain shutdown/);
  assert.equal(calls[0][0], "stop-services"); assert.equal(calls[0][1], previous); assert.equal(calls[0][2], true);
  assert.equal(calls.some(call => call[0] === "kill"), false);
  assert.equal(context.startupBroadcastSuppressionDepth, 0);
  await options.restartBackend(); assert.equal(calls.at(-1)[0], "start-paused");
  assert.equal(context.appReadyPromise, undefined);
  const completed = await options.completeBackendStart();
  assert.equal(completed.ok, true);
  assert.equal((await context.appReadyPromise).runtime.ok, true);
  options.persistDirectory("B"); assert.equal(context.desktopSettings.notesDirectory, "B");
});

test("actual main HTTP wrapper applies project decorator and releases its timeout", async () => {
  let requested, cleared = 0, decorated = 0;
  const context = { AbortController, HTTP_REQUEST_TIMEOUT_MS: 1234,
    setTimeout: () => "synthetic-timer", clearTimeout: timer => { assert.equal(timer, "synthetic-timer"); cleared += 1; },
    desktopProjectBridge: { decorateRequest(url, options) { decorated += 1; return { ...options, redirect: "error", headers: { project: "scoped" } }; } },
    fetch: async (url, options) => { requested = { url, options }; return { ok: true }; } };
  vm.createContext(context);
  vm.runInContext(section(main, "async function fetchWithTimeout(", "\nfunction createTrayIcon()"), context);
  await context.fetchWithTimeout(`${origin}/projects/context`, { method: "GET" });
  assert.equal(decorated, 1); assert.equal(cleared, 1);
  assert.equal(requested.options.redirect, "error"); assert.equal(requested.options.headers.project, "scoped");
  assert.ok(requested.options.signal instanceof AbortSignal);
});

test("actual strict managed shutdown uses explicit previous context and 20 seconds without force fallback", async () => {
  const calls = [];
  const context = { BACKEND_URL: origin, BACKEND_SHUTDOWN_TOKEN: "synthetic", HTTP_REQUEST_TIMEOUT_MS: 1234,
    backendProcess: {}, backendHttpReadyConfirmed: true,
    process: { platform: "win32" }, managedQdrantPid: 999999, PROCESS_STOP_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (...args) => { calls.push(["http", ...args]); return { ok: false }; },
    runProcess: async (...args) => { calls.push(["process", ...args]); } };
  vm.createContext(context);
  vm.runInContext(section(main, "async function stopBackendManagedServices(", "\nasync function rollbackDesktopSettingsChanges("), context);
  const previous = { project_id: "old-project", context_token: "old-token" };
  await assert.rejects(context.stopBackendManagedServices(previous, true), /could not stop safely/);
  assert.equal(calls[0][3], 20000); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].headers["X-Noda-Project-Context"], previous.context_token);
  assert.equal(context.managedQdrantPid, 999999);

  context.backendHttpReadyConfirmed = false;
  await context.stopBackendManagedServices();
  await assert.rejects(context.stopBackendManagedServices(previous, true), /could not stop safely/);
  assert.equal(calls.length, 1, "A foreign port must not receive shutdown requests");
});

test("actual main generation IPC executes sender guard and context fences around runtime readiness", () => fixture(async h => {
  h.start(); const state = await h.invoke("get-projects"), handlers = new Map();
  const context = { projects: () => h.bridge, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isGenerationSender: policy.isGenerationSender, isNotesWindowSender: event => event.sender === h.notes.webContents,
    isStartupWindowSender: () => false, quickWindow: h.quick, notesWindow: h.notes,
    denyInvalidNotesSender: () => ({ ok: false, code: "invalid_sender" }), ensureChatRuntimeReady: policy.ensureChatRuntimeReady,
    ensureGenerationRuntimeReady: policy.ensureGenerationRuntimeReady, ensureBackendReady: async () => {},
    fetchRuntimeConfig: async () => ({ provider: "local" }), ensureManagedRuntimeReady: async () => {},
    readJsonResponse: response => response.json(), BACKEND_URL: origin, startupBroadcastSuppressionDepth: 0 };
  vm.runInNewContext(section(main, 'projects().register(ipcMain);', '\nipcMain.handle("quick-note:get-startup-status"'), context);
  const generation = handlers.get("quick-note:ensure-generation-runtime");
  assert.equal((await generation({ sender: {} }, { ...payload(state), prompt: "text" })).code, "invalid_sender");
  await assert.rejects(generation(h.event(h.quick), { prompt: "missing context" }), { code: "project_changed" });
  assert.equal((await generation(h.event(h.quick), { ...payload(state), prompt: "text" })).ok, true);
  const gate = deferred(); context.ensureBackendReady = () => gate.promise;
  const pending = generation(h.event(h.quick), { ...payload(state), prompt: "old text" });
  await h.invoke("switch-project", h.initial.projects[1].id); gate.resolve();
  await assert.rejects(pending, { code: "project_changed" });
}));

test("actual startup chooser skips only available project folders and explains disconnected roots in RU/EN", async () => {
  for (const language of ["ru", "en"]) await fixture(async h => {
    const statuses = []; let shown = 0;
    const context = { projects: () => h.bridge, normalizeNotesDirectory, desktopSettings: { notesDirectory: h.a, skipNotesDirectorySelection: true },
      AUTO_QUIT_AFTER_READY_MS: 0, PORTABLE_RUNTIME: null, startupNotesDirectorySelectionPromise: null, startupNotesDirectorySelection: null,
      broadcastStartupStatus: value => statuses.push(value), showStartupWindow: () => { shown += 1; },
      uiText: (ru, en) => language === "en" ? en : ru };
    vm.createContext(context);
    vm.runInContext(section(main, "async function waitForStartupNotesDirectory()", "\nasync function waitForStartupSurfaceReady()"), context);
    const before = fs.readFileSync(h.file);
    assert.equal(await context.waitForStartupNotesDirectory(), h.a);
    assert.equal(shown, 0); assert.equal(statuses.length, 0);
    fs.renameSync(h.a, path.join(h.root, "offline-A"));
    const pending = context.waitForStartupNotesDirectory();
    const second = context.waitForStartupNotesDirectory();
    assert.equal(shown, 1); assert.equal(statuses[0].phase, "notes-directory-select");
    assert.match(statuses[0].detail, language === "en" ? /saved folder is unavailable/ : /Сохранённая папка недоступна/);
    assert.equal(context.startupNotesDirectorySelection.selectedDirectory, "");
    assert.deepEqual(fs.readFileSync(h.file), before);
    context.startupNotesDirectorySelection.resolve(h.b);
    assert.equal(await pending, h.b); assert.equal(await second, h.b);
    assert.equal(context.startupNotesDirectorySelectionPromise, null);
    assert.deepEqual(fs.readFileSync(h.file), before);
  });
});

test("bridge mutations require context, serialize conflicting changes and release the lock on failure", () => fixture(async h => {
  h.start(); const state = await h.invoke("get-projects"); let operations = 0;
  for (const candidate of [undefined, null, {}, { ...payload(state), contextToken: "wrong" }]) {
    await assert.rejects(h.bridge.runMutationWithContext(candidate, async () => { operations += 1; }), { code: "project_changed" });
  }
  assert.equal(operations, 0); assert.equal(h.busy, false);
  const gate = deferred();
  const pending = h.bridge.runMutationWithContext(payload(state), async () => { operations += 1; await gate.promise; return "saved"; });
  assert.equal(h.busy, true);
  await assert.rejects(h.bridge.runMutationWithContext(payload(state), async () => { operations += 1; }), { code: "project_busy" });
  assert.equal((await h.invoke("switch-project", h.initial.projects[1].id)).code, "project_busy");
  assert.equal(h.restartCalls, 0); assert.deepEqual(h.registry.load(), h.initial);
  gate.resolve(); assert.equal(await pending, "saved"); assert.equal(h.busy, false);
  await assert.rejects(h.bridge.runMutationWithContext(payload(state), async () => { throw new Error("synthetic write failure"); }), /synthetic write failure/);
  assert.equal(h.busy, false);
  assert.equal((await h.invoke("switch-project", h.initial.projects[1].id)).ok, true);
  assert.equal(operations, 1);
}));

test("actual main runtime update requires context before side effects and holds switch lock through awaited mutation", () => fixture(async h => {
  h.start(); const state = await h.invoke("get-projects"), operations = [], gate = deferred(); let handler, fail = false;
  const context = { projects: () => h.bridge, quickWindow: h.quick, notesWindow: h.notes,
    ipcMain: { handle: (channel, callback) => { assert.equal(channel, "quick-note:update-runtime-config"); handler = callback; } },
    isGenerationSender: policy.isGenerationSender, denyInvalidNotesSender: () => ({ ok: false, code: "invalid_sender" }),
    updateRuntimeConfig: async runtime => { operations.push(JSON.parse(JSON.stringify(runtime))); if (fail) throw new Error("synthetic update failed"); await gate.promise; return { ok: true }; } };
  vm.runInNewContext(section(main, 'ipcMain.handle("quick-note:update-runtime-config"', '\nipcMain.handle("quick-note:get-app-settings"'), context);
  const event = h.event(h.quick);
  for (const value of [undefined, {}, { turboquant: true }, { ...payload(state), contextToken: "wrong" }, { ...payload(state), projectId: "wrong" }]) {
    await assert.rejects(handler(event, value), { code: "project_changed" });
  }
  assert.equal((await handler({ sender: {} }, payload(state))).code, "invalid_sender");
  assert.equal(operations.length, 0); assert.equal(h.busy, false);
  const pending = handler(event, { ...payload(state), turboquant_enabled: true });
  assert.equal(h.busy, true);
  assert.deepEqual(operations, [{ turboquant_enabled: true }]);
  assert.equal((await h.invoke("switch-project", h.initial.projects[1].id)).code, "project_busy");
  assert.equal(h.restartCalls, 0);
  gate.resolve(); assert.equal((await pending).ok, true); assert.equal(h.busy, false);
  fail = true;
  await assert.rejects(handler(event, { ...payload(state), turboquant_enabled: false }), /synthetic update failed/);
  assert.equal(h.busy, false);
  assert.equal((await h.invoke("switch-project", h.initial.projects[1].id)).ok, true);
  const count = operations.length;
  await assert.rejects(handler(event, { ...payload(state), turboquant_enabled: true }), { code: "project_changed" });
  assert.equal(operations.length, count);
}));

test("actual main runtime update preserves explicit trusted legacy without creating project registry", () => fixture(async h => {
  let handler, updated;
  const context = { projects: () => h.bridge, quickWindow: h.quick, notesWindow: h.notes,
    ipcMain: { handle: (_, callback) => { handler = callback; } }, isGenerationSender: policy.isGenerationSender,
    denyInvalidNotesSender: () => ({ ok: false }), updateRuntimeConfig: async value => { updated = value; return { ok: true }; } };
  vm.runInNewContext(section(main, 'ipcMain.handle("quick-note:update-runtime-config"', '\nipcMain.handle("quick-note:get-app-settings"'), context);
  assert.equal((await handler(h.event(h.quick), { turboquant_enabled: true })).ok, true);
  assert.equal(updated.turboquant_enabled, true); assert.equal(h.busy, false);
  assert.equal(fs.existsSync(h.file), false);
}, { owned: true }));

test("actual settings IPCs reject missing or stale context, strip IDs and preserve lock ownership", () => fixture(async h => {
  h.start(); const state = await h.invoke("get-projects"), handlers = new Map(), effects = []; let failing = false;
  const effect = async (kind, value) => {
    assert.equal(h.busy, kind === "pairs", "save/model retain inner lock ownership; pairs use bridge mutation lock");
    effects.push([kind, JSON.parse(JSON.stringify(value))]);
    if (failing) throw new Error("synthetic settings failure");
    return { ok: true };
  };
  const context = { projects: () => h.bridge, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isNotesWindowSender: event => event.sender === h.notes.webContents,
    denyInvalidNotesSender: () => ({ ok: false, code: "invalid_sender" }), OWNED_NOTE_PROFILE: null,
    assertProfileMutable: () => {}, ensureBackendHttpReady: async () => {},
    BACKEND_URL: "http://127.0.0.1:5000", fetchWithTimeout: async () => assert.fail("unexpected fetch"),
    NoteModelDownloadError, runModelDownload: (_sender, task) => task(new AbortController().signal),
    prepareNoteModels: async () => assert.equal(h.busy, true),
    saveDesktopSettingsFromRenderer: value => effect("save", value), applySettingsModelSelection: value => effect("model", value),
    postNotePairSelection: value => effect("pairs", value) };
  vm.runInNewContext(section(main, 'ipcMain.handle("quick-note:save-app-settings"', '\nipcMain.handle("quick-note:close-startup-window"'), context);
  for (const [channel, kind] of [["save-app-settings", "save"], ["apply-settings-model", "model"], ["apply-settings-note-pairs", "pairs"]]) {
    const handler = handlers.get(`quick-note:${channel}`), count = effects.length;
    for (const value of [undefined, {}, { data: "missing" }, { ...payload(state), contextToken: "wrong" }, { ...payload(state), projectId: "wrong" }]) {
      await assert.rejects(handler(h.event(h.notes), value), { code: "project_changed" });
    }
    assert.equal((await handler(h.event(h.quick), payload(state))).code, "invalid_sender");
    assert.equal(effects.length, count); assert.equal(h.busy, false);
    assert.equal((await handler(h.event(h.notes), { ...payload(state), data: channel })).ok, true);
    assert.deepEqual(effects.at(-1), [kind, { data: channel }]); assert.equal(h.busy, false);
    failing = true;
    await assert.rejects(handler(h.event(h.notes), { ...payload(state), data: "failed" }), /synthetic settings failure/);
    failing = false; assert.equal(h.busy, false);
  }
  const count = effects.length;
  await h.invoke("switch-project", h.initial.projects[1].id);
  for (const handler of handlers.values()) await assert.rejects(handler(h.event(h.notes), { ...payload(state), data: "delayed A" }), { code: "project_changed" });
  assert.equal(effects.length, count);
}));
