"use strict";

const crypto = require("node:crypto");

function wrapper(source, { title = "План ремонта велосипеда", tags = ["велосипед", "ремонт"],
  related = ["Список мастерских", "Весеннее обслуживание"], version = "ru-pipeline-v1" } = {}) {
  return ["---", `title: ${JSON.stringify(title)}`, `tags: ${JSON.stringify(tags)}`,
    `related: ${JSON.stringify(related)}`, `noda_source_version: ${JSON.stringify(version)}`,
    `noda_source_sha256: ${JSON.stringify(crypto.createHash("sha256").update(source).digest("hex"))}`,
    `noda_source_length: ${Array.from(source).length}`, "---", ""].join("\n") + source;
}

function initial(language) {
  const english = language === "en";
  const notes = Array.from({ length: 100 }, (_, index) => ({
    title: `Архив ${String(index + 1).padStart(3, "0")}`,
    snippet: english ? "Synthetic archive entry for checking stable navigation." : "Синтетическая запись для проверки места в списке и плавного обновления.",
    tags: index % 2 ? ["план"] : [], indexed: true,
    timestamp: new Date(Date.UTC(2026, 10, 5, 10) - index * 60000).toISOString(),
  }));
  const canonical = "Сохранённая заметка a1b2";
  const source = english
    ? "On Saturday, take the bicycle to the workshop. Ask about the brake pads and chain. Keep the spare key at home."
    : "В субботу отвезти велосипед в мастерскую. Уточнить замену тормозных колодок и цепи. Запасной ключ оставить дома.";
  notes.unshift({ title: canonical, display_title: "Необработанная заметка a1b2", tags: [],
    snippet: source, indexed: true, timestamp: "2026-11-05T10:01:00Z" });
  notes.forEach((note, index) => { note.content_revision = (index + 1).toString(16).padStart(64, "0"); });
  const details = Object.fromEntries(notes.map(note => [note.title, { ...note, resolved_title: note.title,
    content: note.title === canonical ? source : `# ${note.title}\n\n${note.snippet}` }]));
  for (const title of ["Список мастерских", "Весеннее обслуживание"]) {
    details[title] = { title, resolved_title: title, content: `# ${title}\n\nСинтетическая связанная заметка.`, tags: [], indexed: true };
  }
  const generated = wrapper(source, { title: english ? "Bicycle repair plan" : "План ремонта велосипеда" });
  return { notes, details, canonical, source, generated, language };
}

function setup(data) {
  const state = window.__live = { ...data, vault: "a".repeat(32), revision: 1, serial: 1000,
    calls: [], holdLists: false, holdDetails: "", pendingLists: [], pendingDetails: [],
    failLists: false, failDetailOnce: "", listRequests: 0, inFlight: 0, maxInFlight: 0 };
  window.__liveAttack = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(payload) });
  function pending(queue, payload, options) {
    return new Promise((resolve, reject) => {
      const entry = { release: () => resolve(response(payload)), reject };
      queue.push(entry);
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.href), pathname = parsed.pathname;
    state.calls.push({ path: pathname, method: options.method || "GET" });
    if (pathname === "/notes") {
      if (parsed.searchParams.has("expected_vault_id") && parsed.searchParams.get("expected_vault_id") !== state.vault) {
        return response({ code: "vault_changed", error: "Synthetic vault changed", vault_id: state.vault }, 409);
      }
      if (parsed.searchParams.has("q")) {
        const query = parsed.searchParams.get("q").trim().normalize("NFC").toLowerCase();
        const titles = state.notes.filter(note =>
          [note.title, note.display_title, state.details[note.title]?.content, ...note.tags.map(tag => `#${tag}`)]
            .some(value => String(value || "").normalize("NFC").toLowerCase().includes(query))).map(note => note.title);
        return response({ titles, vault_id: state.vault });
      }
      state.listRequests += 1;
      state.inFlight += 1; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const revision = state.revision.toString(16).padStart(64, "0");
      const payload = parsed.searchParams.get("if_revision") === revision
        ? { unchanged: true, revision, vault_id: state.vault }
        : { notes: clone(state.notes), qdrant: { available: true, collection: "synthetic" },
          revision, vault_id: state.vault };
      try {
        if (state.failLists) throw new Error("Synthetic offline");
        return state.holdLists ? await pending(state.pendingLists, payload, options) : response(payload);
      } finally { state.inFlight -= 1; }
    }
    if (pathname.startsWith("/note-detail/")) {
      const title = decodeURIComponent(pathname.slice("/note-detail/".length));
      if (parsed.searchParams.has("expected_vault_id") && parsed.searchParams.get("expected_vault_id") !== state.vault) {
        return response({ code: "vault_changed", error: "Synthetic vault changed", vault_id: state.vault }, 409);
      }
      if (state.failDetailOnce === title) {
        state.failDetailOnce = "";
        throw new Error("Synthetic transient detail failure");
      }
      const detail = clone(state.details[title] || { title, resolved_title: title, content: title, tags: [] });
      detail.vault_id = state.vault;
      return state.holdDetails === title ? pending(state.pendingDetails, detail, options) : response(detail);
    }
    if (pathname === "/runtime/config") return response({ provider: "local", note_pipeline: { enabled: true } });
    if (pathname === "/chats") return response({ chats: [] });
    if (pathname === "/runtime/models") return response({ models: [] });
    throw new Error(`Unexpected synthetic request ${pathname}`);
  };
  window.__liveComplete = () => {
    const note = state.notes.find(row => row.title === state.canonical);
    Object.assign(note, { display_title: state.language === "en" ? "Bicycle repair plan" : "План ремонта велосипеда",
      tags: ["велосипед", "ремонт"], timestamp: "2026-11-05T10:03:00Z",
      content_revision: (++state.serial).toString(16).padStart(64, "0") });
    state.revision += 1;
    state.details[state.canonical] = { ...note, resolved_title: state.canonical, content: state.generated };
  };
  window.__liveAdd = (suffix = "new") => {
    const title = `Новая заметка ${suffix}`;
    const note = { title, display_title: title, snippet: "Новая синтетическая запись, созданная в фоне.",
      tags: ["план"], indexed: true, timestamp: "2026-11-05T10:04:00Z",
      content_revision: (++state.serial).toString(16).padStart(64, "0") };
    state.revision += 1;
    state.notes.unshift(note); state.details[title] = { ...note, resolved_title: title, content: note.snippet };
    return title;
  };
}

module.exports = { wrapper, initial, setup };
