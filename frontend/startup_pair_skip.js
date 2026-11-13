(() => {
  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const dialog = document.getElementById("startup-pair-skip-dialog");
  const heading = document.getElementById("startup-pair-skip-heading");
  const warning = document.getElementById("startup-pair-skip-warning");
  const descriptions = {
    title: [
      "Генерация заголовков будет выключена. Noda возьмёт до 28 символов из начала заметки.",
      "Title generation will be turned off. Noda will use up to 28 characters from the start of the note.",
    ],
    tags: [
      "Обработка тегов будет выключена: Noda не будет подбирать готовые теги или создавать новые.",
      "Tag processing will be turned off. Noda will neither select existing tags nor create new ones.",
    ],
    links: [
      "Поиск связей будет выключен. Noda не будет автоматически связывать новые заметки с другими.",
      "Note linking will be turned off. Noda will not automatically link new notes to other notes.",
    ],
  };
  let onConfirm = null;

  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    const confirm = event.submitter?.value === "skip" ? onConfirm : null;
    reset();
    confirm?.();
  });
  dialog.addEventListener("cancel", () => {
    onConfirm = null;
  });

  function ask(stage, confirm) {
    if (dialog.open) return;
    heading.textContent = t("Пропустить этап?", "Skip this stage?");
    warning.textContent = `${t(...descriptions[stage])} ${t(
      "Этап можно включить позже в настройках.", "You can turn this stage on later in Settings."
    )}`;
    onConfirm = confirm;
    dialog.showModal();
  }

  function reset() {
    onConfirm = null;
    if (dialog.open) dialog.close();
  }

  window.startupPairSkip = { ask, reset };
})();
