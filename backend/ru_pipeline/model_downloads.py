"""Acquire only the exact, pinned weights selected for local note processing."""

from contextlib import closing
from dataclasses import dataclass
import hashlib
import http.client
import os
from pathlib import Path
import shutil
import tempfile
import time
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from filelock import FileLock, Timeout

from .native_assets import guarded, load_manifest, relative
from .pair_settings import _GENERATORS, _RERANKERS
from .scorer_assets import load_descriptor


_GENERATOR_SOURCES = {
    "qwen25_3b": ("Qwen/Qwen2.5-3B-Instruct-GGUF", "7dabda4d13d513e3e842b20f0d435c732f172cbe"),
    "qwen35_4b": ("unsloth/Qwen3.5-4B-GGUF", "e87f176479d0855a907a41277aca2f8ee7a09523"),
    "qwen3_4b_instruct": ("ggml-org/Qwen3-4B-Instruct-2507-Q8_0-GGUF", "e6f794d44f9395d0184a966c27b5ae99ea356fcb"),
}
_DOWNLOAD_HOSTS = {
    "huggingface.co", "cas-bridge.xethub.hf.co", "cdn-lfs.huggingface.co",
    "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "www.apache.org",
}
_DOWNLOAD_TIMEOUT = 7200


@dataclass(frozen=True)
class ModelFile:
    model: str
    target: Path
    url: str
    size: int
    sha256: str
    git_blob: bool = False
    verify_cached: bool = False

    def digest(self):
        if self.git_blob:
            return hashlib.sha1(f"blob {self.size}\0".encode(), usedforsecurity=False)
        return hashlib.sha256()

    def present(self):
        if not self.target.exists():
            return False
        if not self.target.is_file():
            raise DownloadError("storage")
        if self.target.stat().st_size != self.size:
            return False
        if not self.verify_cached:
            return True
        digest = self.digest()
        with self.target.open("rb") as stream:
            return hashlib.file_digest(stream, lambda: digest).hexdigest() == self.sha256


class DownloadError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _hub_file(repository, revision, name):
    return f"https://huggingface.co/{repository}/resolve/{revision}/{quote(name)}?download=true"


def model_files(config, role, key, imported=None):
    if imported is not None:
        return imported_files(config, imported)
    if role == "generator":
        row = load_manifest()["models"][key]
        target = relative(config.repo_root, row["path"])
        source = _hub_file(*_GENERATOR_SOURCES[key], target.name)
        return [ModelFile(_GENERATORS[key], target, source, row["bytes"], row["sha256"])]

    manifest = load_descriptor(key, getattr(config, f"{key}_assets"))
    files = []
    for row in manifest["files"]:
        name = row["path"]
        target = relative(config.repo_root, f'{manifest["model_root"]}/{name}')
        source = (
            "https://www.apache.org/licenses/LICENSE-2.0.txt"
            if key == "qwen" and name == "LICENSE-2.0.txt"
            else _hub_file(manifest["repository"], manifest["revision"], name)
        )
        files.append(ModelFile(_RERANKERS[key], target, source, row["bytes"], row["sha256"]))
    return files


def selected_files(config, pairs, stage_enabled, new_tags):
    from .imported_models import MODEL_ID, load_model

    enabled_pairs = [pair for stage, pair in pairs.items() if stage_enabled[stage]]
    if stage_enabled["tags"] and new_tags.enabled:
        enabled_pairs.append(new_tags.pair)
    files = []
    for role in ("generator", "reranker"):
        for key in dict.fromkeys(getattr(pair, role) for pair in enabled_pairs):
            imported = load_model(config.runtime_dir, key) if MODEL_ID.fullmatch(key) else None
            files.extend(model_files(config, role, key, imported))
    return files


def imported_files(config, item):
    folder = item.folder(config.repo_root)
    return [
        ModelFile(item.repository, guarded(folder / asset.name, config.repo_root),
                  _hub_file(item.repository, item.revision, asset.remote), asset.size, asset.sha256,
                  git_blob=asset.git_blob)
        for asset in item.files
    ]


def download_size(config, files):
    total = sum(file.size for file in files if not file.present())
    if total > (1 << 53) - 1:
        raise DownloadError("import_unsupported")
    return total, shutil.disk_usage(config.repo_root).free


def _verify_url(url):
    target = urlsplit(url)
    host = target.hostname or ""
    if (
        target.scheme != "https" or (host not in _DOWNLOAD_HOSTS and not host.endswith(".cdn.hf.co"))
        or target.port not in (None, 443) or target.username or target.password
    ):
        raise DownloadError("network")


class _PinnedRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _verify_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_source(url):
    _verify_url(url)
    request = Request(url, headers={"User-Agent": "Noda", "Accept-Encoding": "identity"})
    return build_opener(_PinnedRedirects()).open(request, timeout=30)


def _read(source):
    try:
        return source.read1(1024 * 1024)
    except (OSError, http.client.HTTPException) as error:
        raise DownloadError("network") from error


def _download_file(config, file, deadline):
    target = guarded(file.target, config.repo_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    if time.monotonic() >= deadline:
        raise DownloadError("network")
    try:
        source = _open_source(file.url)
    except (OSError, http.client.HTTPException) as error:
        raise DownloadError("network") from error
    temporary = None
    received = 0
    digest = file.digest()
    try:
        with source, tempfile.NamedTemporaryFile(dir=target.parent, prefix=".noda-download-", delete=False) as output:
            temporary = Path(output.name)
            for chunk in iter(lambda: _read(source), b""):
                if time.monotonic() >= deadline:
                    raise DownloadError("network")
                received += len(chunk)
                if received > file.size:
                    raise DownloadError("integrity")
                output.write(chunk)
                digest.update(chunk)
                yield received
            if received != file.size:
                raise DownloadError("network")
            if digest.hexdigest() != file.sha256:
                raise DownloadError("integrity")
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(guarded(target, config.repo_root))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def prepare_files(config, files, allow_downloads):
    if all(file.present() for file in files):
        return
    if not allow_downloads:
        raise DownloadError("disabled")
    folder = guarded(config.runtime_dir, config.runtime_dir)
    folder.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(guarded(folder / "downloads.lock", folder)), timeout=0)
    try:
        with lock:
            pending = [file for file in files if not file.present()]
            total = sum(file.size for file in pending)
            if total > shutil.disk_usage(config.repo_root).free:
                raise DownloadError("space")
            completed = 0
            deadline = time.monotonic() + _DOWNLOAD_TIMEOUT
            for file in pending:
                yield {"state": "downloading", "model": file.model, "bytes": completed, "total": total}
                next_update = time.monotonic() + 0.2
                with closing(_download_file(config, file, deadline)) as chunks:
                    for received in chunks:
                        now = time.monotonic()
                        if now >= next_update:
                            yield {"state": "downloading", "model": file.model, "bytes": completed + received, "total": total}
                            next_update = now + 0.2
                completed += file.size
                yield {"state": "downloading", "model": file.model, "bytes": completed, "total": total}
    except Timeout as error:
        raise DownloadError("busy") from error
