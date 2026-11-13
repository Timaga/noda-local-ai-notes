"""Explicit local configuration for the selected Russian note pipeline."""

from dataclasses import dataclass, field
import json
import math
import os
from pathlib import Path
from types import MappingProxyType


ROOT = Path(__file__).resolve().parents[2]
PROFILE_ID = "ru-three-stage-v1"
SOURCE_VERSION = "ru-pipeline-v1"
_RUNTIME_SUBDIRECTORY = "storage/ru-pipeline"


def portable_runtime_root():
    value = os.environ.get("NODA_RUNTIME_HOME")
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Expected an absolute portable runtime directory")
    return path


def _python(root, environment):
    return (
        root / environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )


def enabled(runtime=None):
    value = getattr(runtime, "RU_NOTE_PIPELINE_ENABLED", None)
    if value is not None:
        if type(value) is not bool:
            raise ValueError("RU_NOTE_PIPELINE_ENABLED must be boolean")
        return value
    value = os.environ.get("NODA_RU_PIPELINE_ENABLED", "1").strip().casefold()
    if value not in {"0", "1", "true", "false"}:
        raise ValueError("NODA_RU_PIPELINE_ENABLED must be 0 or 1")
    return value in {"1", "true"}


@dataclass(frozen=True)
class PipelineConfig:
    repo_root: Path = ROOT
    runtime_dir: Path | None = None
    port: int = 19189
    mmarco_python: Path | None = None
    tev_python: Path | None = None
    mmarco_assets: Path | None = None
    tev_assets: Path | None = None
    scorer_timeout: float = 600.0
    native_startup_timeout: float = 180.0
    native_stop_timeout: float = 30.0
    native_request_timeout: float = 120.0
    lock_timeout: float = 30.0
    tag_descriptions: object = field(default_factory=dict)
    qwen_assets: Path | None = None
    source_root: Path | None = None

    def __post_init__(self):
        root = Path(self.repo_root).resolve()
        source = root if self.source_root is None else Path(self.source_root).resolve()
        object.__setattr__(self, "repo_root", root)
        object.__setattr__(self, "source_root", source)
        defaults = {
            "runtime_dir": root / _RUNTIME_SUBDIRECTORY,
            "mmarco_python": _python(root, ".venv-ru-onnx"),
            "tev_python": _python(root, ".venv-ru-title-ft"),
            "mmarco_assets": source / "backend/ru_pipeline/assets/scorer_mmarco.json",
            "tev_assets": source / "backend/ru_pipeline/assets/scorer_tev.json",
            "qwen_assets": source / "backend/ru_pipeline/assets/scorer_qwen.json",
        }
        for name, default in defaults.items():
            value = getattr(self, name)
            value = Path(default if value is None else value)
            if not value.is_absolute():
                value = root / value
            object.__setattr__(self, name, value.resolve())
        if type(self.port) is not int or not 1024 <= self.port <= 65535:
            raise ValueError("Russian pipeline needs a non-privileged local port")
        for name in (
            "scorer_timeout",
            "native_startup_timeout",
            "native_stop_timeout",
            "native_request_timeout",
            "lock_timeout",
        ):
            value = getattr(self, name)
            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or not 0 < value <= 3600
            ):
                raise ValueError(
                    "Russian pipeline timeouts must be finite, positive and at most one hour"
                )
        descriptions = dict(self.tag_descriptions)
        if len(descriptions) > 10000 or any(
            type(key) is not str
            or not key
            or len(key) > 80
            or type(value) is not str
            or len(value) > 1000
            or "\x00" in key + value
            for key, value in descriptions.items()
        ):
            raise ValueError("Invalid existing-tag descriptions")
        object.__setattr__(self, "tag_descriptions", MappingProxyType(descriptions))

    @property
    def project_root(self):
        return self.repo_root


def _descriptions(root):
    filename = os.environ.get("NODA_RU_TAG_DESCRIPTIONS", "").strip()
    if not filename:
        return {}
    path = Path(filename)
    if not path.is_absolute():
        path = root / path
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("Tag descriptions must be a bounded regular local JSON file")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate tag description key")
            result[key] = value
        return result

    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)
    if type(value) is not dict:
        raise ValueError(
            "Tag descriptions must map existing tag labels to descriptions"
        )
    return value


def _explicit_config(runtime):
    explicit = getattr(runtime, "ru_pipeline_config", None)
    if explicit is not None and not isinstance(explicit, PipelineConfig):
        raise ValueError("Expected a trusted PipelineConfig instance")
    return explicit


def runtime_directory(runtime=None):
    explicit = _explicit_config(runtime)
    return (
        explicit.runtime_dir
        if explicit is not None
        else ((portable_runtime_root() or ROOT) / _RUNTIME_SUBDIRECTORY).resolve()
    )


def get_config(runtime=None):
    explicit = _explicit_config(runtime)
    if explicit is not None:
        return explicit
    root = portable_runtime_root()
    values = {"tag_descriptions": _descriptions(root or ROOT)}
    if root is not None:
        values.update(repo_root=root, source_root=ROOT)
    for name, variable in (
        ("mmarco_python", "NODA_RU_MMARCO_PYTHON"),
        ("tev_python", "NODA_RU_TEV_PYTHON"),
    ):
        value = os.environ.get(variable, "").strip()
        if value:
            values[name] = Path(value)
    return PipelineConfig(**values)
