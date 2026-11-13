const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../../frontend/generation_queue_client.js");

const transport = () => Object.assign(new TypeError("connection refused"), { code: "transport_error" });
const job = (id, status = "queued", extra = {}) => ({ job_id: id, status, ...extra });
const page = (jobs, next_cursor = null, vault_id = "same-vault") => ({ jobs, next_cursor, vault_id });
const state = (vault_id = "same-vault") => ({ queue: { vault_id, queued_count: 0 } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function setup(request, options = {}) {
  const scheduled = new Map(), delays = [];
  let sequence = 0;
  const ui = create({ request, newRequestId: () => "fixed-id",
    setTimeout: (fn, delay) => { delays.push(delay); scheduled.set(++sequence, fn); return sequence; },
    clearTimeout: (id) => scheduled.delete(id), ...options });
  return { ui, scheduled, delays };
}

test("transport outage restarts the backend through bridge and restores server jobs", async () => {
  let offline = true, starts = 0, posts = 0;
  const { ui, delays } = setup(async (path, options) => {
    if (options?.method === "POST") posts += 1;
    if (offline) throw transport();
    return path.includes("?") ? page([job("resumed", "processing")]) : state();
  }, { ensureBackendReady: async () => { starts += 1; offline = false; } });
  await assert.rejects(ui.start(), { code: "transport_error" });
  assert.equal(starts, 1);
  assert.deepEqual(delays, [5000]);
  await ui.refresh();
  assert.equal(ui.values()[0].job_id, "resumed");
  assert.equal(posts, 0);
  assert.equal(delays.at(-1), 900);
  ui.stop();
});

test("automatic restarts stop after three attempts and reset only after server success", async () => {
  let offline = true, starts = 0;
  const errors = [];
  const { ui, delays } = setup(async (path) => {
    if (offline) throw transport();
    return path.includes("?") ? page([]) : state();
  }, { ensureBackendReady: async () => { starts += 1; }, onError: (error) => errors.push(error) });
  await assert.rejects(ui.start());
  for (let pass = 0; pass < 5; pass += 1) await assert.rejects(ui.refresh());
  assert.equal(starts, 3, "Successful IPC alone must not reset the cap");
  assert.equal(errors.at(-1).recoveryExhausted, true);
  assert.deepEqual(delays.slice(0, 4), [5000, 10000, 15000, 15000]);
  await ui.ensureReady(); // An explicit user action can try again after the cap.
  assert.equal(starts, 4);
  await assert.rejects(ui.refresh());
  assert.equal(starts, 4, "Explicit IPC alone must not reset the automatic cap either");
  offline = false; await ui.refresh();
  offline = true; await assert.rejects(ui.refresh());
  assert.equal(starts, 5);
  ui.stop();
});

test("automatic and explicit ensure share one pending bridge call", async () => {
  const entered = deferred(), bridge = deferred();
  let starts = 0;
  const { ui } = setup(async () => { throw transport(); }, {
    ensureBackendReady: () => { starts += 1; entered.resolve(); return bridge.promise; },
  });
  const polling = ui.start();
  await entered.promise;
  assert.equal(ui.refresh(), polling);
  const explicit = ui.ensureReady();
  assert.equal(ui.ensureReady(), explicit);
  assert.equal(starts, 1);
  ui.stop(); bridge.resolve();
  await Promise.all([assert.rejects(explicit, { code: "project_changed" }), assert.rejects(polling)]);
});

test("an existing explicit ensure is reused by transport recovery without a second IPC", async () => {
  const bridge = deferred();
  let starts = 0;
  const { ui } = setup(async () => { throw transport(); }, {
    ensureBackendReady: () => { starts += 1; return bridge.promise; },
  });
  const explicit = ui.ensureReady(), polling = ui.start();
  bridge.resolve(); await explicit; await assert.rejects(polling);
  assert.equal(starts, 1);
  ui.stop();
});

test("failed bridge attempts are bounded and leave the original transport error visible", async () => {
  let starts = 0;
  const { ui } = setup(async () => { throw transport(); }, {
    ensureBackendReady: async () => { starts += 1; throw new Error("startup failed"); },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(attempt ? ui.refresh() : ui.start(), (error) => (
      error.code === "transport_error" && (attempt >= 3 || error.recoveryCode === "backend_start_failed")
    ));
  }
  assert.equal(starts, 3); ui.stop();
});

for (const error of [
  Object.assign(new Error("forbidden"), { status: 403, code: "http_error" }),
  Object.assign(new Error("unavailable"), { status: 503, code: "http_error" }),
  Object.assign(new Error("invalid JSON"), { status: 200, code: "schema_error" }),
  Object.assign(new Error("misclassified HTTP"), { status: 503, code: "transport_error" }),
  new Error("programming error"),
]) {
  test(`response/programming failure never invokes bridge: ${error.message}`, async () => {
    let starts = 0;
    const { ui } = setup(async () => { throw error; }, { ensureBackendReady: async () => { starts += 1; } });
    await assert.rejects(ui.start(), error); await assert.rejects(ui.refresh(), error);
    assert.equal(starts, 0); ui.stop();
  });
}

for (const payload of [null, [], { jobs: "bad" }, page([], 42)]) {
  test(`malformed listing has schema_error and never restarts: ${JSON.stringify(payload)}`, async () => {
    let starts = 0;
    const { ui } = setup(async () => payload, { ensureBackendReady: async () => { starts += 1; } });
    await assert.rejects(ui.start(), { code: "schema_error" });
    assert.equal(starts, 0); ui.stop();
  });
}

test("invalid queue statistics never restarts a reachable server", async () => {
  let starts = 0;
  const { ui } = setup(async (path) => path.includes("?") ? page([]) : { queue: [] }, {
    ensureBackendReady: async () => { starts += 1; },
  });
  await assert.rejects(ui.start(), { code: "schema_error" });
  assert.equal(starts, 0); ui.stop();
});

test("stop before transport failure prevents a bridge call and further timers", async () => {
  const waiting = deferred();
  let starts = 0;
  const { ui, scheduled } = setup(() => waiting.promise, { ensureBackendReady: async () => { starts += 1; } });
  const polling = ui.start(); ui.stop(); waiting.reject(transport());
  await assert.rejects(polling);
  assert.equal(starts, 0); assert.equal(scheduled.size, 0);
});

test("stop during backend startup prevents rescheduling after IPC settles", async () => {
  const waiting = deferred(), entered = deferred();
  const { ui, scheduled } = setup(async () => { throw transport(); }, {
    ensureBackendReady: () => { entered.resolve(); return waiting.promise; },
  });
  const polling = ui.start(); await entered.promise;
  ui.stop(); waiting.resolve(); await assert.rejects(polling);
  assert.equal(scheduled.size, 0);
});

test("missing bridge has its own code, preserves input and never fakes successful startup", async () => {
  const { ui } = setup(async () => { throw transport(); });
  await assert.rejects(ui.ensureReady(), { code: "bridge_unavailable" });
  await assert.rejects(ui.start(), { code: "transport_error", recoveryCode: "bridge_unavailable" });
  ui.stop();
});

test("queue response catches a vault switch after a same-vault list and clears old jobs", async () => {
  let switchAfterList = false, posts = 0;
  const { ui } = setup(async (path, options) => {
    if (options?.method === "POST") { posts += 1; throw transport(); }
    return path.includes("?") ? page([job("old")], null, "a") : state(switchAfterList ? "b" : "a");
  });
  await ui.refresh(); await assert.rejects(ui.enqueue("old raw"));
  switchAfterList = true;
  await assert.rejects(ui.enqueue("old raw"), { code: "vault_changed" });
  assert.equal(posts, 2);
  assert.deepEqual(ui.values(), []);
});

test("history scans reach old active jobs but retain only 50 terminal summaries", async () => {
  let pageNumber = 0;
  const hugeBody = "body".repeat(25000), requested = [];
  const { ui } = setup(async (path) => {
    if (!path.includes("?")) return state();
    requested.push(path);
    const offset = pageNumber++ * 50;
    if (offset === 500) return page([job("old-active", "processing", { created_at: 1 })]);
    return page(Array.from({ length: 50 }, (_, index) => job(`old-${offset + index}`, "completed", {
      created_at: 1000 - offset - index, prompt_text: hugeBody,
      result: { title: `Title ${offset + index}`, content: hugeBody }, unexpected_large: hugeBody,
    })), String(offset + 50));
  });
  for (let pass = 0; pass < 11; pass += 1) {
    await ui.refresh();
    assert(ui.values().length <= 51);
    assert(JSON.stringify(ui.values()).length < 15000, "Completed bodies accumulated in history");
  }
  assert.equal(requested.length, 11);
  assert(requested.at(-1).endsWith("cursor=500"));
  const values = ui.values();
  assert.equal(values.filter((value) => value.status === "completed").length, 50);
  assert.equal(values.find((value) => value.job_id === "old-active").status, "processing");
  assert(values.some((value) => value.job_id === "old-0"));
  assert(!values.some((value) => value.job_id === "old-50"));
});

test("all active jobs survive history pruning and completion returns to the history bound", async () => {
  const old = Array.from({ length: 50 }, (_, i) => job(`active-${i}`, "queued", { created_at: i }));
  let mode = 0;
  const { ui } = setup(async (path) => {
    if (path.includes("?")) return page(mode === 0 ? old : mode === 1
      ? Array.from({ length: 50 }, (_, i) => job(`recent-${i}`, "completed", { created_at: i + 500 })) : []);
    if (path.startsWith("/generate/jobs/")) {
      const found = old.find((value) => path.endsWith(value.job_id));
      return { job: mode === 2 ? { ...found, status: "completed" } : found };
    }
    return state();
  });
  await ui.refresh(); mode = 1; await ui.refresh();
  assert.equal(ui.values().length, 100);
  assert.equal(ui.values().filter((value) => value.status === "queued").length, 50);
  mode = 2; await ui.refresh();
  assert.equal(ui.values().length, 97);
  assert.equal(ui.values().filter((value) => value.status === "completed").length, 50);
});

test("only two requested sources/results stay in memory while raw copy remains exact", async () => {
  const raw = (id) => `  ${id}\r\n<script>literal</script>\r\n  `;
  const { ui } = setup(async (path) => path.includes("?")
    ? page([job("a", "failed"), job("b", "failed"), job("c", "failed")])
    : path.startsWith("/generate/jobs/") ? { job: job(path.split("/").at(-1), "failed", {
      prompt_text: raw(path.split("/").at(-1)), result: { content: "result body" },
    }) } : state());
  await ui.refresh();
  for (const id of ["a", "b", "c"]) assert.equal((await ui.detail(id)).prompt_text, raw(id));
  assert.equal(ui.values().filter((value) => value.prompt_text !== undefined).length, 2);
  assert.equal(ui.values().find((value) => value.job_id === "a").prompt_text, undefined);
  await ui.detail("b"); await ui.detail("a");
  assert.equal(ui.values().find((value) => value.job_id === "c").result, undefined);
  await ui.refresh();
  assert.equal(ui.values().find((value) => value.job_id === "a").prompt_text, raw("a"));
});

test("background active polling cannot evict a user's opened exact source", async () => {
  let first = true;
  const { ui } = setup(async (path) => {
    if (path.includes("?")) {
      const rows = first ? [job("opened", "failed"), job("a"), job("b"), job("c")] : [];
      first = false; return page(rows);
    }
    if (path.startsWith("/generate/jobs/")) {
      const id = path.split("/").at(-1);
      return { job: job(id, id === "opened" ? "failed" : "processing", { prompt_text: `  ${id}\r\n` }) };
    }
    return state();
  });
  await ui.refresh(); await ui.detail("opened"); await ui.refresh();
  assert.equal(ui.values().find((value) => value.job_id === "opened").prompt_text, "  opened\r\n");
  assert.equal(ui.values().filter((value) => value.prompt_text !== undefined).length, 1);
  assert.equal(ui.values().filter((value) => value.status === "processing").length, 3);
});
