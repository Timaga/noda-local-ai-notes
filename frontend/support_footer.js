(function (root) {
  "use strict";
  const doc = root.document;
  if (doc.getElementById("app-support-footer")) return;
  const t = (ru, en) => root.nodaI18n?.t(ru, en) || en;
  const footer = doc.createElement("footer"); footer.id = "app-support-footer"; footer.className = "app-support-footer";
  const email = doc.createElement("span"); email.id = "support-email"; email.dir = "ltr"; email.textContent = "tim@buglai.com";
  const copy = doc.createElement("button"); copy.id = "support-copy"; copy.type = "button";
  copy.setAttribute("aria-describedby", email.id);
  copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><g class="copy-outline"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></g><path class="copy-check" d="m5 12 4 4L19 6"/></svg>';
  const status = doc.createElement("span"); status.className = "support-copy-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  let timer = null;
  function labels() {
    footer.setAttribute("aria-label", t("Почта поддержки", "Support email"));
    copy.title = t("Копировать почту", "Copy email"); copy.setAttribute("aria-label", copy.title);
  }
  copy.addEventListener("click", async () => {
    if (copy.disabled) return;
    copy.disabled = true; status.textContent = ""; clearTimeout(timer);
    try {
      await root.navigator.clipboard.writeText(email.textContent);
      copy.dataset.copied = "true"; status.textContent = t("Почта скопирована.", "Email copied.");
      timer = setTimeout(() => { delete copy.dataset.copied; }, 1800);
    } catch {
      delete copy.dataset.copied; status.textContent = t("Не удалось скопировать почту.", "Could not copy the email.");
    } finally { copy.disabled = false; }
  });
  footer.append(email, copy, status); doc.body.append(footer); doc.body.classList.add("has-support-footer"); labels();
  const observer = new MutationObserver(labels); observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["lang"] });
  root.addEventListener("beforeunload", () => { observer.disconnect(); clearTimeout(timer); }, { once: true });
})(window);
