"""User-owned title/tag edits without changing a note's path or source bytes."""

import json
import re
import unicodedata

try:
    from backend.note_disk_source import read_note_source
    from backend.note_faithful_archive import current_wrapper_metadata
    from backend.note_library_files import (
        editable_content,
        edit_revision,
        write_note_source,
    )
except ImportError:
    from note_disk_source import read_note_source
    from note_faithful_archive import current_wrapper_metadata
    from note_library_files import editable_content, edit_revision, write_note_source


_HEADER = re.compile(
    r"\A(?:\ufeff)?---[ \t]*\r?\n(.*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)", re.M | re.S
)
_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*?)(?:\r?\n)?$")
_TAG = re.compile(r"[\w-]+(?:/[\w-]+)*\Z", re.UNICODE)


def validate_metadata(payload):
    if not isinstance(payload, dict) or set(payload) != {"title", "tags"}:
        raise ValueError("Metadata requires title and tags")
    title, tags = payload["title"], payload["tags"]
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160:
        raise ValueError("Title must contain 1 to 160 characters")
    if any(unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"} for char in title):
        raise ValueError("Title cannot contain control characters")
    title = unicodedata.normalize("NFC", title.strip())
    if not isinstance(tags, list) or len(tags) > 20:
        raise ValueError("Tags must be a list of at most 20 values")
    normalized, seen = [], set()
    for tag in tags:
        if not isinstance(tag, str):
            raise ValueError("Tags must contain text")
        tag = unicodedata.normalize("NFC", tag).casefold()
        if (
            not 1 <= len(tag) <= 64
            or not _TAG.fullmatch(tag)
            or not any(char.isalpha() for char in tag)
        ):
            raise ValueError("Invalid tag")
        if tag.casefold() in seen:
            raise ValueError("Duplicate tag")
        seen.add(tag.casefold())
        normalized.append(tag)
    return {"title": title, "tags": normalized}


def _replace_fields(header, values):
    match = _HEADER.match(header)
    if not match:
        prefix = "\ufeff" if header.startswith("\ufeff") else ""
        newline = "\n"
        return (
            prefix
            + "---\n"
            + "".join(f"{key}: {value}\n" for key, value in values.items())
            + "---\n"
        )
    newline = "\r\n" if "\r\n" in header else "\n"
    lines = match[1].splitlines(keepends=True)
    result, found, skipping = [], set(), False
    for line in lines:
        entry = _KEY.match(line)
        if entry:
            skipping = False
            key, previous = entry.groups()
            if key in values:
                if key in found or previous.lstrip().startswith(("&", "*")):
                    raise ValueError("Ambiguous metadata field")
                found.add(key)
                result.append(f"{key}: {values[key]}{newline}")
                skipping = True
                continue
        if skipping:
            if line.lstrip().startswith("#"):
                result.append(line)
                continue
            if line[:1].isspace() or line.startswith("-") or not line.strip():
                continue
            skipping = False
        # Quoted variants could leave conflicting YAML keys; do not guess.
        if re.match(r"^[\"'](?:title|tags)[\"']\s*:", line):
            raise ValueError("Unsupported quoted metadata field")
        result.append(line)
    for key, value in values.items():
        if key not in found:
            result.append(f"{key}: {value}{newline}")
    return header[: match.start(1)] + "".join(result) + header[match.end(1) :]


def write_edited_metadata(root, path, payload, revision):
    values = validate_metadata(payload)
    raw = read_note_source(root, path)
    if edit_revision(raw) != revision:
        raise FileExistsError("Note changed on disk")
    header, body = editable_content(raw)
    wrapped, _ = current_wrapper_metadata(raw.removeprefix("\ufeff"))
    fields = {
        key: json.dumps(value, ensure_ascii=False) for key, value in values.items()
    }
    if wrapped and wrapped["noda_source_version"] == "faithful-v1" and values["tags"]:
        # Both readers already support this metadata-capable wrapper schema.
        # The creation receipt and immutable original-source bytes are retained.
        fields["noda_source_version"] = json.dumps("ru-pipeline-v1")
    return write_note_source(
        root, path, _replace_fields(header, fields) + body, revision
    )
