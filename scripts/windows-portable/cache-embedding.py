"""Install the bundled embedding profile's pinned data in Noda's local HF cache."""

import hashlib
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile

from huggingface_hub import snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError


PROFILE = json.loads(Path(__file__).with_name("embedding-profile.json").read_text(encoding="utf-8"))
REPOSITORY = PROFILE["repository"]
REVISION = PROFILE["revision"]
WEIGHTS_HASH = PROFILE["weightsHash"]
WEIGHTS_BYTES = PROFILE["weightsBytes"]
FILES = tuple(PROFILE["files"])


def write_atomic(path, text):
    with NamedTemporaryFile(mode="w", encoding="ascii", dir=path.parent, delete=False) as temp:
        temp.write(text)
    try:
        os.replace(temp.name, path)
    finally:
        Path(temp.name).unlink(missing_ok=True)


def is_verified(folder):
    if not all((folder / filename).is_file() for filename in FILES):
        return False
    path = folder / "model.safetensors"
    receipt = folder / ".noda-verified"
    stat = path.stat()
    if stat.st_size != WEIGHTS_BYTES:
        return False
    stamp = json.dumps([WEIGHTS_HASH, stat.st_size, stat.st_mtime_ns])
    if receipt.is_file() and receipt.read_text(encoding="ascii") == stamp:
        return True
    with path.open("rb") as weights:
        if hashlib.file_digest(weights, "sha256").hexdigest() != WEIGHTS_HASH:
            return False
    write_atomic(receipt, stamp)
    return True


def cache_embedding(cache):
    kwargs = dict(
        revision=REVISION,
        cache_dir=cache,
        allow_patterns=FILES,
        token=False,
        etag_timeout=15,
        max_workers=3,
    )
    try:
        folder = Path(snapshot_download(REPOSITORY, local_files_only=True, **kwargs))
    except LocalEntryNotFoundError:
        folder = None
    if folder is None or not is_verified(folder):
        force = folder is not None and (folder / "model.safetensors").is_file()
        folder = Path(snapshot_download(REPOSITORY, force_download=force, **kwargs))
        if not is_verified(folder):
            raise RuntimeError("Embedding snapshot is incomplete or failed its pinned SHA-256 check.")

    # Offline SentenceTransformer resolves the repository ID using refs/main.
    refs = folder.parent.parent / "refs"
    refs.mkdir(exist_ok=True)
    main = refs / "main"
    if not main.is_file() or main.read_text(encoding="ascii").strip() != REVISION:
        write_atomic(main, REVISION)


if __name__ == "__main__":
    cache_embedding(Path(sys.argv[1]))
