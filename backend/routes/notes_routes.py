from pathlib import Path
import os
import unicodedata
import re
from threading import RLock
import uuid
from typing import TYPE_CHECKING

from flask import jsonify, request, send_file

try:
    from backend.local_request_guard import register_local_request_guard
    from backend.note_read_refresh import refresh_cached_note_from_disk
    from backend.note_library_files import editable_content, edit_revision, list_trash, restore_note, trash_note, write_edited_body
    from backend.note_library_metadata import write_edited_metadata
    from backend.note_disk_source import NoteDiskSourceError, read_note_source
    from backend.semantic_embedding import semantic_model_status
    from backend.note_live_state import (
        NotesStateError, capture_note_search, capture_notes_state, note_content_revision,
        parse_live_query, parse_vault_query,
    )
except ImportError:
    from local_request_guard import register_local_request_guard
    from note_read_refresh import refresh_cached_note_from_disk
    from note_library_files import editable_content, edit_revision, list_trash, restore_note, trash_note, write_edited_body
    from note_library_metadata import write_edited_metadata
    from note_disk_source import NoteDiskSourceError, read_note_source
    from semantic_embedding import semantic_model_status
    from note_live_state import (
        NotesStateError, capture_note_search, capture_notes_state, note_content_revision,
        parse_live_query, parse_vault_query,
    )

if TYPE_CHECKING:
    from backend.note_display_title import note_display_title
else:
    try:
        from backend.note_display_title import note_display_title
    except ImportError:
        from note_display_title import note_display_title

MAX_MANAGED_NOTE_TITLE_CHARS = 160
MAX_MANAGED_NOTE_CONTENT_CHARS = 20000
MAX_MANAGED_NOTE_TAGS = 20
MAX_MANAGED_NOTE_TAG_CHARS = 64
MAX_NOTE_ASSET_PATH_CHARS = 512
ALLOWED_NOTE_ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
_FILENAME_FORBIDDEN_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
# Who: Tim Buglaev
# When: 2026-06-15
# What: Allow Obsidian nested tag paths through the notes API while keeping
#       validation bounded to safe word, dash, underscore, slash, and Cyrillic chars.
_TAG_VALUE_RE = re.compile(r"^[\w\-/\u0400-\u04FF]{1,64}$", re.UNICODE)
_WINDOWS_RESERVED_FILENAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{idx}" for idx in range(1, 10)),
    *(f"LPT{idx}" for idx in range(1, 10)),
}


# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted read-only notes endpoints from app.py into a dedicated routes module to separate HTTP
#       transport logic from domain services while preserving existing payload contracts.
def register_notes_routes(app, deps):
    register_local_request_guard(app)
    mutation_lock = RLock()

    @app.after_request
    def notes_read_cache_policy(response):
        if request.method == "GET" and request.endpoint in {"get_notes", "get_note"}:
            response.headers["Cache-Control"] = "no-store"
        return response

    def _find_note_by_title(module, raw_title):
        if raw_title in module.notes_data:
            return raw_title
        normalized = unicodedata.normalize("NFC", str(raw_title or "").strip()).casefold()
        if not normalized:
            return None
        matches = [
            key for key in module.notes_data
            if unicodedata.normalize("NFC", str(key).strip()).casefold() == normalized
        ]
        # Ambiguous names must never choose a file arbitrarily, especially for DELETE.
        return matches[0] if len(matches) == 1 else None

    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Added validated note-management helpers for the full notes panel so create/delete operations
    #       stay inside NOTES_DIR, reject malformed user input, and keep Qdrant identifiers deterministic.
    def _notes_root(module, create=False):
        root = Path(getattr(module, "NOTES_DIR", ""))
        if create:
            root.mkdir(parents=True, exist_ok=True)
        return root.resolve(strict=False)

    def _path_is_inside(root, candidate):
        try:
            root_value = str(Path(root).resolve(strict=False))
            candidate_value = str(Path(candidate).resolve(strict=False))
            return os.path.commonpath([root_value, candidate_value]) == root_value
        except Exception:
            return False

    def _sanitize_note_title(raw_title):
        if not isinstance(raw_title, str):
            raise ValueError("title must be a string")
        title = unicodedata.normalize("NFC", str(raw_title or "")).strip()
        title = re.sub(r"[\x00-\x1f\x7f]+", " ", title)
        title = re.sub(r"\s+", " ", title).strip(" .")
        if not title:
            raise ValueError("title is required")
        if len(title) > MAX_MANAGED_NOTE_TITLE_CHARS:
            raise ValueError(f"title is too long (max {MAX_MANAGED_NOTE_TITLE_CHARS} chars)")
        if _FILENAME_FORBIDDEN_RE.search(title) or title in (".", ".."):
            raise ValueError("title contains characters that are not allowed in note filenames")
        if title.split(".", 1)[0].rstrip().upper() in _WINDOWS_RESERVED_FILENAMES:
            raise ValueError("title is reserved by the operating system")
        return title

    def _validate_note_content(raw_content):
        if not isinstance(raw_content, str):
            raise ValueError("content must be a string")
        if not raw_content.strip():
            raise ValueError("content is required")
        if len(raw_content) > MAX_MANAGED_NOTE_CONTENT_CHARS:
            raise ValueError(f"content is too long (max {MAX_MANAGED_NOTE_CONTENT_CHARS} chars)")
        return raw_content

    def _normalize_tags(module, raw_tags):
        if raw_tags in (None, ""):
            return []
        if isinstance(raw_tags, str):
            tag_items = re.split(r"[,;\s]+", raw_tags)
        elif isinstance(raw_tags, (list, tuple)):
            tag_items = raw_tags
        else:
            raise ValueError("tags must be a list or comma-separated string")

        normalized = []
        for raw_tag in tag_items:
            if not isinstance(raw_tag, str):
                raise ValueError("tags must contain only strings")
            tag = unicodedata.normalize("NFC", str(raw_tag or "").strip().lstrip("#"))
            if not tag:
                continue
            if len(tag) > MAX_MANAGED_NOTE_TAG_CHARS or not _TAG_VALUE_RE.fullmatch(tag):
                raise ValueError("tags may contain only letters, numbers, underscores, and hyphens")
            normalized.append(tag)
            if len(normalized) > MAX_MANAGED_NOTE_TAGS:
                raise ValueError(f"too many tags (max {MAX_MANAGED_NOTE_TAGS})")
        return module._filter_tags(normalized)

    def _compose_note_body(module, title, content, tags):
        body = content
        stripped = body.lstrip()
        if not (stripped.startswith("#") or stripped.startswith("---")):
            body = f"# {title}\n\n{body}"
        if tags:
            body = module._ensure_tags_in_text(body, tags)
        return body

    def _make_unique_note_title(module, root, base_title):
        with module._notes_cache_lock:
            existing_titles = {str(title) for title in module.notes_data.keys()}
        candidate = base_title
        counter = 2
        while candidate in existing_titles or (root / f"{candidate}.md").exists():
            suffix = f" {counter}"
            base = base_title[: MAX_MANAGED_NOTE_TITLE_CHARS - len(suffix)].rstrip(" .")
            candidate = f"{base}{suffix}"
            counter += 1
        return candidate

    def _safe_qdrant_enabled(module):
        try:
            return bool(module._qdrant_enabled())
        except Exception:
            return False

    def _note_summary(module, title, data, qdrant=None, content_revision=None):
        item = data or {}
        filename = item.get("filename") or f"{title}.md"
        filepath = item.get("filepath") or item.get("path")
        note_id = item.get("id") or module._note_identifier(title, filename, filepath)
        if qdrant is None:
            qdrant = {"available": _safe_qdrant_enabled(module), "embedding_status": semantic_model_status(module)}
        indexed = qdrant["available"] and qdrant.get("embedding_status") not in {"disabled", "unavailable"}
        # Who: Tim Buglaev
        # When: 2026-06-13
        # What: Return clean note snippets in the management panel while preserving full raw
        #       Markdown content in detail responses for editing.
        cleaner = getattr(module, "_clean_note_text_for_rag", None)
        snippet_source = item.get("snippet") or item.get("content") or ""
        if callable(cleaner):
            snippet_source = cleaner(snippet_source) or snippet_source
        snippet = module._generate_snippet(snippet_source, title)
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Surface RAG-index exclusion status in the notes panel so noisy notes are
        #       visible/editable but not falsely reported as usable Qdrant context.
        index_status = "indexed" if indexed else "unavailable"
        noise_report = None
        noise_reporter = getattr(module, "_rag_note_noise_report", None)
        if callable(noise_reporter):
            try:
                noise_report = noise_reporter(title, item.get("content") or "", tags=item.get("tags"), clean_text=snippet_source)
                if noise_report.get("excluded"):
                    indexed = False
                    index_status = "excluded_noise"
            except Exception:
                noise_report = None
        return {
            "title": title,
            "display_title": note_display_title(title, item.get("content")),
            "content_revision": content_revision or note_content_revision(title, item),
            "tags": item.get("tags", []),
            "snippet": snippet,
            "filename": filename,
            "timestamp": item.get("timestamp"),
            "qdrant_id": note_id,
            "indexed": indexed,
            "index_status": index_status,
            "index_exclusion_reasons": (noise_report or {}).get("reasons") or [],
        }

    def _note_detail(module, requested_title, resolved_title, state):
        item = dict(state.notes)[resolved_title]
        payload = _note_summary(
            module, resolved_title, item,
            qdrant=state.qdrant,
            content_revision=state.content_revisions[resolved_title],
        )
        payload.update(
            {
                "title": requested_title,
                "resolved_title": resolved_title,
                "content": item.get("content") or "",
                "vault_id": state.vault_id,
            }
        )
        if item.get("filepath") or item.get("path"):
            payload["edit_revision"] = edit_revision(payload["content"])
            payload["editable_body"] = editable_content(payload["content"])[1]
        return payload

    def _write_note_atomic(file_path, content):
        tmp_path = file_path.with_name(f".{file_path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            tmp_path.write_bytes(content.encode("utf-8"))
            tmp_path.replace(file_path)
        finally:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except Exception:
                pass

    # Who: Tim Buglaev
    # When: 2026-06-16
    # What: Resolve read-only Obsidian attachment paths for the notes preview while
    #       keeping all asset access inside NOTES_DIR, limiting served extensions to
    #       images, and supporting the vault's common _resources attachment folder.
    def _normalize_note_asset_path(raw_asset_path):
        # Flask already URL-decodes path parameters. Percent/hash characters can be literal filenames.
        asset_path = unicodedata.normalize("NFC", str(raw_asset_path or "")).strip()
        asset_path = asset_path.replace("\\", "/").lstrip("/")
        if not asset_path:
            raise ValueError("asset path is required")
        if len(asset_path) > MAX_NOTE_ASSET_PATH_CHARS:
            raise ValueError("asset path is too long")
        if re.search(r"[\x00-\x1f\x7f]", asset_path) or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", asset_path):
            raise ValueError("asset path is not allowed")
        parts = [part for part in Path(asset_path).parts if part not in ("", ".")]
        if not parts or any(part == ".." for part in parts):
            raise PermissionError("asset path is outside NOTES_DIR")
        return Path(*parts)

    def _resolve_note_asset(module, raw_asset_path):
        root = _notes_root(module)
        relative_path = _normalize_note_asset_path(raw_asset_path)
        if relative_path.suffix.lower() not in ALLOWED_NOTE_ASSET_EXTENSIONS:
            raise ValueError("asset type is not supported")

        candidates = [root / relative_path]
        if len(relative_path.parts) == 1:
            candidates.append(root / "_resources" / relative_path.name)

        for candidate in candidates:
            resolved = candidate.resolve(strict=False)
            if not _path_is_inside(root, resolved):
                raise PermissionError("asset path is outside NOTES_DIR")
            if resolved.is_file():
                return resolved
        return None

    def _create_note(module, payload):
        if not isinstance(payload, dict):
            raise ValueError("JSON object is required")
        root = _notes_root(module, create=True)
        base_title = _sanitize_note_title(payload.get("title"))
        content = _validate_note_content(payload.get("content"))
        tags = _normalize_tags(module, payload.get("tags"))
        note_title = _make_unique_note_title(module, root, base_title)
        file_path = root / f"{note_title}.md"
        if not _path_is_inside(root, file_path):
            raise ValueError("resolved note path is outside NOTES_DIR")
        note_body = _compose_note_body(module, note_title, content, tags)

        _write_note_atomic(file_path, note_body)
        try:
            module._refresh_note_entry_in_cache(note_title, note_body, file_path, existing_tags=tags)
            try:
                module._register_finalized_note(file_path, note_body)
            except Exception:
                pass
        except Exception:
            try:
                file_path.unlink()
            except Exception:
                pass
            raise

        with module._notes_cache_lock:
            data = dict(module.notes_data.get(note_title) or {})
        return _note_summary(module, note_title, data)

    def _managed_note(module, raw_title):
        title = raw_title
        with module._notes_cache_lock:
            resolved_title = _find_note_by_title(module, title)
            note_data = dict(module.notes_data.get(resolved_title) or {}) if resolved_title is not None else {}

        if resolved_title is None:
            module._reload_notes_cache(reason="/notes/<title> delete")
            with module._notes_cache_lock:
                resolved_title = _find_note_by_title(module, title)
                note_data = dict(module.notes_data.get(resolved_title) or {}) if resolved_title is not None else {}
        if resolved_title is None:
            return None

        root = _notes_root(module)
        filename = note_data.get("filename") or f"{resolved_title}.md"
        filepath = note_data.get("filepath") or note_data.get("path") or str(root / filename)
        file_path = Path(filepath)
        if file_path.suffix.lower() != ".md" or not _path_is_inside(root, file_path):
            raise PermissionError("note file path is outside NOTES_DIR")
        return resolved_title, note_data, root, file_path

    def _refresh_after_write(module, title, file_path, body=None):
        try:
            if body is None:
                body = read_note_source(_notes_root(module), file_path)
            module._register_finalized_note(file_path, body)
            module._refresh_note_entry_in_cache(title, body, file_path)
            return True
        except Exception:
            app.logger.exception("Failed to refresh managed note after saving")
            return False

    def _edit_note(module, title, payload):
        if not isinstance(payload, dict):
            raise ValueError("JSON object is required")
        content, revision = payload.get("content"), payload.get("revision")
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision):
            raise ValueError("Invalid note revision")
        metadata_edit = "metadata" in payload
        if metadata_edit and set(payload) != {"metadata", "revision"}:
            raise ValueError("Metadata and body must be edited separately")
        if not metadata_edit and (not isinstance(content, str) or len(content) > 1_000_000 or "\0" in content):
            raise ValueError("Invalid note content")
        if not metadata_edit:
            content = content.replace("\r\n", "\n").replace("\r", "\n")
        managed = _managed_note(module, title)
        if managed is None:
            raise FileNotFoundError
        resolved, _, root, file_path = managed
        body = write_edited_metadata(root, file_path, payload["metadata"], revision) if metadata_edit \
            else write_edited_body(root, file_path, content, revision)
        return resolved, _refresh_after_write(module, resolved, file_path, body)

    def _delete_note(module, title):
        managed = _managed_note(module, title)
        if managed is None:
            return None
        resolved_title, note_data, root, file_path = managed
        trash_id = trash_note(root, file_path)

        note_id = note_data.get("id") or module._note_identifier(resolved_title, file_path.name, str(file_path))
        qdrant_deleted = False
        try:
            qdrant_deleted = bool(module._delete_notes_in_qdrant(note_id))
        except Exception:
            app.logger.warning("Failed to delete managed note from index")

        with module._notes_cache_lock:
            module.notes_data.pop(resolved_title, None)
            module._notes_snapshot.pop(resolved_title, None)
            try:
                module._qdrant_index_state.pop(note_id, None)
            except Exception:
                pass
            try:
                module._notes_dir_mtime = root.stat().st_mtime_ns
            except Exception:
                pass
            module._update_notes_cache_state(
                reloaded=False,
                disk_count=len(module._notes_snapshot),
                reason="/notes/<title> delete",
                dir_mtime=module._notes_dir_mtime,
            )

        return {
            "title": resolved_title,
            "qdrant_id": note_id,
            "file_deleted": True,
            "trash_id": trash_id,
            "qdrant_deleted": qdrant_deleted,
        }

    def _mutation_vault_error(module):
        expected = parse_vault_query(request.args)
        if expected is None:
            return None
        state = capture_notes_state(module, titles=())
        if expected != state.vault_id:
            return jsonify({"error": "Vault changed", "code": "vault_changed"}), 409
        return None

    @app.route("/notes", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def get_notes():
        module = deps.module
        if request.method == "POST":
            try:
                with mutation_lock:
                    if (error := _mutation_vault_error(module)) is not None:
                        return error
                    if "restore" in request.args:
                        root = _notes_root(module)
                        title, restored = restore_note(root, request.args["restore"])
                        updated = _refresh_after_write(module, title, restored)
                        return jsonify({"success": True, "title": title, "cache_updated": updated})
                    created = _create_note(module, request.get_json(silent=True))
            except FileExistsError:
                return jsonify({"error": "A note already exists at this path", "code": "restore_conflict"}), 409
            except FileNotFoundError:
                return jsonify({"error": "Trash entry or destination folder was not found", "code": "restore_missing"}), 404
            except PermissionError:
                return jsonify({"error": "Trash entry or destination is not accessible", "code": "restore_denied"}), 409
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except Exception as exc:
                app.logger.exception("Failed to create managed note: %s", exc)
                return jsonify({"error": "Failed to create note"}), 500
            return jsonify({"success": True, "note": created}), 201
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
        try:
            live, prior_revision, expected_vault = parse_live_query(request.args)
            query = request.args.get("q")
            if query is not None and (len(query) > 200 or not query.strip()):
                return jsonify({"error": "Invalid notes search query"}), 400
        except ValueError:
            return jsonify({"error": "Invalid live notes query"}), 400
        if query is not None:
            try:
                vault_id, entries = capture_note_search(module)
            except (NotesStateError, ValueError, TypeError):
                return jsonify({"error": "Notes cache is unavailable", "code": "notes_cache_unavailable"}), 503
            if expected_vault is not None and expected_vault != vault_id:
                return jsonify({"error": "Vault changed", "code": "vault_changed"}), 409
            needle = unicodedata.normalize("NFC", query.strip()).casefold()

            def matches(value):
                return needle in unicodedata.normalize("NFC", value).casefold()

            titles = [title for title, content, tags in entries if matches(title)
                      or any(matches(f"#{tag}") for tag in tags) or matches(editable_content(content)[1])
                      or matches(note_display_title(title, content))]
            return jsonify({"titles": titles, "vault_id": vault_id})
        try:
            if not live and request.args.get("trash") != "1":
                module._reload_notes_cache(reason="/notes")
            state = capture_notes_state(
                module, titles=() if request.args.get("trash") == "1" else None,
                qdrant_available=None if live else _safe_qdrant_enabled(module)
            )
        except (NotesStateError, NoteDiskSourceError, OSError, ValueError, TypeError):
            return jsonify({"error": "Notes cache is unavailable", "code": "notes_cache_unavailable"}), 503
        if (live or expected_vault is not None) and state.vault_id is None:
            return jsonify({"error": "Notes vault is unavailable", "code": "notes_cache_unavailable"}), 503
        if expected_vault is not None and expected_vault != state.vault_id:
            return jsonify({"error": "Vault changed", "code": "vault_changed", "vault_id": state.vault_id}), 409
        context = {"vault_id": state.vault_id, "revision": state.revision}
        if request.args.get("trash") == "1":
            try:
                with mutation_lock:
                    return jsonify({"items": list_trash(_notes_root(module)), **context})
            except OSError:
                return jsonify({"error": "Trash is unavailable", "code": "trash_unavailable"}), 503
        if live and prior_revision == state.revision:
            return jsonify({"unchanged": True, **context})
        notes_list = [
            _note_summary(
                module, title, data, qdrant=state.qdrant,
                content_revision=state.content_revisions[title],
            )
            for title, data in state.notes
        ]
        return jsonify({"notes": notes_list, "qdrant": state.qdrant, **context})

    @app.route("/tags", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def get_tags():
        module = deps.module
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
        module._reload_notes_cache(reason="/tags")
        with module._notes_cache_lock:
            all_tags = sorted(
                {
                    tag
                    for data in module.notes_data.values()
                    for tag in data.get("tags", [])
                    if tag
                }
            )
        return jsonify({"tags": all_tags})

    @app.route("/notes/assets/<path:asset_path>", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def get_note_asset(asset_path):
        module = deps.module
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
        try:
            resolved_asset = _resolve_note_asset(module, asset_path)
        except PermissionError as exc:
            return jsonify({"error": str(exc)}), 403
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            app.logger.warning("Failed to resolve note asset path=%s error=%s", asset_path, exc)
            return jsonify({"error": "Failed to resolve note asset"}), 500
        if resolved_asset is None:
            return jsonify({"error": "Asset not found"}), 404
        return send_file(resolved_asset, conditional=True, max_age=3600)

    @app.route("/note-detail/<path:title>", methods=["GET", "DELETE", "PATCH"])
    @app.route("/notes/<path:title>", methods=["GET", "DELETE", "PATCH"])
    def get_note(title):
        module = deps.module

        if request.method in {"DELETE", "PATCH"}:
            try:
                with mutation_lock:
                    if (error := _mutation_vault_error(module)) is not None:
                        return error
                    if request.method == "PATCH":
                        resolved, updated = _edit_note(module, title, request.get_json(silent=True))
                        return jsonify({"success": True, "title": resolved, "cache_updated": updated})
                    deleted = _delete_note(module, title)
            except FileExistsError:
                return jsonify({"error": "Note changed on disk", "code": "note_edit_conflict"}), 409
            except FileNotFoundError:
                return jsonify({"error": "Note not found"}), 404
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except PermissionError as exc:
                return jsonify({"error": str(exc)}), 409
            except Exception:
                app.logger.exception("Failed to update managed note")
                return jsonify({"error": "Failed to update note"}), 500
            if deleted is None:
                return jsonify({"error": "Note not found"}), 404
            return jsonify({"success": True, "deleted": deleted})

        try:
            expected_vault = parse_vault_query(request.args)
        except ValueError:
            return jsonify({"error": "Invalid expected vault identifier"}), 400
        try:
            initial = capture_notes_state(module, titles=())
        except (NotesStateError, ValueError, TypeError):
            return jsonify({"error": "Notes cache is unavailable", "code": "notes_cache_unavailable"}), 503
        if expected_vault is not None and initial.vault_id is None:
            return jsonify({"error": "Notes vault is unavailable", "code": "notes_cache_unavailable"}), 503
        if expected_vault is not None and expected_vault != initial.vault_id:
            return jsonify({"error": "Vault changed", "code": "vault_changed", "vault_id": initial.vault_id}), 409
        with module._notes_cache_lock:
            resolved_title = _find_note_by_title(module, title)
        if resolved_title is None:
            module._reload_notes_cache(reason="/notes/<title>")
        else:
            try:
                refresh_cached_note_from_disk(module, resolved_title)
            except PermissionError:
                return jsonify({"error": "Note file is not accessible"}), 403
            except Exception:
                app.logger.exception("Failed to refresh note from disk")
                return jsonify({"error": "Failed to refresh note"}), 500
        qdrant_available = _safe_qdrant_enabled(module)
        try:
            with module._notes_cache_lock:
                resolved_title = _find_note_by_title(module, title)
                state = capture_notes_state(
                    module, titles=() if resolved_title is None else (resolved_title,),
                    qdrant_available=qdrant_available,
                )
            if expected_vault is not None and state.vault_id is None:
                return jsonify({"error": "Notes vault is unavailable", "code": "notes_cache_unavailable"}), 503
            if expected_vault is not None and expected_vault != state.vault_id:
                return jsonify({"error": "Vault changed", "code": "vault_changed", "vault_id": state.vault_id}), 409
            if resolved_title is not None:
                return jsonify(_note_detail(module, title, resolved_title, state))
        except (NotesStateError, ValueError, TypeError):
            return jsonify({"error": "Notes cache is unavailable", "code": "notes_cache_unavailable"}), 503
        return jsonify({"error": "Note not found"}), 404
