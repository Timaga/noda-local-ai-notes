"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../../frontend/generation_queue_client");
const A = "a".repeat(32), B = "b".repeat(32), V = "c".repeat(32);
const job = (id = A, status = "queued") => ({ job_id: id, status, created_at: 1 });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
function fixture(rows = [job()]) {
  let revision = 0, records = rows, handler = null, current = true;
  const calls = [], updates = [];
  const queue = () => ({ queued_count: records.filter(value => value.status === "queued").length,
    processing_count: records.filter(value => value.status === "processing").length, history_revision: revision });
  const page = () => ({ jobs: structuredClone(records), next_cursor: null, history_revision: revision, vault_id: V });
  const removed = id => ({ success: true, removed: true, job_id: id, already_removed: false,
    vault_id: V, history_revision: revision, queue: queue() });
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    const override = handler?.(path, options); if (override !== undefined) return override;
    if (options.method === "DELETE") { const id = path.split("/").at(-1).split("?")[0];
      records = records.filter(value => value.job_id !== id); revision++; return removed(id); }
    if (path.startsWith("/generate/jobs?")) return page();
    if (path.startsWith("/generate/jobs/")) return { job: { ...records.find(value => value.job_id === path.split("/").at(-1)), prompt_text: "saved source" }, vault_id: V };
    return { queue: queue(), vault_id: V };
  };
  const client = create({ request, isCurrent: () => current, onChange: values => updates.push(values) });
  return { client, calls, updates, page, queue, removed, setHandler: value => { handler = value; },
    setCurrent: value => { current = value; }, setRecords: value => { records = value; }, setRevision: value => { revision = value; } };
}
test("remove queued job uses the captured vault and updates rows and counters only after acknowledgement", async () => {
  const completed = { ...job("d".repeat(32), "completed"), processing_outcome: "completed" };
  const f = fixture([job(), job(B, "failed"), completed]); await f.client.refresh();
  await f.client.detail(A); const result = await f.client.removeJob(A);
  assert.deepEqual(f.calls.find(value => value.method === "DELETE"), {
    path: `/generate/jobs/${A}?expected_vault_id=${V}`, method: "DELETE" });
  assert.equal(result.queue.queued_count, 0); assert.deepEqual(f.client.values(), [job(B, "failed"), completed]);
});
test("a processing job is unavailable for removal without sending a write", async () => {
  const f = fixture([job(A, "processing")]); await f.client.refresh();
  await assert.rejects(f.client.removeJob(A), { code: "job_busy" });
  assert.equal(f.calls.filter(value => value.method === "DELETE").length, 0);
});
test("failed or malformed acknowledgement retains the job and its source", async () => {
  const f = fixture(); await f.client.refresh(); await f.client.detail(A);
  f.setHandler((_path, options) => options.method === "DELETE" ? Promise.reject(Object.assign(new Error("busy"), { code: "job_busy" })) : undefined);
  await assert.rejects(f.client.removeJob(A), { code: "job_busy" });
  assert.equal(f.client.values()[0].prompt_text, "saved source");
  f.setHandler((_path, options) => options.method === "DELETE" ? { success: true, removed: true, job_id: A, vault_id: V, queue: {} } : undefined);
  await assert.rejects(f.client.removeJob(A), { code: "schema_error" });
  assert.equal(f.client.values()[0].prompt_text, "saved source");
});
test("duplicate clicks share one removal operation", async () => {
  const f = fixture(), pending = deferred(); await f.client.refresh();
  f.setHandler((_path, options) => options.method === "DELETE" ? pending.promise : undefined);
  const one = f.client.removeJob(A), two = f.client.removeJob(A);
  assert.equal(one, two); assert.equal(f.client.values().length, 1);
  f.setRevision(1); f.setRecords([]); pending.resolve(f.removed(A)); await one;
  assert.equal(f.calls.filter(value => value.method === "DELETE").length, 1); assert.deepEqual(f.client.values(), []);
});
test("a stale polling page cannot resurrect a removed queued job", async () => {
  const f = fixture(), pending = deferred(); await f.client.refresh(); const old = f.page();
  f.setHandler(path => path.startsWith("/generate/jobs?") ? pending.promise : undefined);
  const polling = f.client.refresh(); await f.client.removeJob(A); pending.resolve(old); await polling;
  assert.deepEqual(f.client.values(), []);
});
test("a delayed detail cannot restore removed source or preview content", async () => {
  const f = fixture([job(A, "completed")]), pending = deferred(); await f.client.refresh();
  f.setHandler(path => path === `/generate/jobs/${A}` ? pending.promise : undefined);
  const detail = f.client.detail(A); await f.client.removeJob(A);
  pending.resolve({ job: { ...job(A, "completed"), prompt_text: "stale private source", result: { title: "stale result" } }, vault_id: V });
  await assert.rejects(detail, { code: "job_not_found" }); assert.deepEqual(f.client.values(), []);
});
test("a server-side removal does not leave a stale active entry or block queue counter refresh", async () => {
  const f = fixture(); await f.client.refresh(); f.setRecords([]); f.setRevision(1);
  f.setHandler(path => path === `/generate/jobs/${A}` ? Promise.reject(Object.assign(new Error("gone"), { code: "job_not_found" })) : undefined);
  await f.client.refresh(); assert.deepEqual(f.client.values(), []);
  assert.equal(f.calls.at(-1).path, "/generate/queue");
});
test("a lost removal acknowledgement is reconciled by polling without automatically sending another DELETE", async () => {
  const f = fixture(); await f.client.refresh();
  f.setHandler((path, options) => {
    if (options.method === "DELETE") { f.setRecords([]); f.setRevision(1); return Promise.reject(new TypeError("Lost acknowledgement")); }
    if (path === `/generate/jobs/${A}`) return Promise.reject(Object.assign(new Error("gone"), { code: "job_not_found" }));
  });
  await assert.rejects(f.client.removeJob(A), /Lost acknowledgement/);
  assert.equal(f.client.values().length, 1); await f.client.refresh(); assert.deepEqual(f.client.values(), []);
  assert.equal(f.calls.filter(value => value.method === "DELETE").length, 1);
});
test("a delayed earlier-history page cannot restore a removed entry", async () => {
  const f = fixture(), pending = deferred();
  f.setHandler(path => path === "/generate/jobs?limit=50" ? { ...f.page(), next_cursor: "older" } : undefined);
  await f.client.refresh();
  f.setHandler(path => path.includes("cursor=older") ? pending.promise : undefined);
  const earlier = f.client.showEarlier(); await f.client.removeJob(A);
  pending.resolve({ jobs: [job(A)], next_cursor: null, history_revision: 0, vault_id: V }); await earlier;
  assert.deepEqual(f.client.values(), []);
});
test("a removal response after switching projects cannot repaint or mutate the new project", async () => {
  const f = fixture(), pending = deferred(); await f.client.refresh(); const previous = f.updates.length;
  f.setHandler((_path, options) => options.method === "DELETE" ? pending.promise : undefined);
  const removal = f.client.removeJob(A); f.setCurrent(false); f.client.stop(); pending.resolve(f.removed(A));
  await assert.rejects(removal, { code: "project_changed" }); assert.equal(f.updates.length, previous);
});
test("unknown or unscoped jobs cannot issue deletion", async () => {
  const f = fixture(); await assert.rejects(f.client.removeJob(A), { code: "job_not_found" });
  const client = create({ request: async path => path.includes("?") ? { jobs: [job()], next_cursor: null } : { queue: {} } });
  await client.refresh(); await assert.rejects(client.removeJob(A), { code: "schema_error" });
  assert.equal(f.calls.length, 0);
});
test("replaying a removed enqueue receipt acknowledges it without restoring a history entry", async () => {
  let accepted;
  const client = create({ newRequestId: () => "a".repeat(32), onAccepted: (value, raw) => { accepted = { value, raw }; },
    request: async path => path === "/generate/enqueue" ? { job: { ...job(A, "failed"), removed: true }, vault_id: V }
      : path.startsWith("/generate/jobs?") ? { jobs: [], next_cursor: null, vault_id: V } : { queue: {}, vault_id: V } });
  await client.enqueue("keep this source"); assert.deepEqual(client.values(), []);
  assert.equal(accepted.value.removed, true); assert.equal(accepted.raw, "keep this source");
});
