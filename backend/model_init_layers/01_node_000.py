# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

import logging
import os
import platform
import re
import shutil
import importlib
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

logger = logging.getLogger(__name__)

DEFAULT_GGUF_MODEL_PATH = "./models/qwen2.5-7b-instruct-q5_k_m.gguf"

# Resolve relative paths against the project root to avoid depending on the current working directory.
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent


try:
    from transformers import BitsAndBytesConfig, AutoModelForCausalLM, AutoTokenizer
except Exception:
    BitsAndBytesConfig = None
    AutoTokenizer = None
    try:
        from transformers import AutoModelForCausalLM  # type: ignore
    except Exception:
        AutoModelForCausalLM = None

# Expose snapshot_download at module scope so tests can patch it and callers can reuse a cached import.
try:
    from huggingface_hub import snapshot_download  # type: ignore
except Exception:
    snapshot_download = None  # type: ignore

# Import model_manager at module load (not inside functions).
try:
    from model_manager import model_manager
except ImportError:
    model_manager = None
    logger.warning("Failed to import model_manager")


def _get_snapshot_downloader(local_only: Optional[bool] = None):
    """
    Lazily imports and returns huggingface_hub.snapshot_download so tests can patch sys.modules.
    When `local_only` is provided, the returned callable injects a default local_files_only flag.
    """
    global snapshot_download
    # If tests patched snapshot_download directly, respect it and avoid re-importing.
    if snapshot_download is None:
        try:
            hub = importlib.import_module("huggingface_hub")
            snapshot_download = getattr(hub, "snapshot_download", None)
        except Exception:
            snapshot_download = None

    downloader = snapshot_download
    if downloader is None:
        return None
    if local_only is None:
        return downloader

    def _wrapped_snapshot_download(**kwargs):
        kwargs.setdefault("local_files_only", bool(local_only))
        return downloader(**kwargs)

    return _wrapped_snapshot_download


def _resolve_gguf_path(path_like: Optional[str]) -> Path:
    """
    Normalizes GGUF paths so relative values are resolved from the project root, not the cwd.
    """
    if not path_like:
        path_like = DEFAULT_GGUF_MODEL_PATH
    path_obj = Path(path_like).expanduser()
    if not path_obj.is_absolute():
        path_obj = (PROJECT_ROOT / path_obj).resolve()
    else:
        path_obj = path_obj.resolve()
    return path_obj


def _validate_gguf_path_input(path_like: Optional[str]) -> Tuple[Optional[Path], Optional[Dict[str, Any]]]:
    """
    Safely resolves a GGUF path and reports invalid Windows-reserved or malformed values.
    Returns (Path|None, error_info|None).
    """
    candidate = path_like or DEFAULT_GGUF_MODEL_PATH
    try:
        if hasattr(os.path, "isreserved") and os.path.isreserved(str(candidate)):
            return None, {"available": False, "model_id": str(candidate), "reason": "invalid_path", "error": "reserved_path"}
        resolved = _resolve_gguf_path(candidate)
        if hasattr(os.path, "isreserved") and os.path.isreserved(str(resolved)):
            return None, {"available": False, "model_id": str(resolved), "reason": "invalid_path", "error": "reserved_path"}
        return resolved, None
    except (OSError, ValueError) as exc:
        return None, {"available": False, "model_id": str(candidate), "reason": "invalid_path", "error": str(exc)}


def _is_snapshot_cached(model_id: str, cache_dir: Optional[str] = None) -> bool:
    """
    Checks if a Hugging Face snapshot for the given model already exists locally.
    Uses local_files_only to avoid network calls during the check.
    """
    downloader = _get_snapshot_downloader()
    if downloader is None:
        return False

    try:
        snapshot_kwargs = {"repo_id": model_id, "local_files_only": True}
        if cache_dir:
            snapshot_kwargs["cache_dir"] = cache_dir
        downloader(**snapshot_kwargs)
        return True
    except Exception:
        return False


def _download_snapshot(model_id: str, cache_dir: Optional[str] = None) -> bool:
    """
    Attempts to download a model snapshot via huggingface_hub.
    Returns True on success, False on any error.
    """
    downloader = _get_snapshot_downloader(local_only=False)
    if downloader is None:
        logger.info("huggingface_hub unavailable for snapshot download")
        return False

    try:
        snapshot_kwargs = {"repo_id": model_id, "local_files_only": False}
        if cache_dir:
            snapshot_kwargs["cache_dir"] = cache_dir
        downloader(**snapshot_kwargs)
        return True
    except Exception as exc:
        logger.warning("Snapshot download failed for %s: %s", model_id, exc)
        return False


def _download_model_via_transformers(
    model_id: str, cache_dir: Optional[str] = None, quantization_config: Optional[Any] = None
) -> bool:
    """
    Attempts to download a model using Transformers AutoModelForCausalLM.
    Avoids full pipeline creation but forces the download into cache.
    """
    if AutoModelForCausalLM is None:
        logger.info("AutoModelForCausalLM unavailable for fallback download")
        return False

    tokenizer_kwargs: Dict[str, Any] = {}
    if cache_dir:
        tokenizer_kwargs["cache_dir"] = cache_dir

    if AutoTokenizer is not None:
        try:
            AutoTokenizer.from_pretrained(model_id, **tokenizer_kwargs)
        except Exception as exc:
            logger.info("Tokenizer download skipped for %s: %s", model_id, exc)

    model_kwargs: Dict[str, Any] = {}
    if cache_dir:
        model_kwargs["cache_dir"] = cache_dir
    if quantization_config:
        model_kwargs["quantization_config"] = quantization_config
        model_kwargs["device_map"] = "auto"

    # Remove None values
    model_kwargs = {k: v for k, v in model_kwargs.items() if v is not None}
    try:
        AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)
        logger.info("Model %s downloaded via transformers AutoModelForCausalLM", model_id)
        return True
    except Exception as exc:
        logger.warning("Transformers fallback download failed for %s: %s", model_id, exc)
        return False


def is_windows() -> bool:
    """Detects Windows platform."""
    return platform.system() == "Windows"


def get_quantization_backend() -> str:
    """
    Determines quantization backend based on OS and QUANTIZATION_BACKEND env.
    auto => GGUF on Windows, bitsandbytes on Linux/others.
    """
    backend = os.getenv("QUANTIZATION_BACKEND", "auto").strip().lower()
    if backend == "auto":
        return "gguf" if is_windows() else "bitsandbytes"
    return backend


def _bitsandbytes_status() -> Tuple[bool, str]:
    """Returns (available, reason) for bitsandbytes discovery."""
    try:
        import importlib.metadata
        import importlib.util

        if importlib.util.find_spec("bitsandbytes") is None:
            return False, "module_not_found"
        try:
            importlib.metadata.version("bitsandbytes")
        except importlib.metadata.PackageNotFoundError:
            return False, "metadata_not_found"
        return True, ""
    except Exception as exc:
        return False, str(exc)


def check_bitsandbytes_availability() -> Dict[str, Any]:
    """Returns dict with bitsandbytes availability considering OS and config."""
    requested_backend = os.getenv("QUANTIZATION_BACKEND", "auto").strip().lower()
    backend = get_quantization_backend()
    if requested_backend == "auto" and is_windows():
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Avoid logging embedded bitsandbytes diagnostics when the active
        #       provider is managed vLLM, because Windows will not load that path.
        if os.getenv("RAG_RUNTIME_PROVIDER", "local").strip().lower() != "vllm_local":
            logger.info("bitsandbytes disabled on Windows (use QUANTIZATION_BACKEND=bitsandbytes to enable)")
        return {"available": False, "error": "disabled_on_windows"}
    if backend not in ("bitsandbytes", "auto") and requested_backend not in ("bitsandbytes", "auto"):
        return {"available": False, "error": "disabled_by_config"}

    available, reason = _bitsandbytes_status()
    if available:
        try:
            import bitsandbytes  # noqa: F401

            return {"available": True, "version": getattr(bitsandbytes, "__version__", None)}
        except Exception as exc:  # pragma: no cover - import guard
            return {"available": False, "error": str(exc)}
    return {"available": False, "error": reason}


def _is_bitsandbytes_available():
    """Checks whether bitsandbytes can be imported (needed for quantization)."""
    available, _ = _bitsandbytes_status()
    return available


def _build_quantization_config():
    """
    Attempts to construct a 4-bit BitsAndBytesConfig when bitsandbytes is available.
    Returns (config, available, error_reason).
    """
    # Who: Tim Buglaev
    # When: 2026-05-28
    # What: Report a stable error when BitsAndBytesConfig itself is unavailable even if
    #       bitsandbytes probing is mocked as available, avoiding accidental real imports in tests.
    if BitsAndBytesConfig is None:
        return None, False, "bitsandbytes_config_unavailable"
    bnb_info = check_bitsandbytes_availability()
    if not bnb_info.get("available"):
        return None, False, bnb_info.get("error")
    try:
        import torch

        quant_cfg = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
        )
        return quant_cfg, True, None
    except Exception as exc:
        return None, False, str(exc)


def _gptq_status():
    """
    Returns (available, reason) for auto-gptq discovery.
    """
    try:
        import importlib.util

        if importlib.util.find_spec("auto_gptq") is None:
            return False, "module_not_found"
        return True, ""
    except Exception as exc:
        return False, str(exc)


def check_gptq_availability() -> Dict[str, Any]:
    available, reason = _gptq_status()
    return {"available": available, "error": reason}


def check_gguf_availability() -> Dict[str, Any]:
    """Checks whether llama-cpp-python is importable."""
    disable_flag = os.getenv("DISABLE_LLAMA_CPP", "").strip().lower() in ("1", "true", "yes", "on")
    if disable_flag:
        return {
            "available": False,
            "error": "disabled_via_env",
            "message": "llama-cpp-python disabled via DISABLE_LLAMA_CPP",
        }
    try:
        import llama_cpp  # noqa: F401

        return {"available": True, "version": getattr(llama_cpp, "__version__", None), "backend": "llama-cpp-python"}
    except ImportError as exc:
        return {"available": False, "error": str(exc), "message": "Install with: pip install llama-cpp-python"}


class _SplitInfo(NamedTuple):
    base_name: str
    part_number: int
    total_parts: int
    part_digits: int
    total_digits: int


class _SplitPlan(NamedTuple):
    expected_parts: List[str]
    total_parts: int
    part_digits: int
    total_digits: int


def _parse_split_gguf_filename(filename: str) -> Optional[_SplitInfo]:
    """
    Parses filenames like `model-00001-of-00002.gguf` and returns split metadata.
    """
    match = re.match(r"^(?P<base>.+?)-(?P<part>\d+)-of-(?P<total>\d+)\.gguf$", filename, flags=re.IGNORECASE)
    if not match:
        return None

    return _SplitInfo(
        base_name=match.group("base"),
        part_number=int(match.group("part")),
        total_parts=int(match.group("total")),
        part_digits=len(match.group("part")),
        total_digits=len(match.group("total")),
    )


def _build_expected_split_parts(split_info: _SplitInfo) -> List[str]:
    """
    Builds the ordered list of shard filenames for a split GGUF model.
    """
    return [
        f"{split_info.base_name}-{part:0{split_info.part_digits}d}-of-{split_info.total_parts:0{split_info.total_digits}d}.gguf"
        for part in range(1, split_info.total_parts + 1)
    ]


def _discover_split_plan(api: Any, repo_id: str, split_info: _SplitInfo) -> Optional[_SplitPlan]:
    """
    Reads repository contents and builds a download plan for all GGUF shards.
    """
    if not hasattr(api, "list_repo_files"):
        logger.error("huggingface_hub version does not support list_repo_files; please upgrade to >=0.20.0")
        return None

    try:
        repo_files = api.list_repo_files(repo_id=repo_id)
    except Exception as exc:
        logger.error("Failed to list files for repo %s: %s", repo_id, exc)
        return None

    pattern = re.compile(rf"^{re.escape(split_info.base_name)}-(\d+)-of-(\d+)\.gguf$", flags=re.IGNORECASE)
    matches = [pattern.match(name) for name in repo_files]
    matches = [m for m in matches if m]
    if not matches:
        logger.error("No split GGUF parts found for base name %s in repo %s", split_info.base_name, repo_id)
        return None

    detected = matches[0]
    total_parts = split_info.total_parts or int(detected.group(2))
    part_digits = split_info.part_digits or len(detected.group(1))
    total_digits = split_info.total_digits or len(detected.group(2))
    plan = _SplitPlan(
        expected_parts=[
            f"{split_info.base_name}-{part:0{part_digits}d}-of-{total_parts:0{total_digits}d}.gguf"
            for part in range(1, total_parts + 1)
        ],
        total_parts=total_parts,
        part_digits=part_digits,
        total_digits=total_digits,
    )

    missing_in_repo = [part for part in plan.expected_parts if part not in repo_files]
    if missing_in_repo:
        logger.error("Missing split GGUF parts in repo %s: %s", repo_id, ", ".join(missing_in_repo))
        return None

    return plan


def _download_split_plan(
    api: Any, hf_hub_download: Any, repo_id: str, target_dir: Path, plan: _SplitPlan, only: Optional[List[str]] = None
) -> bool:
    """
    Downloads the required split shards into the target directory.
    """
    required = set(only or plan.expected_parts)

    for idx, part_name in enumerate(plan.expected_parts, start=1):
        shard_path = target_dir / part_name
        if part_name not in required:
            if shard_path.exists():
                logger.info("GGUF shard already present (%d/%d): %s", idx, plan.total_parts, shard_path)
            else:
                logger.debug("Skipping optional shard %s (not requested for download)", part_name)
            continue

        if shard_path.exists():
            logger.info("GGUF shard already present (%d/%d): %s", idx, plan.total_parts, shard_path)
            continue

        logger.info("Downloading split GGUF part %d of %d: %s", idx, plan.total_parts, part_name)
        try:
            hf_hub_download(
                repo_id=repo_id,
                filename=part_name,
                local_dir=str(target_dir),
            )
        except Exception as exc:
            logger.error("Failed to download GGUF shard %s: %s", part_name, exc)
            return False

    missing_after = [name for name in required if not (target_dir / name).exists()]
    if missing_after:
        logger.error("Some GGUF shards are still missing after download: %s", ", ".join(missing_after))
        return False

    logger.info("All GGUF shards available in %s", target_dir)
    return True


def _merge_split_files(parts: List[str], output_path: str) -> bool:
    """
    Merges multiple split GGUF part files into a single output file.
    Returns True on success, False on failure.
    """
    try:
        with open(output_path, "wb") as merged:
            for part in parts:
                with open(part, "rb") as chunk:
                    shutil.copyfileobj(chunk, merged)
        return True
    except Exception as exc:
        logger.error("Failed to merge split GGUF files into %s: %s", output_path, exc)
        return False


def _download_gguf_model(
    model_path: str, repo_id: str = "Qwen/Qwen2.5-7B-Instruct-GGUF", filename: str = "qwen2.5-7b-instruct-q5_k_m.gguf"
) -> bool:
    """
    Downloads GGUF model from Hugging Face Hub.
    Supports both single-file artifacts and split GGUF shards (e.g. *-00001-of-00002.gguf).
    Returns True on success, False on failure.
    """
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except Exception as exc:
        logger.error("huggingface_hub unavailable for GGUF download: %s", exc)
        return False

    target_dir = Path(model_path).parent
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(filename).name

    logger.info("Preparing to download GGUF model %s/%s", repo_id, filename)
    logger.info("Target path: %s", model_path)

    split_hint = _parse_split_gguf_filename(filename)

    def _attempt_single_file_download() -> bool:
        try:
            downloaded_path = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=str(target_dir),
            )

            logger.info("GGUF model downloaded successfully to %s", downloaded_path)
            return True
        except Exception as exc:
            logger.warning("Direct GGUF download failed, checking for split files: %s", exc)
            return False

    # If the filename already encodes shard information, prefer shard-aware download.
    if split_hint:
        logger.info(
            "Detected sharded GGUF filename (%s): part %d of %d", filename, split_hint.part_number, split_hint.total_parts
        )
        try:
            api = HfApi()
        except Exception as exc:
            logger.error("Unable to initialize HfApi for split GGUF discovery: %s", exc)
            return False

        plan = _discover_split_plan(api, repo_id, split_hint)
        if not plan:
            return False

        return _download_split_plan(api, hf_hub_download, repo_id, target_dir, plan)

    api = None
    try:
        api = HfApi()
        logger.info("Validating GGUF file exists on Hugging Face Hub: %s/%s", repo_id, filename)
        if not api.file_exists(repo_id=repo_id, filename=filename):
            logger.info(
                "GGUF file %s not found in repo %s, attempting direct download before split fallback", filename, repo_id
            )
    except Exception as exc:
        logger.warning(
            "Could not verify GGUF file presence on Hugging Face Hub (%s/%s): %s", repo_id, filename, exc
        )

    if _attempt_single_file_download():
        return True

    # Attempt split-file discovery and download
    logger.info("Searching for split GGUF parts in %s", repo_id)
    try:
        api = api if api is not None else HfApi()
    except Exception as exc:
        logger.error("Unable to initialize HfApi for split GGUF discovery: %s", exc)
        return False

    base_name = Path(filename).stem
    inferred_info = _SplitInfo(
        base_name=base_name,
        part_number=1,
        total_parts=0,
        part_digits=5,
        total_digits=5,
    )
    plan = _discover_split_plan(api, repo_id, inferred_info)
    if not plan:
        return False

    return _download_split_plan(api, hf_hub_download, repo_id, target_dir, plan)


