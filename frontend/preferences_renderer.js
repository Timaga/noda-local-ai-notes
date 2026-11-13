(function (root) {
  "use strict";
  const schema = root.NotesDesktopPreferences;
  if (!schema) return;
  let saved = schema.normalizePreferences(root.quickNoteBridge?.getPreferences?.() || {}), current = saved;
  function render(value) {
    const target = document.documentElement;
    target.style.setProperty("--editor-font-size", `${value.editorFontSize}px`);
    target.dataset.interfaceDensity = value.interfaceDensity;
    root.dispatchEvent(new CustomEvent("noda-preferences:changed", { detail: { ...value } }));
  }
  root.NodaPreferences = Object.freeze({
    get: () => ({ ...current }),
    apply(value) { saved = schema.normalizePreferences(value, saved); current = saved; render(current); },
    preview(value) { current = schema.normalizePreferences({ ...saved, ...value }, saved); render(current); },
    reset() { current = saved; render(current); },
  });
  render(current);
  root.quickNoteBridge?.onPreferencesChanged?.(value => root.NodaPreferences.apply(value));
})(window);
