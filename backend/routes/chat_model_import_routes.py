"""Desktop-only inspection and download of public Hugging Face chat weights."""

from contextlib import closing
import json
import math
import os
import re

from flask import Response, jsonify, request

from backend.local_request_guard import local_browser_request_allowed
from backend.model_catalog import PORTABLE_CHAT_ID
from backend.ru_pipeline.config import get_config, portable_runtime_root
from backend.ru_pipeline.imported_models import SHA, list_models
from backend.ru_pipeline.model_downloads import (
    DownloadError, _hub_file, download_size, imported_files, model_files, prepare_files,
)
from backend.ru_pipeline.model_import import MAX_IMPORT_BYTES, import_model, parse_link, resolve_model


_CHAT_ID = re.compile(r"hfc_[a-f0-9]{16}")
_METADATA_ERRORS = (ValueError, TypeError, KeyError, AttributeError, RecursionError)


def _catalog_entry(item):
    weights = sum(file.size for file in item.files)
    if weights > (1 << 53) - 1:
        raise DownloadError("import_unsupported")
    weight_gib = weights / (1 << 30)
    quantization = re.search(r"(?:^|[-.])((?:I?Q|TQ)[1-9][A-Z0-9_]*|[BF]F?16|F32)(?:[-.]|$)",
                             item.files[0].name, re.IGNORECASE)
    return {
        "id": item.id,
        "name": item.repository,
        "hf_model_id": item.repository,
        "gguf_filename": item.files[0].name,
        "artifact": "gguf",
        "model_format": "llama_cpp",
        "quantization": quantization[1].upper() if quantization else None,
        "estimated_download_gb": weights / 1e9,
        "memory_type": "ram",
        "min_memory_gb": math.ceil(weight_gib * 1.15 + 2),
        "recommended_memory_gb": math.ceil(weight_gib * 1.35 + 4),
        "imported": True,
    }


def chat_models(runtime, active):
    try:
        config = get_config(runtime)
        items = list_models(config.runtime_dir, chat=True)
    except (OSError, ValueError, RecursionError):
        return []
    active_path = os.path.normcase(os.path.normpath(str(active or "")))
    result = []
    for item in items.values():
        try:
            files = imported_files(config, item)
            if not all(file.present() for file in files):
                continue
            path = str(files[0].target)
            entry = _catalog_entry(item)
        except (DownloadError, OSError, ValueError):
            continue
        result.append({**entry, "local_path": path, "downloaded": True,
                       "active": os.path.normcase(path) == active_path})
    return result


def register_chat_model_import(app, runtime):
    def validate(*keys):
        if (any(name in request.headers for name in ("Origin", "Referer", "Sec-Fetch-Site"))
                or not local_browser_request_allowed()):
            raise DownloadError("local_access_required")
        if "NODA_OWNED_TITLE_PROFILE" in os.environ or not getattr(runtime, "_model_downloads_allowed", lambda: False)():
            raise DownloadError("disabled")
        if not request.is_json:
            raise DownloadError("import_url")
        raw = request.stream.read(MAX_IMPORT_BYTES + 1)
        if len(raw) > MAX_IMPORT_BYTES:
            raise DownloadError("request_too_large")
        payload = json.loads(raw)
        if type(payload) is not dict or set(payload) != set(keys):
            raise DownloadError("import_url")
        return payload

    def failure(code):
        status = {"local_access_required": 403, "disabled": 409, "request_too_large": 413,
                  "network": 502, "storage": 503}.get(code, 400)
        return jsonify(ok=False, code=code), status

    @app.post("/models/chat-import/preview")
    def preview_chat_model():
        try:
            payload = validate("url")
            item = resolve_model(payload["url"], "chat")
            config = get_config(runtime)
            entry = _catalog_entry(item)
            pending, free = download_size(config, imported_files(config, item))
        except DownloadError as error:
            return failure(error.code)
        except OSError:
            return failure("storage")
        except _METADATA_ERRORS:
            return failure("import_unsupported")
        return jsonify(ok=True, model=entry, download_bytes=pending, disk_free_bytes=free,
                       url=_hub_file(item.repository, item.revision, item.files[0].remote))

    @app.post("/models/chat-import/download")
    def download_chat_model():
        try:
            payload = validate("url", "id")
            _, revision, filename = parse_link(payload["url"], "chat")
            if not (SHA.fullmatch(revision) and filename and isinstance(payload["id"], str)
                    and _CHAT_ID.fullmatch(payload["id"])):
                raise DownloadError("import_url")
        except DownloadError as error:
            return failure(error.code)
        except _METADATA_ERRORS:
            return failure("import_url")

        def events():
            try:
                with closing(import_model(get_config(runtime), payload["url"], "chat", True,
                                          expected_id=payload["id"])) as updates:
                    for event in updates:
                        yield json.dumps(event, ensure_ascii=False) + "\n"
            except DownloadError as error:
                yield json.dumps({"state": "error", "code": error.code}) + "\n"
            except OSError:
                yield '{"state":"error","code":"storage"}\n'
            except _METADATA_ERRORS:
                yield '{"state":"error","code":"import_unsupported"}\n'

        return Response(events(), mimetype="application/x-ndjson", headers={"Cache-Control": "no-store"})

    @app.post("/models/chat-preset/download")
    def download_portable_chat_preset():
        try:
            payload = validate("id")
            if portable_runtime_root() is None or payload["id"] != PORTABLE_CHAT_ID:
                raise DownloadError("import_unsupported")
        except DownloadError as error:
            return failure(error.code)
        except _METADATA_ERRORS:
            return failure("import_unsupported")

        def events():
            try:
                config = get_config(runtime)
                files = model_files(config, "generator", "qwen35_4b")
                with closing(prepare_files(config, files, True)) as updates:
                    for event in updates:
                        yield json.dumps(event, ensure_ascii=False) + "\n"
            except DownloadError as error:
                yield json.dumps({"state": "error", "code": error.code}) + "\n"
            except OSError:
                yield '{"state":"error","code":"storage"}\n'
            except _METADATA_ERRORS:
                yield '{"state":"error","code":"configuration"}\n'
            else:
                yield '{"state":"done"}\n'

        return Response(events(), mimetype="application/x-ndjson", headers={"Cache-Control": "no-store"})
