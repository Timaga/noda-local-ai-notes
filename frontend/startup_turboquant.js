// Who: Tim Buglaev
// When: 2026-07-02
// What: Render the compatibility-gated startup explanation and submit only exact
//       enable/skip booleans through the restricted preload bridge.
(() => {
  "use strict";

  const t = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
  const isEnglish = () => window.nodaI18n?.isEnglish() === true;

  const section = document.getElementById("startup-turboquant");
  const hardware = document.getElementById("startup-turboquant-hardware");
  const current = document.getElementById("startup-turboquant-current");
  const status = document.getElementById("startup-turboquant-status");
  const skip = document.getElementById("startup-turboquant-skip");
  const disableButton = document.getElementById("startup-turboquant-disable");
  const enableButton = document.getElementById("startup-turboquant-enable");
  let working = false;

  function setWorking(nextWorking) {
    working = Boolean(nextWorking);
    disableButton.disabled = working;
    enableButton.disabled = working;
    skip.disabled = working;
  }

  async function submit(enabled) {
    if (working) {
      return;
    }
    const bridge = window.quickNoteBridge;
    if (typeof bridge?.selectStartupTurboQuant !== "function") {
      status.textContent = t("Выбор TurboQuant недоступен вне приложения.", "TurboQuant options are available only inside Noda.");
      return;
    }
    setWorking(true);
    status.textContent = enabled
      ? t("Включаем TurboQuant и сохраняем выбор...", "Enabling TurboQuant and saving your choice…")
      : t("Сохраняем выбор и продолжаем запуск...", "Saving your choice and continuing startup…");
    try {
      const result = await bridge.selectStartupTurboQuant({
        enabled: Boolean(enabled),
        skipFuturePrompt: Boolean(skip.checked),
      });
      if (!result || result.ok !== true) {
        throw new Error(t("Приложение не подтвердило выбор TurboQuant.", "Noda did not confirm the TurboQuant setting."));
      }
    } catch (error) {
      status.textContent = isEnglish()
        ? t("Не удалось применить настройку.", "Could not apply the TurboQuant setting. Try again.")
        : error?.message || "Не удалось применить настройку.";
      setWorking(false);
    }
  }

  function render(payload = {}) {
    const visible = payload.phase === "turboquant-select";
    section.hidden = !visible;
    document.body.classList.toggle("startup-turboquant-page", visible);
    document.getElementById("startup-overlay")?.classList.toggle("turboquant-select", visible);
    if (!visible) {
      status.textContent = "";
      setWorking(false);
      return;
    }
    const capability = payload.turboquantCapability || {};
    hardware.textContent = window.modelLocale?.turboquantReason(capability)
      || t(capability.reason || "Совместимость подтверждена.", "TurboQuant compatibility confirmed.");
    const enabled = Boolean(payload.turboquantEnabled);
    current.textContent = enabled
      ? t("Сейчас TurboQuant включён. Вы можете оставить его включённым или выключить.", "TurboQuant is on. You can leave it on or turn it off.")
      : t("Сейчас TurboQuant выключен. Выберите, нужен ли он для этой модели.", "TurboQuant is off. Choose whether to use it for this model.");
    disableButton.textContent = enabled ? t("Выключить", "Turn off") : t("Оставить выключенным", "Leave off");
    enableButton.textContent = enabled ? t("Оставить включённым", "Leave on") : t("Включить TurboQuant", "Enable TurboQuant");
    if (!working && payload.state !== "turboquant-select") {
      status.textContent = "";
    }
  }

  disableButton.addEventListener("click", () => {
    submit(false).catch(() => {});
  });
  enableButton.addEventListener("click", () => {
    submit(true).catch(() => {});
  });

  window.startupTurboQuant = { render };
})();
