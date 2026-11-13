"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const policy = require("../frontend/ru_note_startup");
const queueClient = require("../frontend/generation_queue_client");

const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../frontend/renderer.js"), "utf8");
const ru = { provider: "vllm_local", note_pipeline: { enabled: true, profile: policy.PROFILE_ID } };
const source = "\ufeff  Точный исходник\r\n  ";

function section(text, begin, end) {
  const start = text.indexOf(begin), finish = text.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start);
  return text.slice(start, finish);
}

function options(overrides = {}) {
  const calls = [];
  let depth = 1;
  return {
    calls, allowed: true, draft: { prompt: source, mode: "organize_edit", extra: "not forwarded" },
    deny: () => { calls.push("deny"); return { ok: false }; },
    ensureBackendReady: async () => calls.push("backend"),
    fetchRuntimeConfig: async () => { calls.push("runtime"); return ru; },
    backendUrl: "http://127.0.0.1:5000",
    fetchWithTimeout: async (url, request) => {
      calls.push("policy");
      assert.equal(url, "http://127.0.0.1:5000/generate/runtime");
      assert.equal(request.method, "POST");
      assert.deepEqual(JSON.parse(request.body), { prompt: source, mode: "organize_edit" });
      return { ok: true, status: 200, policy: { requires_legacy_runtime: true, profile: null } };
    },
    readJsonResponse: async response => response.policy,
    startupProgress: { get: () => depth, set: value => { depth = value; } },
    ensureManagedRuntimeReady: async runtime => { assert.equal(runtime, ru); assert.equal(depth, 2); calls.push("managed"); },
    getDepth: () => depth,
    ...overrides,
  };
}

test("generation senders are exact live quick or notes windows", () => {
  const quick = { isDestroyed: () => false, webContents: {} };
  const notes = { isDestroyed: () => false, webContents: {} };
  assert.equal(policy.isGenerationSender({ sender: quick.webContents }, [quick, notes]), true);
  assert.equal(policy.isGenerationSender({ sender: notes.webContents }, [quick, notes]), true);
  assert.equal(policy.isGenerationSender({ sender: {} }, [quick, notes]), false);
  assert.equal(policy.isGenerationSender({ sender: quick.webContents }, [null, { ...quick, isDestroyed: () => true }]), false);
});

test("generation guard rejects a foreign renderer before reading source or model state", async () => {
  const opts = options({ allowed: false });
  Object.defineProperty(opts, "draft", { get() { throw new Error("Source must not be read"); } });
  assert.deepEqual(await policy.ensureGenerationRuntimeReady(opts), { ok: false });
  assert.deepEqual(opts.calls, ["deny"]);
});

test("cold legacy generation is decided by backend, then warmed with progress restored", async () => {
  const opts = options();
  assert.deepEqual(await policy.ensureGenerationRuntimeReady(opts), { ok: true });
  assert.deepEqual(opts.calls, ["backend", "runtime", "policy", "managed"]);
  assert.equal(opts.getDepth(), 1);
});

test("backend Russian route avoids legacy model regardless of client source guesses", async () => {
  const opts = options({
    draft: { prompt: "English text is deliberately not classified in JS", mode: "organize" },
    fetchWithTimeout: async () => ({ ok: true, policy: { requires_legacy_runtime: false, profile: policy.PROFILE_ID } }),
  });
  assert.deepEqual(await policy.ensureGenerationRuntimeReady(opts), { ok: true });
  assert.deepEqual(opts.calls, ["backend", "runtime"]);
});

test("missing or disabled Russian profile retains legacy startup flow without a new endpoint", async () => {
  for (const runtime of [{ provider: "vllm_local" }, { ...ru, note_pipeline: { enabled: false, profile: policy.PROFILE_ID } }]) {
    const opts = options({ fetchRuntimeConfig: async () => runtime, draft: undefined });
    assert.deepEqual(await policy.ensureGenerationRuntimeReady(opts), { ok: true });
    assert.deepEqual(opts.calls, ["backend"]);
  }
});

test("local legacy generation leaves actual lazy loading to backend", async () => {
  const opts = options({ fetchRuntimeConfig: async () => ({ ...ru, provider: "local" }) });
  assert.deepEqual(await policy.ensureGenerationRuntimeReady(opts), { ok: true });
  assert.deepEqual(opts.calls, ["backend", "policy"]);
});

test("failed canonical policy or malformed payload never starts the managed model", async () => {
  for (const value of [null, [], {}, { requires_legacy_runtime: "true", profile: null },
    { requires_legacy_runtime: false, profile: "other" }, { requires_legacy_runtime: true, profile: policy.PROFILE_ID }]) {
    const opts = options({ fetchWithTimeout: async () => ({ ok: true, policy: value }) });
    await assert.rejects(policy.ensureGenerationRuntimeReady(opts), /маршрут/);
    assert.equal(opts.calls.includes("managed"), false);
  }
  const denied = options({ fetchWithTimeout: async () => ({ ok: false, status: 400, policy: { error: "Invalid mode" } }) });
  await assert.rejects(policy.ensureGenerationRuntimeReady(denied), /Invalid mode/);
  const unavailable = options({ fetchWithTimeout: async () => ({ ok: false, status: 503, policy: null }) });
  await assert.rejects(policy.ensureGenerationRuntimeReady(unavailable), /HTTP 503/);
  for (const draft of [undefined, { prompt: 4 }, { prompt: source, mode: true },
    { prompt: source, mode: "x".repeat(33) }, { prompt: "x".repeat(65537) }]) {
    const opts = options({ draft });
    await assert.rejects(policy.ensureGenerationRuntimeReady(opts), /исходник/);
    assert.equal(opts.calls.includes("policy"), false);
  }
});

test("generation startup failure restores prior app readiness", async () => {
  const opts = options({ ensureManagedRuntimeReady: async () => { throw new Error("Synthetic cold start failed"); } });
  await assert.rejects(policy.ensureGenerationRuntimeReady(opts), /Synthetic cold start failed/);
  assert.equal(opts.getDepth(), 1);
});

test("actual main generation IPC guards both allowed windows and forwards only fixed options", async () => {
  let handler;
  const quick = { isDestroyed: () => false, webContents: {} };
  const calls = [];
  const context = vm.createContext({
    quickWindow: quick, notesWindow: null, BACKEND_URL: "http://127.0.0.1:5000",
    startupBroadcastSuppressionDepth: 0,
    ipcMain: { handle: (name, callback) => { assert.equal(name, "quick-note:ensure-generation-runtime"); handler = callback; } },
    isGenerationSender: policy.isGenerationSender, ensureGenerationRuntimeReady: policy.ensureGenerationRuntimeReady,
    projects: () => ({ runWithContext: async (_binding, action) => action(), fetchFor: () => context.fetchWithTimeout }),
    denyInvalidNotesSender: action => { calls.push(action); return { ok: false, error: "forbidden" }; },
    ensureBackendReady: async () => calls.push("backend"),
    fetchRuntimeConfig: async opts => { assert.equal(opts.announceStartup, false); return ru; },
    fetchWithTimeout: async (url, request) => { calls.push("policy"); assert.equal(JSON.parse(request.body).prompt, source); return { ok: true }; },
    readJsonResponse: async () => ({ requires_legacy_runtime: true, profile: null }),
    ensureManagedRuntimeReady: async () => { assert.equal(context.startupBroadcastSuppressionDepth, 1); calls.push("managed"); },
  });
  vm.runInContext(section(main, 'ipcMain.handle("quick-note:ensure-generation-runtime"', "// Who:"), context);
  const hostile = {};
  Object.defineProperty(hostile, "prompt", { get() { throw new Error("Unauthorized source accessed"); } });
  assert.equal((await handler({ sender: {} }, hostile)).ok, false);
  assert.deepEqual(calls, ["ensure-generation-runtime"]);
  calls.length = 0;
  assert.equal((await handler({ sender: quick.webContents }, { prompt: source, mode: "organize_edit" })).ok, true);
  assert.deepEqual(calls, ["backend", "policy", "managed"]);
  assert.equal(context.startupBroadcastSuppressionDepth, 0);
});

function rendererFixture(ready, responseStatus = 202, responseBody = null) {
  const calls = [], posts = [];
  const bound = Object.freeze({ projectId: "a".repeat(32), contextToken: "b".repeat(32), epoch: 1, status: "ready" });
  let active = bound;
  const assertCurrent = value => {
    if (value !== active) throw Object.assign(new Error("Project changed"), { code: "project_changed" });
  };
  const context = vm.createContext({
    window: { quickNoteBridge: ready ? { ensureGenerationRuntimeReady: async draft => { calls.push("ready"); return ready(draft); } } : {} },
    API_BASE: "http://127.0.0.1:5000",
    API_REQUEST_TIMEOUT_MS: 15000,
    projectContext: { isCurrent: value => value === active },
    captureProject: () => active,
    assertProject: assertCurrent,
    projectIds: value => ({ projectId: value.projectId, contextToken: value.contextToken }),
    fetchWithTimeout: async (url, request) => {
      calls.push("post");
      const body = request?.body ? JSON.parse(request.body) : null;
      if (body) posts.push(body);
      return { ok: true, status: responseStatus, json: async () => responseBody ? responseBody()
        : ({ job: { job_id: "job1", status: "queued", client_request_id: body?.client_request_id } }) };
    },
  });
  vm.runInContext(section(renderer, "async function prepareQuickSubmission(", "async function ensureBackendReady("), context);
  function createQueue(overrides = {}) {
    const captured = active;
    return queueClient.create({
      isCurrent: () => captured === active,
      request: (path, request, status) => context.apiRequest(path, request, status, captured),
      prepareSubmission: (raw, mode) => context.prepareQuickSubmission(raw, mode, captured),
      newRequestId: () => "request1",
      ...overrides,
    });
  }
  return { context, calls, posts, createQueue, switchProject() {
    const epoch = active.epoch + 1;
    active = Object.freeze({ projectId: "c".repeat(32), contextToken: epoch.toString(16).padStart(32, "0"), epoch, status: "ready" });
  } };
}

test("actual quick capture preflights generation before sending unchanged note payload", async () => {
  let release;
  const fixture = rendererFixture(draft => {
    assert.equal(draft.prompt, source); assert.equal(draft.mode, "organize_edit");
    assert.equal(draft.projectId, "a".repeat(32)); assert.equal(draft.contextToken, "b".repeat(32));
    return new Promise(resolve => { release = resolve; });
  });
  const request = fixture.createQueue().enqueue(source, "local", "organize_edit");
  assert.deepEqual(fixture.calls, ["ready"]);
  release({ ok: true });
  await request;
  assert.deepEqual(fixture.calls, ["ready", "post"]);
  assert.deepEqual(fixture.posts, [
    { prompt: source, source: "local", mode: "organize_edit", client_request_id: "request1", expected_vault_id: null },
  ]);
});

test("a definite runtime preparation failure permits submission of edited input", async () => {
  const fixture = rendererFixture(async draft => {
    if (draft.prompt === source) throw new Error("Synthetic cold model failure");
    return { ok: true };
  });
  const accepted = [];
  const queue = fixture.createQueue({ onAccepted: job => accepted.push(job) });
  await assert.rejects(queue.enqueue(source, "local", "organize_edit"), { code: "runtime_unavailable" });
  assert.deepEqual(fixture.posts, []);
  assert.deepEqual(accepted, []);
  assert.deepEqual(queue.values(), []);
  await queue.enqueue("Corrected draft", "local", "organize_edit");
  assert.deepEqual(fixture.posts.map(body => body.prompt), ["Corrected draft"]);
  assert.equal(accepted.length, 1);
});

test("project switch during runtime readiness blocks the old note before HTTP admission", async () => {
  let release;
  const fixture = rendererFixture(() => new Promise(resolve => { release = resolve; }));
  const pending = fixture.createQueue().enqueue(source);
  fixture.switchProject(); release({ ok: true });
  await assert.rejects(pending, { code: "project_changed" });
  assert.deepEqual(fixture.posts, []);
  assert.deepEqual(fixture.calls, ["ready"]);
});

test("a late JSON body or network failure keeps its project boundary and never becomes a retryable transport error", async () => {
  let release, entered;
  const bodyEntered = new Promise(resolve => { entered = resolve; });
  const fixture = rendererFixture(null, 200, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = fixture.context.apiRequest("/runtime/config");
  await bodyEntered; fixture.switchProject(); release({ runtime_model_id: "ALPHA_ONLY" });
  await assert.rejects(pending, { code: "project_changed" });
  let reject;
  fixture.context.fetchWithTimeout = () => new Promise((_resolve, failure) => { reject = failure; });
  const failed = fixture.context.apiRequest("/generate/queue");
  fixture.switchProject(); reject(new TypeError("offline"));
  await assert.rejects(failed, { code: "project_changed" });
});

test("polling and old bridge callers do not gain runtime side effects", async () => {
  const polling = rendererFixture(async () => { throw new Error("Polling must not warm a model"); });
  await polling.context.apiRequest("/generate/queue");
  assert.deepEqual(polling.calls, ["post"]);
  const old = rendererFixture();
  await old.context.apiRequest("/generate/enqueue", { method: "POST", body: JSON.stringify({ prompt: source }) });
  assert.deepEqual(old.calls, ["post"]);
});

test("preload generation bridge strips renderer model, command and path fields", async () => {
  let bridge;
  const calls = [];
  const context = vm.createContext({
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: () => {}, invoke: async (...args) => { calls.push(args); return { ok: true }; } },
    }),
    process: { argv: [] }, document: { documentElement: { dataset: {}, style: {} } }, window: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/preload.js"), "utf8"), context);
  await bridge.ensureGenerationRuntimeReady({ prompt: source, mode: "organize", projectId: "a".repeat(32), contextToken: "b".repeat(32),
    model: "ignored", command: "ignored", path: "ignored" });
  assert.equal(calls[0][0], "quick-note:ensure-generation-runtime");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { prompt: source, mode: "organize", projectId: "a".repeat(32), contextToken: "b".repeat(32) });
});
