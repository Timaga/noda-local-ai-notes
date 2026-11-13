"""Refresh one cached Markdown note without scanning or reconciling the vault."""

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend import note_disk_source
else:
    try:
        from backend import note_disk_source
    except ImportError:
        import note_disk_source


logger = logging.getLogger(__name__)


def refresh_cached_note_from_disk(module, title):
    with module._notes_cache_lock:
        entry = dict(module.notes_data.get(title) or {})
    filepath = entry.get("filepath") or entry.get("path")
    if not filepath:
        # Preserve the existing contract for explicitly supplied in-memory notes.
        return
    path = Path(filepath)
    try:
        path = note_disk_source.safe_note_path(module.NOTES_DIR, path)
        stat = path.stat()
        # Read only this file. Editors/restores can preserve both mtime and size,
        # so a stat-only cache hit cannot establish that its content is unchanged.
        content = note_disk_source.read_note_source(module.NOTES_DIR, path)
    except FileNotFoundError:
        note_id = entry.get("id") or module._note_identifier(
            title, entry.get("filename") or path.name, filepath
        )
        try:
            module._delete_notes_in_qdrant(note_id)
        except Exception:
            logger.warning("Failed to invalidate deleted note in index")
        with module._notes_cache_lock:
            module.notes_data.pop(title, None)
            module._notes_snapshot.pop(title, None)
        return

    if content != entry.get("content"):
        module._refresh_note_entry_in_cache(title, content, path)
        return
    with module._notes_cache_lock:
        current = module.notes_data.get(title)
        if current and current.get("content") == content:
            current["timestamp"] = stat.st_mtime
            module._notes_snapshot[title] = (stat.st_mtime_ns, stat.st_size)
