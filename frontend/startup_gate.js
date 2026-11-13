// Who: Tim Buglaev
// When: 2026-06-14
// What: Added a shared renderer startup gate that blocks quick notes and the
//       notes panel until backend, Qdrant, and managed vLLM report readiness.
(function () {
  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const isEnglish = () => window.nodaI18n?.isEnglish() === true;
  const PHASE_ORDER = ["backend", "qdrant", "runtime-config", "model-select", "model-download", "wsl", "vllm", "ready"];
  const STARTUP_PHASE_COUNT = PHASE_ORDER.length - 1;
  const PHASE_ALIASES = {
    idle: "backend",
    startup: "backend",
    "language-select": "backend",
    "notes-directory-select": "backend",
    runtime: "wsl",
  };
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Rotate plain-language reassurance independently from backend progress so
  //       a long cold start never looks frozen to an inexperienced user.
  const LOADING_TITLE_INTERVAL_MS = 15000;
  const LOADING_TITLES = [
    ["Загружаемся…", "Loading…"],
    ["Готовим всё к работе…", "Getting things ready…"],
    ["Загрузка идёт…", "Still loading…"],
    ["Подключаем модель…", "Connecting the model…"],
    ["Всё работает…", "Startup is progressing…"],
    ["Проверяем запуск…", "Checking startup…"],
  ];

  let elements = null;
  let unsubscribeStartupStatus = null;
  let unsubscribeStartupCloseRequest = null;
  let waitingPromise = null;
  let applyingModelSelection = false;
  let lastRenderedStatus = { state: "loading", phase: "backend" };
  let loadingTitleIndex = 0, loadingTitleTimer = null;
  let startupCompletionRequested = false, startupCompletionRetryStatus = null;

  function statusCopy(text, fallback) {
    if (typeof text !== "string" || !text.trim()) return fallback;
    if (isEnglish() && (/[А-Яа-яЁё]/u.test(text) || text.startsWith("Error invoking remote method"))) return fallback;
    return text;
  }

  function phaseRank(phase) {
    const normalized = PHASE_ALIASES[phase] || phase || "backend";
    const index = PHASE_ORDER.indexOf(normalized);
    return index >= 0 ? index : 0;
  }

  function getElements() {
    if (elements) {
      return elements;
    }
    elements = {
      overlay: document.getElementById("startup-overlay"),
      visualCore: document.querySelector(".startup-switch-core"),
      title: document.getElementById("startup-title"),
      message: document.getElementById("startup-message"),
      detail: document.getElementById("startup-detail"),
      provisioning: document.getElementById("startup-provisioning"),
      provisioningDetail: document.getElementById("startup-provisioning-detail"),
      provisioningProgress: document.getElementById("startup-provisioning-progress"),
      provisioningCount: document.getElementById("startup-provisioning-count"),
      progressBar: document.getElementById("startup-progress-bar"),
      phaseCounter: document.getElementById("startup-phase-counter"),
      retryButton: document.getElementById("startup-retry-btn"),
      modelPicker: document.getElementById("startup-model-picker"),
      modelList: document.getElementById("startup-model-list"),
      modelStatus: document.getElementById("startup-model-status"),
      stopDialog: document.getElementById("startup-stop-dialog"),
      stopConfirmButton: document.getElementById("startup-stop-confirm-btn"),
      stopCancelButton: document.getElementById("startup-stop-cancel-btn"),
      detailsToggle: document.getElementById("startup-details-toggle"),
      detailsPanel: document.getElementById("startup-details-panel"),
      detailLog: document.getElementById("startup-detail-log"),
      steps: Array.from(document.querySelectorAll("[data-startup-phase]")),
    };
    return elements;
  }

  function setControlsLocked(locked) {
    const controls = Array.from(document.querySelectorAll("button, input, textarea, select"));
    controls.forEach((control) => {
      if (control.closest("#startup-overlay")) {
        return;
      }
      if (locked) {
        if (control.dataset.startupLocked !== "1") {
          control.dataset.startupWasDisabled = control.disabled ? "1" : "0";
          control.dataset.startupLocked = "1";
        }
        control.disabled = true;
        return;
      }
      if (control.dataset.startupLocked === "1") {
        control.disabled = control.dataset.startupWasDisabled === "1";
        delete control.dataset.startupWasDisabled;
        delete control.dataset.startupLocked;
      }
    });
  }

  function setGateVisible(visible) {
    // Who: Tim Buglaev
    // When: 2026-06-15
    // What: Keep the dedicated startup window visible after readiness so users
    //       explicitly acknowledge the final state, while embedded gates still hide.
    const isStandaloneStartup = document.body.classList.contains("startup-page");
    document.body.classList.toggle("app-loading", visible || isStandaloneStartup);
    document.body.classList.toggle("app-ready", !visible);
    setControlsLocked(visible && !isStandaloneStartup);
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Keep safe operating-system close confirmation and recovery controls after
  //       removing the visible launcher titlebar and its minimize/close buttons.
  function setStopDialogVisible(visible) {
    const currentElements = getElements();
    if (!currentElements.stopDialog) {
      return;
    }
    currentElements.stopDialog.hidden = !visible;
    if (visible && currentElements.stopCancelButton) {
      currentElements.stopCancelButton.focus();
    }
  }

  function requestStartupClose() {
    if (lastRenderedStatus.state === "ready") {
      if (window.quickNoteBridge && typeof window.quickNoteBridge.closeStartupWindow === "function") {
        window.quickNoteBridge.closeStartupWindow().catch(() => {});
        return;
      }
      window.close();
      return;
    }
    setStopDialogVisible(true);
  }

  function bindStartupWindowControls() {
    const currentElements = getElements();
    if (currentElements.stopCancelButton) {
      currentElements.stopCancelButton.addEventListener("click", () => setStopDialogVisible(false));
    }
    if (currentElements.stopConfirmButton) {
      currentElements.stopConfirmButton.addEventListener("click", () => {
        currentElements.stopConfirmButton.disabled = true;
        if (window.quickNoteBridge && typeof window.quickNoteBridge.stopStartup === "function") {
          window.quickNoteBridge.stopStartup().catch(() => {
            currentElements.stopConfirmButton.disabled = false;
          });
          return;
        }
        window.close();
      });
    }
    if (currentElements.detailsToggle && currentElements.detailsPanel) {
      currentElements.detailsToggle.addEventListener("click", () => {
        const nextHidden = !currentElements.detailsPanel.hidden;
        currentElements.detailsPanel.hidden = nextHidden;
        currentElements.detailsToggle.setAttribute("aria-expanded", String(!nextHidden));
      });
    }
    if (window.quickNoteBridge && typeof window.quickNoteBridge.onStartupCloseRequest === "function") {
      unsubscribeStartupCloseRequest = window.quickNoteBridge.onStartupCloseRequest(requestStartupClose);
    }
  }

  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Added renderer-only startup model picker controls that submit only a
  //       catalog model id through the secure preload bridge and keep the app locked.
  function setModelButtonsDisabled(disabled) {
    const currentElements = getElements();
    const scope = currentElements.modelPicker || currentElements.modelList;
    if (!scope) {
      return;
    }
    if (window.startupModelPicker && typeof window.startupModelPicker.setDisabled === "function") {
      window.startupModelPicker.setDisabled(scope, disabled);
      return;
    }
    Array.from(scope.querySelectorAll("button, input, select")).forEach((control) => {
      control.disabled = disabled;
    });
  }

  async function chooseStartupModel(model) {
    const currentElements = getElements();
    if (!window.quickNoteBridge || typeof window.quickNoteBridge.selectStartupModel !== "function") {
      throw new Error("Model-selection bridge is unavailable.");
    }
    applyingModelSelection = true;
    setModelButtonsDisabled(true);
    if (currentElements.modelStatus) {
      currentElements.modelStatus.textContent = model.downloaded
        ? t("Применяем выбранную модель...", "Applying the selected model…")
        : t("Скачиваем выбранную модель из Hugging Face...", "Downloading the selected model from Hugging Face…");
    }
    try {
      await window.quickNoteBridge.selectStartupModel({ model_id: model.id });
    } catch (error) {
      applyingModelSelection = false;
      setModelButtonsDisabled(false);
      if (currentElements.modelStatus) {
        currentElements.modelStatus.textContent = isEnglish()
          ? t("Не удалось подготовить модель.", "Could not prepare the model. Try again or choose a different model.")
          : error?.message || "Не удалось подготовить модель.";
      }
      throw error;
    }
  }

  async function chooseStartupPairs(selection) {
    if (applyingModelSelection) return;
    const { modelStatus } = getElements();
    applyingModelSelection = true;
    setModelButtonsDisabled(true);
    if (modelStatus) modelStatus.textContent = t("Сохраняем связки…", "Saving model pairs…");
    try {
      const result = await window.quickNoteBridge.applyStartupNotePairs(selection);
      if (result?.ok !== true) {
        if (result?.downloadError && modelStatus) {
          modelStatus.textContent = window.startupNoteDownload.errorMessage(result.downloadError);
          return;
        }
        throw new Error("Model pairs were not saved.");
      }
    } catch {
      if (modelStatus) {
        modelStatus.textContent = t(
          "Не удалось сохранить связки. Повторите попытку.",
          "Could not save the pairs. Try again."
        );
      }
    } finally {
      applyingModelSelection = false;
      setModelButtonsDisabled(false);
    }
  }

  function createModelMeta(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  function renderModelPicker(status) {
    const currentElements = getElements();
    if (!currentElements.modelPicker) {
      return;
    }
    if (applyingModelSelection && status.noteModelDownload
        && currentElements.modelPicker.dataset.pairMode === "true") return;
    const models = Array.isArray(status.models) ? status.models : [];
    const standalonePicker = window.startupModelPicker && document.body.classList.contains("startup-page");
    const pairMode = Boolean(standalonePicker && status.phase === "model-select" && Array.isArray(status.notePipeline?.catalog));
    const shouldShow = status.phase === "model-select" && (pairMode || models.length > 0);
    const wasPairMode = currentElements.modelPicker.dataset.pairMode === "true";
    if (pairMode !== wasPairMode) {
      currentElements.modelPicker.dataset.pairMode = String(pairMode);
      if (!pairMode) window.startupModelPicker?.resetPairs();
      if (currentElements.modelStatus) {
        const unreadable = status.notePipeline?.configurationError === "note_pipeline_selection_unreadable";
        if (!pairMode) {
          currentElements.modelStatus.textContent = t("Выберите модель для этого запуска.", "Choose a model for this session.");
        } else {
          currentElements.modelStatus.textContent = status.notePipeline.downloadError
            ? window.startupNoteDownload.errorMessage(status.notePipeline.downloadError)
            : unreadable
            ? t("Сохранённые связки не удалось прочитать. Выберите и сохраните их заново.", "The saved pairs could not be read. Select and save them again.")
            : "";
        }
      }
    }
    currentElements.modelPicker.hidden = !shouldShow;
    if (!shouldShow) {
      currentElements.modelPicker.replaceChildren(...[currentElements.modelList, currentElements.modelStatus].filter(Boolean));
      if (currentElements.modelList) {
        currentElements.modelList.replaceChildren();
      }
      return;
    }

    if (standalonePicker) {
      window.startupModelPicker.render(currentElements.modelPicker, status, {
        disabled: applyingModelSelection,
        onChoose: chooseStartupModel,
        onChoosePairs: chooseStartupPairs,
        statusElement: currentElements.modelStatus,
      });
      return;
    }

    if (!currentElements.modelList) {
      return;
    }
    currentElements.modelList.replaceChildren();
    models.forEach((model) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "startup-model-option";
      button.classList.toggle("active", Boolean(model.id === status.selectedModelId || model.active));
      button.disabled = applyingModelSelection;
      button.addEventListener("click", () => {
        chooseStartupModel(model).catch(() => {});
      });

      const top = document.createElement("span");
      top.className = "startup-model-top";
      const name = document.createElement("strong");
      name.textContent = model.name || model.hf_model_id || t("Модель", "Model");
      const badge = document.createElement("span");
      badge.className = model.downloaded ? "startup-model-badge downloaded" : "startup-model-badge";
      badge.textContent = model.downloaded ? t("скачана", "Downloaded") : t("скачать", "Download");
      top.append(name, badge);
      if (model.active) {
        const activeBadge = document.createElement("span");
        activeBadge.className = "startup-model-badge active";
        activeBadge.textContent = t("активна", "Active");
        top.append(activeBadge);
      }

      const description = document.createElement("span");
      description.className = "startup-model-description";
      description.textContent = window.modelLocale?.description(model) || statusCopy(model.description, "");

      const meta = document.createElement("span");
      meta.className = "startup-model-meta";
      meta.append(
        createModelMeta(window.modelLocale?.quality(model) || statusCopy(model.quality, t("Профиль", "Profile"))),
        createModelMeta(`~${model.estimated_download_gb || "?"} GB`),
        createModelMeta(window.modelLocale?.hardware(model) || statusCopy(model.hardware, t("Локальный запуск", "Local runtime")))
      );

      button.append(top, description, meta);
      currentElements.modelList.appendChild(button);
    });

    if (currentElements.modelStatus && !applyingModelSelection) {
      currentElements.modelStatus.textContent = t("Выберите профиль модели для этого запуска.", "Choose a model profile for this session.");
    }
  }

  function renderSteps(status) {
    const activeRank = phaseRank(status.phase);
    const isReady = status.state === "ready";
    const isError = status.state === "error";
    getElements().steps.forEach((step) => {
      const rank = phaseRank(step.dataset.startupPhase);
      step.classList.toggle("active", !isReady && !isError && rank === activeRank);
      step.classList.toggle("done", isReady || rank < activeRank);
      step.classList.toggle("error", isError && rank === activeRank);
    });
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Maintain exactly one bounded loading-copy timer, pause it for interactive
  //       selectors and terminal states, and avoid resetting it on progress events.
  function isPassiveLoading(status = lastRenderedStatus) {
    return status.state === "loading" && !["language-select", "model-select", "notes-directory-select", "turboquant-select"].includes(status.phase);
  }

  function renderNextLoadingTitle() {
    if (!isPassiveLoading()) {
      return;
    }
    const currentElements = getElements();
    if (!currentElements.title) {
      return;
    }
    currentElements.title.textContent = t(...LOADING_TITLES[loadingTitleIndex]);
    loadingTitleIndex = (loadingTitleIndex + 1) % LOADING_TITLES.length;
  }

  function stopLoadingTitleCycle() {
    if (loadingTitleTimer) {
      window.clearInterval(loadingTitleTimer);
      loadingTitleTimer = null;
    }
  }

  function startLoadingTitleCycle() {
    if (loadingTitleTimer) {
      return;
    }
    loadingTitleIndex = 0;
    renderNextLoadingTitle();
    loadingTitleTimer = window.setInterval(renderNextLoadingTitle, LOADING_TITLE_INTERVAL_MS);
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Open the notes panel automatically once from the dedicated ready window;
  //       duplicate ready events are ignored and IPC failure remains retryable.
  function requestAutomaticStartupCompletion(status) {
    const isStandaloneStartup = document.body.classList.contains("startup-page");
    const bridge = window.quickNoteBridge;
    const canComplete = isStandaloneStartup && status.state === "ready"
      && !startupCompletionRequested && typeof bridge?.completeStartup === "function";
    if (!canComplete) {
      return;
    }
    startupCompletionRequested = true;
    startupCompletionRetryStatus = null;
    Promise.resolve().then(() => bridge.completeStartup()).then((result) => {
      if (!result || result.ok !== true) {
        throw new Error("Main process rejected automatic startup completion.");
      }
    }).catch(() => {
      startupCompletionRequested = false;
      startupCompletionRetryStatus = { ...status };
      renderStatus({
        state: "error", phase: "ready", message: t("Не удалось открыть заметки", "Could not open notes"),
        detail: t("Нажмите «Повторить запуск», чтобы открыть список заметок.", "Select Retry startup to open your notes."), progress: 100,
      });
    });
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Render rotating reassurance with the model-flow animation during passive
  //       loading while preserving interactive, ready, and recoverable error states.
  function renderStatus(statusPayload = {}) {
    if (statusPayload.language !== document.documentElement.lang) {
      window.nodaI18n?.setLanguage(statusPayload.language);
    }
    const status = {
      state: "loading",
      phase: "backend",
      message: t("Запускаем сервисы", "Starting services"),
      detail: t("Инициализируем Flask, Qdrant и индекс заметок...", "Starting Flask, Qdrant, and the notes index…"),
      progress: 24,
      ...statusPayload,
    };
    const currentElements = getElements();
    if (!currentElements.overlay) {
      return;
    }
    if (startupCompletionRetryStatus && status.state === "ready" && !startupCompletionRequested) return;
    lastRenderedStatus = status;

    const isLoading = status.state === "loading";
    const installing = Boolean(isLoading && status.provisioning && currentElements.provisioning);
    const passiveLoading = !installing && isPassiveLoading(status);
    const iconOnly = passiveLoading && currentElements.overlay.classList.contains("startup-standalone");
    currentElements.overlay.classList.toggle("startup-icon-only", iconOnly);
    if (passiveLoading && !iconOnly) {
      startLoadingTitleCycle();
    } else {
      stopLoadingTitleCycle();
      const defaultTitle = status.state === "ready"
        ? t("Всё готово", "Ready")
        : status.state === "error" ? t("Запуск не завершился", "Startup failed") : t("Запускаем Noda…", "Starting Noda…");
      currentElements.title.textContent = iconOnly ? t(...LOADING_TITLES[0]) : statusCopy(status.message, defaultTitle);
    }
    currentElements.overlay.setAttribute("aria-busy", String(isLoading));
    if (currentElements.visualCore) {
      currentElements.visualCore.textContent = status.state === "ready"
        ? "✓"
        : status.state === "error" ? "×" : "◇";
    }
    currentElements.message.textContent = status.state === "ready"
      ? t("Все готово к работе.", "Noda is ready to use.")
      : t("Пожалуйста, подождите. Интерфейс станет доступен после запуска сервисов.", "Please wait for the local services to start.");
    const defaultDetail = status.state === "error"
      ? t("Проверьте, что локальные сервисы доступны, и повторите запуск.", "Check that local services are available, then retry startup.")
      : "";
    const detail = statusCopy(status.detail, defaultDetail);
    currentElements.detail.textContent = detail;
    if (currentElements.provisioning) {
      currentElements.provisioning.hidden = !installing;
      if (installing) {
        const { completed, total } = status.provisioning;
        currentElements.provisioningDetail.textContent = detail;
        currentElements.provisioningProgress.max = total;
        currentElements.provisioningProgress.value = completed;
        currentElements.provisioningCount.textContent = t(
          `Готово этапов: ${completed} из ${total}`, `Steps complete: ${completed} of ${total}`);
      }
    }
    if (currentElements.detailLog) {
      currentElements.detailLog.textContent = detail || statusCopy(status.message, t("Запуск продолжается.", "Startup is in progress."));
    }
    const progressValue = Math.max(0, Math.min(100, Number(status.progress) || 0));
    const displayProgress = status.state === "loading" && progressValue > 0
      ? Math.max(24, progressValue)
      : progressValue;
    currentElements.progressBar.style.width = `${displayProgress}%`;
    if (currentElements.phaseCounter) {
      const activeStep = status.state === "ready"
        ? STARTUP_PHASE_COUNT
        : Math.min(STARTUP_PHASE_COUNT, phaseRank(status.phase) + 1);
      currentElements.phaseCounter.textContent = `${activeStep}/${STARTUP_PHASE_COUNT}`;
    }
    currentElements.overlay.classList.toggle("error", status.state === "error");
    currentElements.overlay.classList.toggle("ready", status.state === "ready");
    currentElements.overlay.classList.toggle("model-select", status.phase === "model-select");
    currentElements.overlay.classList.toggle("notes-directory-select", status.phase === "notes-directory-select");
    document.body.classList.toggle("startup-model-select-page", status.phase === "model-select");
    document.body.classList.toggle("startup-notes-directory-page", status.phase === "notes-directory-select");
    if (currentElements.retryButton) {
      currentElements.retryButton.hidden = status.state !== "error";
      currentElements.retryButton.disabled = status.state !== "error";
    }
    // Who: Tim Buglaev
    // When: 2026-07-02
    // What: Render optional vault and TurboQuant decisions independently while
    //       preserving the shared startup status lifecycle.
    window.startupLanguage?.render(status);
    window.startupNotesDirectory?.render?.(status);
    window.startupTurboQuant?.render?.(status);
    window.startupNoteDownload?.render(status.noteModelDownload);
    renderModelPicker(status);
    renderSteps(status);
    setGateVisible(status.state !== "ready");
    requestAutomaticStartupCompletion(status);
  }

  function handleFailure(error) {
    renderStatus({
      state: "error",
      phase: "vllm",
      message: t("Запуск не завершился", "Startup failed"),
      detail: isEnglish()
        ? t("Проверьте доступность локальных сервисов и повторите запуск.",
          "Check that local services are available, then retry startup.")
        : error?.message || "Проверьте backend, WSL и vLLM runtime.",
      progress: 100,
    });
  }

  async function waitForReady() {
    const currentElements = getElements();
    if (!currentElements.overlay) {
      return;
    }
    if (waitingPromise) {
      return waitingPromise;
    }
    setGateVisible(true);
    renderStatus({
      state: "loading",
      phase: "backend",
      message: t("Запускаем сервисы", "Starting services"),
      detail: t("Инициализируем Flask, Qdrant и индекс заметок...", "Starting Flask, Qdrant, and the notes index…"),
      progress: 2,
    });

    waitingPromise = (async () => {
      if (!window.quickNoteBridge || typeof window.quickNoteBridge.ensureBackendReady !== "function") {
        throw new Error("IPC bridge is unavailable.");
      }
      if (typeof window.quickNoteBridge.getStartupStatus === "function") {
        renderStatus(await window.quickNoteBridge.getStartupStatus());
      }
      await window.quickNoteBridge.ensureBackendReady();
      if (typeof window.quickNoteBridge.getStartupStatus === "function") {
        renderStatus(await window.quickNoteBridge.getStartupStatus());
      } else {
        renderStatus({
          state: "ready",
          phase: "ready",
          message: t("Все сервисы готовы", "All services are ready"),
          detail: t("Можно работать с заметками.", "You can start using your notes."),
          progress: 100,
        });
      }
    })();

    try {
      await waitingPromise;
    } catch (error) {
      waitingPromise = null;
      handleFailure(error);
      throw error;
    }
  }

  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Render the initial startup state before IPC status arrives, keeping the
  //       compact window populated even during the first Electron startup tick.
  function init() {
    const currentElements = getElements();
    if (!currentElements.overlay) {
      return;
    }
    renderStatus();
    bindStartupWindowControls();
    if (window.quickNoteBridge && typeof window.quickNoteBridge.onStartupStatus === "function") {
      unsubscribeStartupStatus = window.quickNoteBridge.onStartupStatus((payload) => {
        renderStatus(payload);
      });
    }
    if (currentElements.retryButton) {
      currentElements.retryButton.addEventListener("click", () => {
        if (startupCompletionRetryStatus) {
          const retryStatus = startupCompletionRetryStatus;
          startupCompletionRetryStatus = null;
          renderStatus(retryStatus);
          return;
        }
        currentElements.retryButton.disabled = true;
        waitForReady().catch(() => {
          currentElements.retryButton.disabled = false;
        });
      });
    }
    window.addEventListener("beforeunload", () => {
      stopLoadingTitleCycle();
      if (typeof unsubscribeStartupStatus === "function") {
        unsubscribeStartupStatus();
      }
      if (typeof unsubscribeStartupCloseRequest === "function") {
        unsubscribeStartupCloseRequest();
      }
    });
  }

  window.startupGate = {
    init,
    waitForReady,
    renderStatus,
  };

  init();
})();
