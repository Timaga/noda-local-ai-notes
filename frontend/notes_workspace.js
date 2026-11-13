(function (root) {
  "use strict";
  function create({ doc, text }) {
    const body = doc.body, original = doc.querySelector(".notes-header-actions");
    const create = doc.getElementById("new-note-btn"), refresh = doc.getElementById("refresh-notes-btn");
    const createSlot = doc.getElementById("notes-create-slot"), refreshSlot = doc.getElementById("notes-refresh-slot");
    const projectToggle = doc.getElementById("workspace-project-toggle"), projects = doc.getElementById("notes-projects-panel");
    const projectPicker = root.NotesProjectPicker.create({ doc, trigger: projectToggle, list: doc.getElementById("projects-list") });
    const closeProjects = (restoreFocus = false) => {
      projectPicker.close(restoreFocus);
      const wasOpen = body.classList.contains("projects-drawer-open");
      body.classList.remove("projects-drawer-open"); projectToggle.setAttribute("aria-expanded", "false");
      if (restoreFocus && wasOpen) projectToggle.focus();
    };
    projectToggle.addEventListener("click", () => {
      if (root.innerWidth > 900) { projectPicker.toggle(); return; }
      projectToggle.setAttribute("aria-controls", projects.id);
      const open = body.classList.toggle("projects-drawer-open");
      projectToggle.setAttribute("aria-expanded", String(open));
      if (open) projects.querySelector('[aria-current="true"]')?.focus();
    });
    doc.getElementById("projects-list").addEventListener("click", event => {
      if (event.target.closest(".project-button")) closeProjects();
    });
    for (const id of ["create-project-btn", "connect-project-btn"]) doc.getElementById(id).addEventListener("click", () => {
      doc.getElementById("projects-add-menu").open = false;
    });
    doc.getElementById("note-list-back").addEventListener("click", () => {
      body.dataset.notesMobile = "list"; doc.getElementById("notes-search").focus();
    });
    doc.addEventListener("click", event => {
      for (const menu of doc.querySelectorAll(".notes-compact-menu[open]")) if (!menu.contains(event.target)) menu.open = false;
    });
    doc.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const openMenus = [...doc.querySelectorAll(".notes-compact-menu[open]")];
      for (const menu of openMenus) {
        menu.open = false; menu.querySelector("summary").focus();
      }
      if (!openMenus.length) closeProjects(true);
    });
    const sort = doc.getElementById("notes-sort-select"), options = [...doc.querySelectorAll("[data-notes-sort]")];
    function renderSort() {
      for (const button of options) button.setAttribute("aria-pressed", String(button.dataset.notesSort === sort.value));
    }
    for (const button of options) button.addEventListener("click", () => {
      sort.value = button.dataset.notesSort; sort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    sort.addEventListener("change", renderSort);
    return {
      tab(tab) {
        renderSort();
        body.dataset.notesTab = tab;
        if (tab === "notes") {
          createSlot.append(create); refreshSlot.append(refresh);
          create.querySelector("span:last-child").textContent = text("Заметка", "Note");
        } else original.append(refresh, create);
        closeProjects();
      },
      openNote() { body.dataset.notesMobile = "editor"; closeProjects(); },
      clear() { body.dataset.notesMobile = "list"; closeProjects(); },
    };
  }
  root.NotesWorkspace = { create };
})(window);
