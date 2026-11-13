(() => {
  const t = (ru, en) => window.nodaI18n.t(ru, en);
  const popup = document.getElementById("startup-note-download");
  const model = document.getElementById("startup-note-download-model");
  const progress = document.getElementById("startup-note-download-progress");
  const size = document.getElementById("startup-note-download-size");
  const percent = document.getElementById("startup-note-download-percent");
  const cancel = document.getElementById("startup-note-download-cancel");
  const errors = {
    network: ["Не удалось скачать модель. Проверьте подключение и повторите попытку.", "Could not download a model. Check your connection and try again."],
    space: ["Недостаточно места для выбранных моделей. Освободите место и повторите попытку.", "There is not enough space for the selected models. Free up space and try again."],
    disabled: ["Скачивание моделей отключено. Можно пропустить этот этап.", "Model downloads are disabled. You can skip this stage."],
    integrity: ["Не прошла проверка файла модели. Повторите скачивание.", "A model file failed verification. Try downloading it again."],
    storage: ["Не удалось записать файл модели. Проверьте доступ к папке приложения.", "Could not write a model file. Check access to the application folder."],
    busy: ["Модели уже скачиваются в другом окне Noda. Повторите попытку позже.", "Another Noda window is downloading models. Try again later."],
    configuration: ["Не удалось подготовить выбранные модели. Повторите попытку или пропустите этап.", "Could not prepare the selected models. Try again or skip the stage."],
    canceled: ["Загрузка остановлена. Выбор моделей сохранён на экране.", "Download stopped. Your model selection is still on screen."],
  };

  function errorMessage(code) {
    return t(...(Object.hasOwn(errors, code) ? errors[code] : errors.configuration));
  }

  function render(download) {
    const wasHidden = popup.hidden;
    popup.hidden = !download;
    if (!download) {
      cancel.disabled = false;
      return;
    }
    cancel.hidden = download.cancellable !== true || download.bytes >= download.total
      || typeof window.quickNoteBridge?.cancelModelDownload !== "function";
    if (wasHidden && !cancel.hidden) cancel.focus();
    if (model.textContent !== download.model) model.textContent = download.model;
    const ratio = download.bytes / download.total;
    progress.value = ratio * 100;
    const format = new Intl.NumberFormat(window.nodaI18n.locale(), { maximumFractionDigits: 1 });
    const unit = download.total >= 1e9 ? [1e9, t("ГБ", "GB")] : [1e6, t("МБ", "MB")];
    size.textContent = `${format.format(download.bytes / unit[0])} / ${format.format(download.total / unit[0])} ${unit[1]}`;
    percent.textContent = `${Math.floor(ratio * 100)}%`;
  }

  cancel.addEventListener("click", async () => {
    cancel.disabled = true;
    const result = await window.quickNoteBridge.cancelModelDownload().catch(() => null);
    if (result?.ok !== true) cancel.disabled = false;
  });

  window.startupNoteDownload = { render, errorMessage };
})();
