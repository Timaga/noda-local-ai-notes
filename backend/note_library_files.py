"""Project-local Markdown edits and recoverable moves."""

import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile
from uuid import uuid4

try:
    from backend.note_disk_source import note_relative_title, read_note_source, safe_note_path
    from backend.note_faithful_archive import NoteSystemError, current_wrapper_metadata
except ImportError:
    from note_disk_source import note_relative_title, read_note_source, safe_note_path
    from note_faithful_archive import NoteSystemError, current_wrapper_metadata


TRASH_DIRECTORY = ".noda-trash"
TRASH_SUFFIX = ".noda-deleted"
_TRASH_ID = re.compile(r"[a-f0-9]{32}\Z")
_FRONTMATTER = re.compile(r"\A(?:\ufeff)?---[ \t]*\r?\n.*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)", re.M | re.S)


def editable_content(raw):
    match = _FRONTMATTER.match(raw)
    offset = match.end() if match else int(raw.startswith("\ufeff"))
    return raw[:offset], raw[offset:]


def edit_revision(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def write_edited_body(root, path, content, revision):
    raw = read_note_source(root, path)
    if edit_revision(raw) != revision:
        raise FileExistsError("Note changed on disk")
    header, previous_body = editable_content(raw)
    if content == previous_body.replace("\r\n", "\n").replace("\r", "\n"):
        return raw
    if len(header) > 1 and not header.endswith("\n"):
        header += "\r\n" if "\r\n" in header else "\n"
    if "\r\n" in (previous_body or header) and "\n" not in (previous_body or header).replace("\r\n", ""):
        content = content.replace("\n", "\r\n")
    result = header + content
    return write_note_source(root, path, result, revision)


def write_note_source(root, path, result, revision):
    """Replace one managed note only while its checked disk revision still holds."""
    raw = read_note_source(root, path)
    if edit_revision(raw) != revision:
        raise FileExistsError("Note changed on disk")
    if result == raw:
        return raw
    try:
        current_wrapper_metadata(result)
    except NoteSystemError as exc:
        raise ValueError("The note contains invalid Noda properties") from exc
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".noda-edit-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(result.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        if edit_revision(read_note_source(root, path)) != revision:
            raise FileExistsError("Note changed on disk")
        temporary.chmod(stat.S_IMODE(path.stat().st_mode))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return result


def _regular(path, directory=False):
    info = path.lstat()
    is_link = stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    if is_link or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise PermissionError("Invalid path in note trash")
    return path


def trash_note(root, path):
    path = safe_note_path(root, path)
    trash = root / TRASH_DIRECTORY
    trash.mkdir(exist_ok=True)
    _regular(trash, directory=True)
    token = uuid4().hex
    entry = trash / token
    entry.mkdir()
    target = entry / path.relative_to(root)
    target = target.with_name(target.name + TRASH_SUFFIX)
    target.parent.mkdir(parents=True, exist_ok=True)
    path.rename(target)
    return token


def _trashed_path(root, token):
    if not _TRASH_ID.fullmatch(token):
        raise ValueError("Invalid trash identifier")
    trash = _regular(root / TRASH_DIRECTORY, directory=True)
    directory = entry = _regular(trash / token, directory=True)
    while True:
        children = list(directory.iterdir())
        if len(children) != 1:
            raise FileNotFoundError("Trash entry is unavailable")
        path = children[0]
        if path.name.endswith(TRASH_SUFFIX) and path.is_file():
            _regular(path)
            original = root / path.relative_to(entry)
            return path, original.with_name(original.name.removesuffix(TRASH_SUFFIX))
        directory = _regular(path, directory=True)


def list_trash(root):
    try:
        trash = _regular(root / TRASH_DIRECTORY, directory=True)
    except FileNotFoundError:
        return []
    items = []
    for entry in sorted(trash.iterdir(), key=lambda p: p.name):
        if not _TRASH_ID.fullmatch(entry.name):
            continue
        try:
            _, original = _trashed_path(root, entry.name)
        except (FileNotFoundError, PermissionError):
            continue
        items.append({"id": entry.name, "title": original.relative_to(root).with_suffix("").as_posix()})
    return sorted(items, key=lambda item: item["title"].casefold())


def restore_note(root, token):
    saved, original = _trashed_path(root, token)
    if any(part.startswith(".") for part in original.relative_to(root).parts):
        raise PermissionError("Cannot restore into an internal folder")
    title = note_relative_title(root, original, allow_missing_leaf=True)
    if os.name == "nt":
        saved.rename(original)  # Windows refuses to replace an occupied destination.
    else:
        os.link(saved, original)
        saved.unlink()
    parent = saved.parent
    entry = root / TRASH_DIRECTORY / token
    while parent != entry.parent:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
    return title, original
