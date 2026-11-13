"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createProjectContext } = require("../../frontend/project_context");
const source = fs.readFileSync(path.join(__dirname, "../../frontend/project_context.js"), "utf8");
const A = "a".repeat(32), B = "b".repeat(32), TA = "1".repeat(32), TB = "2".repeat(32);
const entry = id => ({ id, name: id === A ? "A" : "B", notesDirectory: `/synthetic/${id}`,
  collectionName: `noda_project_${id}`, legacy: false, noteCount: null });
const dto = (id = A, token = TA, status = "ready") => ({ ok: true, mode: "projects", status,
  projects: [entry(id)], activeProjectId: id, activeProject: { ...entry(id), legacyChatStorage: false },
  context: { project_id: id, context_token: token } });
const legacy = () => ({ ok: true, mode: "legacy", status: "ready", projects: [],
  activeProjectId: null, activeProject: null, context: null });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
function fixture(initial = dto(), options = {}) {
  let listener, unsubscribed = 0;
  const calls = [];
  const bridge = { getProjects: () => Promise.resolve(initial), onProjectState(callback) {
    listener = callback; return () => { unsubscribed += 1; };
  } };
  const context = createProjectContext({ bridge, fetch: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ value: "A" }));
  }, ...options });
  return { context, calls, emit: value => listener(value), get unsubscribed() { return unsubscribed; } };
}
function browser(extra = {}) {
  const timers = new Map(), events = new Map();
  let timerId = 0;
  const window = { Headers, AbortController, fetch: async () => new Response("browser"),
    console: { warn() {} }, setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), addEventListener: (event, callback) => events.set(event, callback), ...extra };
  vm.runInNewContext(source, { window, URL }, { filename: path.join(__dirname, "../../frontend/project_context.js") });
  return { context: window.NodaProjectContext, window, timers, events };
}

test("ready snapshot is deeply immutable and subscriptions receive immediate state", async () => {
  const payload = dto();
  const f = fixture(payload), observed = [];
  const unsubscribe = f.context.subscribe(state => observed.push(state));
  assert.equal(observed[0].status, "switching");
  const current = await f.context.ready();
  payload.projects[0].name = "mutated";
  assert.equal(current.projectState.projects[0].name, "A");
  assert.ok(Object.isFrozen(current) && Object.isFrozen(current.projectState.projects[0]));
  assert.equal(f.context.isCurrent(current), true);
  unsubscribe(); const count = observed.length;
  f.emit(dto(B, TB));
  assert.equal(observed.length, count);
  assert.equal(f.context.isCurrent(current), false);
  f.context.dispose();
  assert.equal(f.unsubscribed, 1);
});

test("invalid and inconsistent desktop DTOs fail closed", async () => {
  for (const change of [
    value => ({ ...value, ok: false }), value => ({ ...value, status: "unknown" }),
    value => ({ ...value, mode: "foreign" }), value => ({ ...value, activeProjectId: "wrong" }),
    value => ({ ...value, context: { ...value.context, context_token: "wrong" } }),
    value => ({ ...value, context: { ...value.context, project_id: B } }),
    value => ({ ...value, activeProject: { ...value.activeProject, id: B } }),
    value => ({ ...value, activeProject: { id: A, legacyChatStorage: true, legacy: false } }),
    value => ({ ...value, activeProject: { id: A } }),
    value => ({ ...value, projects: [value.projects[0], value.projects[0]] }),
    value => ({ ...value, projects: [] }), value => ({ ...value, projects: {} }),
    () => null,
  ]) {
    const f = fixture(change(dto()));
    await assert.rejects(f.context.ready(), { code: "project_context_unavailable" });
    assert.equal(f.context.snapshot().status, "error");
    await assert.rejects(f.context.fetch("/notes"), { code: "project_context_unavailable" });
    f.context.dispose();
  }
});

test("switching blocks requests and error drops context; legacy downgrade is forbidden", async () => {
  const f = fixture();
  const previous = await f.context.ready();
  f.emit(dto(A, TA, "switching"));
  await assert.rejects(f.context.fetch("/notes"), { code: "project_switching" });
  assert.equal(f.context.isCurrent(previous), false);
  f.emit({ ...dto(), status: "error", context: null });
  assert.equal(f.context.snapshot().contextToken, null);
  f.emit(legacy());
  assert.equal(f.context.snapshot().status, "error");
  f.emit(dto(B, TB));
  assert.equal(f.context.snapshot().projectId, B);
  f.context.dispose();
});

test("trusted bridge legacy and browser without a bridge remain explicit unscoped modes", async () => {
  const f = fixture(legacy());
  assert.equal((await f.context.ready()).legacyChatStorage, true);
  await f.context.fetch("/notes", { headers: { "X-Noda-Project-Id": A, "X-Noda-Project-Context": TA } });
  assert.equal(f.calls[0].init.headers.has("X-Noda-Project-Id"), false);
  assert.equal(f.calls[0].init.headers.has("X-Noda-Project-Context"), false);
  f.context.dispose();
  const plain = browser();
  assert.equal((await plain.context.ready()).projectId, null);
  plain.events.get("beforeunload")();
});

test("browser singleton uses actual quickNoteBridge and never the unrelated electronAPI global", async () => {
  let calls = 0, events;
  const f = browser({ quickNoteBridge: { getProjects: async () => { calls += 1; return dto(); },
    onProjectState(callback) { events = callback; return () => {}; } },
  electronAPI: { getProjects() { throw new Error("wrong bridge used"); } } });
  assert.equal((await f.context.ready()).projectId, A);
  assert.equal(calls, 1);
  events(dto(B, TB));
  assert.equal(f.context.snapshot().projectId, B);
  f.context.dispose();
  const wrongOnly = browser({ electronAPI: { getProjects() { throw new Error("wrong global used"); } } });
  assert.equal((await wrongOnly.context.ready()).projectId, null);
  wrongOnly.context.dispose();
});

test("existing but incomplete bridge cannot silently select legacy mode", async () => {
  for (const bridge of [{}, { getProjects: async () => dto() }, { onProjectState() {} }]) {
    const context = createProjectContext({ bridge });
    await assert.rejects(context.ready(), { code: "project_context_unavailable" });
    context.dispose();
  }
});

test("newer bootstrap event wins over late getProjects response and timeout", async () => {
  const get = deferred(); let emit;
  const context = createProjectContext({ bridge: { getProjects: () => get.promise,
    onProjectState(callback) { emit = callback; } } });
  await flush();
  emit(dto(B, TB));
  assert.equal((await context.ready()).projectId, B);
  get.resolve(dto()); await flush();
  assert.equal(context.snapshot().projectId, B);
  context.dispose();
  let timeoutEvent;
  const f = browser({ quickNoteBridge: { getProjects: () => new Promise(() => {}), onProjectState(callback) { timeoutEvent = callback; } } });
  await flush();
  timeoutEvent(dto(B, TB));
  for (const callback of f.timers.values()) callback();
  await flush();
  assert.equal((await f.context.ready()).projectId, B);
  f.context.dispose();
});

test("bootstrap timeout and dispose release pending initialization and all timers", async () => {
  for (const terminate of ["timeout", "dispose"]) {
    const f = browser({ quickNoteBridge: { getProjects: () => new Promise(() => {}), onProjectState() {} } });
    await flush();
    assert.equal(f.timers.size, 1);
    if (terminate === "timeout") for (const callback of f.timers.values()) callback();
    else f.context.dispose();
    await assert.rejects(f.context.ready(), { code: "project_context_unavailable" });
    await flush();
    assert.equal(f.timers.size, 0);
    f.context.dispose();
  }
});

test("requests stamp current IDs, preserve other headers and prohibit redirects or external destinations", async () => {
  const f = fixture(); await f.context.ready();
  await f.context.fetch("/notes?q=one", { method: "POST", body: "source", redirect: "follow",
    headers: { "X-Noda-Project-Id": B, "X-Noda-Project-Context": TB, "Content-Type": "text/plain" } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "http://127.0.0.1:5000/notes?q=one");
  assert.equal(f.calls[0].init.headers.get("X-Noda-Project-Id"), A);
  assert.equal(f.calls[0].init.headers.get("X-Noda-Project-Context"), TA);
  assert.equal(f.calls[0].init.headers.get("Content-Type"), "text/plain");
  assert.equal(f.calls[0].init.redirect, "error");
  for (const input of ["https://evil.example/notes", "http://localhost:5000/notes", "http://127.0.0.1:5001/notes",
    "http://user:pass@127.0.0.1:5000/notes", "file:///C:/private", "data:text/plain,x", "http://["]) {
    await assert.rejects(f.context.fetch(input), { code: "project_request_forbidden" });
  }
  assert.equal(f.calls.length, 1);
  f.context.dispose();
});

test("backend origin itself cannot redirect stamped credentials outside loopback", async () => {
  for (const backendOrigin of ["https://evil.example", "http://192.168.1.10:5000", "file:///tmp/", "http://127.0.0.1:5000/extra"]) {
    let sent = 0;
    const f = fixture(dto(), { backendOrigin, fetch: async () => { sent += 1; return new Response("forbidden"); } });
    await f.context.ready();
    await assert.rejects(f.context.fetch("/notes"), { code: "project_request_forbidden" });
    assert.throws(() => f.context.assetUrl("/notes/assets/a.png"), { code: "project_request_forbidden" });
    assert.equal(sent, 0);
    f.context.dispose();
  }
});

test("asset URLs admit only project asset paths and replace caller supplied context", async () => {
  const f = fixture(); await f.context.ready();
  const result = new URL(f.context.assetUrl("/notes/assets/image.png?size=2&project_id=forged&project_context=forged"));
  assert.equal(result.searchParams.get("size"), "2");
  assert.equal(result.searchParams.get("project_id"), A);
  assert.equal(result.searchParams.get("project_context"), TA);
  for (const input of ["/notes", "/notes/assets", "/notes/assets/../private.png", "https://evil.example/notes/assets/a.png"]) {
    assert.throws(() => f.context.assetUrl(input), { code: "project_request_forbidden" });
  }
  f.context.dispose();
});

test("late fetch response after A→B→A is discarded without automatic replay", async () => {
  const gate = deferred(), calls = [];
  const f = fixture(dto(), { fetch: (url, init) => { calls.push({ url, init }); return gate.promise; } });
  await f.context.ready();
  const pending = f.context.fetch("/notes", { method: "POST", body: "A only" });
  f.emit(dto(B, TB)); f.emit(dto(A, TA));
  assert.equal(calls[0].init.signal.aborted, true);
  gate.resolve(new Response("old A"));
  await assert.rejects(pending, { code: "project_context_changed" });
  assert.equal(calls.length, 1);
  f.context.dispose();
});

test("late body consumption and cloned responses are fenced after epoch change", async () => {
  const body = deferred();
  const response = { json: () => body.promise, clone() { return this; }, status: 200 };
  const f = fixture(dto(), { fetch: async () => response });
  await f.context.ready();
  const result = await f.context.fetch("/notes");
  assert.equal(result.status, 200);
  const clone = result.clone();
  const pending = result.json();
  f.emit(dto(B, TB));
  body.resolve({ confidential: "old A" });
  await assert.rejects(pending, { code: "project_context_changed" });
  await assert.rejects(async () => clone.json(), { code: "project_context_changed" });
  assert.throws(() => result.clone(), { code: "project_context_changed" });
  f.context.dispose();
});

test("concurrent cloned body reads retain the shared controller until the final read settles", async () => {
  const first = deferred(), second = deferred(); let signal;
  const response = { json: () => first.promise, clone: () => ({ json: () => second.promise }) };
  const f = fixture(dto(), { fetch: async (_, init) => { signal = init.signal; return response; } });
  await f.context.ready();
  const result = await f.context.fetch("/notes");
  const clone = result.clone();
  const one = result.json(), two = clone.json();
  first.resolve({ value: "first" });
  assert.deepEqual(await one, { value: "first" });
  assert.equal(signal.aborted, false);
  f.emit(dto(B, TB));
  assert.equal(signal.aborted, true);
  second.resolve({ value: "late old project" });
  await assert.rejects(two, { code: "project_context_changed" });
  f.context.dispose();
});

test("malformed foreign project entries and active-project mismatch cannot enter the snapshot", async () => {
  for (const change of [
    value => { value.projects.push({ ...entry(B), id: "wrong" }); },
    value => { value.projects.push(entry(B), entry(B)); },
    value => { value.projects.push({ ...entry(B), noteCount: -1 }); },
    value => { value.projects.push({ ...entry(B), noteCount: "1" }); },
    value => { value.projects.push({ ...entry(B), name: " " }); },
    value => { value.projects.push({ ...entry(B), notesDirectory: "" }); },
    value => { value.projects.push({ ...entry(B), collectionName: "" }); },
    value => { value.projects.push({ ...entry(B), legacy: "false" }); },
    value => { value.projects = Array.from({ length: 129 }, (_, index) => entry(index.toString(16).padStart(32, "0"))); },
    value => { value.activeProject.name = "Mismatched"; },
    value => { value.activeProject.notesDirectory = "/other"; },
    value => { value.activeProject.collectionName = "other"; },
    value => { value.activeProject.noteCount = 3; },
  ]) {
    const value = dto(); change(value);
    const f = fixture(value);
    await assert.rejects(f.context.ready(), { code: "project_context_unavailable" });
    assert.equal(f.context.snapshot().projectState, null);
    f.context.dispose();
  }
});

test("raw body readers cannot bypass epoch fencing", async () => {
  let enqueue;
  const stream = new ReadableStream({ start(controller) { enqueue = controller; } });
  const f = fixture(dto(), { fetch: async () => new Response(stream) });
  await f.context.ready();
  const response = await f.context.fetch("/notes");
  try {
    const reader = response.body.getReader();
    const pending = reader.read();
    f.emit(dto(B, TB));
    enqueue.enqueue(new TextEncoder().encode("old project source")); enqueue.close();
    await assert.rejects(pending, { code: "project_context_changed" });
  } catch (error) {
    if (error.code !== "project_stream_unsupported") throw error;
  } finally { f.context.dispose(); }
});

test("external abort rejects a late response even if the transport ignores its signal", async () => {
  const gate = deferred(); let signal;
  const f = fixture(dto(), { fetch: (_, init) => { signal = init.signal; return gate.promise; } });
  await f.context.ready();
  const external = new AbortController();
  const pending = f.context.fetch("/notes", { signal: external.signal });
  external.abort();
  assert.equal(signal.aborted, true);
  gate.resolve(new Response("ignored cancellation"));
  await assert.rejects(pending, { name: "AbortError" });
  f.context.dispose();
});

test("already aborted requests never reach transport and named body readers retain response binding", async () => {
  let sent = 0;
  const response = { value: "bound", body: null };
  for (const method of ["json", "text", "blob", "arrayBuffer", "formData", "bytes"]) {
    response[method] = function () { return Promise.resolve(this.value); };
  }
  const f = fixture(dto(), { fetch: async () => { sent += 1; return response; } });
  await f.context.ready();
  const external = new AbortController(); external.abort();
  await assert.rejects(f.context.fetch("/notes", { signal: external.signal }), { name: "AbortError" });
  assert.equal(sent, 0);
  const result = await f.context.fetch("/notes");
  assert.equal(result.body, null);
  for (const method of ["json", "text", "blob", "arrayBuffer", "formData", "bytes"]) assert.equal(await result[method](), "bound");
  f.context.dispose();
});

test("custom loopback origin and subsequent project requests use exactly the current context", async () => {
  for (const backendOrigin of ["http://localhost:6000", "http://[::1]:5000/"]) {
    const f = fixture(dto(), { backendOrigin }); await f.context.ready();
    f.emit(dto(B, TB));
    await f.context.fetch("/notes");
    assert.equal(f.calls[0].init.headers.get("X-Noda-Project-Id"), B);
    assert.equal(f.calls[0].init.headers.get("X-Noda-Project-Context"), TB);
    assert.equal(new URL(f.calls[0].url).origin, new URL(backendOrigin).origin);
    f.context.dispose();
  }
});

test("request concurrency is bounded and dispose aborts work and rejects future access", async () => {
  const gate = deferred(), signals = [];
  const f = fixture(dto(), { fetch: (_, init) => { signals.push(init.signal); return gate.promise; } });
  await f.context.ready();
  const pending = Array.from({ length: 128 }, () => f.context.fetch("/notes"));
  await assert.rejects(f.context.fetch("/notes"), { code: "project_requests_busy" });
  f.context.dispose();
  assert.ok(signals.every(signal => signal.aborted));
  gate.resolve(new Response("late"));
  const settled = await Promise.allSettled(pending);
  assert.ok(settled.every(result => result.status === "rejected" && result.reason.code === "project_context_changed"));
  await assert.rejects(f.context.fetch("/notes"), { code: "project_context_unavailable" });
  await assert.rejects(f.context.ready(), { code: "project_context_unavailable" });
});

test("listener exceptions are reported without preventing other listeners or transport errors", async () => {
  let reports = 0, changes = 0;
  const f = fixture(dto(), { report: () => { reports += 1; }, fetch: async () => { throw new TypeError("offline"); } });
  f.context.subscribe(() => { throw new Error("listener failure"); });
  f.context.subscribe(() => { changes += 1; });
  assert.throws(() => f.context.subscribe(null), TypeError);
  await f.context.ready();
  assert.equal(reports, 2);
  assert.equal(changes, 2);
  await assert.rejects(f.context.fetch("/notes"), { message: "offline" });
  f.context.dispose();
});
