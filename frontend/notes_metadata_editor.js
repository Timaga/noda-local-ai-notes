(function (root) {
  "use strict";
  const failure = code => Object.assign(new Error(code), { code });
  function parseTags(raw) {
    const tags = String(raw).split(/[,;\s]+/u).filter(Boolean).map(tag => tag.replace(/^#/, "").normalize("NFC"));
    if (tags.length > 20 || new Set(tags.map(tag => tag.toLowerCase())).size !== tags.length
        || tags.some(tag => Array.from(tag).length > 64 || !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag) || !/\p{L}/u.test(tag))) {
      throw failure("invalid_tags");
    }
    return tags;
  }
  async function save({ context, bound, title, vault, detail, metadata, request, readDetail }) {
    if (!context.isCurrent(bound)) throw failure("project_changed");
    const path = `/note-detail/${encodeURIComponent(title)}${vault ? `?expected_vault_id=${encodeURIComponent(vault)}` : ""}`;
    const result = await request(path, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: detail.edit_revision, metadata }) });
    if (!context.isCurrent(bound)) throw failure("project_changed");
    let fresh = null;
    try { fresh = await readDetail(title, vault); } catch { /* The write is already committed. */ }
    if (!context.isCurrent(bound)) throw failure("project_changed");
    return { title, result, detail: fresh };
  }
  function create({ doc, text, context, getTitle, getDetail, getVault, request, readDetail,
    prepare = async () => true, onSaved = () => {}, onError = () => {}, setBusy = () => {} }) {
    const header = doc.querySelector("#note-view-panel .note-view-header"), menu = header.querySelector(".note-actions-menu");
    const button = doc.createElement("button"); button.type = "button"; button.className = "note-metadata-edit";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg>';
    header.classList.add("has-metadata-editor"); header.insertBefore(button, menu);
    const dialog = doc.createElement("dialog"); dialog.className = "note-metadata-dialog";
    dialog.setAttribute("aria-labelledby", "note-metadata-heading");
    const form = doc.createElement("form");
    const add = (tag, className, parent = form) => { const node = doc.createElement(tag); node.className = className; parent.append(node); return node; };
    const heading = add("h2", ""); heading.id = "note-metadata-heading";
    const titleLabel = add("label", "note-metadata-field"), titleText = add("span", "", titleLabel), titleInput = add("input", "", titleLabel);
    titleInput.type = "text"; titleInput.maxLength = 320; titleInput.required = true;
    const tagsLabel = add("label", "note-metadata-field"), tagsText = add("span", "", tagsLabel), tagsInput = add("input", "", tagsLabel);
    tagsInput.type = "text"; tagsInput.maxLength = 2000;
    const hint = add("p", "note-metadata-hint"), status = add("p", "note-metadata-status");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const actions = add("div", "note-metadata-actions"), cancel = add("button", "", actions), submit = add("button", "note-metadata-save", actions);
    cancel.type = "button"; submit.type = "submit"; dialog.append(form); doc.body.append(dialog);
    let operation = null, working = false, opening = false;
    function refreshLanguage() {
      button.title = text("Изменить заголовок и теги", "Edit title and tags"); button.setAttribute("aria-label", button.title);
      heading.textContent = text("Свойства заметки", "Note properties");
      titleText.textContent = text("Заголовок заметки", "Note title"); tagsText.textContent = text("Теги через запятую", "Tags separated by commas");
      hint.textContent = text("Имя файла и существующие ссылки сохраняются.", "The filename and existing links stay unchanged.") + " "
        + text("Теги внутри текста не меняются.", "Tags written in the note text are kept.");
      cancel.textContent = text("Отмена", "Cancel"); submit.textContent = text("Сохранить", "Save");
    }
    function refresh() {
      refreshLanguage(); button.disabled = working || opening || !getTitle() || !getDetail()?.edit_revision;
    }
    function close() { if (!working && dialog.open) dialog.close(); }
    async function open() {
      if (working || opening || !getDetail()?.edit_revision) return;
      const bound = context.snapshot(), title = getTitle(), vault = getVault();
      opening = true; refresh();
      try {
        if (!await prepare()) throw failure("unsaved_body");
        if (!context.isCurrent(bound) || title !== getTitle()) throw failure("project_changed");
        setBusy(true);
        const detail = await readDetail(title, vault);
        if (!context.isCurrent(bound) || title !== getTitle()) throw failure("project_changed");
        operation = { bound, title, vault, detail };
        titleInput.value = detail.display_title || detail.generated_title || title;
        tagsInput.value = (detail.tags || []).join(", "); status.textContent = "";
        dialog.showModal(); titleInput.focus(); titleInput.select();
      } catch (error) {
        setBusy(false);
        onError(error.code === "unsaved_body" ? text("Сохраните текст заметки перед изменением заголовка и тегов.",
          "Save the note text before changing its title or tags.") : text("Не удалось открыть свойства заметки.", "Could not open note properties."));
      } finally { opening = false; refresh(); }
    }
    button.addEventListener("click", () => void open()); cancel.addEventListener("click", close);
    dialog.addEventListener("cancel", event => { if (working) event.preventDefault(); });
    dialog.addEventListener("close", () => { operation = null; setBusy(false); refresh(); });
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (working || !operation) return;
      let metadata;
      try {
        const title = titleInput.value.normalize("NFC").trim();
        if (!title || Array.from(title).length > 160 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(title)) throw failure("invalid_title");
        metadata = { title, tags: parseTags(tagsInput.value) };
      } catch (error) {
        status.textContent = error.code === "invalid_title" ? text("Введите заголовок от 1 до 160 символов.", "Enter a title (1–160 characters).")
          : text("Укажите до 20 разных тегов: буквы, цифры, подчёркивания, дефисы и слеши.", "Use up to 20 unique tags with letters, numbers, underscores, hyphens or slashes.");
        return;
      }
      const captured = operation; working = true;
      titleInput.disabled = tagsInput.disabled = submit.disabled = cancel.disabled = true; refresh();
      try {
        const saved = await save({ context, ...captured, metadata, request, readDetail });
        if (operation !== captured) return;
        dialog.close(); onSaved(saved);
        if (!saved.detail) onError(text("Свойства сохранены. Обновите заметку, чтобы увидеть изменения.", "Note properties saved. Refresh the note to see the changes."));
      } catch (error) {
        status.textContent = error.code === "note_edit_conflict"
          ? text("Файл изменён в другом месте. Закройте это окно и откройте заметку заново.", "The file changed elsewhere. Close this dialog and reopen the note.")
          : error.code === "project_changed" ? text("Проект изменился. Откройте заметку заново.", "The project changed. Reopen the note.")
            : text("Не удалось сохранить свойства заметки.", "Could not save note properties.");
      } finally { working = false; titleInput.disabled = tagsInput.disabled = submit.disabled = cancel.disabled = false; refresh(); }
    });
    refresh();
    return { open, close, refresh, refreshLanguage, dispose() { close(); button.remove(); dialog.remove(); } };
  }
  const api = { create, parseTags, save };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesMetadataEditor = api;
})(typeof window === "undefined" ? globalThis : window);
