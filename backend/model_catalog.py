# Who: Tim Buglaev
# When: 2026-06-15
# What: Added a bounded Hugging Face model catalog for startup selection, including
#       cache detection plus snapshot/GGUF download helpers that avoid arbitrary repository input.
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


PROJECT_ROOT = Path(__file__).resolve().parent.parent
GGUF_MODELS_DIR = PROJECT_ROOT / "models"
PORTABLE_CHAT_ID = "qwen35_4b_portable"


# Who: Tim Buglaev
# When: 2026-06-24
# What: Added structured RAM/VRAM and quality metadata so compatibility is calculated
#       from detected hardware instead of model-name heuristics or decorative ratings.
MODEL_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "t_lite_it_2_1_q4_k_m",
        "hf_model_id": "t-tech/T-lite-it-2.1-GGUF",
        "gguf_filename": "T-lite-it-2.1-Q4_K_M.gguf",
        "name": "T-lite-it 2.1 Q4_K_M",
        "quality": "Русские заметки",
        "description": "Основной стартовый GGUF-профиль для русской правки, заголовков, тегов и ссылок.",
        "hardware": "12-16 GB RAM; хороший баланс качества и размера.",
        "estimated_download_gb": 5.0,
        "artifact": "gguf",
        "model_format": "llama_cpp",
        "quantization": "Q4_K_M",
        "max_model_len": 4096,
        "recommended": True,
        "memory_type": "ram",
        "min_memory_gb": 12,
        "recommended_memory_gb": 16,
        "quality_rank": 4,
        "language": "Русский",
    },
    {
        "id": "t_lite_it_2_1_q5_k_m",
        "hf_model_id": "t-tech/T-lite-it-2.1-GGUF",
        "gguf_filename": "T-lite-it-2.1-Q5_K_M.gguf",
        "name": "T-lite-it 2.1 Q5_K_M",
        "quality": "Лучше правка",
        "description": "Более качественный GGUF-профиль T-lite, если хватает RAM и скорость терпимая.",
        "hardware": "16-24 GB RAM; меньше артефактов, чем Q4_K_M.",
        "estimated_download_gb": 5.9,
        "artifact": "gguf",
        "model_format": "llama_cpp",
        "quantization": "Q5_K_M",
        "max_model_len": 4096,
        "memory_type": "ram",
        "min_memory_gb": 16,
        "recommended_memory_gb": 24,
        "quality_rank": 4,
        "language": "Русский",
    },
    {
        "id": "t_lite_it_2_1_q6_k",
        "hf_model_id": "t-tech/T-lite-it-2.1-GGUF",
        "gguf_filename": "T-lite-it-2.1-Q6_K.gguf",
        "name": "T-lite-it 2.1 Q6_K",
        "quality": "Качество+",
        "description": "Тяжелее, но ближе к полной модели для финальной русской редакторской правки.",
        "hardware": "16-24 GB RAM; выбирать, если Q5_K_M работает достаточно быстро.",
        "estimated_download_gb": 6.7,
        "artifact": "gguf",
        "model_format": "llama_cpp",
        "quantization": "Q6_K",
        "max_model_len": 4096,
        "memory_type": "ram",
        "min_memory_gb": 16,
        "recommended_memory_gb": 24,
        "quality_rank": 5,
        "language": "Русский",
    },
    {
        "id": "qwen3_4b_instruct_2507_q4_k_m",
        "hf_model_id": "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        "gguf_filename": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        "name": "Qwen3 4B Instruct 2507 Q4_K_M",
        "quality": "Слабые ПК",
        "description": "Легкий запасной GGUF-профиль для минимального локального запуска.",
        "hardware": "8 GB RAM, CPU-only; слабее как русский редактор, но очень легкий.",
        "estimated_download_gb": 2.5,
        "artifact": "gguf",
        "model_format": "llama_cpp",
        "quantization": "Q4_K_M",
        "max_model_len": 4096,
        "memory_type": "ram",
        "min_memory_gb": 8,
        "recommended_memory_gb": 12,
        "quality_rank": 3,
        "language": "Русский",
    },
    {
        "id": "vikhr_nemo_12b_q4_k_m",
        "hf_model_id": "VlSav/Vikhr-Nemo-12B-Instruct-R-21-09-24-Q4_K_M-GGUF",
        "gguf_filename": "vikhr-nemo-12b-instruct-r-21-09-24-q4_k_m.gguf",
        "name": "Vikhr-Nemo 12B Q4_K_M",
        "quality": "Русский RAG",
        "description": "Тяжелый русский GGUF-профиль для отдельной проверки качества RAG, не для слабых ПК.",
        "hardware": "24-32 GB RAM; использовать как качественную контрольную модель.",
        "estimated_download_gb": 7.5,
        "artifact": "gguf",
        "model_format": "llama_cpp",
        "quantization": "Q4_K_M",
        "max_model_len": 4096,
        "memory_type": "ram",
        "min_memory_gb": 24,
        "recommended_memory_gb": 32,
        "quality_rank": 5,
        "language": "Русский",
    },
    {
        "id": "qwen3_5_2b",
        "hf_model_id": "Qwen/Qwen3.5-2B",
        "name": "Qwen3.5 2B",
        "quality": "Проверка двух режимов",
        "description": "Общая локальная модель для технической проверки организации и редактуры заметок через vLLM.",
        "hardware": "Проверена на GPU с 12 GB VRAM и контекстом 8192 токенов.",
        "estimated_download_gb": 4.3,
        "artifact": "hf",
        "model_format": "vllm_local",
        "max_model_len": 8192,
        "gpu_memory_utilization": 0.67,
        "enforce_eager": True,
        "memory_type": "vram",
        "min_memory_gb": 8,
        "recommended_memory_gb": 10,
        "quality_rank": 3,
        "language": "Русский",
    },
    {
        "id": "qwen2_5_1_5b",
        "hf_model_id": "Qwen/Qwen2.5-1.5B-Instruct",
        "name": "Qwen2.5 1.5B Instruct",
        "quality": "Быстрая проверка",
        "description": "Легкий профиль для слабых машин и быстрых smoke-тестов. Качество заголовков и связей ограничено.",
        "hardware": "CPU или старая GPU; подходит для проверки пайплайна.",
        "estimated_download_gb": 3.1,
        "max_model_len": 2048,
        "gpu_memory_utilization": 0.72,
        "enforce_eager": True,
        "memory_type": "vram",
        "min_memory_gb": 4,
        "recommended_memory_gb": 6,
        "quality_rank": 2,
        "language": "Русский",
    },
    {
        "id": "qwen2_5_3b",
        "hf_model_id": "Qwen/Qwen2.5-3B-Instruct",
        "name": "Qwen2.5 3B Instruct",
        "quality": "Баланс",
        "description": "Более сильный вариант для русских заметок без резкого роста требований.",
        "hardware": "Желательно 8-12 GB VRAM или терпимый CPU fallback.",
        "estimated_download_gb": 6.2,
        "max_model_len": 2048,
        "gpu_memory_utilization": 0.78,
        "enforce_eager": True,
        "memory_type": "vram",
        "min_memory_gb": 8,
        "recommended_memory_gb": 12,
        "quality_rank": 3,
        "language": "Русский",
    },
    # Who: Tim Buglaev
    # When: 2026-06-21
    # What: Use the official AWQ weight-quantized 7B checkpoint so the quality
    #       profile fits a 12 GB GPU; TurboQuant alone only compresses KV cache
    #       and cannot make the original BF16 weights fit in available VRAM.
    {
        "id": "qwen2_5_7b",
        "hf_model_id": "Qwen/Qwen2.5-7B-Instruct-AWQ",
        "name": "Qwen2.5 7B Instruct AWQ",
        "quality": "Качество",
        "description": "Весовая 4-bit AWQ-версия для качественной правки, заголовков, тегов и ссылок через vLLM.",
        "hardware": "8-12 GB VRAM; рассчитана на GPU-запуск без загрузки полных BF16-весов.",
        "estimated_download_gb": 4.7,
        "quantization": "AWQ",
        "max_model_len": 2048,
        "gpu_memory_utilization": 0.82,
        "enforce_eager": True,
        "memory_type": "vram",
        "min_memory_gb": 8,
        "recommended_memory_gb": 12,
        "quality_rank": 4,
        "language": "Русский",
    },
    {
        "id": "qwen2_5_14b",
        "hf_model_id": "Qwen/Qwen2.5-14B-Instruct",
        "name": "Qwen2.5 14B Instruct",
        "quality": "Тяжелая оценка",
        "description": "Профиль для честной проверки верхней планки качества на мощной машине.",
        "hardware": "Практически нужен high-VRAM режим; для старых GPU не подходит.",
        "estimated_download_gb": 29.0,
        "max_model_len": 2048,
        "gpu_memory_utilization": 0.86,
        "enforce_eager": True,
        "memory_type": "vram",
        "min_memory_gb": 24,
        "recommended_memory_gb": 32,
        "quality_rank": 5,
        "language": "Русский",
    },
]


def _portable_model_file():
    from backend.ru_pipeline.config import get_config
    from backend.ru_pipeline.model_downloads import model_files

    return model_files(get_config(), "generator", "qwen35_4b")[0]


def _catalog_entries():
    from backend.ru_pipeline.config import portable_runtime_root

    if portable_runtime_root() is None:
        return MODEL_CATALOG
    file = _portable_model_file()
    return [{
        "id": PORTABLE_CHAT_ID, "hf_model_id": "unsloth/Qwen3.5-4B-GGUF",
        "name": "Qwen3.5-4B Q8_0", "gguf_filename": file.target.name,
        "description": "Локальная модель чата и обработки заметок.",
        "quality": "Баланс", "hardware": "CPU, 12–16 GB RAM",
        "estimated_download_gb": file.size / 1e9, "artifact": "gguf",
        "model_format": "llama_cpp", "quantization": "Q8_0", "max_model_len": 8192,
        "recommended": True, "memory_type": "ram", "min_memory_gb": 12,
        "recommended_memory_gb": 16, "quality_rank": 3, "language": "Русский · English",
    }]


def _dedupe_paths(paths: Iterable[Optional[Path]]) -> List[Path]:
    seen = set()
    result: List[Path] = []
    for path in paths:
        if path is None:
            continue
        try:
            normalized = Path(path).expanduser().resolve()
        except Exception:
            continue
        key = str(normalized).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def candidate_cache_dirs(primary_cache_dir: Optional[str] = None) -> List[Path]:
    home = Path.home()
    return _dedupe_paths(
        [
            Path(primary_cache_dir) if primary_cache_dir else None,
            Path(os.environ["TRANSFORMERS_CACHE"]) if os.environ.get("TRANSFORMERS_CACHE") else None,
            Path(os.environ["RAG_LOCAL_MODEL_CACHE"]) if os.environ.get("RAG_LOCAL_MODEL_CACHE") else None,
            home / ".cache" / "huggingface" / "hub",
            home / ".cache" / "huggingface" / "transformers",
        ]
    )


def primary_cache_dir(primary_cache_dir_value: Optional[str] = None) -> Optional[str]:
    cache_dirs = candidate_cache_dirs(primary_cache_dir_value)
    return str(cache_dirs[0]) if cache_dirs else None


def gguf_target_path(model: Dict[str, Any], models_dir: Optional[Path] = None) -> Path:
    if models_dir is None and model.get("id") == PORTABLE_CHAT_ID:
        return _portable_model_file().target
    filename = Path(str(model.get("gguf_filename") or "")).name
    if not filename:
        raise ValueError("gguf_filename is required for GGUF catalog models")
    target_dir = (models_dir or GGUF_MODELS_DIR).resolve()
    return target_dir / filename


def find_catalog_model(model_id: str) -> Optional[Dict[str, Any]]:
    normalized = str(model_id or "").strip()
    if not normalized:
        return None
    for entry in _catalog_entries():
        aliases = {
            entry["id"],
            entry["hf_model_id"],
            entry.get("gguf_filename"),
        }
        if entry.get("quantization"):
            aliases.add(f'{entry["hf_model_id"]}:{entry["quantization"]}')
        if normalized in aliases:
            return dict(entry)
    return None


def _snapshot_cached(model_id: str, cache_dir: Optional[str]) -> bool:
    try:
        from model_init import _is_snapshot_cached
    except Exception:
        return False
    return bool(_is_snapshot_cached(model_id, cache_dir))


def is_model_downloaded(model_id: str, cache_dirs: Iterable[Path]) -> bool:
    for cache_dir in cache_dirs:
        if _snapshot_cached(model_id, str(cache_dir)):
            return True
    return False


def is_catalog_model_downloaded(model: Dict[str, Any], cache_dirs: Iterable[Path]) -> bool:
    if model.get("id") == PORTABLE_CHAT_ID:
        return _portable_model_file().present()
    if model.get("artifact") == "gguf":
        return gguf_target_path(model).exists()
    return is_model_downloaded(model["hf_model_id"], cache_dirs)


def build_model_catalog(active_model_id: Optional[str] = None, cache_dir: Optional[str] = None) -> List[Dict[str, Any]]:
    normalized_active = str(active_model_id or "").strip()
    cache_dirs = candidate_cache_dirs(cache_dir)
    models = []
    for entry in _catalog_entries():
        model = dict(entry)
        if model.get("artifact") == "gguf":
            model["local_path"] = str(gguf_target_path(model))
        model["downloaded"] = is_catalog_model_downloaded(model, cache_dirs)
        selected = normalized_active in {
            str(model["id"]),
            str(model["hf_model_id"]),
            str(model.get("gguf_filename") or ""),
            str(model.get("local_path") or ""),
        }
        model["active"] = selected
        if model["id"] == PORTABLE_CHAT_ID:
            model["configured"] = selected
            model["active"] = selected and model["downloaded"]
        models.append(model)
    return models


def _download_gguf_catalog_model(model: Dict[str, Any]) -> Dict[str, Any]:
    target_path = gguf_target_path(model)
    model["local_path"] = str(target_path)
    if model.get("id") == PORTABLE_CHAT_ID:
        from backend.ru_pipeline.config import get_config
        from backend.ru_pipeline.model_downloads import DownloadError, prepare_files

        try:
            for _ in prepare_files(get_config(), [_portable_model_file()], True):
                continue
        except (DownloadError, OSError, ValueError):
            return {"success": False, "status": "download_failed", "model": model}
        model["downloaded"] = True
        return {"success": True, "status": "downloaded", "model": model}
    if target_path.exists():
        model["downloaded"] = True
        return {"success": True, "status": "already_cached", "model": model}
    try:
        from model_init import _download_gguf_model
    except Exception as exc:
        return {"success": False, "error": str(exc), "status": "download_unavailable", "model": model}

    downloaded = bool(
        _download_gguf_model(
            str(target_path),
            repo_id=str(model["hf_model_id"]),
            filename=str(model["gguf_filename"]),
        )
    )
    if not downloaded:
        return {"success": False, "error": "GGUF file download failed", "status": "download_failed", "model": model}
    model["downloaded"] = True
    return {"success": True, "status": "downloaded", "model": model}


def download_catalog_model(model_id: str, cache_dir: Optional[str] = None) -> Dict[str, Any]:
    model = find_catalog_model(model_id)
    if model is None:
        return {"success": False, "error": "Unknown model id", "status": "invalid_model"}

    if model.get("artifact") == "gguf":
        return _download_gguf_catalog_model(model)

    resolved_cache_dir = primary_cache_dir(cache_dir)
    cache_dirs = candidate_cache_dirs(resolved_cache_dir)
    if is_model_downloaded(model["hf_model_id"], cache_dirs):
        return {"success": True, "status": "already_cached", "model": model}

    try:
        from model_init import _download_snapshot
    except Exception as exc:
        return {"success": False, "error": str(exc), "status": "download_unavailable", "model": model}

    downloaded = bool(_download_snapshot(model["hf_model_id"], resolved_cache_dir))
    if not downloaded:
        return {"success": False, "error": "Hugging Face snapshot download failed", "status": "download_failed", "model": model}
    model["downloaded"] = True
    return {"success": True, "status": "downloaded", "model": model}
