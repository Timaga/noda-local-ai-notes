"""All-or-restore metadata refresh of existing notes with exact source checks."""

from contextlib import ExitStack
import hashlib
from pathlib import Path

from backend.note_faithful_archive import snapshot_archive, wrapper_metadata
from backend.generated_text_language import validate_note_output
from backend.services.windows_note_file import locked_note


def refresh_metadata(notes_dir, expected, drafts):
    """Preserve note paths and source bytes; reject stale plans before any write."""
    if (
        not isinstance(expected, dict)
        or not isinstance(drafts, dict)
        or not expected
        or len(expected) > 64
        or set(expected) != set(drafts)
    ):
        raise ValueError("Expected exactly one revision for every draft")
    root = Path(notes_dir).absolute()
    records = {record.id: record for record in snapshot_archive(root)}
    if not set(drafts) <= records.keys():
        raise ValueError("Unknown note identity")
    bodies = {}
    for identity, draft in drafts.items():
        record = records[identity]
        if record.disk_sha256 != expected[identity]:
            raise FileExistsError("Note changed since the refresh was prepared")
        validate_note_output(draft)
        metadata, source = wrapper_metadata(draft["content"])
        if metadata is None or source != record.source:
            raise ValueError("Metadata refresh must preserve the exact full source")
        if metadata["tags"] != draft["tags"] or metadata["related"] != draft["links"]:
            raise ValueError("Metadata and draft disagree")
        if identity in draft["links"] or not set(draft["links"]) <= records.keys():
            raise ValueError("Metadata refresh contains a dangling or self link")
        bodies[identity] = draft["content"].encode("utf-8")
    with ExitStack() as stack:
        handles, originals = {}, {}
        for identity in sorted(drafts):
            handles[identity] = stack.enter_context(
                locked_note(Path(records[identity].filepath))
            )
            originals[identity] = handles[identity].read_all()
            if hashlib.sha256(originals[identity]).hexdigest() != expected[identity]:
                raise FileExistsError("Note changed while opening the refresh")
        written = []
        try:
            for identity in sorted(drafts):
                written.append(identity)
                handles[identity].write_all(bodies[identity])
        except BaseException:
            for identity in reversed(written):
                handles[identity].write_all(originals[identity])
            raise
    return {
        identity: hashlib.sha256(body).hexdigest() for identity, body in bodies.items()
    }
