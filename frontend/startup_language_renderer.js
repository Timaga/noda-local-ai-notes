(() => {
  "use strict";

  const section = document.getElementById("startup-language");
  const heading = document.getElementById("startup-language-title");
  const status = document.getElementById("startup-language-status");
  const overlay = document.getElementById("startup-overlay");
  const { languages, translate } = window.nodaLanguages;
  const options = section.querySelector(".startup-language-options");
  const buttons = Object.entries(languages).map(([code, [label]]) => {
    const existing = document.getElementById(`startup-language-${code}`);
    if (existing) {
      options.append(existing);
      return existing;
    }
    const button = document.createElement("button");
    button.id = `startup-language-${code}`;
    button.type = "button";
    button.value = code;
    button.lang = code;
    const labelGroup = document.createElement("span");
    labelGroup.className = "startup-language-label";
    const flag = document.createElement("img");
    flag.className = "startup-language-flag";
    flag.width = 24;
    flag.height = 16;
    flag.alt = "";
    flag.setAttribute("aria-hidden", "true");
    flag.src = window.nodaLanguageFlags[code];
    const name = document.createElement("span");
    name.textContent = label;
    labelGroup.append(flag, name);
    const badge = document.createElement("span");
    badge.className = "startup-language-code";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = code.toUpperCase();
    button.append(labelGroup, badge);
    options.append(button);
    return button;
  });
  let working = false;

  function setWorking(value) {
    working = value;
    buttons.forEach((button) => { button.disabled = value; });
  }

  async function choose(button) {
    if (working || section.hidden) return;
    const language = button.value;
    setWorking(true);
    status.lang = language;
    status.classList.remove("error");
    status.textContent = translate(language, "Сохраняем язык…", "Saving your language…");

    try {
      const result = await window.quickNoteBridge?.selectStartupLanguage?.(language);
      if (result?.ok !== true || result.language !== language) {
        throw new Error("Language choice was not confirmed");
      }
    } catch {
      if (section.hidden) return;
      setWorking(false);
      status.classList.add("error");
      status.textContent = translate(language, "Не удалось сохранить язык. Повторите попытку.",
        "Could not save your language. Try again.");
      button.focus();
    }
  }

  function render(payload) {
    const visible = payload.phase === "language-select" && payload.state !== "error";
    const opening = visible && section.hidden;
    section.hidden = !visible;
    overlay.classList.toggle("language-select", visible);
    document.body.classList.toggle("startup-language-page", visible);
    if (!visible) {
      status.textContent = "";
      setWorking(false);
    } else if (opening) {
      heading.focus();
    }
  }

  buttons.forEach((button) => button.addEventListener("click", () => choose(button)));
  window.startupLanguage = { render };
})();
