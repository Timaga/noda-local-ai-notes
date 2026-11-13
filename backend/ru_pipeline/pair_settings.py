"""Supported note-stage pairs and their persisted local selection."""

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from threading import Lock
from types import MappingProxyType

from .config import get_config, portable_runtime_root, runtime_directory
from .imported_models import list_models
from .native_assets import guarded


MAX_SELECTION_BYTES = 1024
_SETTINGS_FILENAME = "stage-pairs.json"
_GENERATORS = {
    "qwen25_3b": "Qwen2.5-3B",
    "qwen35_4b": "Qwen3.5-4B",
    "qwen3_4b_instruct": "Qwen3-4B-Instruct-2507",
}
_RERANKERS = {
    "mmarco": "mMARCO MiniLM CrossEncoder",
    "tev": "Tev1-0.8B",
    "qwen": "Qwen3-Reranker-0.6B",
}


@dataclass(frozen=True)
class Pair:
    generator: str
    reranker: str
    generator_label: str | None = None
    reranker_label: str | None = None
    thresholds: dict | None = None

    @property
    def id(self):
        return f"{self.generator}_{self.reranker}"

    @property
    def label(self):
        return f"{self.generator_label or _GENERATORS[self.generator]} + {self.reranker_label or _RERANKERS[self.reranker]}"

    def scorer_engine(self, stage):
        if self.thresholds is not None:
            return f"qwen_{stage}:{self.reranker}"
        return f"qwen_{stage}" if self.reranker == "qwen" else self.reranker

    def threshold(self, stage, defaults):
        return self.thresholds[stage] if self.thresholds is not None else defaults[self.reranker]


_QWEN25_MMARCO = Pair("qwen25_3b", "mmarco")
_QWEN35_MMARCO = Pair("qwen35_4b", "mmarco")
_QWEN25_TEV = Pair("qwen25_3b", "tev")
_QWEN35_TEV = Pair("qwen35_4b", "tev")
_QWEN25_QWEN = Pair("qwen25_3b", "qwen")
_QWEN35_QWEN = Pair("qwen35_4b", "qwen")

# Each stage's first pair is the recommended selection and the historical default.
_STAGES = {
    "title": (_QWEN25_MMARCO, _QWEN35_MMARCO, _QWEN25_QWEN, _QWEN35_QWEN),
    "tags": (
        _QWEN35_TEV,
        _QWEN35_MMARCO,
        _QWEN25_TEV,
        _QWEN25_MMARCO,
        _QWEN35_QWEN,
        _QWEN25_QWEN,
    ),
    "links": (_QWEN35_MMARCO, _QWEN25_MMARCO, _QWEN35_QWEN, _QWEN25_QWEN),
}
DEFAULT_PAIRS = MappingProxyType({stage: pairs[0] for stage, pairs in _STAGES.items()})
PORTABLE_DEFAULT_PAIRS = MappingProxyType(dict.fromkeys(_STAGES, _QWEN35_MMARCO))
DEFAULT_STAGE_ENABLED = MappingProxyType(dict.fromkeys(_STAGES, True))
NEW_TAG_PAIRS = tuple(Pair("qwen3_4b_instruct", engine) for engine in ("qwen", "mmarco"))
_SAVE_LOCK = Lock()


@dataclass(frozen=True)
class NewTags:
    enabled: bool = False
    pair: Pair = NEW_TAG_PAIRS[0]

    def payload(self):
        return {"enabled": self.enabled, "pairId": self.pair.id}


def _components(options, models):
    generators = {pair.generator: _GENERATORS[pair.generator] for pair in options}
    rerankers = {pair.reranker: _RERANKERS[pair.reranker] for pair in options}
    for model in models.values():
        choices = generators if model.role == "generator" else rerankers
        choices[model.id] = model.label
    return generators, rerankers


def _resolve_pair(options, models, identifier):
    if type(identifier) is not str or len(identifier) > 64:
        return None
    generators, rerankers = _components(options, models)
    for generator in generators:
        prefix = generator + "_"
        if not identifier.startswith(prefix):
            continue
        reranker = identifier[len(prefix):]
        if reranker in rerankers:
            return Pair(
                generator, reranker,
                generators[generator] if generator in models else None,
                rerankers[reranker] if reranker in models else None,
                models[reranker].thresholds if reranker in models else None,
            )
    return None


def decode_settings(raw, models=None):
    models = models or {}
    def unique(pairs):
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ValueError("Duplicate note-stage key")
        return result

    if len(raw) > MAX_SELECTION_BYTES:
        raise ValueError("Note-stage selection is too large")
    values = json.loads(raw, object_pairs_hook=unique)
    if type(values) is not dict or values.keys() - {"newTags", "stageEnabled"} != _STAGES.keys():
        raise ValueError("Expected exactly title, tags and links")
    selected = {}
    for stage, options in _STAGES.items():
        match = _resolve_pair(options, models, values[stage])
        if match is None:
            raise ValueError("Unsupported note-stage pair")
        selected[stage] = match
    enabled = values.get("stageEnabled")
    if "stageEnabled" in values and (
        type(enabled) is not dict
        or enabled.keys() != _STAGES.keys()
        or any(type(flag) is not bool for flag in enabled.values())
    ):
        raise ValueError("Invalid note-stage switches")
    if "newTags" not in values:
        return selected, None, enabled
    new = values["newTags"]
    if (
        type(new) is not dict
        or set(new) != {"enabled", "pairId"}
        or type(new["enabled"]) is not bool
    ):
        raise ValueError("Invalid new tag preferences")
    pair = _resolve_pair(NEW_TAG_PAIRS, models, new["pairId"])
    if pair is None:
        raise ValueError("Unsupported new tag pair")
    return selected, NewTags(new["enabled"], pair), enabled


def _selection_path(directory):
    return guarded(directory / _SETTINGS_FILENAME, directory)


def _portable(directory):
    root = portable_runtime_root()
    return root is not None and directory == runtime_directory()


def _default_pairs(directory):
    return PORTABLE_DEFAULT_PAIRS if _portable(directory) else DEFAULT_PAIRS


def selectable_pair(directory, pair):
    return not _portable(directory) or (pair.generator != "qwen25_3b" and pair.reranker != "tev")


def load_settings(directory, models=None):
    path = _selection_path(directory)
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        return _default_pairs(directory), NewTags(), DEFAULT_STAGE_ENABLED, False
    if not stat.S_ISREG(mode):
        raise ValueError("Expected a regular note-stage selection file")
    with path.open("rb") as stream:
        selected, new_tags, enabled = decode_settings(
            stream.read(MAX_SELECTION_BYTES + 1), list_models(directory) if models is None else models,
        )
    if any(not selectable_pair(directory, pair) for pair in selected.values()):
        raise ValueError("Unavailable model in portable setup")
    active = dict(DEFAULT_STAGE_ENABLED)
    if enabled is not None:
        active.update(enabled)
    return selected, new_tags or NewTags(), active, True


def save_selection(directory, selected, new_tags=None, *, stage_enabled=None):
    # The startup picker writes pair IDs only. Preserve the desktop switches.
    with _SAVE_LOCK:
        if new_tags is None or stage_enabled is None:
            try:
                _, saved_new_tags, saved_enabled, _ = load_settings(directory)
            except (ValueError, TypeError, RecursionError):
                saved_new_tags, saved_enabled = NewTags(), DEFAULT_STAGE_ENABLED
            if new_tags is None:
                new_tags = saved_new_tags
            if stage_enabled is None:
                stage_enabled = saved_enabled
        values = selection_ids(selected)
        if new_tags != NewTags():
            values["newTags"] = new_tags.payload()
        if stage_enabled != DEFAULT_STAGE_ENABLED:
            values["stageEnabled"] = dict(stage_enabled)
        _write_selection(directory, values)


def _write_selection(directory, values):
    data = json.dumps(values, separators=(",", ":")) + "\n"
    path = _selection_path(directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=".stage-pairs-",
            suffix=".tmp",
            delete=False,
        ) as stream:
            pending = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        pending.replace(path)
        pending = None
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def selection_ids(selected):
    return {stage: pair.id for stage, pair in selected.items()}


def selection_status(runtime):
    from .model_downloads import DownloadError, model_files
    from .scorer_contract import ScorerAssetError

    directory = runtime_directory(runtime)
    models = {}
    try:
        models = list_models(directory)
        selected, new_tags, enabled, configured = load_settings(directory, models)
        status = {}
    except (OSError, ValueError, TypeError, RecursionError):
        selected, new_tags, enabled, configured = _default_pairs(directory), NewTags(), DEFAULT_STAGE_ENABLED, False
        status = {"configurationError": "note_pipeline_selection_unreadable"}

    try:
        config = get_config(runtime)
    except (OSError, ValueError, RecursionError):
        config = None
    try:
        download_free = shutil.disk_usage(config.repo_root).free if config is not None else None
    except OSError:
        download_free = None
    components = {}

    def component(role, key, label):
        if key not in components:
            imported = models.get(key)
            option = imported.option() if imported else {
                "id": key, "label": label, "languages": ["ru", "en"], "experimental": key == "qwen",
            }
            if config is not None:
                try:
                    files = model_files(config, role, key, imported)
                    if imported:
                        option["downloaded"] = all(file.present() for file in files)
                    else:
                        option["download_bytes"] = sum(file.size for file in files if not file.present())
                        option["downloaded"] = option["download_bytes"] == 0
                except (DownloadError, ScorerAssetError, OSError, ValueError, KeyError):
                    option["downloaded"] = None
            components[key] = option
        return components[key]

    def public_components(options):
        generators, rerankers = _components(options, models)
        return {
            role: [component(role, key, label) for key, label in choices.items()]
            for role, choices in (("generator", generators), ("reranker", rerankers))
        }
    return {
        **status,
        "configured": configured,
        "downloadFreeBytes": download_free,
        "stageEnabled": dict(enabled),
        "newTags": {
            **new_tags.payload(),
            "components": public_components(NEW_TAG_PAIRS),
            "recommendedId": NEW_TAG_PAIRS[0].id,
            "options": [
                {"id": pair.id, "label": pair.label, "languages": ["ru", "en"]}
                for pair in NEW_TAG_PAIRS
            ],
        },
        "selection": selection_ids(selected),
        "catalog": [
            {
                "id": stage,
                "components": public_components(options),
                "recommendedId": _default_pairs(directory)[stage].id,
                "options": [
                    {
                        "id": pair.id,
                        "label": pair.label,
                        "languages": ["ru", "en"],
                        "experimental": pair.reranker == "qwen",
                    }
                    for pair in options
                ],
            }
            for stage, all_options in _STAGES.items()
            for options in [tuple(pair for pair in all_options if selectable_pair(directory, pair))]
        ],
        "stages": [
            {
                "name": stage,
                "generator": pair.generator_label or _GENERATORS[pair.generator],
                "reranker": pair.reranker_label or _RERANKERS[pair.reranker],
            }
            for stage, pair in selected.items()
        ],
    }
