// Who: Tim Buglaev
// When: 2026-06-23
// What: Wire the settings workspace to the restricted Electron bridge, reuse the
//       startup model catalog, and keep unsaved path/startup choices reversible.
(() => {
  "use strict";

  const t = (ru, en) => window.nodaI18n.t(ru, en);
  const currentLanguage = () => window.nodaI18n.getLanguage();

  const modelName = document.getElementById("settings-model-name");
  const modelBadges = document.getElementById("settings-model-badges");
  const modelHeading = document.getElementById("settings-model-heading");
  const modelDescription = document.getElementById("settings-model-description");
  const modelDialogTitle = document.getElementById("settings-model-dialog-title");
  const skipModelRow = document.getElementById("settings-skip-model-row");
  const skipModelLabel = document.getElementById("settings-skip-model-label");
  const skipModelNote = document.getElementById("settings-skip-model-note");
  const modelOpen = document.getElementById("settings-model-open");
  const modelChoose = document.getElementById("settings-model-choose");
  const modelModal = document.getElementById("settings-model-modal");
  const modelClose = document.getElementById("settings-model-close");
  const modelPicker = document.getElementById("settings-model-picker");
  const modelProgress = document.getElementById("settings-model-progress");
  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Bind the settings-only switch overlay; all values are rendered through
  //       textContent so model names and runtime details cannot inject markup.
  const modelSwitch = document.getElementById("settings-model-switch");
  const switchCore = modelSwitch?.querySelector(".settings-switch-core");
  const switchTitle = document.getElementById("settings-switch-title");
  const switchModel = document.getElementById("settings-switch-model");
  const switchDetail = document.getElementById("settings-switch-detail");
  const switchElapsed = document.getElementById("settings-switch-elapsed");
  const switchClose = document.getElementById("settings-switch-close");
  const switchDownloadProgress = document.getElementById("settings-switch-download-progress");
  const switchStopDownload = document.getElementById("settings-switch-stop-download");
  const notesPath = document.getElementById("settings-notes-path");
  const pathBrowse = document.getElementById("settings-path-browse");
  const skipModel = document.getElementById("settings-skip-model");
  const skipPath = document.getElementById("settings-skip-path");
  const languageInput = document.getElementById("settings-language");
  if (languageInput) {
    for (const [code, [label]] of Object.entries(window.nodaLanguages.languages)) {
      const option = document.createElement("option");
      option.value = code;
      option.lang = code;
      option.textContent = label;
      languageInput.append(option);
    }
  }
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Bind separate TurboQuant enablement and startup-prompt preferences while
  //       treating the main-process capability verdict as read-only display data.
  const turboquantEnabled = document.getElementById("settings-turboquant-enabled");
  const turboquantCapability = document.getElementById("settings-turboquant-capability");
  const skipTurboquant = document.getElementById("settings-skip-turboquant");
  const saveButton = document.getElementById("settings-save");
  const cancelButton = document.getElementById("settings-cancel");
  const status = document.getElementById("settings-status");
  const runtimeState = document.getElementById("settings-runtime-state");
  // Who: Tim Buglaev
  // When: 2026-07-10
  // What: Bind only the two shipped theme radios and use Graphite whenever
  //       an older or incomplete settings snapshot has no explicit theme.
  const themeInputs = Array.from(document.querySelectorAll('input[name="settings-theme"]'));
  const supportedThemes = new Set(["noda-red", "classic-blue"]);

  let snapshot = null;
  let snapshotProject;
  let savedFields;
  let working = false;
  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Track one bounded renderer timer and one removable IPC listener for the
  //       model-switch lifecycle, preventing duplicate updates after window teardown.
  let switchStartedAt = 0;
  let switchTimer = null;
  let unsubscribeSettingsModelProgress = null;
  const projectContext = window.NodaProjectContext;
  const captureProject = () => projectContext?.snapshot();
  const sameProject = captured => !projectContext || projectContext.isCurrent(captured);
  const projectIds = captured => captured?.projectId ? { projectId: captured.projectId, contextToken: captured.contextToken } : {};
  let modelProject = null;
  const preferences = window.NotesSettingsPreferences.create({ doc: document, text: t,
    isDirty: () => Boolean(snapshot && (savedFields !== JSON.stringify(settingsFields())
      || window.notesSettingsNotePairs.hasDraft())), onStatus: setStatus, onWorking: setWorking });
  function syncProjectPath() {
    const project = captureProject()?.projectState?.activeProject;
    if (!project) return;
    if (snapshot?.settings) snapshot.settings.notesDirectory = project.notesDirectory;
    notesPath.value = project.notesDirectory;
    const label = pathBrowse.querySelector("span[data-en]");
    if (label) { label.dataset.en = "Projects"; label.textContent = t("Проекты", "Projects"); }
  }

  function bridge() {
    const value = window.quickNoteBridge;
    if (!value
      || typeof value.getAppSettings !== "function"
      || typeof value.chooseNotesDirectory !== "function"
      || typeof value.saveAppSettings !== "function"
      || typeof value.applySettingsModel !== "function"
      || typeof value.onSettingsModelProgress !== "function") {
      throw new Error(t("Настройки доступны только в приложении Electron.", "Settings are available in the desktop app."));
    }
    return value;
  }

  function setStatus(message, type = "") {
    status.textContent = String(message || "");
    status.className = type;
  }

  function setModelProgress(message, type = "") {
    modelProgress.textContent = String(message || "");
    modelProgress.className = `settings-model-progress${type ? ` ${type}` : ""}`;
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Lock theme choices with the rest of the settings form during serialized saves.
  function setWorking(nextWorking) {
    working = Boolean(nextWorking);
    [modelOpen, modelChoose, pathBrowse, skipModel, skipPath, turboquantEnabled,
      skipTurboquant, languageInput, ...themeInputs, saveButton, cancelButton]
      .filter(Boolean)
      .forEach((control) => {
        control.disabled = working;
      });
    if (!working) {
      updateTurboQuantAvailability();
    }
    if (window.settingsModelPicker && modelPicker) {
      window.settingsModelPicker.setDisabled(modelPicker, working);
    }
    window.notesSettingsNotePairs.setDisabled(working);
    preferences.setDisabled(working);
  }

  function activeCatalogModel() {
    return snapshot?.models.find((model) => model.id === snapshot.activeModelId) || null;
  }

  function runtimeModel(runtime) {
    const modelId = runtime?.provider === "vllm_local"
      ? runtime.vllm?.source_model_id || runtime.runtime_model_id
      : runtime?.runtime_model_id;
    const id = typeof modelId === "string" ? modelId.trim() : "";
    const gguf = /\.gguf$/i.test(id);
    const filePath = gguf || /^(?:[a-z]:[\\/]|[\\/])/i.test(id) || id.includes("\\");
    const label = filePath ? id.split(/[\\/]/).pop() : id;
    const name = gguf ? label.replace(/(?:-\d{5}-of-\d{5})?\.gguf$/i, "") : label;
    const quantization = gguf ? name.match(/-(I?Q\d+(?:_[A-Z0-9]+)*)$/i)?.[1].toUpperCase() : null;
    return { name, gguf, quantization };
  }

  function hardwareRam(model) {
    const match = String(model?.hardware || "").match(/\d+(?:-\d+)?\s*GB(?:\s+RAM)?/i);
    return match ? match[0] : t("По конфигурации", "Depends on hardware");
  }

  function modelSize(model) {
    const size = Number(model?.estimated_download_gb);
    return Number.isFinite(size) && size > 0 ? `~${size.toFixed(1)} GB` : t("Локальная", "Local");
  }

  function addBadge(text, accent = false) {
    const badge = document.createElement("span");
    badge.className = `settings-badge${accent ? " accent" : ""}`;
    badge.textContent = text;
    modelBadges.appendChild(badge);
  }

  function renderRuntime() {
    const runtime = snapshot?.runtime || {};
    const turboquantReady = runtime.provider === "vllm_local" && Boolean(runtime.turboquant?.enabled);
    runtimeState.classList.toggle("warn", !turboquantReady);
    const label = runtimeState.querySelector("span:last-child");
    if (label) {
      label.textContent = turboquantReady
        ? t("TurboQuant готов", "TurboQuant ready")
        : runtime.provider === "local"
          ? t("Локальная GGUF-модель", "Local GGUF model")
          : t("TurboQuant выключен", "TurboQuant off");
    }
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Block unsupported enablement while preserving the user's ability to
  //       disable an already active configuration after hardware changes.
  function updateTurboQuantAvailability() {
    const capability = snapshot?.turboquantCapability || {};
    const currentlyEnabled = Boolean(snapshot?.runtime?.turboquant?.enabled);
    turboquantEnabled.disabled = working || (!capability.supported && !currentlyEnabled);
  }

  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Render the main-process verdict with textContent and keep enable/skip
  //       choices separate for clear startup behavior.
  function renderTurboQuant() {
    const capability = snapshot?.turboquantCapability || {};
    turboquantEnabled.checked = Boolean(snapshot?.runtime?.turboquant?.enabled);
    skipTurboquant.checked = Boolean(snapshot?.settings?.skipTurboQuantSelection);
    turboquantCapability.textContent = window.modelLocale.turboquantReason(capability);
    turboquantCapability.classList.toggle("blocked", !capability.supported);
    updateTurboQuantAvailability();
  }

  // Who: Tim Buglaev
  // When: 2026-07-10
  // What: Preview only allowlisted themes, synchronize both radios from the saved
  //       snapshot, and fall back to Graphite for legacy settings responses.
  function applyThemePreview(theme) {
    if (!supportedThemes.has(theme)) {
      return;
    }
    document.documentElement.dataset.theme = theme;
  }

  function renderTheme(settings) {
    const theme = supportedThemes.has(settings?.theme) ? settings.theme : "classic-blue";
    themeInputs.forEach((input) => {
      input.checked = input.value === theme;
    });
    applyThemePreview(theme);
  }

  function selectedTheme() {
    const theme = themeInputs.find((input) => input.checked)?.value;
    return supportedThemes.has(theme) ? theme : "classic-blue";
  }

  function configuredLanguage(language) {
    return window.nodaLanguages.supported(language) ? language : currentLanguage();
  }

  function renderModelPurpose(pipelineEnabled) {
    modelHeading.textContent = pipelineEnabled
      ? t("Модель для чата", "Chat model")
      : t("Модель по умолчанию", "Default model");
    modelDescription.textContent = pipelineEnabled
      ? t("Выберите локальную модель для чата и задач вне трёх этапов обработки.", "Choose the local model for chat and tasks outside the three note processing stages.")
      : t("Выберите локальную модель для обработки заметок и ответов в чате.", "Choose the local model for processing notes and answering questions.");
    modelDialogTitle.textContent = pipelineEnabled
      ? t("Выберите модель для чата", "Choose a chat model")
      : t("Выберите модель", "Choose a model");
    skipModelLabel.textContent = t("Пропускать выбор модели при запуске программы", "Skip model selection on startup");
    skipModelNote.textContent = t("Приложение будет автоматически использовать сохранённую модель.", "Noda will automatically use the saved model.");
    skipModelRow.hidden = pipelineEnabled;
  }

  async function applyNotePairs(selection, onProgress) {
    const captured = captureProject();
    if (!sameProject(captured)) return;
    const alreadyWorking = working;
    if (!alreadyWorking) setWorking(true);
    let unsubscribe;
    try {
      const api = bridge();
      unsubscribe = api.onSettingsNoteDownloadProgress?.(onProgress);
      const result = await api.applySettingsNotePairs({ ...selection, ...projectIds(captured) }).catch(() => null);
      if (!sameProject(captured)) return;
      if (result?.downloadError) {
        throw new Error(window.notesSettingsNotePairs.downloadError(result.downloadError));
      }
      const pipeline = result?.runtime?.note_pipeline;
      const { newTags, stageEnabled, ...required } = selection;
      if (result?.ok !== true || pipeline?.enabled !== true || pipeline?.configured !== true
        || Object.entries(required).some(([stage, pairId]) => pipeline.selection?.[stage] !== pairId)
        || (stageEnabled && Object.entries(stageEnabled).some(
          ([stage, active]) => pipeline.stageEnabled?.[stage] !== active))
        || (newTags && (pipeline.newTags?.enabled !== newTags.enabled
          || pipeline.newTags?.pairId !== newTags.pairId))) {
        throw new Error(t("Не удалось сохранить настройки обработки. Попробуйте ещё раз.",
          "Could not save processing settings. Try again."));
      }
      snapshot.runtime = result.runtime;
      return pipeline;
    } catch (error) {
      if (sameProject(captured)) throw error;
    } finally {
      unsubscribe?.();
      if (!alreadyWorking && sameProject(captured)) setWorking(false);
    }
  }

  function renderSnapshot({ keepPairDraft = false } = {}) {
    const settings = snapshot?.settings || {};
    const model = activeCatalogModel();
    const configured = runtimeModel(snapshot?.runtime);
    const pipeline = snapshot?.runtime?.note_pipeline;
    if (!keepPairDraft) window.notesSettingsNotePairs.render(pipeline, applyNotePairs, () => preferences.updateRestart());
    window.notesSettingsNotePairs.renderStartup(settings);
    renderModelPurpose(pipeline?.enabled === true);
    modelName.textContent = model?.name || configured.name || t("Текущая модель не определена", "Current model unknown");
    modelBadges.replaceChildren();
    if (model) {
      addBadge(model.artifact === "gguf" ? "GGUF" : "vLLM / HF");
      addBadge(hardwareRam(model));
      addBadge(model.quantization || window.modelLocale.quality(model, "Локальная", "Local"));
      addBadge(modelSize(model));
      if (model.ready !== undefined) addBadge(window.settingsModelPicker.availability(model));
      if (snapshot?.runtime?.turboquant?.enabled) {
        addBadge("TurboQuant", true);
      }
    } else if (configured.gguf) {
      addBadge("GGUF");
      if (configured.quantization) addBadge(configured.quantization);
    }
    notesPath.value = String(settings.notesDirectory || "");
    syncProjectPath();
    skipModel.checked = Boolean(settings.skipModelSelection);
    skipPath.checked = Boolean(settings.skipNotesDirectorySelection);
    if (languageInput) languageInput.value = configuredLanguage(settings.language);
    renderTheme(settings);
    preferences.render(settings);
    renderTurboQuant();
    renderRuntime();
    savedFields = JSON.stringify(settingsFields());
    preferences.updateRestart(settings);
  }

  function validatePayload(payload) {
    if (!payload || payload.ok !== true || !payload.settings || !Array.isArray(payload.models)
      || typeof payload.turboquantCapability?.supported !== "boolean"
      || !supportedThemes.has(payload.settings.theme)) {
      throw new Error(t("Приложение вернуло неполные настройки.", "The app returned incomplete settings."));
    }
    return payload;
  }

  async function loadSettings(options = {}) {
    const captured = captureProject();
    if (!sameProject(captured)) return;
    const draft = options.keepDraft && snapshot ? settingsFields() : null;
    const keepPairDraft = Boolean(draft && window.notesSettingsNotePairs.hasDraft());
    setWorking(true);
    if (!options.silent) {
      setStatus(t("Загружаем настройки...", "Loading settings..."));
    }
    try {
      const payload = await bridge().getAppSettings();
      if (!sameProject(captured)) return;
      snapshot = validatePayload(payload);
      snapshotProject = captured;
      renderSnapshot({ keepPairDraft });
      if (draft) preferences.restoreDraft(draft);
      if (!options.silent) {
        setStatus(t("Настройки загружены.", "Settings loaded."), "ok");
      }
      return snapshot;
    } catch (error) {
      if (sameProject(captured)) throw error;
    } finally {
      if (sameProject(captured)) setWorking(false);
    }
  }

  function closeModelPicker() {
    if (working) {
      return;
    }
    modelModal.hidden = true;
    setModelProgress("");
    modelOpen.focus();
  }

  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Keep model switching visually separate from application startup, expose
  //       elapsed time, and provide explicit ready/error states without fake progress.
  function updateSwitchElapsed() {
    if (!switchStartedAt || !switchElapsed) {
      return;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - switchStartedAt) / 1000));
    switchElapsed.textContent = t(`Прошло: ${seconds} с.`, `Elapsed: ${seconds} s`);
  }

  function stopSwitchTimer() {
    if (switchTimer) {
      window.clearInterval(switchTimer);
      switchTimer = null;
    }
  }

  function showModelSwitch(model) {
    modelModal.hidden = true;
    modelSwitch.hidden = false;
    modelSwitch.classList.remove("ready", "error");
    modelSwitch.setAttribute("aria-busy", "true");
    switchCore.textContent = "◇";
    switchTitle.textContent = t("Переключаем модель", "Switching model");
    switchModel.textContent = model?.name || model?.id || t("Локальная модель", "Local model");
    switchDetail.textContent = model?.downloaded
      ? t("Останавливаем текущую модель и загружаем выбранную в память...", "Stopping the current model and loading the selected one...")
      : t("Скачиваем модель, затем загрузим её в память...", "Downloading the model before loading it into memory...");
    switchClose.hidden = true;
    switchDownloadProgress.hidden = switchStopDownload.hidden = true;
    switchStopDownload.disabled = false;
    switchStartedAt = Date.now();
    stopSwitchTimer();
    updateSwitchElapsed();
    switchTimer = window.setInterval(updateSwitchElapsed, 1000);
  }

  function displayRuntimeText(message, fallback) {
    const value = String(message || "").trim();
    return value && !(currentLanguage() !== "ru" && /[А-Яа-яЁё]/u.test(value)) ? value : fallback;
  }

  function renderModelSwitchProgress(payload = {}) {
    if (modelSwitch.hidden) {
      return;
    }
    const state = ["loading", "ready", "error"].includes(payload.state) ? payload.state : "loading";
    modelSwitch.classList.toggle("ready", state === "ready");
    modelSwitch.classList.toggle("error", state === "error");
    const titles = {
      loading: t("Переключаем модель", "Switching model"),
      ready: t("Модель подключена", "Model ready"),
      error: t("Не удалось переключить модель", "Could not switch models"),
    };
    switchTitle.textContent = displayRuntimeText(payload.message, titles[state]);
    if (payload.detail) {
      const details = {
        loading: "Preparing the selected model...",
        ready: "The selected model is ready.",
        error: "Try again or select another model.",
      };
      switchDetail.textContent = displayRuntimeText(payload.detail, details[state]);
    }
    const download = state === "loading" ? payload.download : null;
    switchDownloadProgress.hidden = !download;
    switchStopDownload.hidden = !download || download.bytes >= download.total
      || typeof window.quickNoteBridge.cancelModelDownload !== "function";
    if (download) {
      switchDownloadProgress.max = download.total;
      switchDownloadProgress.value = download.bytes;
      const format = window.noteModelPairPicker.formatBytes;
      switchDetail.textContent = switchStopDownload.disabled ? t("Останавливаем загрузку…", "Stopping download…")
        : t(`${format(download.bytes)} из ${format(download.total)}`, `${format(download.bytes)} of ${format(download.total)}`);
    }
    if (state !== "loading") {
      stopSwitchTimer();
      modelSwitch.setAttribute("aria-busy", "false");
      switchCore.textContent = state === "ready" ? "✓" : "×";
      switchClose.hidden = state !== "error";
    }
  }

  function hideModelSwitch() {
    stopSwitchTimer();
    switchStartedAt = 0;
    modelSwitch.hidden = true;
    modelSwitch.classList.remove("ready", "error");
    modelSwitch.setAttribute("aria-busy", "false");
    switchCore.textContent = "◇";
    switchClose.hidden = true;
    switchDownloadProgress.hidden = switchStopDownload.hidden = true;
  }

  async function applyModel(model) {
    const captured = captureProject();
    if (!sameProject(captured)) return;
    if (!model?.id) {
      throw new Error(t("Модель не выбрана.", "Select a model first."));
    }
    setWorking(true);
    modelProject = captured;
    showModelSwitch(model);
    const progressMessage = model.downloaded
      ? t("Переключаем модель...", "Switching model...")
      : t("Скачиваем и подключаем модель...", "Downloading and loading model...");
    setStatus(progressMessage);
    setModelProgress(progressMessage);
    try {
      const result = await bridge().applySettingsModel({ model_id: model.id, ...projectIds(captured) });
      if (!sameProject(captured)) return;
      if (result?.canceled) {
        hideModelSwitch();
        setStatus(t("Загрузка остановлена. Модель можно скачать позже.", "Download stopped. You can download the model later."));
        return false;
      }
      if (result?.downloadError) {
        throw new Error(window.notesSettingsNotePairs.downloadError(result.downloadError));
      }
      if (!result || result.ok !== true) {
        throw new Error(t("Не удалось применить выбранную модель.", "Could not load the selected model."));
      }
      snapshot.runtime = result.runtime || snapshot.runtime;
      snapshot.models = Array.isArray(result.models) ? result.models : snapshot.models;
      snapshot.activeModelId = result.activeModelId || model.id;
      await loadSettings({ silent: true, keepDraft: true });
      if (!sameProject(captured)) return;
      setModelProgress("");
      const name = model.name || model.id;
      setStatus(t(`Модель «${name}» подключена.`, `Model ${name} is ready.`), "ok");
      renderModelSwitchProgress({
        state: "ready",
        message: t("Модель подключена", "Model ready"),
        detail: t(`${name} готова к работе.`, `${name} is ready to use.`),
      });
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      if (!sameProject(captured)) return;
      hideModelSwitch();
      return true;
    } catch (error) {
      if (sameProject(captured)) throw error;
    } finally {
      if (sameProject(captured)) setWorking(false);
    }
  }

  function openModelPicker() {
    if (working || !snapshot || !window.settingsModelPicker) {
      return;
    }
    modelModal.hidden = false;
    setModelProgress("");
    // Who: Tim Buglaev
    // When: 2026-06-24
    // What: Use the dedicated settings selector with detected hardware instead of
    //       reusing the startup rail and launch-specific progress information.
    window.settingsModelPicker.render(modelPicker, {
      models: snapshot.models,
      selectedModelId: snapshot.activeModelId,
      activeModelName: modelName.textContent,
      chatModel: snapshot.runtime?.note_pipeline?.enabled === true,
      hardware: snapshot.hardware || {},
    }, {
      disabled: false,
      onCancel: closeModelPicker,
      onImport: window.quickNoteBridge.previewChatModel && window.settingsChatModelImport ? async trigger => {
        const captured = captureProject();
        const api = bridge();
        const scoped = async (method, payload) => {
          if (!sameProject(captured)) return null;
          const result = await method({ ...payload, ...projectIds(captured) }).catch(() => null);
          return sameProject(captured) ? result : null;
        };
        const model = await window.settingsChatModelImport.open(trigger, {
          hardware: snapshot.hardware || {},
          preview: payload => scoped(api.previewChatModel, payload),
          download: payload => scoped(api.downloadChatModel, payload),
          subscribe: api.onChatModelImportProgress,
          cancelDownload: api.cancelModelDownload,
        });
        if (!model || !sameProject(captured)) return;
        snapshot.models = [...snapshot.models.filter(entry => entry.id !== model.id), model];
        return model;
      } : null,
      onChoose: async (model) => {
        const captured = captureProject();
        try {
          if (await applyModel(model) && sameProject(captured)) closeModelPicker();
        } catch (error) {
          if (!sameProject(captured)) return;
          const detail = displayRuntimeText(error?.message, t("Попробуйте ещё раз.", "Try again."));
          setStatus(t(`Ошибка модели: ${detail}`, `Model error: ${detail}`), "error");
          setModelProgress(t(`Ошибка: ${detail}`, `Error: ${detail}`), "error");
          renderModelSwitchProgress({
            state: "error",
            message: t("Не удалось переключить модель", "Could not switch models"),
            detail,
          });
        }
      },
    });
    (modelPicker.querySelector('input[type="search"]') || modelClose).focus();
  }

  async function browseNotesDirectory() {
    if (captureProject()?.projectId) {
      window.dispatchEvent(new CustomEvent("noda-projects:manage"));
      return;
    }
    setWorking(true);
    setStatus(t("Открываем выбор папки...", "Opening folder picker..."));
    try {
      const result = await bridge().chooseNotesDirectory();
      if (result?.canceled) {
        setStatus(t("Выбор папки отменён.", "Folder selection canceled."));
        return;
      }
      if (!result?.ok || typeof result.notesDirectory !== "string") {
        throw new Error(t("Не удалось выбрать папку с заметками.", "Could not select the notes folder."));
      }
      notesPath.value = result.notesDirectory;
      setStatus(t("Новая папка выбрана. Сохраните изменения.", "Folder selected. Save your changes to apply it."));
    } finally {
      setWorking(false);
    }
  }

  function settingsFields() {
    return {
      notesDirectory: notesPath.value,
      skipModelSelection: skipModel.checked,
      skipNotesDirectorySelection: skipPath.checked,
      skipTurboQuantSelection: skipTurboquant.checked,
      ...window.notesSettingsNotePairs.startupSettings(),
      turboquantEnabled: turboquantEnabled.checked,
      theme: selectedTheme(),
      ...(languageInput && { language: configuredLanguage(languageInput.value) }),
      ...preferences.read(),
    };
  }

  async function saveSettings() {
    if (working) return;
    const captured = captureProject();
    if (!sameProject(captured)) return;
    preferences.validate();
    setWorking(true);
    setStatus(t("Сохраняем настройки и проверяем сервисы...", "Saving settings and checking services..."));
    let pairsApplied = false;
    try {
      const pairSave = window.notesSettingsNotePairs.save();
      if (pairSave) {
        await pairSave;
        pairsApplied = true;
      }
      if (!sameProject(captured)) return;
      const startupSettings = window.notesSettingsNotePairs.startupSettings();
      const result = await bridge().saveAppSettings({
        ...projectIds(captured),
        ...settingsFields(),
      });
      if (!sameProject(captured)) return;
      if (!result || result.ok !== true || !result.settings
        || Object.entries(startupSettings).some(([key, value]) => result.settings[key] !== value)) {
        throw new Error(t("Приложение не подтвердило сохранение настроек.", "The app did not confirm that settings were saved."));
      }
      snapshot.settings = result.settings;
      window.NodaPreferences?.apply(result.settings);
      snapshot.runtime = result.runtime || snapshot.runtime;
      snapshot.turboquantCapability = result.turboquantCapability || snapshot.turboquantCapability;
      renderSnapshot({ keepPairDraft: true });
      const changesLanguage = configuredLanguage(result.settings.language) !== currentLanguage();
      setStatus(changesLanguage ? t(
        "Изменения сохранены. Язык применится при следующем запуске.",
        "Changes saved. The language will take effect the next time you start Noda."
      ) : t("Изменения сохранены.", "Changes saved."), "ok");
    } catch (error) {
      if (sameProject(captured)) {
        if (pairsApplied) {
          throw new Error(t("Настройки обработки уже применены. Остальные изменения не сохранились. Повторите сохранение.",
            "Processing settings were applied. The remaining changes were not saved. Try saving again."));
        }
        throw error;
      }
    } finally {
      if (sameProject(captured)) setWorking(false);
    }
  }

  function reportError(prefix, error) {
    setStatus(`${prefix}: ${displayRuntimeText(error?.message, t("попробуйте ещё раз", "try again"))}`, "error");
  }

  modelOpen.addEventListener("click", openModelPicker);
  modelChoose.addEventListener("click", openModelPicker);
  modelClose.addEventListener("click", closeModelPicker);
  switchClose.addEventListener("click", hideModelSwitch);
  switchStopDownload.addEventListener("click", async () => {
    switchStopDownload.disabled = true;
    switchDetail.textContent = t("Останавливаем загрузку…", "Stopping download…");
    const result = await window.quickNoteBridge.cancelModelDownload().catch(() => null);
    if (result?.ok !== true) switchStopDownload.disabled = false;
  });
  // Who: Tim Buglaev
  // When: 2026-07-02
  // What: Preview theme selection immediately without persisting it; cancel and
  //       failed saves restore the last trusted snapshot through renderSnapshot.
  themeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked && !working) {
        applyThemePreview(input.value);
      }
    });
  });
  modelModal.addEventListener("click", (event) => {
    if (event.target === modelModal) {
      closeModelPicker();
    }
  });
  pathBrowse.addEventListener("click", () => {
    browseNotesDirectory().catch((error) => reportError(t("Ошибка выбора папки", "Could not select the folder"), error));
  });
  saveButton.addEventListener("click", () => {
    saveSettings().catch((error) => reportError(t("Ошибка сохранения", "Could not save settings"), error));
  });
  cancelButton.addEventListener("click", () => {
    if (snapshot) {
      renderSnapshot();
      setStatus(t("Несохранённые изменения отменены.", "Unsaved changes discarded."));
    }
  });
  document.addEventListener("keydown", (event) => {
    if (document.querySelector?.(".settings-hf-dialog[open]")) return;
    if (event.key === "Tab" && !modelModal.hidden && modelSwitch.hidden) {
      const controls = [...modelModal.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
      const first = controls[0], last = controls.at(-1);
      if (first && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
    if (event.key === "Escape" && !modelModal.hidden) {
      closeModelPicker();
    } else if (event.key === "Escape" && modelSwitch.classList.contains("error")) {
      hideModelSwitch();
    }
  });

  // Who: Tim Buglaev
  // When: 2026-06-24
  // What: Subscribe to the restricted settings progress channel once and clean it
  //       up with the renderer to avoid duplicate listeners after window teardown.
  unsubscribeSettingsModelProgress = bridge().onSettingsModelProgress(payload => {
    if (sameProject(modelProject)) renderModelSwitchProgress(payload);
  });
  let previousProject = captureProject();
  const unsubscribeProject = projectContext?.subscribe(next => {
    if (previousProject && next.epoch !== previousProject.epoch) {
      modelProject = null; hideModelSwitch(); modelModal.hidden = true;
      setModelProgress(""); setStatus(""); setWorking(false);
    }
    previousProject = next;
    if (next.status === "ready") syncProjectPath();
  });
  window.addEventListener("beforeunload", () => {
    unsubscribeProject?.();
    stopSwitchTimer();
    unsubscribeSettingsModelProgress?.();
    unsubscribeSettingsModelProgress = null;
  }, { once: true });

  window.notesSettingsController = {
    activate: async () => {
      if (working) return;
      if (snapshot && sameProject(snapshotProject)
          && (savedFields !== JSON.stringify(settingsFields()) || window.notesSettingsNotePairs.hasDraft())) return;
      try {
        await loadSettings({ silent: Boolean(snapshot) });
      } catch (error) {
        reportError(t("Не удалось загрузить настройки", "Could not load settings"), error);
      }
    },
    reset: () => {
      if (working) return;
      loadSettings().catch((error) => reportError(t("Не удалось сбросить изменения", "Could not discard changes"), error));
    },
    save: () => {
      saveSettings().catch((error) => reportError(t("Ошибка сохранения", "Could not save settings"), error));
    },
  };
})();
