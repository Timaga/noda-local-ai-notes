(function (root) {
  "use strict";
  const $ = id => document.getElementById(id), t = (ru, en) => root.nodaI18n.t(ru, en);
  const panel = $("notes-tab-graph"), context = root.NodaProjectContext, Model = root.NotesGraphModel;
  const search = $("graph-search"), onlyLinked = $("graph-linked-only"), list = $("graph-note-list");
  const status = $("graph-status"), empty = $("graph-empty"), counter = $("graph-count"), detail = $("graph-selection");
  let model = Model.build({ nodes: [], edges: [] }), view = Model.filter(model), selected = "";
  let revision = "", vault = "", bound = null, epoch = -1, loaded = false, active = false, disposed = false;
  const canvas = root.NotesGraphCanvas.create($("graph-canvas"), {
    onSelect: id => select(id), onOpen: id => open(id),
    onZoom: scale => { $("graph-zoom-value").textContent = `${Math.round(scale * 100)}%`; },
  });
  function current() { return bound && context.isCurrent(bound) && bound.status === "ready"; }
  function open(id) {
    if (!current() || !model.nodes.has(id)) return;
    root.dispatchEvent(new CustomEvent("notes-chat:open-note", { detail: { title: id, projectContext: bound } }));
  }
  function button(id, label, handler) {
    const item = document.createElement("button"); item.type = "button"; item.className = "graph-note-button";
    item.textContent = label; item.dataset.graphNote = id; item.addEventListener("click", handler); return item;
  }
  function select(id, center = false) {
    selected = view.ids.has(id) ? id : ""; canvas.select(selected, center);
    for (const item of list.children) item.setAttribute("aria-pressed", String(item.dataset.graphNote === selected));
    detail.replaceChildren();
    if (!selected) {
      const p = document.createElement("p"); p.textContent = t("Выберите точку или заметку в списке, чтобы увидеть её связи.", "Select a node or a note in the list to see its connections."); detail.append(p); return;
    }
    const heading = document.createElement("h3"); heading.textContent = model.nodes.get(selected).title;
    const peers = [...model.adjacency.get(selected)].sort((a, b) => model.nodes.get(a).title.localeCompare(model.nodes.get(b).title, root.nodaI18n.locale()));
    const count = document.createElement("p"); count.textContent = `${t("Связей", "Connections")}: ${peers.length}`;
    const go = button(selected, t("Открыть заметку", "Open note"), () => open(selected));
    go.classList.add("graph-open-note", "ui-icon-button", "ui-icon-after");
    go.dataset.uiIcon = "forward";
    const links = document.createElement("div"); links.className = "graph-neighbors";
    const label = document.createElement("h4"); label.textContent = t("Связанные заметки", "Connected notes");
    for (const peer of peers) links.append(button(peer, model.nodes.get(peer).title, () => { select(peer, true); }));
    detail.append(heading, count, go);
    if (peers.length) detail.append(label, links);
  }
  function render(resetView = false) {
    view = Model.filter(model, search.value, onlyLinked.checked); canvas.filter(view);
    counter.textContent = `${t("Заметок", "Notes")}: ${view.ids.size} · ${t("Связей", "Connections")}: ${view.edges.length}`;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.graphNote : null;
    const scroll = list.scrollTop, fragment = document.createDocumentFragment();
    const sorted = [...view.ids].sort((a, b) => model.nodes.get(a).title.localeCompare(model.nodes.get(b).title, root.nodaI18n.locale()));
    // A paged accessible list bounds DOM cost; the canvas still contains every node.
    const limit = Number(list.dataset.limit || 100), shown = sorted.slice(0, limit);
    for (const id of shown) {
      const node = model.nodes.get(id), item = button(id, node.title, () => select(id, true));
      const degree = document.createElement("span"); degree.className = "graph-degree"; degree.textContent = String(model.adjacency.get(id).size);
      degree.setAttribute("aria-label", t("Количество связей", "Connection count")); item.append(degree); fragment.append(item);
    }
    list.replaceChildren(fragment); list.scrollTop = scroll;
    if (focused) [...list.children].find(item => item.dataset.graphNote === focused)?.focus({ preventScroll: true });
    $("graph-show-more").hidden = sorted.length <= shown.length;
    $("graph-show-more").textContent = `${t("Показать ещё", "Show more")} (${shown.length}/${sorted.length})`;
    select(selected); empty.hidden = !loaded || view.ids.size > 0;
    empty.textContent = model.nodes.size === 0
      ? t("В проекте пока нет заметок. Создайте первую заметку.", "This project has no notes yet. Create your first note.")
      : t("Нет заметок по выбранному фильтру.", "No notes match the current filter.");
    if (resetView) canvas.fit();
    $("graph-no-links").hidden = !loaded || !model.nodes.size || model.edges.length > 0;
    const unresolved = $("graph-unresolved");
    unresolved.hidden = !loaded || model.unresolved === 0;
    unresolved.textContent = model.unresolved
      ? t(`Ссылки без найденной заметки · ${model.unresolved}`, `Links without a matching note · ${model.unresolved}`) : "";
  }
  function message(text, error = false) {
    status.textContent = text; status.classList.toggle("graph-error", error);
    $("graph-retry").hidden = !error;
  }
  async function refresh(request) {
    if (disposed || !active || !current()) return false;
    const captured = bound, first = !loaded;
    if (first) { panel.setAttribute("aria-busy", "true"); message(t("Загрузка связей…", "Loading connections…")); }
    const query = new URLSearchParams(request.background ? { live: "1" } : {});
    if (vault) query.set("expected_vault_id", vault);
    if (revision && request.background) query.set("if_revision", revision);
    const controller = new AbortController(), timeout = root.setTimeout(() => controller.abort(), 12000);
    try {
      const origin = root.quickNoteBridge?.getBackendOrigin?.() || "http://127.0.0.1:5000";
      const response = await context.fetch(`${origin}/notes-graph?${query}`, { signal: controller.signal });
      const payload = await response.json();
      if (disposed || !context.isCurrent(captured) || !request.isCurrent() || !active) return false;
      if (!response.ok) throw Object.assign(new Error("Graph unavailable"), { code: payload.code });
      if (!/^[a-f0-9]{32}$/.test(payload.vault_id || "") || !/^[a-f0-9]{64}$/.test(payload.revision || "")
          || (vault && payload.vault_id !== vault)) throw new Error("Invalid graph context");
      if (payload.unchanged === true) {
        if (!loaded || payload.revision !== revision) throw new Error("Invalid graph revision");
      } else {
        const next = Model.build(payload); model = next; canvas.setData(model, !loaded);
        loaded = true; vault = payload.vault_id; revision = payload.revision; render();
      }
      panel.setAttribute("aria-busy", "false");
      message(t("Сохранённые связи · обновляется автоматически", "Saved connections · updates automatically"));
      return true;
    } catch (error) {
      if (context.isCurrent(captured) && request.isCurrent() && active && !disposed) {
        panel.setAttribute("aria-busy", "false");
        message(error.code === "graph_limit"
          ? t("Граф превышает лимит: 5 000 заметок, 50 000 связей или 25 млн символов. Данные сохранены.", "Graph exceeds 5,000 notes, 50,000 connections or 25 million characters. Your data is saved.")
          : t("Не удалось обновить граф. Проверьте проект и повторите.", "Could not update the graph. Check the project and retry."), true);
      }
      throw error;
    } finally { root.clearTimeout(timeout); }
  }
  const scheduler = root.NotesLiveSync.create({ refresh, intervalMs: 2500, isVisible: () => active && !document.hidden && current() });
  scheduler.start(); scheduler.pause();
  function activate(value) {
    active = value; canvas.activate(value);
    if (active && current()) scheduler.wake(); else scheduler.pause();
  }
  const unsubscribe = context.subscribe(state => {
    $("graph-project").textContent = state.projectState?.activeProject?.name || t("Текущий проект", "Current project");
    if (state.epoch === epoch) return;
    epoch = state.epoch; bound = state; scheduler.pause(); loaded = false; vault = ""; revision = ""; selected = "";
    model = Model.build({ nodes: [], edges: [] }); canvas.setData(model, true); render();
    message(state.status === "switching" ? t("Переключаем проект…", "Switching project…") : state.status === "ready"
      ? t("Откройте граф, чтобы увидеть связи.", "Open the graph to view connections.") : t("Проект недоступен. Выберите проект в разделе «Заметки».", "Project unavailable. Select a project in Notes."));
    if (active && state.status === "ready") scheduler.wake();
  });
  search.addEventListener("input", () => { list.dataset.limit = "100"; render(true); });
  onlyLinked.addEventListener("change", () => { list.dataset.limit = "100"; render(true); });
  $("graph-show-more").addEventListener("click", () => { list.dataset.limit = String(Number(list.dataset.limit || 100) + 100); render(); });
  $("graph-zoom-in").addEventListener("click", () => canvas.zoom(1.25));
  $("graph-zoom-out").addEventListener("click", () => canvas.zoom(0.8));
  $("graph-fit").addEventListener("click", () => canvas.fit());
  const manualRefresh = () => scheduler.refresh().catch(() => false);
  $("graph-retry").addEventListener("click", manualRefresh);
  $("graph-project-button").addEventListener("click", () => root.dispatchEvent(new Event("noda-projects:manage")));
  document.addEventListener("visibilitychange", () => { canvas.activate(active && !document.hidden); if (document.hidden) scheduler.pause(); else if (active) scheduler.wake(); });
  root.addEventListener("beforeunload", () => { disposed = true; unsubscribe(); scheduler.dispose(); canvas.dispose(); }, { once: true });
  root.notesGraphController = { activate, refresh: manualRefresh };
})(window);
