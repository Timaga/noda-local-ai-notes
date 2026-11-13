const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createDesktopProjects } = require("../frontend/desktop_projects");
const { createDesktopProjectController } = require("../frontend/desktop_project_controller");

const fault = code => Object.assign(new Error(code), { code });
const request = context => ({ projectId: context.project_id, contextToken: context.context_token });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(run, { empty = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "noda-project-controller-")));
  const a = path.join(root, "A"), b = path.join(root, "B");
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, "CRM.md"), "Source from project A");
  fs.writeFileSync(path.join(b, "CRM.md"), "Source from project B");
  let id = 0, token = 100;
  const file = path.join(root, "profile", "projects.json");
  const registry = createDesktopProjects(file, { idFactory: () => (++id).toString(16).padStart(32, "0") });
  let initial;
  if (!empty) {
    const first = registry.bootstrap({ name: "A", notesDirectory: a, collectionName: "old_notes" });
    initial = registry.commit(first, registry.activate(registry.addExisting(first, { name: "B", notesDirectory: b }), first.activeProjectId));
  }
  const environment = {};
  const h = { root, a, b, file, registry, initial, environment, events: [], calls: [], busy: false,
    options: {}, prefs: a, restartCount: 0, persistCount: 0, stopCount: 0, activations: [] };
  const wrapped = { ...registry, commit(previous, next) {
    h.calls.push(["commit", next.activeProjectId]);
    if (h.commitError) throw h.commitError;
    return registry.commit(previous, next);
  } };
  const options = {
    registry: wrapped, environment, storageRoot: path.join(root, "project-storage"), legacyCollection: "old_notes",
    makeToken: () => (++token).toString(16).padStart(32, "0"),
    prepareSwitch: async context => {
      h.calls.push(["prepare", { ...context }]);
      if (h.onPrepare) await h.onPrepare(context);
    },
    cancelSwitch: async context => {
      h.calls.push(["cancel", { ...context }]);
      if (h.cancelError) throw h.cancelError;
    },
    stopBackend: async context => {
      h.stopCount += 1;
      h.calls.push(["stop", { context: { ...context }, environment: { ...environment } }]);
      if (h.onStop) await h.onStop(h.stopCount);
    },
    restartBackend: async boundaries => {
      h.restartCount += 1;
      h.calls.push(["restart", { ...environment }, boundaries]);
      if (h.onRestart) await h.onRestart(h.restartCount);
      return { ready: true };
    },
    activateBackend: async context => {
      h.calls.push(["activate", { ...context }]);
      assert.equal(registry.load().activeProjectId, context.project_id, "queued work may activate only after registry commit");
      if (h.onActivate) await h.onActivate(context);
      h.activations.push({ ...context });
    },
    completeBackendStart: async () => { h.calls.push(["runtime-ready"]); },
    readContext: async () => {
      const normalized = process.platform === "win32" ? path.resolve(environment.NOTES_DIR).toLowerCase() : path.resolve(environment.NOTES_DIR);
      const result = { ready: true, project_id: environment.NODA_PROJECT_ID,
        context_token: environment.NODA_PROJECT_CONTEXT, collection_name: environment.QDRANT_COLLECTION_NAME,
        root_sha256: crypto.createHash("sha256").update(normalized).digest("hex"), vault_id: "f".repeat(32) };
      h.calls.push(["verify", { ...result }]);
      return h.contextReply ? h.contextReply(result) : result;
    },
    persistDirectory: async directory => {
      h.persistCount += 1;
      h.calls.push(["prefs", directory]);
      if (h.onPersist) await h.onPersist(directory, h.persistCount);
      h.prefs = directory;
      fs.writeFileSync(path.join(root, "preferences.json"), JSON.stringify({ directory }));
    },
    emit: state => h.events.push(state), isBusy: () => h.busy,
    setBusy: value => h.calls.push(["busy", value]),
  };
  h.options = options;
  h.create = overrides => createDesktopProjectController({ ...options, ...overrides });
  h.controller = h.create();
  h.start = directory => h.controller.startup(directory || a);
  try { await run(h); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("runtime completion callback is mandatory before any project startup", () => fixture(async h => {
  assert.throws(() => h.create({ completeBackendStart: undefined }), /completion callback is required/);
}));

test("bootstrap imports in place and startup binds exact project storage and header context", () => fixture(async h => {
  assert.equal(h.controller.restoredDirectory(), null);
  assert.equal(h.controller.directoryAvailable(h.a), true);
  assert.equal(fs.existsSync(h.file), false);
  assert.deepEqual(h.controller.snapshot().projects, []);
  const binding = h.start();
  const view = h.controller.snapshot();
  assert.equal(view.activeProject.name, "A");
  assert.equal(view.activeProject.legacyChatStorage, true);
  assert.equal(view.activeProject.noteCount, null);
  assert.equal(h.environment.NOTES_DIR, h.a);
  assert.equal(h.environment.QDRANT_COLLECTION_NAME, "old_notes");
  assert.equal(h.environment.NODA_PROJECT_LEGACY, "1");
  assert.equal(h.environment.NODA_PROJECT_STORAGE, path.join(h.root, "project-storage", view.activeProjectId));
  assert.deepEqual(view.context, binding.context);
  h.controller.assertContext(request(view.context));
  assert.equal((await h.controller.verifyBackend()).project_id, view.activeProjectId);
  assert.equal(h.start(h.b), binding);
  assert.equal(fs.readFileSync(path.join(h.a, "CRM.md"), "utf8"), "Source from project A");
  assert.equal(h.restartCount, 0);
}, { empty: true }));

test("startup restores persisted active project and accepts explicit existing/new folder without duplication", () => fixture(async h => {
  h.start(h.b);
  assert.equal(h.registry.load().projects.length, 2);
  assert.equal(h.controller.restoredDirectory(), h.b);
  assert.equal(h.controller.snapshot().activeProject.legacyChatStorage, false);
  assert.equal(h.environment.NODA_PROJECT_LEGACY, "0");
  const restored = h.create();
  assert.equal(restored.restoredDirectory(), h.b);
  restored.startup(h.b);
  const extra = path.join(h.root, "C"); fs.mkdirSync(extra);
  const explicit = h.create(); explicit.startup(extra);
  assert.equal(h.registry.load().projects.length, 3);
  assert.equal(h.registry.load().projects[2].notesDirectory, extra);
}));

test("switch A→B→A rotates tokens and keeps same-filename sources and counts isolated", () => fixture(async h => {
  h.start();
  const aContext = h.controller.snapshot().context;
  h.controller.reportCount({ ...request(aContext), count: 1 });
  h.calls.length = 0;
  const b = h.initial.projects[1];
  const switched = await h.controller.switchProject(b.id);
  assert.equal(switched.ok, true);
  assert.equal(switched.activeProjectId, b.id);
  assert.equal(switched.activeProject.noteCount, null);
  assert.notEqual(switched.context.context_token, aContext.context_token);
  assert.deepEqual(h.calls.map(call => call[0]), ["busy", "prepare", "stop", "restart", "verify", "prefs", "commit", "activate", "runtime-ready", "busy"]);
  assert.deepEqual(h.calls.find(call => call[0] === "stop")[1].context, aContext);
  assert.equal(h.calls.find(call => call[0] === "stop")[1].environment.NOTES_DIR, h.a);
  assert.equal(h.calls.find(call => call[0] === "restart")[1].NOTES_DIR, h.b);
  assert.equal(h.prefs, h.b);
  assert.equal(h.registry.load().activeProjectId, b.id);
  assert.equal(h.events.at(-2).status, "switching");
  assert.equal(h.events.at(-2).pendingProjectId, b.id);
  assert.equal(h.events.at(-1).status, "ready");
  assert.throws(() => h.controller.assertContext(request(aContext)), { code: "project_changed" });
  h.controller.reportCount({ ...request(switched.context), count: 0 });
  const returned = await h.controller.switchProject(h.initial.activeProjectId);
  assert.equal(returned.activeProject.noteCount, 1);
  assert.equal(returned.projects[1].noteCount, 0);
  assert.notEqual(returned.context.context_token, aContext.context_token);
  assert.throws(() => h.controller.reportCount({ ...request(aContext), count: 99 }), { code: "project_changed" });
  assert.equal(fs.readFileSync(path.join(h.a, "CRM.md"), "utf8"), "Source from project A");
  assert.equal(fs.readFileSync(path.join(h.b, "CRM.md"), "utf8"), "Source from project B");
}));

test("backend handshake rejects wrong readiness, project, token, collection, root and vault identity", () => fixture(async h => {
  h.start();
  for (const change of [
    value => ({ ...value, ready: false }), value => ({ ...value, project_id: "0".repeat(32) }),
    value => ({ ...value, context_token: "0".repeat(32) }), value => ({ ...value, collection_name: "foreign" }),
    value => ({ ...value, root_sha256: "0".repeat(64) }), value => ({ ...value, vault_id: "wrong" }),
    () => null,
  ]) {
    h.contextReply = change;
    await assert.rejects(h.controller.verifyBackend(), { code: "project_context_invalid" });
  }
  const badToken = h.create({ makeToken: () => "INVALID" });
  assert.throws(() => badToken.startup(h.a), { code: "project_context_invalid" });
  assert.equal(h.registry.load().activeProjectId, h.initial.activeProjectId);
}));

test("unknown IDs, same active selection, missing directories and malformed create payloads have no side effects", () => fixture(async h => {
  h.start();
  const before = fs.readFileSync(h.file);
  assert.equal((await h.controller.switchProject("missing")).code, "UNKNOWN_PROJECT");
  assert.equal((await h.controller.switchProject(h.initial.activeProjectId)).ok, true);
  assert.equal((await h.controller.connectProject(async () => path.join(h.root, "missing"))).code, "ENOENT");
  let picked = 0;
  for (const payload of [null, {}, { name: " " }, { name: 4 }, { name: "x", extra: true }, { name: "x".repeat(121) }]) {
    assert.equal((await h.controller.createProject(payload, async () => { picked += 1; return h.root; })).code, "INVALID_NAME");
  }
  assert.equal(picked, 0);
  assert.equal(h.restartCount, 0);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.equal(h.calls.some(call => call[0] === "prepare"), false);
}));

test("external busy, pending native picker and cancellation serialize actions without writes", () => fixture(async h => {
  h.start(); const context = h.controller.snapshot().context;
  const before = fs.readFileSync(h.file);
  h.busy = true;
  assert.equal((await h.controller.switchProject(h.initial.projects[1].id)).code, "project_busy");
  h.busy = false;
  const selected = deferred();
  const pending = h.controller.connectProject(() => selected.promise);
  assert.equal(h.controller.isTransitioning(), true);
  assert.throws(() => h.controller.assertContext(request(context)), { code: "project_changed" });
  assert.equal((await h.controller.switchProject(h.initial.projects[1].id)).code, "project_busy");
  selected.resolve(null);
  assert.equal((await pending).canceled, true);
  assert.equal((await h.controller.createProject({ name: "Cancelled" }, async () => null)).canceled, true);
  assert.equal(h.controller.isTransitioning(), false);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.equal(h.calls.some(call => call[0] === "prepare"), false);
  assert.equal(h.restartCount, 0);
}));

test("connect existing project deduplicates canonical case and new folders acquire separate collections", () => fixture(async h => {
  h.start();
  const selected = process.platform === "win32" ? h.b.toUpperCase() : h.b;
  assert.equal((await h.controller.connectProject(async () => selected)).activeProjectId, h.initial.projects[1].id);
  assert.equal(h.registry.load().projects.length, 2);
  const directory = path.join(h.root, "Connected"); fs.mkdirSync(directory);
  const added = await h.controller.connectProject(async () => directory);
  assert.equal(added.projects.length, 3);
  assert.equal(added.activeProject.notesDirectory, directory);
  assert.equal(added.activeProject.collectionName, `noda_project_${added.activeProjectId}`);
  assert.equal(added.activeProject.noteCount, null);
}));

test("create waits for successful backend preflight before mkdir, registry or preference writes", () => fixture(async h => {
  h.start();
  const target = path.join(h.root, "Created");
  const before = fs.readFileSync(h.file);
  const freeze = deferred();
  const reached = deferred();
  h.onPrepare = () => { reached.resolve(); return freeze.promise; };
  const pending = h.controller.createProject({ name: "  Created  " }, async () => h.root);
  await reached.promise;
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.equal(h.persistCount, 0);
  freeze.resolve();
  const created = await pending;
  assert.equal(created.ok, true);
  assert.equal(created.activeProject.notesDirectory, target);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(h.registry.load().projects.length, 3);
}));

test("busy preflight refuses creation before filesystem mutation and thaws original context", () => fixture(async h => {
  h.start(); const context = h.controller.snapshot().context;
  const before = fs.readFileSync(h.file);
  h.onPrepare = () => { throw fault("project_busy"); };
  const reply = await h.controller.createProject({ name: "Refused" }, async () => h.root);
  assert.equal(reply.code, "project_busy");
  assert.equal(fs.existsSync(path.join(h.root, "Refused")), false);
  assert.equal(h.restartCount, 0);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.deepEqual(h.calls.find(call => call[0] === "cancel")[1], context);
  h.controller.assertContext(request(context));
}));

test("preflight timeout with failed thaw enters fail-closed error state without restart", () => fixture(async h => {
  h.start(); const context = h.controller.snapshot().context;
  h.onPrepare = () => { throw fault("ETIMEDOUT"); };
  h.cancelError = fault("ECONNREFUSED");
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_switch_unconfirmed");
  assert.equal(reply.status, "error");
  assert.equal(reply.context, null);
  assert.equal(h.restartCount, 0);
  assert.throws(() => h.controller.assertContext(request(context)), { code: "project_changed" });
  assert.equal((await h.controller.switchProject(h.initial.projects[1].id)).code, "project_busy");
}));

test("preflight timeout with successful thaw preserves old project and source", () => fixture(async h => {
  h.start(); const context = h.controller.snapshot().context;
  h.onPrepare = () => { throw fault("ETIMEDOUT"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "ETIMEDOUT");
  assert.equal(reply.status, "ready");
  assert.deepEqual(reply.context, context);
  h.controller.assertContext(request(context));
  assert.equal(h.restartCount, 0);
}));

test("create validation after freeze cancels admissions and leaves registry untouched", () => fixture(async h => {
  h.start(); const before = fs.readFileSync(h.file);
  for (const name of ["../escape", "CON", "A"]) {
    const reply = await h.controller.createProject({ name }, async () => h.root);
    assert.equal(reply.ok, false);
    assert.equal(reply.status, "ready");
  }
  assert.equal(h.calls.filter(call => call[0] === "cancel").length, 3);
  assert.equal(h.restartCount, 0);
  assert.deepEqual(fs.readFileSync(h.file), before);
  h.cancelError = fault("EIO");
  const failed = await h.controller.createProject({ name: "../escape" }, async () => h.root);
  assert.equal(failed.status, "error");
  assert.equal(failed.context, null);
}));

test("existing folder create offers connect guidance and overlap connect is refused without restart", () => fixture(async h => {
  h.start();
  fs.mkdirSync(path.join(h.root, "Existing"));
  const exists = await h.controller.createProject({ name: "Existing" }, async () => h.root);
  assert.equal(exists.code, "EEXIST");
  assert.match(exists.error, /существует/);
  const overlap = await h.controller.connectProject(async () => h.root);
  assert.equal(overlap.code, "OVERLAPPING_DIRECTORIES");
  assert.match(overlap.error, /отдельными/);
  assert.equal(h.restartCount, 0);
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("created empty folder remains honest on failed target startup without adding registry entry", () => fixture(async h => {
  h.start();
  h.onRestart = count => { if (count === 1) throw fault("backend_start_failed"); };
  const reply = await h.controller.createProject({ name: "Unopened" }, async () => h.root);
  assert.equal(reply.code, "project_switch_failed");
  assert.equal(reply.activeProjectId, h.initial.activeProjectId);
  assert.deepEqual(fs.readdirSync(path.join(h.root, "Unopened")), []);
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("busy refusal never freezes backend even when redundant cancel is unavailable", () => fixture(async h => {
  h.start(); const context = h.controller.snapshot().context;
  h.onPrepare = () => { throw fault("project_busy"); };
  h.cancelError = fault("unavailable");
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_busy");
  assert.equal(reply.status, "ready");
  assert.deepEqual(reply.context, context);
  assert.equal(h.restartCount, 0);
  h.controller.assertContext(request(context));
}));

test("production default busy hooks and cryptographic tokens permit independent switch", () => fixture(async h => {
  const controller = h.create({ makeToken: undefined, isBusy: undefined, setBusy: undefined, text: undefined });
  controller.startup(h.a);
  const initial = controller.snapshot().context;
  assert.match(initial.context_token, /^[a-f0-9]{32}$/);
  const reply = await controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.ok, true);
  assert.notEqual(reply.context.context_token, initial.context_token);
}));

test("target startup failure rolls back with fresh old-project token and no preference commit", () => fixture(async h => {
  h.start(); const context = h.controller.snapshot().context;
  const before = fs.readFileSync(h.file);
  h.onRestart = count => { if (count === 1) throw fault("backend_start_failed"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_switch_failed");
  assert.equal(reply.status, "ready");
  assert.equal(reply.activeProjectId, h.initial.activeProjectId);
  assert.notEqual(reply.context.context_token, context.context_token);
  assert.equal(h.environment.NOTES_DIR, h.a);
  assert.equal(h.persistCount, 0);
  assert.deepEqual(fs.readFileSync(h.file), before);
  h.controller.assertContext(request(reply.context));
}));

test("invalid target handshake never persists and old backend is restored", () => fixture(async h => {
  h.start();
  h.contextReply = value => h.environment.NOTES_DIR === h.b ? { ...value, collection_name: "wrong" } : value;
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_switch_failed");
  assert.equal(reply.activeProjectId, h.initial.activeProjectId);
  assert.equal(h.restartCount, 2);
  assert.equal(h.persistCount, 0);
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("preference write failure rolls backend back without committing registry", () => fixture(async h => {
  h.start();
  h.onPersist = () => { throw fault("disk_full"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_switch_failed");
  assert.equal(reply.status, "ready");
  assert.equal(h.prefs, h.a);
  assert.equal(h.environment.NOTES_DIR, h.a);
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("registry commit failure restores preferences and backend; rollback failure fails closed", () => fixture(async h => {
  h.start();
  h.commitError = fault("disk_full");
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_switch_failed");
  assert.equal(h.prefs, h.a);
  assert.deepEqual(h.calls.filter(call => call[0] === "prefs").map(call => call[1]), [h.b, h.a]);
  assert.deepEqual(h.registry.load(), h.initial);
  h.onRestart = () => { throw fault("backend_dead"); };
  const broken = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(broken.code, "project_rollback_failed");
  assert.equal(broken.status, "error");
  assert.equal(broken.context, null);
  assert.equal(h.controller.isTransitioning(), true);
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("failed preference restoration after registry refusal fails closed", () => fixture(async h => {
  h.start(); h.commitError = fault("disk_full");
  h.onPersist = (_, count) => { if (count === 2) throw fault("restore_denied"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_rollback_failed");
  assert.equal(reply.context, null);
  assert.equal(reply.status, "error");
  assert.deepEqual(h.registry.load(), h.initial);
}));

test("count reports require exact current context, bounded integer and avoid redundant commits", () => fixture(async h => {
  await assert.rejects(h.controller.switchProject(h.initial.projects[1].id), { code: "project_not_ready" });
  assert.throws(() => h.controller.assertContext({}), { code: "project_changed" });
  h.start(); const context = h.controller.snapshot().context;
  for (const payload of [null, {}, { projectId: context.project_id }, { ...request(context), contextToken: "wrong" }]) {
    assert.throws(() => h.controller.reportCount(payload), { code: "project_changed" });
  }
  for (const count of [-1, 0.5, 1000001, Number.NaN, Infinity, "1", null, undefined]) {
    assert.throws(() => h.controller.reportCount({ ...request(context), count }), { code: "invalid_project_count" });
  }
  h.controller.reportCount({ ...request(context), count: 1000000 });
  const commits = h.calls.filter(call => call[0] === "commit").length;
  assert.equal(h.controller.reportCount({ ...request(context), count: 1000000 }).activeProject.noteCount, 1000000);
  assert.equal(h.calls.filter(call => call[0] === "commit").length, commits);
}));

test("initial activation uses launch binding and is skipped before binding or during a switch", () => fixture(async h => {
  assert.equal(h.controller.backendContext(), null);
  await h.controller.activateInitial(); assert.equal(h.activations.length, 0);
  h.start();
  assert.deepEqual(h.controller.backendContext(), h.controller.snapshot().context);
  await h.controller.activateInitial(); assert.equal(h.activations.length, 1);
  const pause = deferred(), reached = deferred();
  h.onPrepare = () => { reached.resolve(); return pause.promise; };
  const pending = h.controller.switchProject(h.initial.projects[1].id);
  await reached.promise;
  await h.controller.activateInitial(); assert.equal(h.activations.length, 1);
  pause.resolve(); await pending;
  assert.equal(h.activations.length, 2);
}));

test("unknown activation after commit preserves new registry and fails closed without rollback", () => fixture(async h => {
  h.start();
  h.onActivate = () => { throw fault("ETIMEDOUT"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_activation_failed");
  assert.equal(reply.status, "error"); assert.equal(reply.context, null);
  assert.equal(reply.activeProjectId, h.initial.projects[1].id);
  assert.equal(h.registry.load().activeProjectId, h.initial.projects[1].id);
  assert.equal(h.prefs, h.b); assert.equal(h.environment.NOTES_DIR, h.b);
  assert.equal(h.restartCount, 1); assert.equal(h.stopCount, 1);
  assert.equal(h.activations.length, 0);
  await h.controller.activateInitial(); assert.equal(h.calls.filter(call => call[0] === "activate").length, 1);
}));

test("stop refusal never binds target and rollback reactivates old verified context", () => fixture(async h => {
  h.start(); const original = h.controller.backendContext();
  h.onStop = number => { if (number === 1) throw fault("shutdown_unconfirmed"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_switch_failed"); assert.equal(reply.activeProjectId, h.initial.activeProjectId);
  assert.equal(h.stopCount, 2); assert.equal(h.restartCount, 1);
  const stopped = h.calls.filter(call => call[0] === "stop");
  assert.ok(stopped.every(call => call[1].environment.NOTES_DIR === h.a));
  assert.ok(stopped.every(call => call[1].context.context_token === original.context_token));
  assert.equal(h.activations[0].project_id, h.initial.activeProjectId);
  assert.notEqual(h.activations[0].context_token, original.context_token);
}));

test("failed rollback activation does not announce old project ready", () => fixture(async h => {
  h.start(); h.commitError = fault("disk_full");
  h.onActivate = () => { throw fault("activation_unconfirmed"); };
  const reply = await h.controller.switchProject(h.initial.projects[1].id);
  assert.equal(reply.code, "project_rollback_failed"); assert.equal(reply.context, null);
  assert.equal(reply.status, "error"); assert.deepEqual(h.registry.load(), h.initial);
  assert.equal(h.activations.length, 0);
}));

test("startup availability checks existing, missing and linked project roots without registry writes", () => fixture(async h => {
  const before = fs.readFileSync(h.file);
  assert.equal(h.controller.directoryAvailable(h.a), true);
  assert.equal(h.controller.directoryAvailable(h.b), true);
  assert.equal(h.controller.directoryAvailable(h.root), false);
  fs.renameSync(h.a, path.join(h.root, "disconnected-A"));
  assert.equal(h.controller.directoryAvailable(h.a), false);
  assert.equal(h.controller.directoryAvailable(h.b), true);
  fs.symlinkSync(h.b, h.a, process.platform === "win32" ? "junction" : "dir");
  assert.equal(h.controller.directoryAvailable(h.a), false);
  assert.equal(h.controller.restoredDirectory(), h.a);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.equal(h.restartCount, 0);
}));
