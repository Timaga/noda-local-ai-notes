// Who: Tim Buglaev
// When: 2026-06-15
// What: Added a full startup model-selection renderer with sidebar steps,
//       filters, recommendations, model table, and a details/action panel.
(function () {
  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const modelDescription = (model) => window.modelLocale?.description(model)
    || t(model.description || "Локальная модель для заметок.", "Local model for notes.");
  const modelQuality = (model) => window.modelLocale?.quality(model) || t(model.quality || "Профиль", "Profile");
  const MODEL_SELECT_STEPS = [
    [["Backend и Flask", "Backend and Flask"], "done"],
    [["Qdrant и индекс заметок", "Qdrant and notes index"], "done"],
    [["Выбор модели", "Model selection"], "active"],
    [["Кэш Hugging Face", "Hugging Face cache"], "pending"],
    [["Среда WSL", "WSL runtime"], "pending"],
    [["vLLM и TurboQuant", "vLLM and TurboQuant"], "pending"],
    [["Готово к работе", "Ready to use"], "pending"],
  ];
  const RECOMMENDED_IDS = ["qwen2_5_1_5b", "qwen3_4b_instruct_2507_q4_k_m", "t_lite_it_2_1_q4_k_m"];
  const FILTERS = [
    ["all", "Все", "All"],
    ["recommended", "Рекомендуемые", "Recommended"],
    ["downloaded", "Скачанные", "Downloaded"],
    ["lowram", "Для 8 GB RAM", "8 GB RAM"],
    ["russian", "Русский", "Russian"],
    ["light", "Лёгкие", "Lightweight"],
  ];

  const pickerState = {
    query: "",
    filter: "all",
    selectedId: "",
    lastRoot: null,
    lastStatus: null,
    lastOptions: null,
  };
  let pairSelection = null;
  const skippedPairStages = new Set();
  let pairStep = 0;
  let pairStagesKey = "";
  let advancedSetup = false;

  function modelSize(model) {
    const value = Number(model.estimated_download_gb);
    return Number.isFinite(value) ? `~${value.toFixed(value >= 10 ? 1 : 1)} GB` : "~? GB";
  }

  function modelRam(model) {
    const source = `${model.hardware || ""} ${model.description || ""}`;
    const range = source.match(/(\d+\s*[-–]\s*\d+|\d+)\s*GB/i);
    if (range) {
      return `${range[1].replace(/\s+/g, "")} GB`;
    }
    const size = Number(model.estimated_download_gb);
    if (Number.isFinite(size)) {
      return size <= 3 ? "2.5 GB" : size <= 6 ? "8 GB" : "16 GB+";
    }
    return "RAM";
  }

  function isRecommended(model) {
    return Boolean(model.recommended || RECOMMENDED_IDS.includes(model.id));
  }

  function isRussian(model) {
    const text = `${model.name || ""} ${model.quality || ""} ${model.description || ""}`.toLowerCase();
    return text.includes("рус") || text.includes("t-lite") || text.includes("vikhr");
  }

  function tagsFor(model) {
    const tags = [];
    if (model.quality) {
      tags.push(modelQuality(model));
    }
    if (isRussian(model)) {
      tags.push(t("Русский", "Russian"));
    }
    if (model.quantization) {
      tags.push(String(model.quantization));
    }
    if (!tags.length) {
      tags.push(t("Код", "Code"));
    }
    return tags.slice(0, 3);
  }

  function sortModels(models) {
    return [...models].sort((left, right) => {
      const leftIndex = RECOMMENDED_IDS.indexOf(left.id);
      const rightIndex = RECOMMENDED_IDS.indexOf(right.id);
      const leftRank = leftIndex >= 0 ? leftIndex : 100 + models.indexOf(left);
      const rightRank = rightIndex >= 0 ? rightIndex : 100 + models.indexOf(right);
      return leftRank - rightRank;
    });
  }

  function filterModels(models) {
    const query = pickerState.query.trim().toLowerCase();
    return models.filter((model) => {
      const text = `${model.name || ""} ${model.hf_model_id || ""} ${model.description || ""} ${model.quality || ""} ${modelDescription(model)} ${modelQuality(model)}`.toLowerCase();
      if (query && !text.includes(query)) {
        return false;
      }
      if (pickerState.filter === "recommended") {
        return isRecommended(model);
      }
      if (pickerState.filter === "downloaded") {
        return Boolean(model.downloaded);
      }
      if (pickerState.filter === "lowram") {
        return Number(model.estimated_download_gb || 99) <= 6.2 || modelRam(model).includes("8");
      }
      if (pickerState.filter === "russian") {
        return isRussian(model);
      }
      if (pickerState.filter === "light") {
        return Number(model.estimated_download_gb || 99) <= 6;
      }
      return true;
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function renderStepRail(steps = MODEL_SELECT_STEPS) {
    const aside = el("aside", "model-select-rail");
    const notes = {
      done: t("Готово", "Done"),
      skipped: t("Пропущено", "Skipped"),
      active: t("Текущий шаг", "Current step"),
      pending: t("Ожидает", "Pending"),
    };
    steps.forEach(([title, state], index) => {
      const item = el("div", `model-select-step ${state}`);
      const marker = el("span", "model-select-step-marker", state === "done" ? "✓"
        : state === "skipped" ? "–" : String(index + 1));
      const text = el("span", "model-select-step-text");
      text.append(el("strong", "", t(...title)), el("small", "", notes[state]));
      if (state === "active") item.setAttribute("aria-current", "step");
      item.append(marker, text);
      aside.appendChild(item);
    });
    return aside;
  }

  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Removed the unclear inactive sort button from startup model selection;
  //       catalog order is already handled by recommended-first sorting and filters.
  function renderSearchAndFilters(status) {
    const controls = el("div", "model-select-controls");
    const searchWrap = el("label", "model-search");
    const searchIcon = el("span", "ui-icon");
    searchIcon.dataset.uiIcon = "search";
    searchIcon.setAttribute("aria-hidden", "true");
    searchWrap.append(searchIcon);
    const input = el("input");
    input.type = "search";
    input.placeholder = t("Поиск модели...", "Search models…");
    input.setAttribute("aria-label", t("Поиск модели", "Search models"));
    input.value = pickerState.query;
    input.addEventListener("input", () => {
      pickerState.query = input.value;
      rerender();
    });
    searchWrap.appendChild(input);
    controls.appendChild(searchWrap);

    const row = el("div", "model-filter-row");
    const chips = el("div", "model-filter-chips");
    FILTERS.forEach(([id, ru, en]) => {
      const button = el("button", `model-filter-chip${pickerState.filter === id ? " active" : ""}`, t(ru, en));
      button.type = "button";
      button.setAttribute("aria-pressed", String(pickerState.filter === id));
      button.addEventListener("click", () => {
        pickerState.filter = id;
        rerender();
      });
      chips.appendChild(button);
    });
    row.appendChild(chips);
    controls.appendChild(row);
    return controls;
  }

  function renderBadge(text, extraClass) {
    return el("span", extraClass ? `model-badge ${extraClass}` : "model-badge", text);
  }

  function renderRecommendedCards(models) {
    const section = el("section", "model-recommended");
    const heading = el("div", "model-section-heading");
    heading.append(el("strong", "", t("☆ Рекомендуемые", "☆ Recommended")), el("button", "", t("Показать все", "Show all")));
    section.appendChild(heading);
    const grid = el("div", "model-recommended-grid");
    models.slice(0, 3).forEach((model) => {
      const active = model.id === pickerState.selectedId;
      const card = el("button", `model-recommend-card${active ? " active" : ""}`);
      card.type = "button";
      card.addEventListener("click", () => {
        pickerState.selectedId = model.id;
        rerender();
      });
      const title = el("div", "model-card-title");
      title.append(el("strong", "", model.name || t("Модель", "Model")));
      if (isRecommended(model)) {
        title.append(renderBadge(t("Рекомендуемая", "Recommended"), "green"));
      }
      card.append(title, el("p", "", modelDescription(model)));
      const meta = el("div", "model-card-meta");
      [modelRam(model), modelSize(model), modelQuality(model)].forEach((item) => meta.append(renderBadge(item)));
      card.appendChild(meta);
      grid.appendChild(card);
    });
    section.appendChild(grid);
    return section;
  }

  function renderModelTable(models, options) {
    const wrap = el("section", "model-table-wrap");
    const top = el("div", "model-table-heading");
    const count = models.length;
    top.append(
      el("strong", "", t(`Все модели (${count})`, `All models (${count})`)),
      el("span", "", t(`${count} моделей`, `${count} ${count === 1 ? "model" : "models"}`))
    );
    wrap.appendChild(top);
    const tableBox = el("div", "model-table-box");
    const table = el("table", "model-table");
    const thead = el("thead");
    const headRow = el("tr");
    [t("Модель", "Model"), "RAM", t("Размер", "Size"), t("Теги", "Tags"), t("Статус", "Status")]
      .forEach((head) => headRow.appendChild(el("th", "", head)));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el("tbody");
    models.slice(0, 10).forEach((model) => tbody.appendChild(renderModelRow(model, options)));
    table.appendChild(tbody);
    tableBox.appendChild(table);
    wrap.appendChild(tableBox);
    const shown = Math.min(10, count);
    wrap.appendChild(el("p", "model-table-note", t(`Показано ${shown} из ${count} моделей`, `Showing ${shown} of ${count} models`)));
    return wrap;
  }

  // Who: Tim Buglaev
  // When: 2026-06-15
  // What: Keep table cells as real table cells and move flex layout into
  //       inner wrappers so column widths, ellipsis, and row heights stay stable.
  function renderModelRow(model, options) {
    const active = model.id === pickerState.selectedId;
    const row = el("tr", active ? "active" : "");
    row.addEventListener("click", () => {
      pickerState.selectedId = model.id;
      rerender();
    });
    const nameCell = el("td", "model-name-cell");
    const nameContent = el("div", "model-name-content");
    nameContent.append(el("span", active ? "model-radio active" : "model-radio"), el("strong", "", model.name || t("Модель", "Model")));
    nameCell.appendChild(nameContent);
    row.appendChild(nameCell);
    row.appendChild(el("td", "", modelRam(model)));
    row.appendChild(el("td", "", modelSize(model)));
    const tagCell = el("td", "model-tag-cell");
    const tagContent = el("div", "model-tag-content");
    tagsFor(model).forEach((tag) => tagContent.appendChild(renderBadge(tag)));
    tagCell.appendChild(tagContent);
    row.appendChild(tagCell);
    const status = el("td", "model-status-cell");
    if (model.downloaded) {
      status.append(renderBadge(t("✓ Скачана", "✓ Downloaded"), "downloaded"));
    } else {
      const action = el("button", "model-row-action", t("Скачать", "Download"));
      action.type = "button";
      action.disabled = Boolean(options.disabled);
      action.addEventListener("click", (event) => {
        event.stopPropagation();
        pickerState.selectedId = model.id;
        options.onChoose(model).catch(() => {});
      });
      status.appendChild(action);
    }
    row.appendChild(status);
    return row;
  }

  function renderDetails(model, options) {
    const panel = el("aside", "model-detail-card");
    panel.append(el("h3", "", model.name || t("Модель", "Model")));
    panel.append(el("p", "", modelDescription(model)));
    const specs = el("dl", "model-spec-list");
    [
      ["RAM", modelRam(model)],
      [t("Размер", "Size"), modelSize(model)],
      [t("Формат", "Format"), model.artifact === "gguf" ? `GGUF (${model.quantization || "Q4_K_M"})` : "vLLM / HF"],
      [t("Язык", "Language"), isRussian(model) ? t("Русский, Английский", "Russian, English") : t("Английский, универсальный", "English, general purpose")],
      [t("Совместимость", "Compatibility"), model.artifact === "gguf" ? "Windows, Linux (WSL)" : "vLLM runtime"],
      [t("Подходит для", "Best for"), model.quality ? modelQuality(model) : t("Чаты, заметки, обучение", "Chats, notes, learning")],
    ].forEach(([name, value]) => {
      specs.append(el("dt", "", name), el("dd", "", value));
    });
    panel.appendChild(specs);
    const ram = modelRam(model);
    panel.append(el("p", "model-info-box", t(`ⓘ Требуется минимум ${ram} RAM. Рекомендуется для локального запуска.`, `ⓘ Requires at least ${ram} of RAM. Recommended for local use.`)));
    const auto = el("button", "model-secondary-action", t("✣ Рекомендовать автоматически", "✣ Recommend a model"));
    auto.type = "button";
    auto.disabled = Boolean(options.disabled);
    auto.addEventListener("click", () => {
      pickerState.selectedId = (options.recommended[0] || model).id;
      rerender();
    });
    const primary = el("button", "model-primary-action ui-icon-button ui-icon-after", t("Выбрать и продолжить", "Select and continue"));
    primary.dataset.uiIcon = "forward";
    primary.type = "button";
    primary.disabled = Boolean(options.disabled);
    primary.addEventListener("click", () => {
      options.onChoose(model).catch(() => {});
    });
    panel.append(auto, primary);
    return panel;
  }

  function renderFooter(step = 4, total = 7) {
    const footer = el("div", "model-select-footer");
    footer.append(el("span", "", t(`Шаг ${step} из ${total}`, `Step ${step} of ${total}`)));
    const track = el("div", "model-select-progress");
    const fill = el("span");
    fill.style.width = `${step / total * 100}%`;
    track.appendChild(fill);
    footer.append(track, el("span", "", `${step}/${total}`));
    return footer;
  }

  function renderSetupOptions(root, notePipeline, options, showAdvanced, focusHeading) {
    const picker = window.noteModelPairPicker;
    const recommendation = Object.fromEntries(notePipeline.catalog.map(stage => [stage.id, stage.recommendedId]));
    const canRecommend = notePipeline.catalog.every(stage => stage.options.some(
      pair => pair.id === stage.recommendedId && pair.available !== false));
    const main = el("main", "model-select-main startup-setup-main");
    const heading = el("header", "model-select-heading");
    const title = el("h2", "", t("Настройте обработку заметок", "Set up note processing"));
    title.tabIndex = -1;
    heading.append(title, el("p", "", t("Модели работают на вашем компьютере. Выбор можно изменить в настройках.",
      "Models run on your computer. You can change your selection in Settings.")));
    const card = el("section", "note-pair-stage startup-setup-card");
    const summary = el("div", "note-pair-stage-intro");
    summary.append(el("h3", "note-pair-stage-name", t("Рекомендуемая настройка", "Recommended setup")));
    const pairs = el("ul", "startup-setup-pairs");
    for (const stage of notePipeline.catalog) {
      const label = picker.stages.find(item => item.id === stage.id)?.label;
      const pair = stage.options.find(item => item.id === stage.recommendedId);
      if (label && pair) pairs.append(el("li", "", `${t(...label)} · ${pair.label}`));
    }
    summary.append(pairs, el("p", "startup-download-summary", picker.downloadSummary(
      picker.downloadPlan(notePipeline.catalog, recommendation, notePipeline.stageEnabled, notePipeline.newTags),
      notePipeline.downloadFreeBytes
    )));
    const action = (label, primary, onClick) => {
      const button = el("button", primary ? "model-primary-action" : "note-pair-reset", label);
      button.type = "button";
      button.disabled = Boolean(options.disabled);
      button.addEventListener("click", onClick);
      return button;
    };
    const recommended = action(t("Использовать рекомендации", "Use recommended setup"), true,
      () => options.onChoosePairs(recommendation).catch(() => {}));
    recommended.id = "startup-recommended-setup";
    recommended.dataset.pairUnavailable = String(!canRecommend);
    recommended.disabled ||= !canRecommend;
    const advanced = action(t("Выбрать модели вручную", "Choose models manually"), false, showAdvanced);
    advanced.id = "startup-advanced-setup";
    const skip = action(t("Открыть заметки без обработки ИИ", "Open notes without AI processing"), false, () => {
      const stageEnabled = Object.fromEntries(picker.stages.map(({ id }) => [id, false]));
      options.onChoosePairs({ ...pairSelection, stageEnabled }).catch(() => {});
    });
    skip.id = "startup-skip-setup";
    const actions = el("div", "startup-pair-actions");
    actions.append(recommended, advanced, skip);
    card.append(summary);
    const explanation = el("p", "note-pair-description", t(
      "Без обработки ИИ заголовок берётся из начала заметки. Теги и связи автоматически не добавляются.",
      "Without AI processing, note titles use the start of the note. Tags and links are not added automatically."
    ));
    main.append(heading, card, actions, explanation);
    if (options.statusElement) main.append(options.statusElement);
    const shell = el("div", "model-select-shell startup-pair-shell");
    shell.append(renderStepRail([
      MODEL_SELECT_STEPS[0], MODEL_SELECT_STEPS[1],
      [["Настройка обработки", "Processing setup"], "active"], MODEL_SELECT_STEPS[6],
    ]), main);
    root.replaceChildren(shell);
    if (focusHeading) title.focus();
  }

  function renderPairs(root, notePipeline, options, focusHeading = false) {
    const picker = window.noteModelPairPicker;
    const requested = notePipeline.startupStageIds;
    const validSubset = Array.isArray(requested) && requested.length > 0
      && new Set(requested).size === requested.length
      && requested.every(id => picker.stages.some(stage => stage.id === id));
    const stages = validSubset ? picker.stages.filter(stage => requested.includes(stage.id)) : picker.stages;
    const nextKey = stages.map(stage => stage.id).join(",");
    if (pairStagesKey !== nextKey) {
      resetPairs();
      pairStagesKey = nextKey;
    }
    pairSelection ??= Object.fromEntries(picker.stages.map(({ id }) => {
      const catalog = notePipeline.catalog.find(entry => entry.id === id);
      const savedId = notePipeline.selection?.[id];
      const saved = catalog?.options.find(pair => pair.id === savedId);
      const savedCustom = catalog?.components?.generator?.some(generator =>
        catalog.components.reranker?.some(reranker => savedId === `${generator.id}_${reranker.id}`));
      const recommended = catalog?.options.find(pair => pair.id === catalog.recommendedId);
      return [id, savedCustom ? savedId : (saved || recommended || catalog?.options[0])?.id];
    }));
    const offersSetup = notePipeline.configured === false && stages.length === picker.stages.length
      && !notePipeline.configurationError && Object.hasOwn(notePipeline, "downloadFreeBytes");
    if (offersSetup && !advancedSetup) {
      renderSetupOptions(root, notePipeline, options, () => {
        advancedSetup = true;
        if (options.statusElement) options.statusElement.textContent = "";
        renderPairs(root, notePipeline, options, true);
      }, focusHeading);
      return;
    }
    const stage = stages[pairStep];
    const isLast = pairStep === stages.length - 1;
    const disabled = root.classList.contains("is-applying");
    const steps = [
      MODEL_SELECT_STEPS[0],
      MODEL_SELECT_STEPS[1],
      ...stages.map(({ id, label }, index) => [label, index < pairStep
        ? (skippedPairStages.has(id) ? "skipped" : "done") : index === pairStep ? "active" : "pending"]),
      MODEL_SELECT_STEPS[6],
    ];
    const shell = el("div", "model-select-shell startup-pair-shell");
    const main = el("main", "model-select-main startup-pair-main");
    const heading = el("header", "model-select-heading");
    const title = el("h2", "", t(...stage.label));
    title.tabIndex = -1;
    heading.append(
      el("p", "model-select-eyebrow", t("Модели обработки заметок", "Note processing models")),
      title,
      el("p", "", t(
        "Используйте готовую связку или выберите генератор и ранжировщик отдельно. Свои модели можно скачать из Hugging Face.",
        "Use a preset or choose the generator and reranker separately. You can download your own models from Hugging Face."
      ))
    );
    const pairs = el("div", "startup-pair-picker");
    pairs.id = "startup-note-pairs";
    const actions = el("div", "startup-pair-actions");
    const primaryLabel = () => skippedPairStages.has(stage.id)
      ? t("Включить этап", "Enable stage") : isLast
      ? t("Сохранить и продолжить", "Save and continue")
      : t("Далее", "Next");
    const primary = el("button", "model-primary-action startup-pair-primary ui-icon-button ui-icon-after", primaryLabel());
    primary.dataset.uiIcon = "forward";
    primary.type = "button";
    const setReady = (ready) => {
      primary.dataset.pairUnavailable = String(!ready);
      primary.disabled = root.classList.contains("is-applying") || !ready;
    };
    const downloadSummary = el("p", "startup-download-summary");
    downloadSummary.setAttribute("role", "status");
    function enabledStages() {
      return Object.fromEntries(picker.stages.map(({ id }) => [
        id, notePipeline.stageEnabled?.[id] !== false && !skippedPairStages.has(id),
      ]));
    }
    function syncDownloadSummary() {
      const plan = picker.downloadPlan(notePipeline.catalog, pairSelection, enabledStages(), notePipeline.newTags);
      downloadSummary.textContent = picker.downloadSummary(plan, notePipeline.downloadFreeBytes);
    }
    const ready = picker.render(pairs, {
      catalog: notePipeline.catalog,
      selection: pairSelection,
      disabled,
      stageId: stage.id,
      onChange: (selection, isReady) => {
        Object.assign(pairSelection, selection);
        if (options.statusElement) options.statusElement.textContent = "";
        setReady(isReady);
        syncDownloadSummary();
      },
    });
    setReady(ready);
    syncDownloadSummary();
    function goTo(step) {
      pairStep = step;
      if (options.statusElement) options.statusElement.textContent = "";
      renderPairs(root, notePipeline, options, true);
    }
    function advance(skip) {
      if (skip) skippedPairStages.add(stage.id);
      else skippedPairStages.delete(stage.id);
      if (isLast) {
        primary.textContent = primaryLabel();
        const selection = { ...pairSelection };
        if (skippedPairStages.size) {
          selection.stageEnabled = enabledStages();
        }
        options.onChoosePairs(selection).catch(() => {});
      } else goTo(pairStep + 1);
    }
    primary.addEventListener("click", () => advance(false));
    if (pairStep > 0 || offersSetup) {
      const back = el("button", "note-pair-reset startup-pair-back ui-icon-button", t("Назад", "Back"));
      back.dataset.uiIcon = "back";
      back.type = "button";
      back.disabled = disabled;
      back.addEventListener("click", () => {
        if (pairStep === 0) advancedSetup = false;
        goTo(Math.max(0, pairStep - 1));
      });
      actions.append(back);
    }
    actions.append(primary);
    const reset = pairs.querySelector(":scope > .note-pair-reset");
    if (reset) actions.append(reset);
    const skip = el("button", "note-pair-reset startup-pair-skip", t("Пропустить", "Skip"));
    skip.type = "button";
    skip.disabled = disabled;
    skip.setAttribute("aria-haspopup", "dialog");
    skip.addEventListener("click", () => window.startupPairSkip.ask(stage.id, () => advance(true)));
    actions.append(skip);
    if (options.statusElement) {
      options.statusElement.setAttribute("role", "status");
      actions.append(options.statusElement);
    }
    const controls = el("div", "startup-pair-controls");
    controls.append(downloadSummary, actions);
    main.append(heading, pairs, controls, renderFooter(pairStep + 1, stages.length));
    shell.append(renderStepRail(steps), main);
    root.replaceChildren(shell);
    if (focusHeading) title.focus();
  }

  function render(root, status, options) {
    if (Array.isArray(status.notePipeline?.catalog)) {
      root.classList.toggle("is-applying", Boolean(options.disabled));
      renderPairs(root, status.notePipeline, options);
      return;
    }
    resetPairs();
    const models = sortModels(Array.isArray(status.models) ? status.models : []);
    if (!models.length) {
      return;
    }
    pickerState.lastRoot = root;
    pickerState.lastStatus = status;
    pickerState.lastOptions = options;
    if (!models.some((model) => model.id === pickerState.selectedId)) {
      pickerState.selectedId = status.selectedModelId || models.find((model) => model.active)?.id || models[0].id;
    }
    const recommended = models.filter(isRecommended).slice(0, 3);
    const filtered = filterModels(models);
    const selected = models.find((model) => model.id === pickerState.selectedId) || filtered[0] || models[0];
    const shell = el("div", "model-select-shell");
    const main = el("main", "model-select-main");
    const heading = el("header", "model-select-heading");
    heading.append(el("p", "model-select-eyebrow", t("ЗАПУСК ПРИЛОЖЕНИЯ", "APP STARTUP")));
    heading.append(el("h2", "", t("Выберите локальную модель", "Choose a local model")));
    heading.append(el("p", "", t("Мы рекомендуем подходящие варианты первыми. Используйте поиск и фильтры, чтобы быстро найти нужную модель.", "Recommended models appear first. Use search and filters to find a model.")));
    if (options.statusElement) {
      options.statusElement.setAttribute("role", "status");
      heading.appendChild(options.statusElement);
    }
    main.append(heading, renderSearchAndFilters(status), renderRecommendedCards(recommended.length ? recommended : models.slice(0, 3)));
    const body = el("div", "model-select-body");
    body.append(renderModelTable(filtered, options), renderDetails(selected, { ...options, recommended }));
    main.append(body, renderFooter());
    shell.append(renderStepRail(), main);
    root.replaceChildren(shell);
  }

  function rerender() {
    if (pickerState.lastRoot && pickerState.lastStatus && pickerState.lastOptions) {
      render(pickerState.lastRoot, pickerState.lastStatus, pickerState.lastOptions);
    }
  }

  function setDisabled(root, disabled) {
    if (!root) {
      return;
    }
    root.classList.toggle("is-applying", Boolean(disabled));
    Array.from(root.querySelectorAll("button, input, select")).forEach((control) => {
      control.disabled = Boolean(disabled) || control.dataset.pairUnavailable === "true";
    });
  }

  function resetPairs() {
    pairSelection = null;
    skippedPairStages.clear();
    window.startupPairSkip?.reset();
    pairStep = 0;
    pairStagesKey = "";
    advancedSetup = false;
  }

  window.startupModelPicker = { render, setDisabled, resetPairs };
})();
