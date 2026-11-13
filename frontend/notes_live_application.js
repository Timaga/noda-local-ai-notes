(function (root) {
  "use strict";

  const token = (value, size) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
  const failure = code => Object.assign(new Error(code), { code });
  const summary = notes => JSON.stringify(notes);
  const visible = note => JSON.stringify([note?.title, note?.display_title, note?.generated_title,
    note?.tags, note?.timestamp, note?.indexed]);
  const detailDigest = note => JSON.stringify([note?.content, visible(note), note?.resolved_title]);

  function create({ request, getState, applyList, applyDetail, resetSelection }) {
    let vault = null, revision = null, listDigest = null;

    function checkedVault(payload, expected) {
      if (payload.vault_id != null && !token(payload.vault_id, 32)) throw failure("invalid_notes_response");
      if (expected && payload.vault_id !== expected) throw failure("vault_changed");
      return payload.vault_id || null;
    }

    function suffix(expected) {
      return expected ? `?expected_vault_id=${expected}` : "";
    }

    async function readDetail(title, expected = vault) {
      const payload = await request(`/note-detail/${encodeURIComponent(title)}${suffix(expected)}`);
      checkedVault(payload, expected);
      if (typeof payload.content !== "string" || !Array.isArray(payload.tags)) throw failure("invalid_notes_response");
      return payload;
    }

    async function refresh(context) {
      const previous = getState(), requestedVault = vault;
      const params = [];
      if (context.background) params.push("live=1");
      if (requestedVault) params.push(`expected_vault_id=${requestedVault}`);
      if (context.background && revision) params.push(`if_revision=${revision}`);
      let payload, expectedReply = requestedVault;
      try { payload = await request(`/notes${params.length ? "?" + params.join("&") : ""}`); }
      catch (error) {
        if (!context.isCurrent() || error.code !== "vault_changed") throw error;
        expectedReply = null;
        payload = await request(context.background ? "/notes?live=1" : "/notes");
      }
      if (!context.isCurrent()) return false;
      const incomingVault = checkedVault(payload, expectedReply);
      if (payload.revision !== undefined && !token(payload.revision, 64)) throw failure("invalid_notes_response");
      if (payload.unchanged === true) {
        if (!requestedVault || incomingVault !== requestedVault || payload.revision !== revision) {
          throw failure("invalid_notes_response");
        }
        return false;
      }
      if (!Array.isArray(payload.notes) || payload.notes.some(note => !note || typeof note.title !== "string")
          || new Set(payload.notes.map(note => note.title)).size !== payload.notes.length) {
        throw failure("invalid_notes_response");
      }
      const switched = Boolean(vault && incomingVault !== vault);
      if (switched) resetSelection();
      vault = incomingVault;
      const incomingRevision = payload.revision || null;
      const complete = () => { revision = incomingRevision; return true; };
      const digest = JSON.stringify([summary(payload.notes), payload.qdrant || {}]);
      if (switched || digest !== listDigest) {
        applyList(payload); listDigest = digest;
      }
      const selected = getState();
      if (selected.creatingNote || !selected.selectedNoteTitle) return complete();
      const row = payload.notes.find(note => note.title === selected.selectedNoteTitle);
      if (!row) { resetSelection(); return complete(); }
      const oldRow = previous.notes.find(note => note.title === selected.selectedNoteTitle);
      const sameRevision = token(row.content_revision, 64)
        && row.content_revision === selected.selectedNoteDetail?.content_revision;
      if ((sameRevision && visible(row) === visible(selected.selectedNoteDetail))
          || (!row.content_revision && summary([oldRow]) === summary([row]))) return complete();
      const version = selected.noteSelectionVersion, title = selected.selectedNoteTitle, detailVault = vault;
      const detail = await readDetail(title, detailVault);
      const current = getState();
      if (!context.isCurrent() || vault !== detailVault || current.noteSelectionVersion !== version
          || current.selectedNoteTitle !== title || current.creatingNote) return false;
      if (detailDigest(detail) !== detailDigest(current.selectedNoteDetail)) applyDetail(detail);
      else current.selectedNoteDetail.content_revision = detail.content_revision;
      return complete();
    }

    return { refresh, readDetail, getVault: () => vault,
      reset: () => { vault = null; revision = null; listDigest = null; } };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesLiveApplication = api;
})(typeof window === "undefined" ? globalThis : window);
