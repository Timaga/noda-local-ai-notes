const assert = require("node:assert/strict");
const test = require("node:test");
const { create } = require(process.env.NODA_QUEUE_CLIENT_UNDER_TEST || "../../frontend/generation_queue_client");

const stages = ["title", "tags", "links", "save"];
const progress = (current) => ({
  version: 1, attempt: 1, current_stage: current,
  stages: stages.map((id) => ({ id, status: id === current ? "running" : "pending" })),
});

function fixture(initial) {
  let record = initial;
  const ui = create({ request: async (path) => {
    if (path.includes("?")) return { jobs: [record], next_cursor: null };
    if (path.startsWith("/generate/jobs/")) return { job: record };
    return { queue: { queued_count: 0, processing_count: 1 } };
  } });
  return { ui, set: (value) => { record = value; } };
}

test("server stage changes and an unprocessed saved source survive queue polling", async () => {
  const record = { job_id: "stage-job", status: "processing", progress: progress("title"),
    processing_outcome: "processing" };
  const { ui, set } = fixture(record);
  await ui.refresh();
  assert.equal(ui.values()[0].progress.current_stage, "title");
  set({ ...record, progress: progress("tags") });
  await ui.refresh();
  assert.equal(ui.values()[0].progress.current_stage, "tags");
  const failed = progress(null);
  failed.stages[0].status = "failed";
  set({ ...record, status: "completed", processing_outcome: "source_saved", progress: failed,
    prompt_text: "  Original source\r\n", result: { title: "Raw source", generation: { metadata_pending: true } } });
  await ui.refresh();
  const detail = await ui.detail("stage-job");
  assert.equal(detail.prompt_text, "  Original source\r\n");
  assert.equal(ui.values()[0].processing_outcome, "source_saved");
  assert.equal(ui.values()[0].progress.stages[0].status, "failed");
  assert.equal(ui.values()[0].result.generation.metadata_pending, true);
});

test("legacy jobs have no invented history and malformed observations are bounded", async () => {
  const { ui, set } = fixture({ job_id: "old", status: "completed", progress: null });
  await ui.refresh();
  assert.equal(ui.values()[0].progress, null);
  set({ job_id: "old", status: "completed", progress: { version: 1, attempt: "bad",
    current_stage: "__proto__", stages: [null, { id: "__proto__", status: "running" },
      { id: "title", status: "invalid" }, { id: "save", status: "completed", payload: "not retained" },
      { id: "tags", status: "running" }] } });
  await ui.refresh();
  assert.deepEqual(ui.values()[0].progress, { version: 1, attempt: 0,
    current_stage: null, stages: [{ id: "save", status: "completed" }] });
});

test("disabled stages stay skipped through queue polling and completed details", async () => {
  const record = { job_id: "skip-job", status: "completed", processing_outcome: "completed",
    progress: { ...progress(null), stages: stages.map(id => ({ id, status: id === "save" ? "completed" : "skipped" })) } };
  const { ui } = fixture(record);
  await ui.refresh();
  assert.deepEqual(ui.values()[0].progress.stages, record.progress.stages);
  assert.deepEqual((await ui.detail("skip-job")).progress.stages, record.progress.stages);
});

test("a late detail cannot revert newer poll state but still provides immutable source", async () => {
  let release, delayDetail = false;
  let record = { job_id: "slow", status: "processing", progress: progress("title"),
    processing_outcome: "processing", attempts: 1 };
  const ui = create({ request: async (path) => {
    if (path.includes("?")) return { jobs: [record], next_cursor: null };
    if (!path.startsWith("/generate/jobs/")) return { queue: {} };
    if (delayDetail) {
      delayDetail = false;
      const snapshot = { ...record, prompt_text: "Exact immutable source" };
      return new Promise(resolve => { release = () => resolve({ job: snapshot }); });
    }
    return { job: record };
  } });
  await ui.refresh();
  delayDetail = true;
  const detail = ui.detail("slow");
  record = { ...record, progress: progress("links") };
  await ui.refresh();
  release();
  const received = await detail;
  assert.equal(ui.values()[0].progress.current_stage, "links");
  assert.equal(received.progress.current_stage, "links");
  assert.equal(received.prompt_text, "Exact immutable source");

  delayDetail = true;
  const oldProcessing = ui.detail("slow");
  record = { ...record, status: "completed", processing_outcome: "source_saved",
    progress: progress(null), result: { generation: { metadata_pending: true } } };
  await ui.refresh();
  release();
  const terminal = await oldProcessing;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.processing_outcome, "source_saved");
  assert.equal(ui.values()[0].processing_outcome, "source_saved");
  assert.equal(terminal.result, undefined);

  const completed = await ui.detail("slow");
  assert.equal(completed.result.generation.metadata_pending, true);
});

test("a detail from the previous vault cannot clear the newly loaded library", async () => {
  let currentVault = "vault-a", release;
  const ui = create({ request: async (path) => {
    if (path.startsWith("/generate/jobs/")) {
      return new Promise(resolve => { release = () => resolve({ vault_id: "vault-a",
        job: { job_id: "vault-a", status: "completed" } }); });
    }
    if (path.includes("?")) return { vault_id: currentVault, next_cursor: null,
      jobs: [{ job_id: currentVault, status: "completed" }] };
    return { queue: { vault_id: currentVault } };
  } });
  await ui.refresh();
  const oldDetail = ui.detail("vault-a");
  currentVault = "vault-b";
  await assert.rejects(ui.refresh(), { code: "vault_changed" });
  await ui.refresh();
  release();
  await assert.rejects(oldDetail, { code: "vault_changed" });
  assert.deepEqual(ui.values().map(job => job.job_id), ["vault-b"]);
});
