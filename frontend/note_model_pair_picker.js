(function () {
  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const stages = [
    { id: "title", label: ["Заголовки", "Titles"], description: ["Создание заголовка заметки", "Generate a title for the note"],
      toggle: ["Генерировать заголовки", "Generate titles"], off: ["Заголовок — до 28 символов из начала заметки", "Use up to 28 characters from the start of the note"] },
    { id: "tags", label: ["Теги", "Tags"], description: ["Выбор из существующих тегов", "Choose from existing tags"],
      toggle: ["Добавлять теги", "Add tags"], off: ["Готовые и новые теги не добавляются", "Existing and new tags are not added"] },
    { id: "links", label: ["Связи между заметками", "Note links"], description: ["Поиск связанных заметок", "Find related notes"],
      toggle: ["Связывать заметки", "Link notes"], off: ["Связи не создаются", "No note links are added"] },
  ];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function formatBytes(bytes) {
    const [scale, unit] = bytes >= 1e9 ? [1e9, t("ГБ", "GB")]
      : bytes >= 1e6 ? [1e6, t("МБ", "MB")] : bytes >= 1e3 ? [1e3, t("КБ", "KB")] : [1, t("Б", "B")];
    return `${new Intl.NumberFormat(window.nodaI18n?.locale(), { maximumFractionDigits: 1 }).format(bytes / scale)} ${unit}`;
  }

  function downloadPlan(catalog, selection, stageEnabled = {}, newTags) {
    const seen = new Set();
    let bytes = 0;
    let unknown = false;
    function add(stage, pairId) {
      const components = stage.components;
      if (!components) {
        unknown = true;
        return;
      }
      const generator = components.generator.find(item => pairId?.startsWith(item.id + "_")
        && components.reranker.some(reranker => pairId === `${item.id}_${reranker.id}`));
      const reranker = components.reranker.find(item => pairId === `${generator?.id}_${item.id}`);
      for (const item of [generator, reranker]) {
        if (!item) {
          unknown = true;
        } else if (!seen.has(item.id)) {
          seen.add(item.id);
          if (Number.isSafeInteger(item.download_bytes) && item.download_bytes >= 0) bytes += item.download_bytes;
          else if (item.downloaded !== true) unknown = true;
        }
      }
    }
    for (const stage of catalog) {
      if (stageEnabled[stage.id] !== false) add(stage, selection[stage.id]);
    }
    if (newTags?.enabled && stageEnabled.tags !== false) add(newTags, newTags.pairId);
    return { bytes, unknown };
  }

  function downloadSummary(plan, diskFreeBytes) {
    if (!plan.bytes && !plan.unknown) return t("Все файлы уже на диске.", "All files are already on disk.");
    const size = formatBytes(plan.bytes);
    const total = plan.unknown
      ? plan.bytes ? t(`К загрузке не менее ${size}`, `At least ${size} to download`)
        : t("Объём загрузки пока неизвестен", "Download size is not yet available")
      : t(`К загрузке ${size}`, `Download ${size}`);
    if (!Number.isSafeInteger(diskFreeBytes) || diskFreeBytes < 0) return `${total}.`;
    const free = formatBytes(diskFreeBytes);
    const capacity = t(`на диске свободно ${free}`, `${free} free on disk`);
    return `${total} · ${capacity}.${plan.bytes > diskFreeBytes
      ? t(" Освободите место или измените выбор.", " Free up disk space or change your selection.") : ""}`;
  }

  function metadata(pair) {
    const supported = Array.isArray(pair?.languages) ? pair.languages : [];
    const languages = [
      ["ru", "Русский", "Russian"],
      ["en", "Английский", "English"],
    ].filter(([code]) => supported.includes(code)).map(([, ru, en]) => t(ru, en));
    const items = [];
    if (languages.length) items.push(["note-pair-language", languages.join(" · ")]);
    if (pair?.experimental === true) items.push(["note-pair-experimental", t("Экспериментальная", "Experimental")]);
    return items;
  }

  function showDownloadWarning(warning, control, active) {
    const missing = active ? control.missingModels?.() || [] : [];
    warning.textContent = missing.length ? t(
      `При сохранении Noda скачает ${missing.join(", ")}.`,
      `Noda will download ${missing.join(", ")} when you save.`
    ) : "";
  }

  function selectControl(groupId, pairs, disabled) {
    const select = element("select", "note-pair-select");
    select.id = groupId;
    select.disabled = disabled;
    for (const pair of pairs) {
      const parts = [pair.label, ...metadata(pair).map(([, text]) => text)];
      if (pair.available === false) parts.push(t("Файлы отсутствуют", "Files missing"));
      const option = element("option", "", parts.join(" — "));
      option.value = pair.id;
      option.disabled = pair.available === false;
      select.append(option);
    }
    return { node: select, get: () => select.value, set: (id) => { select.value = id; } };
  }

  function inlineControl(groupId, pairs, recommendedId, disabled) {
    const group = element("div", "note-pair-choices");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", `${groupId}-label`);
    group.setAttribute("aria-describedby", `${groupId}-description`);
    const radios = [];
    for (const pair of pairs) {
      const choice = element("label", "note-pair-choice");
      const radio = element("input", "note-pair-radio");
      radio.type = "radio";
      radio.name = groupId;
      radio.value = pair.id;
      radio.dataset.pairUnavailable = String(pair.available === false);
      radio.disabled = disabled || pair.available === false;
      const copy = element("span", "note-pair-choice-copy");
      copy.append(element("span", "note-pair-choice-name", pair.label));
      if (pair.id === recommendedId) {
        copy.append(element("span", "note-pair-recommended", t("Рекомендовано", "Recommended")));
      }
      if (pair.available === false) {
        copy.append(element("span", "note-pair-option-missing", t("Файлы отсутствуют", "Files missing")));
      }
      const pairMeta = metadata(pair);
      if (pairMeta.length) {
        const meta = element("span", "note-pair-choice-meta");
        meta.append(...pairMeta.map(([className, text]) => element("span", className, text)));
        copy.append(meta);
      }
      choice.append(radio, copy);
      group.append(choice);
      radios.push(radio);
    }
    return {
      node: group,
      get: () => radios.find((radio) => radio.checked)?.value,
      set: (id) => { for (const radio of radios) radio.checked = radio.value === id; },
    };
  }

  function switchControl(label, descriptionId, checked, disabled) {
    const node = element("label", "note-pair-switch");
    const input = element("input", "note-pair-switch-input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.setAttribute("aria-describedby", descriptionId);
    input.checked = checked;
    input.disabled = disabled;
    const track = element("span", "note-pair-switch-track");
    track.setAttribute("aria-hidden", "true");
    node.append(input, track, element("span", "", label));
    return { node, input };
  }

  function stageControl(groupId, stage, disabled, onImport, inline = false) {
    if (stage.components && window.noteStageComponents) {
      return window.noteStageComponents.create(groupId, stage, disabled, onImport, inline);
    }
    const control = inline ? inlineControl(groupId, stage.options, stage.recommendedId, disabled)
      : selectControl(groupId, stage.options, disabled);
    return { ...control, find: id => stage.options.find(pair => pair.id === id) };
  }

  function newTagsField(groupId, preferences, disabled, onImport) {
    const row = element("div", "note-pair-stage note-pair-stage-experimental");
    const intro = element("div", "note-pair-stage-intro");
    const name = element("label", "note-pair-stage-name", t("Создание новых тегов", "Create new tags"));
    name.htmlFor = groupId;
    const badge = element("span", "note-pair-experiment-badge", t("Экспериментально", "Experimental"));
    const description = element("p", "note-pair-description", t(
      "Добавляет новые теги после выбора готовых, если подходящей темы нет в словаре.",
      "Adds new tags after choosing existing ones when the catalog lacks a matching topic."
    ));
    description.id = `${groupId}-description`;
    intro.append(name, badge, description);

    const controls = element("div", "note-pair-controls");
    const toggle = switchControl(t("Создавать новые теги", "Generate new tags"),
      description.id, preferences.enabled === true, disabled);

    const { options, recommendedId } = preferences;
    const control = stageControl(groupId, preferences, disabled || !toggle.input.checked, onImport);
    const recommended = options.find((pair) => pair.id === recommendedId);
    const selected = control.find(preferences.pairId);
    control.set((selected || recommended || options[0]).id);
    const meta = element("p", "note-pair-selected-meta");
    meta.id = `${groupId}-meta`;
    const warning = downloadWarning(`${groupId}-download`);
    control.node.setAttribute("aria-describedby", `${description.id} ${meta.id} ${warning.id}`);
    controls.append(toggle.node, control.node, meta, warning);
    row.append(intro, controls);
    return { row, toggle: toggle.input, control, recommended, options, meta, warning };
  }

  function downloadWarning(id) {
    const warning = element("p", "note-pair-download-warning");
    warning.id = id;
    warning.setAttribute("role", "status");
    return warning;
  }

  function render(root, { catalog, selection, newTags, stageEnabled, downloadFreeBytes, disabled = false, stageId, onChange }) {
    const selectedStages = stageId ? stages.filter((stage) => stage.id === stageId) : stages;
    const inline = Boolean(stageId);
    const fields = [];
    const onImport = (role, model) => {
      for (const stage of [...catalog, newTags].filter(Boolean)) {
        const choices = stage.components?.[role];
        const existing = choices?.find(choice => choice.id === model.id);
        if (existing) Object.assign(existing, { downloaded: true, download_bytes: 0 });
        else choices?.push(model);
      }
      for (const field of fields) field.control.addImported?.(role, model);
      experiment?.control.addImported?.(role, model);
    };
    for (const { id, label: stageLabel, description: stageDescription, toggle: switchLabel, off } of selectedStages) {
      const stage = catalog?.find((item) => item.id === id);
      if (!stage?.options?.length) continue;

      const groupId = `${root.id || "note-pairs"}-${id}`;
      const row = element("div", inline ? "note-pair-stage note-pair-stage-inline" : "note-pair-stage");
      const intro = element("div", "note-pair-stage-intro");
      const label = element(inline ? "h3" : "label", "note-pair-stage-name", t(...stageLabel));
      label.id = `${groupId}-label`;
      const description = element("p", "note-pair-description", t(...stageDescription));
      description.id = `${groupId}-description`;
      intro.append(label, description);

      const controls = element("div", "note-pair-controls");
      const control = stageControl(groupId, stage, disabled, onImport, inline);
      controls.append(control.node);
      const recommendation = inline ? null : element("p", "note-pair-recommended");
      const warning = inline ? null : downloadWarning(`${groupId}-download`);
      const meta = !inline || stage.components ? element("p", "note-pair-selected-meta") : null;
      let toggle;
      if (meta) {
        meta.id = `${groupId}-meta`;
        controls.append(meta);
      }
      if (recommendation) {
        recommendation.id = `${groupId}-status`;
        control.node.setAttribute("aria-describedby", `${recommendation.id} ${meta.id} ${warning.id}`);
        label.htmlFor = groupId;
        controls.append(recommendation, warning);
        if (stageEnabled) {
          toggle = switchControl(t(...switchLabel), recommendation.id, stageEnabled[id] !== false, disabled);
          controls.prepend(toggle.node);
        }
      }
      const saved = control.find(selection?.[id]);
      const recommended = stage.options.find((pair) => pair.id === stage.recommendedId);
      control.set((saved || recommended || stage.options[0]).id);
      row.append(intro, controls);
      fields.push({ id, control, row, recommendation, meta, recommended, options: stage.options, toggle, off, warning });
    }

    if (fields.length === 0 || fields.length !== selectedStages.length) {
      const error = element("p", "note-pair-error", t("Каталог связок пока недоступен.", "The model pair catalog is unavailable."));
      root.replaceChildren(error);
      return false;
    }

    const rows = element("div", "note-pair-stages");
    const summary = !inline && element("p", "note-pair-download-warning note-pair-download-summary");
    if (summary) summary.setAttribute("role", "status");
    const experiment = !inline && newTags?.options?.length
      ? newTagsField(`${root.id || "note-pairs"}-new-tags`, newTags, disabled, onImport)
      : null;
    const reset = element("button", "note-pair-reset", inline
      ? t("Выбрать рекомендуемую связку", "Use recommended pair")
      : t("Выбрать рекомендованные", "Use recommended pairs"));
    reset.type = "button";

    function sync(notify) {
      const current = {};
      if (!inline && stageEnabled) current.stageEnabled = {};
      let ready = true;
      for (const field of fields) {
        const pairId = field.control.get();
        const pair = field.control.find(pairId);
        const available = Boolean(pair && pair.available !== false);
        const active = field.toggle?.input.checked ?? true;
        current[field.id] = pairId;
        if (field.toggle) {
          current.stageEnabled[field.id] = active;
          field.control.node.disabled = disabled || !active;
        }
        ready &&= Boolean(pair && (!active || available));
        field.meta?.replaceChildren(...metadata(pair).map(([className, text]) => element("span", className, text)));
        if (!field.recommendation) continue;
        showDownloadWarning(field.warning, field.control, active);
        field.recommendation.classList.toggle("is-missing", active && !available);
        if (!active) {
          field.recommendation.textContent = t(...field.off);
        } else if (!available) {
          field.recommendation.textContent = t("Файлы этой связки отсутствуют", "Files for this pair are missing");
        } else if (pair.id === field.recommended?.id) {
          field.recommendation.textContent = t("Рекомендовано", "Recommended");
        } else {
          const label = field.recommended?.label;
          field.recommendation.textContent = label ? t(`Рекомендуем ${label}`, `Recommended pair: ${label}`) : "";
        }
      }
      if (experiment) {
        const pairId = experiment.control.get();
        const pair = experiment.control.find(pairId);
        const enabled = experiment.toggle.checked;
        const tagsActive = current.stageEnabled?.tags !== false;
        experiment.toggle.disabled = disabled || !tagsActive;
        experiment.control.node.disabled = disabled || !enabled || !tagsActive;
        showDownloadWarning(experiment.warning, experiment.control, enabled && tagsActive);
        experiment.meta.replaceChildren(...metadata(pair).map(([className, text]) => element("span", className, text)));
        if (pair?.id === experiment.recommended?.id) {
          experiment.meta.append(element("span", "", t("Рекомендовано", "Recommended")));
        }
        current.newTags = { enabled, pairId };
        ready &&= Boolean(pair && (!tagsActive || !enabled || pair.available !== false));
      }
      if (summary) {
        const plan = downloadPlan(catalog, current, current.stageEnabled,
          newTags && { ...newTags, ...current.newTags });
        summary.textContent = plan.bytes || plan.unknown ? downloadSummary(plan, downloadFreeBytes) : "";
      }
      if (notify) onChange?.(current, ready);
      return ready;
    }

    for (const field of fields) {
      field.control.node.addEventListener("change", () => sync(true));
      field.toggle?.input.addEventListener("change", () => sync(true));
      rows.append(field.row);
    }
    if (experiment) {
      experiment.toggle.addEventListener("change", () => sync(true));
      experiment.control.node.addEventListener("change", () => sync(true));
      rows.append(experiment.row);
    }
    reset.disabled = disabled;
    reset.addEventListener("click", () => {
      for (const field of fields) {
        if (field.recommended) field.control.set(field.recommended.id);
      }
      if (experiment?.recommended) experiment.control.set(experiment.recommended.id);
      sync(true);
    });
    root.replaceChildren(rows, ...(summary ? [summary] : []), reset);
    return sync(false);
  }

  window.noteModelPairPicker = { render, stages, formatBytes, downloadPlan, downloadSummary };
})();
