(function (root) {
  "use strict";
  function create({ doc, host, context, request, getVault, text, model: Model }) {
    const heading = doc.createElement("h3"), status = doc.createElement("p"), list = doc.createElement("div");
    heading.id = "note-related-heading";
    list.className = "note-related-list";
    status.setAttribute("role", "status");
    host.setAttribute("aria-labelledby", heading.id);
    host.append(heading, status, list);
    let active = null, cache = null, pending = null, queued = false, failed = false, disposed = false;
    let shown = 50;
    const current = owner => owner && !disposed && context.isCurrent(owner.bound) && getVault() === owner.vault;
    function render() {
      heading.textContent = text("Связанные заметки", "Connected notes");
      if (!current(active)) { host.hidden = true; list.replaceChildren(); return; }
      const peers = cache && current(cache) ? [...(cache.data.adjacency.get(active.title) || [])] : [];
      peers.sort((a, b) => cache.data.nodes.get(a).title.localeCompare(cache.data.nodes.get(b).title, doc.documentElement.lang));
      status.textContent = failed ? text("Не удалось загрузить связанные заметки.", "Could not load connected notes.")
        : !cache ? text("Загрузка связей…", "Loading connections…") : "";
      status.hidden = !status.textContent;
      host.hidden = !peers.length && !status.textContent;
      // Retain keyboard focus when an automatic refresh changes the link list.
      const focused = list.contains(doc.activeElement) ? doc.activeElement.dataset.noteTitle : null;
      const fragment = doc.createDocumentFragment(), owner = active;
      for (const id of peers.slice(0, shown)) {
        const button = doc.createElement("button");
        button.type = "button"; button.className = "note-related-link";
        button.dataset.noteTitle = id; button.textContent = cache.data.nodes.get(id).title; button.title = button.textContent;
        button.addEventListener("click", () => {
          if (active !== owner || !current(owner) || !cache?.data.adjacency.get(owner.title)?.has(id)) return;
          root.dispatchEvent(new CustomEvent("notes-chat:open-note", { detail: { title: id, projectContext: owner.bound, focusEditor: true } }));
        });
        fragment.append(button);
      }
      if (peers.length > shown) {
        const more = doc.createElement("button"); more.type = "button";
        more.textContent = text("Показать ещё", "Show more");
        more.addEventListener("click", () => { const next = shown; shown += 50; render(); list.children[next]?.focus(); }); fragment.append(more);
      }
      list.replaceChildren(fragment);
      if (focused) [...list.children].find(node => node.dataset.noteTitle === focused)?.focus({ preventScroll: true });
    }
    async function refresh(changed = true) {
      if (!current(active) || (!changed && cache && !failed)) return;
      if (pending) { queued = queued || changed; return pending; }
      const owner = active, previous = cache && current(cache) ? cache : null;
      const query = new URLSearchParams({ live: "1" });
      if (owner.vault) query.set("expected_vault_id", owner.vault);
      if (previous) query.set("if_revision", previous.revision);
      pending = (async () => {
        try {
          const payload = await request(`/notes-graph?${query}`);
          if (!current(owner)) return;
          if (!/^[a-f0-9]{32}$/.test(payload.vault_id || "") || !/^[a-f0-9]{64}$/.test(payload.revision || "")
              || (owner.vault && payload.vault_id !== owner.vault)) throw new Error("Invalid graph context");
          if (payload.unchanged === true) {
            if (!previous || payload.revision !== previous.revision) throw new Error("Invalid graph revision");
          } else {
            cache = { bound: owner.bound, vault: owner.vault, revision: payload.revision, data: Model.build(payload) };
          }
          failed = false;
        } catch {
          if (current(owner)) { cache = null; failed = true; }
        } finally {
          pending = null; render();
          if (queued) { queued = false; void refresh(); }
        }
      })();
      return pending;
    }
    function clear() { active = null; cache = null; failed = false; queued = false; render(); }
    const unsubscribe = context.subscribe(() => { if (active && !current(active)) clear(); });
    host.hidden = true;
    return {
      open(title) {
        const bound = context.snapshot(), vault = getVault();
        if (cache && !current(cache)) cache = null;
        if (active?.title !== title || !current(active)) { active = { title, bound, vault }; shown = 50; }
        render(); if (!cache) void refresh();
      },
      refresh, refreshLanguage: render, clear,
      dispose() { clear(); disposed = true; unsubscribe(); },
    };
  }
  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesRelatedNotes = api;
})(typeof window === "undefined" ? globalThis : window);
