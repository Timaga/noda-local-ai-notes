(function (root) {
  "use strict";
  function create({ doc, trigger, list }) {
    const menu = doc.createElement("div");
    menu.id = "workspace-project-picker"; menu.className = "workspace-project-picker";
    menu.hidden = true; menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", trigger.id); doc.body.append(menu);
    function close(restoreFocus = false) {
      if (menu.hidden) return;
      menu.hidden = true; trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    }
    function open() {
      menu.replaceChildren();
      for (const source of list.querySelectorAll(".project-button")) {
        const projectId = source.dataset.projectId;
        const button = doc.createElement("button"); button.type = "button";
        button.textContent = source.querySelector(".project-name")?.textContent || source.textContent;
        button.disabled = source.disabled; button.setAttribute("role", "menuitemradio");
        button.setAttribute("aria-checked", String(source.getAttribute("aria-current") === "true"));
        button.addEventListener("click", () => {
          const current = [...list.querySelectorAll(".project-button")].find(item => item.dataset.projectId === projectId);
          close(true); if (current && !current.disabled) current.click();
        });
        menu.append(button);
      }
      if (!menu.children.length) return;
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(rect.left, root.innerWidth - 292))}px`;
      menu.style.top = `${rect.bottom + 8}px`;
      menu.style.maxHeight = `${Math.max(100, root.innerHeight - rect.bottom - 56)}px`;
      menu.hidden = false; trigger.setAttribute("aria-expanded", "true"); trigger.setAttribute("aria-controls", menu.id);
      (menu.querySelector('[aria-checked="true"]:not(:disabled)') || menu.querySelector("button:not(:disabled)"))?.focus();
    }
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      const buttons = [...menu.querySelectorAll("button:not(:disabled)")], index = buttons.indexOf(doc.activeElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length
        : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
          : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
      if (next !== null && buttons.length) { event.preventDefault(); buttons[next].focus(); }
      if (event.key === "Tab") close(true);
    });
    doc.addEventListener("click", event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(); });
    root.addEventListener("resize", () => close(true));
    return { close, isOpen: () => !menu.hidden, toggle() { if (menu.hidden) open(); else close(true); } };
  }
  root.NotesProjectPicker = { create };
})(window);
