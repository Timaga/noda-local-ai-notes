const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { create, createDraftStorage } = require("../../frontend/quick_capture_project.js");
const Queue = require("../../frontend/generation_queue_client.js");
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const job = (project, extra = {}) => ({ job_id: "same-job", status: "queued", prompt_preview: project, vault_id: project, ...extra });
const page = (project, rows = []) => ({ vault_id: project, jobs: rows, next_cursor: null });
const state = project => ({ queue: { vault_id: project } });

function context(initial = "A") {
  let epoch = 0, value = { projectId: initial, contextToken: `${initial}-token`, epoch, status: initial ? "ready" : "switching" };
  const listeners = new Set();
  return {
    snapshot: () => value,
    ready: async () => { if (value.status !== "ready") throw Object.assign(new Error("switching"), { code: "project_changed" }); return value; },
    isCurrent: observed => value.status === "ready" && observed?.epoch === value.epoch && observed.projectId === value.projectId,
    subscribe(fn) { listeners.add(fn); fn(value); return () => listeners.delete(fn); },
    switch(project, status = "ready") {
      value = { projectId: project, contextToken: `${project}-${++epoch}`, epoch, status };
      for (const listener of listeners) listener(value);
    },
  };
}

function setup(transport, initial, storage) {
  const project = context(initial), callbacks = [], calls = [], clients = [];
  let draft = { text: "", mode: "organize" }, requestId = 0;
  const controller = create({
    context: project, readDraft: () => ({ ...draft }), writeDraft: value => { draft = { ...value }; },
    storage, reset() { callbacks.push(["reset"]); }, onState(value) { callbacks.push(["state", value.status]); },
    createClient(captured, pendingSubmission, onSubmissionChange) {
      const client = Queue.create({
        isCurrent: () => project.isCurrent(captured), requireVault: true,
        request: (...args) => { calls.push([captured.projectId, ...args]); return transport(captured.projectId, ...args); },
        ...(storage ? { pendingSubmission, onSubmissionChange } : {}),
        newRequestId: storage ? randomUUID : () => `request-${++requestId}`,
        ensureBackendReady: async () => {},
        setTimeout: () => 1, clearTimeout: () => {},
        onChange(rows) { callbacks.push(["change", captured.projectId, rows.map(row => row.prompt_preview)]); },
        onAccepted(value, raw) { callbacks.push(["accepted", captured.projectId]); if (draft.text === raw) draft.text = ""; },
        onError(error) { callbacks.push(["error", captured.projectId, error.code]); },
      });
      clients.push(client);
      return client;
    },
  });
  return { controller, project, callbacks, calls, clients, get draft() { return draft; }, set draft(value) { draft = value; } };
}

test("deleting a queued entry stays bound to its original project and a late response cannot affect B", async () => {
  const pending = defer();
  const ui = setup(async (project, path, options = {}) => {
    if (options.method === "DELETE") return pending.promise;
    return path.includes("?") ? page(project, [job(project)]) : state(project);
  }, "A");
  await ui.controller.refresh(); const removed = ui.controller.removeJob("same-job");
  assert.equal(ui.calls.at(-1)[1], "/generate/jobs/same-job?expected_vault_id=A");
  ui.project.switch("B", "switching"); const count = ui.calls.length;
  await assert.rejects(ui.controller.removeJob("same-job"), { code: "project_changed" }); assert.equal(ui.calls.length, count);
  ui.project.switch("B"); await ui.controller.refresh();
  pending.resolve({ success: true, removed: true, job_id: "same-job", vault_id: "A", history_revision: 1, queue: { history_revision: 1 } });
  await assert.rejects(removed, { code: "project_changed" });
  assert.equal(ui.controller.values()[0].prompt_preview, "B"); ui.controller.dispose();
});

test("project switches restore separate drafts and modes without sending anything", async () => {
  const ui = setup(async () => { throw new Error("Unexpected network request"); });
  ui.draft = { text: "ALPHA_ONLY", mode: "organize_edit" };
  ui.project.switch("B", "switching");
  assert.equal(ui.draft.text, "");
  await assert.rejects(ui.controller.enqueue("ALPHA_ONLY"), { code: "project_changed" });
  ui.project.switch("B");
  assert.deepEqual(ui.draft, { text: "", mode: "organize" });
  ui.draft = { text: "BETA_ONLY", mode: "organize" };
  ui.project.switch("A");
  assert.deepEqual(ui.draft, { text: "ALPHA_ONLY", mode: "organize_edit" });
  assert.equal(ui.calls.length, 0);
  ui.controller.dispose();
});

test("a fresh renderer restores only the active project's saved draft", () => {
  const disk = new Map();
  const storage = createDraftStorage(() => ({
    getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value), removeItem: key => disk.delete(key),
  }));
  const alpha = "a".repeat(32), beta = "b".repeat(32);
  const noNetwork = () => { throw new Error("Unexpected network request"); };
  const first = setup(noNetwork, alpha, storage);
  first.draft = { text: "Exact alpha\r\n  ", mode: "organize_edit" };
  assert.equal(first.controller.saveDraft(), true);
  first.controller.dispose();
  const second = setup(noNetwork, beta, storage);
  assert.deepEqual(second.draft, { text: "", mode: "organize" });
  second.draft = { text: "Separate beta", mode: "organize" };
  second.project.switch(alpha);
  assert.deepEqual(second.draft, { text: "Exact alpha\r\n  ", mode: "organize_edit" });
  second.draft = { text: "", mode: "organize" };
  assert.equal(second.controller.saveDraft(), true);
  second.controller.dispose();
  const third = setup(noNetwork, alpha, storage);
  assert.equal(third.draft.text, "");
  third.project.switch(beta);
  assert.equal(third.draft.text, "Separate beta");
  third.controller.dispose();
});

test("an uncertain send keeps its original receipt across renderer restart", async () => {
  const disk = new Map();
  const storage = createDraftStorage(() => ({
    getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value), removeItem: key => disk.delete(key),
  }));
  const alpha = "a".repeat(32);
  const fixturePosts = [];
  let responseLost = true;
  const transport = async (project, path, options) => {
    if (path.includes("?")) return page(project);
    if (path === "/generate/queue") return state(project);
    const body = JSON.parse(options.body);
    fixturePosts.push(body);
    if (responseLost) throw Object.assign(new TypeError("Lost response"), { code: "transport_error" });
    return { vault_id: project, job: job(project, { client_request_id: body.client_request_id }) };
  };
  const first = setup(transport, alpha, storage);
  first.draft = { text: "Original text", mode: "organize" };
  await assert.rejects(first.controller.enqueue(first.draft.text), { code: "transport_error" });
  first.draft = { text: "Next draft", mode: "organize" };
  assert.equal(first.controller.saveDraft(), true);
  first.controller.dispose();

  responseLost = false;
  const second = setup(transport, alpha, storage);
  assert.equal(second.draft.text, "Next draft");
  const unresolved = JSON.parse(disk.values().next().value).pending;
  assert.equal(unresolved.raw, "Original text");
  // Replay only the unresolved operation. Acknowledging it must preserve the edited field.
  await second.controller.enqueue(unresolved.raw);
  assert.equal(second.draft.text, "Next draft");
  assert(fixturePosts.every(body => body.client_request_id === unresolved.id && body.expected_vault_id === alpha));
  assert.equal(JSON.parse(disk.values().next().value).pending, null);
  second.controller.dispose();
});

test("late A list cannot overwrite B with the same job ID, including ABA epochs", async () => {
  const waiting = defer();
  let first = true;
  const ui = setup(async (project, path) => path.includes("?")
    ? first ? (first = false, waiting.promise) : page(project, [job(project)]) : state(project));
  const old = ui.controller.refresh();
  ui.project.switch("B"); await ui.controller.refresh();
  ui.project.switch("A"); await ui.controller.refresh();
  const before = ui.callbacks.length;
  waiting.resolve(page("A", [job("OLD_ALPHA")]));
  await assert.rejects(old, { code: "project_changed" });
  assert.equal(ui.callbacks.length, before);
  assert.equal(ui.controller.values()[0].prompt_preview, "A");
  ui.controller.dispose();
});

test("first enqueue waits for a nonnull vault before the first POST", async () => {
  const waiting = defer(), entered = defer();
  const ui = setup(async (project, path, options) => {
    if (path.includes("?")) { entered.resolve(); return waiting.promise; }
    if (path === "/generate/queue") return state(project);
    const body = JSON.parse(options.body);
    assert.equal(body.expected_vault_id, "A");
    return { vault_id: "A", job: job("A", { client_request_id: body.client_request_id }) };
  });
  const pending = ui.controller.enqueue("exact source");
  await entered.promise;
  assert.equal(ui.calls.filter(row => row[2]?.method === "POST").length, 0);
  waiting.resolve(page("A"));
  await pending;
  assert.equal(ui.calls.filter(row => row[2]?.method === "POST").length, 1);
  ui.controller.dispose();
});

test("late A POST never acknowledges identical B draft or replaces B same-ID job", async () => {
  const waiting = defer(), posted = defer();
  const ui = setup(async (project, path, options) => {
    if (options?.method === "POST") { posted.resolve(); return waiting.promise; }
    return path.includes("?") ? page(project, [job(project)]) : state(project);
  });
  ui.draft = { text: "identical text", mode: "organize" };
  const old = ui.controller.enqueue(ui.draft.text); await posted.promise;
  ui.project.switch("B"); ui.draft = { text: "identical text", mode: "organize" };
  await ui.controller.refresh();
  const before = ui.callbacks.length;
  waiting.resolve({ vault_id: "A", job: job("A", { status: "completed", result: { title: "CRM" } }) });
  await assert.rejects(old, { code: "project_changed" });
  assert.equal(ui.callbacks.length, before);
  assert.equal(ui.draft.text, "identical text");
  assert.equal(ui.controller.values()[0].prompt_preview, "B");
  ui.controller.dispose();
});

test("late A transport failure cannot replay a POST in B", async () => {
  const waiting = defer(), posted = defer();
  const ui = setup(async (project, path, options) => {
    if (options?.method === "POST") { posted.resolve(); return waiting.promise; }
    return path.includes("?") ? page(project) : state(project);
  });
  const old = ui.controller.enqueue("ALPHA_ONLY"); await posted.promise;
  ui.project.switch("B");
  waiting.reject(Object.assign(new TypeError("offline"), { code: "transport_error" }));
  await assert.rejects(old, { code: "project_changed" });
  assert.equal(ui.calls.filter(row => row[2]?.method === "POST").length, 1);
  assert.equal(ui.calls.filter(row => row[0] === "B").length, 0);
  ui.controller.dispose();
});

test("same-ID B retry has a new client while a late A retry remains unacknowledged", async () => {
  const oldRetry = defer(), posted = defer();
  const ui = setup(async (project, path, options) => {
    if (path.endsWith("/retry")) {
      if (project === "A") { posted.resolve(); return oldRetry.promise; }
      return { vault_id: "B", job: job("B", { status: "processing" }) };
    }
    return path.includes("?") ? page(project, [job(project, { status: "failed", retry_available: true })]) : state(project);
  });
  await ui.controller.refresh(); const old = ui.controller.retry("same-job"); await posted.promise;
  ui.project.switch("B"); await ui.controller.refresh();
  const fresh = await ui.controller.retry("same-job");
  assert.equal(fresh.prompt_preview, "B");
  oldRetry.resolve({ vault_id: "A", job: job("A", { status: "completed" }) });
  await assert.rejects(old, { code: "project_changed" });
  assert.equal(ui.controller.values()[0].prompt_preview, "B");
  assert.equal(ui.calls.filter(row => row[1].endsWith("/retry")).length, 2);
  ui.controller.dispose();
});

test("missing vault fails closed without POST and a late detail cannot replace B source", async () => {
  const missing = Queue.create({ request: async path => path.includes("?") ? { jobs: [], next_cursor: null } : { queue: {} }, requireVault: true });
  await assert.rejects(missing.enqueue("raw"), { code: "schema_error" });
  const waiting = defer();
  const ui = setup(async (project, path) => path.includes("?") ? page(project, [job(project)])
    : path.includes("/jobs/") ? waiting.promise : state(project));
  await ui.controller.refresh(); const old = ui.controller.detail("same-job");
  ui.project.switch("B"); await ui.controller.refresh();
  waiting.resolve({ vault_id: "A", job: job("A", { prompt_text: "ALPHA_ONLY" }) });
  await assert.rejects(old, { code: "project_changed" });
  assert.equal(ui.controller.values()[0].prompt_text, undefined);
  ui.controller.dispose();
});

test("bootstrap cannot poll before a ready project and disposal blocks later actions", async () => {
  const ui = setup(async (project, path) => path.includes("?") ? page(project) : state(project), null);
  const ready = defer(); ui.project.ready = () => ready.promise;
  const started = ui.controller.start();
  assert.equal(ui.calls.length, 0);
  ui.project.switch("A"); ready.resolve(ui.project.snapshot());
  await started;
  assert(ui.calls.length > 0);
  ui.controller.stop(); ui.controller.dispose();
  const count = ui.calls.length;
  ui.project.switch("B");
  await assert.rejects(ui.controller.enqueue("raw"), { code: "project_changed" });
  assert.deepEqual(ui.controller.values(), []);
  assert.equal(ui.calls.length, count);
});

test("late readiness IPC cannot prepare an old client or cause a new-project write", async () => {
  const waiting = defer();
  let allowed = true, calls = 0;
  const client = Queue.create({
    isCurrent: () => allowed,
    ensureBackendReady: () => waiting.promise,
    request: async () => { calls += 1; return {}; },
  });
  const pending = client.ensureReady();
  await Promise.resolve(); allowed = false; waiting.resolve({ ok: true });
  await assert.rejects(pending, { code: "project_changed" });
  await assert.rejects(client.enqueue("ALPHA_ONLY"), { code: "project_changed" });
  assert.equal(calls, 0);
  assert.throws(() => create({}), { code: "project_changed" });
});
