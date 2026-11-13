(function (root) {
  "use strict";

  function createDrafts(storage) {
    const memory = new Map();
    const key = (project, title) => `noda:note-draft:v1:${JSON.stringify([project, title])}`;
    function read(project, title) {
      if (!project) return null;
      const id = key(project, title);
      if (memory.has(id)) return memory.get(id);
      try {
        const value = JSON.parse(storage()?.getItem(id) || "null");
        if (value && typeof value.content === "string" && typeof value.title === "string" && typeof value.tags === "string"
            && (value.revision === null || /^[a-f0-9]{64}$/.test(value.revision))) return value;
      } catch { /* Unavailable storage must not hide in-memory drafts. */ }
      return null;
    }
    function write(project, title, value) {
      if (!project) return false;
      const id = key(project, title);
      memory.set(id, value);
      try {
        const target = storage();
        if (!target) return false;
        if (value) target.setItem(id, JSON.stringify(value));
        else target.removeItem(id);
        memory.delete(id);
        return true;
      } catch { return false; }
    }
    return { read, write, isDurable: (project, title) => !memory.has(key(project, title)) };
  }

  function createSearch({ request, isCurrent, onChange, getVault, delay = 180 }) {
    let timer, generation = 0, previous = "", state = { type: "idle" };
    function setState(next) { state = next; onChange(); }
    function search(query, context, immediate = false) {
      clearTimeout(timer);
      const current = ++generation;
      const value = query.trim();
      const previousMatches = value === previous ? state.titles : undefined;
      previous = value;
      if (!value) { setState({ type: "idle" }); return; }
      const expected = getVault();
      const params = new URLSearchParams({ q: value });
      if (expected) params.set("expected_vault_id", expected);
      const active = () => current === generation && isCurrent(context);
      if (!previousMatches) setState({ type: "loading" });
      timer = setTimeout(async () => {
        if (!active()) return;
        try {
          const payload = await request(`/notes?${params}`);
          if (!active()) return;
          if (!Array.isArray(payload.titles) || (expected && expected !== payload.vault_id)) throw new Error("invalid_search_response");
          setState({ type: "ready", titles: new Set(payload.titles) });
        } catch {
          if (active()) setState({ type: "error", ...(previousMatches ? { titles: previousMatches } : {}) });
        }
      }, immediate ? 0 : delay);
    }
    return { search, getState: () => state, reset() { clearTimeout(timer); generation++; previous = ""; state = { type: "idle" }; } };
  }

  function createTrash({ dialog, status, list, context, getVault, request, refresh, text }) {
    let generation = 0;
    async function open() {
      const project = context.snapshot(), vault = getVault(), operation = ++generation;
      if (!context.isCurrent(project)) return;
      const active = () => dialog.open && operation === generation && context.isCurrent(project);
      const suffix = vault ? `&expected_vault_id=${vault}` : "";
      if (!dialog.open) dialog.showModal();
      list.replaceChildren();
      status.textContent = text("Открываем корзину…", "Opening trash…");
      try {
        const payload = await request(`/notes?trash=1${suffix}`);
        if (!active()) return;
        status.textContent = payload.items.length ? "" : text("Корзина пуста.", "Trash is empty.");
        for (const item of payload.items) {
          const doc = list.ownerDocument;
          const row = doc.createElement("li"), button = doc.createElement("button"), label = doc.createElement("span");
          label.textContent = item.title;
          button.type = "button"; button.className = "secondary-btn";
          button.textContent = text("Восстановить", "Restore");
          button.setAttribute("aria-label", text(`Восстановить ${item.title}`, `Restore ${item.title}`));
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const result = await request(`/notes?restore=${encodeURIComponent(item.id)}${suffix}`, { method: "POST" });
              if (!context.isCurrent(project)) return;
              row.remove();
              let updated = false;
              try { await refresh(); updated = result.cache_updated; } catch { /* The file is already restored. */ }
              if (active()) status.textContent = updated ? text("Заметка восстановлена.", "Note restored.")
                : text("Файл восстановлен. Не удалось обновить список заметок.", "File restored. Could not refresh the notes list.");
            } catch (error) {
              if (!active()) return;
              button.disabled = false;
              status.textContent = error.code === "restore_conflict"
                ? text("По этому пути уже есть заметка. Освободите имя файла и повторите.", "A note already exists at that path. Free the filename and try again.")
                : error.code === "restore_missing" ? text("Верните исходную папку заметки и повторите.", "Restore the original folder and try again.")
                  : text("Не удалось восстановить заметку. Попробуйте ещё раз.", "Could not restore the note. Try again.");
            }
          });
          row.append(label, button); list.append(row);
        }
      } catch {
        if (active()) status.textContent = text("Не удалось открыть корзину. Закройте её и попробуйте ещё раз.",
          "Could not open trash. Close it and try again.");
      }
    }
    return { open, close: () => { generation++; if (dialog.open) dialog.close(); } };
  }

  const api = { createDrafts, createSearch, createTrash };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesLibraryTools = api;
})(typeof window === "undefined" ? globalThis : window);
