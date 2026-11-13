"""Strict metadata for an explicit, same-identity source recovery operation."""

import hashlib
import math
import re


STATES = frozenset(("queued", "processing", "completed", "failed", "conflict"))
ACTIVE_STATES = ("queued", "processing", "conflict")
_ID = re.compile(r"[a-f0-9]{32}\Z")
_HASH = re.compile(r"[a-f0-9]{64}\Z")


def is_source_saved(job):
    result = job.get("result")
    metadata = result.get("generation") if type(result) is dict else None
    return (
        job.get("status") == "completed"
        and job.get("phase") == "completed"
        and job.get("mode", "organize") == "organize"
        and type(metadata) is dict
        and metadata.get("metadata_pending") is True
        and result.get("content") == job.get("raw_source")
        and result.get("tags") == []
        and result.get("links") == []
    )


def validate_recovery(value, job):
    if value is None:
        return
    keys = {
        "version",
        "target",
        "expected",
        "original_result",
        "original_index_pending",
        "request_id",
        "requested_at",
        "retry_count",
        "state",
        "new_sha256",
        "backup_size",
    }
    if (
        type(value) is not dict
        or set(value) != keys
        or type(value.get("version")) is not int
        or value["version"] != 1
    ):
        raise ValueError("Invalid source recovery record")
    target = value["target"]
    if (
        type(target) is not str
        or not target.endswith(".md")
        or len(target) > 250
        or any(char in target for char in "/\\:\x00")
        or type(value["request_id"]) is not str
        or not _ID.fullmatch(value["request_id"])
        or type(value["state"]) is not str
        or value["state"] not in STATES
        or type(value["retry_count"]) is not int
        or not 1 <= value["retry_count"] <= 1000000
        or type(value["requested_at"]) not in (int, float)
        or not math.isfinite(value["requested_at"])
        or value["requested_at"] < 0
        or type(value["original_index_pending"]) is not bool
    ):
        raise ValueError("Invalid source recovery identity")
    proof = value["expected"]
    source = job["raw_source"].encode("utf-8")
    if (
        type(proof) is not dict
        or set(proof) != {"identity", "size", "mtime_ns", "sha256"}
        or type(proof["identity"]) is not list
        or len(proof["identity"]) != 2
        or any(type(part) is not int or part < 0 for part in proof["identity"])
        or type(proof["size"]) is not int
        or proof["size"] != len(source)
        or type(proof["mtime_ns"]) is not int
        or proof["mtime_ns"] < 0
        or proof["sha256"] != hashlib.sha256(source).hexdigest()
        or type(value["backup_size"]) is not int
        or value["backup_size"] != len(source)
    ):
        raise ValueError("Invalid source recovery proof")
    old = value["original_result"]
    if (
        type(old) is not dict
        or old.get("content") != job["raw_source"]
        or old.get("tags") != []
        or old.get("links") != []
        or type(old.get("title")) is not str
        or old["title"] + ".md" != target
        or type(old.get("generation")) is not dict
        or old["generation"].get("metadata_pending") is not True
    ):
        raise ValueError("Invalid source recovery receipt")
    new_hash = value["new_sha256"]
    if new_hash is not None and (
        type(new_hash) is not str or not _HASH.fullmatch(new_hash)
    ):
        raise ValueError("Invalid source recovery publication hash")
    state, status, phase = value["state"], job["status"], job["phase"]
    expected_status = {
        "queued": "queued",
        "processing": "processing",
        "completed": "completed",
        "failed": "completed",
        "conflict": "failed",
    }[state]
    if status != expected_status or (
        state == "queued"
        and phase != "queued"
        or state in ("completed", "failed")
        and phase != "completed"
        or state == "conflict"
        and phase != "publication_unknown"
    ):
        raise ValueError("Inconsistent source recovery state")
    if state == "failed" and not is_source_saved(job):
        raise ValueError("Missing saved source after recovery failure")
    if (
        phase in ("publish_intent", "published", "completed")
        and job.get("target") != target
    ):
        raise ValueError("Recovered canonical target changed")
    if phase in ("published", "completed"):
        result, draft = job.get("result"), job.get("draft")
        if (
            type(result) is not dict
            or type(draft) is not dict
            or type(result.get("title")) is not str
            or result["title"] + ".md" != target
            or result.get("tags") != draft.get("tags")
            or result.get("links") != draft.get("links")
        ):
            raise ValueError("Recovered receipt identity changed")
    if state in ("processing", "completed") and phase != "generating":
        _validate_prepared_source(job)
        if phase in ("publish_intent", "published", "completed") and (
            new_hash
            != hashlib.sha256(job["draft"]["content"].encode("utf-8")).hexdigest()
        ):
            raise ValueError("Invalid recovered result hash")


def _validate_prepared_source(job):
    from backend.note_faithful_archive import wrapper_metadata
    from backend.note_generation_contract import NoteGenerationError

    draft = job.get("draft")
    try:
        if type(draft) is not dict or type(draft.get("content")) is not str:
            raise ValueError("Missing recovery draft")
        metadata, source = wrapper_metadata(draft["content"])
        if (
            metadata is None
            or source != job["raw_source"]
            or metadata["tags"] != draft.get("tags")
            or metadata["related"] != draft.get("links")
            or type(draft.get("generation")) is not dict
            or draft["generation"].get("metadata_pending") is True
        ):
            raise ValueError("Recovered draft changed the source")
    except (TypeError, NoteGenerationError) as exc:
        raise ValueError("Invalid recovery draft") from exc


def public_recovery(job):
    recovery = job.get("recovery")
    summary = (
        None
        if recovery is None
        else {
            key: recovery[key] for key in ("request_id", "requested_at", "retry_count")
        }
    )
    if summary is not None:
        summary["status"] = recovery["state"]
    return {
        "retry_available": is_source_saved(job)
        and (recovery is None or recovery["state"] == "failed"),
        "recovery_summary": summary,
    }
