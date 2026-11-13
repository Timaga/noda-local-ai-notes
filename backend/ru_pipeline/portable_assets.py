"""Verify the installed CPU runtime against the pinned Windows distribution."""

import hashlib
import json


_MANIFEST = "scripts/windows-portable/llama-cpu-assets.json"
_MANIFEST_SHA256 = "83e60cea5b9b3ec32e50b6f5976ce84048d47b1a93780ebcff03d92e31c4af0c"
_DIRECTORY = "bin/llama"


def uses_cpu_runtime(config):
    source = getattr(config, "source_root", None)
    return source is not None and source != config.repo_root


def cpu_executable(config, relative):
    return relative(config.repo_root, f"{_DIRECTORY}/llama-server.exe")


def verify_cpu_runtime(config, relative, sha_file):
    path = relative(config.source_root, _MANIFEST)
    with path.open("rb") as stream:
        raw = stream.read(16385)
    if len(raw) > 16384 or hashlib.sha256(raw).hexdigest() != _MANIFEST_SHA256:
        raise ValueError("Pinned CPU runtime manifest changed")
    manifest = json.loads(raw)
    if manifest["schema"] != "noda-portable-llama-cpu-v1" or manifest["executable"] != "llama-server.exe":
        raise ValueError("Unexpected CPU runtime manifest")
    runtime = cpu_executable(config, relative).parent
    if {path.name for path in runtime.iterdir()} != {row["path"] for row in manifest["files"]}:
        raise ValueError("Unexpected CPU runtime dependency")
    for row in manifest["files"]:
        path = relative(runtime, row["path"])
        if not path.is_file() or path.stat().st_size != row["bytes"] or sha_file(path) != row["sha256"]:
            raise ValueError("Pinned CPU runtime dependency changed")
