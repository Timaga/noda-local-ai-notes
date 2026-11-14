# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

try:
    from backend.note_disk_source import note_relative_title, read_note_source
except ImportError:
    from note_disk_source import note_relative_title, read_note_source

def _handle_note_update(event_path, previous_path=None):
    """
    Handles the logic for processing a modified note file.
    """
    global _notes_dir_mtime
    try:
        current_path = Path(event_path)
    except Exception:
        return
    if current_path.suffix.lower() != ".md":
        return
    if _should_skip_recent_event(current_path):
        logger.info("Skipping repeated note event: %s", event_path)
        return

    logger.info(f"File change detected: {event_path}")

    try:
        previous_title = None
        previous_filename = None
        previous_filepath = None
        if previous_path:
            try:
                prev_path_obj = Path(previous_path)
                previous_title = note_relative_title(NOTES_DIR, prev_path_obj, allow_missing_leaf=True)
                previous_filename = prev_path_obj.name
                previous_filepath = str(prev_path_obj)
            except Exception:
                previous_title = None
                previous_filename = None
                previous_filepath = None

        # Give the file a moment to finish writing
        time.sleep(0.5)
        content = read_note_source(NOTES_DIR, current_path)

        if not content.strip():
            logger.info(f"Skipping empty note: {event_path}")
            return

        current_title = note_relative_title(NOTES_DIR, current_path)
        current_filename = current_path.name
        current_filepath = str(current_path)

        if previous_filepath and previous_filepath != current_filepath:
            try:
                _delete_notes_in_qdrant(_note_identifier(previous_title, previous_filename, previous_filepath))
            except Exception as delete_exc:
                logger.warning("Failed to drop previous note from ANN index: %s", delete_exc)
            with _note_autolink_lock:
                try:
                    _finalized_note_cache.pop(_note_path_key(Path(previous_filepath)), None)
                except Exception:
                    pass
            with _notes_cache_lock:
                notes_data.pop(previous_title, None)
                _notes_snapshot.pop(previous_title, None)

        try:
            key = _note_path_key(current_path)
            signature = _note_event_signature(current_path)
        except Exception:
            key = str(current_path)
            signature = None
        if signature is not None:
            with _note_autolink_lock:
                processed_sig = _note_processed_signatures.get(key)
            if processed_sig is not None and processed_sig == signature:
                _register_finalized_note(current_path, content)
                logger.info("Skipping already processed note event: %s", event_path)
                return
        if _should_skip_generated_event(current_path, content):
            try:
                stat = current_path.stat()
                snapshot_value = (stat.st_mtime_ns, stat.st_size)
                with _notes_cache_lock:
                    _notes_snapshot[current_title] = snapshot_value
            except Exception:
                pass
            _register_finalized_note(current_path, content)
            logger.info("Skipping autolinker for freshly generated note: %s", event_path)
            return

        cached_entry = {}
        try:
            with _notes_cache_lock:
                cached_entry = dict(notes_data.get(current_title) or {})
        except Exception:
            cached_entry = {}
        cached_digest = _compute_note_digest(cached_entry.get("content"))
        content_digest = _compute_note_digest(content)
        if _is_finalized_note_event(current_path, content) or (cached_digest and cached_digest == content_digest):
            try:
                stat = current_path.stat()
                snapshot_value = (stat.st_mtime_ns, stat.st_size)
                with _notes_cache_lock:
                    _notes_snapshot[current_title] = snapshot_value
            except Exception:
                pass
            _register_finalized_note(current_path, content)
            logger.info("Skipping autolinker for finalized or unchanged note: %s", event_path)
            return

        # Saving or editing a note must not silently replace model/user decisions.
        # The watcher refreshes search data only; generation owns semantic metadata.
        updated_content = content
        updated_tags = extract_tags(content)

        updated_index_text = _clean_note_text_for_rag(updated_content) or updated_content
        updated_vector = generate_embedding(updated_index_text, vector_size=_get_vector_size())
        updated_snippet = _generate_snippet(updated_index_text, current_title)
        _refresh_note_entry_in_cache(
            current_title,
            updated_content,
            current_path,
            existing_tags=updated_tags,
            vector=updated_vector,
        )
        _register_finalized_note(current_path, updated_content)
        try:
            _notes_dir_mtime = NOTES_DIR.stat().st_mtime_ns
            _update_notes_cache_state(
                reloaded=False,
                disk_count=len(_notes_snapshot),
                reason="file_updated",
                dir_mtime=_notes_dir_mtime,
            )
        except Exception:
            pass


    except FileNotFoundError:
        logger.warning(f"File not found during processing: {event_path}")
    except Exception as e:
        import traceback
        logger.error(f"Error processing note update for {event_path}: {e}\n{traceback.format_exc()}")


def _handle_note_delete(event_path):
    try:
        path_obj = Path(event_path)
        title = note_relative_title(NOTES_DIR, path_obj, allow_missing_leaf=True)
    except Exception:
        logger.warning("Note deletion event has an unavailable or unsafe path")
        return
    if path_obj.suffix.lower() != ".md":
        return
    filename = path_obj.name
    filepath = str(path_obj)
    try:
        _delete_notes_in_qdrant(_note_identifier(title, filename, filepath))
    except Exception as exc:
        logger.warning("Failed to remove note from ANN index: %s", exc)
    with _notes_cache_lock:
        notes_data.pop(title, None)
        _notes_snapshot.pop(title, None)
    try:
        _update_notes_cache_state(
            reloaded=False,
            disk_count=len(_notes_snapshot),
            reason="file_deleted",
            dir_mtime=_notes_dir_mtime,
        )
    except Exception:
        pass


if PatternMatchingEventHandler is not None:
    class NoteChangeHandler(PatternMatchingEventHandler):
        def __init__(self):
            super().__init__(patterns=["*.md"], ignore_directories=True, case_sensitive=False)
            self._last_event = {}

        def on_any_event(self, event):
            now = time.time()
            key = (event.event_type, event.src_path)
            try:
                signature = _note_event_signature(Path(event.src_path))
            except Exception:
                signature = None

            last_entry = self._last_event.get(key) or {}
            last_sig = last_entry.get("sig")
            last_ts = float(last_entry.get("ts") or 0)
            # Ignore rapid duplicate watchdog events with the same signature,
            # but allow real changes (different signature) to reset the timer even if they are frequent.
            if signature is not None and last_sig is not None and signature == last_sig:
                if now - last_ts < 1.0:
                    return
            self._last_event[key] = {"sig": signature, "ts": now}

            if event.event_type in ('modified', 'created'):
                _schedule_debounced_note_update(event.src_path)
            elif event.event_type == 'moved':
                _cancel_scheduled_note_update(event.src_path)
                _schedule_debounced_note_update(event.dest_path, previous_path=event.src_path)
            elif event.event_type == 'deleted':
                _cancel_scheduled_note_update(event.src_path)
                _handle_note_delete(event.src_path)
else:
    NoteChangeHandler = None

def start_file_watcher():
    """Initializes and starts the file system watcher in a background thread."""
    if not UPDATE_ON_SAVE:
        logger.info("File watcher is disabled by UPDATE_ON_SAVE=0.")
        return

    if not all([Observer, PatternMatchingEventHandler, NoteChangeHandler]):
        logger.warning("Watchdog is not installed. File watcher is disabled.")
        return

    event_handler = NoteChangeHandler()
    observer = Observer()

    try:
        notes_dir_path = str(NOTES_DIR.resolve())
        observer.schedule(event_handler, notes_dir_path, recursive=True)
        # Who: Tim Buglaev
        # When: 2026-05-28
        # What: Started watchdog's Observer directly as its own daemon thread instead of nesting
        #       observer.start() inside another thread, fixing Python 3.13 _ThreadHandle crashes.
        try:
            observer.daemon = True
        except Exception:
            pass
        observer.start()

        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Use the shared path-log formatter so watcher logs stay readable in
        #       UTF-8 terminals and only escape Cyrillic for non-Unicode log sinks.
        formatter = globals().get("_format_path_for_log")
        display_notes_dir_path = formatter(notes_dir_path) if callable(formatter) else notes_dir_path
        logger.info("Started file watcher on directory: %s", display_notes_dir_path)

        # Let the daemon thread handle shutdown, atexit can be problematic on Windows
        # atexit.register(stop_observer)
        return observer

    except Exception as e:
        formatter = globals().get("_format_path_for_log")
        display_notes_dir = formatter(NOTES_DIR) if callable(formatter) else NOTES_DIR
        logger.error("Failed to start file watcher on %s: %s", display_notes_dir, e)
        return None

_notes_observer = None


def _activate_project_background():
    global _notes_observer
    _notes_observer = start_file_watcher()


# --- загрузка заметок при старте ---
if IS_TEST_ENV:
    try:
        _reload_notes_cache(force=True, reason="startup-test")
    except Exception as e:
        print(f"Ошибка при загрузке заметок (test env): {e}")

if not IS_TEST_ENV:
    try:
        _reload_notes_cache(force=True, reason="startup")
    except Exception as e:
        print(f"Ошибка при загрузке заметок: {e}")

    if _PROJECT_CONFIGURATION is None:
        _activate_project_background()


# Who: Tim Buglaev
# When: 2026-03-07
# What: Extracted note generation into a reusable synchronous function with a global generation lock so both
#       direct and queued API flows produce identical output while avoiding concurrent title/file write races.
