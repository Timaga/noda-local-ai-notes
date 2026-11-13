const { normalizeLanguage } = require("./desktop_settings");
const { supported } = require("./ui_languages");

function createStartupLanguageSelection({ initialLanguage, bypass = false, persist, showPrompt }) {
  let language = normalizeLanguage(initialLanguage);
  let pending = null;

  function getLanguage() {
    return language ?? (bypass ? "en" : null);
  }

  function wait() {
    const current = getLanguage();
    if (current) return Promise.resolve(current);
    if (pending) return pending.promise;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    pending = { promise, resolve };
    try {
      showPrompt();
    } catch (error) {
      pending = null;
      throw error;
    }
    return promise;
  }

  function select(value) {
    if (!supported(value)) return { ok: false, code: "invalid_language" };
    if (!pending) return { ok: false, code: "selection_inactive" };
    try {
      persist(value);
    } catch (error) {
      console.warn(`[startup language] save failed: ${error?.name || "Error"}`);
      return { ok: false, code: "language_save_failed" };
    }
    language = value;
    const selection = pending;
    pending = null;
    selection.resolve(language);
    return { ok: true, language };
  }

  return { wait, select, getLanguage };
}

module.exports = { createStartupLanguageSelection };
