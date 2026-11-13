(function (root) {
  "use strict";

  function createItem(note, { doc, selectedTitle, onSelect, tone, time, text }) {
    const li = doc.createElement("li"), button = doc.createElement("button");
    button.type = "button";
    button.className = "note-list-button";
    button.dataset.noteTitle = note.title;
    button.classList.toggle("active", note.title === selectedTitle);
    button.addEventListener("click", () => onSelect(note.title));
    const top = doc.createElement("div"), wrap = doc.createElement("div");
    top.className = "note-list-top"; wrap.className = "note-list-title-wrap";
    const dot = doc.createElement("span"), title = doc.createElement("span");
    dot.className = "note-list-dot"; dot.setAttribute("aria-hidden", "true");
    title.className = "note-list-title";
    title.textContent = note.display_title || note.generated_title || note.title || text("Без названия", "Untitled");
    wrap.append(dot, title); top.append(wrap);
    const snippet = doc.createElement("p"), bottom = doc.createElement("div");
    snippet.className = "note-list-snippet"; snippet.textContent = note.snippet || "";
    bottom.className = "note-list-bottom";
    if (Array.isArray(note.tags) && note.tags.length) {
      const tags = doc.createElement("div"); tags.className = "tag-row compact";
      for (const tag of note.tags.slice(0, 2)) {
        const pill = doc.createElement("span");
        pill.className = `tag-pill tag-tone-${tone(tag)}`; pill.textContent = `#${tag}`; tags.append(pill);
      }
      bottom.append(tags);
    }
    const timestamp = doc.createElement("span"); timestamp.className = "note-list-time";
    timestamp.textContent = time(note.timestamp); top.append(timestamp);
    button.append(top); if (snippet.textContent) button.append(snippet); if (bottom.children.length) button.append(bottom);
    li.append(button); return li;
  }

  const signature = note => JSON.stringify([note.title, note.display_title, note.generated_title,
    note.snippet, note.tags, note.timestamp]);

  function createReconciler({ list, doc, createItem: item }) {
    let rows = new Map(), empty = null;
    function render(notes, { preserveScroll = false, emptyText = "" } = {}) {
      if (new Set(notes.map(note => note.title)).size !== notes.length) throw new TypeError("Duplicate note identity");
      const top = list.getBoundingClientRect().top, scroll = list.scrollTop;
      const visible = Array.from(list.children).find(row => row.getBoundingClientRect().bottom > top);
      const anchor = visible && Array.from(rows.entries()).find(([, value]) => value.node === visible)?.[0];
      const offset = visible ? visible.getBoundingClientRect().top - top : 0;
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
      const next = new Map();
      if (notes.length && empty) { empty.remove(); empty = null; }
      for (const [index, note] of notes.entries()) {
        const key = note.title, digest = signature(note);
        let entry = rows.get(key);
        if (!entry) entry = { node: item(note), digest };
        else if (entry.digest !== digest) {
          const fresh = item(note), oldButton = entry.node.querySelector(".note-list-button");
          const newButton = fresh.querySelector(".note-list-button");
          oldButton.replaceChildren(...Array.from(newButton.childNodes));
          oldButton.className = newButton.className;
          entry.digest = digest;
        }
        next.set(key, entry);
        if (list.children[index] !== entry.node) list.insertBefore(entry.node, list.children[index] || null);
      }
      for (const [key, entry] of rows) if (!next.has(key)) entry.node.remove();
      rows = next;
      if (!notes.length) {
        if (!empty) { empty = doc.createElement("li"); empty.className = "notes-empty"; list.append(empty); }
        if (empty.textContent !== emptyText) empty.textContent = emptyText;
      }
      const managed = new Set(Array.from(rows.values(), entry => entry.node));
      if (empty) managed.add(empty);
      for (const node of Array.from(list.children)) if (!managed.has(node)) node.remove();
      if (preserveScroll && scroll > 0 && anchor && rows.has(anchor)) {
        list.scrollTop += rows.get(anchor).node.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
      } else list.scrollTop = preserveScroll ? scroll : 0;
      if (focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    return { render };
  }

  const api = { createItem, createReconciler };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesListView = api;
})(typeof window === "undefined" ? globalThis : window);
