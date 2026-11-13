(function (root) {
  "use strict";
  const validRevision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const normalize = value => value.replace(/\r\n?/g, "\n");

  function create({ context, drafts, request, readDetail, getProject, getVault, onChange = () => {},
    onSaved = () => {}, onBusy = () => {}, delay = 1000, autoSave = true,
    timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) } }) {
    let active = null, pending = null, pendingRecord = null, timer = null, composing = false;
    let autoSaving = autoSave !== false, saveDelay = delay;
    const dirty = record => Boolean(record?.editable && record.content !== record.base);
    const current = record => record && context.isCurrent(record.bound);
    const visible = record => active === record && current(record);
    const cancel = () => { if (timer !== null) timers.clearTimeout(timer); timer = null; };
    const state = record => ({ ...record, dirty: dirty(record), busy: Boolean(pending) || Boolean(record.reloading),
      autoSaveEnabled: autoSaving, autoSaveDelayMs: saveDelay });
    const notify = record => { if (visible(record)) onChange(state(record)); };
    function persist(record) {
      if (!record?.editable) return;
      record.durable = drafts.write(record.project, record.title, dirty(record) || record.writing || record.unconfirmed
        ? { title: record.title, tags: "", content: record.content, revision: record.revision } : null);
    }
    function schedule() {
      cancel();
      if (!autoSaving || !active || !dirty(active) || active.blocked || active.reloading || composing || !current(active)) return;
      timer = timers.setTimeout(() => { timer = null; void flush(); }, saveDelay);
    }
    function open(title, detail) {
      const bound = context.snapshot(), project = getProject();
      if (pendingRecord?.title === title && pendingRecord.project === project && current(pendingRecord)) {
        persist(active); cancel(); active = pendingRecord; notify(active); return;
      }
      if (active?.title === title && active.project === project && context.isCurrent(active.bound)) {
        if (dirty(active) || pending) return;
        if (active.revision === detail.edit_revision) return;
      }
      persist(active); cancel();
      const editable = validRevision(detail.edit_revision) && typeof detail.editable_body === "string";
      const base = editable ? normalize(detail.editable_body) : "";
      const draft = editable ? drafts.read(project, title) : null;
      const content = draft ? normalize(draft.content) : base;
      active = { title, project, bound, vault: getVault(), editable, base,
        content, revision: content === base ? detail.edit_revision : draft?.revision || detail.edit_revision,
        status: editable ? "saved" : "readonly", blocked: false, durable: !draft || drafts.isDurable(project, title) };
      if (dirty(active)) {
        active.status = active.revision === detail.edit_revision ? "draft" : "conflict";
        active.blocked = active.status === "conflict";
        schedule();
      } else if (editable && draft) persist(active);
      notify(active);
    }
    function input(content) {
      if (!active?.editable || active.reloading || !current(active)) return;
      active.reloadError = false;
      active.content = normalize(content);
      if (!active.blocked) active.status = dirty(active) ? "draft" : "saved";
      persist(active); notify(active); schedule();
    }
    async function flush() {
      cancel();
      const record = active;
      if (!record || !current(record) || record.blocked || record.reloading || composing) return false;
      while (pending) {
        await pending;
        if (active !== record || !current(record) || record.blocked || record.reloading || record.status === "error") return false;
      }
      if (record.unconfirmed) return retry();
      if (!dirty(record)) return true;
      if (!validRevision(record.revision)) return false;
      const sent = { content: record.content, revision: record.revision };
      record.status = "saving"; record.writing = true; record.unconfirmed = sent; persist(record);
      pendingRecord = record;
      onBusy(true);
      pending = (async () => {
        let committed = false;
        try {
          const suffix = record.vault ? `?expected_vault_id=${record.vault}` : "";
          const result = await request(`/note-detail/${encodeURIComponent(record.title)}${suffix}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent) });
          committed = true;
          if (!current(record)) return false;
          const detail = await readDetail(result.title || record.title, record.vault);
          if (!current(record)) return false;
          if (!validRevision(detail.edit_revision) || typeof detail.editable_body !== "string"
              || normalize(detail.editable_body) !== sent.content) {
            record.blocked = true; record.status = "conflict";
            persist(record); return false;
          }
          record.base = sent.content; record.revision = detail.edit_revision;
          record.status = dirty(record) ? "draft" : result.cache_updated === false ? "index-pending" : "saved";
          record.unconfirmed = null;
          persist(record);
          if (visible(record)) onSaved(detail, result);
          return true;
        } catch (error) {
          if (!current(record)) return false;
          record.blocked = error.code === "note_edit_conflict" || error.code === "vault_changed";
          record.status = record.blocked ? "conflict" : "error";
          // A timeout can follow an atomic write. Reconcile before retrying it.
          if (!record.blocked) record.unconfirmed = sent;
          record.committed = committed;
          persist(record); return false;
        }
      })();
      notify(record);
      try { return await pending; }
      finally {
        pending = null; pendingRecord = null; record.writing = false; persist(record); onBusy(false); notify(record);
        if (visible(record) && record.status === "draft") schedule();
      }
    }
    async function retry() {
      const record = active;
      if (!record || !current(record) || record.blocked || record.reloading || pending) return false;
      if (record.unconfirmed) {
        try {
          const detail = await readDetail(record.title, record.vault);
          if (!visible(record)) return false;
          const content = typeof detail.editable_body === "string" ? normalize(detail.editable_body) : null;
          if (!validRevision(detail.edit_revision) || (content !== record.unconfirmed.content && content !== record.base)) {
            record.status = "conflict"; record.blocked = true; notify(record); return false;
          }
          record.base = content; record.revision = detail.edit_revision; record.unconfirmed = null;
          record.status = dirty(record) ? "draft" : "saved"; persist(record); notify(record);
        } catch { return false; }
      }
      return flush();
    }
    async function reloadFromDisk() {
      const record = active;
      if (!record || !current(record) || record.reloading) return false;
      cancel(); record.reloading = true; record.reloadError = false; onBusy(true); notify(record);
      try {
        if (pending) await pending;
        if (!visible(record)) return false;
        const detail = await readDetail(record.title, record.vault);
        if (!visible(record)) return false;
        if (!validRevision(detail.edit_revision) || typeof detail.editable_body !== "string") throw new Error("invalid_note_detail");
        record.content = record.base = normalize(detail.editable_body); record.revision = detail.edit_revision;
        record.editable = true; record.blocked = false; record.unconfirmed = null; record.status = "saved";
        persist(record); onSaved(detail, { reloaded: true }); return true;
      } catch {
        if (visible(record)) { record.reloadError = true; persist(record); }
        return false;
      } finally {
        record.reloading = false; onBusy(false); notify(record);
      }
    }
    function configure(value = {}) {
      if (value.editorAutoSave !== undefined && typeof value.editorAutoSave !== "boolean") return false;
      if (value.editorAutoSaveDelayMs !== undefined && (!Number.isInteger(value.editorAutoSaveDelayMs)
          || value.editorAutoSaveDelayMs < 500 || value.editorAutoSaveDelayMs > 10000)) return false;
      if (value.editorAutoSave !== undefined) autoSaving = value.editorAutoSave;
      if (value.editorAutoSaveDelayMs !== undefined) saveDelay = value.editorAutoSaveDelayMs;
      schedule(); notify(active); return true;
    }
    return { open, input, flush, retry, reloadFromDisk, configure,
      autoSave: () => autoSaving ? flush() : Promise.resolve(false),
      close() { persist(active); cancel(); active = null; composing = false; },
      composition(value) { composing = value; if (value) cancel(); else schedule(); },
      getState: () => active ? state(active) : null,
      isDirty: () => dirty(active) || Boolean(pending) || Boolean(active?.reloading),
    };
  }
  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesEditorSession = api;
})(typeof window === "undefined" ? globalThis : window);
