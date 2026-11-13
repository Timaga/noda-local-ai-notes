"""Admit selected scorer identities from relative, pinned manifests."""

import hashlib
from pathlib import Path

from .scorer_contract import ScorerAssetError, loads


DESCRIPTOR_SHA256 = {
    "mmarco": "e4983452937982aa62330e635b507eba97b1b4ea3457e3850ad686bbb90b89ef",
    "tev": "83520950d3a5c46efa36b3df197fab770df5cd993f946e0df62f79610104cbe1",
    "qwen": "50d7adbff21756caa7b0ca49d5c308dcc39977dc1ddc19b1ad5c11b4e80e3aae",
}
IDENTITIES = {
    "mmarco": (
        "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
        "1427fd652930e4ba29e8149678df786c240d8825",
        "models/ru-note-mmarco-v1",
        6,
    ),
    "tev": (
        "togethercomputer/Tev1-0.8B-experimental",
        "6bb2dff14b38fea90ddb14d870166ccaf77374e9",
        "models/ten-notes-tev1-08b-v1",
        11,
    ),
    "qwen": (
        "Qwen/Qwen3-Reranker-0.6B",
        "e61197ed45024b0ed8a2d74b80b4d909f1255473",
        "models/ten-notes-qwen3-reranker-06b-v1",
        10,
    ),
}


def load_descriptor(engine, descriptor):
    path = Path(descriptor)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ScorerAssetError("Invalid scorer descriptor")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DESCRIPTOR_SHA256[engine]:
        raise ScorerAssetError("Scorer descriptor changed")
    manifest = loads(raw)
    repository, revision, relative, count = IDENTITIES[engine]
    if (
        manifest["engine"] != engine
        or manifest["repository"] != repository
        or manifest["revision"] != revision
        or manifest["model_root"] != relative
        or len(manifest["files"]) != count
    ):
        raise ScorerAssetError("Unselected scorer identity")
    return manifest


def verify_assets(engine, descriptor, project_root):
    try:
        manifest = load_descriptor(engine, descriptor)
        root = Path(project_root).resolve(strict=True)
        folder = (root / manifest["model_root"]).resolve(strict=True)
        if not folder.is_relative_to(root):
            raise ScorerAssetError("Model directory escapes project")
        seen = set()
        for entry in manifest["files"]:
            name = entry["path"]
            local = Path(name)
            if local.is_absolute() or ".." in local.parts or name in seen:
                raise ScorerAssetError("Invalid model file mapping")
            seen.add(name)
            asset = folder / local
            if asset.is_symlink() or not asset.resolve(strict=True).is_relative_to(
                folder
            ):
                raise ScorerAssetError("Model asset escapes selected directory")
            if asset.stat().st_size != entry["bytes"]:
                raise ScorerAssetError("Model asset size changed")
            with asset.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != entry["sha256"]:
                raise ScorerAssetError("Model asset changed")
        return folder
    except ScorerAssetError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ScorerAssetError("Scorer assets unavailable") from error
