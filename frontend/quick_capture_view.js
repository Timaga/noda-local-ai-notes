(function (root) {
  "use strict";

  const stageLabels = {
    title: ["Название", "Title"], tags: ["Теги", "Tags"],
    links: ["Связи", "Links"], save: ["Сохранение", "Save"],
  };
  const statusLabels = {
    queued: ["В очереди", "Queued"], processing: ["В работе", "Processing"],
    completed: ["Готово", "Complete"], failed: ["Ошибка", "Failed"],
    source_saved: ["Не обработана", "Unprocessed"],
  };
  const phaseLabels = {
    queued: ["Ожидает обработки", "Waiting to be processed"],
    generating: ["Обработка заметки", "Processing the note"],
    preparing: ["Подготовка к сохранению", "Preparing to save"],
    prepared: ["Готово к сохранению", "Ready to save"],
    publish_intent: ["Сохранение заметки", "Saving the note"],
    published: ["Заметка сохранена", "Note saved"],
    completed: ["Обработка завершена", "Processing complete"],
    failed: ["Обработка не завершена", "Processing did not finish"],
  };
  const retryErrors = {
    retry_target_changed: ["Заметка изменена после сохранения. Повторная обработка остановлена, чтобы сохранить ваши правки.",
      "The note changed after it was saved. Reprocessing was stopped to preserve your edits."],
    retry_target_busy: ["Файл заметки занят. Закройте его в другом приложении и повторите обработку.",
      "The note file is in use. Close it in the other application, then retry processing."],
    retry_request_conflict: ["Не удалось безопасно повторить обработку. Обновите очередь.", "Could not safely retry processing. Refresh the queue."],
    vault_changed: ["Папка заметок изменилась. Откройте актуальную очередь.", "The notes folder changed. Open the current queue."],
    retry_not_allowed: ["Повторная обработка сейчас недоступна. Исходник сохранён.", "Retry processing is unavailable for this job. The source text is saved."],
    retry_pending: ["Повторная обработка уже идёт. Проверьте очередь.", "A retry is already in progress. Check the queue."],
    retry_unsupported: ["Безопасный повтор сейчас недоступен. Исходник можно скопировать.", "Safe retry is currently unavailable. You can copy the source text."],
    job_not_found: ["Задание больше не доступно в этой очереди.", "This job is no longer available in this queue."],
  };
  const recoveryLabels = {
    queued: ["Повторная обработка в очереди.", "Retry queued."],
    processing: ["Выполняется повторная обработка.", "Retry in progress."],
    completed: ["Повторный запуск завершён.", "Retry attempt finished."],
    failed: ["Повторная обработка не завершена. Исходник сохранён.", "Retry did not finish. The source text is saved."],
    conflict: ["Не удалось безопасно повторить обработку. Исходник сохранён.", "Could not safely retry processing. The source text is saved."],
  };
  const t = (ru, en) => root.nodaI18n?.t(ru, en) ?? ru;
  const text = (labels) => t(...labels);
  const sameProject = (a, b) => a?.projectId === b?.projectId && a?.epoch === b?.epoch && a?.status === b?.status;

  function create(options = {}) {
    const doc = root.document;
    const shell = doc.querySelector(".quick-shell");
    const input = doc.getElementById("prompt-input");
    const toggle = doc.getElementById("quick-queue-toggle");
    const panel = doc.getElementById("quick-queue-panel");
    const list = doc.getElementById("jobs-list");
    const badge = doc.getElementById("quick-queue-badge");
    const counter = doc.getElementById("queue-counter");
    const feedback = doc.getElementById("quick-feedback");
    const announcement = doc.getElementById("quick-announcement");
    const inputMeta = doc.getElementById("quick-input-meta");
    const activeProject = doc.getElementById("quick-active-project");
    const history = doc.getElementById("quick-queue-history");
    const retention = doc.getElementById("quick-queue-retention");
    const cleanup = doc.getElementById("quick-queue-cleanup");
    const cleanupStatus = doc.getElementById("quick-queue-cleanup-status");
    const recent = doc.getElementById("quick-queue-recent");
    const earlier = doc.getElementById("quick-queue-earlier");
    const rows = new Map();
    let currentJobs = [], currentQueue = null, count = 0, failures = 0, resizeFrame = null, lastHeight = null;
    let project = null;
    let currentPaging = {};

    function notifyResize() {
      if (resizeFrame !== null) return;
      resizeFrame = root.requestAnimationFrame(() => {
        resizeFrame = null;
        const entryHeight = doc.getElementById("quick-note-form").getBoundingClientRect().height;
        const metaHeight = inputMeta?.getBoundingClientRect().height || 0;
        const historyHeight = panel.hidden || history?.hidden ? 0 : history?.getBoundingClientRect().height || 0;
        const messageHeight = feedback.hidden ? 0 : feedback.getBoundingClientRect().height + 7;
        shell.style.setProperty("--quick-entry-height", `${entryHeight}px`);
        shell.style.setProperty("--quick-meta-height", `${metaHeight}px`);
        shell.style.setProperty("--quick-history-height", `${historyHeight}px`);
        shell.style.setProperty("--quick-message-height", `${messageHeight}px`);
        const queueHeight = panel.hidden ? 0
          : panel.querySelector(".quick-queue-heading").getBoundingClientRect().height
            + historyHeight + Math.min(480, list.scrollHeight) + 34;
        const supportHeight = doc.getElementById("app-support-footer")?.getBoundingClientRect().height || 0;
        const height = Math.ceil(entryHeight + metaHeight + messageHeight + queueHeight + supportHeight + 16);
        if (height !== lastHeight) { lastHeight = height; options.onResize?.(height); }
      });
    }

    function resizeInput() {
      input.style.height = "38px";
      input.style.height = `${Math.min(150, Math.max(38, input.scrollHeight))}px`;
      notifyResize();
    }

    function setQueueOpen(open) {
      panel.hidden = !open;
      doc.body.classList.toggle("quick-queue-open", Boolean(open));
      toggle.setAttribute("aria-expanded", String(Boolean(open)));
      notifyResize();
    }

    toggle.addEventListener("click", () => setQueueOpen(panel.hidden));
    input.addEventListener("input", resizeInput);

    function renderProject(state) {
      const previous = project;
      project = state;
      if (!activeProject) return;
      const name = state?.projectState?.activeProject?.name;
      const label = state?.status === "switching"
        ? t("Переключаем проект…", "Switching project…")
        : state?.status === "error" ? t("Проект недоступен", "Project unavailable")
          : name ? t(`Проект · ${name}`, `Project · ${name}`) : t("Папка заметок", "Notes folder");
      activeProject.textContent = label;
      activeProject.title = label;
      if (cleanupStatus && !sameProject(previous, state)) cleanupStatus.hidden = true;
      notifyResize();
    }

    function renderRetention() {
      if (!history) return;
      const days = currentQueue?.history_retention_days;
      history.hidden = !Number.isInteger(days) || days < 1;
      if (history.hidden) return;
      retention.textContent = t(`Успешные задания очищаются через ${days} дней или раньше, если не хватает места.`,
        `Successful entries are cleared after ${days} days, or sooner if space runs low.`);
    }

    cleanup?.addEventListener("click", async () => {
      if (!options.onCleanup || cleanup.disabled || !root.confirm(t(
        "Очистить успешно завершённые задания из очереди? Файлы заметок и задания, требующие внимания, сохранятся.",
        "Clear successfully completed entries from the queue? Note files and entries that need attention will be kept."
      ))) return;
      const observed = project;
      cleanup.disabled = true;
      cleanupStatus.hidden = true;
      try {
        const removed = await options.onCleanup();
        if (!sameProject(project, observed)) return;
        cleanupStatus.textContent = removed
          ? t(`Удалено записей из истории: ${removed}.`, `History entries removed: ${removed}.`)
          : t("Нет завершённых записей для очистки.", "No completed entries to clear.");
      } catch {
        if (!sameProject(project, observed)) return;
        cleanupStatus.textContent = t("Не удалось подтвердить очистку. Проверьте очередь.",
          "Could not confirm cleanup. Check the queue.");
      } finally {
        cleanup.disabled = false;
        if (sameProject(project, observed)) cleanupStatus.hidden = false;
        notifyResize();
      }
    });

    recent?.addEventListener("click", () => { options.onShowRecent?.(); });
    earlier?.addEventListener("click", async () => {
      if (!options.onShowEarlier || earlier.disabled) return;
      const observed = project;
      earlier.disabled = true;
      cleanupStatus.hidden = true;
      try {
        await options.onShowEarlier();
      } catch {
        if (sameProject(project, observed)) {
          cleanupStatus.textContent = t("Не удалось загрузить ранние задания. Повторите попытку.",
            "Could not load earlier entries. Try again.");
          cleanupStatus.hidden = false;
        }
      } finally {
        earlier.disabled = false;
        notifyResize();
      }
    });

    function renderQueueCounter(value) {
      count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      badge.textContent = count ? (count > 99 ? "99+" : String(count)) : "!";
      badge.hidden = count === 0 && failures === 0;
      badge.classList.toggle("needs-attention", count === 0 && failures > 0);
      toggle.dataset.hasFailures = String(failures > 0);
      counter.textContent = t(`В работе и очереди: ${count}`, `Active and queued: ${count}`);
      toggle.setAttribute("aria-label", t(`Посмотреть очередь. В работе и очереди: ${count}.`, `Show queue. Active and queued: ${count}.`)
        + (failures ? t(` Требуют внимания: ${failures}.`, ` Need attention: ${failures}.`) : ""));
    }

    function setStatus(type, message) {
      feedback.textContent = message || "";
      announcement.textContent = message || "";
      feedback.hidden = type !== "error" || !message;
      input.setAttribute("aria-invalid", String(type === "error"));
      toggle.title = message || t("Посмотреть очередь", "Show queue");
      resizeInput();
    }

    function node(tag, className, content) {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (content !== undefined) element.textContent = content;
      return element;
    }

    function sourceSaved(job) {
      if (["pending", "processing", "completed", "failed", "source_saved"].includes(job.processing_outcome)) {
        return job.processing_outcome === "source_saved";
      }
      return job.processing_outcome === "source_saved" || job.result?.generation?.metadata_pending === true;
    }

    function recovery(job) {
      const value = job.recovery_summary;
      return value && typeof value.request_id === "string" && Object.hasOwn(recoveryLabels, value.status) ? value : null;
    }

    function renderRetry(row) {
      const job = row.job;
      const summary = recovery(job);
      const failed = job.status === "failed" || sourceSaved(job);
      const state = row.retrying ? "submitting" : row.retryErrorState || summary?.status || "idle";
      row.details.dataset.retryState = state;
      row.retry.hidden = !row.retrying && !(failed && job.retry_available === true);
      row.retry.disabled = row.retrying || row.removing || ["queued", "processing", "conflict"].includes(state);
      row.retry.setAttribute("aria-busy", String(row.retrying));
      row.retry.textContent = row.retrying ? t("Отправляем на обработку…", "Queuing retry…") : t("Повторить обработку", "Retry processing");
      row.actions.hidden = row.retry.hidden && row.copy.hidden;
      row.retryMessage.hidden = !failed || (!row.retryError && !summary && !row.retrying);
      row.retryMessage.textContent = row.retryError ? text(row.retryError)
        : row.retrying ? t("Подтверждаем повторный запуск…", "Confirming the retry…")
          : summary ? text(recoveryLabels[summary.status]) : "";
      row.retryMessage.classList.toggle("error", Boolean(row.retryError) || summary?.status === "conflict");
      updateRemoval(row);
    }

    async function retryJob(row, jobId) {
      if (row.retrying || row.retry.disabled || row.job?.retry_available !== true
          || typeof options.onRetryJob !== "function") return;
      row.retrying = true;
      row.retryError = null;
      row.retryErrorState = null;
      renderRetry(row); notifyResize();
      try {
        // The queue client owns receipt validation and renders the acknowledged job.
        await options.onRetryJob(jobId);
      } catch (error) {
        if (rows.get(jobId) !== row) return;
        const code = typeof error?.code === "string" ? error.code : null;
        row.retryError = Object.hasOwn(retryErrors, code) ? retryErrors[code]
          : ["Не удалось подтвердить повторный запуск. Проверяем очередь.", "Could not confirm the retry. Checking the queue."];
        row.retryErrorState = code === "retry_pending" ? "queued" : code === "retry_target_busy" ? "failed"
          : Object.hasOwn(retryErrors, code) ? "conflict" : "unknown";
      } finally {
        if (rows.get(jobId) === row) { row.retrying = false; renderRetry(row); notifyResize(); }
      }
    }

    async function removeJob(row, id) {
      if (row.remove.disabled || row.retrying || typeof options.onDeleteJob !== "function") return;
      const queued = row.job.status === "queued";
      if (!root.confirm(queued ? t("Удалить ожидающее задание? Оно не будет обработано. Файлы заметок сохранятся.",
        "Remove this queued job? It will not be processed. Note files will be kept.")
        : t("Убрать это задание из очереди? Его исходник больше не будет показан здесь. Файлы заметок сохранятся.",
          "Remove this entry from the queue? Its saved source will no longer appear here. Note files will be kept."))) return;
      const observed = project;
      const next = row.item.nextElementSibling?.querySelector("summary") || row.item.previousElementSibling?.querySelector("summary");
      row.removing = true; row.removeError = null; renderRetry(row);
      try {
        await options.onDeleteJob(id);
        if (!sameProject(project, observed)) return;
        setStatus("ok", t("Задание удалено из очереди. Файлы заметок сохранены.", "Job removed from queue. Note files were kept."));
        (next?.isConnected ? next : toggle).focus({ preventScroll: true });
      } catch (error) {
        if (rows.get(id) !== row || !sameProject(project, observed)) return;
        row.removeError = error?.code === "job_busy" ? "busy" : "unknown"; row.details.open = true;
      } finally { row.removing = false; if (rows.get(id) === row) renderRetry(row); notifyResize(); }
    }

    function updateRemoval(row) {
      row.remove.hidden = typeof options.onDeleteJob !== "function";
      row.remove.disabled = row.removing || row.retrying || row.job?.status === "processing";
      const label = row.removing ? t("Удаляем…", "Removing…") : row.job?.status === "processing"
        ? t("Идёт обработка. Дождитесь её завершения, чтобы убрать задание.", "Processing is in progress. Wait until it finishes to remove this entry.")
        : t("Удалить задание из очереди", "Remove job from queue");
      row.remove.title = label; row.remove.setAttribute("aria-label", label); row.remove.setAttribute("aria-busy", String(row.removing));
      row.removeMessage.hidden = !row.removeError;
      row.removeMessage.textContent = row.removeError === "busy"
        ? t("Задание уже обрабатывается. Дождитесь завершения.", "This job has started processing. Wait until it finishes.")
        : row.removeError ? t("Не удалось подтвердить удаление. Обновите очередь и повторите попытку.", "Could not confirm removal. Refresh the queue and try again.") : "";
    }

    function jobPhase(job) {
      if (sourceSaved(job)) return t("Исходник сохранён, обработка не завершена", "Source saved; processing did not finish");
      const stage = job.progress?.current_stage;
      if (Object.hasOwn(stageLabels, stage)) {
        const failed = Array.isArray(job.progress.stages)
          && job.progress.stages.some(value => value?.id === stage && value.status === "failed");
        return failed ? t(`Ошибка: ${text(stageLabels[stage]).toLowerCase()}`, `${text(stageLabels[stage])} failed`)
          : text(stageLabels[stage]);
      }
      const phase = Object.hasOwn(phaseLabels, job.phase) ? job.phase
        : Object.hasOwn(phaseLabels, job.status) ? job.status : "generating";
      return text(phaseLabels[phase]);
    }

    function makeRow(jobId) {
      const item = node("li", "quick-job-item");
      const details = node("details", "quick-job");
      details.dataset.jobId = jobId;
      const summary = node("summary", "quick-job-summary");
      const icon = node("span", "quick-job-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 28" focusable="false"><path d="M4 1h11l6 6v19H4zM15 1v7h6M8 14h9M8 19h9"/></svg>';
      const title = node("span", "quick-job-title");
      const status = node("span", "quick-job-status");
      const chevron = node("span", "ui-icon ui-chevron");
      chevron.dataset.uiIcon = "chevron";
      chevron.setAttribute("aria-hidden", "true");
      summary.append(icon, title, status, chevron);
      const body = node("div", "quick-job-body");
      const phase = node("p", "quick-job-phase");
      phase.setAttribute("aria-live", "polite");
      const stages = node("ol", "quick-job-stages");
      const error = node("p", "quick-job-error");
      const source = node("pre", "quick-job-source");
      const copy = node("button", "quick-source-button");
      copy.type = "button";
      copy.addEventListener("click", () => options.onCopySource?.(jobId));
      const retry = node("button", "quick-retry-button");
      retry.type = "button";
      const actions = node("div", "quick-job-actions");
      const retryMessage = node("p", "quick-retry-message");
      retryMessage.setAttribute("role", "status");
      retryMessage.setAttribute("aria-live", "polite");
      actions.append(retry, copy);
      const removeMessage = node("p", "quick-retry-message error"); removeMessage.hidden = true; removeMessage.setAttribute("role", "status");
      const remove = node("button", "quick-remove-button"); remove.type = "button";
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg>';
      body.append(phase, stages, error, source, actions, retryMessage, removeMessage);
      details.append(summary, body);
      item.append(details, remove);
      const row = { item, details, title, status, phase, stages, error, source, copy, retry, actions, retryMessage, remove, removeMessage,
        job: null, signature: "", retrying: false, removing: false, retryError: null, retryErrorState: null, recoveryStamp: null };
      remove.addEventListener("click", () => removeJob(row, jobId));
      retry.addEventListener("click", () => retryJob(row, jobId));
      details.addEventListener("toggle", () => {
        notifyResize();
        if (!details.open || !rows.has(jobId)) return;
        if (typeof row.job?.prompt_text !== "string" && typeof options.onExpandJob === "function") {
          Promise.resolve(options.onExpandJob(jobId)).then(detail => {
            if (!detail || rows.get(jobId) !== row) return;
            // Detail requests may finish after a newer progress poll.
            const hydrated = { ...row.job };
            if (typeof detail.prompt_text === "string") hydrated.prompt_text = detail.prompt_text;
            const sameReceipt = (hydrated.recovery_summary?.request_id || null) === (detail.recovery_summary?.request_id || null);
            const sameOutcome = !hydrated.processing_outcome || !detail.processing_outcome
              || hydrated.processing_outcome === detail.processing_outcome;
            if (!hydrated.result && detail.result && sameReceipt && sameOutcome && hydrated.status === detail.status) {
              hydrated.result = detail.result;
            }
            updateRow(row, hydrated);
          }).catch(() => {
            if (rows.get(jobId) !== row) return;
            row.error.textContent = t("Не удалось загрузить подробности. Исходник остаётся в очереди.",
              "Could not load the details. The source remains in the queue.");
            row.error.hidden = false;
            notifyResize();
          });
        }
      });
      return row;
    }

    function updateRow(row, job) {
      const summary = recovery(job);
      const stamp = summary ? `${summary.request_id}:${summary.status}:${summary.requested_at}:${summary.retry_count}` : null;
      if ((stamp && stamp !== row.recoveryStamp) || (job.retry_available === true && row.job?.retry_available === false)) {
        row.retryError = null; row.retryErrorState = null;
      }
      row.recoveryStamp = stamp;
      row.job = job;
      const outcome = sourceSaved(job) ? "source_saved" : job.status;
      row.details.dataset.status = outcome;
      row.title.textContent = (sourceSaved(job) && job.prompt_preview) || job.result_title || job.result?.display_title || job.result?.title
        || job.prompt_preview || t("Новая заметка", "New note");
      row.title.title = row.title.textContent;
      row.status.textContent = text(Object.hasOwn(statusLabels, outcome) ? statusLabels[outcome] : statusLabels.processing);
      row.phase.textContent = `${t("Статус генерации", "Generation status")}: ${jobPhase(job)}`;
      const stateLabels = { pending: ["ожидает", "pending"], running: ["в работе", "in progress"],
        completed: ["завершено", "completed"], failed: ["ошибка", "failed"], skipped: ["пропущено", "skipped"] };
      const values = job.progress?.version === 1 && Array.isArray(job.progress.stages)
        ? job.progress.stages.filter(value => value && Object.hasOwn(stageLabels, value.id)
          && Object.hasOwn(stateLabels, value.status)) : [];
      const signature = JSON.stringify(values.map(value => [value.id, value.status])) + t("ru", "en");
      if (signature !== row.signature) {
        row.signature = signature;
        row.stages.replaceChildren();
        for (const stage of values) {
          const entry = node("li", "", text(stageLabels[stage.id]));
          entry.dataset.stageId = stage.id;
          entry.dataset.state = stage.status;
          const statusText = `${text(stageLabels[stage.id])}: ${text(stateLabels[stage.status])}`;
          entry.setAttribute("aria-label", statusText);
          entry.title = statusText;
          if (stage.status === "skipped") {
            entry.append(node("small", "quick-job-stage-state", t("Пропущено", "Skipped")));
          }
          row.stages.append(entry);
        }
      }
      row.stages.hidden = row.stages.children.length === 0;
      row.error.hidden = job.status !== "failed" && !sourceSaved(job);
      row.error.textContent = job.error_code === "publication_unknown"
        ? t("Проверьте результат сохранения. Исходник в очереди.", "Check the saved result. The source remains in the queue.")
        : failedStageText(job);
      row.source.textContent = typeof job.prompt_text === "string" ? job.prompt_text : job.prompt_preview || "";
      row.source.hidden = row.error.hidden || !row.source.textContent;
      row.copy.textContent = t("Скопировать исходник", "Copy source text");
      row.copy.hidden = row.error.hidden;
      renderRetry(row);
      notifyResize();
    }

    function failedStageText(job) {
      const stage = Array.isArray(job.progress?.stages)
        ? job.progress.stages.find(value => value?.status === "failed" && Object.hasOwn(stageLabels, value.id))?.id : null;
      const labels = {
        title: ["Генерация названия не завершена.", "Title generation did not finish."],
        tags: ["Подбор тегов не завершён.", "Tag selection did not finish."],
        links: ["Поиск связей не завершён.", "Finding related notes did not finish."],
        save: ["Сохранение результата не завершено.", "Saving the result did not finish."],
      };
      const reasons = {
        context_budget_exceeded: ["Текст превысил лимит обработки на этом этапе.", "The text exceeded this stage’s processing limit."],
        links_reranker_source_too_long: ["Исходник превышает лимит оценщика связей.", "The source text exceeds the note-link scorer’s limit."],
        window_budget: ["Слишком большой объём текста для одной обработки связей.", "There is too much text for a single note-link processing step."],
      };
      const detail = typeof job.processing_error?.detail_code === "string" ? job.processing_error.detail_code
        : typeof job.processing_error?.code === "string" ? job.processing_error.code : null;
      const reasonCode = detail === "links_reranker_window_budget_exceeded" ? "window_budget" : detail;
      return (stage ? text(labels[stage]) : t("Обработка не завершена.", "Processing did not finish."))
        + (Object.hasOwn(reasons, reasonCode) ? ` ${text(reasons[reasonCode])}` : "")
        + t(" Исходник сохранён в очереди.", " The source text is saved in the queue.");
    }

    function renderJobs(jobs, queue, paging = {}) {
      currentJobs = Array.isArray(jobs) ? jobs : [];
      currentQueue = queue || null;
      currentPaging = paging;
      renderRetention();
      if (recent) recent.hidden = !paging.older;
      if (earlier) earlier.hidden = !paging.hasEarlier;
      failures = currentJobs.filter(job => job.status === "failed" || sourceSaved(job)).length;
      const previousScroll = list.scrollTop;
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
      const ids = new Set(currentJobs.map(job => job.job_id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.item.remove(); rows.delete(id); }
      list.querySelector(".quick-queue-empty")?.remove();
      if (!currentJobs.length) {
        list.append(node("li", "quick-queue-empty", t("Очередь пуста", "The queue is empty")));
      }
      currentJobs.forEach((job, index) => {
        let row = rows.get(job.job_id);
        if (!row) { row = makeRow(job.job_id); rows.set(job.job_id, row); }
        updateRow(row, job);
        if (list.children[index] !== row.item) list.insertBefore(row.item, list.children[index] || null);
      });
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
      list.scrollTop = previousScroll;
      renderQueueCounter(count);
      notifyResize();
    }

    if (typeof root.ResizeObserver === "function") new root.ResizeObserver(notifyResize).observe(shell);
    resizeInput();
    return {
      renderJobs, setStatus, setQueueOpen, renderQueueCounter, resizeInput, renderProject,
      refreshLanguage() { renderProject(project); renderJobs(currentJobs, currentQueue, currentPaging); renderQueueCounter(count); },
    };
  }

  root.QuickCaptureView = Object.freeze({ create });
})(window);
