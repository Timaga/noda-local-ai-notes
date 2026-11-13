(() => {
  "use strict";

  const t = (ru, en) => window.nodaI18n.t(ru, en);
  const errors = {
    import_url: ["Вставьте ссылку на huggingface.co.", "Enter a huggingface.co link."],
    import_access: ["Нужна публичная модель без запроса доступа.", "Choose a public model that does not require access."],
    import_unsupported: ["Для импорта нужна совместимая модель в формате GGUF.", "Import requires a compatible GGUF model."],
    import_choose_file: ["В репозитории несколько вариантов. Вставьте ссылку на нужный файл GGUF.", "This repository has several variants. Paste a link to the GGUF file you want."],
    import_incomplete: ["В репозитории отсутствуют части модели.", "Some model parts are missing from the repository."],
    import_changed: ["Модель изменилась. Проверьте ссылку заново.", "The model changed. Check the link again."],
    network: ["Не удалось связаться с Hugging Face. Проверьте подключение.", "Could not reach Hugging Face. Check your connection."],
    integrity: ["Файлы модели не прошли проверку целостности.", "The model files failed the integrity check."],
    space: ["Для модели не хватает места на диске.", "There is not enough disk space for this model."],
    busy: ["Уже идёт другая загрузка. Повторите попытку позже.", "Another download is in progress. Try again later."],
    disabled: ["Скачивание моделей отключено в этой конфигурации.", "Model downloads are disabled in this configuration."],
    canceled: ["Загрузка остановлена. Можно повторить попытку.", "Download stopped. You can try again."],
  };

  function open(trigger, { hardware, preview, download, subscribe, cancelDownload }) {
    return new Promise(resolve => {
      const dialog = document.createElement("dialog");
      dialog.className = "settings-hf-dialog";
      dialog.setAttribute("aria-labelledby", "settings-hf-title");
      const form = document.createElement("form");
      const add = (tag, text, parent = form) => {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        parent.append(node);
        return node;
      };
      add("h2", t("Модель из Hugging Face", "Model from Hugging Face")).id = "settings-hf-title";
      add("p", t("Вставьте ссылку на публичный репозиторий или файл GGUF.", "Paste a link to a public repository or GGUF file.")).className = "settings-picker-muted";
      add("label", t("Ссылка на модель", "Model link")).htmlFor = "settings-hf-url";
      const input = add("input");
      input.id = "settings-hf-url";
      input.type = "url";
      input.required = true;
      input.maxLength = 1800;
      input.placeholder = "https://huggingface.co/…";
      const result = add("section");
      result.className = "settings-hf-result";
      result.hidden = true;
      const status = add("p");
      status.setAttribute("role", "status");
      const progress = add("progress");
      progress.max = 100;
      progress.hidden = true;
      progress.setAttribute("aria-label", t("Загрузка модели", "Model download"));
      const actions = add("div");
      actions.className = "settings-hf-actions";
      const cancel = add("button", t("Закрыть", "Close"), actions);
      cancel.type = "button";
      cancel.className = "settings-picker-cancel";
      const submit = add("button", "", actions);
      submit.type = "submit";
      submit.className = "settings-picker-choose";
      let inspected, imported, busy = false;
      let downloading = false, stopping = false;
      const fitsOnDisk = () => inspected
        && (!Number.isSafeInteger(inspected.disk_free_bytes) || inspected.download_bytes <= inspected.disk_free_bytes);
      const setLabel = () => {
        submit.textContent = fitsOnDisk()
          ? inspected.download_bytes > 0 ? t("Скачать модель", "Download model") : t("Добавить в каталог", "Add to catalog")
          : t("Проверить ссылку", "Check link");
      };
      const syncCancel = () => {
        const canStop = downloading && typeof cancelDownload === "function";
        cancel.disabled = busy && (!canStop || stopping);
        cancel.textContent = canStop ? t("Остановить загрузку", "Stop download") : t("Закрыть", "Close");
      };
      const onProgress = event => {
        if (!busy || !fitsOnDisk()) return;
        if (event?.state === "testing") {
          downloading = false;
          syncCancel();
          progress.removeAttribute("value");
          status.textContent = t("Проверяем файлы…", "Checking files…");
          return;
        }
        if (event?.state !== "downloading" || stopping) return;
        downloading = event.bytes < event.total;
        syncCancel();
        const percent = Math.floor(event.bytes / event.total * 100);
        progress.hidden = false;
        progress.value = percent;
        status.textContent = t(`Скачиваем модель · ${percent}%`, `Downloading model · ${percent}%`);
      };
      const unsubscribe = subscribe(onProgress);
      dialog.addEventListener("close", () => {
        unsubscribe();
        dialog.remove();
        trigger.focus();
        resolve(imported);
      }, { once: true });
      async function stopOrClose() {
        if (!busy) {
          dialog.close();
        } else if (downloading && !stopping && cancelDownload) {
          stopping = true;
          syncCancel();
          status.textContent = t("Останавливаем загрузку…", "Stopping download…");
          const result = await cancelDownload().catch(() => null);
          if (busy && result?.ok !== true) {
            stopping = false;
            syncCancel();
          }
        }
      }
      dialog.addEventListener("cancel", event => {
        if (busy) {
          event.preventDefault();
          stopOrClose();
        }
      });
      cancel.addEventListener("click", stopOrClose);
      input.addEventListener("input", () => {
        inspected = undefined;
        result.hidden = true;
        status.textContent = "";
        setLabel();
      });
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy) return;
        const confirmed = fitsOnDisk();
        busy = input.disabled = submit.disabled = true;
        syncCancel();
        status.className = "";
        try {
          status.textContent = confirmed ? t("Готовим файлы…", "Preparing files…") : t("Проверяем модель…", "Checking model…");
          const response = confirmed
            ? await download({ url: inspected.url, id: inspected.model.id })
            : await preview({ url: input.value.trim() });
          if (!response?.ok) {
            const code = response?.code;
            if (code === "import_changed" || code === "space") {
              inspected = undefined;
              result.hidden = true;
              setLabel();
            }
            throw new Error(Object.hasOwn(errors, code) ? t(...errors[code]) : t("Не удалось подготовить модель.", "Could not prepare the model."));
          }
          if (confirmed) {
            imported = response.model;
            dialog.close();
            return;
          }
          inspected = response;
          const { model, download_bytes, disk_free_bytes } = response;
          const fit = window.modelCompatibility.evaluate(model, hardware, window.nodaI18n.locale());
          const format = new Intl.NumberFormat(window.nodaI18n.locale(), { maximumFractionDigits: 2 });
          result.replaceChildren();
          add("strong", model.name, result);
          add("p", model.gguf_filename, result).className = "settings-picker-muted";
          add("p", t(`К загрузке ${format.format(download_bytes / 1e9)} GB · рекомендуется ${fit.recommendedGb} GB RAM`,
            `Download ${format.format(download_bytes / 1e9)} GB · ${fit.recommendedGb} GB RAM recommended`), result);
          if (Number.isSafeInteger(disk_free_bytes)) {
            const free = format.format(disk_free_bytes / 1e9);
            add("p", t(`На диске свободно ${free} ГБ.`, `${free} GB free on disk.`), result);
          }
          add("strong", fit.label, result).className = `settings-picker-fit compat-${fit.level}`;
          add("p", t("Это оценка по размеру весов и общей RAM. Noda проверит запуск при подключении модели.",
            "This estimate uses the weight size and total RAM. Noda will check whether the model starts when you select it."), result).className = "settings-picker-muted";
          result.hidden = false;
          status.textContent = fitsOnDisk() ? "" : t(...errors.space);
          if (!fitsOnDisk()) status.className = "settings-hf-error";
          setLabel();
        } catch (error) {
          status.textContent = error.message;
          status.className = "settings-hf-error";
        } finally {
          busy = downloading = stopping = input.disabled = submit.disabled = false;
          syncCancel();
          progress.hidden = true;
          if (dialog.open) submit.focus();
        }
      });
      setLabel();
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();
      input.focus();
    });
  }

  window.settingsChatModelImport = { open };
})();
