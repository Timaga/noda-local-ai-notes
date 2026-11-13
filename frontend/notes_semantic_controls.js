(function () {
  "use strict";
  const text = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const buttons = [document.getElementById("settings-semantic-setup"), document.getElementById("chat-semantic-setup")].filter(Boolean);
  const status = document.getElementById("settings-semantic-status");
  for (const button of buttons) button.addEventListener("click", async () => {
    for (const control of buttons) control.disabled = true;
    let message;
    try {
      const result = await window.quickNoteBridge?.setupSemanticSearch?.();
      message = result?.canceled ? "" : result?.ok
        ? text("Выбор сохранён. Модель будет подготовлена при следующем запуске Noda.", "Your choice is saved. The model will be prepared the next time Noda starts.")
        : result?.code === "busy" ? text("Дождитесь завершения текущей операции.", "Wait for the current operation to finish.")
          : text("Не удалось настроить смысловой поиск. Повторите попытку в установленной Noda.", "Could not set up semantic search. Try again in the installed Noda app.");
    } catch { message = text("Не удалось настроить смысловой поиск.", "Could not set up semantic search."); }
    finally { for (const control of buttons) control.disabled = false; }
    if (status) status.textContent = message;
    if (button.id === "chat-semantic-setup" && message) document.getElementById("chat-subtitle").textContent = message;
  });
})();
