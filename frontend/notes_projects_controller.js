(function (root) {
  "use strict";
  const INPUTS = ["notes-search", "notes-sort-select", "note-title-input", "note-tags-input", "note-content-input"];
  const SCROLL = ["notes-list", "note-view-content", "notes-viewer", "note-inline-content"];

  function create({ doc, context, bridge, notes, createView, text = ru => ru }) {
    const byId = id => doc.getElementById(id), snapshots = new Map();
    const dialog = byId("project-name-dialog"), form = byId("project-name-form");
    const name = byId("project-name-input"), nameError = byId("project-name-error");
    const management = byId("project-management-dialog"), managementError = byId("project-management-error");
    const managementStatus = byId("project-management-status");
    let managedId = null, managedContext = null, renaming = false;
    let state = context.snapshot(), displayedId = null, displayedEpoch = -1;
    let started = false, loaded = false, disposed = false, localBusy = false, actionBusy = false, localError = "", loadError = "", dismissedError = "", serial = 0;
    let activation = Promise.resolve(), startPromise = null, view, reportedCount = "", reportingCount = "", desiredCount = null;
    const plainError = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600) : "";

    function capture() {
      return { data: notes.read(), inputs: Object.fromEntries(INPUTS.map(id => [id, byId(id).value])),
        scroll: Object.fromEntries(SCROLL.map(id => [id, { top: byId(id).scrollTop, left: byId(id).scrollLeft }])) };
    }
    function restore(saved) {
      for (const id of INPUTS) byId(id).value = saved?.inputs[id] || (id === "notes-sort-select" ? "newest" : "");
      notes.write(saved?.data || {});
    }
    function remember() {
      if (loaded && displayedId) snapshots.set(displayedId, capture());
      loaded = false;
    }
    function block(value) {
      for (const selector of [".notes-sidebar", ".notes-viewer"]) {
        const panel = doc.querySelector(selector);
        if (panel) { panel.inert = value; panel.style.visibility = value ? "hidden" : ""; }
      }
      for (const id of ["refresh-notes-btn", "new-note-btn"]) byId(id).disabled = value;
    }
    function clear() {
      notes.pause(); notes.reset();
      notes.status("", "");
      byId("note-view-content").replaceChildren(); byId("note-view-tags").replaceChildren();
      byId("note-view-title").textContent = ""; restore(null); block(true);
    }
    function update() {
      if (!view || disposed) return;
      const dto = state.projectState || {}, busy = state.status === "switching" || localBusy || actionBusy;
      const mainError = plainError(dto.error), hardError = state.status === "error";
      const projects = (dto.projects || []).map(project => ({ id: project.id, name: project.name,
        path: project.notesDirectory, count: loaded && project.id === displayedId ? notes.read().notes.length : project.noteCount }));
      view.render({ projects, activeProjectId: dto.activeProjectId, pendingProjectId: dto.pendingProjectId,
        busy, ready: state.status === "ready", error: hardError
          ? mainError || text("Не удалось подтвердить состояние проекта. Перезапустите Noda.", "Could not confirm the project state. Restart Noda.")
          : localError || (mainError !== dismissedError ? mainError : "") || loadError,
        message: busy ? text("Открываем проект…", "Opening project…") : "",
        noteTitle: loaded && notes.read().selectedNoteTitle ? byId("note-view-title").textContent : "" });
      for (const id of ["project-name-input", "project-name-submit"]) byId(id).disabled = busy || hardError;
      byId("project-name-cancel").disabled = busy;
      const managed = projects.find(project => project.id === managedId);
      const active = managed && managedId === state.projectId;
      if (managed) byId("project-management-heading").textContent = managed.name;
      byId("project-management-hint").hidden = !active;
      for (const id of ["open", "rename", "detach", "backup"]) {
        byId(`project-management-${id}`).disabled = busy || !managed || (id === "detach" && active);
      }
      byId("project-management-close").disabled = actionBusy;
    }
    async function activate(next) {
      const operation = ++serial;
      remember(); localBusy = true; clear(); state = next; displayedEpoch = next.epoch; displayedId = next.projectId;
      localError = plainError(next.projectState?.error); loadError = ""; dismissedError = ""; update();
      const saved = snapshots.get(next.projectId); restore(saved);
      try {
        await notes.refresh();
        if (disposed || operation !== serial || !context.isCurrent(next)) return;
        loaded = true; localBusy = false; block(false);
        if (saved) for (const id of SCROLL) {
          byId(id).scrollTop = saved.scroll[id].top; byId(id).scrollLeft = saved.scroll[id].left;
        }
        notes.resume(); notesChanged();
      } catch (error) {
        if (disposed || operation !== serial || !context.isCurrent(next)) return;
        localBusy = false; loadError = text("Не удалось загрузить заметки. Нажмите «Повторить».", "Could not load notes. Select “Try again”.");
        block(false); notes.resume(); update();
      }
    }
    function receive(next) {
      state = next;
      if (!started) return;
      if (next.projectState?.mode === "legacy") return;
      if (next.status !== "ready") {
        if (displayedEpoch !== next.epoch) { serial += 1; remember(); clear(); displayedEpoch = next.epoch; }
        localBusy = next.status === "switching"; update(); return;
      }
      if (displayedEpoch !== next.epoch) activation = activate(next);
      else update();
    }
    async function run(action) {
      if (disposed || localBusy || actionBusy || state.status !== "ready") return false;
      localError = ""; dismissedError = plainError(state.projectState?.error); actionBusy = true; update();
      try {
        const result = await action();
        if (!result || result.ok !== true) {
          localError = plainError(result?.error) || plainError(state.projectState?.error)
            || text("Не удалось выполнить действие. Попробуйте ещё раз.", "Could not complete the action. Please try again.");
          update(); return false;
        }
        return result.canceled === true ? false : result;
      } catch {
        localError = text("Не удалось выполнить действие. Попробуйте ещё раз.", "Could not complete the action. Please try again."); update(); return false;
      } finally { actionBusy = false; update(); }
    }
    function openNameDialog(project) {
      if (localBusy || actionBusy || state.status !== "ready") return;
      renaming = Boolean(project);
      name.value = project?.name || "";
      name.maxLength = renaming ? 120 : 80;
      byId("project-name-heading").textContent = renaming ? text("Переименовать проект", "Rename project") : text("Новый проект", "New project");
      byId("project-name-submit").textContent = renaming ? text("Сохранить", "Save") : text("Выбрать папку", "Choose parent folder");
      nameError.hidden = true; dialog.showModal(); name.focus();
    }
    function openManagement(id) {
      if (localBusy || actionBusy || state.status !== "ready" || !state.projectState?.projects.some(project => project.id === id)) return;
      managedId = id; managedContext = state; managementError.hidden = true;
      managementStatus.textContent = ""; managementStatus.hidden = true;
      update(); management.showModal();
    }
    const managedProject = () => state.projectState?.projects.find(project => project.id === managedId);
    function manage(method, fields = {}) {
      if (!context.isCurrent(managedContext)) {
        localError = text("Текущий проект изменился. Откройте меню проекта снова.", "The current project changed. Open the project menu again.");
        return false;
      }
      return run(() => bridge[method]({ targetId: managedId,
        projectId: managedContext.projectId, contextToken: managedContext.contextToken, ...fields }));
    }
    async function finishManagement(method) {
      managementError.hidden = true;
      if (await manage(method)) {
        management.close();
        if (method === "detachProject") byId("connect-project-btn").focus();
      } else if (localError) {
        managementError.textContent = localError; managementError.hidden = false;
      }
    }
    const openFolder = () => finishManagement("openProjectFolder");
    const rename = () => { const project = managedProject(); if (project) openNameDialog(project); };
    async function backup() {
      if (localBusy || actionBusy || !managedProject()) return;
      managementError.hidden = true;
      managementStatus.hidden = false;
      managementStatus.textContent = text("Сохраняем копию заметок…", "Saving a copy of the notes…");
      const result = await manage("backupProject");
      managementStatus.hidden = !result;
      managementStatus.textContent = result
        ? text(`Копия проверена и сохранена в папку ${result.directory}`, `Backup verified and saved to ${result.directory}`) : "";
      if (!result && localError) {
        managementError.textContent = localError;
        managementError.hidden = false;
      }
    }
    function detach() {
      if (managedId === state.projectId || localBusy || actionBusy) return;
      const project = managedProject();
      if (project && root.confirm(text(
        `Отключить проект «${project.name}»? Папка, заметки и история сохранятся. Чтобы вернуть проект, подключите ту же папку.`,
        `Disconnect “${project.name}”? The folder, notes and history are kept. Connect the same folder to restore the project.`))) {
        return finishManagement("detachProject");
      }
    }
    const managementActions = { open: openFolder, rename, backup, detach };
    const keepBusyDialog = event => { if (actionBusy) event.preventDefault(); };
    const connect = () => run(() => bridge.connectProject());
    const select = id => { if (id !== state.projectId) return run(() => bridge.switchProject(id)); };
    const cancel = event => { if (localBusy || actionBusy) event?.preventDefault(); else dialog.close(); };
    async function submit(event) {
      event.preventDefault();
      const value = name.value.trim();
      if (!value || value.length > (renaming ? 120 : 80) || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(value) || value === "." || value === "..") {
        nameError.textContent = text("Укажите название без символов пути.", "Enter a name without path characters."); nameError.hidden = false; name.focus(); return;
      }
      nameError.hidden = true;
      const result = renaming ? await manage("renameProject", { name: value })
        : await run(() => bridge.createProject({ name: value }));
      if (result) { dialog.close(); name.value = ""; }
      else if (localError) { nameError.textContent = localError; nameError.hidden = false; }
    }
    const unsubscribe = context.subscribe(receive);

    async function initialize() {
      view = createView({ doc, onSelect: select, onCreate: () => openNameDialog(), onConnect: connect, onManage: openManagement, text });
      form.addEventListener("submit", submit); dialog.addEventListener("cancel", cancel);
      byId("project-name-cancel").addEventListener("click", cancel);
      management.addEventListener("cancel", keepBusyDialog);
      for (const [id, handler] of Object.entries(managementActions)) byId(`project-management-${id}`).addEventListener("click", handler);
      let initial;
      try { initial = await context.ready(); }
      catch { started = true; clear(); state = context.snapshot(); update(); return; }
      if (disposed) return;
      if (initial.projectState?.mode === "legacy") {
        byId("notes-projects-panel").hidden = true;
        byId("notes-projects-panel").parentElement.classList.remove("notes-projects-layout");
        const version = notes.read().noteSelectionVersion; notes.start?.(); await notes.refresh();
        if (version !== notes.read().noteSelectionVersion) return;
        const first = notes.read().notes[0]; if (first) await notes.select(first.title); else notes.newNote();
        return;
      }
      started = true; receive(context.snapshot()); await activation;
    }
    function dispose() {
      disposed = true; serial += 1; unsubscribe(); view?.dispose(); notes.pause();
      snapshots.clear(); form.removeEventListener("submit", submit); dialog.removeEventListener("cancel", cancel);
      byId("project-name-cancel").removeEventListener("click", cancel);
      management.removeEventListener("cancel", keepBusyDialog);
      for (const [id, handler] of Object.entries(managementActions)) byId(`project-management-${id}`).removeEventListener("click", handler);
    }
    function reportCount() {
      if (disposed || reportingCount || !desiredCount) return;
      const { bound, payload, key } = desiredCount; desiredCount = null;
      if (reportedCount === key || !context.isCurrent(bound)) return;
      reportingCount = key;
      Promise.resolve().then(() => context.isCurrent(bound) ? bridge.reportProjectCount(payload) : null)
        .then(result => { if (result?.ok) reportedCount = key; })
        .catch(() => root.console?.warn("Project note count could not be saved"))
        .finally(() => { reportingCount = ""; reportCount(); });
    }
    function notesChanged() {
      if (disposed) return;
      if (!localBusy && state.status === "ready" && displayedId === state.projectId) {
        loaded = true; loadError = "";
        if (state.projectId && typeof bridge.reportProjectCount === "function") {
          const count = notes.read().notes.length, key = `${state.projectId}:${state.contextToken}:${count}`;
          desiredCount = { bound: state, key, payload: { projectId: state.projectId, contextToken: state.contextToken, count } };
          reportCount();
        }
      }
      update();
    }
    return { start: () => startPromise ||= initialize(), update, notesChanged, dispose };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesProjectsController = api;
})(typeof window === "undefined" ? globalThis : window);
