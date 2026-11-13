"""Local write endpoint for the note-stage pair selection."""

from contextlib import closing
import json
import os

from flask import Response, jsonify, request

from backend.local_request_guard import local_browser_request_allowed
from backend.ru_pipeline.config import get_config, runtime_directory
from backend.ru_pipeline.imported_models import MODEL_ID, ROLES, SHA, list_models
from backend.ru_pipeline.model_downloads import (
    DownloadError, _hub_file, download_size, imported_files, prepare_files, selected_files,
)
from backend.ru_pipeline.model_import import MAX_IMPORT_BYTES, import_model, parse_link, resolve_model
from backend.ru_pipeline.pair_settings import (
    DEFAULT_STAGE_ENABLED,
    MAX_SELECTION_BYTES,
    NewTags,
    decode_settings,
    load_settings,
    save_selection,
    selectable_pair,
)
from backend.ru_pipeline.scorer_contract import ScorerAssetError


def register_note_pipeline_route(app, runtime, runtime_payload):
    def check_request():
        # The desktop main process writes preferences. Local web pages cannot.
        browser_headers = ("Origin", "Referer", "Sec-Fetch-Site")
        if (
            any(header in request.headers for header in browser_headers)
            or not local_browser_request_allowed()
        ):
            return None, (jsonify(ok=False, code="local_access_required"), 403)
        if "NODA_OWNED_TITLE_PROFILE" in os.environ:
            return None, (jsonify(ok=False, code="note_pipeline_selection_locked"), 409)
        if getattr(runtime, "RU_NOTE_PIPELINE_ENABLED", False) is not True:
            return None, (jsonify(ok=False, code="note_pipeline_disabled"), 409)
        return None, None

    def read_selection():
        _, rejection = check_request()
        if rejection is not None:
            return None, rejection
        if not request.is_json:
            return None, (jsonify(ok=False, code="invalid_note_pipeline_selection"), 400)
        raw = request.stream.read(MAX_SELECTION_BYTES + 1)
        if len(raw) > MAX_SELECTION_BYTES:
            return None, (jsonify(ok=False, code="request_too_large"), 413)
        try:
            directory = runtime_directory(runtime)
            decoded = decode_settings(raw, list_models(directory))
            if not all(selectable_pair(directory, pair) for pair in decoded[0].values()):
                raise ValueError("Unavailable model in portable setup")
            return decoded, None
        except (ValueError, TypeError, RecursionError):
            return None, (jsonify(ok=False, code="invalid_note_pipeline_selection"), 400)

    def read_model_link(*, preview):
        _, rejection = check_request()
        if rejection is not None:
            return None, rejection
        if not request.is_json:
            return None, (jsonify(ok=False, code="import_url"), 400)
        raw = request.stream.read(MAX_IMPORT_BYTES + 1)
        if len(raw) > MAX_IMPORT_BYTES:
            return None, (jsonify(ok=False, code="import_url"), 413)
        try:
            payload = json.loads(raw)
            allowed = ({"url", "role"},) if preview else ({"url", "role"}, {"url", "role", "id"})
            if type(payload) is not dict or set(payload) not in allowed:
                raise ValueError
            role = payload["role"]
            if role not in ("generator", "reranker"):
                raise ValueError
            _, revision, filename = parse_link(payload["url"], role)
            if "id" in payload:
                key = payload["id"]
                if (not isinstance(key, str) or not MODEL_ID.fullmatch(key)
                        or not key.startswith(ROLES[role]) or not SHA.fullmatch(revision) or not filename):
                    raise ValueError
        except (DownloadError, ValueError, RecursionError):
            return None, (jsonify(ok=False, code="import_url"), 400)
        return payload, None

    @app.post("/runtime/note-pipeline/preview")
    def preview_note_pipeline_model():
        payload, rejection = read_model_link(preview=True)
        if rejection is not None:
            return rejection
        if not getattr(runtime, "_model_downloads_allowed", lambda: False)():
            return jsonify(ok=False, code="disabled"), 409
        try:
            config = get_config(runtime)
            item = resolve_model(payload["url"], payload["role"])
            pending, free = download_size(config, imported_files(config, item))
            primary = next(file for file in item.files if file.name.lower().endswith(
                (".gguf", ".safetensors", ".safetensors.index.json")))
            return jsonify(ok=True, model=item.option(), download_bytes=pending, disk_free_bytes=free,
                           url=_hub_file(item.repository, item.revision, primary.remote))
        except DownloadError as error:
            return jsonify(ok=False, code=error.code), 502 if error.code == "network" else 400
        except OSError:
            return jsonify(ok=False, code="storage"), 503
        except (KeyError, ValueError, TypeError, AttributeError, RecursionError, StopIteration):
            return jsonify(ok=False, code="import_unsupported"), 400

    @app.post("/runtime/note-pipeline/import")
    def import_note_pipeline_model():
        payload, rejection = read_model_link(preview=False)
        if rejection is not None:
            return rejection

        def events():
            try:
                permitted = getattr(runtime, "_model_downloads_allowed", lambda: False)
                with closing(import_model(get_config(runtime), payload["url"], payload["role"], permitted(),
                                          expected_id=payload.get("id"))) as updates:
                    for event in updates:
                        yield json.dumps(event, ensure_ascii=False) + "\n"
            except DownloadError as error:
                yield json.dumps({"state": "error", "code": error.code}) + "\n"
            except OSError:
                yield '{"state":"error","code":"storage"}\n'
            except (KeyError, ValueError, TypeError, AttributeError, RecursionError):
                yield '{"state":"error","code":"import_unsupported"}\n'

        return Response(events(), mimetype="application/x-ndjson", headers={"Cache-Control": "no-store"})

    @app.post("/runtime/note-pipeline")
    def update_note_pipeline_selection():
        result, rejection = read_selection()
        if rejection is not None:
            return rejection
        selection, new_tags, enabled = result
        try:
            save_selection(runtime_directory(runtime), selection, new_tags, stage_enabled=enabled)
        except (OSError, ValueError, TypeError, RecursionError):
            return jsonify(ok=False, code="note_pipeline_selection_unavailable"), 503
        return jsonify(ok=True, runtime=runtime_payload())

    @app.post("/runtime/note-pipeline/prepare")
    def prepare_note_pipeline_models():
        result, rejection = read_selection()
        if rejection is not None:
            return rejection
        selection, new_tags, enabled = result

        def line(payload):
            return json.dumps(payload, ensure_ascii=False) + "\n"

        def events():
            try:
                config = get_config(runtime)
                try:
                    _, stored_tags, stored_enabled, _ = load_settings(config.runtime_dir)
                except (ValueError, TypeError, RecursionError):
                    stored_tags, stored_enabled = NewTags(), DEFAULT_STAGE_ENABLED
                files = selected_files(config, selection, enabled or stored_enabled, new_tags or stored_tags)
                permitted = getattr(runtime, "_model_downloads_allowed", lambda: False)
                with closing(prepare_files(config, files, permitted())) as updates:
                    for event in updates:
                        yield line(event)
            except DownloadError as error:
                yield line({"state": "error", "code": error.code})
            except OSError:
                yield line({"state": "error", "code": "storage"})
            except (ScorerAssetError, KeyError, ValueError, TypeError, RecursionError):
                yield line({"state": "error", "code": "configuration"})
            else:
                yield line({"state": "done"})

        return Response(events(), mimetype="application/x-ndjson", headers={"Cache-Control": "no-store"})
