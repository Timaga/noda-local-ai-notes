"""Validated project launch identity and isolated writable training paths."""

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import stat


_HEX_ID = re.compile(r"[a-f0-9]{32}\Z")
_COLLECTION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_PROJECT_KEYS = (
    "NODA_PROJECT_ID",
    "NODA_PROJECT_CONTEXT",
    "NODA_PROJECT_STORAGE",
    "NODA_PROJECT_LEGACY",
)
_TRAINING_PATHS = {
    "TRAINING_STATUS_PATH": "training/status.json",
    "TRAINING_DATASET_PATH": "training/dataset/notes.jsonl",
    "TRAINING_ARTIFACTS_DIR": "training/artifacts",
    "NODA_TRAINED_NOTES_PATH": "training/trained_notes.json",
    "TRAINING_ADAPTER_PATH": "training/artifacts/adapter",
}


@dataclass(frozen=True)
class ProjectConfiguration:
    project_id: str
    context_token: str
    notes_directory: Path
    storage: Path | None
    legacy: bool
    collection_name: str
    root_sha256: str


def _check_components(path):
    for component in (path, *path.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Project paths cannot contain links or reparse points")
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("Project storage ancestors must be directories")


def _directory(raw, *, required):
    if type(raw) is not str or not raw or "\0" in raw:
        raise ValueError("Project directory must be an absolute path")
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Project directory must be an absolute path")
    try:
        _check_components(path)
        canonical = path.resolve(strict=required)
        _check_components(canonical)
        if required and not canonical.is_dir():
            raise ValueError("Project notes directory must exist")
        return canonical
    except OSError as error:
        raise ValueError("Project directory is unavailable") from error


def project_configuration(environ=None):
    """Validate a launch descriptor; a legacy non-project launch stays unchanged."""
    values = os.environ if environ is None else environ
    if not any(key in values for key in _PROJECT_KEYS):
        return None
    project_id = values.get("NODA_PROJECT_ID")
    token = values.get("NODA_PROJECT_CONTEXT")
    if (
        type(project_id) is not str
        or not _HEX_ID.fullmatch(project_id)
        or type(token) is not str
        or not _HEX_ID.fullmatch(token)
    ):
        raise ValueError("Project ID and context must be canonical 32-hex values")
    legacy_raw = values.get("NODA_PROJECT_LEGACY", "0")
    if legacy_raw not in ("0", "1"):
        raise ValueError("Project legacy flag must be 0 or 1")
    legacy = legacy_raw == "1"
    notes = _directory(values.get("NOTES_DIR"), required=True)
    storage_raw = values.get("NODA_PROJECT_STORAGE")
    if storage_raw is None and not legacy:
        raise ValueError("New projects require isolated storage")
    storage = None if storage_raw is None else _directory(storage_raw, required=False)
    if not legacy and (storage.name != project_id or storage.parent.name != "projects"):
        raise ValueError("Project storage must use the projects/project_id layout")
    collection = values.get("QDRANT_COLLECTION_NAME", "notes" if legacy else None)
    valid_legacy_collection = (
        type(collection) is str
        and 0 < len(collection) <= 255
        and bool(collection.strip())
        and not any(ord(char) < 32 or ord(char) == 127 for char in collection)
    )
    if (
        legacy
        and not valid_legacy_collection
        or not legacy
        and (
            type(collection) is not str
            or not _COLLECTION.fullmatch(collection)
            or project_id not in collection
        )
    ):
        raise ValueError("Project collection must be explicit and project-scoped")
    root_sha256 = hashlib.sha256(
        os.path.normcase(str(notes)).encode("utf-8")
    ).hexdigest()
    return ProjectConfiguration(
        project_id, token, notes, storage, legacy, collection, root_sha256
    )


def _relative_path(relative):
    if not isinstance(relative, (str, os.PathLike)):
        raise ValueError("Project data path must be relative")
    raw = os.fspath(relative)
    if type(raw) is not str or not raw or "\0" in raw or ":" in raw:
        raise ValueError("Project data path must be relative")
    parts = raw.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Project data path must stay within its storage")
    return Path(*parts)


def _data_path(config, relative):
    candidate = config.storage / relative
    try:
        # The leaf may be a regular data file; validate its ancestors separately.
        _check_components(candidate.parent)
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            info = None
        if info is not None and (
            stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0) & 0x400
            or stat.S_ISREG(info.st_mode)
            and info.st_nlink != 1
            or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
        ):
            raise ValueError("Project data path cannot be a link or special file")
        resolved = candidate.resolve(strict=False)
        if config.storage not in resolved.parents:
            raise ValueError("Project data path escapes its storage")
        return resolved
    except OSError as error:
        raise ValueError("Project data path is unavailable") from error


def project_data_path(relative, legacy_default, *, environ=None):
    """Return an isolated project path, preserving exact legacy defaults otherwise."""
    relative = _relative_path(relative)
    config = project_configuration(environ)
    if config is None or config.legacy:
        return Path(legacy_default)
    return _data_path(config, relative)


def apply_project_environment(environ=None):
    """Scope writable paths and metadata before config imports, without moving data."""
    values = os.environ if environ is None else environ
    config = project_configuration(values)
    if config is None or config.legacy:
        return config
    changes = {
        key: str(_data_path(config, _relative_path(relative)))
        for key, relative in _TRAINING_PATHS.items()
    }
    changes["NODA_RU_TAG_DESCRIPTIONS"] = ""
    values.update(changes)
    return config


def load_project_dotenv(loader, env_path, *, environ=None, **options):
    """Load shared model settings without replacing the immutable launch scope."""
    values = os.environ if environ is None else environ
    config = apply_project_environment(values)
    if config is None:
        return loader(env_path, **options)
    protected = (*_PROJECT_KEYS, "NOTES_DIR", "QDRANT_COLLECTION_NAME")
    if not config.legacy:
        protected += (*_TRAINING_PATHS, "NODA_RU_TAG_DESCRIPTIONS")
    absent = object()
    before = {key: values.get(key, absent) for key in protected}
    try:
        return loader(env_path, **options)
    finally:
        for key, previous in before.items():
            if previous is absent:
                values.pop(key, None)
            else:
                values[key] = previous
