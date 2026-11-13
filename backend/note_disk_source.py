"""Strict vault reads and relative note identities for cache consumers."""

import os
from pathlib import Path
import stat


class NoteDiskSourceError(RuntimeError):
    """The vault could not be read completely; its previous cache remains valid."""


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _root(directory):
    root = Path(directory).absolute()
    info = root.lstat()
    if _is_link(info) or not stat.S_ISDIR(info.st_mode):
        raise PermissionError("notes directory is not a regular directory")
    return root


def _checked_note_path(directory, filepath, allow_missing_leaf=False):
    root = _root(directory)
    path = Path(filepath).absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise PermissionError("note file path is outside NOTES_DIR") from exc
    if not relative.parts or ".." in relative.parts or path.suffix.casefold() != ".md":
        raise PermissionError("note file path is not a Markdown note")
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing_leaf and index == len(relative.parts) - 1:
                info = None
                break
            raise
        if _is_link(info):
            raise PermissionError("linked note paths are not supported")
    if (
        info is not None and not stat.S_ISREG(info.st_mode)
    ) or root.resolve() not in path.resolve().parents:
        raise PermissionError("note file path is outside NOTES_DIR")
    return path


def safe_note_path(directory, filepath):
    """Reject non-Markdown files, escapes, and every linked path component."""
    return _checked_note_path(directory, filepath)


def note_relative_title(directory, filepath, *, allow_missing_leaf=False):
    path = _checked_note_path(directory, filepath, allow_missing_leaf)
    return path.relative_to(Path(directory).absolute()).with_suffix("").as_posix()


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns)


def read_note_source(directory, filepath):
    """Read exact UTF-8 text, preserving BOM, CRLF, CR, and trailing whitespace."""
    path = safe_note_path(directory, filepath)
    before = path.lstat()
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            if _signature(os.fstat(stream.fileno())) != _signature(before):
                raise NoteDiskSourceError("Note changed while being read")
            raw = stream.read()
            after = os.fstat(stream.fileno())
        safe_note_path(directory, path)
        if _signature(after) != _signature(before) or _signature(
            path.lstat()
        ) != _signature(before):
            raise NoteDiskSourceError("Note changed while being read")
        return raw.decode("utf-8", errors="strict")
    except FileNotFoundError:
        raise
    except (OSError, UnicodeError) as exc:
        raise NoteDiskSourceError(
            "Could not read the complete UTF-8 note source"
        ) from exc


def note_inventory(directory):
    """Return deterministic complete inventory, excluding Noda's internal storage."""
    try:
        root = _root(directory)
        inventory = {}

        def visit(folder):
            with os.scandir(folder) as iterator:
                entries = sorted(
                    iterator, key=lambda entry: (entry.name.casefold(), entry.name)
                )
            for entry in entries:
                path = Path(entry.path)
                if folder == root and entry.name in {".noda-queue", ".noda-trash"}:
                    continue
                info = entry.stat(follow_symlinks=False)
                if _is_link(info):
                    raise PermissionError("linked vault paths are not supported")
                if stat.S_ISDIR(info.st_mode):
                    visit(path)
                elif path.suffix.casefold() == ".md":
                    title = note_relative_title(root, path)
                    if title in inventory:
                        raise NoteDiskSourceError(
                            "Multiple note files have the same identity"
                        )
                    inventory[title] = (path, path.lstat())

        visit(root)
        return inventory
    except OSError as exc:
        raise NoteDiskSourceError(
            "Could not read the complete notes inventory"
        ) from exc


def collect_notes_snapshot(directory):
    return {
        title: (info.st_mtime_ns, info.st_size)
        for title, (_, info) in note_inventory(directory).items()
    }


def load_note_cache(directory, extract_tags, filter_tags):
    """Build a complete replacement before the caller changes the previous cache."""
    try:
        from backend.note_faithful_archive import current_wrapper_metadata
    except ImportError:
        from note_faithful_archive import current_wrapper_metadata

    loaded = {}
    snapshot = {}
    try:
        inventory = note_inventory(directory)
        for title, (path, before) in inventory.items():
            content = read_note_source(directory, path)
            info = path.lstat()
            if _signature(info) != _signature(before):
                raise NoteDiskSourceError("Note changed during cache reload")
            metadata, _ = current_wrapper_metadata(content)
            tags = (
                list(metadata["tags"])
                if metadata and metadata["noda_source_version"] == "ru-pipeline-v1"
                else filter_tags(extract_tags(content))
            )
            loaded[title] = {
                "content": content,
                "tags": tags,
                "filename": path.name,
                "filepath": str(path),
                "timestamp": info.st_mtime,
            }
            snapshot[title] = (info.st_mtime_ns, info.st_size)
        if collect_notes_snapshot(directory) != snapshot:
            raise NoteDiskSourceError("Notes inventory changed during cache reload")
    except OSError as exc:
        raise NoteDiskSourceError("Could not load the complete notes cache") from exc
    return loaded, snapshot
