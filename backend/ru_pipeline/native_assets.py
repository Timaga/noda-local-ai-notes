"""Pinned relative assets for the user-selected note generators."""

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat

from .portable_assets import cpu_executable, uses_cpu_runtime, verify_cpu_runtime


MANIFEST = Path(__file__).with_name("assets") / "native-models.json"
MANIFEST_SHA256 = "0d884235e5122f2b4b545bf1fab390ffe67e77eca40a17132a73765bad6465dd"
HOST = "127.0.0.1"


@dataclass(frozen=True)
class Profile:
    key: str
    model: Path
    model_sha256: str
    model_bytes: int
    parameters: int
    alias: str
    executable: Path
    context: int = 8192
    parallel: int = 1


def reparse(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
    )


def guarded(path, root):
    root, path = Path(root).absolute(), Path(path).absolute()
    if ".." in path.parts or not path.is_relative_to(root):
        raise ValueError("Native path outside configured root")
    for part in (path, *path.parents):
        try:
            if reparse(part.lstat()):
                raise ValueError("Native reparse path refused")
        except FileNotFoundError:
            continue
    return path


def relative(root, value):
    if type(value) is not str or "\\" in value:
        raise ValueError("Expected a relative portable asset path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in ("", ".", "..") or ":" in part for part in path.parts)
    ):
        raise ValueError("Unexpected native asset path")
    return guarded(Path(root).joinpath(*path.parts), root)


def sha_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_manifest():
    if reparse(MANIFEST.lstat()) or not MANIFEST.is_file():
        raise ValueError("Regular native manifest required")
    raw = MANIFEST.read_bytes()
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != MANIFEST_SHA256:
        raise ValueError("Pinned native manifest changed")
    value = json.loads(raw)
    if value["schema"] != "ru-note-native-assets-v1":
        raise ValueError("Unexpected native manifest schema")
    return value


def profile(config, key):
    if type(key) is not str:
        raise ValueError("Unknown note generator")
    manifest = load_manifest()
    root = Path(config.repo_root)
    executable = (cpu_executable(config, relative) if uses_cpu_runtime(config)
                  else relative(root, manifest["runtime"]["executable"]))
    if key not in manifest["models"]:
        from .imported_models import MODEL_ID, runtime_model

        if not MODEL_ID.fullmatch(key) or not key.startswith("hfg_"):
            raise ValueError("Unknown note generator")
        item, _ = runtime_model(config.runtime_dir, key)
        asset = item.files[0]
        return Profile(
            key, guarded(item.folder(root) / asset.name, root), asset.sha256, asset.size,
            item.parameters, key, executable,
            context=item.context,
        )
    item = manifest["models"][key]
    if item["nominal_billion"] not in (3, 4):
        raise ValueError("Unapproved native model class")
    return Profile(
        key,
        relative(root, item["path"]),
        item["sha256"],
        item["bytes"],
        item["parameters"],
        item["alias"],
        executable,
    )


def verify_assets(config, item):
    manifest = load_manifest()
    if item != profile(config, item.key):
        raise ValueError("Pinned native profile mismatch")
    if uses_cpu_runtime(config):
        verify_cpu_runtime(config, relative, sha_file)
    else:
        files = manifest["runtime"]["files"]
        if len(files) != 55:
            raise ValueError("Pinned CUDA runtime manifest mismatch")
        for row in files:
            path = relative(config.repo_root, row["path"])
            if not path.is_relative_to(item.executable.parent) or not path.is_file():
                raise ValueError("Native dependency outside runtime directory")
            if path.stat().st_size != row["bytes"] or sha_file(path) != row["sha256"]:
                raise ValueError("Native dependency bytes changed")
    if item.key.startswith("hfg_"):
        from .imported_models import runtime_model, verified_folder

        imported, _ = runtime_model(config.runtime_dir, item.key)
        verified_folder(imported, config.repo_root)
    elif (
        not item.model.is_file()
        or item.model.stat().st_size != item.model_bytes
        or sha_file(item.model) != item.model_sha256
    ):
        raise ValueError("Exact selected model bytes required")
    return item


def command(config, item):
    port = getattr(config, "port", 19189)
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("Explicit unprivileged native port required")
    placement = ["--gpu-layers", "0", "--fit", "off"] if uses_cpu_runtime(config) else ["--fit", "on"] if item.key.startswith("hfg_") else [
        "--split-mode", "none", "--gpu-layers", "all", "--fit", "off",
    ]
    return [
        str(item.executable),
        "--model",
        str(item.model),
        "--alias",
        item.alias,
        "--host",
        HOST,
        "--port",
        str(port),
        *placement,
        "--ctx-size",
        str(item.context),
        "--parallel",
        "1",
        "--batch-size",
        "256",
        "--ubatch-size",
        "128",
        "--threads",
        "4",
        "--threads-batch",
        "4",
        "--threads-http",
        "2",
        "--n-predict",
        "1024",
        "--timeout",
        "120",
        "--jinja",
        "--chat-template-kwargs",
        '{"enable_thinking":false}',
        "--reasoning",
        "off",
        "--reasoning-budget",
        "0",
        "--no-context-shift",
        "--cache-ram",
        "0",
        "--no-webui",
        "--no-mmproj",
        "--no-models-autoload",
        "--models-max",
        "1",
        "--offline",
        "--cors-origins",
        f"http://{HOST}:{port}",
        "--no-cors-credentials",
        "--verbosity",
        "0",
    ]
