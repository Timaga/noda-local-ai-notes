(() => {
  "use strict";

  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const labels = {
    generator: ["Генератор", "Generator"],
    reranker: ["Ранжировщик", "Reranker"],
  };
  const errors = {
    import_url: ["Вставьте HTTPS-ссылку на модель или файл в huggingface.co.", "Paste a Hugging Face HTTPS model or file link."],
    import_access: ["Для импорта нужна общедоступная модель.", "The model must be publicly accessible."],
    import_unsupported: ["Модель не подходит для этого поля или версии локального движка.", "This model is incompatible with this field or the local runtime."],
    import_choose_file: ["В репозитории несколько GGUF-файлов. Вставьте ссылку на нужный файл.", "This repository has several GGUF files. Paste a link to the specific file."],
    import_incomplete: ["В репозитории не хватает частей весов. Проверьте выбранный файл или ревизию.", "Some weight files are missing from the repository. Check the selected file or revision."],
    import_changed: ["Модель изменилась. Проверьте ссылку заново.", "The model changed. Check the link again."],
    import_startup: ["Движок не запустил модель. Проверьте, хватает ли памяти и поддерживается ли архитектура.", "The runtime could not start the model. Check available memory and architecture support."],
    import_memory: ["Модели не хватило оперативной или видеопамяти.", "The model ran out of RAM or GPU memory."],
    import_runtime: ["Не удалось получить ответ модели в формате для этой роли.", "Could not get a model response in the format required for this role."],
    busy: ["Локальная обработка занята. Повторите импорт чуть позже.", "Local processing is busy. Try importing again shortly."],
    network: ["Не удалось скачать модель. Проверьте соединение и повторите.", "Could not download the model. Check your connection and retry."],
    integrity: ["Не удалось подтвердить целостность файла модели.", "The model file failed its integrity check."],
    storage: ["Не удалось записать файлы модели.", "Could not write the model files."],
    space: ["На диске недостаточно места для модели.", "There is not enough disk space for the model."],
    disabled: ["Скачивание моделей отключено.", "Model downloads are disabled."],
    canceled: ["Загрузка остановлена. Можно повторить попытку.", "Download stopped. You can try again."],
  };
  let activeDialog = null;

  function el(tag, className, label) {
    const node = document.createElement(tag);
    node.className = className;
    if (label) node.textContent = label;
    return node;
  }

  function openImport(role, button, select, onAdded) {
    if (activeDialog) return;
    const bridge = window.quickNoteBridge;
    const context = window.NodaProjectContext;
    const captured = context?.snapshot();
    const dialog = el("dialog", "note-import-dialog");
    activeDialog = dialog;
    const form = el("form", "note-import-form");
    const heading = el("h3", "", t("Импорт из Hugging Face", "Import from Hugging Face"));
    heading.id = `${select.id}-import-title`;
    dialog.setAttribute("aria-labelledby", heading.id);
    const field = el("label", "", t(...labels[role]));
    const url = el("input", "note-pair-select");
    url.type = "url";
    url.required = true;
    url.maxLength = 1800;
    url.placeholder = "https://huggingface.co/…";
    field.append(url);
    const help = el("p", "note-pair-description", role === "generator"
      ? t("Чат-модель в GGUF любого размера, в том числе в нескольких файлах. Для ссылки на репозиторий Noda предпочитает Q4_K_M.",
        "A GGUF chat model of any size, including models split across files. For repository links, Noda prefers Q4_K_M.")
      : t("Ранжировщик в Safetensors любого размера. Поддерживаются Qwen3 и модели, оценивающие релевантность пары текстов.",
        "A Safetensors reranker of any size. Supports Qwen3 and models that score the relevance of text pairs."));
    const status = el("p", "note-import-status");
    status.setAttribute("role", "status");
    const preview = el("section", "note-import-preview");
    preview.hidden = true;
    const progress = el("progress", "note-import-progress");
    progress.hidden = true;
    progress.setAttribute("aria-label", t("Загрузка модели", "Model download"));
    const actions = el("div", "note-import-actions");
    const close = el("button", "note-pair-reset", t("Закрыть", "Close"));
    close.type = "button";
    const submit = el("button", "note-pair-reset");
    submit.type = "submit";
    actions.append(close, submit);
    form.append(heading, field, help, preview, status, progress, actions);
    dialog.append(form);
    document.body.append(dialog);
    const canPreview = typeof bridge.previewNoteModel === "function";
    const canCancel = typeof bridge.cancelModelDownload === "function";
    const project = captured?.projectId ? { projectId: captured.projectId, contextToken: captured.contextToken } : {};
    let inspected;
    let busy = false;
    let downloading = false;
    let canceling = false;
    let imported = false;
    const fitsOnDisk = () => inspected && inspected.download_bytes <= inspected.disk_free_bytes;
    function syncSubmit() {
      submit.textContent = fitsOnDisk() ? (inspected.download_bytes > 0
        ? t("Скачать модель", "Download model") : t("Добавить модель", "Add model"))
        : canPreview ? t("Проверить ссылку", "Check link") : t("Проверить и скачать", "Check and download");
    }
    function syncClose() {
      close.disabled = busy && (!downloading || !canCancel || canceling);
      close.textContent = downloading && canCancel ? t("Остановить загрузку", "Stop download") : t("Закрыть", "Close");
    }
    function clearPreview() {
      inspected = undefined;
      preview.hidden = true;
      status.textContent = "";
      syncSubmit();
    }
    function stopOrClose() {
      if (!busy) {
        dialog.close();
      } else if (downloading && canCancel && !canceling) {
        canceling = true;
        syncClose();
        status.textContent = t("Останавливаем загрузку…", "Stopping download…");
        bridge.cancelModelDownload().then(result => {
          if (busy && result?.ok !== true) {
            canceling = false;
            syncClose();
          }
        }).catch(() => {
          if (busy) {
            canceling = false;
            syncClose();
          }
        });
      }
    }
    syncSubmit();
    close.addEventListener("click", stopOrClose);
    url.addEventListener("input", clearPreview);
    dialog.addEventListener("cancel", event => {
      if (!busy) return;
      event.preventDefault();
      stopOrClose();
    });
    dialog.addEventListener("close", () => {
      activeDialog = null;
      dialog.remove();
      (imported ? select : button).focus();
    }, { once: true });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy) return;
      const checking = canPreview && !fitsOnDisk();
      busy = url.disabled = submit.disabled = true;
      syncClose();
      status.dataset.state = "";
      status.textContent = checking ? t("Проверяем ссылку…", "Checking the link…")
        : t("Подготавливаем файлы…", "Preparing files…");
      const unsubscribe = checking ? null : bridge.onNoteModelImportProgress?.(update => {
        if (update.state === "downloading") {
          if (canceling) return;
          downloading = update.bytes < update.total;
          syncClose();
          const percent = Math.floor(update.bytes * 100 / update.total);
          progress.hidden = false;
          progress.max = update.total;
          progress.value = update.bytes;
          const format = window.noteModelPairPicker.formatBytes;
          const received = format(update.bytes);
          const total = format(update.total);
          status.textContent = t(`Скачиваем · ${percent}% · ${received} из ${total}`,
            `Downloading · ${percent}% · ${received} of ${total}`);
        } else if (update.state === "testing") {
          downloading = false;
          syncClose();
          progress.hidden = false;
          progress.removeAttribute("value");
          status.textContent = t("Проверяем работу модели на этом компьютере…", "Testing the model on this computer…");
        }
      });
      try {
        const result = checking
          ? await bridge.previewNoteModel({ ...project, url: url.value.trim(), role })
          : await bridge.importNoteModel({ ...project, role,
            ...(inspected ? { url: inspected.url, id: inspected.model.id } : { url: url.value.trim() }),
          });
        if (result?.ok !== true || !result.model) throw new Error(result?.code);
        if (checking) {
          inspected = result;
          const format = window.noteModelPairPicker.formatBytes;
          preview.replaceChildren(el("strong", "", result.model.label), el("p", "", t(
            `К загрузке ${format(result.download_bytes)} · свободно ${format(result.disk_free_bytes)}`,
            `Download ${format(result.download_bytes)} · ${format(result.disk_free_bytes)} free`
          )));
          preview.hidden = false;
          status.textContent = fitsOnDisk() ? t("После загрузки Noda проверит, запускается ли модель.",
            "Noda will test whether the model runs after downloading.") : t(...errors.space);
          if (!fitsOnDisk()) status.dataset.state = "error";
          syncSubmit();
          return;
        }
        if (button.isConnected && (!context || context.isCurrent(captured))) {
          onAdded(result.model);
          imported = true;
        }
        dialog.close();
      } catch (error) {
        if (error.message === "import_changed" || error.message === "space") clearPreview();
        progress.hidden = true;
        status.dataset.state = error.message === "canceled" ? "" : "error";
        status.textContent = Object.hasOwn(errors, error.message) ? t(...errors[error.message])
          : t("Не удалось импортировать модель. Повторите попытку.", "Could not import the model. Try again.");
      } finally {
        unsubscribe?.();
        busy = downloading = canceling = url.disabled = submit.disabled = false;
        syncClose();
        if (dialog.open) submit.focus();
      }
    });
    dialog.showModal();
    url.focus();
  }

  function create(id, stage, disabled, onImport, startup = false) {
    const node = el("fieldset", "note-component-fields");
    node.disabled = disabled;
    const preset = el("select", "note-pair-select");
    preset.id = id;
    const presetLabel = el("label", "note-component-label", t("Готовая связка", "Preset"));
    presetLabel.htmlFor = id;
    const option = (value, label) => {
      const result = el("option", "", label);
      result.value = value;
      return result;
    };
    const custom = option("", t("Своя комбинация", "Custom combination"));
    custom.disabled = true;
    preset.append(custom);
    for (const pair of stage.options) {
      const label = pair.id === stage.recommendedId
        ? t(`${pair.label} · Рекомендуется`, `${pair.label} · Recommended`) : pair.label;
      const item = option(pair.id, label);
      item.disabled = pair.available === false;
      preset.append(item);
    }
    node.append(presetLabel, preset);
    const grid = el("div", "note-component-grid");
    const controls = {};
    for (const [role, label] of Object.entries(labels)) {
      const row = el("div", "note-component-role");
      const labelNode = el("label", "note-component-label", t(...label));
      const select = el("select", "note-pair-select");
      select.id = `${id}-${role}`;
      labelNode.htmlFor = select.id;
      const append = model => {
        if ([...select.options].some(item => item.value === model.id)) return;
        select.append(option(model.id, model.imported
          ? t(`${model.label} · Импорт`, `${model.label} · Imported`) : model.label));
      };
      controls[role] = { select, append };
      for (const model of stage.components[role]) append(model);
      const input = el("div", "note-component-input");
      input.append(select);
      if (window.quickNoteBridge?.importNoteModel) {
        const caption = startup ? t("Скачать из Hugging Face", "Download from Hugging Face") : "Hugging Face";
        const add = el("button", "note-pair-reset note-component-add ui-icon-button", caption);
        add.dataset.uiIcon = "download";
        add.type = "button";
        const action = startup ? caption : t("Импорт из Hugging Face", "Import from Hugging Face");
        add.setAttribute("aria-label", `${action} · ${t(...label)}`);
        add.setAttribute("aria-haspopup", "dialog");
        add.addEventListener("click", () => openImport(role, add, select, model => {
          onImport(role, model);
          select.value = model.id;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }));
        input.append(add);
      }
      row.append(labelNode, input);
      grid.append(row);
    }
    node.append(grid);

    function parts(pairId) {
      for (const generator of stage.components.generator) {
        const prefix = generator.id + "_";
        if (!pairId?.startsWith(prefix)) continue;
        const reranker = stage.components.reranker.find(model => model.id === pairId.slice(prefix.length));
        if (reranker) return { generator, reranker };
      }
      return null;
    }
    const get = () => `${controls.generator.select.value}_${controls.reranker.select.value}`;
    function find(pairId) {
      const known = stage.options.find(pair => pair.id === pairId);
      if (known) return known;
      const pair = parts(pairId);
      if (!pair) return undefined;
      const { generator, reranker } = pair;
      return {
        id: pairId, label: `${generator.label} + ${reranker.label}`,
        languages: generator.languages?.filter(lang => reranker.languages?.includes(lang)),
        experimental: generator.experimental || reranker.experimental,
      };
    }
    function syncPreset() {
      const current = get();
      preset.value = stage.options.some(pair => pair.id === current) ? current : "";
    }
    function set(pairId) {
      const pair = parts(pairId);
      if (pair) for (const role of Object.keys(controls)) controls[role].select.value = pair[role].id;
      syncPreset();
    }
    for (const { select } of Object.values(controls)) select.addEventListener("change", syncPreset);
    preset.addEventListener("change", () => set(preset.value));
    function missingModels() {
      const pair = parts(get());
      return pair ? Object.values(pair).filter(model => model.downloaded === false).map(model => model.label) : [];
    }

    return { node, get, set, find, missingModels, addImported: (role, model) => controls[role].append(model) };
  }

  window.noteStageComponents = { create };
})();
