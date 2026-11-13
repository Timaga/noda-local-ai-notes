// Who: Tim Buglaev
// When: 2026-06-13
// What: Added TurboQuant toggle handling through the secure Electron bridge while keeping
//       runtime status rendering escaped and backend/vLLM process control outside the renderer.
const API_BASE = window.quickNoteBridge?.getBackendOrigin?.() || "http://127.0.0.1:5000";
const API_REQUEST_TIMEOUT_MS = 15000;
const quickText = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
const quickLocale = () => window.nodaI18n?.locale() ?? "ru-RU";
const projectContext = window.NodaProjectContext;
function captureProject() {
  const captured = projectContext?.snapshot();
  if (!captured || !projectContext.isCurrent(captured)) {
    throw Object.assign(new Error("The active project is not ready."), { code: "project_changed" });
  }
  return captured;
}
function assertProject(captured) {
  if (!projectContext?.isCurrent(captured)) {
    throw Object.assign(new Error("The active project changed."), { code: "project_changed" });
  }
}
const projectIds = captured => ({ projectId: captured.projectId, contextToken: captured.contextToken });

const QUICK_ERRORS = new Map([
  ["bridge_unavailable", ["Связь с приложением недоступна", "The application connection is unavailable"]],
  ["transport_error", ["Нет соединения с локальным сервером", "Cannot connect to the local server"]],
  ["runtime_unavailable", ["Локальная модель пока недоступна", "The local model is not ready yet"]],
  ["schema_error", ["Сервер вернул некорректный ответ", "The server returned an invalid response"]],
  ["input_error", ["Проверьте текст заметки и режим обработки", "Check the note text and processing mode"]],
  ["invalid_source", ["Проверьте текст и длину заметки", "Check the note text and length"]],
  ["invalid_mode", ["Проверьте режим обработки заметки", "Check the note processing mode"]],
  ["invalid_request_id", ["Некорректный идентификатор отправки", "Invalid submission ID"]],
  ["request_conflict", ["Идентификатор уже использован для другого текста или режима", "This submission ID belongs to different text or a different mode"]],
  ["submission_busy", ["Дождитесь завершения текущей отправки", "Wait for the current submission to finish"]],
  ["queue_full", ["Очередь заполнена, исходный текст не принят", "The queue is full and the source text was not accepted"]],
  ["vault_changed", ["Папка заметок изменилась, предыдущая отправка не повторялась", "The notes folder changed and the previous submission was not replayed"]],
  ["project_changed", ["Проект переключается. Черновик сохранён в прежнем проекте", "The project is switching. Your draft stays with its original project"]],
  ["project_transition", ["Дождитесь переключения проекта", "Wait for the project to finish switching"]],
  ["store_unavailable", ["Хранилище очереди недоступно", "Queue storage is unavailable"]],
  ["storage_quota", ["Хранилище очереди заполнено, сохранённые исходники на месте", "Queue storage is full and previously saved sources are intact"]],
  ["draft_storage_unavailable", ["Не удалось сохранить черновик в профиле Noda. Скопируйте текст перед выходом",
    "Could not save the draft to your Noda profile. Copy the text before quitting"]],
]);

function quickErrorMessage(error) {
  const message = QUICK_ERRORS.get(error?.code) || (error?.code?.startsWith("project_") && QUICK_ERRORS.get("project_changed"));
  if (message) return quickText(...message);
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    return quickText(`Ошибка локального сервера (HTTP ${error.status})`, `Local server error (HTTP ${error.status})`);
  }
  return quickText("Сбой приложения", "Application error");
}

const form = document.getElementById("quick-note-form");
const promptInput = document.getElementById("prompt-input");
const unsubscribeInputFocus = window.quickNoteBridge?.onQuickNoteFocusInput?.(() => {
  promptInput.focus({ preventScroll: true });
});
window.addEventListener("beforeunload", () => unsubscribeInputFocus?.(), { once: true });
const modeInputs = Array.from(document.querySelectorAll('input[name="note-mode"]'));
const MODE_SETTING_KEY = "noda.noteProcessingMode.v1";
for (const input of modeInputs) input.addEventListener("change", () => {
  if (!input.checked) return;
  try {
    const captured = captureProject();
    window.localStorage.setItem(`${MODE_SETTING_KEY}:${captured.projectId || "legacy"}`, input.value);
  } catch (_) { /* Session-only choice. */ }
  saveQuickDraft();
});
const enqueueBtn = document.getElementById("enqueue-btn");
const notesPanelBtn = document.getElementById("notes-panel-btn");
const statusCard = document.getElementById("status-card");
const statusText = document.getElementById("status-text");
const jobsList = document.getElementById("jobs-list");
const queueCounter = document.getElementById("queue-counter");
const recentNotesList = document.getElementById("recent-notes-list");
const notePreview = document.getElementById("note-preview");
const hotkeyValue = document.getElementById("hotkey-value");
const runtimeStatus = document.getElementById("runtime-status");
const turboquantStatus = document.getElementById("turboquant-status");
const turboquantToggle = document.getElementById("turboquant-toggle");
const turboquantToggleLabel = turboquantToggle ? turboquantToggle.closest(".toggle-chip") : null;
const quickCloseBtn = document.getElementById("quick-close-btn");
const quickCaptureView = window.QuickCaptureView?.create({
  onExpandJob: (id) => queueClient.detail(id),
  onCopySource: (id) => copyJobSource(id),
  onRetryJob: (id) => queueClient.retry(id),
  onDeleteJob: (id) => queueClient.removeJob(id),
  onCleanup: () => queueClient.cleanupHistory(),
  onShowEarlier: () => queueClient.showEarlier(),
  onShowRecent: () => Promise.resolve(queueClient.showRecent()).catch(() => {}),
  onResize: (height) => window.quickNoteBridge?.setQuickCaptureHeight?.(height)
    ?.catch(() => console.warn("Quick capture resize unavailable")),
});
if (quickCaptureView) window.quickCaptureView = quickCaptureView;

const jobs = new Map();
const expandedJobs = new Set();
let lastCompletedJobId = null;
let lastCompletedRecoveryId = null;
let currentRuntimePayload = null;
let turboquantApplying = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(timestampValue) {
  if (!timestampValue) {
    return quickText("не задано", "not set");
  }
  const date = new Date(timestampValue * 1000);
  if (Number.isNaN(date.getTime())) {
    return quickText("не задано", "not set");
  }
  const locale = quickLocale();
  return `${date.toLocaleDateString(locale)} ${date.toLocaleTimeString(locale)}`;
}

// Who: Tim Buglaev
// When: 2026-06-16
// What: Added compact relative timestamps for the hotkey recent-note list so
//       the bottom popup stays readable without exposing raw backend dates.
function formatRelativeTime(timestampValue) {
  if (!timestampValue) {
    return quickText("только что", "just now");
  }
  const timestampMs = Number(timestampValue) * 1000;
  const diffMs = Date.now() - timestampMs;
  if (!Number.isFinite(diffMs) || diffMs < 60000) {
    return quickText("только что", "just now");
  }
  const relative = new Intl.RelativeTimeFormat(quickLocale(), { style: "short" });
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) {
    return relative.format(-minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return relative.format(-hours, "hour");
  }
  const days = Math.round(hours / 24);
  return relative.format(-days, "day");
}

function setStatus(type, message) {
  quickCaptureView?.setStatus(type, message);
  statusCard.classList.remove("ok", "warn", "error");
  if (type) {
    statusCard.classList.add(type);
  }
  statusText.textContent = message;
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Added bounded renderer fetches so local API calls fail visibly instead of leaving
//       controls disabled when the backend or managed vLLM runtime stops responding.
async function fetchWithTimeout(url, options = {}, timeoutMs = API_REQUEST_TIMEOUT_MS, captured = captureProject()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    assertProject(captured);
    const response = await projectContext.fetch(url, {
      ...options,
      signal: controller.signal,
    });
    assertProject(captured);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function renderQueueCounter(serverQueuedCount = null) {
  const localPending = Array.from(jobs.values()).filter((job) => (
    (job.status || "").toLowerCase() === "queued"
      || (job.status || "").toLowerCase() === "processing"
  )).length;

  const count = Number.isFinite(serverQueuedCount) ? serverQueuedCount : localPending;
  if (quickCaptureView) {
    quickCaptureView.renderQueueCounter(count);
    return;
  }
  queueCounter.textContent = quickText(`Очередь: ${count}`, `Queue: ${count}`);
}

async function copyJobSource(jobId) {
  const captured = projectContext.snapshot();
  try {
    assertProject(captured);
    const detail = await queueClient.detail(jobId);
    assertProject(captured);
    if (typeof detail.prompt_text !== "string") throw new Error("Исходник не получен.");
    await navigator.clipboard.writeText(detail.prompt_text);
    assertProject(captured);
    setStatus("ok", quickText("Исходник скопирован.", "Source text copied."));
  } catch (_) {
    if (!projectContext.isCurrent(captured)) return;
    setStatus("error", quickText("Не удалось скопировать исходник.", "Could not copy the source text."));
  }
}

// Who: Tim Buglaev
// When: 2026-06-16
// What: Render the last five submitted quick notes as expandable, escaped DOM
//       nodes so the compact hotkey window shows recent input without XSS risk.
function renderRecentNotes(jobArray = null) {
  if (!recentNotesList) {
    return;
  }

  const recentJobs = (jobArray || Array.from(jobs.values()))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .slice(0, 5);

  recentNotesList.replaceChildren();
  if (!recentJobs.length) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "recent-note-empty";
    emptyItem.textContent = quickText("Пока нет быстрых заметок.", "No quick notes yet.");
    recentNotesList.appendChild(emptyItem);
    return;
  }

  recentJobs.forEach((job) => {
    const text = String(job.prompt_preview || job.result_title || "");
    const title = text || job.result_title || quickText("Заметка добавлена в очередь", "Note added to the queue");
    const item = document.createElement("li");
    item.className = "recent-note-row";

    const details = document.createElement("details");
    details.className = "recent-note-item";

    const summary = document.createElement("summary");
    summary.className = "recent-note-summary";

    const icon = document.createElement("span");
    icon.className = "recent-note-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▤";

    const textSpan = document.createElement("span");
    textSpan.className = "recent-note-text";
    textSpan.textContent = title;

    const timeSpan = document.createElement("span");
    timeSpan.className = "recent-note-time";
    timeSpan.textContent = `${statusLabel(job.status)} · ${formatRelativeTime(job.created_at)}`;

    const chevron = document.createElement("span");
    chevron.className = "recent-note-chevron ui-icon ui-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.dataset.uiIcon = "chevron";

    summary.append(icon, textSpan, timeSpan, chevron);

    const fullText = document.createElement("pre");
    fullText.className = "recent-note-full";
    fullText.style.whiteSpace = "pre-wrap";
    fullText.textContent = typeof job.prompt_text === "string" ? job.prompt_text
      : quickText("Откройте, чтобы загрузить сохранённый исходник.", "Expand to load the saved source text.");

    const errorText = document.createElement("p");
    errorText.textContent = job.error_code === "publication_unknown"
      ? quickText("Проверьте результат публикации. Исходник сохранён. Автоматический повтор остановлен.",
        "Check the publication result. The source text is saved. Automatic retries have stopped.")
      : (job.status === "failed" ? failedJobText() : "");
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = quickText("Скопировать исходник", "Copy source text");
    copyButton.addEventListener("click", () => copyJobSource(job.job_id));
    details.open = expandedJobs.has(job.job_id);
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      if (!details.open) { expandedJobs.delete(job.job_id); return; }
      const wasExpanded = expandedJobs.has(job.job_id);
      expandedJobs.clear();
      expandedJobs.add(job.job_id);
      if (!wasExpanded && typeof job.prompt_text !== "string") {
        const captured = captureProject();
        queueClient.detail(job.job_id).catch(() => {
          if (!projectContext.isCurrent(captured)) return;
          setStatus("warn", quickText("Исходник пока недоступен.", "The source text is unavailable for now."));
        });
      }
    });

    details.append(summary, errorText, fullText, copyButton);
    item.appendChild(details);
    recentNotesList.appendChild(item);
  });
}

function failedJobText() {
  return quickText("Исходный текст сохранён. Обработка не завершена. Исходник можно скопировать.",
    "The source text is saved. Processing did not finish. You can copy the source text.");
}

function statusLabel(status) {
  const normalized = (status || "queued").toLowerCase();
  const labels = {
    queued: quickText("в очереди", "queued"),
    processing: quickText("в работе", "processing"),
    completed: quickText("готово", "complete"),
    failed: quickText("ошибка", "failed"),
  };
  return labels[normalized] || normalized;
}

function modeLabel(mode) {
  return mode === "organize_edit" ? quickText("Организовать и отредактировать", "Organize and edit")
    : quickText("Организовать", "Organize");
}

function renderJobs(queue = null, paging = {}) {
  const jobArray = Array.from(jobs.values()).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (quickCaptureView) {
    quickCaptureView.renderJobs(jobArray, queue, paging);
    return;
  }
  renderRecentNotes(jobArray);
  if (!jobsList) {
    return;
  }
  jobsList.innerHTML = "";

  if (!jobArray.length) {
    const li = document.createElement("li");
    li.className = "job-item";
    const placeholder = document.createElement("p");
    placeholder.className = "job-text";
    placeholder.textContent = quickText("Пока пусто. Добавьте первую заметку.", "The queue is empty. Add your first note.");
    li.appendChild(placeholder);
    jobsList.appendChild(li);
    return;
  }

  jobArray.forEach((job) => {
    const status = (job.status || "queued").toLowerCase();
    const li = document.createElement("li");
    li.className = "job-item";
    li.innerHTML = `
      <div class="job-top">
        <span class="job-status ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
        <span>${escapeHtml(modeLabel(job.mode))} · ${escapeHtml(formatTimestamp(job.created_at))}</span>
      </div>
      <p class="job-text">${escapeHtml(job.prompt_preview || "")}</p>
    `;
    if (status === "failed") {
      const message = document.createElement("p");
      message.textContent = job.error_code === "publication_unknown"
        ? quickText("Проверьте результат публикации. Исходник сохранён.", "Check the publication result. The source text is saved.")
        : failedJobText();
      li.appendChild(message);
    }
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.textContent = quickText("Скопировать исходник", "Copy source text");
    sourceButton.addEventListener("click", () => copyJobSource(job.job_id));
    li.appendChild(sourceButton);
    jobsList.appendChild(li);
  });
}

function renderCompletedNote(resultPayload) {
  if (!resultPayload || !notePreview) {
    return;
  }

  const title = escapeHtml(resultPayload.display_title || resultPayload.generated_title || resultPayload.title
    || quickText("Новая заметка", "New note"));
  const tags = Array.isArray(resultPayload.tags) ? resultPayload.tags : [];
  const body = escapeHtml(resultPayload.content || "");

  const tagsHtml = tags.length
    ? `<div class="tag-row">${tags.map((tag) => `<span class="tag-pill">#${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";

  const editWarning = resultPayload.mode === "organize_edit"
    && resultPayload.generation?.editing_applied === false
    ? `<p class="note-edit-warning">${escapeHtml(quickText("Редактура не применена. Сохранён исходный текст.",
      "Edits were not applied. The original text is saved."))}</p>` : "";
  const metadataWarning = resultPayload.generation?.metadata_pending === true
    ? `<p class="note-edit-warning">${escapeHtml(quickText("Исходник сохранён как заметка. Заголовок, теги и связи пока не обработаны.",
      "The source text is saved as a note. Its title, tags, and links are still pending."))}</p>` : "";

  notePreview.innerHTML = `
    <h3 class="note-title">${title}</h3>
    ${editWarning}
    ${metadataWarning}
    ${tagsHtml}
    <p class="note-body">${body}</p>
`;
}

function setTurboquantLabel(text, active = false) {
  if (!turboquantStatus) {
    return;
  }
  const dot = document.createElement("span");
  dot.className = "quick-dot";
  dot.setAttribute("aria-hidden", "true");
  turboquantStatus.replaceChildren(dot, document.createTextNode(text));
  turboquantStatus.classList.toggle("active", Boolean(active));
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Wired runtime status to the new TurboQuant toggle, disabling it when runtime
//       config is unavailable or not vLLM-backed so users cannot submit invalid changes.
function renderRuntimeConfig(runtimePayload) {
  currentRuntimePayload = runtimePayload || null;
  if (!runtimePayload) {
    if (turboquantToggle) {
      turboquantToggle.checked = false;
      turboquantToggle.disabled = true;
    }
    if (turboquantToggleLabel) {
      turboquantToggleLabel.classList.remove("active");
    }
    runtimeStatus.textContent = quickText("Модель: недоступна", "Model: unavailable");
    setTurboquantLabel(quickText("TurboQuant недоступен", "TurboQuant unavailable"), false);
    return;
  }

  const providerLabel = runtimePayload.provider === "vllm_local" ? quickText("локальный vLLM", "local vLLM")
    : quickText("локальная", "local");
  const modelId = runtimePayload.runtime_model_id || runtimePayload.vllm?.model_id || quickText("не задана", "not set");
  runtimeStatus.textContent = quickText(`Модель: ${providerLabel} (${modelId})`, `Model: ${providerLabel} (${modelId})`);

  const turboquant = runtimePayload.turboquant || {};
  if (turboquantToggle) {
    turboquantToggle.checked = Boolean(turboquant.enabled);
    turboquantToggle.disabled = turboquantApplying || runtimePayload.provider !== "vllm_local";
  }
  if (turboquantToggleLabel) {
    turboquantToggleLabel.classList.toggle("active", Boolean(turboquant.enabled));
  }
  if (turboquant.enabled) {
    setTurboquantLabel("TurboQuant", true);
  } else {
    setTurboquantLabel(quickText("TurboQuant выкл.", "TurboQuant off"), false);
  }
}

async function prepareQuickSubmission(prompt, mode, captured) {
  assertProject(captured);
  if (typeof window.quickNoteBridge?.ensureGenerationRuntimeReady !== "function") return;
  try {
    const ready = await window.quickNoteBridge.ensureGenerationRuntimeReady({ prompt, mode, ...projectIds(captured) });
    assertProject(captured);
    if (ready?.ok === true) return;
  } catch (error) {
    assertProject(captured);
    if (error?.code?.startsWith("project_")) throw error;
  }
  throw Object.assign(new Error("Локальная модель пока недоступна."), { code: "runtime_unavailable" });
}

async function apiRequest(path, options = {}, expectedStatus = null, captured = captureProject()) {
  assertProject(captured);
  let response;
  try {
    response = await fetchWithTimeout(`${API_BASE}${path}`, options, API_REQUEST_TIMEOUT_MS, captured);
  } catch (failure) {
    assertProject(captured);
    if (failure.code?.startsWith("project_")) throw failure;
    const error = new Error("Нет соединения с локальным сервером.");
    error.code = failure instanceof TypeError || failure.name === "AbortError"
      ? "transport_error" : "request_error";
    throw error;
  }
  let payload;
  try { payload = await response.json(); }
  catch (failure) {
    assertProject(captured);
    if (failure.code?.startsWith("project_")) throw failure;
    throw Object.assign(new Error("Сервер вернул нечитаемый ответ."), { code: "schema_error", status: response.status });
  }
  assertProject(captured);
  if (!response.ok || (expectedStatus !== null && response.status !== expectedStatus)) {
    throw Object.assign(new Error(payload?.error || `HTTP ${response.status}`), {
      status: response.status, code: payload?.code || "http_error",
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("Сервер вернул некорректный ответ."), { code: "schema_error", status: response.status });
  }
  return payload;
}

async function ensureBackendReady(captured = captureProject()) {
  assertProject(captured);
  if (!window.quickNoteBridge || typeof window.quickNoteBridge.ensureBackendReady !== "function") {
    throw new Error("Bridge is unavailable.");
  }
  await window.quickNoteBridge.ensureBackendReady(projectIds(captured));
  assertProject(captured);
}

async function refreshRuntimeConfig(captured = captureProject()) {
  const runtimePayload = await apiRequest("/runtime/config", {}, null, captured);
  assertProject(captured);
  renderRuntimeConfig(runtimePayload);
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Added persistent TurboQuant enable/disable flow through main-process IPC so
//       toggling restarts only the managed runtime and never exposes process control to the DOM.
async function applyTurboQuantEnabled(enabled) {
  const captured = captureProject();
  if (!window.quickNoteBridge || typeof window.quickNoteBridge.updateRuntimeConfig !== "function") {
    throw new Error("Runtime bridge is unavailable.");
  }
  turboquantApplying = true;
  if (turboquantToggle) {
    turboquantToggle.disabled = true;
  }
  setStatus("warn", enabled ? quickText("Включаем TurboQuant…", "Enabling TurboQuant…")
    : quickText("Выключаем TurboQuant…", "Disabling TurboQuant…"));

  try {
    const payload = await window.quickNoteBridge.updateRuntimeConfig({
      turboquant_enabled: enabled,
      reload_model: false,
      ...projectIds(captured),
    });
    assertProject(captured);
    renderRuntimeConfig(payload.runtime || await apiRequest("/runtime/config"));
    setStatus("ok", enabled ? quickText("TurboQuant включён.", "TurboQuant enabled.")
      : quickText("TurboQuant выключен.", "TurboQuant disabled."));
  } catch (_) {
    if (!projectContext.isCurrent(captured)) return;
    if (turboquantToggle) {
      turboquantToggle.checked = !enabled;
    }
    setStatus("error", quickText("Не удалось изменить TurboQuant.", "Could not change TurboQuant."));
    try {
      await refreshRuntimeConfig();
    } catch (_) {
      if (projectContext.isCurrent(captured)) renderRuntimeConfig(currentRuntimePayload);
    }
  } finally {
    if (projectContext.isCurrent(captured)) {
      turboquantApplying = false;
      renderRuntimeConfig(currentRuntimePayload);
    }
  }
}

const queueClient = window.QuickCaptureProject.create({
  context: projectContext,
  storage: window.QuickCaptureProject.createDraftStorage(() => window.localStorage),
  readDraft: () => ({ text: promptInput.value, mode: modeInputs.find(input => input.checked)?.value || "organize" }),
  writeDraft(draft, captured, remembered) {
    if (captured && !remembered) {
      try {
        const mode = window.localStorage.getItem(`${MODE_SETTING_KEY}:${captured.projectId || "legacy"}`);
        if (["organize", "organize_edit"].includes(mode)) draft = { ...draft, mode };
      } catch (_) { /* A disabled preference store leaves this project's safe default. */ }
    }
    promptInput.value = draft.text;
    quickCaptureView?.resizeInput();
    modeInputs.forEach(input => { input.checked = input.value === draft.mode; });
  },
  reset() {
    jobs.clear(); expandedJobs.clear(); lastCompletedJobId = null; lastCompletedRecoveryId = null;
    turboquantApplying = false;
    notePreview?.replaceChildren(); renderRuntimeConfig(null); renderJobs(); renderQueueCounter(0);
  },
  onProject: (state) => quickCaptureView?.renderProject(state),
  onState(state) {
    const ready = state.status === "ready";
    enqueueBtn.disabled = !ready; promptInput.disabled = !ready;
    form.setAttribute("aria-busy", String(!ready));
    setStatus(ready ? "ok" : state.status === "error" ? "error" : "warn", ready
      ? quickText("Готово к вводу.", "Ready for input.")
      : state.status === "error" ? quickText("Проект недоступен. Черновики сохранены.", "The project is unavailable. Drafts are preserved.")
        : quickText("Переключаем проект…", "Switching project…"));
  },
  onReady(captured) { refreshRuntimeConfig(captured).catch(() => {}); },
  createClient(captured, pendingSubmission, onSubmissionChange) { return window.GenerationQueueClient.create({
  request: (path, options, status) => apiRequest(path, options, status, captured),
  prepareSubmission: (raw, mode) => prepareQuickSubmission(raw, mode, captured),
  pendingSubmission,
  onSubmissionChange,
  isCurrent: () => projectContext.isCurrent(captured),
  requireVault: true,
  ensureBackendReady: () => ensureBackendReady(captured),
  onChange(serverJobs, queue, paging) {
    jobs.clear();
    serverJobs.forEach((job) => jobs.set(job.job_id, job));
    for (const id of expandedJobs) if (!jobs.has(id)) expandedJobs.delete(id);
    if (lastCompletedJobId && !jobs.has(lastCompletedJobId)) {
      lastCompletedJobId = null; lastCompletedRecoveryId = null;
      if (notePreview) notePreview.replaceChildren();
    }
    if (!serverJobs.length && !queue) {
      lastCompletedJobId = null;
      lastCompletedRecoveryId = null;
      if (notePreview) notePreview.replaceChildren();
    }
    renderJobs(queue, paging);
    renderQueueCounter(Number.isFinite(queue?.queued_count)
      ? queue.queued_count + (queue.processing_count ?? Number(queue.processing === true)) : null);
    const completed = serverJobs.filter((job) => job.status === "completed")
      .sort((a, b) => (b.completed_at || b.created_at || 0) - (a.completed_at || a.created_at || 0))[0];
    const recoveryId = completed?.recovery_summary?.request_id || null;
    if (completed && (completed.job_id !== lastCompletedJobId || recoveryId !== lastCompletedRecoveryId)) {
      lastCompletedJobId = completed.job_id;
      lastCompletedRecoveryId = recoveryId;
      if (completed.result) renderCompletedNote(completed.result);
      else queueClient.detail(completed.job_id).then((job) => {
        if (projectContext.isCurrent(captured) && lastCompletedJobId === job.job_id && lastCompletedRecoveryId === recoveryId) renderCompletedNote(job.result);
      }).catch(() => { if (projectContext.isCurrent(captured) && lastCompletedJobId === completed.job_id
          && lastCompletedRecoveryId === recoveryId) setStatus("warn", quickText("Заметка создана. Предпросмотр пока недоступен.",
        "The note was created. The preview is unavailable for now.")); });
    }
  },
  onAccepted(job, raw) {
    assertProject(captured);
    if (job.removed === true) {
      setStatus("warn", quickText("Это задание удалено из очереди. Ввод сохранён; отправьте его снова, чтобы создать новое задание.",
        "This job was removed from the queue. Your input was kept; submit it again to create a new job."));
      return;
    }
    if (promptInput.value === raw) {
      promptInput.value = "";
      quickCaptureView?.resizeInput();
    }
    setStatus(job.status === "failed" || job.processing_outcome === "source_saved" ? "warn" : "ok",
      job.processing_outcome === "source_saved"
        ? quickText("Исходник сохранён. Обработка не завершена. Подробности в очереди.",
          "The source is saved. Processing did not finish. See the queue for details.") : job.status === "completed"
      ? quickText("Заметка уже создана.", "The note has already been created.") : job.status === "failed"
        ? quickText("Исходник сохранён. Генерация не завершена. Подробности в очереди.",
          "The source text is saved. Generation did not finish. See the queue for details.")
        : quickText("Исходник сохранён. Задание принято в очередь.", "The source text is saved. The job is queued."));
  },
  onError(error) {
    if (!projectContext.isCurrent(captured)) return;
    const recovery = error.recoveryExhausted
      ? quickText(" Автозапуск приостановлен после трёх попыток. Проверяем соединение.",
        " Automatic startup paused after three attempts. Checking the connection.")
      : error.code === "transport_error" ? quickText(" Восстанавливаем соединение.", " Reconnecting.") : "";
    setStatus(error.recoveryExhausted ? "error" : "warn",
      `${quickText("Очередь недоступна", "Queue unavailable")}. ${quickErrorMessage(error)}.${recovery}`);
  },
}); },
});

function saveQuickDraft() {
  if (!queueClient.saveDraft()) {
    setStatus("error", quickErrorMessage({ code: "draft_storage_unavailable" }));
  }
}
promptInput.addEventListener("input", saveQuickDraft);
window.addEventListener("online", () => queueClient.refresh().catch(() => {}));
window.addEventListener("beforeunload", () => queueClient.dispose());

async function enqueueNote(promptText) {
  if (enqueueBtn.disabled) return;
  const captured = captureProject();
  enqueueBtn.disabled = true;
  const submissionFocus = document.activeElement;
  try {
    setStatus("warn", quickText("Сохраняем исходник в очередь…", "Saving the source text to the queue…"));
    await queueClient.ensureReady();
    assertProject(captured);
    const mode = modeInputs.find((input) => input.checked)?.value || "organize";
    await queueClient.enqueue(promptText, "local", mode);
    queueClient.refresh().catch(() => {});
  } catch (error) {
    if (!projectContext.isCurrent(captured)) return;
    setStatus("error", `${quickText("Отправка не подтверждена", "Submission was not confirmed")}. ${quickErrorMessage(error)}. ${
      quickText("Текст остаётся в поле ввода.", "Your text is still in the input field.")}`);
  } finally {
    if (projectContext.isCurrent(captured)) {
      enqueueBtn.disabled = false;
      if (document.activeElement === submissionFocus) promptInput.focus();
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const promptText = promptInput.value || "";
  if (!promptText.trim()) {
    setStatus("warn", quickText("Введите текст заметки.", "Enter the note text."));
    return;
  }
  await enqueueNote(promptText);
});

promptInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (event.repeat) return;
    const promptText = promptInput.value || "";
    if (promptText.trim()) {
      await enqueueNote(promptText);
    } else {
      setStatus("warn", quickText("Введите текст заметки.", "Enter the note text."));
    }
  }

  if (event.key === "Escape" && window.quickNoteBridge) {
    window.quickNoteBridge.toggleWindow();
  }
});

if (turboquantToggle) {
  turboquantToggle.addEventListener("change", (event) => {
    const captured = projectContext.snapshot();
    applyTurboQuantEnabled(Boolean(event.target.checked)).catch(() => {
      if (!projectContext.isCurrent(captured)) return;
      setStatus("error", quickText("Не удалось изменить TurboQuant.", "Could not change TurboQuant."));
    });
  });
}

// Who: Tim Buglaev
// When: 2026-06-16
// What: Added a compact custom close button for the frameless hotkey popup,
//       reusing the existing main-process toggle IPC instead of exposing window APIs.
if (quickCloseBtn) {
  quickCloseBtn.addEventListener("click", () => {
    if (window.quickNoteBridge && typeof window.quickNoteBridge.toggleWindow === "function") {
      window.quickNoteBridge.toggleWindow();
    }
  });
}

// Who: Tim Buglaev
// When: 2026-06-13
// What: Wired quick-capture UI to the dedicated notes panel through a narrow IPC method,
//       keeping note cleanup reachable without exposing filesystem APIs to the renderer.
if (notesPanelBtn) {
  notesPanelBtn.addEventListener("click", async () => {
    try {
      if (!window.quickNoteBridge || typeof window.quickNoteBridge.openNotesPanel !== "function") {
        throw new Error("Bridge is unavailable.");
      }
      await window.quickNoteBridge.openNotesPanel();
    } catch (_) {
      setStatus("error", quickText("Не удалось открыть панель заметок.", "Could not open the notes panel."));
    }
  });
}

async function init() {
  renderJobs();
  renderQueueCounter(0);
  await projectContext.ready();
  const captured = captureProject();
  queueClient.start().catch(() => {});

  if (!window.quickNoteBridge) {
    setStatus("error", quickText("Связь с приложением недоступна.", "The application connection is unavailable."));
    return;
  }

  // Who: Tim Buglaev
  // When: 2026-06-14
  // What: Block quick-capture initialization behind the shared startup gate so
  //       users cannot enqueue notes before backend, Qdrant, and vLLM are ready.
  try {
    // Lock readiness before the first IPC await, so a late hotkey reply cannot blur the editor.
    if (!window.startupGate || typeof window.startupGate.waitForReady !== "function") {
      throw new Error("Startup gate is unavailable.");
    }
    await window.startupGate.waitForReady();
    assertProject(captured);
    try {
      const hotkey = await window.quickNoteBridge.getHotkey();
      assertProject(captured);
      hotkeyValue.textContent = hotkey || quickText("не задано", "not set");
    } catch (_) {
      assertProject(captured);
      hotkeyValue.textContent = quickText("не задано", "not set");
    }
    await refreshRuntimeConfig(captured);
    await queueClient.refresh();
    assertProject(captured);
    setStatus("ok", quickText("Готово к вводу.", "Ready for input."));
  } catch (error) {
    if (!projectContext.isCurrent(captured)) return;
    try {
      await refreshRuntimeConfig(captured);
    } catch (_) {
      if (!projectContext.isCurrent(captured)) return;
      renderRuntimeConfig(null);
    }
    setStatus("error", `${quickText("Приложение не готово", "The application is not ready")}. ${quickErrorMessage(error)}.`);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    if (["project_changed", "project_transition"].includes(error.code)) return;
    setStatus("error", `${quickText("Ошибка инициализации", "Startup error")}. ${quickErrorMessage(error)}.`);
  });
});
