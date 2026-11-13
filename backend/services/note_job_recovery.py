"""Reconcile a committed note against its current file, without regeneration."""

from pathlib import Path


def reconcile_publication(runtime, context):
    if Path(runtime.NOTES_DIR).resolve() != context.store.vault:
        return False
    job = context.store.get(context.job_id)
    name = job.get("target")
    if not isinstance(name, str) or Path(name).name != name:
        return False
    target = context.store.vault / name
    if (
        target.is_symlink()
        or not target.is_file()
        or target.resolve().parent != context.store.vault
    ):
        # A user's deletion/move is never repaired by recreating the note.
        return False
    runtime._reload_notes_cache(reason="queued publication recovery", skip_index=True)
    with runtime._notes_cache_lock:
        entry = dict(runtime.notes_data.get(target.stem) or {})
    if not entry or Path(entry.get("filepath", "")).resolve() != target.resolve():
        return False
    indexed = runtime._index_notes_in_qdrant({target.stem: entry})
    return indexed is not False or not runtime._qdrant_enabled()
