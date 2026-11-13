"""Strict complete source snapshots for local note decisions."""

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat


_WRAPPER_VERSIONS = frozenset(("faithful-v1", "ru-pipeline-v1"))

try:
    from backend.note_processing_failures import NoteSystemError
except ImportError:
    from note_processing_failures import NoteSystemError


@dataclass(frozen=True)
class ArchiveRecord:
    id: str
    title: str
    source: str
    filepath: str
    disk_sha256: str
    source_modified: bool = False
    tags: tuple[str, ...] = ()


def _failure(message, cause=None):
    error = NoteSystemError(message, failure_code="archive_unavailable_or_changed")
    if cause is not None:
        raise error from cause
    raise error


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _root(notes_dir):
    path = Path(notes_dir).absolute()
    try:
        info = path.lstat()
        if _is_link(info) or not stat.S_ISDIR(info.st_mode):
            _failure("Архив должен быть обычным доступным каталогом.")
        return path.resolve(strict=True)
    except OSError as exc:
        _failure("Архив заметок недоступен.", exc)


def _inventory(root):
    files = []

    def visit(directory):
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(
                    iterator, key=lambda entry: (entry.name.casefold(), entry.name)
                )
            for entry in entries:
                if directory == root and entry.name in {".noda-queue", ".noda-trash"}:
                    continue
                path = Path(entry.path)
                info = entry.stat(follow_symlinks=False)
                if _is_link(info):
                    _failure("Ссылки файловой системы в архиве не поддерживаются.")
                resolved = path.resolve(strict=True)
                if root not in resolved.parents:
                    _failure("Объект архива находится вне выбранного каталога.")
                if stat.S_ISDIR(info.st_mode):
                    visit(path)
                elif path.suffix.casefold() == ".md":
                    if not stat.S_ISREG(info.st_mode):
                        _failure("Заметка должна быть обычным файлом.")
                    files.append(path)
        except OSError as exc:
            _failure("Не удалось полностью прочитать состав архива.", exc)

    visit(root)
    return tuple(
        sorted(
            files,
            key=lambda path: (
                path.relative_to(root).as_posix().casefold(),
                path.relative_to(root).as_posix(),
            ),
        )
    )


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns)


def _read_bytes(path, root):
    try:
        before = path.lstat()
        if _is_link(before) or not stat.S_ISREG(before.st_mode):
            _failure("Файл заметки изменил тип во время чтения.")
        if root not in path.resolve(strict=True).parents:
            _failure("Файл заметки находится вне выбранного каталога.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            if _signature(os.fstat(stream.fileno())) != _signature(before):
                _failure("Файл заметки изменился во время чтения.")
            raw = stream.read()
            after = os.fstat(stream.fileno())
        current = path.lstat()
        if (
            _signature(after) != _signature(before)
            or _signature(current) != _signature(before)
            or _is_link(current)
        ):
            _failure("Файл заметки изменился во время чтения.")
        return raw
    except OSError as exc:
        _failure("Не удалось прочитать полный исходник заметки.", exc)


def _scalar(value):
    value = value.strip()
    if value.startswith('"'):
        parsed = json.loads(value)
        if not isinstance(parsed, str):
            raise ValueError("Scalar must be text")
        return parsed
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


def _valid_metadata_items(values):
    return (
        isinstance(values, list)
        and all(
            isinstance(item, str)
            and item.strip()
            and item == item.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in item)
            for item in values
        )
        and len(set(values)) == len(values)
    )


def _valid_ru_tags(values):
    # These tags bypass semantic legacy filters when the cache is reloaded.
    return _valid_metadata_items(values) and all(
        len(tag) <= 80
        and re.fullmatch(r"[\w-]+(?:/[\w-]+)*", tag)
        and any(char.isalpha() for char in tag)
        for tag in values
    )


def _parse_wrapper(disk_text, *, verify_source=True):
    if not isinstance(disk_text, str):
        _failure("Исходник архива должен быть строкой.")
    if not disk_text.startswith(("---\n", "---\r\n")):
        return None, disk_text
    offset = 4 if disk_text.startswith("---\n") else 5
    closing = re.search(r"(?m)^---\r?\n", disk_text[offset:])
    header_end = offset + closing.start() if closing else None
    header = disk_text[offset:header_end]
    versions = re.findall(r"(?m)^noda_source_version:[ \t]*(.*)$", header)
    try:
        marked = any(_scalar(value) in _WRAPPER_VERSIONS for value in versions)
    except (ValueError, TypeError):
        _failure("Неверная служебная оболочка заметки.")
    if not marked:
        return None, disk_text
    if closing is None:
        _failure("Неверная служебная оболочка заметки.")
    source_start = offset + closing.end()
    source = disk_text[source_start:]
    values = {}
    for line in header.splitlines():
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)", line)
        if not match or match.group(1) in values:
            _failure("Неверная служебная оболочка заметки.")
        values[match.group(1)] = match.group(2)
    expected = {
        "noda_source_version",
        "noda_source_length",
        "noda_source_sha256",
        "title",
        "tags",
        "related",
    }
    if set(values) != expected:
        _failure("Неверная служебная оболочка заметки.")
    try:
        version = _scalar(values["noda_source_version"])
        length = _scalar(values["noda_source_length"])
        digest = _scalar(values["noda_source_sha256"])
        title = json.loads(values["title"])
        tags = json.loads(values["tags"])
        related = json.loads(values["related"])
        if (
            version not in _WRAPPER_VERSIONS
            or not isinstance(title, str)
            or not title
            or not isinstance(tags, list)
            or (version == "faithful-v1" and tags)
            or (
                version == "ru-pipeline-v1"
                and (
                    not _valid_ru_tags(tags)
                    or not _valid_metadata_items(related)
                )
            )
            or not isinstance(related, list)
            or any(not isinstance(item, str) or not item for item in related)
            or len(set(related)) != len(related)
            or not re.fullmatch(r"0|[1-9][0-9]*", length)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or (
                verify_source
                and (
                    int(length) != len(source)
                    or hashlib.sha256(source.encode("utf-8")).hexdigest() != digest
                )
            )
        ):
            raise ValueError("Invalid generated wrapper")
    except (ValueError, TypeError, UnicodeError):
        _failure("Исходник служебной заметки не прошёл проверку целостности.")
    return {
        "noda_source_version": version,
        "noda_source_length": int(length),
        "noda_source_sha256": digest,
        "title": title,
        "tags": tags,
        "related": related,
    }, source


def wrapper_metadata(disk_text):
    """Return verified application metadata and the exact original source."""
    return _parse_wrapper(disk_text)


def current_wrapper_metadata(disk_text):
    """Read the current body; a creation receipt does not forbid later author edits."""
    metadata, source = _parse_wrapper(disk_text, verify_source=False)
    if metadata is not None:
        metadata = dict(metadata)
        metadata["source_modified"] = (
            metadata["noda_source_length"] != len(source)
            or metadata["noda_source_sha256"]
            != hashlib.sha256(source.encode("utf-8")).hexdigest()
        )
    return metadata, source


def faithful_metadata(disk_text):
    """Return metadata for a supported lossless application wrapper."""
    return _parse_wrapper(disk_text)[0]


def unwrap_source(disk_text):
    """Remove only the declared application wrapper after lossless verification."""
    return _parse_wrapper(disk_text)[1]


def snapshot_archive(notes_dir):
    """Read every Markdown file, retaining complete raw text and path identity."""
    try:
        from backend.note_generation_contract import extract_note_tags
    except ImportError:
        from note_generation_contract import extract_note_tags

    root = _root(notes_dir)
    files = _inventory(root)
    identifiers = tuple(
        path.relative_to(root).with_suffix("").as_posix() for path in files
    )
    if len(set(identifiers)) != len(identifiers):
        _failure("В архиве есть разные файлы с одинаковой идентичностью заметки.")
    records = []
    for path, identifier in zip(files, identifiers):
        raw = _read_bytes(path, root)
        try:
            disk_text = raw.decode("utf-8", errors="strict")
        except UnicodeError as exc:
            _failure("Исходник заметки не является корректным UTF-8.", exc)
        metadata, source = current_wrapper_metadata(disk_text)
        records.append(
            ArchiveRecord(
                id=identifier,
                title=identifier,
                source=source,
                filepath=str(path),
                disk_sha256=hashlib.sha256(raw).hexdigest(),
                source_modified=bool(metadata and metadata["source_modified"]),
                tags=tuple(extract_note_tags(disk_text)),
            )
        )
    if files != _inventory(root):
        _failure("Состав архива изменился во время чтения.")
    return tuple(records)


def assert_unchanged(snapshot, notes_dir):
    """Reject publication when inventory or any full-file digest changed."""
    root = _root(notes_dir)
    records = tuple(snapshot)
    if not all(isinstance(record, ArchiveRecord) for record in records):
        _failure("Неверный снимок архива.")
    if len({record.id for record in records}) != len(records):
        _failure("Неверный снимок архива.")
    files = _inventory(root)
    if tuple(str(path) for path in files) != tuple(
        record.filepath for record in records
    ):
        _failure("Состав архива изменился; повторите обработку.")
    for path, record in zip(files, records):
        if hashlib.sha256(_read_bytes(path, root)).hexdigest() != record.disk_sha256:
            _failure("Исходник архива изменился; повторите обработку.")
    if files != _inventory(root):
        _failure("Состав архива изменился; повторите обработку.")
