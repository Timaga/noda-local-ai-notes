"""Atomic note publication and cache/index synchronization after commit."""

import logging
import os
from pathlib import Path
import re
import tempfile
import time

try:
    from backend.generated_text_language import validate_note_output
    from backend.note_generation_contract import NoteGenerationError
    from backend.note_processing_failures import NoteSystemError
except ImportError:
    from generated_text_language import validate_note_output
    from note_generation_contract import NoteGenerationError
    from note_processing_failures import NoteSystemError


def safe_title(title):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f\[\]#]', " ", title)
    value = re.sub(r"\s+", " ", value).strip(" .")[:120].rstrip(" .")
    if not value:
        raise NoteGenerationError("Заголовок модели нельзя использовать как имя файла.")
    if re.match(
        r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", value, re.IGNORECASE
    ):
        value = "_" + value
    return value


def save_new_note(directory, title, content):
    """Publish exact UTF-8 bytes atomically without replacing an existing file."""
    root = Path(directory).resolve(strict=True)
    base = safe_title(title)
    descriptor, temporary = tempfile.mkstemp(prefix=".note-", suffix=".tmp", dir=root)
    published = False
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        for number in range(10000):
            name = base if number == 0 else f"{base} {number}"
            target = root / f"{name}.md"
            try:
                # A hard link exposes the complete file and rejects live collisions.
                os.link(temporary, target)
                published = True
                return target
            except FileExistsError:
                continue
        raise OSError("Unique filename limit reached")
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        except OSError:
            if not published:
                raise
            logging.getLogger(__name__).warning(
                "Note persisted; temporary file cleanup failed"
            )


def persist_note(
    runtime, draft, *, publication_context=None, related_paths=(), started=None
):
    """Commit a caller-built draft, then synchronize its runtime bookkeeping."""
    validate_note_output(draft)
    started = time.perf_counter() if started is None else started
    body = draft["content"]
    try:
        if publication_context is None:
            path = save_new_note(runtime.NOTES_DIR, draft["title"], body)
        else:
            path = publication_context.publish(
                runtime.NOTES_DIR, draft, related_paths=related_paths
            )
    except (OSError, ValueError) as exc:
        raise NoteSystemError(
            "Не удалось сохранить заметку на диск. Проверьте доступ и свободное место.",
            failure_code="publication_failed",
        ) from exc
    title = path.stem
    warnings = list(draft.get("warnings") or [])
    try:
        stat = path.stat()
        directory_mtime = Path(runtime.NOTES_DIR).stat().st_mtime_ns
    except OSError:
        stat = None
        directory_mtime = None
        runtime.logger.warning("Note persisted; file metadata could not be read")
        warnings.append(
            "Заметка сохранена; сведения о файле будут обновлены при следующем чтении."
        )
    try:
        runtime._mark_generated_note_guard(path, body)
    except Exception:
        runtime.logger.warning("Note persisted; watcher guard could not be updated")
    entry = {
        "content": body,
        "tags": draft["tags"],
        "filename": path.name,
        "filepath": str(path),
        "timestamp": stat.st_mtime if stat is not None else None,
    }
    with runtime._notes_cache_lock:
        runtime.notes_data[title] = entry
        if stat is not None:
            runtime._notes_snapshot[title] = (stat.st_mtime_ns, stat.st_size)
        else:
            runtime._notes_snapshot.pop(title, None)
        runtime._notes_dir_mtime = directory_mtime
    try:
        runtime._update_notes_cache_state(
            reloaded=False,
            disk_count=len(runtime._notes_snapshot),
            reason="/generate",
            dir_mtime=runtime._notes_dir_mtime,
        )
    except Exception:
        runtime.logger.warning("Note persisted; cache diagnostics could not be updated")
    try:
        indexed = runtime._index_notes_in_qdrant({title: entry})
        if publication_context is not None and indexed is not False:
            publication_context.store.update(
                publication_context.job_id, index_pending=False
            )
        if indexed is False and getattr(runtime, "_qdrant_enabled", lambda: False)():
            warnings.append(
                "Заметка сохранена; обновление поискового индекса не завершено."
            )
    except Exception:
        runtime.logger.warning("Note persisted; search index update failed")
        warnings.append(
            "Заметка сохранена; обновление поискового индекса не завершено."
        )
    try:
        runtime._register_finalized_note(path, body)
    except Exception:
        runtime.logger.warning("Note persisted; watcher signature could not be updated")
    draft.update(title=title, warnings=warnings)
    draft.setdefault("generation", {})["duration_ms"] = round(
        (time.perf_counter() - started) * 1000
    )
    return draft
