(function (root) {
  "use strict";
  const STATUSES = new Set(["queued", "processing", "completed", "failed"]);
  const validJob = (job) => job && typeof job.job_id === "string"
    && job.job_id.length > 0 && STATUSES.has(job.status);
  const key = (value) => String(value || "").replaceAll("-", "").toLowerCase();
  const activeJob = (job) => job.status === "queued" || job.status === "processing";
  const problem = (code, message) => Object.assign(new Error(message), { code });
  const vaultChanged = () => Object.assign(
    problem("vault_changed", "Папка заметок сменилась. Предыдущая отправка в неё не повторялась; проверьте оставшийся ввод."),
    { status: 409 },
  );
  const transportFailure = (error) => error.code === "transport_error" && !Number.isFinite(error.status);
  const RECENT_LIMIT = 50, DETAIL_LIMIT = 2, RECOVERY_LIMIT = 3;

  function create(options) {
    const { request: transportRequest, onChange = () => {}, onError = () => {}, onAccepted = () => {} } = options;
    const later = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    const newId = options.newRequestId || (() => root.crypto.randomUUID());
    const jobs = new Map();
    const details = new Map();
    let cursor = null, activeOffset = 0, timer = null, running = false;
    let pending = options.pendingSubmission ? { ...options.pendingSubmission, attempted: true } : null;
    let refreshing = null, sending = null, queue = null, vaultId = pending?.vaultId ?? null;
    let ensuring = null, recoveryAttempts = 0, failedPass = false;
    let historyRevision = null;
    let latestCursor = null, olderCursor = null, olderJobs = null;
    let epoch = 0, mutationVersion = 0;
    const removing = new Map();
    const current = () => typeof options.isCurrent !== "function" || options.isCurrent();
    function guard(observed = epoch) {
      if (observed !== epoch || !current()) throw problem("project_changed", "The active project changed.");
    }
    async function request(...args) {
      const observed = epoch;
      guard(observed);
      try {
        const payload = await transportRequest(...args);
        guard(observed);
        return payload;
      } catch (error) { guard(observed); throw error; }
    }

    function knownJob(id) { return jobs.get(id) || olderJobs?.get(id); }
    function values() {
      const visible = olderJobs
        ? new Map([...olderJobs, ...Array.from(jobs).filter(([, job]) => activeJob(job))])
        : jobs;
      return Array.from(visible.values(), (job) => ({ ...details.get(job.job_id), ...job }));
    }
    function changed() {
      if (current()) onChange(values(), queue, {
        older: olderJobs !== null, hasEarlier: (olderJobs ? olderCursor : latestCursor) !== null,
      });
    }

    function ensureReady() {
      try { guard(); } catch (error) { return Promise.reject(error); }
      if (ensuring) return ensuring;
      if (typeof options.ensureBackendReady !== "function") {
        return Promise.reject(problem("bridge_unavailable", "Мост запуска приложения недоступен."));
      }
      const observed = epoch;
      ensuring = Promise.resolve().then(() => { guard(observed); return options.ensureBackendReady(); })
        .then(value => { guard(observed); return value; })
        .finally(() => { ensuring = null; });
      return ensuring;
    }

    async function recover(error) {
      if (!current() || !running || !transportFailure(error)) return;
      if (!ensuring && recoveryAttempts >= RECOVERY_LIMIT) {
        error.recoveryExhausted = true;
        return;
      }
      if (!ensuring) recoveryAttempts += 1;
      try { await ensureReady(); }
      catch (failure) { error.recoveryCode = failure.code || "backend_start_failed"; }
      // A successful IPC call alone does not prove a connection to the server.
      error.recoveryExhausted = recoveryAttempts >= RECOVERY_LIMIT;
    }

    function forgetSubmission(context) {
      if (pending !== context) return;
      pending = null;
      if (context?.attempted) options.onSubmissionChange?.(null);
    }

    function acknowledgeSubmission(context, job) {
      if (pending !== context) return;
      context.acknowledged = job;
      // Persist the remaining input together with removal of the receipt key.
      onAccepted(job, context.raw);
      forgetSubmission(context);
    }

    function checkVault(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw problem("schema_error", "Сервер вернул некорректный ответ.");
      }
      const value = payload.vault_id || payload.job?.vault_id || payload.queue?.vault_id;
      if (typeof value !== "string" || !value) return;
      if (vaultId !== null && value !== vaultId) {
        jobs.clear(); details.clear(); forgetSubmission(pending); queue = null; cursor = null; vaultId = value;
        historyRevision = null;
        latestCursor = null; olderCursor = null; olderJobs = null;
        changed();
        throw vaultChanged();
      }
      vaultId = value;
    }

    function applyHistory(revision, pruneCompleted = true) {
      if (!Number.isSafeInteger(revision) || revision < 0) return { current: true, changed: false };
      if (historyRevision !== null && revision < historyRevision) return { current: false, changed: false };
      const changed = historyRevision !== null && revision > historyRevision;
      historyRevision = revision;
      if (changed) {
        cursor = null;
        latestCursor = null;
        for (const collection of pruneCompleted ? [jobs, olderJobs] : []) {
          if (!collection) continue;
          for (const job of collection.values()) {
            if (job.processing_outcome !== "completed") continue;
            collection.delete(job.job_id);
            details.delete(job.job_id);
          }
        }
      }
      return { current: true, changed };
    }

    function accept(job) {
      if (!validJob(job)) throw problem("schema_error", "Сервер вернул некорректное задание.");
      if (job.archived === true || job.removed === true) {
        jobs.delete(job.job_id);
        olderJobs?.delete(job.job_id);
        details.delete(job.job_id);
        if (pending && key(job.client_request_id) === key(pending.id)) acknowledgeSubmission(pending, job);
        return;
      }
      // History holds only compact metadata, never every completed body or raw source.
      const summary = {};
      for (const field of ["job_id", "status", "created_at", "completed_at", "client_request_id",
        "vault_id", "error_code", "retryable", "next_attempt_at", "phase", "attempts",
        "processing_outcome", "retry_available"]) {
        if (job[field] !== undefined) summary[field] = job[field];
      }
      if (job.recovery_summary && typeof job.recovery_summary.request_id === "string"
          && ["queued", "processing", "completed", "failed", "conflict"].includes(job.recovery_summary.status)) {
        summary.recovery_summary = {
          request_id: job.recovery_summary.request_id.slice(0, 64), status: job.recovery_summary.status,
          retry_count: job.recovery_summary.retry_count,
        };
      } else if (job.recovery_summary === null) summary.recovery_summary = null;
      if (job.processing_error && typeof job.processing_error === "object") {
        const safeCodes = new Set(["context_budget_exceeded", "links_reranker_source_too_long",
          "links_reranker_window_budget_exceeded"]);
        const detail = job.processing_error.detail_code;
        const code = job.processing_error.code;
        summary.processing_error = { code: safeCodes.has(code) ? code : "generation_failed",
          detail_code: safeCodes.has(detail) ? detail : "generation_failed" };
      } else if (job.processing_error === null) summary.processing_error = null;
      const recoveryChanged = summary.recovery_summary?.request_id
        && summary.recovery_summary.request_id !== knownJob(job.job_id)?.recovery_summary?.request_id;
      if (recoveryChanged && details.has(job.job_id)) {
        details.set(job.job_id, { prompt_text: details.get(job.job_id).prompt_text, result: undefined });
      }
      if (recoveryChanged) summary.result_title = undefined;
      if (job.progress?.version === 1 && Array.isArray(job.progress.stages)) {
        const stageIds = new Set(["title", "tags", "links", "save"]);
        const stageStates = new Set(["pending", "running", "completed", "failed", "skipped"]);
        summary.progress = {
          version: 1,
          attempt: Number.isInteger(job.progress.attempt) ? job.progress.attempt : 0,
          current_stage: stageIds.has(job.progress.current_stage) ? job.progress.current_stage : null,
          stages: job.progress.stages.slice(0, 4)
            .filter(stage => stage && stageIds.has(stage.id) && stageStates.has(stage.status))
            .map(stage => ({ id: stage.id, status: stage.status })),
        };
      } else if (job.progress === null) summary.progress = null;
      if (typeof job.prompt_preview === "string") summary.prompt_preview = job.prompt_preview.slice(0, 280);
      const resultTitle = [job.result?.display_title, job.result?.generated_title, job.result?.title]
        .find(value => typeof value === "string" && value.trim());
      if (resultTitle) summary.result_title = resultTitle;
      const currentJob = { ...knownJob(job.job_id), ...summary };
      jobs.set(job.job_id, currentJob);
      if (olderJobs?.has(job.job_id)) olderJobs.set(job.job_id, currentJob);
      retryClient?.observeJob(job);
      const terminal = Array.from(jobs.values()).filter((value) => !activeJob(value))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.job_id.localeCompare(b.job_id));
      for (const old of terminal.slice(RECENT_LIMIT)) {
        jobs.delete(old.job_id);
        if (!olderJobs?.has(old.job_id)) details.delete(old.job_id);
      }
      if (pending && key(job.client_request_id) === key(pending.id)) acknowledgeSubmission(pending, job);
      return currentJob;
    }

    async function detail(id, keepContent = true) {
      const observedJob = knownJob(id), observedVault = vaultId;
      const observedMutation = mutationVersion;
      let payload;
      try { payload = await request(`/generate/jobs/${encodeURIComponent(id)}`); }
      catch (error) {
        if (error.code === "job_not_found" && knownJob(id) === observedJob) {
          jobs.delete(id); olderJobs?.delete(id); details.delete(id); mutationVersion += 1; changed();
        }
        throw error;
      }
      if (observedVault !== vaultId) {
        throw problem("vault_changed", "The notes folder changed while loading the job.");
      }
      checkVault(payload);
      if (payload.job?.removed === true || (observedMutation !== mutationVersion && !knownJob(id))) {
        if (payload.job?.removed === true) accept(payload.job);
        changed(); throw problem("job_not_found", "This job is no longer available in this queue.");
      }
      if (!validJob(payload.job) || payload.job.job_id !== id) {
        throw problem("schema_error", "Сервер вернул другое задание.");
      }
      const fresh = knownJob(id) === observedJob;
      if (fresh || payload.job.archived === true) accept(payload.job);
      const current = knownJob(id);
      const compatibleResult = fresh || (current?.status === "completed" && payload.job.status === "completed"
        && current.processing_outcome === payload.job.processing_outcome && current.attempts === payload.job.attempts
        && current.recovery_summary?.request_id === payload.job.recovery_summary?.request_id);
      const result = compatibleResult ? payload.job.result : details.get(id)?.result;
      if (keepContent && current) {
        details.delete(id);
        details.set(id, { prompt_text: payload.job.prompt_text, result });
        while (details.size > DETAIL_LIMIT) details.delete(details.keys().next().value);
      }
      changed();
      return { ...payload.job, ...current, result };
    }

    function schedule() {
      if (!current() || !running || timer !== null) return;
      const active = Array.from(jobs.values()).some(activeJob);
      const delay = failedPass ? Math.max(5000, recoveryAttempts * 5000)
        : active || cursor !== null ? (options.intervalMs || 900) : (options.idleMs || 5000);
      timer = later(() => {
        timer = null;
        refresh().catch(() => {}); // refresh reports the failure through onError.
      }, delay);
    }

    async function loadPage(pageCursor) {
      const suffix = pageCursor === null ? "" : `&cursor=${encodeURIComponent(pageCursor)}`;
      const payload = await request(`/generate/jobs?limit=50${suffix}`);
      checkVault(payload);
      if (!Array.isArray(payload.jobs) || payload.jobs.length > 50
        || !payload.jobs.every(validJob)
        || !(payload.next_cursor === null || typeof payload.next_cursor === "string")) {
        throw problem("schema_error", "Сервер вернул некорректный список очереди.");
      }
      if (payload.next_cursor !== null && payload.next_cursor === pageCursor) {
        throw problem("schema_error", "Сервер не продвинул страницу очереди.");
      }
      return payload;
    }

    function refresh() {
      try { guard(); } catch (error) { return Promise.reject(error); }
      if (refreshing) return refreshing;
      const observed = epoch;
      if (timer !== null) { cancel(timer); timer = null; }
      refreshing = (async () => {
        const pageCursor = cursor;
        const payload = await loadPage(pageCursor);
        const history = applyHistory(payload.history_revision);
        if (history.current && (!history.changed || pageCursor === null)) {
          for (const job of payload.jobs) accept(job);
          cursor = payload.next_cursor;
          if (pageCursor === null) latestCursor = cursor;
        }
        changed();
        const listed = new Set(payload.jobs.map((job) => job.job_id));
        const active = Array.from(jobs.values()).filter((job) => (
          activeJob(job) && !listed.has(job.job_id)
        ));
        // At most one page and three detail requests per pass, all sequential.
        for (let i = 0; i < Math.min(active.length, 3); i += 1) {
          try { await detail(active[(activeOffset + i) % active.length].job_id, false); }
          catch (error) { if (error.code !== "job_not_found") throw error; }
        }
        if (active.length) activeOffset = (activeOffset + 3) % active.length;
        const state = await request("/generate/queue");
        checkVault(state);
        if (!state.queue || typeof state.queue !== "object" || Array.isArray(state.queue)) {
          throw problem("schema_error", "Сервер вернул некорректную статистику очереди.");
        }
        if (applyHistory(state.queue.history_revision).current) queue = state.queue;
        recoveryAttempts = 0; failedPass = false;
        changed();
      })().catch(async (error) => {
        if (observed !== epoch || !current()) throw problem("project_changed", "The active project changed.");
        cursor = null; // Reconnect starts with current server jobs, including unknown IDs.
        failedPass = true;
        await recover(error);
        guard(observed);
        onError(error);
        throw error;
      }).finally(() => { refreshing = null; schedule(); });
      return refreshing;
    }

    function enqueue(raw, source = "local", mode = "organize") {
      try { guard(); } catch (error) { return Promise.reject(error); }
      if (typeof raw !== "string" || !raw.trim()) {
        return Promise.reject(problem("input_error", "Введите текст заметки."));
      }
      if (!["organize", "organize_edit"].includes(mode)) {
        return Promise.reject(problem("input_error", "Выберите режим обработки заметки."));
      }
      if (pending && (pending.raw !== raw || pending.source !== source || pending.mode !== mode)) {
        if (sending) return Promise.reject(problem("submission_busy", "Дождитесь завершения текущей отправки."));
        // Resolve the one uncertain request with its original key before a new draft.
        return enqueue(pending.raw, pending.source, pending.mode).then(() => enqueue(raw, source, mode));
      }
      if (sending) return sending;
      if (!pending) pending = { raw, source, mode, id: newId() };
      const context = pending;
      const observed = epoch;
      sending = (async () => {
        try {
          // A known store is checked again before replay; the server also compares
          // expected_vault_id atomically with admission to close the GET/POST race.
          if (vaultId !== null || options.requireVault === true) await refresh();
          guard(observed);
          if (context.acknowledged) return context.acknowledged;
          if (options.requireVault === true && (typeof vaultId !== "string" || !vaultId)) {
            throw problem("schema_error", "The project queue did not identify its vault.");
          }
          await options.prepareSubmission?.(context.raw, context.mode);
          guard(observed);
        } catch (error) {
          // Preparation failed before the first POST. The edited text can be submitted next.
          if (!context.attempted) forgetSubmission(context);
          throw error;
        }
        if (context.acknowledged) return context.acknowledged;
        if (pending !== context) throw vaultChanged();
        if (context.vaultId === undefined) context.vaultId = vaultId;
        if (!context.attempted) {
          const { raw, source, mode, id, vaultId } = context;
          if (options.onSubmissionChange?.({ raw, source, mode, id, vaultId }) === false) {
            forgetSubmission(context);
            options.onSubmissionChange(null);
            throw problem("draft_storage_unavailable", "Не удалось сохранить черновик и ключ отправки.");
          }
          context.attempted = true;
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const payload = await request("/generate/enqueue", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: context.raw, source: context.source, mode: context.mode,
                client_request_id: context.id, expected_vault_id: context.vaultId }),
            }, 202);
            checkVault(payload);
            if (!validJob(payload.job)) throw problem("schema_error", "Сервер не подтвердил сохранение задания.");
            accept(payload.job);
            acknowledgeSubmission(context, payload.job);
            queue = payload.queue || queue;
            recoveryAttempts = 0;
            changed();
            return payload.job;
          } catch (error) {
            guard(observed);
            if (attempt === 0 && transportFailure(error)) continue;
            // A definitive validation/capacity rejection permits correcting the input.
            if (Number.isFinite(error.status) && error.status >= 400 && error.status < 500) {
              forgetSubmission(context);
            }
            throw error;
          }
        }
      })().finally(() => { sending = null; });
      return sending;
    }

    const retryApi = typeof module !== "undefined" && module.exports
      ? require("./generation_retry_client") : root.GenerationRetryClient;
    const retryClient = retryApi?.create({ request, newId, getVault: () => vaultId,
      getJob: knownJob, refresh,
      applyJob(job, observed, state) {
        if (knownJob(job.job_id) === observed) {
          accept(job);
          if (state && typeof state === "object" && !Array.isArray(state)) queue = state;
        }
        changed();
      },
    });

    async function showEarlier() {
      const observed = epoch;
      const observedPage = olderJobs;
      const next = observedPage ? olderCursor : latestCursor;
      if (next === null) return;
      const payload = await loadPage(next);
      guard(observed);
      if (olderJobs !== observedPage || !applyHistory(payload.history_revision).current) return;
      const earlier = new Map();
      for (const job of payload.jobs) {
        const summary = knownJob(job.job_id) || accept(job);
        if (summary) earlier.set(job.job_id, summary);
      }
      olderJobs = earlier;
      olderCursor = payload.next_cursor;
      changed();
    }

    function showRecent() {
      guard();
      olderJobs = null;
      olderCursor = null;
      changed();
    }

    async function cleanupHistory() {
      const observed = epoch;
      await refresh();
      guard(observed);
      if (typeof vaultId !== "string" || !vaultId) {
        throw problem("schema_error", "Сервер не подтвердил папку очереди.");
      }
      const payload = await request("/generate/queue/cleanup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_vault_id: vaultId }),
      });
      checkVault(payload);
      if (!Number.isSafeInteger(payload.archived_count) || payload.archived_count < 0 || !payload.queue) {
        throw problem("schema_error", "Сервер не подтвердил очистку очереди.");
      }
      if (applyHistory(payload.queue.history_revision).current) queue = payload.queue;
      changed();
      refresh().catch(() => {}); // The cleanup was confirmed even if the next poll fails.
      return payload.archived_count;
    }

    function removeJob(id) {
      try { guard(); } catch (error) { return Promise.reject(error); }
      if (removing.has(id)) return removing.get(id);
      const job = knownJob(id);
      if (!job) return Promise.reject(problem("job_not_found", "This job is no longer available in this queue."));
      if (job.status === "processing") return Promise.reject(problem("job_busy", "This job has started processing."));
      if (typeof vaultId !== "string" || !vaultId) return Promise.reject(problem("schema_error", "The queue vault is unknown."));
      const expected = vaultId;
      const observed = epoch;
      const operation = request(`/generate/jobs/${encodeURIComponent(id)}?expected_vault_id=${encodeURIComponent(expected)}`, { method: "DELETE" })
        .then(payload => {
          guard(observed);
          checkVault(payload);
          if (payload.success !== true || payload.removed !== true || payload.job_id !== id
              || payload.vault_id !== expected || !payload.queue || typeof payload.queue !== "object" || Array.isArray(payload.queue)
              || !Number.isSafeInteger(payload.history_revision) || payload.history_revision < 0
              || payload.queue.history_revision !== payload.history_revision) {
            throw problem("schema_error", "The server did not confirm removal.");
          }
          mutationVersion += 1;
          jobs.delete(id); olderJobs?.delete(id); details.delete(id);
          if (applyHistory(payload.history_revision, false).current) queue = payload.queue;
          changed();
          return payload;
        }).finally(() => { removing.delete(id); });
      removing.set(id, operation); return operation;
    }

    return {
      refresh, enqueue, detail, ensureReady, values, cleanupHistory, showEarlier, showRecent, removeJob,
      retry: (id) => {
        try { guard(); } catch (error) { return Promise.reject(error); }
        return retryClient ? retryClient.retry(id) : Promise.reject(problem("bridge_unavailable", "Retry unavailable"));
      },
      start() { running = true; return refresh(); },
      stop() { running = false; epoch += 1; if (timer !== null) cancel(timer); timer = null; },
    };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GenerationQueueClient = api;
})(typeof window === "undefined" ? globalThis : window);
