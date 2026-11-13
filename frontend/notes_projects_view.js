(function (root) {
  "use strict";

  function create({ doc, onSelect, onCreate, onConnect, onManage, text = (ru) => ru }) {
    const byId = id => doc.getElementById(id);
    const list = byId("projects-list"), createButton = byId("create-project-btn");
    const connectButton = byId("connect-project-btn"), total = byId("projects-total");
    const breadcrumb = byId("project-breadcrumb-root"), breadcrumbNote = byId("project-breadcrumb-note");
    const separator = byId("project-breadcrumb-separator"), message = byId("projects-message");
    const overlay = byId("projects-switch-overlay"), switchLabel = byId("projects-switch-label");
    const layout = byId("notes-projects-panel").parentElement;
    let rows = new Map(), empty = null, pendingFocus = null;
    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    const createProject = () => onCreate(), connectProject = () => onConnect();
    createButton.addEventListener("click", createProject);
    connectButton.addEventListener("click", connectProject);

    function item(project) {
      const node = doc.createElement("li"), button = doc.createElement("button");
      node.className = "project-list-item"; button.className = "project-button"; button.type = "button";
      button.dataset.projectId = project.id;
      const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false"); icon.classList.add("project-icon");
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M3.5 6.5h6l2 2h9v10h-17z"); icon.append(path);
      const labels = doc.createElement("span"), name = doc.createElement("span");
      const location = doc.createElement("span"), count = doc.createElement("span");
      labels.className = "project-labels"; name.className = "project-name";
      location.className = "project-path"; count.className = "project-count";
      labels.append(name, location); button.append(icon, labels, count); node.append(button);
      button.addEventListener("click", () => onSelect(project.id));
      let manage;
      if (onManage) {
        manage = doc.createElement("button"); manage.type = "button"; manage.className = "project-manage-button";
        manage.textContent = "⋯"; manage.setAttribute("aria-haspopup", "dialog");
        manage.addEventListener("click", () => onManage(project.id)); node.append(manage);
      }
      return { node, button, name, location, count, manage };
    }

    function render(state) {
      const projects = state.projects || [];
      if (!Array.isArray(projects) || projects.some(project => !project || typeof project.id !== "string" || !project.id)
          || new Set(projects.map(project => project.id)).size !== projects.length) {
        throw new TypeError("Invalid project view state");
      }
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
      const scrollTop = list.scrollTop, next = new Map(), busy = Boolean(state.busy);
      if (busy && focused) pendingFocus = focused;
      if (projects.length && empty) { empty.remove(); empty = null; }
      for (const [index, project] of projects.entries()) {
        const row = rows.get(project.id) || item(project);
        const name = String(project.name || text("Без названия", "Untitled"));
        const countKnown = Number.isSafeInteger(project.count) && project.count >= 0;
        setText(row.name, name); setText(row.location, String(project.path || ""));
        setText(row.count, countKnown ? String(project.count) : "—");
        row.button.setAttribute("aria-current", project.id === state.activeProjectId ? "true" : "false");
        row.button.classList.toggle("is-pending", project.id === state.pendingProjectId);
        row.button.disabled = busy || state.ready === false;
        row.button.title = project.path ? `${name}\n${project.path}` : name;
        row.button.setAttribute("aria-label", name);
        if (row.manage) {
          row.manage.disabled = row.button.disabled;
          row.manage.setAttribute("aria-label", text(`Действия с проектом «${name}»`, `Actions for ${name}`));
          row.manage.title = text("Действия с проектом", "Project actions");
        }
        row.count.setAttribute("aria-label", countKnown
          ? `${text("Заметок", "Notes")}: ${project.count}`
          : text("Количество заметок пока неизвестно", "Note count unavailable"));
        if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] || null);
        next.set(project.id, row);
      }
      for (const [id, row] of rows) if (!next.has(id)) row.node.remove();
      rows = next;
      if (!projects.length) {
        if (!empty) { empty = doc.createElement("li"); empty.className = "projects-empty"; list.append(empty); }
        setText(empty, text("Подключите папку или создайте первый проект.", "Connect a folder or create your first project."));
      }
      setText(total, String(projects.length));
      const active = projects.find(project => project.id === state.activeProjectId);
      const heading = byId("notes-list-heading");
      if (heading) setText(heading, active ? String(active.name || text("Без названия", "Untitled")) : text("Заметки", "Notes"));
      setText(breadcrumb, active ? String(active.name || text("Без названия", "Untitled")) : text("Проекты", "Projects"));
      const noteTitle = String(state.noteTitle || "");
      separator.hidden = breadcrumbNote.hidden = !noteTitle;
      setText(breadcrumbNote, noteTitle);
      const status = String(state.error || state.message || "");
      setText(message, status); message.hidden = !status;
      message.setAttribute("role", state.error ? "alert" : "status");
      message.classList.toggle("is-error", Boolean(state.error));
      layout.setAttribute("aria-busy", String(busy)); overlay.hidden = !busy;
      setText(switchLabel, state.message || text("Открываем проект…", "Opening project…"));
      createButton.disabled = connectButton.disabled = busy || state.ready === false;
      list.scrollTop = scrollTop;
      const target = focused || pendingFocus;
      if (!busy) {
        if (target?.isConnected && doc.activeElement === doc.body && doc.hasFocus?.() !== false) target.focus({ preventScroll: true });
        pendingFocus = null;
      }
    }

    function dispose() {
      createButton.removeEventListener("click", createProject);
      connectButton.removeEventListener("click", connectProject);
    }
    return { render, dispose };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesProjectsView = api;
})(typeof window === "undefined" ? globalThis : window);
