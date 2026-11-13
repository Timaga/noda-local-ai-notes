(function (root) {
  "use strict";
  const changed = () => Object.assign(new Error("The active project changed."), { code: "project_changed" });
  const blank = () => ({ text: "", mode: "organize" });
  const projectId = /^[a-f0-9]{32}$/;
  const requestId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
  const validMode = mode => ["organize", "organize_edit"].includes(mode);
  const validText = text => typeof text === "string" && text.length <= 4000;

  function createDraftStorage(storage) {
    const key = state => {
      const id = projectId.test(state?.projectId || "") ? state.projectId
        : state?.projectId === null && state.legacyChatStorage === true ? "legacy" : null;
      return id === null ? null : `noda:quick-draft:v1:${id}`;
    };
    const validPending = value => value && validText(value.raw) && value.raw.trim()
      && value.source === "local" && validMode(value.mode) && requestId.test(value.id || "")
      && projectId.test(value.vaultId || "");
    return {
      read(state) {
        const id = key(state);
        if (id === null) return null;
        try {
          const value = JSON.parse(storage()?.getItem(id) || "null");
          if (!value || !validText(value.draft?.text) || !validMode(value.draft.mode)) return null;
          const { text, mode } = value.draft;
          let pending = null;
          if (validPending(value.pending)) {
            const { raw, source, mode, id, vaultId } = value.pending;
            pending = { raw, source, mode, id, vaultId };
          }
          return { draft: { text, mode }, pending };
        } catch {
          return null;
        }
      },
      write(state, value) {
        const id = key(state);
        if (id === null || !validText(value.draft?.text) || !validMode(value.draft.mode)
            || (value.pending && !validPending(value.pending))) return false;
        try {
          const target = storage();
          if (!target) return false;
          if (value.draft.text || value.pending) target.setItem(id, JSON.stringify(value));
          else target.removeItem(id);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  function create({ context, readDraft, writeDraft, createClient, reset, onState,
    storage, onProject = () => {}, onReady = () => {} }) {
    if (!context || typeof context.subscribe !== "function") throw changed();
    const drafts = new Map();
    let bound = null, client = null, started = false, disposed = false;
    function remember(state, pending = drafts.get(state.projectId)?.pending ?? null) {
      const entry = { draft: readDraft(), pending };
      drafts.set(state.projectId, entry);
      return !storage || storage.write(state, entry);
    }
    function active() {
      if (disposed || !bound || !client || !context.isCurrent(bound)) throw changed();
      return client;
    }
    const unsubscribe = context.subscribe(next => {
      if (disposed) return;
      onProject(next);
      if (bound && context.isCurrent(bound) && next.epoch === bound.epoch) return;
      if (bound) remember(bound);
      client?.stop();
      client = null; bound = null;
      writeDraft(blank());
      reset();
      if (next.status === "ready") {
        bound = next;
        const entry = drafts.get(next.projectId) || storage?.read(next);
        if (entry) drafts.set(next.projectId, entry);
        writeDraft(entry?.draft || blank(), next, Boolean(entry));
        client = createClient(next, entry?.pending || null, pending =>
          !disposed && bound === next && context.isCurrent(next) && remember(next, pending));
      }
      onState(next);
      if (bound) {
        const captured = bound;
        Promise.resolve().then(() => {
          if (!context.isCurrent(captured) || disposed) return;
          if (started) client.start().catch(() => {});
          onReady(captured);
        });
      }
    });
    const call = name => (...args) => {
      try { return active()[name](...args); }
      catch (error) { return Promise.reject(error); }
    };
    return {
      enqueue: call("enqueue"), detail: call("detail"), retry: call("retry"), refresh: call("refresh"),
      ensureReady: call("ensureReady"), cleanupHistory: call("cleanupHistory"), removeJob: call("removeJob"),
      showEarlier: call("showEarlier"), showRecent: call("showRecent"),
      saveDraft() { return !bound || (context.isCurrent(bound) && remember(bound)); },
      values: () => { try { return active().values(); } catch (_) { return []; } },
      async start() {
        started = true;
        await context.ready();
        return active().start();
      },
      stop() { started = false; client?.stop(); },
      dispose() {
        if (disposed) return;
        if (bound) remember(bound);
        disposed = true; started = false; unsubscribe?.(); client?.stop(); drafts.clear();
      },
    };
  }
  const api = { create, createDraftStorage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QuickCaptureProject = api;
})(typeof window === "undefined" ? globalThis : window);
