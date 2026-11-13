"""Validate persisted job records before scheduling or exposing them."""

import math
import re

from .note_job_progress import validate_error, validate_progress
from .source_recovery_record import validate_recovery

try:
    from backend.note_processing_mode import MODES, PROCESSING_VERSION
except ImportError:
    from note_processing_mode import MODES, PROCESSING_VERSION


_ID = re.compile(r"[a-f0-9]{32}\Z")
_PHASES = {
    "queued": {"queued"},
    "processing": {
        "generating",
        "preparing",
        "prepared",
        "publish_intent",
        "published",
    },
    "completed": {"completed"},
    "failed": {
        "queue_full",
        "invalid_request_id",
        "invalid_source",
        "invalid_mode",
        "request_conflict",
        "store_unavailable",
        "storage_quota",
        "publication_unknown",
        "publication_failed",
        "generation_failed",
        "retry_exhausted",
        "vault_changed",
    },
}


def _draft(value):
    if not isinstance(value, dict):
        raise ValueError("Invalid result object")
    if not isinstance(value.get("title"), str) or not value["title"].strip():
        raise ValueError("Invalid result title")
    if not isinstance(value.get("content"), str) or not value["content"]:
        raise ValueError("Invalid result content")
    for field in ("tags", "links"):
        if not isinstance(value.get(field), list) or not all(
            isinstance(item, str) for item in value[field]
        ):
            raise ValueError("Invalid result metadata")


def validate_job_record(value):
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("job_id"), str)
        or not _ID.fullmatch(value["job_id"])
    ):
        raise ValueError("Invalid job ID")
    status = value.get("status")
    if status not in _PHASES or value.get("phase") not in _PHASES[status]:
        raise ValueError("Invalid job state")
    if value.get("progress") is not None:
        validate_progress(value["progress"])
    validate_error(value.get("processing_error"))
    if (
        not isinstance(value.get("raw_source"), str)
        or not value["raw_source"].strip()
        or len(value["raw_source"]) > 65536
    ):
        raise ValueError("Invalid raw source")
    if value.get("prompt") != value["raw_source"].strip():
        raise ValueError("Inconsistent normalized source")
    validate_recovery(value.get("recovery"), value)
    if "mode" in value and (
        not isinstance(value["mode"], str)
        or value["mode"] not in MODES
        or value.get("processing_version") != PROCESSING_VERSION
    ):
        raise ValueError("Invalid processing mode or version")
    if "processing_version" in value and "mode" not in value:
        raise ValueError("Missing processing mode")
    if type(value.get("attempts")) is not int or not 0 <= value["attempts"] <= 5:
        raise ValueError("Invalid attempt count")
    if (
        type(value.get("source_provided")) is not bool
        or type(value.get("retryable")) is not bool
    ):
        raise ValueError("Invalid boolean metadata")
    key = value.get("client_request_id")
    if key is not None and (not isinstance(key, str) or not _ID.fullmatch(key)):
        raise ValueError("Invalid request ID")
    for field in ("created_at", "next_attempt_at"):
        number = value.get(field)
        if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
            raise ValueError("Invalid timestamp")
    if value["phase"] in {
        "preparing",
        "prepared",
        "publish_intent",
        "published",
        "completed",
    }:
        _draft(value.get("draft"))
    if value["phase"] in {"prepared", "publish_intent", "published", "completed"}:
        identity = value.get("prepared_identity")
        if (
            not isinstance(identity, list)
            or len(identity) != 2
            or any(type(part) is not int or part < 0 for part in identity)
        ):
            raise ValueError("Invalid file identity")
    if value["phase"] in {"publish_intent", "published", "completed"}:
        name = value.get("target")
        if (
            not isinstance(name, str)
            or not name.endswith(".md")
            or any(char in name for char in "/\\:\x00")
        ):
            raise ValueError("Invalid publication path")
    if value["phase"] in {"published", "completed"}:
        _draft(value.get("result"))
        if value["result"]["content"] != value["draft"]["content"]:
            raise ValueError("Published content changed in journal")
