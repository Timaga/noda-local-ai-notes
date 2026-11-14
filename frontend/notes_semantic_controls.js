(function () {
  "use strict";
  const text = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const buttons = [document.getElementById("settings-semantic-setup"), document.getElementById("chat-semantic-setup")].filter(Boolean);
  const status = document.getElementById("settings-semantic-status");
  const section = document.getElementById("settings-semantic-section");
  const context = window.NodaProjectContext;
  let working = false, needsSetup = false, disposed = false;
  function update(snapshot = {}) {
    needsSetup = ["disabled", "unavailable"].includes(snapshot?.embedding_status);
    if (section) {
      const restoreFocus = !needsSetup && section.contains(document.activeElement);
      section.hidden = !needsSetup;
      if (restoreFocus) document.getElementById("notes-settings-tab")?.focus();
    }
    if (!needsSetup && status) status.textContent = "";
  }
  window.notesSemanticControls = { update };
  const unsubscribe = context?.subscribe(snapshot => { if (snapshot.status !== "ready") update(); });
  window.addEventListener("beforeunload", () => { disposed = true; unsubscribe?.(); }, { once: true });
  for (const button of buttons) button.addEventListener("click", async () => {
    if (disposed || working || !needsSetup || button.hidden || (button.id === "settings-semantic-setup" && section?.hidden)) return;
    const owner = context?.snapshot();
    working = true;
    for (const control of buttons) control.disabled = true;
    let message = "";
    try {
      const result = await window.quickNoteBridge?.setupSemanticSearch?.();
      if (disposed || !needsSetup || (owner && !context.isCurrent(owner))) return;
      message = result?.canceled ? "" : result?.ok
        ? text("Выбор сохранён. Модель будет подготовлена при следующем запуске Noda.", "Your choice is saved. The model will be prepared the next time Noda starts.")
        : result?.code === "busy" ? text("Дождитесь завершения текущей операции.", "Wait for the current operation to finish.")
          : text("Не удалось настроить смысловой поиск. Повторите попытку в установленной Noda.", "Could not set up semantic search. Try again in the installed Noda app.");
    } catch {
      if (disposed || !needsSetup || (owner && !context.isCurrent(owner))) return;
      message = text("Не удалось настроить смысловой поиск.", "Could not set up semantic search.");
    }
    finally { working = false; for (const control of buttons) control.disabled = false; }
    if (status && !section?.hidden) status.textContent = message;
    if (button.id === "chat-semantic-setup" && message) document.getElementById("chat-subtitle").textContent = message;
  });
})();
