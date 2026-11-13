"""Local descriptors of tested user models. Repository paths never come from the UI."""

import hashlib
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from .native_assets import guarded, relative


ROLES = {"generator": "hfg", "reranker": "hfr", "chat": "hfc"}
MODEL_ID = re.compile(r"hf[grc]_[a-f0-9]{16}")
PART = r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}"
REPOSITORY = re.compile(rf"{PART}/{PART}")
SHA = re.compile(r"[a-f0-9]{40}")
SHA256 = re.compile(r"[a-f0-9]{64}")
RANKER_CONFIG = ("config.json", "tokenizer.json", "tokenizer_config.json")
WEIGHTS = "model.safetensors"
WEIGHTS_INDEX = WEIGHTS + ".index.json"
MAX_DESCRIPTOR = 2 * 1024 * 1024
_SHARD = re.compile(r"(.+)-(\d{5})-of-(\d{5})(\.gguf|\.safetensors)", re.IGNORECASE)


def first_shard(filename):
    match = _SHARD.fullmatch(filename)
    return f"{match[1]}-00001-of-{match[3]}{match[4]}" if match else filename


def split_files(filename, available):
    """Return the ordered siblings expected by the native weight loaders."""
    match = _SHARD.fullmatch(filename)
    if match is None:
        return (filename,)
    prefix, index, count, extension = match.groups()
    if not 1 <= int(index) <= int(count):
        raise ValueError("Invalid model shard number")
    if int(count) > available:
        return ()
    return tuple(f"{prefix}-{number:05d}-of-{count}{extension}" for number in range(1, int(count) + 1))


def model_id(role, repository, revision, primary):
    identity = "\n".join((repository, revision, primary))
    return f"{ROLES[role]}_{hashlib.sha256(identity.encode()).hexdigest()[:16]}"


def model_primary(role, assets):
    if role == "reranker" and any(asset.name == WEIGHTS_INDEX for asset in assets):
        return WEIGHTS_INDEX
    return assets[0].remote if assets else ""


@dataclass(frozen=True)
class Asset:
    remote: str
    name: str
    size: int
    sha256: str
    git_blob: bool = False


@dataclass(frozen=True)
class ImportedModel:
    id: str
    role: str
    repository: str
    revision: str
    parameters: int | None
    files: tuple[Asset, ...]
    thresholds: dict
    context: int = 8192

    @property
    def label(self):
        suffix = f" · {self.files[0].name}" if self.role != "reranker" else ""
        return f"{self.repository}{suffix} · {self.revision[:7]}"

    def option(self):
        return {"id": self.id, "label": self.label, "experimental": True, "imported": True}

    def folder(self, root):
        return relative(root, f"models/noda-user/{self.id}")


def descriptor_path(directory, key, *, trial=False):
    if not MODEL_ID.fullmatch(key):
        raise ValueError("Invalid imported model identifier")
    return guarded(directory / "imported-models" / (key + (".trial" if trial else ".json")), directory)


def read_descriptor(path, key, *, trial=False):
    with path.open("rb") as stream:
        raw = stream.read(MAX_DESCRIPTOR + 1)
    if len(raw) > MAX_DESCRIPTOR:
        raise ValueError("Imported model descriptor exceeds its limit")
    value = json.loads(raw)
    assets = tuple(Asset(**entry) for entry in value.pop("files"))
    item = ImportedModel(files=assets, **value)
    if (
        not REPOSITORY.fullmatch(item.repository) or not SHA.fullmatch(item.revision)
        or (item.parameters is not None and (type(item.parameters) is not int or item.parameters <= 0))
        or item.role not in ROLES or not assets
        or key != item.id or key != model_id(item.role, item.repository, item.revision, model_primary(item.role, assets))
        or any(type(asset.git_blob) is not bool
               or not (SHA if asset.git_blob else SHA256).fullmatch(asset.sha256)
               or type(asset.size) is not int or asset.size <= 0
               or not re.fullmatch(PART, asset.name)
               or not all(re.fullmatch(PART, part) for part in asset.remote.split("/"))
               for asset in assets)
    ):
        raise ValueError("Invalid imported model descriptor")
    names = tuple(asset.name for asset in assets)
    if item.role != "reranker":
        remote = tuple(asset.remote for asset in assets)
        if (remote != split_files(remote[0], len(assets))
                or names != tuple(name.rsplit("/", 1)[-1] for name in remote)
                or not names[0].lower().endswith(".gguf")
                or any(asset.git_blob for asset in assets) or item.thresholds != {}
                or type(item.context) is not int or not 128 <= item.context <= 8192
                or item.parameters is None):
            raise ValueError("Invalid generator assets")
    else:
        weights = names[len(RANKER_CONFIG):]
        if (names[:len(RANKER_CONFIG)] != RANKER_CONFIG
                or not (weights == (WEIGHTS,) or len(weights) > 1 and weights[0] == WEIGHTS_INDEX
                        and re.fullmatch(r"model-00001-of-\d{5}\.safetensors", weights[1])
                        and weights[1:] == split_files(weights[1], len(weights) - 1))
                or any(asset.name != asset.remote for asset in assets)):
            raise ValueError("Invalid reranker assets")
        if not trial or item.thresholds:
            if (set(item.thresholds) != {"tags", "links", "new_tags"}
                    or any(type(score) not in (int, float) or not 0 < score <= 1 for score in item.thresholds.values())):
                raise ValueError("Invalid reranker thresholds")
    return item


def load_model(directory, key, *, trial=False):
    return read_descriptor(descriptor_path(directory, key, trial=trial), key, trial=trial)


def runtime_model(directory, key):
    try:
        return load_model(directory, key), False
    except FileNotFoundError:
        return load_model(directory, key, trial=True), True


def list_models(directory, *, chat=False):
    folder = guarded(directory / "imported-models", directory)
    models = {}
    for path in sorted(folder.glob("hf*.json")):
        if MODEL_ID.fullmatch(path.stem) and path.stem.startswith("hfc_") == chat:
            try:
                models[path.stem] = load_model(directory, path.stem)
            except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
                continue
    return models


def save_descriptor(directory, item, *, trial=False):
    path = descriptor_path(directory, item.id, trial=trial)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".model-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(asdict(item), stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        read_descriptor(temporary, item.id, trial=trial)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def verified_folder(item, root):
    folder = item.folder(root)
    if {path.name for path in folder.iterdir()} != {asset.name for asset in item.files}:
        raise ValueError("Unexpected entries in imported model folder")
    for asset in item.files:
        path = guarded(folder / asset.name, root)
        if not path.is_file() or path.stat().st_size != asset.size:
            raise ValueError("Imported model file changed")
        digest = (hashlib.sha1(f"blob {asset.size}\0".encode(), usedforsecurity=False)
                  if asset.git_blob else hashlib.sha256())
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, lambda: digest).hexdigest()
        if actual != asset.sha256:
            raise ValueError("Imported model file changed")
    return folder
