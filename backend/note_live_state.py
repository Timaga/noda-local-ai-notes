"""Read-only cache snapshots and opaque revisions; no filesystem or model access."""

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import os
import re
import uuid

try:
    from backend.semantic_embedding import semantic_model_status
except ImportError:
    from semantic_embedding import semantic_model_status


_VAULT_ID = re.compile(r"[a-f0-9]{32}\Z")
_REVISION = re.compile(r"[a-f0-9]{64}\Z")
_ENTRY_FIELDS = (
    "content",
    "tags",
    "filename",
    "filepath",
    "path",
    "timestamp",
    "snippet",
    "id",
)
_PRESENTATION_SETTINGS = (
    "RAG_SNIPPET_LENGTH",
    "RAG_MAX_INDEX_TEXT_CHARS",
    "RAG_NOISE_MAX_TAGS_PER_NOTE",
    "RAG_NOISE_REPEATED_TAG_THRESHOLD",
    "RAG_NOISE_MIN_TOKENS",
    "RAG_NOISE_DUPLICATE_TOKEN_RATIO",
)


class NotesStateError(RuntimeError):
    """The current vault and its cache cannot be safely associated."""


def parse_vault_query(args):
    if "expected_vault_id" not in args:
        return None
    values = args.getlist("expected_vault_id")
    if len(values) != 1 or not _VAULT_ID.fullmatch(values[0]):
        raise ValueError("Invalid expected vault identifier")
    return values[0]


def parse_live_query(args):
    expected = parse_vault_query(args)
    if "live" not in args and "if_revision" not in args:
        return False, None, expected
    if (
        set(args) - {"live", "if_revision", "expected_vault_id"}
        or args.getlist("live") != ["1"]
        or "if_revision" in args
        and (
            len(args.getlist("if_revision")) != 1
            or not _REVISION.fullmatch(args["if_revision"])
        )
    ):
        raise ValueError("Invalid live notes query")
    return True, args.get("if_revision"), expected


def _lexical_path(value):
    # resolve()/stat() would turn a cache poll into a filesystem operation.
    if not isinstance(value, (str, os.PathLike)):
        return None
    raw = os.fspath(value)
    if not isinstance(raw, str) or not raw or "\0" in raw:
        return None
    if not isinstance(value, str) and not os.path.isabs(raw):
        # Incomplete PathLike fixtures can synthesize names unrelated to a vault.
        return None
    return os.path.normcase(os.path.abspath(raw))


def _vault_context(module):
    root = _lexical_path(getattr(module, "NOTES_DIR", None))
    if root is None:
        return None, None
    store = getattr(getattr(module, "note_generation_queue", None), "store", None)
    queue_id = getattr(store, "vault_id", None)
    if (
        _lexical_path(getattr(store, "vault", None)) == root
        and isinstance(queue_id, str)
        and _VAULT_ID.fullmatch(queue_id)
    ):
        return root, queue_id
    return root, uuid.uuid5(uuid.NAMESPACE_URL, "noda-notes-vault-v1:" + root).hex


def _entry_copy(data):
    source = data or {}
    return {key: deepcopy(source[key]) for key in _ENTRY_FIELDS if key in source}


def _inside(root, entry):
    value = entry.get("filepath") or entry.get("path")
    if not value or root is None:
        return True  # Explicit in-memory fixtures have no filesystem ownership.
    filename = _lexical_path(value)
    try:
        return filename != root and os.path.commonpath((root, filename)) == root
    except (ValueError, TypeError):
        return False


def _cached_qdrant(module):
    service = getattr(module, "qdrant_service", None)
    health = getattr(module, "_qdrant_health_cache", None)
    available = bool(
        getattr(module, "use_qdrant", False)
        and service is not None
        and isinstance(health, dict)
        and health.get("status") is True
        and health.get("service_id") == id(service)
    )
    result = {
        "available": available,
        "collection": getattr(service, "collection_name", None),
    }
    embedding_status = semantic_model_status(module)
    if embedding_status is not None:
        result["embedding_status"] = embedding_status
    return result


def _digest(value):
    digest = hashlib.sha256()
    # Streaming serialization avoids constructing another whole-corpus string.
    encoder = json.JSONEncoder(sort_keys=True, ensure_ascii=True, allow_nan=False)
    for chunk in encoder.iterencode(value):
        digest.update(chunk.encode("utf-8"))
    return digest.hexdigest()


def note_content_revision(title, entry, presentation=None):
    return _digest(["noda-note-content-v1", title, _entry_copy(entry), presentation])


def capture_note_search(module):
    """Capture immutable search fields without hashing or reindexing note bodies."""
    with module._notes_cache_lock:
        root, vault = _vault_context(module)
        entries = tuple(
            (title, entry.get("content") or "", tuple(entry.get("tags") or ()))
            for title, entry in module.notes_data.items()
            if _inside(root, entry)
        )
        if (root, vault) != _vault_context(module):
            raise NotesStateError("Notes cache is changing vault")
    return vault, entries


@dataclass(frozen=True)
class NotesState:
    root: str | None
    vault_id: str | None
    notes: tuple
    qdrant: dict
    revision: str
    content_revisions: dict


def capture_notes_state(module, *, qdrant_available=None, titles=None):
    """Capture root, private entry copies and fingerprints under the cache lock."""
    with module._notes_cache_lock:
        before = _vault_context(module)
        source = module.notes_data
        entries = (
            source.items()
            if titles is None
            else ((title, source[title]) for title in titles if title in source)
        )
        notes = tuple((title, _entry_copy(data)) for title, data in entries)
        qdrant = _cached_qdrant(module)
        if qdrant_available is not None:
            qdrant["available"] = bool(qdrant_available)
        settings = {key: getattr(module, key, None) for key in _PRESENTATION_SETTINGS}
        index = getattr(module, "_qdrant_index_state", None)
        index_metadata = (
            sorted((key, deepcopy(value)) for key, value in list(index.items()))
            if isinstance(index, dict)
            else []
        )
        if before != _vault_context(module) or any(
            not _inside(before[0], entry) for _, entry in notes
        ):
            raise NotesStateError("Notes cache is changing vault")
        presentation = [qdrant, settings]
        revisions = {
            title: note_content_revision(title, entry, presentation)
            for title, entry in notes
        }
        revision = _digest(
            [
                "noda-notes-cache-v1",
                before[1],
                presentation,
                index_metadata,
                sorted(revisions.items()),
            ]
        )
        return NotesState(before[0], before[1], notes, qdrant, revision, revisions)
