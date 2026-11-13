"""Resolve public Hugging Face models and publish only locally tested imports."""

from dataclasses import replace
import http.client
import json
import re
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlsplit

from filelock import FileLock, Timeout

from backend.note_processing_failures import NoteSystemError
from .gguf_import import inspect_generator
from .imported_models import (
    PART, RANKER_CONFIG, REPOSITORY, ROLES, SHA, SHA256, WEIGHTS, WEIGHTS_INDEX,
    Asset, ImportedModel, descriptor_path, first_shard, load_model, model_id,
    model_primary, save_descriptor, split_files,
)
from .model_downloads import DownloadError, _open_source, imported_files, prepare_files
from .native_assets import guarded
from .scorer_contract import ScorerAssetError
from .services import LocalServices
from .title_stage import TITLE_FORMAT


MAX_IMPORT_BYTES = 2048
_MAX_HUB_METADATA = 2 * 1024 * 1024


def parse_link(raw, role):
    if type(role) is not str or role not in ROLES or type(raw) is not str or len(raw) > 1800:
        raise DownloadError("import_url")
    try:
        link = urlsplit(raw.strip())
        if link.scheme != "https" or link.netloc.lower() != "huggingface.co":
            raise ValueError
        parts = link.path.strip("/").split("/")
        repo = "/".join(parts[:2])
        if not REPOSITORY.fullmatch(repo):
            raise ValueError
        if len(parts) == 2:
            return repo, "main", None
        if len(parts) < 5 or parts[2] not in ("blob", "resolve"):
            raise ValueError
        revision = unquote(parts[3])
        names = [unquote(part) for part in parts[4:]]
        if not re.fullmatch(PART, revision) or not all(re.fullmatch(PART, name) for name in names):
            raise ValueError
        return repo, revision, "/".join(names)
    except (ValueError, AttributeError) as error:
        raise DownloadError("import_url") from error


def _metadata(repo, revision):
    url = f"https://huggingface.co/api/models/{repo}/revision/{quote(revision)}?blobs=true"
    try:
        with _open_source(url) as response:
            raw = response.read(_MAX_HUB_METADATA + 1)
        if len(raw) > _MAX_HUB_METADATA:
            raise DownloadError("import_unsupported")
        return json.loads(raw)
    except HTTPError as error:
        raise DownloadError("import_access" if error.code in (401, 403, 404) else "network") from error
    except (OSError, http.client.HTTPException) as error:
        raise DownloadError("network") from error


def _asset(row, *, size_limit=None, weights=False):
    remote = row["rfilename"]
    if not all(re.fullmatch(PART, part) for part in remote.split("/")):
        raise DownloadError("import_unsupported")
    lfs = row.get("lfs")
    size = row.get("size")
    if type(size) is not int or size <= 0 or (size_limit is not None and size > size_limit):
        raise DownloadError("import_unsupported")
    if lfs and lfs.get("size") == size and SHA256.fullmatch(lfs.get("sha256", "")):
        return Asset(remote, remote.rsplit("/", 1)[-1], size, lfs["sha256"])
    if weights or not SHA.fullmatch(row.get("blobId", "")):
        raise DownloadError("integrity")
    return Asset(remote, remote.rsplit("/", 1)[-1], size, row["blobId"], git_blob=True)


def _generator_files(rows, filename):
    names = [name for name in rows if name.lower().endswith(".gguf")
             and "mmproj" not in name.lower()]
    if filename is None:
        groups = list(dict.fromkeys(first_shard(name) for name in names))
        preferred = [name for name in groups
                     if re.search(r"q4_k_m(?:-00001-of-\d{5})?\.gguf$", name, re.I)]
        choices = preferred or groups
        if len(choices) > 1:
            raise DownloadError("import_choose_file")
        if not choices:
            raise DownloadError("import_unsupported")
        filename = choices[0]
    elif filename not in names:
        raise DownloadError("import_unsupported")
    parts = split_files(filename, len(rows))
    if not parts or not all(name in rows for name in parts):
        raise DownloadError("import_incomplete")
    return tuple(_asset(rows[name], weights=True) for name in parts)


def _reranker_files(rows, filename):
    if not all(name in rows for name in RANKER_CONFIG):
        raise DownloadError("import_unsupported")
    if WEIGHTS in rows and filename in (None, WEIGHTS):
        weights = (_asset(rows[WEIGHTS], weights=True),)
    elif WEIGHTS_INDEX in rows:
        first = next((name for name in rows if re.fullmatch(r"model-00001-of-\d{5}\.safetensors", name)), None)
        if first is None:
            raise DownloadError("import_incomplete")
        parts = split_files(first, len(rows))
        if filename is not None and filename != WEIGHTS_INDEX and filename not in parts:
            raise DownloadError("import_unsupported")
        if not parts or not all(name in rows for name in parts):
            raise DownloadError("import_incomplete")
        weights = (_asset(rows[WEIGHTS_INDEX], size_limit=16 * 1024 * 1024), *(
            _asset(rows[name], weights=True) for name in parts
        ))
    else:
        raise DownloadError("import_unsupported")
    limits = (65536, 64 * 1024 * 1024, 1024 * 1024)
    return tuple(_asset(rows[name], size_limit=limit)
                 for name, limit in zip(RANKER_CONFIG, limits, strict=True)) + weights


def resolve_model(url, role):
    repo, revision, filename = parse_link(url, role)
    metadata = _metadata(repo, revision)
    if metadata.get("private") or metadata.get("gated") or metadata.get("disabled"):
        raise DownloadError("import_access")
    canonical = metadata.get("id", repo)
    commit = metadata["sha"]
    if (not REPOSITORY.fullmatch(canonical) or canonical.casefold() != repo.casefold()
            or not SHA.fullmatch(commit)):
        raise DownloadError("integrity")
    rows = {row["rfilename"]: row for row in metadata["siblings"]}
    if role != "reranker":
        params = (metadata.get("gguf") or {}).get("total")
        files = _generator_files(rows, filename)
    else:
        params = (metadata.get("safetensors") or {}).get("total")
        files = _reranker_files(rows, filename)
    params = params if type(params) is int and params > 0 else None
    key = model_id(role, canonical, commit, model_primary(role, files))
    return ImportedModel(key, role, canonical, commit, params, files, {})


_PROBES = {
    "title": ("Обновить пароль Wi-Fi в офисе.", "Обновление пароля Wi-Fi", "Выставка садовых цветов"),
    "tags": ("Обновить пароль Wi-Fi в офисе.", "Сети: настройка Wi-Fi и беспроводных сетей", "Садоводство: уход за цветами"),
    "links": ("Обновить пароль сети Wi-Fi «Офис-2» в субботу.",
              "Новый пароль Wi-Fi «Офис-2» нужно передать сотрудникам после смены.",
              "После выставки пересадить садовые цветы в больший горшок."),
    "new_tags": ("Office Wi-Fi passwords rotate on Saturday.",
                 "Wi-Fi: setting up wireless networks", "Gardening: growing flowers"),
}


def _test_locally(config, item):
    with LocalServices(config) as services:
        if item.role == "generator":
            with services.generator(item.id) as generator:
                for source, language in (
                    ("Завтра заменить офисный роутер.", "Russian"),
                    ("Replace the office router tomorrow.", "English"),
                ):
                    response = generator.invoke(
                        [{"role": "system", "content": f"Write a concise {language} note title in the JSON title field."},
                         {"role": "user", "content": source}],
                        max_new_tokens=min(128, item.context // 4), temperature=0, do_sample=False, response_format=TITLE_FORMAT,
                        raise_on_truncation=True, require_context_budget=True,
                    )
                    result = json.loads(response)
                    if type(result) is not dict or type(result.get("title")) is not str or not result["title"].strip():
                        raise ValueError("Generator did not return a title")
            return item
        thresholds = {}
        for stage, (source, yes, no) in _PROBES.items():
            positive, negative = services.score(f"qwen_{stage}:{item.id}", [
                {"source": source, "target": yes}, {"source": source, "target": no},
            ])
            if not (0 <= negative <= 1 and 0 <= positive <= 1):
                raise DownloadError("import_runtime")
            if stage != "title":
                thresholds[stage] = (positive + negative) / 2 if positive > negative else 0.5
        return replace(item, thresholds=thresholds)


def import_model(config, url, role, allow_downloads, *, expected_id=None):
    if not allow_downloads:
        raise DownloadError("disabled")
    directory = config.runtime_dir
    directory.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(guarded(directory / "model-import.lock", directory)), timeout=0)
    try:
        with lock:
            yield {"state": "checking"}
            item = resolve_model(url, role)
            if expected_id is not None and item.id != expected_id:
                raise DownloadError("import_changed")
            try:
                saved = load_model(directory, item.id)
            except FileNotFoundError:
                saved = None
            files = [replace(file, verify_cached=True) for file in imported_files(config, item)]
            yield from prepare_files(config, files, allow_downloads)
            if saved is not None:
                yield {"state": "done", "model": saved.option()}
                return
            yield {"state": "testing"}
            try:
                if role != "reranker":
                    headers = [inspect_generator(file.target) for file in files]
                    context = headers[0][1]
                    if context < 128:
                        raise DownloadError("import_unsupported")
                    item = replace(item, parameters=sum(count for count, _ in headers), context=context)
            except (ValueError, ScorerAssetError) as error:
                raise DownloadError("import_unsupported") from error
            if role == "chat":
                save_descriptor(directory, item)
                yield {"state": "done", "model": item.option()}
                return
            trial = descriptor_path(directory, item.id, trial=True)
            save_descriptor(directory, item, trial=True)
            try:
                item = _test_locally(config, item)
                save_descriptor(directory, item)
            except (NoteSystemError, ValueError, RuntimeError, ScorerAssetError) as error:
                code = {
                    "ru_runtime_busy": "busy",
                    "reranker_assets_invalid": "import_unsupported",
                    "reranker_memory": "import_memory",
                    "ru_native_startup_failed": "import_startup",
                }.get(getattr(error, "failure_code", None), "import_runtime")
                raise DownloadError(code) from error
            finally:
                trial.unlink(missing_ok=True)
            yield {"state": "done", "model": item.option()}
    except Timeout as error:
        raise DownloadError("busy") from error
