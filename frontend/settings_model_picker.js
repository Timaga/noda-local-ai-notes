(() => {
  "use strict";

  const t = (ru, en) => window.nodaI18n.t(ru, en);
  let active;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, label, click) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", click);
    return node;
  }

  function fileSize(model) {
    const size = Number(model.estimated_download_gb);
    return size > 0 ? `${new Intl.NumberFormat(window.nodaI18n.locale(), { maximumFractionDigits: 2 }).format(size)} GB`
      : t("Неизвестен", "Unknown");
  }

  function evaluate(model, hardware) {
    return window.modelCompatibility.evaluate(model, hardware, window.nodaI18n.locale());
  }

  function memory(info) {
    return `${info.minimumGb}–${info.recommendedGb} GB ${info.memoryType.toUpperCase()}`;
  }

  function hardwareLabel(hardware) {
    return [hardware.ramGb && `${hardware.ramGb} GB RAM`, hardware.gpuMemoryGb && `${hardware.gpuMemoryGb} GB VRAM`]
      .filter(Boolean).join(" · ") || t("Память не определена", "Memory not detected");
  }

  function availability(model) {
    if (!model.downloaded) return t("Нужна загрузка", "Download required");
    if (model.ready === true) return t("Готова", "Ready");
    if (model.active && model.ready === false) return t("Выбрана · На диске", "Selected · On disk");
    if (model.active) return t("Активна", "Active");
    return t("На диске", "On disk");
  }

  function render(root, status, options) {
    const { hardware = {}, activeModelName } = status;
    let models = [...(status.models || [])];
    let selected = models.find(model => model.id === status.selectedModelId) || null;
    let filter = "all";

    const shell = el("div", "settings-picker-content");
    const intro = el("div", "settings-picker-intro");
    const summary = el("div", "settings-picker-summary");
    summary.append(el("span", "settings-picker-muted", t("Текущая модель", "Current model")),
      el("strong", "", activeModelName || t("Не выбрана", "None selected")));
    intro.append(summary, el("span", "settings-picker-hardware", hardwareLabel(hardware)));

    const controls = el("div", "settings-picker-controls");
    const search = el("input", "settings-picker-search");
    search.type = "search";
    search.placeholder = t("Найти модель…", "Find a model…");
    search.setAttribute("aria-label", t("Поиск модели", "Search models"));
    controls.append(search);
    const sort = el("select", "settings-picker-sort");
    sort.setAttribute("aria-label", t("Сортировка моделей", "Sort models"));
    for (const [value, label] of [["compatibility", t("По совместимости", "By compatibility")],
      ["size", t("По размеру", "By size")], ["quality", t("По качеству", "By quality")]]) {
      const option = el("option", "", label);
      option.value = value;
      sort.append(option);
    }
    controls.append(sort);
    if (options.onImport) {
      const importButton = button("settings-picker-import ui-icon-button", t("Из Hugging Face", "From Hugging Face"), async event => {
        const trigger = event.currentTarget;
        const model = await options.onImport(trigger);
        if (!model || active?.root !== root || !root.contains(trigger)) return;
        models = [...models.filter(entry => entry.id !== model.id), model];
        selected = model;
        search.value = "";
        filter = "imported";
        update();
        list.querySelector('[aria-pressed="true"]')?.focus();
      });
      importButton.dataset.uiIcon = "download";
      controls.append(importButton);
    }

    const chips = el("div", "settings-picker-filters");
    const filters = [
      ["all", t("Все", "All"), () => true],
      ["recommended", t("Рекомендуемые", "Recommended"), model => model.recommended],
      ["downloaded", t("На диске", "On disk"), model => model.downloaded],
      ["imported", t("Hugging Face", "Hugging Face"), model => model.imported],
      ["ram8", "≤ 8 GB", model => evaluate(model, hardware).minimumGb <= 8],
      ["ram16", "≤ 16 GB", model => evaluate(model, hardware).minimumGb <= 16],
      ["powerful", t("Для мощных ПК", "High-end PCs"), model => Number(model.quality_rank) >= 4],
      ["russian", t("Русский", "Russian"), model => String(model.language || "").toLowerCase().includes("рус")],
      ["light", t("Лёгкие", "Lightweight"), model => Number(model.estimated_download_gb) <= 5],
    ];
    for (const [key, label] of filters) {
      const chip = button("", label, () => { filter = key; update(); });
      chip.dataset.filter = key;
      chips.append(chip);
    }

    const body = el("div", "settings-picker-body");
    const library = el("section", "settings-picker-library");
    const count = el("h3", "settings-picker-count");
    const list = el("div", "settings-picker-list");
    const details = el("aside", "settings-picker-details");
    library.append(count, list);
    body.append(library, details);
    const footer = el("footer", "settings-picker-footer");
    const note = el("span", "settings-picker-muted");
    const cancel = button("settings-picker-cancel", t("Отмена", "Cancel"), options.onCancel);
    const choose = button("settings-picker-choose", t("Подключить", "Use model"), () => options.onChoose(selected).catch(() => {}));
    footer.append(note, cancel, choose);
    shell.append(intro, controls, chips, body, footer);
    root.replaceChildren(shell);

    function update() {
      const query = search.value.trim().toLowerCase();
      const match = filters.find(([key]) => key === filter)[2];
      const entries = models.filter(model => match(model) && (!query ||
        [model.name, model.gguf_filename, model.hf_model_id, model.quantization].join(" ").toLowerCase().includes(query)));
      const levels = { fit: 2, edge: 1, hard: 0 };
      entries.sort((left, right) => {
        if (sort.value === "size") return (left.estimated_download_gb || Infinity) - (right.estimated_download_gb || Infinity);
        if (sort.value === "quality") return (right.quality_rank || 0) - (left.quality_rank || 0);
        return levels[evaluate(right, hardware).level] - levels[evaluate(left, hardware).level]
          || Number(Boolean(right.active)) - Number(Boolean(left.active))
          || Number(Boolean(right.recommended)) - Number(Boolean(left.recommended));
      });
      for (const chip of chips.children) chip.setAttribute("aria-pressed", String(chip.dataset.filter === filter));
      count.textContent = t(`Модели · ${entries.length}`, `Models · ${entries.length}`);
      list.replaceChildren(...entries.map(model => {
        const fit = evaluate(model, hardware);
        const row = button("settings-picker-row", "", () => {
          selected = model;
          for (const other of list.children) other.setAttribute("aria-pressed", String(other === row));
          updateDetails();
        });
        row.setAttribute("aria-pressed", String(selected?.id === model.id));
        const title = el("span", "settings-picker-row-title");
        title.append(el("strong", "", model.name || model.id), el("small", "", [
          model.quantization || (model.artifact === "gguf" ? "GGUF" : "vLLM"), fileSize(model),
          availability(model),
        ].join(" · ")));
        row.append(title, el("span", `settings-picker-fit compat-${fit.level}`, fit.label));
        return row;
      }));
      if (!entries.length) list.append(el("p", "settings-picker-empty", t("Модели не найдены.", "No models found.")));
      updateDetails();
    }

    function updateDetails() {
      details.replaceChildren();
      const connected = selected?.active && selected.downloaded && selected.ready !== false;
      choose.disabled = options.disabled || !selected || connected;
      note.textContent = connected ? t("Эта модель уже подключена", "This model is connected")
        : selected?.configured && !selected.downloaded
          ? t("Модель выбрана, скачайте её для работы чата.", "The model is selected. Download it to use chat.")
          : "";
      choose.textContent = selected && !selected.downloaded ? t("Скачать и подключить", "Download and use") : t("Подключить", "Use model");
      if (!selected) {
        details.append(el("p", "settings-picker-empty", t("Выберите модель, чтобы сравнить требования.", "Select a model to see its requirements.")));
        return;
      }
      const info = evaluate(selected, hardware);
      details.append(el("h3", "", selected.name || selected.id));
      details.append(el("p", "settings-picker-muted", selected.imported ? selected.gguf_filename : window.modelLocale.description(selected)));
      const specs = el("dl", "settings-picker-specs");
      for (const [label, value] of [
        [t("Память", "Memory"), memory(info)], [t("Размер на диске", "Disk size"), fileSize(selected)],
        [t("Формат", "Format"), selected.artifact === "gguf" ? "GGUF" : "vLLM"],
        ...(!selected.imported ? [[t("Язык", "Language"), window.modelLocale.language(selected)],
          [t("Профиль", "Profile"), window.modelLocale.quality(selected)]] : []),
      ]) specs.append(el("dt", "", label), el("dd", "", value));
      const fit = el("div", `settings-picker-compat-box compat-${info.level}`);
      fit.append(el("strong", "", info.label), el("p", "", info.detail));
      if (selected.imported) fit.append(el("p", "settings-picker-muted", t("Оценка по размеру весов и объёму RAM.", "Estimated from the weight size and total RAM.")));
      details.append(specs, fit);
    }

    search.addEventListener("input", update);
    sort.addEventListener("change", update);
    active = { root, options, updateDetails };
    update();
  }

  function setDisabled(root, disabled) {
    if (active?.root !== root) return;
    active.options.disabled = disabled;
    root.querySelectorAll("button, input, select").forEach(control => { control.disabled = disabled; });
    active.updateDetails();
  }

  window.settingsModelPicker = { render, setDisabled, availability };
})();
