const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../../frontend/generation_queue_client.js");

const job = (id, status = "queued", extra = {}) => ({ job_id: id, status, ...extra });
const page = (jobs, next_cursor = null) => ({ jobs, next_cursor });
const transportError = (message) => Object.assign(new TypeError(message), { code: "transport_error" });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function client(request, options = {}) {
  return create({ request, newRequestId: () => "d98f5740-25b1-443f-953b-945dc98ac7be", ...options });
}

test("fresh UI restores pending, completed and failed jobs solely from server", async () => {
  const records = [job("a"), job("b", "completed"), job("c", "failed", { error_code: "publication_unknown" })];
  const methods = [];
  const request = async (path, options) => {
    methods.push(options?.method || "GET");
    return path.startsWith("/generate/jobs?") ? page(records) : { queue: { queued_count: 1 } };
  };
  for (let restart = 0; restart < 2; restart += 1) {
    const ui = client(request);
    await ui.refresh();
    assert.deepEqual(ui.values(), records);
  }
  assert(methods.every((method) => method === "GET"));
});

test("pagination is bounded to one page per refresh and deduplicates IDs", async () => {
  const paths = [];
  const ui = client(async (path) => {
    paths.push(path);
    if (path.includes("cursor=")) return page([job("a", "completed"), job("b", "failed")]);
    if (path.includes("?")) return page([job("a", "completed")], "17");
    return { queue: {} };
  });
  await ui.refresh();
  assert.equal(ui.values().length, 1);
  await ui.refresh();
  assert.equal(ui.values().length, 2);
  assert(paths.includes("/generate/jobs?limit=50&cursor=17"));
});

test("project cleanup clears completed rows, retaining unresolved jobs and cached sources", async () => {
  let revision = 0;
  const completed = job("published", "completed", { processing_outcome: "completed" });
  const failed = job("unprocessed", "completed", { processing_outcome: "source_saved" });
  const waiting = job("waiting");
  const queue = () => ({ history_revision: revision, history_retention_days: 30, vault_id: "fixture" });
  const ui = client(async (path, options) => {
    if (path === "/generate/queue/cleanup") {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { expected_vault_id: "fixture" });
      revision = 1;
      return { archived_count: 1, vault_id: "fixture", queue: queue() };
    }
    if (path === "/generate/jobs/unprocessed") return { job: { ...failed, prompt_text: "exact source" } };
    if (path.startsWith("/generate/jobs?")) return {
      jobs: revision ? [waiting, failed] : [waiting, failed, completed],
      next_cursor: null, history_revision: revision, vault_id: "fixture",
    };
    return { queue: queue() };
  });
  await ui.refresh();
  await ui.detail("unprocessed");
  assert.equal(await ui.cleanupHistory(), 1);
  assert.deepEqual(ui.values(), [waiting, { ...failed, prompt_text: "exact source", result: undefined }]);
});

test("earlier queue pages expose sources outside the 50 recent terminal jobs", async () => {
  const recent = Array.from({ length: 50 }, (_, index) => job(`recent-${index}`, "completed", { created_at: 100 + index }));
  const waiting = job("active");
  const firstPage = [...recent.slice(0, 49), waiting];
  const old = job("old-failure", "failed", { created_at: 20 });
  const older = job("earliest-failure", "failed", { created_at: 10 });
  let paging;
  const ui = client(async (path) => {
    if (path === "/generate/jobs?limit=50") return page(firstPage, "51");
    if (path.endsWith("cursor=51")) return page([recent[49], old], "10");
    if (path.endsWith("cursor=10")) return page([older]);
    if (path.endsWith("/old-failure")) return { job: { ...old, prompt_text: "original older source" } };
    if (path.endsWith("/active")) return { job: waiting };
    return { queue: {} };
  }, { onChange(_jobs, _queue, next) { paging = next; } });
  await ui.refresh();
  await ui.refresh(); // The background cache can no longer hold the old failed job.
  assert(!ui.values().some(record => record.job_id === old.job_id));
  assert.deepEqual(paging, { older: false, hasEarlier: true });
  await ui.showEarlier();
  assert.deepEqual(ui.values().map(record => record.job_id), ["recent-49", old.job_id, waiting.job_id]);
  assert.equal((await ui.detail(old.job_id)).prompt_text, "original older source");
  await ui.showEarlier();
  assert.deepEqual(ui.values().map(record => record.job_id), [older.job_id, waiting.job_id]);
  assert.deepEqual(paging, { older: true, hasEarlier: false });
  ui.showRecent();
  assert.equal(ui.values().length, 51);
});

test("slow refresh and reconnect never overlap list requests", async () => {
  const waiting = deferred();
  let calls = 0;
  const ui = client(async (path) => {
    if (path.includes("?")) { calls += 1; return waiting.promise; }
    return { queue: {} };
  });
  const first = ui.refresh(), second = ui.refresh();
  assert.equal(first, second);
  assert.equal(calls, 1);
  waiting.resolve(page([job("new-id", "completed")]));
  await first;
});

test("a replaced queue cannot receive a draft whose preflight began in the old vault", async () => {
  const ready = deferred(), entered = deferred();
  let vault = "A", posts = 0;
  const ui = client(async (path) => {
    if (path === "/generate/enqueue") { posts += 1; return { job: job("unexpected") }; }
    if (path.startsWith("/generate/jobs?")) return { ...page([]), vault_id: vault };
    return { queue: { vault_id: vault } };
  }, { requireVault: true, prepareSubmission: () => { entered.resolve(); return ready.promise; } });
  const pending = ui.enqueue("Bound to vault A");
  await entered.promise;
  vault = "B";
  await assert.rejects(ui.refresh(), { code: "vault_changed" });
  ready.resolve();
  await assert.rejects(pending, { code: "vault_changed" });
  assert.equal(posts, 0);
});

test("a draft storage failure prevents dispatch and permits a later edited submission", async () => {
  let writable = false;
  const posts = [];
  const ui = client(async (_path, options) => {
    posts.push(JSON.parse(options.body).prompt);
    return { job: job("accepted") };
  }, { onSubmissionChange: () => writable });
  await assert.rejects(ui.enqueue("Unsaved initial draft"), { code: "draft_storage_unavailable" });
  assert.equal(posts.length, 0);
  writable = true;
  await ui.enqueue("Revised draft");
  assert.deepEqual(posts, ["Revised draft"]);
});

test("offline pass recovers unknown server jobs on the next pass", async () => {
  let offline = true, errors = 0;
  const ui = client(async (path) => {
    if (offline) throw transportError("Failed to fetch");
    return path.includes("?") ? page([job("recovered", "processing")]) : { queue: {} };
  }, { onError: () => { errors += 1; } });
  await assert.rejects(ui.refresh());
  offline = false;
  await ui.refresh();
  assert.equal(errors, 1);
  assert.equal(ui.values()[0].job_id, "recovered");
});

test("network replay preserves exact raw text and the same idempotency key", async () => {
  const raw = "  Шаг −2\r\n```json\r\n{\"value\":null}\r\n```\r\n![x](a b.svg)  ";
  const bodies = [], accepted = [];
  const ui = client(async (path, options, expectedStatus) => {
    assert.equal(expectedStatus, 202);
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw transportError("lost response after commit");
    return { job: job("durable", "queued", { client_request_id: bodies[0].client_request_id.replaceAll("-", "") }) };
  }, { onAccepted: (value, text) => accepted.push(text) });
  await ui.enqueue(raw);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].prompt, raw);
  assert.deepEqual(accepted, [raw]);
});

test("mode is frozen in a pending submission and a switch starts a new request", async () => {
  let online = false;
  const bodies = [];
  let nextId = 0;
  const ui = client(async (path, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (!online) throw transportError("offline");
    return { job: job(body.client_request_id) };
  }, { newRequestId: () => String(++nextId) });
  await assert.rejects(ui.enqueue("текст", "local", "organize_edit"));
  online = true;
  await ui.enqueue("текст", "local", "organize");
  assert.deepEqual(bodies.map((body) => body.mode), [
    "organize_edit", "organize_edit", "organize_edit", "organize",
  ]);
  assert.equal(bodies[0].client_request_id, bodies[2].client_request_id);
  assert.notEqual(bodies[2].client_request_id, bodies[3].client_request_id);
});

test("a pending POST does not acknowledge input before durable response", async () => {
  const waiting = deferred(), accepted = [];
  const ui = client(() => waiting.promise, { onAccepted: (value, raw) => accepted.push(raw) });
  const sending = ui.enqueue(" exact ");
  assert.deepEqual(accepted, []);
  waiting.resolve({ job: job("accepted") });
  await sending;
  assert.deepEqual(accepted, [" exact "]);
});

test("lost acknowledgements retain request ID across later user retries", async () => {
  let online = false;
  const bodies = [];
  const ui = client(async (path, options) => {
    bodies.push(JSON.parse(options.body));
    if (!online) throw transportError("offline");
    return { job: job("once") };
  });
  await assert.rejects(ui.enqueue("original"));
  online = true;
  await ui.enqueue("original");
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies.map((body) => body.client_request_id)).size, 1);
});

test("listing can resolve a lost 202 without repeating generation", async () => {
  let id, accepted = 0, posts = 0;
  const ui = client(async (path, options) => {
    if (options?.method === "POST") {
      posts += 1; id = JSON.parse(options.body).client_request_id;
      throw transportError("lost response");
    }
    return path.includes("?") ? page([job("once", "completed", { client_request_id: id })]) : { queue: {} };
  }, { onAccepted: () => { accepted += 1; } });
  await assert.rejects(ui.enqueue("source"));
  await ui.refresh();
  assert.equal(accepted, 1);
  assert.equal(posts, 2);
});

test("failed publication job never produces an automatic POST", async () => {
  const calls = [];
  const ui = client(async (path, options) => {
    calls.push(options?.method || "GET");
    return path.includes("?") ? page([job("ambiguous", "failed", { error_code: "publication_unknown", retryable: false })]) : { queue: {} };
  });
  await ui.refresh(); await ui.refresh();
  assert(calls.every((method) => method === "GET"));
});

test("same concurrent submission coalesces while a different draft is rejected", async () => {
  const waiting = deferred();
  let posts = 0;
  const ui = client(() => { posts += 1; return waiting.promise; });
  const first = ui.enqueue("a"), duplicate = ui.enqueue("a");
  assert.equal(first, duplicate);
  await assert.rejects(ui.enqueue("b"));
  waiting.resolve({ job: job("one") });
  await first;
  assert.equal(posts, 1);
});

test("validation rejection permits an edited draft with a new key", async () => {
  let next = 0;
  const bodies = [];
  const ui = client(async (path, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw Object.assign(new Error("invalid"), { status: 400 });
    return { job: job("fixed") };
  }, { newRequestId: () => String(++next) });
  await assert.rejects(ui.enqueue("bad")); await ui.enqueue("fixed");
  assert.notEqual(bodies[0].client_request_id, bodies[1].client_request_id);
});

test("an edited draft first resolves the uncertain submission with its original key", async () => {
  let online = false, id = 0;
  const bodies = [];
  const ui = client(async (path, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (!online) throw transportError("offline");
    return { job: job(body.client_request_id) };
  }, { newRequestId: () => String(++id) });
  await assert.rejects(ui.enqueue("first raw"));
  online = true;
  await ui.enqueue("second raw");
  assert.deepEqual(bodies.map((body) => body.prompt), ["first raw", "first raw", "first raw", "second raw"]);
  assert.equal(bodies[0].client_request_id, bodies[2].client_request_id);
  assert.notEqual(bodies[2].client_request_id, bodies[3].client_request_id);
});

test("malformed list and another job's detail are rejected without replacing state", async () => {
  let malformed = false;
  const ui = client(async (path) => {
    if (path.endsWith("/a")) return { job: job("another", "failed", { prompt_text: "wrong" }) };
    if (path.includes("?")) return malformed ? { jobs: [], next_cursor: 3 } : page([job("a", "failed")]);
    return { queue: {} };
  });
  await ui.refresh();
  await assert.rejects(ui.detail("a"));
  malformed = true;
  await assert.rejects(ui.refresh());
  assert.deepEqual(ui.values(), [job("a", "failed")]);
});

test("source detail stays exact when a later list excludes raw text", async () => {
  const raw = " \r\n<html> literal </html>\r\n ";
  const ui = client(async (path) => path.includes("?") ? page([job("a", "failed")])
    : path.endsWith("/a") ? { job: job("a", "failed", { prompt_text: raw }) } : { queue: {} });
  await ui.detail("a"); await ui.refresh();
  assert.equal(ui.values()[0].prompt_text, raw);
});

test("confirmed vault change clears old jobs and never replays old uncertain raw", async () => {
  let vault = "store-a", offline = true;
  const posts = [];
  const ui = client(async (path, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(options.body));
      if (offline) throw transportError("lost acknowledgement");
      return { vault_id: vault, job: job("accepted") };
    }
    return path.includes("?") ? { ...page([job(vault, "completed")]), vault_id: vault } : { queue: { vault_id: vault } };
  });
  await ui.refresh();
  await assert.rejects(ui.enqueue("old raw"));
  assert.equal(posts[0].expected_vault_id, "store-a");
  vault = "store-b"; offline = false;
  await assert.rejects(ui.enqueue("old raw"), /Папка заметок сменилась/);
  assert.equal(posts.length, 2);
  assert.deepEqual(ui.values(), []);
  await ui.refresh();
  assert.equal(ui.values()[0].job_id, "store-b");
});

test("stop clears scheduler and an in-flight response cannot start another timer", async () => {
  const waiting = deferred();
  let scheduled = 0;
  const ui = client(async (path) => path.includes("?") ? waiting.promise : { queue: {} }, {
    setTimeout: () => { scheduled += 1; return 1; }, clearTimeout: () => {},
  });
  const first = ui.start(); ui.stop(); waiting.resolve(page([]));
  await assert.rejects(first, { code: "project_changed" });
  assert.deepEqual(ui.values(), []);
  assert.equal(scheduled, 0);
});

test("scheduled polling changes from active to idle cadence without overlap", async () => {
  let callback, state = "queued", cancelled = 0;
  const delays = [];
  const ui = client(async (path) => path.includes("?") ? page([job("a", state)]) : { queue: {} }, {
    setTimeout: (fn, delay) => { callback = fn; delays.push(delay); return delays.length; },
    clearTimeout: () => { cancelled += 1; },
  });
  await ui.start();
  assert.deepEqual(delays, [900]);
  state = "completed";
  callback(); await ui.refresh();
  assert.deepEqual(delays, [900, 5000]);
  ui.stop(); assert.equal(cancelled, 1);
});

test("one pass refreshes at most three known active jobs absent from the page", async () => {
  let second = false;
  const details = [];
  const ui = client(async (path) => {
    if (path.includes("?")) return second ? page([]) : page([job("a"), job("b"), job("c"), job("d")], "2");
    if (path.startsWith("/generate/jobs/")) {
      const id = path.split("/").at(-1); details.push(id);
      return { job: job(id, "completed") };
    }
    return { queue: {} };
  });
  await ui.refresh(); second = true; await ui.refresh();
  assert.deepEqual(details, ["a", "b", "c"]);
  assert.equal(ui.values().find((value) => value.job_id === "d").status, "queued");
});

test("empty input and malformed acknowledgements cannot claim durable acceptance", async () => {
  let requests = 0, accepted = 0;
  const ui = client(async () => { requests += 1; return { job: { job_id: "bad" } }; }, {
    onAccepted: () => { accepted += 1; },
  });
  await assert.rejects(ui.enqueue(" \r\n "));
  assert.equal(requests, 0);
  await assert.rejects(ui.enqueue("nonempty"));
  assert.equal(requests, 1); // Schema failures are not safe network retries.
  assert.equal(accepted, 0);
});

test("repeating server cursor is rejected instead of looping forever", async () => {
  const ui = client(async (path) => path.includes("?") ? page([], "same") : { queue: {} });
  await ui.refresh();
  await assert.rejects(ui.refresh(), /не продвинул/);
});
