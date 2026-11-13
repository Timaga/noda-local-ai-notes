// Synthetic HTTP boundary only; the production helper and renderer are loaded unchanged.
window.__queueFixture = {
  rows: [
    { job_id: "persisted-pending", status: "processing", created_at: 100, prompt_preview: "Незавершённый исходник" },
    { job_id: "persisted-failed", status: "failed", error_code: "publication_unknown", created_at: 90, prompt_preview: "<img src=x onerror=window.__attack=1>" },
  ],
  posts: [], mode: "normal", status: 202, release: null, postStarted: null,
  bridgeCalls: 0, bridgeFailure: false, transportOffline: false, responseMode: "normal",
  source: "  Точный исходник\r\n![схема](assets/example.svg)\r\n<script>window.__attack=1</script>  ",
};
window.__attack = 0;
window.__storageWrites = [];
let fixtureRequestNumber = 0;
Object.defineProperty(window.crypto, "randomUUID", { value: () => `00000000-0000-4000-8000-${String(++fixtureRequestNumber).padStart(12, "0")}` });
const fixtureSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  window.__storageWrites.push({ key, value });
  if (/^noda:quick-draft:v1:(?:legacy|[a-f0-9]{32})$/.test(key) || key.startsWith("noda.noteProcessingMode.v1:")) {
    fixtureSetItem.call(this, key, value);
  } else {
    throw new Error("Unexpected quick capture storage key");
  }
};
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.__copied = text; } } });
window.quickNoteBridge = {
  getLanguage: () => "ru",
  getProjects: async () => ({ ok: true, mode: "legacy", status: "ready", context: null,
    activeProjectId: null, activeProject: null, projects: [] }),
  onProjectState: () => () => {},
  getHotkey: async () => "Ctrl+Shift+Space",
  setQuickCaptureHeight: async () => ({ ok: true }),
  toggleWindow: async () => { window.__queueFixture.hideCalls = (window.__queueFixture.hideCalls || 0) + 1; },
  ensureBackendReady: async () => {
    window.__queueFixture.bridgeCalls += 1;
    if (window.__queueFixture.bridgeFailure) throw new Error("Synthetic startup failure");
    window.__queueFixture.transportOffline = false;
  },
};
window.startupGate = { waitForReady: async () => {} };
window.fetch = async (url, options = {}) => {
  const fixture = window.__queueFixture;
  const pathname = new URL(url).pathname;
  const vault_id = fixture.history?.vault_id || "0123456789abcdef0123456789abcdef";
  if (fixture.transportOffline) throw new TypeError("Synthetic connection refused");
  let data, status = 200;
  if (pathname === "/generate/enqueue") {
    const body = JSON.parse(options.body); fixture.posts.push(body);
    if (!fixture.bridgeCalls) throw new Error("POST before ensureBackendReady");
    if (fixture.mode === "waiting") await new Promise((resolve) => {
      fixture.release = resolve; fixture.postStarted();
    });
    status = fixture.status;
    data = { job: { job_id: "submitted-" + body.client_request_id, client_request_id: body.client_request_id,
      status: "queued", created_at: 120, prompt_preview: body.prompt.slice(0, 140) }, queue: { queued_count: 1 } };
  } else if (pathname === "/generate/jobs") data = { jobs: fixture.rows, next_cursor: null, ...fixture.history };
  else if (pathname.startsWith("/generate/jobs/")) {
    const id = decodeURIComponent(pathname.split("/").at(-1));
    data = { job: { ...(fixture.rows.find((row) => row.job_id === id) || { job_id: id, status: "queued" }), prompt_text: fixture.source } };
  } else if (pathname === "/generate/queue") data = { queue: { queued_count: fixture.queueQueuedCount ?? 1, ...fixture.history } };
  else if (pathname === "/generate/queue/cleanup" && fixture.history) {
    const body = JSON.parse(options.body);
    if (options.method !== "POST" || body.expected_vault_id !== fixture.history.vault_id) {
      throw new Error("Queue cleanup was not scoped to the fixture vault");
    }
    const before = fixture.rows.length;
    fixture.rows = fixture.rows.filter(job => job.processing_outcome !== "completed");
    fixture.history.history_revision += 1;
    data = { archived_count: before - fixture.rows.length, queue: { ...fixture.history } };
  }
  else if (pathname === "/runtime/config") data = { provider: "local", runtime_model_id: "synthetic-test" };
  else throw new Error("Unexpected test API path: " + pathname);
  if (fixture.responseMode === "forbidden") status = 403;
  if (fixture.responseMode === "unavailable") status = 503;
  return { ok: status >= 200 && status < 300, status, json: async () => {
    if (fixture.responseMode === "invalid-json") throw new SyntaxError("Synthetic invalid JSON");
    return fixture.responseMode === "invalid-shape" ? [] : { vault_id, ...data };
  } };
};

window.runQueueDomTests = async (restart) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const fixture = window.__queueFixture;
  await init(); queueClient.stop();
  check(jobs.size === 2, "Server jobs were not restored in fresh renderer");
  check(document.querySelectorAll("#jobs-list details[data-job-id]").length === 2, "Recovered queue invisible");
  check(document.getElementById("jobs-list").textContent.toLowerCase().includes("исходник сохранён"), "Failed job recovery absent");
  check(!document.querySelector("#jobs-list img"), "Unescaped job preview injected HTML");
  check(window.__attack === 0, "Job payload executed script");
  if (restart === 0) {
    check(document.querySelectorAll('input[name="note-mode"]').length === 0, "Compact capture exposes a removed mode control");
    fixture.bridgeFailure = true;
    promptInput.value = "неподтверждённый исходник";
    await enqueueNote(promptInput.value);
    check(fixture.posts.length === 0, "Failed backend ensure must prevent POST");
    check(promptInput.value === "неподтверждённый исходник", "Failed backend ensure erased input");
    fixture.bridgeFailure = false;
    fixture.mode = "waiting";
    promptInput.value = "  Unicode η\n```json\n{\"value\":null}\n```  ";
    const raw = promptInput.value;
    const postStarted = new Promise((resolve) => { fixture.postStarted = resolve; });
    const submission = enqueueNote(raw);
    check(promptInput.value === raw, "Input cleared before durable 202");
    await postStarted;
    check(fixture.posts.at(-1).prompt === raw, "Renderer trimmed raw source");
    check(fixture.posts.at(-1).mode === "organize", "Compact capture must use the source-preserving pipeline");
    promptInput.value = "следующий черновик";
    fixture.release(); await submission;
    check(promptInput.value === "следующий черновик", "Accepted old request erased new draft");

    fixture.mode = "normal"; fixture.status = 200;
    await enqueueNote(promptInput.value);
    check(promptInput.value === "следующий черновик", "Non-202 response cleared input");
    fixture.status = 202;
    await enqueueNote(promptInput.value);
    check(promptInput.value === "", "Durable acknowledgement failed to clear submitted draft");

    await copyJobSource("persisted-failed");
    check(window.__copied === fixture.source, "Copied source was trimmed or reformatted");
    const restored = jobs.get("persisted-failed");
    check(restored.prompt_text === fixture.source, "Source detail was not retained exactly");
    const failedRow = document.querySelector('details[data-job-id="persisted-failed"]');
    failedRow.open = true;
    failedRow.dispatchEvent(new Event("toggle"));
    await new Promise(resolve => requestAnimationFrame(resolve));
    check(document.querySelector('details[data-job-id="persisted-failed"]').textContent.includes(fixture.source), "Raw source display changed text");
    check(window.__attack === 0, "Source detail executed script");

    renderCompletedNote({ title: "Необработанная заметка", content: fixture.source,
      tags: [], mode: "organize", generation: { metadata_pending: true } });
    check(notePreview.textContent.includes("Заголовок, теги и связи пока не обработаны"), "Unprocessed metadata warning is missing");
    check(!notePreview.querySelector("script"), "Fallback source was rendered as executable HTML");

    await queueClient.refresh(); // Finish any refresh started by the last acknowledged submission.
    const normalFailed = { job_id: "processing-failed", status: "failed", error: "Заметка не сохранена" };
    fixture.rows.push(normalFailed); await queueClient.refresh();
    const failedProcessingRow = document.querySelector('details[data-job-id="processing-failed"]');
    check(failedProcessingRow.dataset.status === "failed"
      && failedProcessingRow.querySelector(".quick-job-error").textContent.includes("Исходник сохранён"),
    "Durable source and failed processing were conflated");
    check(!jobsList.textContent.includes("Заметка не сохранена"), "Model error falsely denied durable source");

    const beforeRecovery = fixture.bridgeCalls;
    fixture.transportOffline = true;
    try { await queueClient.start(); } catch (error) {
      check(error.code === "transport_error", "Fetch failure lacked transport classification");
    }
    await queueClient.refresh(); queueClient.stop();
    check(fixture.bridgeCalls === beforeRecovery + 1, "Transport recovery did not use bridge exactly once");
    check(jobs.has("persisted-pending"), "Bridge reconnect lost server job identity");
    for (const mode of ["forbidden", "unavailable", "invalid-json", "invalid-shape"]) {
      fixture.responseMode = mode;
      let rejected = false;
      try { await queueClient.start(); } catch (error) {
        rejected = true;
        check(error.code !== "transport_error", "HTTP/schema failure classified as transport");
      }
      queueClient.stop();
      check(rejected, "Invalid API response was accepted");
      check(fixture.bridgeCalls === beforeRecovery + 1, "HTTP/schema failure restarted backend");
    }
    fixture.responseMode = "normal";
  }
  check(window.__storageWrites.every(({ key, value }) => key === "noda:quick-draft:v1:legacy"
    ? !value.includes("persisted-failed") && !value.includes("assets/example.svg")
    : key.startsWith("noda.noteProcessingMode.v1:") && ["organize", "organize_edit"].includes(value)),
  "Existing server data was copied to draft storage");
  queueClient.stop();
  return { restart, recovered: 2, status: "passed", exactRaw: restart === 0 };
};
