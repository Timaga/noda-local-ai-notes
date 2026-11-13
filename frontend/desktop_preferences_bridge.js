"use strict";

function broadcastPreferences(windows, preferences) {
  for (const window of windows) {
    try {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed?.()) {
        window.webContents.send("quick-note:preferences-changed", preferences);
      }
    } catch { /* A closing renderer cannot roll back durable settings. */ }
  }
}

function registerPreferencesBridge({ ipcMain, allowed, getPreferences, restart, scheduleSearch,
  busy, confirmRestart, flushDrafts, app, deny, dialog, uiText, appName }) {
  const confirmation = confirmRestart || (async () => (await dialog.showMessageBox({
    type: "question", title: appName,
    message: uiText("Перезапустить Noda?", "Restart Noda?"),
    detail: uiText("Черновики будут сохранены. Незавершённый ответ чата будет прерван.",
      "Drafts will be saved. An unfinished chat response will be interrupted."),
    buttons: [uiText("Перезапустить", "Restart"), uiText("Отмена", "Cancel")],
    defaultId: 0, cancelId: 1, noLink: true,
  })).response === 0);
  ipcMain.handle("quick-note:get-preferences", event => allowed(event) ? getPreferences() : deny());
  ipcMain.handle("quick-note:setup-semantic-search", async event => {
    if (!allowed(event)) return deny();
    if (busy()) return { ok: false, code: "busy" };
    return scheduleSearch ? await scheduleSearch() : { ok: false, code: "unavailable" };
  });
  ipcMain.handle("quick-note:restart-for-settings", async event => {
    if (!allowed(event)) return deny();
    if (busy()) return { ok: false, code: "busy" };
    if (!await confirmation()) return { ok: false, canceled: true };
    if (busy()) return { ok: false, code: "busy" };
    await flushDrafts();
    app.relaunch(); restart();
    return { ok: true };
  });
}
module.exports = { registerPreferencesBridge, broadcastPreferences };
