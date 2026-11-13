"use strict";

function ensureTray(options) {
  const {
    Tray, Menu, createTrayIcon, appName, uiText, isReady, showStartupWindow,
    showQuickWindow, showNotesWindow, toggleQuickWindow, ensureBackendReady,
    requestAppQuit, onBackendError, installSemanticSearch,
  } = options;

  function whenReady(action) {
    if (!isReady()) {
      showStartupWindow();
      return;
    }
    return action();
  }

  let tray = options.tray;
  if (!tray) {
    tray = new Tray(createTrayIcon());
    tray.on("click", () => whenReady(toggleQuickWindow));
  }
  tray.setToolTip(appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: uiText("Быстрая заметка…", "Quick note…"),
      click: () => whenReady(showQuickWindow),
    },
    {
      label: uiText("Панель заметок", "Notes panel"),
      click: () => whenReady(showNotesWindow),
    },
    {
      label: uiText("Запустить локальные службы", "Start local services"),
      click: () => whenReady(async () => {
        try {
          await ensureBackendReady();
        } catch (error) {
          onBackendError(error);
        }
      }),
    },
    ...(installSemanticSearch ? [{
      label: uiText("Настроить смысловой поиск…", "Set up semantic search…"),
      click: () => whenReady(installSemanticSearch),
    }] : []),
    { type: "separator" },
    { label: uiText("Выход", "Quit"), click: requestAppQuit },
  ]));
  return tray;
}

module.exports = { ensureTray };
