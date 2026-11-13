(function (root) {
  "use strict";
  function create({ doc, text, isDirty, onStatus, onWorking }) {
    const { normalizePreferences } = root.NotesDesktopPreferences;
    const byId = id => doc.getElementById(id);
    const fields = {
      quickNoteHotkey: byId("settings-quick-hotkey"), editorFontSize: byId("settings-editor-font-size"),
      interfaceDensity: byId("settings-interface-density"), editorAutoSave: byId("settings-editor-autosave"),
      editorAutoSaveDelayMs: byId("settings-editor-autosave-delay"),
    };
    const restart = byId("settings-language-restart"), restartNote = byId("settings-language-restart-note");
    const messages = {
      quickNoteHotkey: ["Введите сочетание Ctrl, Alt или Meta и одной клавиши.", "Enter a keyboard shortcut with Ctrl, Alt, or Meta and one key."],
      editorFontSize: ["Выберите размер шрифта от 14 до 24.", "Choose a font size from 14 to 24."],
      interfaceDensity: ["Выберите плотность из списка.", "Choose a density option from the list."],
      editorAutoSave: ["Автосохранение должно быть включено или выключено.", "Autosave must be enabled or disabled."],
      editorAutoSaveDelayMs: ["Выберите паузу автосохранения от 500 до 10000 миллисекунд.", "Choose an autosave delay from 500 to 10000 milliseconds."],
    };
    let working = false, savedSettings = null;
    function read() {
      return { quickNoteHotkey: fields.quickNoteHotkey.value, editorFontSize: Number(fields.editorFontSize.value),
        interfaceDensity: fields.interfaceDensity.value, editorAutoSave: fields.editorAutoSave.checked,
        editorAutoSaveDelayMs: Number(fields.editorAutoSaveDelayMs.value) };
    }
    function preview() {
      try {
        const values = normalizePreferences(read());
        root.NodaPreferences?.preview({ editorFontSize: values.editorFontSize, interfaceDensity: values.interfaceDensity });
      } catch { /* Incomplete form values do not change the current preview. */ }
    }
    function updateRestart(settings = savedSettings) {
      savedSettings = settings;
      const needsRestart = settings?.language && settings.language !== root.nodaI18n.getLanguage();
      const dirty = needsRestart && isDirty();
      restart.hidden = !needsRestart; restart.disabled = working || dirty;
      restartNote.hidden = !dirty;
      restartNote.textContent = text("Сохраните изменения перед перезапуском.", "Save your changes before restarting.");
    }
    function setDisabled(value) {
      working = value;
      for (const field of Object.values(fields)) field.disabled = working;
      fields.editorAutoSaveDelayMs.disabled = working || !fields.editorAutoSave.checked;
      updateRestart();
    }
    function render(settings) {
      const values = normalizePreferences(settings || {});
      for (const [key, field] of Object.entries(fields)) {
        if (key === "editorAutoSave") field.checked = values[key];
        else field.value = String(values[key]);
      }
      fields.editorAutoSaveDelayMs.disabled = working || !values.editorAutoSave;
      preview();
    }
    function validate() {
      for (const field of Object.values(fields)) field.setCustomValidity?.("");
      try { return normalizePreferences(read()); }
      catch (error) {
        const key = Object.hasOwn(messages, error.code) ? error.code : "quickNoteHotkey";
        const message = text(...messages[key]); fields[key].setCustomValidity?.(message);
        fields[key].reportValidity?.(); fields[key].focus(); throw new Error(message);
      }
    }
    function restoreDraft(draft) {
      const bindings = { notesDirectory: "settings-notes-path", language: "settings-language", skipModelSelection: "settings-skip-model",
        skipNotesDirectorySelection: "settings-skip-path", skipTurboQuantSelection: "settings-skip-turboquant", turboquantEnabled: "settings-turboquant-enabled" };
      for (const [key, id] of Object.entries(bindings)) {
        if (typeof draft[key] === "boolean") byId(id).checked = draft[key];
        else if (draft[key] !== undefined) byId(id).value = draft[key];
      }
      for (const field of doc.querySelectorAll('input[name="settings-theme"]')) field.checked = field.value === draft.theme;
      if (draft.theme) doc.documentElement.dataset.theme = draft.theme;
      root.notesSettingsNotePairs.renderStartup(draft); render(draft); updateRestart();
    }
    for (const field of Object.values(fields)) for (const event of ["input", "change"]) field.addEventListener(event, () => {
      field.setCustomValidity?.(""); fields.editorAutoSaveDelayMs.disabled = working || !fields.editorAutoSave.checked; preview(); updateRestart();
    });
    byId("notes-tab-settings").addEventListener("change", () => updateRestart());
    restart.addEventListener("click", async () => {
      if (working || restart.hidden || isDirty()) return;
      onWorking(true);
      try {
        const result = await root.quickNoteBridge.restartAppForSettings?.();
        if (result?.canceled) return;
        if (result?.ok !== true) throw new Error("restart_failed");
      } catch {
        onStatus(text("Не удалось перезапустить Noda. Выберите «Выход» в трее и откройте приложение снова.",
          "Could not restart Noda. Close Noda using Quit in the tray, then open it again."), "error");
      } finally { onWorking(false); }
    });
    return { read, render, validate, restoreDraft, setDisabled, updateRestart };
  }
  root.NotesSettingsPreferences = { create };
})(window);
