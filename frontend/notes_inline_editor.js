(function (root) {
  "use strict";
  function create({ doc, context, drafts, request, readDetail, getProject, getVault, text, onSaved, onBusy, renderPreview, saveCopy }) {
    const article = doc.getElementById("note-view-panel"), preview = doc.getElementById("note-view-content");
    const tags = doc.getElementById("note-view-tags"), bin = doc.getElementById("delete-note-btn");
    const host = doc.createElement("div"); host.className = "inline-note";
    const translations = new Map();
    const uiText = (ru, en) => { const value = text(ru, en); translations.set(value, [ru, en]); return value; };
    host.innerHTML = `<div class="inline-note-toolbar" role="toolbar" aria-label="${uiText("Форматирование текста", "Text formatting")}">
      <label class="inline-style"><span class="sr-only">${uiText("Стиль текста", "Text style")}</span><select id="note-text-style">
        <option value="paragraph">${uiText("Обычный текст", "Normal text")}</option><option value="h1">${uiText("Заголовок 1", "Heading 1")}</option>
        <option value="h2">${uiText("Заголовок 2", "Heading 2")}</option><option value="h3">${uiText("Заголовок 3", "Heading 3")}</option></select></label>
      <span class="inline-toolbar-divider" aria-hidden="true"></span>
      <button type="button" data-format="bold" aria-label="${uiText("Полужирный", "Bold")}" title="Ctrl+B"><b>B</b></button>
      <button type="button" data-format="italic" aria-label="${uiText("Курсив", "Italic")}" title="Ctrl+I"><i>I</i></button>
      <button type="button" data-format="strike" aria-label="${uiText("Зачёркнутый", "Strikethrough")}"><s>S</s></button>
      <span class="inline-toolbar-divider" aria-hidden="true"></span>
      <button type="button" data-format="bullet" aria-label="${uiText("Маркированный список", "Bullet list")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M3 6h1M3 12h1M3 18h1"/></svg></button>
      <button type="button" data-format="numbered" aria-label="${uiText("Нумерованный список", "Numbered list")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6h10M10 12h10M10 18h10M3 4h2v5M3 9h4M3 15c0-3 4-3 4-1 0 2-4 2-4 5h4"/></svg></button>
      <button type="button" data-format="task" aria-label="${uiText("Список задач", "Task list")}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/></svg></button>
      <button type="button" data-format="code" aria-label="${uiText("Код", "Code")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/></svg></button>
      <button type="button" data-format="link" aria-label="${uiText("Ссылка", "Link")}" title="Ctrl+K"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 15 6-6m-5-2 2-2a5 5 0 0 1 7 7l-2 2m-3 3-2 2a5 5 0 0 1-7-7l2-2"/></svg></button>
      <button type="button" id="note-preview-toggle" class="inline-preview-toggle" aria-pressed="false" aria-label="${uiText("Просмотр заметки", "Preview note")}" title="${uiText("Просмотр", "Preview")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>
    <div class="inline-note-body"><label for="note-inline-content" class="sr-only">${uiText("Текст заметки", "Note text")}</label>
      <textarea id="note-inline-content" maxlength="1000000" spellcheck="true" aria-describedby="note-inline-status"></textarea><div class="inline-preview-slot"></div><section id="note-related" class="note-related" hidden></section></div>
    <footer class="inline-note-footer"><div class="inline-tags"></div><div class="inline-save-state" role="status" aria-live="polite">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span id="note-inline-status"></span>
      <button type="button" id="note-save-retry" hidden>${uiText("Повторить", "Try again")}</button>
      <button type="button" id="note-save-manual" hidden>${uiText("Сохранить", "Save")}</button>
      <button type="button" id="note-reload-latest" hidden>${uiText("Открыть актуальный файл", "Open latest file")}</button>
      <button type="button" id="note-save-copy" hidden>${uiText("Сохранить отдельно", "Save a copy")}</button></div></footer>`;
    const localized = [];
    const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, pair = translations.get(node.nodeValue);
      if (pair) localized.push(() => { node.nodeValue = text(...pair); });
    }
    for (const node of host.querySelectorAll("[aria-label], [title]")) for (const name of ["aria-label", "title"]) {
      const pair = translations.get(node.getAttribute(name));
      if (pair) localized.push(() => node.setAttribute(name, text(...pair)));
    }
    article.append(host);
    host.querySelector(".inline-preview-slot").append(preview);
    host.querySelector(".inline-tags").append(tags);
    const input = doc.getElementById("note-inline-content"), status = doc.getElementById("note-inline-status");
    const retry = doc.getElementById("note-save-retry"), copy = doc.getElementById("note-save-copy");
    const manual = doc.getElementById("note-save-manual"), reload = doc.getElementById("note-reload-latest");
    const toggle = doc.getElementById("note-preview-toggle"), style = doc.getElementById("note-text-style");
    let previewing = true, disabled = false;
    const labels = {
      saved: ["Сохранено", "Saved"], draft: ["Есть изменения", "Unsaved changes"], saving: ["Сохраняем…", "Saving…"],
      "index-pending": ["Сохранено. Поиск обновится позже.", "Saved. Search will update later."],
      readonly: ["Файл недоступен для редактирования", "This file cannot be edited"],
      error: ["Не удалось сохранить. Черновик сохранён.", "Could not save. Your draft is kept."],
      conflict: ["Файл изменён в другом месте. Ваши правки сохранены в черновике.", "The file changed elsewhere. Your draft is kept."],
    };
    function render(state) {
      if (!state) return;
      if (input.value !== state.content) {
        const start = input.selectionStart, end = input.selectionEnd, top = input.scrollTop;
        input.value = state.content; input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length)); input.scrollTop = top;
      }
      input.readOnly = disabled || state.reloading || !state.editable;
      input.hidden = previewing || !state.editable;
      preview.hidden = !previewing && state.editable;
      if (previewing && state.editable) renderPreview(state.content);
      toggle.setAttribute("aria-pressed", String(previewing));
      const toggleLabel = previewing ? text("Редактировать", "Edit") : text("Просмотр заметки", "Preview note");
      toggle.setAttribute("aria-label", toggleLabel); toggle.title = toggleLabel;
      host.dataset.state = state.status;
      const label = (state.reloading ? text("Загружаем актуальную версию…", "Loading latest version…")
        : state.reloadError ? text("Не удалось перечитать файл. Черновик сохранён.", "Could not reload the file. Your draft is kept.")
        : text(...labels[state.status])) + (!state.autoSaveEnabled && state.dirty ? " " + text("Автосохранение выключено.", "Autosave is off.") : "") + (state.dirty && !state.durable
        ? " " + text("Черновик только в этом окне. Сохраните правки отдельно.", "Draft only in this window. Save a copy.") : "");
      if (status.textContent !== label) status.textContent = label;
      retry.hidden = state.status !== "error";
      manual.hidden = state.autoSaveEnabled || !state.editable || state.blocked;
      manual.disabled = disabled || state.busy || !state.dirty;
      reload.hidden = !state.blocked;
      reload.disabled = disabled || state.busy;
      copy.hidden = !["error", "conflict"].includes(state.status);
      retry.disabled = copy.disabled = disabled || state.busy;
      bin.disabled = disabled || state.busy || !state.title;
      for (const button of host.querySelectorAll("[data-format], select")) button.disabled = disabled || state.reloading || !state.editable || previewing;
      toggle.disabled = state.reloading || !state.editable;
    }
    const session = root.NotesEditorSession.create({ context, drafts, request, readDetail, getProject, getVault, onSaved, onBusy, onChange: render });
    session.configure(root.NodaPreferences?.get?.() || {});
    root.addEventListener("noda-preferences:changed", event => session.configure(event.detail || root.NodaPreferences?.get?.() || {}));
    const change = () => session.input(input.value);
    function insert(result) {
      input.focus(); input.select();
      // insertText keeps the native undo stack in the pinned Electron editor.
      if (!doc.execCommand("insertText", false, result.value)) input.value = result.value;
      input.setSelectionRange(result.start, result.end); change();
    }
    function linkDialog() {
      const before = input.value, start = input.selectionStart, end = input.selectionEnd, owner = session.getState();
      if (!owner || doc.getElementById("note-link-dialog")) return;
      const dialog = doc.createElement("dialog"); dialog.id = "note-link-dialog"; dialog.className = "note-link-dialog";
      dialog.setAttribute("aria-labelledby", "note-link-title");
      const form = doc.createElement("form"), title = doc.createElement("h2"), label = doc.createElement("label");
      form.noValidate = true;
      title.id = "note-link-title"; title.textContent = text("Вставить ссылку", "Insert link");
      label.htmlFor = "note-link-address"; label.textContent = text("Адрес ссылки", "Link address");
      const url = doc.createElement("input"); url.id = "note-link-address"; url.type = "url";
      url.placeholder = "https://"; url.maxLength = 2048; url.required = true; url.autocomplete = "off";
      const error = doc.createElement("p"); error.id = "note-link-error"; error.setAttribute("role", "alert");
      url.setAttribute("aria-describedby", error.id);
      const actions = doc.createElement("div"), cancel = doc.createElement("button"), submit = doc.createElement("button");
      actions.className = "note-link-actions"; cancel.type = "button"; submit.type = "submit";
      cancel.textContent = text("Отмена", "Cancel"); submit.textContent = title.textContent;
      actions.append(cancel, submit); form.append(title, label, url, error, actions); dialog.append(form); doc.body.append(dialog);
      cancel.addEventListener("click", () => dialog.close());
      dialog.addEventListener("close", () => { dialog.remove(); if (session.getState()?.title === owner.title && session.getState()?.project === owner.project) input.focus(); }, { once: true });
      form.addEventListener("submit", event => {
        event.preventDefault();
        const current = session.getState();
        if (!context.isCurrent(owner.bound) || current?.title !== owner.title || current?.project !== owner.project || input.value !== before) {
          error.textContent = text("Заметка изменилась, пока был открыт диалог. Откройте его заново.", "This note changed while the link dialog was open. Open it again."); return;
        }
        const result = root.NotesEditorCommands.insertLink(before, start, end, url.value.trim());
        if (!result) { error.textContent = text("Введите адрес http, https или mailto.", "Enter an http, https or mailto address."); url.focus(); return; }
        dialog.close(); insert(result);
      });
      dialog.showModal(); url.focus();
    }
    function command(name) {
      if (input.readOnly || previewing) return;
      if (name === "link") { linkDialog(); return; }
      const result = root.NotesEditorCommands.format(input.value, input.selectionStart, input.selectionEnd, name);
      insert(result);
    }
    input.addEventListener("input", change);
    input.addEventListener("compositionstart", () => session.composition(true));
    input.addEventListener("compositionend", () => { change(); session.composition(false); });
    input.addEventListener("blur", () => { if (!disabled) void session.autoSave(); });
    input.addEventListener("keydown", event => {
      const action = root.NotesEditorCommands.shortcut(event);
      if (!action) return;
      event.preventDefault(); if (action === "save") void session.retry(); else command(action);
    });
    for (const button of host.querySelectorAll("[data-format]")) {
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => command(button.dataset.format));
    }
    style.addEventListener("change", () => { command(style.value); style.value = "paragraph"; });
    toggle.addEventListener("click", () => {
      previewing = !previewing; toggle.setAttribute("aria-pressed", String(previewing));
      render(session.getState()); if (!previewing) input.focus();
    });
    retry.addEventListener("click", () => void session.retry());
    manual.addEventListener("click", () => void session.retry());
    reload.addEventListener("click", () => {
      if (root.confirm(text("Отбросить ваши правки и открыть актуальный файл с диска? Локальный черновик будет удалён только после загрузки файла.",
        "Discard your changes and open the latest file from disk? Your local draft will be removed only after the file is loaded."))) void session.reloadFromDisk();
    });
    copy.addEventListener("click", () => saveCopy(session.getState()));
    return { ...session,
      refreshLanguage() { localized.forEach(update => update()); if (session.getState()) render(session.getState()); },
      open(title, detail) { const changed = session.getState()?.title !== title || session.getState()?.project !== getProject();
        if (changed) {
        previewing = true;
      } session.open(title, detail);
        if (changed) { input.setSelectionRange(0, 0); input.scrollTop = 0; preview.scrollTop = 0; }
      },
      setDisabled(value) { disabled = value; if (session.getState()) render(session.getState()); },
      focus() { if (input.hidden) { preview.tabIndex = -1; preview.focus(); } else input.focus(); }, inputElement: input,
    };
  }
  root.NotesInlineEditor = { create };
})(window);
