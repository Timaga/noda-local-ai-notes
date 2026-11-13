// Who: Tim Buglaev
// When: 2026-06-30
// What: Drive the optional startup vault selector through narrow preload commands;
//       paths originate only from Electron's native dialog and render via textContent.
(function () {
  "use strict";

  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const isEnglish = () => window.nodaI18n?.isEnglish() === true;

  const root = document.getElementById("startup-notes-directory");
  const pathLabel = document.getElementById("startup-directory-path");
  const chooseButton = document.getElementById("startup-directory-choose");
  const nextButton = document.getElementById("startup-directory-next");
  const statusLabel = document.getElementById("startup-directory-status");

  let selectedDirectory = "";
  let working = false;

  function setStatus(message, error = false) {
    statusLabel.textContent = String(message || "");
    statusLabel.classList.toggle("error", error);
  }

  function renderSelection() {
    const hasSelection = Boolean(selectedDirectory);
    pathLabel.textContent = hasSelection ? selectedDirectory : t("Папка не выбрана", "No folder selected");
    pathLabel.title = hasSelection ? selectedDirectory : "";
    pathLabel.classList.toggle("selected", hasSelection);
    chooseButton.disabled = working;
    nextButton.disabled = working || !hasSelection;
  }

  async function chooseDirectory() {
    if (working || !window.quickNoteBridge?.chooseStartupNotesDirectory) {
      return;
    }
    working = true;
    setStatus(t("Открываем выбор папки...", "Opening the folder picker…"));
    renderSelection();
    try {
      const result = await window.quickNoteBridge.chooseStartupNotesDirectory();
      if (!result?.ok) {
        throw new Error(result?.error || t("Не удалось открыть выбор папки.", "Could not open the folder picker."));
      }
      if (result.canceled) {
        setStatus(t("Выбор отменён. Укажите папку, чтобы продолжить.", "Selection canceled. Choose a folder to continue."));
        return;
      }
      if (typeof result.notesDirectory !== "string" || !result.notesDirectory.trim()) {
        throw new Error(t("Приложение не вернуло выбранную папку.", "Noda could not read the selected folder."));
      }
      selectedDirectory = result.notesDirectory.trim();
      setStatus(t("Папка выбрана. Можно продолжить.", "Folder selected. You can continue."));
    } catch (error) {
      setStatus(isEnglish() ? t("Не удалось выбрать папку.", "Could not choose the folder. Try again.")
        : error?.message || "Не удалось выбрать папку.", true);
    } finally {
      working = false;
      renderSelection();
    }
  }

  async function confirmDirectory() {
    if (working || !selectedDirectory || !window.quickNoteBridge?.confirmStartupNotesDirectory) {
      return;
    }
    working = true;
    setStatus(t("Сохраняем путь и готовим индекс...", "Saving the folder and preparing the index…"));
    renderSelection();
    try {
      const result = await window.quickNoteBridge.confirmStartupNotesDirectory();
      if (!result?.ok) {
        throw new Error(result?.error || t("Не удалось подтвердить папку.", "Could not confirm the folder."));
      }
    } catch (error) {
      working = false;
      setStatus(isEnglish() ? t("Не удалось подтвердить папку.", "Could not confirm the folder. Try again.")
        : error?.message || "Не удалось подтвердить папку.", true);
      renderSelection();
    }
  }

  function render(status = {}) {
    const visible = status.phase === "notes-directory-select";
    root.hidden = !visible;
    if (visible) {
      renderSelection();
    }
  }

  chooseButton.addEventListener("click", () => {
    chooseDirectory().catch(() => {});
  });
  nextButton.addEventListener("click", () => {
    confirmDirectory().catch(() => {});
  });

  window.startupNotesDirectory = { render };
  renderSelection();
})();
