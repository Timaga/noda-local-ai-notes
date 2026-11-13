(() => {
  "use strict";

  const t = (ru, en) => window.nodaI18n.t(ru, en);
  const section = document.getElementById("settings-note-pairs-section");
  const picker = document.getElementById("settings-note-pairs-picker");
  const fields = document.getElementById("settings-note-pairs-fields");
  const button = document.getElementById("settings-note-pairs-apply");
  const status = document.getElementById("settings-note-pairs-status");
  const progress = document.getElementById("settings-note-pairs-progress");
  const cancel = document.getElementById("settings-note-pairs-cancel");
  const startupChoices = [
    ["skipNoteTitleSelection", document.getElementById("settings-skip-note-title")],
    ["skipNoteTagsSelection", document.getElementById("settings-skip-note-tags")],
    ["skipNoteLinksSelection", document.getElementById("settings-skip-note-links")],
  ];
  const downloadErrors = {
    network: ["Не удалось скачать модели. Проверьте интернет и повторите попытку.", "Could not download the models. Check your connection and try again."],
    space: ["Недостаточно места для скачивания моделей.", "There is not enough disk space to download the models."],
    disabled: ["Скачивание моделей отключено.", "Model downloads are disabled."],
    integrity: ["Файл модели не прошёл проверку. Повторите попытку.", "A model file failed verification. Try again."],
    storage: ["Не удалось сохранить файлы моделей. Проверьте доступ к папке приложения.", "Could not save model files. Check access to the app folder."],
    busy: ["Модели уже скачиваются. Повторите попытку позже.", "A model download is already in progress. Try again later."],
    canceled: ["Загрузка остановлена. Выбор моделей сохранён на экране.", "Download stopped. Your model selection is still on screen."],
  };

  function downloadError(code) {
    return Object.hasOwn(downloadErrors, code) ? t(...downloadErrors[code]) : t(
      "Не удалось подготовить выбранные модели. Повторите попытку.", "Could not prepare the selected models. Try again."
    );
  }

  let pipeline;
  let selection;
  let ready = false;
  let onApply;
  let onDraftChange = () => {};
  let stopping = false;
  function hasDraft() {
    return Boolean(pipeline && selection && Array.isArray(pipeline.catalog)) && (
      pipeline.catalog.some(({ id }) => selection[id] !== pipeline.selection?.[id])
      || (selection.stageEnabled && pipeline.catalog.some(
        ({ id }) => selection.stageEnabled[id] !== pipeline.stageEnabled?.[id]))
      || (selection.newTags && (selection.newTags.enabled !== pipeline.newTags?.enabled
        || selection.newTags.pairId !== pipeline.newTags?.pairId))
    );
  }

  function hasChanges() {
    return ready && (pipeline.configured !== true || hasDraft());
  }

  function canApply() {
    return !fields.disabled && hasChanges();
  }

  function setStatus(message, state = "") {
    status.textContent = message;
    status.className = `settings-field-note ${state}`.trim();
  }

  function renderDownload(download) {
    progress.hidden = !download;
    cancel.hidden = download?.cancellable !== true || download.bytes >= download.total
      || typeof window.quickNoteBridge?.cancelModelDownload !== "function";
    if (!download) {
      stopping = false;
      cancel.disabled = false;
      return;
    }
    const percent = Math.floor(download.bytes / download.total * 100);
    progress.value = percent;
    if (!stopping) setStatus(t(`Скачиваем ${download.model} · ${percent}%`, `Downloading ${download.model} · ${percent}%`));
  }

  function render(nextPipeline, applySelection, draftChanged = onDraftChange) {
    pipeline = nextPipeline;
    onApply = applySelection;
    onDraftChange = draftChanged;
    ready = false;
    selection = {
      ...pipeline?.selection,
      ...(pipeline?.stageEnabled && { stageEnabled: { ...pipeline.stageEnabled } }),
      ...(pipeline?.newTags && { newTags: { enabled: pipeline.newTags.enabled, pairId: pipeline.newTags.pairId } }),
    };
    section.hidden = pipeline?.enabled !== true;
    picker.replaceChildren();
    setStatus("");
    renderDownload(null);
    if (!section.hidden) {
      if (window.noteModelPairPicker && Array.isArray(pipeline.catalog) && pipeline.catalog.length) {
        ready = window.noteModelPairPicker.render(picker, {
          catalog: pipeline.catalog,
          selection,
          newTags: pipeline.newTags,
          stageEnabled: pipeline.stageEnabled,
          downloadFreeBytes: pipeline.downloadFreeBytes,
          onChange(nextSelection, nextReady) {
            selection = nextSelection;
            ready = nextReady;
            button.disabled = !canApply();
            setStatus("");
            onDraftChange();
          },
        });
        if (pipeline.configurationError === "note_pipeline_selection_unreadable") {
          setStatus(t("Сохранённые связки недоступны. Выберите и примените их заново.",
            "Saved model pairs are unavailable. Choose and apply them again."), "error");
        }
      } else {
        setStatus(t("Каталог связок недоступен.", "The model pair catalog is unavailable."), "error");
      }
    }
    button.disabled = !canApply();
    onDraftChange();
  }

  function setDisabled(disabled) {
    fields.disabled = disabled;
    button.disabled = !canApply();
  }

  function renderStartup(settings) {
    for (const [key, input] of startupChoices) input.checked = settings?.[key] !== false;
  }

  function startupSettings() {
    return Object.fromEntries(startupChoices.map(([key, input]) => [key, input.checked]));
  }

  async function saveSelection() {
    const context = window.NodaProjectContext, captured = context?.snapshot();
    const current = () => !context || context.isCurrent(captured);
    if (!current()) return;
    setStatus(t("Проверяем файлы моделей…", "Checking model files…"));
    try {
      const nextPipeline = await onApply(selection, download => {
        if (current()) renderDownload(download);
      });
      if (!current()) return;
      render(nextPipeline, onApply);
      setStatus(t("Настройки обработки сохранены.", "Processing settings saved."), "ok");
    } catch (error) {
      if (!current()) return;
      setStatus(error.message, "error");
      throw error;
    } finally {
      if (current()) renderDownload(null);
    }
  }

  function save() {
    if (hasChanges()) return saveSelection();
  }

  button.addEventListener("click", () => {
    if (canApply()) return saveSelection().catch(() => {});
  });
  cancel.addEventListener("click", async () => {
    stopping = cancel.disabled = true;
    setStatus(t("Останавливаем загрузку…", "Stopping download…"));
    const result = await window.quickNoteBridge.cancelModelDownload().catch(() => null);
    if (result?.ok !== true) stopping = cancel.disabled = false;
  });

  window.notesSettingsNotePairs = { render, renderStartup, startupSettings, setDisabled, save, downloadError, hasDraft };
})();
