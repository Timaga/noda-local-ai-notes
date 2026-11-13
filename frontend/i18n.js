(function () {
  const { languages, supported, translate } = window.nodaLanguages;
  const attributes = ["placeholder", "title", "aria-label", "aria-description", "alt"];
  const selector = ["[data-en]", ...attributes.map((name) => `[data-en-${name}]`)].join(",");
  const labels = Array.from(document.querySelectorAll(selector), (element) => ({
    element,
    text: element.hasAttribute("data-en") ? element.textContent : null,
    attrs: attributes.filter((name) => element.hasAttribute(`data-en-${name}`))
      .map((name) => [name, element.getAttribute(name)]),
  }));
  let language;

  function setLanguage(next) {
    if (!supported(next)) return false;
    if (language === next) return true;
    language = next;
    document.documentElement.lang = next;
    for (const { element, text, attrs } of labels) {
      if (text !== null) element.textContent = t(text, element.getAttribute("data-en"));
      for (const [name, original] of attrs) {
        const value = t(original, element.getAttribute(`data-en-${name}`));
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
      }
    }
    return true;
  }

  function usesEnglishSource() { return language !== "ru"; }
  function t(ru, en) { return translate(language, ru, en); }
  function locale() { return languages[language][1]; }

  function count(value, ruForms, enOne, enOther) {
    const form = new Intl.PluralRules(locale()).select(value);
    const ruIndex = form === "one" ? 0 : form === "few" ? 1 : 2;
    const word = t(ruForms[ruIndex], form === "one" ? enOne : enOther);
    return `${new Intl.NumberFormat(locale()).format(value)} ${word}`;
  }

  window.nodaI18n = Object.freeze({ t, locale, count, isEnglish: usesEnglishSource, getLanguage: () => language, setLanguage });
  const initial = window.quickNoteBridge?.getLanguage?.() ?? document.documentElement.lang;
  setLanguage(supported(initial) ? initial : "en");
})();
