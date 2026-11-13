(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./ui_translations"));
  } else {
    root.nodaLanguages = factory(root.nodaTranslations);
  }
})(globalThis, function (catalogs) {
  "use strict";

  const languages = Object.freeze({
    en: ["English", "en-US"],
    ru: ["Русский", "ru-RU"],
    es: ["Español", "es-ES"],
    fr: ["Français", "fr-FR"],
    de: ["Deutsch", "de-DE"],
    pt: ["Português (Brasil)", "pt-BR"],
    it: ["Italiano", "it-IT"],
    zh: ["简体中文", "zh-CN"],
    ja: ["日本語", "ja-JP"],
    ko: ["한국어", "ko-KR"],
  });
  const placeholder = /\{(\d+)\}/g;
  const templates = new Map();

  function supported(code) {
    return typeof code === "string" && Object.hasOwn(languages, code);
  }

  function matchTemplate(value, pieces) {
    const first = pieces[0];
    const last = pieces.at(-1);
    if (!value.startsWith(first) || !value.endsWith(last)) return null;
    let offset = first.length;
    const end = value.length - last.length;
    const args = [];
    for (let index = 1; index < pieces.length - 1; index += 2) {
      const next = index === pieces.length - 2 ? end : value.indexOf(pieces[index + 1], offset);
      if (next < offset || next > end) return null;
      args[pieces[index]] = value.slice(offset, next);
      offset = next + pieces[index + 1].length;
    }
    return args;
  }

  function translate(code, russian, english) {
    if (code === "ru") return russian;
    const catalog = supported(code) ? catalogs[code] : null;
    if (!catalog || typeof english !== "string") return english ?? russian;
    if (Object.hasOwn(catalog, english)) return catalog[english];
    if (english.length > 4096) return english;
    if (!templates.has(code)) {
      const patterns = Object.entries(catalog).map(([source, target]) => [source.split(placeholder), target])
        .filter(([pieces]) => pieces.length > 1 && pieces.slice(2, -1).every((piece, index) => index % 2 || piece))
        .sort(([a], [b]) => b[0].length + b.at(-1).length - a[0].length - a.at(-1).length);
      templates.set(code, patterns);
    }
    for (const [pieces, target] of templates.get(code)) {
      const args = matchTemplate(english, pieces);
      if (args) return target.replace(placeholder, (marker, index) => args[index] ?? marker);
    }
    return english;
  }

  return Object.freeze({ languages, supported, translate });
});
