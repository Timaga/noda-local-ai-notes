const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require("../../frontend/generation_retry_client");
const queue = require("../../frontend/generation_queue_client");

const id = "a".repeat(32), requestId = "d98f5740-25b1-443f-953b-945dc98ac7be";
const waiting = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const eligible = () => ({ job_id: id, status: "completed", processing_outcome: "source_saved", retry_available: true });
const lost = () => Object.assign(new TypeError("offline"), { code: "transport_error" });

function fixture(request) {
  let job = eligible(), vault = "vault-a", refreshes = 0, sequence = 0;
  const calls = [];
  const api = create({ request: (path, options) => { calls.push({ path, options }); return request(path, options); },
    newId: () => {
      const value = sequence++;
      return value === 0 ? requestId : `${value === 1 ? "a" : "b"}98f5740-25b1-443f-953b-945dc98ac7be`;
    },
    getVault: () => vault, getJob: () => job,
    applyJob: (incoming, observed) => { if (job === observed) job = incoming; },
    refresh: async () => { refreshes += 1; },
  });
  return { api, calls, get: () => job, set: value => { job = value; }, vault: value => { vault = value; }, refreshes: () => refreshes };
}

test("double click sends one job-bound retry without the source text", async () => {
  const gate = waiting();
  const state = fixture(() => gate.promise);
  const first = state.api.retry(id), second = state.api.retry(id);
  assert.equal(first, second);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].path, `/generate/jobs/${id}/retry`);
  assert.deepEqual(JSON.parse(state.calls[0].options.body), { client_request_id: requestId, expected_vault_id: "vault-a" });
  gate.resolve({ vault_id: "vault-a", job: { ...eligible(), status: "queued", retry_available: false } });
  await first;
  assert.equal(state.get().status, "queued");
});

test("uncertain acknowledgement reuses the same key, then matching polling resolves it", async () => {
  let online = false;
  const state = fixture(async () => {
    if (!online) throw lost();
    return { vault_id: "vault-a", job: { ...eligible(), status: "queued" } };
  });
  await assert.rejects(state.api.retry(id), { code: "transport_error" });
  assert.equal(state.calls.length, 2);
  online = true;
  await state.api.retry(id);
  assert.equal(new Set(state.calls.map(call => call.options.body)).size, 1);
  assert.equal(state.refreshes(), 1);

  online = false;
  state.set(eligible());
  await assert.rejects(state.api.retry(id));
  state.api.observeJob({ ...eligible(), recovery_summary: { request_id: "a98f574025b1443f953b945dc98ac7be" } });
  online = true;
  await state.api.retry(id);
  assert.ok(state.calls.length >= 6);
  assert.equal(JSON.parse(state.calls.at(-1).options.body).client_request_id,
    "b98f5740-25b1-443f-953b-945dc98ac7be");
});

test("late retry acknowledgement does not overwrite a newer poll or another vault", async () => {
  const gate = waiting();
  const state = fixture(() => gate.promise);
  const pending = state.api.retry(id);
  state.set({ ...eligible(), status: "processing", phase: "generating", processing_outcome: "processing" });
  gate.resolve({ vault_id: "vault-a", job: { ...eligible(), status: "queued" } });
  const response = await pending;
  assert.equal(state.get().status, "processing");
  assert.equal(response.status, "processing");

  const otherGate = waiting(), other = fixture(() => otherGate.promise);
  const old = other.api.retry(id);
  other.vault("vault-b");
  otherGate.resolve({ vault_id: "vault-a", job: eligible() });
  await assert.rejects(old, { code: "vault_changed" });
  assert.equal(other.get().processing_outcome, "source_saved");
});

test("eligibility, permanent conflicts and malformed acknowledgements fail closed", async () => {
  const conflict = Object.assign(new Error("unsafe private detail"), { code: "retry_target_changed", status: 409 });
  const state = fixture(async () => { throw conflict; });
  state.set({ ...eligible(), retry_available: false });
  await assert.rejects(state.api.retry(id), { code: "retry_not_allowed" });
  assert.equal(state.calls.length, 0);
  state.set(eligible());
  await assert.rejects(state.api.retry(id), { code: "retry_target_changed" });
  await assert.rejects(state.api.retry(id), { code: "retry_target_changed" });
  assert.notEqual(state.calls[0].options.body, state.calls[1].options.body);
  const bad = fixture(async () => ({ vault_id: "vault-a", job: { job_id: "other", status: "completed" } }));
  await assert.rejects(bad.api.retry(id), { code: "schema_error" });
  assert.equal(bad.get().processing_outcome, "source_saved");
  bad.vault(null);
  await assert.rejects(bad.api.retry(id), { code: "retry_not_allowed" });
});

test("queue integration resets old metadata cache only after a server retry acknowledgement", async () => {
  const raw = "  Exact source\r\n";
  let record = { ...eligible(), recovery_summary: null, attempts: 1,
    result: { title: "Old fallback", generation: { metadata_pending: true } }, prompt_text: raw };
  let lastQueue;
  const ui = queue.create({ newRequestId: () => requestId, onChange: (_, value) => { lastQueue = value; },
    request: async (path, options) => {
      if (path.endsWith("/retry")) {
        assert.equal(options.method, "POST");
        assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ["client_request_id", "expected_vault_id"]);
        record = { ...record, status: "queued", processing_outcome: "pending", retry_available: false,
          result: null, processing_error: null,
          recovery_summary: { request_id: requestId.replaceAll("-", ""), status: "queued", retry_count: 1 } };
        return { vault_id: "vault-a", job: record, queue: { queued_count: 1, processing_count: 0 } };
      }
      if (path.includes("?")) return { vault_id: "vault-a", jobs: [record], next_cursor: null };
      if (path.startsWith("/generate/jobs/")) return { vault_id: "vault-a", job: record };
      return { vault_id: "vault-a", queue: {} };
    },
  });
  await ui.refresh();
  await ui.detail(id);
  assert.equal(ui.values()[0].result.generation.metadata_pending, true);
  await ui.retry(id);
  assert.equal(ui.values()[0].processing_outcome, "pending");
  assert.equal(ui.values()[0].result, undefined);
  assert.equal(ui.values()[0].result_title, undefined);
  assert.equal(ui.values()[0].prompt_text, raw);
  assert.equal(lastQueue.queued_count, 1);
  record = { ...record, status: "completed", processing_outcome: "completed",
    recovery_summary: { ...record.recovery_summary, status: "completed" },
    result: { title: "Canonical fallback filename", display_title: "Processed title",
      generation: { metadata_pending: false } } };
  await ui.refresh();
  const detail = await ui.detail(id);
  assert.equal(detail.result.generation.metadata_pending, false);
  assert.equal(ui.values()[0].result_title, "Processed title");
  assert.equal(detail.result.title, "Canonical fallback filename");
  assert.equal(ui.values()[0].prompt_text, raw);
});
