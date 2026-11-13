(function (root) {
  "use strict";

  function create({ context, request, getState, inputs, controls, text, clipboard, confirm, presentation, beforeDelete = async () => true }) {
    const bound = () => { const value = context.snapshot(); return { current: () => context.isCurrent(value) }; };
    const vaultSuffix = () => getState().vault ? `?expected_vault_id=${getState().vault}` : "";

    async function createNote() {
      const operation = bound();
      if (!operation.current()) return;
      const title = inputs.title.value.trim(), content = inputs.content.value;
      if (!title || !content.trim()) {
        controls.status("warn", !title ? text("Введите название заметки.", "Enter a note title.")
          : text("Введите содержимое заметки.", "Enter the note content."));
        (!title ? inputs.title : inputs.content).focus(); return;
      }
      inputs.save.disabled = true;
      try {
        const tags = inputs.tags.value.split(/[,;\s]+/).map(tag => tag.trim()).filter(Boolean);
        const payload = await request(`/notes${vaultSuffix()}`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content, tags }) });
        if (!operation.current()) return;
        const createdTitle = payload.note?.title || title;
        controls.created({ ...payload.note, title: createdTitle, content });
        controls.status("ok", text(`Создана заметка: ${createdTitle}`, `Note created: ${createdTitle}`));
        try {
          await controls.refresh();
          if (!operation.current()) return;
          await controls.select(createdTitle);
        } catch (error) {
          if (!operation.current()) return;
          controls.status("warn", text(`Заметка сохранена: ${createdTitle}. Не удалось обновить список: ${error.message}`,
            `Note saved: ${createdTitle}. Could not refresh the list.`));
        }
      } catch (error) { if (operation.current()) throw error; }
      finally {
        if (operation.current()) { inputs.save.disabled = false; controls.editor(getState().creatingNote); }
      }
    }

    async function deleteNote() {
      const operation = bound(), title = getState().selectedNoteTitle;
      if (!operation.current() || !title || !confirm(text(
        `Переместить «${title}» в корзину? Восстановить её можно из корзины этого проекта.`,
        `Move “${title}” to trash? You can restore it from this project's trash.`))) return;
      inputs.delete.disabled = true;
      try {
        if (!await beforeDelete() || !operation.current() || getState().selectedNoteTitle !== title) return;
        const result = await request(`/note-detail/${encodeURIComponent(title)}${vaultSuffix()}`, { method: "DELETE" });
        if (!operation.current()) return;
        if (getState().selectedNoteTitle === title) controls.moved();
        let refreshed = false;
        try { await controls.refresh(); refreshed = true; } catch { /* The file is already recoverable. */ }
        if (!operation.current()) return;
        const synced = refreshed && result.deleted?.qdrant_deleted === true;
        controls.status(synced ? "ok" : "warn", synced ? text(`Заметка в корзине: ${title}`, `Note in trash: ${title}`)
          : text("Заметка в корзине. Обновление списка или поискового индекса не подтверждено.",
            "Note moved to trash. The list or search index update could not be confirmed."));
      } catch (error) { if (operation.current()) throw error; }
      finally { if (operation.current()) controls.editor(getState().creatingNote); }
    }

    async function copyNote() {
      const operation = bound(), detail = getState().selectedNoteDetail;
      if (!operation.current() || !detail) return;
      const content = detail.content || "", source = presentation?.(content).source ?? content;
      if (!source) {
        controls.status("warn", text("В выбранной заметке нет текста для копирования.", "The selected note has no text to copy.")); return;
      }
      try {
        if (!clipboard || typeof clipboard.writeText !== "function") {
          throw new Error(text("Буфер обмена недоступен.", "The clipboard is unavailable."));
        }
        await clipboard.writeText(source);
        if (operation.current()) controls.status("ok", text("Текст заметки скопирован.", "Note text copied."));
      } catch (error) {
        if (operation.current()) controls.status("error", text(`Не удалось скопировать заметку: ${error.message}`, "Could not copy the note."));
      }
    }
    return { createNote, deleteNote, copyNote };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesNoteActions = api;
})(typeof window === "undefined" ? globalThis : window);
