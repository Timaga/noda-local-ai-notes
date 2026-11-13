# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

from backend.note_title_method import title_method as _title_method
from backend.project_storage import (
    project_data_path as _project_data_path,
    load_project_dotenv as _load_project_dotenv,
)


def _create_local_rag_model():
    """Создаёт экземпляр локальной RAG-модели в соответствии с текущей конфигурацией."""
    return LocalRagModel(
        RAG_LOCAL_MODEL_NAME,
        model_id=RAG_RUNTIME_MODEL_ID,
        max_new_tokens=RAG_LOCAL_MODEL_MAX_NEW_TOKENS,
        temperature=RAG_LOCAL_MODEL_TEMPERATURE,
        top_p=RAG_LOCAL_MODEL_TOP_P,
        pipeline_task=RAG_LOCAL_MODEL_PIPELINE,
        cache_dir=RAG_LOCAL_MODEL_CACHE,
        device=RAG_LOCAL_MODEL_DEVICE,
        torch_dtype=RAG_LOCAL_MODEL_DTYPE,
        quantization=RAG_LOCAL_MODEL_QUANTIZATION,
        tokenizer_id=RAG_LOCAL_MODEL_TOKENIZER,
        model_revision=RAG_LOCAL_MODEL_REVISION,
        model_format=RAG_LOCAL_MODEL_FORMAT,
        gguf_path=RAG_LOCAL_MODEL_GGUF_PATH,
        gguf_gpu_layers=GGUF_N_GPU_LAYERS,
        context_window=RAG_LOCAL_MODEL_CONTEXT_SIZE,
        trust_remote_code=RAG_LOCAL_MODEL_TRUST_REMOTE_CODE,
        threads=RAG_LOCAL_MODEL_THREADS,
        runtime_provider=RAG_RUNTIME_PROVIDER,
        vllm_base_url=RAG_VLLM_BASE_URL,
        vllm_model_id=RAG_VLLM_MODEL_ID,
        vllm_timeout_seconds=RAG_VLLM_TIMEOUT_SECONDS,
        vllm_verify_tls=RAG_VLLM_VERIFY_TLS,
        turboquant_enabled=TURBOQUANT_ENABLED,
        turboquant_k_bits=TURBOQUANT_K_BITS,
        turboquant_v_bits=TURBOQUANT_V_BITS,
        turboquant_kv_cache_dtype=TURBOQUANT_KV_CACHE_DTYPE,
        llama_server_base_url=RAG_LLAMA_SERVER_BASE_URL,
        llama_server_timeout_seconds=RAG_LLAMA_SERVER_TIMEOUT_SECONDS,
    )
# Сохраняем Flask app между reload'ами модуля
# Это нужно для того, чтобы роуты не терялись при reload с RuntimeError
if __name__ in sys.modules and hasattr(sys.modules[__name__], 'app'):
    app = sys.modules[__name__].app
    _routes_registered = True  # Роуты уже зарегистрированы
else:
    app = Flask(__name__)
    CORS(app)
    _routes_registered = False  # Роуты нужно зарегистрировать

# --- консоль в UTF-8, чтобы русские имена не были кракозябрами ---
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

print("=== APP VERSION: Local-only AI ===")

# --- .env ---
# Path - поддержка мокирования через присваивание в тестах
def _get_path_class():
    """Возвращает класс Path для создания путей (поддерживает мокирование)"""
    # Проверяем атрибут модуля (который патчится в тестах через patch('app.Path'))
    if hasattr(sys.modules[__name__], 'Path'):
        return getattr(sys.modules[__name__], 'Path')
    return pathlib.Path

def get_base_dir():
    """Возвращает базовую директорию проекта"""
    # Всегда используем реальный pathlib.Path для BASE_DIR (не мок)
    # Это нужно для корректной работы тестов, которые проверяют isinstance(BASE_DIR, Path)
    import os
    parent_dir = os.path.dirname(__file__)
    return pathlib.Path(parent_dir)

def get_notes_dir():
    """Возвращает директорию с заметками"""
    Path = _get_path_class()
    # Who: Tim Buglaev
    # When: 2026-05-28
    # What: Added a validated NOTES_DIR environment override so live RAG benchmarks and
    #       tests can use isolated vaults without writing synthetic notes into the user vault.
    notes_dir_override = os.environ.get("NOTES_DIR", "").strip()
    if notes_dir_override:
        try:
            return Path(notes_dir_override).expanduser().resolve()
        except Exception:
            print(f"[WARNING] Invalid NOTES_DIR override ignored: {notes_dir_override!r}")
    # Для NOTES_DIR используем мокируемый Path для поддержки тестов
    base_dir = getattr(sys.modules[__name__], "BASE_DIR", None) or get_base_dir()
    vault_dir = Path(base_dir, "notes", "Мои заметки")
    if getattr(vault_dir, "name", None) != "Мои заметки":
        try:
            vault_dir = vault_dir / "notes" / "Мои заметки"
        except Exception:
            try:
                vault_dir = Path(base_dir) / "notes" / "Мои заметки"
            except Exception:
                pass
    try:
        if getattr(vault_dir, "exists", lambda: False)():
            return vault_dir
    except Exception:
        # Если мок не умеет exists(), просто возвращаем поддиректорию
        pass
    return vault_dir

# BASE_DIR всегда реальный pathlib.Path
BASE_DIR = get_base_dir()
# NOTES_DIR может быть моком для тестов
NOTES_DIR = get_notes_dir()


# Who: Tim Buglaev
# When: 2026-06-15
# What: Prefer readable Unicode paths in UTF-8 consoles while retaining an
#       ASCII-safe fallback for redirected Windows logs that cannot encode Cyrillic.
def _format_path_for_log(path_value):
    text = str(path_value)
    encoding = getattr(getattr(sys, "stdout", None), "encoding", None) or "utf-8"
    try:
        text.encode(encoding)
        return text
    except UnicodeEncodeError:
        return text.encode("ascii", errors="backslashreplace").decode("ascii")


def _resolve_model_path(path_value: str) -> pathlib.Path:
    """
    Resolves model paths relative to the project root to avoid dependence on the cwd.
    Prefers the repository root (BASE_DIR.parent) and falls back to backend/BASE_DIR.
    """
    candidate = pathlib.Path(path_value).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    root_candidate = (BASE_DIR.parent / candidate).resolve()
    backend_candidate = (BASE_DIR / candidate).resolve()
    if root_candidate.exists():
        return root_candidate
    if backend_candidate.exists():
        return backend_candidate
    return root_candidate


# Who: Tim Buglaev
# When: 2026-05-28
# What: Added explicit TurboQuant preset normalization for vLLM KV-cache compression,
#       mapping legacy k/v bit settings to supported vLLM --kv-cache-dtype values and
#       rejecting unsupported pairs in strict request-validation paths.
TURBOQUANT_PRESET_BITS = {
    "turboquant_k8v4": (8, 4),
    "turboquant_4bit_nc": (4, 4),
    "turboquant_k3v4_nc": (3, 4),
    "turboquant_3bit_nc": (3, 3),
}
TURBOQUANT_SUPPORTED_KV_CACHE_DTYPES = tuple(TURBOQUANT_PRESET_BITS.keys())
TURBOQUANT_DEFAULT_KV_CACHE_DTYPE = "turboquant_4bit_nc"


def _turboquant_dtype_from_bits(k_bits, v_bits):
    try:
        bit_pair = (int(k_bits), int(v_bits))
    except (TypeError, ValueError):
        return None
    for dtype_name, dtype_bits in TURBOQUANT_PRESET_BITS.items():
        if dtype_bits == bit_pair:
            return dtype_name
    return None


def _normalize_turboquant_kv_cache_dtype(raw_value=None, enabled=True, k_bits=4, v_bits=4, strict=False):
    if not enabled:
        return None
    normalized = str(raw_value or "").strip().lower().replace("-", "_")
    if normalized in ("", "auto"):
        inferred = _turboquant_dtype_from_bits(k_bits, v_bits)
        if inferred:
            return inferred
        if strict:
            supported_pairs = ", ".join(f"{k}/{v}" for k, v in TURBOQUANT_PRESET_BITS.values())
            raise ValueError(f"Unsupported TurboQuant bit pair: K={k_bits}, V={v_bits}; supported pairs: {supported_pairs}")
        print(
            f"[WARNING] Unsupported TurboQuant bit pair K={k_bits}, V={v_bits}; "
            f"using {TURBOQUANT_DEFAULT_KV_CACHE_DTYPE}"
        )
        return TURBOQUANT_DEFAULT_KV_CACHE_DTYPE
    if normalized not in TURBOQUANT_PRESET_BITS:
        if strict:
            supported = ", ".join(TURBOQUANT_SUPPORTED_KV_CACHE_DTYPES)
            raise ValueError(f"Unsupported TurboQuant kv-cache dtype: {raw_value}; supported values: {supported}")
        print(
            f"[WARNING] Unsupported TurboQuant kv-cache dtype '{raw_value}'; "
            f"using {TURBOQUANT_DEFAULT_KV_CACHE_DTYPE}"
        )
        return TURBOQUANT_DEFAULT_KV_CACHE_DTYPE
    return normalized


def _turboquant_bits_for_dtype(dtype_name, default_k_bits=4, default_v_bits=4):
    bits = TURBOQUANT_PRESET_BITS.get(str(dtype_name or "").strip().lower())
    if bits:
        return bits
    return max(1, min(8, int(default_k_bits))), max(1, min(8, int(default_v_bits)))

from backend.ru_pipeline.config import portable_runtime_root

_portable_root = portable_runtime_root()
env_path = _portable_root / "runtime.env" if _portable_root else BASE_DIR / ".env"
if not _portable_root and not env_path.exists():
    # Fallback to project root if backend/.env отсутствует
    candidate = BASE_DIR.parent / ".env"
    if candidate.exists():
        env_path = candidate

print("ENV PATH:", env_path, "exists:", env_path.exists())

if env_path.exists():
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Make backend/.env the real desktop runtime source of truth outside
    #       tests so stale parent-shell variables cannot switch local GGUF startup
    #       back to WSL/vLLM or an old TurboQuant profile.
    _load_project_dotenv(load_dotenv, env_path, override=not IS_TEST_ENV)
else:
    print("[WARNING] .env не найден по пути:", env_path)

# Who: Tim Buglaev
# When: 2026-03-25
# What: Forced local-only runtime configuration and ignored remote-provider environment toggles to ensure
#       generation endpoints never route prompts to cloud APIs, including accidental ENABLE_GEMINI_BACKEND usage.
_gemini_env_value = os.environ.get("GEMINI_API_KEY", "")
if _gemini_env_value:
    print("[INFO] GEMINI_API_KEY is set but cloud backends are disabled in local-only mode.")
GEMINI_API_KEY = ""
GEMINI_BACKEND_ENABLED = False

# Читаем переменные конфигурации RAG и заметок
# Quantization / GGUF configuration
QUANTIZATION_BACKEND_ENV = os.environ.get("QUANTIZATION_BACKEND", "auto").strip().lower()
SELECTED_QUANTIZATION_BACKEND = QUANTIZATION_BACKEND_ENV
if _get_quant_backend:
    try:
        SELECTED_QUANTIZATION_BACKEND = _get_quant_backend()
    except Exception:
        SELECTED_QUANTIZATION_BACKEND = QUANTIZATION_BACKEND_ENV
USE_GGUF = _parse_bool_env("USE_GGUF", _is_windows_os_helper())
RAW_GGUF_MODEL_PATH = os.environ.get("GGUF_MODEL_PATH", "./models/qwen2.5-7b-instruct-q5_k_m.gguf")
GGUF_MODEL_PATH = str(_resolve_model_path(RAW_GGUF_MODEL_PATH))

# Who: Tim Buglaev
# When: 2026-06-14
# What: Prefer an existing first split GGUF shard when the default merged GGUF path is
#       absent, allowing Windows local fallback to load the repository's sharded model.
def _resolve_existing_gguf_path(path_value):
    try:
        path_obj = pathlib.Path(path_value)
        if path_obj.exists():
            return str(path_obj)
        first_split = sorted(path_obj.parent.glob(f"{path_obj.stem}-00001-of-*.gguf"))
        if first_split:
            return str(first_split[0])
    except Exception:
        pass
    return str(path_value)


GGUF_MODEL_PATH = _resolve_existing_gguf_path(GGUF_MODEL_PATH)
os.environ["GGUF_MODEL_PATH"] = GGUF_MODEL_PATH
GGUF_FILENAME = os.environ.get("GGUF_FILENAME", pathlib.Path(GGUF_MODEL_PATH).name)
GGUF_N_GPU_LAYERS = _parse_int_env("GGUF_N_GPU_LAYERS", 0)
GGUF_N_CTX = _parse_int_env("GGUF_N_CTX", 8192)
GGUF_N_THREADS = _parse_int_env("GGUF_N_THREADS", max(os.cpu_count() or 4, 1))
LLAMA_CPP_CTX_MAX = _parse_int_env("LLAMA_CPP_CTX_MAX", 16384)
USE_BITSANDBYTES = _parse_bool_env("USE_BITSANDBYTES", False)
if QUANTIZATION_BACKEND_ENV == "auto" and not _is_windows_os_helper():
    USE_BITSANDBYTES = True
GGUF_INFO = _check_gguf() if _check_gguf else {"available": False, "error": "not_checked", "message": "llama-cpp-python not installed"}

# Who: Tim Buglaev
# When: 2026-03-25
# What: Locked source selection to local regardless of request/environment and logged ignored remote values
#       to keep behavior explicit and avoid ambiguous runtime fallbacks.
_rag_model_source_env = os.environ.get("RAG_MODEL_SOURCE", "local").strip().lower()
if _rag_model_source_env not in ("", "local", "auto"):
    print(f"[INFO] Ignoring unsupported RAG_MODEL_SOURCE='{_rag_model_source_env}' in local-only mode")
RAG_MODEL_SOURCE = "local"
RAG_LOCAL_MODEL_NAME = os.environ.get("RAG_LOCAL_MODEL_NAME", "local-rag")
RAG_LOCAL_MODEL_ID = os.environ.get("RAG_LOCAL_MODEL_ID", "Qwen/Qwen2.5-7B-Instruct")
RAG_LOCAL_MODEL_TOKENIZER = os.environ.get("RAG_LOCAL_MODEL_TOKENIZER")
RAG_CONTEXT_LIMIT = _parse_int_env("RAG_CONTEXT_LIMIT", 3)
RAG_SNIPPET_LENGTH = _parse_int_env("RAG_SNIPPET_LENGTH", 400)
# Who: Tim Buglaev
# When: 2026-06-14
# What: Added explicit RAG-index quality limits so pathological Obsidian files with
#       repeated tag/text loops are quarantined from embeddings and metadata inheritance.
RAG_MAX_INDEX_TEXT_CHARS = _parse_int_env("RAG_MAX_INDEX_TEXT_CHARS", 12000)
RAG_NOISE_MAX_TAGS_PER_NOTE = _parse_int_env("RAG_NOISE_MAX_TAGS_PER_NOTE", 80)
RAG_NOISE_MIN_TOKENS = _parse_int_env("RAG_NOISE_MIN_TOKENS", 120)
RAG_NOISE_DUPLICATE_TOKEN_RATIO = _parse_float_env("RAG_NOISE_DUPLICATE_TOKEN_RATIO", 0.92)
RAG_NOISE_REPEATED_TAG_THRESHOLD = _parse_int_env("RAG_NOISE_REPEATED_TAG_THRESHOLD", 12)
RAG_LOCAL_MODEL_MAX_NEW_TOKENS = _parse_int_env("RAG_LOCAL_MODEL_MAX_NEW_TOKENS", 128)
RAG_LOCAL_MODEL_TEMPERATURE = _parse_float_env("RAG_LOCAL_MODEL_TEMPERATURE", 0.7)
RAG_LOCAL_MODEL_TOP_P = _parse_float_env("RAG_LOCAL_MODEL_TOP_P", 0.95)
RAG_LOCAL_MODEL_PIPELINE = os.environ.get("RAG_LOCAL_MODEL_PIPELINE", "text-generation")
RAG_LOCAL_MODEL_CACHE = os.environ.get("RAG_LOCAL_MODEL_CACHE", str(BASE_DIR / ".cache" / "models"))
RAG_LOCAL_MODEL_DEVICE = os.environ.get("RAG_LOCAL_MODEL_DEVICE", "auto")
RAG_LOCAL_MODEL_DTYPE = os.environ.get("RAG_LOCAL_MODEL_DTYPE", "bfloat16")
RAG_LOCAL_MODEL_QUANTIZATION = os.environ.get("RAG_LOCAL_MODEL_QUANTIZATION", "bnb-4bit")
RAG_LOCAL_MODEL_REVISION = os.environ.get("RAG_LOCAL_MODEL_REVISION")
RAG_LOCAL_MODEL_GGUF_PATH = os.environ.get("RAG_LOCAL_MODEL_GGUF_PATH")
if RAG_LOCAL_MODEL_GGUF_PATH:
    RAG_LOCAL_MODEL_GGUF_PATH = str(_resolve_model_path(RAG_LOCAL_MODEL_GGUF_PATH))
RAG_LOCAL_MODEL_FORMAT = os.environ.get("RAG_LOCAL_MODEL_FORMAT", "transformers")
RAG_LOCAL_MODEL_CONTEXT_SIZE = _parse_int_env("RAG_LOCAL_MODEL_CONTEXT_SIZE", 8192)
RAG_LOCAL_MODEL_TRUST_REMOTE_CODE = _parse_bool_env("RAG_LOCAL_MODEL_TRUST_REMOTE_CODE", False)
RAG_LOCAL_MODEL_THREADS = _parse_int_env("RAG_LOCAL_MODEL_THREADS", max(os.cpu_count() or 4, 1))
# Who: Tim Buglaev
# When: 2026-04-06
# What: Added strict local runtime provider parsing so app can switch between embedded local inference
#       and loopback-only vLLM serving while rejecting cloud-style provider semantics.
RAG_RUNTIME_PROVIDER_RAW = os.environ.get("RAG_RUNTIME_PROVIDER", "local").strip().lower()
if RAG_RUNTIME_PROVIDER_RAW in ("vllm", "vllm_local", "vllm_openai", "openai_compatible"):
    if RAG_RUNTIME_PROVIDER_RAW in ("vllm_openai", "openai_compatible"):
        print(f"[INFO] Mapping legacy provider '{RAG_RUNTIME_PROVIDER_RAW}' to local provider 'vllm_local'")
    RAG_RUNTIME_PROVIDER = "vllm_local"
elif RAG_RUNTIME_PROVIDER_RAW == "llama_cpp_server":
    RAG_RUNTIME_PROVIDER = "llama_cpp_server"
else:
    if RAG_RUNTIME_PROVIDER_RAW not in ("", "local"):
        print(f"[INFO] Unsupported RAG_RUNTIME_PROVIDER='{RAG_RUNTIME_PROVIDER_RAW}', using 'local'")
    RAG_RUNTIME_PROVIDER = "local"
RAG_VLLM_BASE_URL = os.environ.get("RAG_VLLM_BASE_URL", "http://127.0.0.1:8000/v1").strip()
if not RAG_VLLM_BASE_URL:
    RAG_VLLM_BASE_URL = "http://127.0.0.1:8000/v1"
RAG_VLLM_MODEL_ID = (os.environ.get("RAG_VLLM_MODEL_ID") or "").strip()
# Who: Tim Buglaev
# When: 2026-06-14
# What: Separate the real source model served by vLLM from the local OpenAI-compatible
#       served name so startup can use --served-model-name without treating local-model as HF id.
RAG_VLLM_SOURCE_MODEL_ID = (os.environ.get("RAG_VLLM_SOURCE_MODEL_ID") or "").strip()
RAG_VLLM_TIMEOUT_SECONDS = _parse_float_env("RAG_VLLM_TIMEOUT_SECONDS", 45.0)
if RAG_VLLM_TIMEOUT_SECONDS <= 0:
    RAG_VLLM_TIMEOUT_SECONDS = 45.0
RAG_VLLM_VERIFY_TLS = _parse_bool_env("RAG_VLLM_VERIFY_TLS", True)
RAG_LLAMA_SERVER_BASE_URL = os.environ.get("RAG_LLAMA_SERVER_BASE_URL")
RAG_LLAMA_SERVER_TIMEOUT_SECONDS = _parse_float_env("RAG_LLAMA_SERVER_TIMEOUT_SECONDS", 120.0)
RAG_NOTE_TITLE_METHOD = _title_method(
    os.environ.get("RAG_NOTE_TITLE_METHOD", "reviewed")
).name
# Who: Tim Buglaev
# When: 2026-06-14
# What: Bound managed vLLM startup resource settings so a Windows/WSL launch on 12GB GPUs
#       uses a predictable context size and memory budget instead of vLLM model defaults.
RAG_VLLM_MAX_MODEL_LEN = _parse_int_env("RAG_VLLM_MAX_MODEL_LEN", 2048)
RAG_VLLM_MAX_MODEL_LEN = RAG_VLLM_MAX_MODEL_LEN if RAG_VLLM_MAX_MODEL_LEN > 0 else 2048
RAG_VLLM_GPU_MEMORY_UTILIZATION = _parse_float_env("RAG_VLLM_GPU_MEMORY_UTILIZATION", 0.75)
if RAG_VLLM_GPU_MEMORY_UTILIZATION <= 0 or RAG_VLLM_GPU_MEMORY_UTILIZATION > 0.95:
    RAG_VLLM_GPU_MEMORY_UTILIZATION = 0.75
RAG_VLLM_ENFORCE_EAGER = _parse_bool_env("RAG_VLLM_ENFORCE_EAGER", True)
# Who: Tim Buglaev
# When: 2026-05-28
# What: Normalized TurboQuant environment settings to concrete vLLM KV-cache dtype
#       presets, repairing unsupported legacy K/V pairs at startup without leaking
#       invalid runtime state into API responses.
TURBOQUANT_ENABLED = _parse_bool_env("TURBOQUANT_ENABLED", False)
TURBOQUANT_K_BITS = _parse_int_env("TURBOQUANT_K_BITS", 4)
TURBOQUANT_V_BITS = _parse_int_env("TURBOQUANT_V_BITS", 4)
TURBOQUANT_K_BITS = max(1, min(8, TURBOQUANT_K_BITS))
TURBOQUANT_V_BITS = max(1, min(8, TURBOQUANT_V_BITS))
TURBOQUANT_KV_CACHE_DTYPE = _normalize_turboquant_kv_cache_dtype(
    os.environ.get("TURBOQUANT_KV_CACHE_DTYPE"),
    enabled=TURBOQUANT_ENABLED,
    k_bits=TURBOQUANT_K_BITS,
    v_bits=TURBOQUANT_V_BITS,
    strict=False,
)
if TURBOQUANT_KV_CACHE_DTYPE:
    TURBOQUANT_K_BITS, TURBOQUANT_V_BITS = _turboquant_bits_for_dtype(
        TURBOQUANT_KV_CACHE_DTYPE,
        TURBOQUANT_K_BITS,
        TURBOQUANT_V_BITS,
    )
if LLAMA_CPP_CTX_MAX and LLAMA_CPP_CTX_MAX > 0:
    if GGUF_N_CTX:
        GGUF_N_CTX = min(GGUF_N_CTX, LLAMA_CPP_CTX_MAX)
    RAG_LOCAL_MODEL_CONTEXT_SIZE = min(RAG_LOCAL_MODEL_CONTEXT_SIZE, LLAMA_CPP_CTX_MAX)
# Training / retraining configuration
TRAINING_VALIDATION_SPLIT = _parse_float_env("TRAINING_VALIDATION_SPLIT", 0.1)
TRAINING_MAX_EPOCHS = _parse_int_env("TRAINING_MAX_EPOCHS", 3)
TRAINING_EARLY_STOPPING_PATIENCE = _parse_int_env("TRAINING_EARLY_STOPPING_PATIENCE", 2)
TRAINING_EARLY_STOPPING_DELTA = _parse_float_env("TRAINING_EARLY_STOPPING_DELTA", 0.02)
TRAINING_LR = _parse_float_env("TRAINING_LR", 2e-4)
TRAINING_LORA_R = _parse_int_env("TRAINING_LORA_R", 16)
TRAINING_LORA_ALPHA = _parse_int_env("TRAINING_LORA_ALPHA", 32)
TRAINING_LORA_DROPOUT = _parse_float_env("TRAINING_LORA_DROPOUT", 0.05)
TRAINING_WARMUP_RATIO = _parse_float_env("TRAINING_WARMUP_RATIO", 0.02)
TRAINING_MAX_SEQ_LENGTH = _parse_int_env("TRAINING_MAX_SEQ_LENGTH", min(RAG_LOCAL_MODEL_CONTEXT_SIZE, 8192))
TRAINING_GRAD_ACCUM_STEPS = _parse_int_env("TRAINING_GRAD_ACCUM_STEPS", 4)
TRAINING_DEGRADATION_TOLERANCE = _parse_float_env("TRAINING_DEGRADATION_TOLERANCE", 0.05)
TRAINING_REQUIRE_GPU = _parse_bool_env("TRAINING_REQUIRE_GPU", False)
TRAINING_SCHEDULE_MINUTES = _parse_int_env("TRAINING_SCHEDULE_MINUTES", 0)
TRAINING_STATUS_PATH = os.environ.get("TRAINING_STATUS_PATH", str(BASE_DIR / "storage" / "pipeline" / "status.json"))
TRAINING_DATASET_PATH = os.environ.get("TRAINING_DATASET_PATH", str(BASE_DIR / "storage" / "pipeline" / "dataset" / "notes.jsonl"))
TRAINING_ARTIFACTS_DIR = os.environ.get("TRAINING_ARTIFACTS_DIR", str(BASE_DIR / "storage" / "pipeline" / "artifacts"))
TRAINING_DEFAULT_GGUF_FILENAME = os.environ.get("TRAINING_GGUF_FILENAME")

SELECTED_QUANTIZATION_BACKEND = (SELECTED_QUANTIZATION_BACKEND or QUANTIZATION_BACKEND_ENV).strip().lower()
gguf_available = GGUF_INFO.get("available", False)
gguf_requested = SELECTED_QUANTIZATION_BACKEND == "gguf" or USE_GGUF
if gguf_requested and not gguf_available and RAG_RUNTIME_PROVIDER != "llama_cpp_server":
    fallback_reason = GGUF_INFO.get("message") or GGUF_INFO.get("error") or "llama-cpp-python not installed"
    if fallback_reason == "not_checked":
        fallback_reason = "llama-cpp-python not installed"
    print(f"[WARNING] GGUF backend disabled: {fallback_reason}. Falling back to transformers.")
    SELECTED_QUANTIZATION_BACKEND = "full"
    USE_GGUF = False
    gguf_requested = False
    RAG_LOCAL_MODEL_FORMAT = "transformers"
    RAG_LOCAL_MODEL_GGUF_PATH = None
    RAG_LOCAL_MODEL_QUANTIZATION = None
if gguf_requested and not RAG_LOCAL_MODEL_GGUF_PATH:
    RAG_LOCAL_MODEL_GGUF_PATH = GGUF_MODEL_PATH
if gguf_requested:
    RAG_LOCAL_MODEL_FORMAT = "llama_cpp"
    RAG_LOCAL_MODEL_QUANTIZATION = None
    RAG_LOCAL_MODEL_CONTEXT_SIZE = GGUF_N_CTX or RAG_LOCAL_MODEL_CONTEXT_SIZE
    RAG_LOCAL_MODEL_THREADS = GGUF_N_THREADS or RAG_LOCAL_MODEL_THREADS
elif SELECTED_QUANTIZATION_BACKEND == "bitsandbytes":
    USE_BITSANDBYTES = True
elif SELECTED_QUANTIZATION_BACKEND == "gptq":
    RAG_LOCAL_MODEL_QUANTIZATION = "gptq"
elif SELECTED_QUANTIZATION_BACKEND == "full":
    RAG_LOCAL_MODEL_QUANTIZATION = None
# Who: Tim Buglaev
# When: 2026-04-06
# What: Bound vLLM mode to local-only execution format (vllm_local) and preserved deterministic runtime
#       model id selection so fallback/local behavior remains predictable across reloads.
if not RAG_VLLM_MODEL_ID:
    RAG_VLLM_MODEL_ID = RAG_LOCAL_MODEL_ID
if not RAG_VLLM_SOURCE_MODEL_ID:
    RAG_VLLM_SOURCE_MODEL_ID = RAG_LOCAL_MODEL_ID
if RAG_RUNTIME_PROVIDER == "vllm_local":
    RAG_LOCAL_MODEL_FORMAT = "vllm_local"
    RAG_LOCAL_MODEL_QUANTIZATION = None
    print(f"Runtime provider: vllm_local ({RAG_VLLM_BASE_URL})")
elif RAG_RUNTIME_PROVIDER == "llama_cpp_server":
    RAG_LOCAL_MODEL_FORMAT = "llama_cpp_server"
    RAG_LOCAL_MODEL_QUANTIZATION = None
    RAG_LOCAL_MODEL_GGUF_PATH = RAG_LOCAL_MODEL_GGUF_PATH or GGUF_MODEL_PATH
    RAG_LOCAL_MODEL_CONTEXT_SIZE = GGUF_N_CTX or RAG_LOCAL_MODEL_CONTEXT_SIZE
    print("Runtime provider: llama_cpp_server")
else:
    print("Runtime provider: local")

# Who: Tim Buglaev
# When: 2026-06-15
# What: Report the actual active runtime model id for each backend, using the
#       GGUF file path for local llama.cpp so status/config and startup selection
#       do not drift back to the transformers base model id.
def _current_runtime_model_id():
    if RAG_RUNTIME_PROVIDER == "vllm_local":
        return RAG_VLLM_MODEL_ID
    if RAG_LOCAL_MODEL_FORMAT in ("llama_cpp", "llama_cpp_server"):
        return RAG_LOCAL_MODEL_GGUF_PATH or GGUF_MODEL_PATH or RAG_LOCAL_MODEL_ID
    return RAG_LOCAL_MODEL_ID


RAG_RUNTIME_MODEL_ID = _current_runtime_model_id()

if _check_bnb:
    _bnb_info = _check_bnb()
    BITSANDBYTES_AVAILABLE = _bnb_info.get("available", False)
    BITSANDBYTES_ERROR = _bnb_info.get("error")
else:
    BITSANDBYTES_AVAILABLE, BITSANDBYTES_ERROR = _bitsandbytes_status()
GPTQ_AVAILABLE, GPTQ_ERROR = _gptq_status()
GGUF_AVAILABLE = gguf_available

# Who: Tim Buglaev
# When: 2026-06-14
# What: Suppress local bitsandbytes diagnostics in managed vLLM mode because
#       Windows does not load the embedded transformer pipeline on that path.
if BITSANDBYTES_ERROR == "disabled_on_windows" and RAG_RUNTIME_PROVIDER != "vllm_local":
    print("bitsandbytes disabled on Windows (use QUANTIZATION_BACKEND=bitsandbytes to enable)")

# Who: Tim Buglaev
# When: 2026-06-14
# What: Report the active quantization path accurately in managed vLLM mode so
#       Windows startup logs do not claim GGUF/local fallback while WSL vLLM
#       actually serves the model with TurboQuant KV-cache settings.
if RAG_RUNTIME_PROVIDER == "vllm_local":
    if TURBOQUANT_ENABLED and TURBOQUANT_KV_CACHE_DTYPE:
        print(f"Managed runtime quantization: vLLM TurboQuant KV-cache ({TURBOQUANT_KV_CACHE_DTYPE})")
    else:
        print("Managed runtime quantization: vLLM default")
else:
    if SELECTED_QUANTIZATION_BACKEND == "gguf":
        label = "Quantization backend: gguf (auto-selected for Windows)" if _is_windows_os_helper() else "Quantization backend: gguf"
        print(label)
    elif SELECTED_QUANTIZATION_BACKEND == "bitsandbytes":
        print("Quantization backend: bitsandbytes")
    elif SELECTED_QUANTIZATION_BACKEND == "gptq":
        print("Quantization backend: gptq")
    else:
        print(f"Quantization backend: {SELECTED_QUANTIZATION_BACKEND}")

    if (SELECTED_QUANTIZATION_BACKEND == "gguf" or USE_GGUF) and RAG_LOCAL_MODEL_GGUF_PATH:
        print(f"Using GGUF model: {RAG_LOCAL_MODEL_GGUF_PATH}")

if SELECTED_QUANTIZATION_BACKEND == "bitsandbytes" and not BITSANDBYTES_AVAILABLE:
    quant_value = (str(RAG_LOCAL_MODEL_QUANTIZATION or "")).strip().lower()
    if quant_value not in ("", "none", "off"):
        reason_text = f" ({BITSANDBYTES_ERROR})" if BITSANDBYTES_ERROR else ""
        if GPTQ_AVAILABLE:
            print(f"bitsandbytes not found{reason_text}, using GPTQ fallback.")
            RAG_LOCAL_MODEL_QUANTIZATION = "gptq"
        else:
            print(f"bitsandbytes not found{reason_text}, quantization disabled (CPU mode).")
            RAG_LOCAL_MODEL_QUANTIZATION = None

def run_training_if_needed():
    """Checks for new notes and runs the fine-tuning pipeline if necessary."""
    if not all([TrainingPipeline, PipelineConfig]):
        print("[WARNING] Training pipeline components not available, skipping.")
        return

    print("[START] Checking for new notes to fine-tune the model...")

    try:
        config = PipelineConfig(
            notes_dir=NOTES_DIR,
            trained_notes_path=_project_data_path("training/trained_notes.json", BASE_DIR / "storage" / "trained_notes.json"),
            adapter_path=_project_data_path("training/artifacts/adapter", BASE_DIR / "models" / "lora_adapters"),
            artifacts_dir=_project_data_path("training/artifacts", BASE_DIR / "storage" / "pipeline" / "artifacts"),
            dataset_path=_project_data_path("training/dataset/notes.jsonl", BASE_DIR / "storage" / "pipeline" / "dataset" / "notes.jsonl"),
            model_id=RAG_LOCAL_MODEL_ID,
            require_gpu=TRAINING_REQUIRE_GPU,
        )

        pipeline = TrainingPipeline(config)
        result = pipeline.run()

        if result.success:
            if result.status == 'skipped':
                print(f"[SUCCESS] Training skipped: {result.message}")
            else:
                print(f"[SUCCESS] Training successful: {result.message}")
        else:
            print(f"[ERROR] Training failed: {result.message}")

    except Exception as e:
        print(f"[ERROR] An error occurred during the training pipeline execution: {e}")

# Временно отключаем автоматическое обучение при старте
# run_training_if_needed()
NOTE_BASE_TITLE = os.environ.get("NOTE_BASE_TITLE", "Заметка")
MODEL_INIT_RESULT = None


# Who: Tim Buglaev
# When: 2026-03-26
# What: Added explicit accessors for MODEL_INIT_RESULT so extracted route modules can update/read shared
#       initialization state without relying on module-level globals inside app.py.
def _get_model_init_result():
    return MODEL_INIT_RESULT


def _set_model_init_result(value):
    global MODEL_INIT_RESULT
    MODEL_INIT_RESULT = value


MODEL_READY_TIMEOUT = _parse_float_env("MODEL_READY_TIMEOUT", 90.0)
if IS_TEST_ENV:
    MODEL_READY_TIMEOUT = min(MODEL_READY_TIMEOUT, 5.0)
MODEL_READY_POLL_INTERVAL = 0.25

# Who: Tim Buglaev
# When: 2026-03-07
# What: Added bounded prompt validation and background queue settings to keep rapid note intake safe and
#       sequential, preventing race conditions during concurrent note generation.
MAX_PROMPT_CHARS = _parse_int_env("MAX_PROMPT_CHARS", 4000)
GENERATE_QUEUE_MAX_SIZE = _parse_int_env("GENERATE_QUEUE_MAX_SIZE", 200)
GENERATE_QUEUE_JOB_TTL_SECONDS = _parse_int_env("GENERATE_QUEUE_JOB_TTL_SECONDS", 3600)
# Who: Tim Buglaev
# When: 2026-03-09
# What: Added strict quality toggles for prompt-grounded generation so tagging/linking defaults to conservative
#       behavior and avoids injecting unrelated entities under noisy context overlap.
STRICT_EXISTING_TAGS = _parse_bool_env("STRICT_EXISTING_TAGS", True)
STRICT_PROMPT_GROUNDING = _parse_bool_env("STRICT_PROMPT_GROUNDING", True)
NOTE_GENERATION_LOCK = threading.Lock()


# Who: Tim Buglaev
# When: 2026-03-07
# What: Added strict prompt normalization to reject empty and oversized inputs early for direct and queued
#       generation flows, preserving predictable server behavior.
def _validate_prompt_text(prompt_raw):
    prompt_text = "" if prompt_raw is None else str(prompt_raw).strip()
    if not prompt_text:
        raise ValueError("Prompt text is required")
    if MAX_PROMPT_CHARS > 0 and len(prompt_text) > MAX_PROMPT_CHARS:
        raise ValueError(f"Prompt text is too long (max {MAX_PROMPT_CHARS} chars)")
    return prompt_text


# Who: Tim Buglaev
# When: 2026-03-25
# What: Simplified source resolver to strict local-only mode so queue/direct generation paths cannot opt into
#       remote providers via payload or query parameters.
def _resolve_generate_source(payload, source_provided=False):
    return "local"


# Who: Tim Buglaev
# When: 2026-03-26
# What: Queue orchestration class moved to backend/services/note_generation_queue.py to isolate
#       concurrent job scheduling from Flask bootstrap code.

if model_manager:
    try:
        model_manager.model_cache_dir = model_manager._get_cache_directory()
    except Exception as cache_exc:
        print(f"Не удалось обновить каталог кэша моделей: {cache_exc}")

# Создаём локальную RAG-модель с загруженными параметрами
if IS_TEST_ENV:
    try:
        from unittest.mock import MagicMock
        _mock_local = MagicMock()
        _mock_local.generate_note.return_value = "Тестовая заметка из локальной модели"
        _mock_local.generate_answer.return_value = "Ответ локальной модели"
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Give the test double an explicit grounded-generation budget contract so
        #       endpoint tests exercise bounded prompts instead of an iterable MagicMock.
        _mock_local.grounded_generation_limits.return_value = (512, 12000)
        _mock_local.name = "local-mock"
        local_rag_model = _mock_local
    except Exception:
        local_rag_model = _create_local_rag_model()
else:
    local_rag_model = _create_local_rag_model()

try:
    _load_embedding_model(startup=True)
except Exception as embedding_exc:
    logger.warning("Embedding model preload failed: %s", embedding_exc)

if not IS_TEST_ENV:
    _init_qdrant_service()
    atexit.register(_cleanup_qdrant_process)

# Who: Tim Buglaev
# When: 2026-03-25
# What: Removed remote-client bootstrap to prevent accidental cloud initialization during module import,
#       including test mode and fallback branches; client remains None by design.
client = None

# --- директория заметок Obsidian ---

# Функция для проверки директории (объявляем до использования)
def validate_notes_dir():
    """Проверяет существование директории с заметками"""
    # Пересчитываем путь каждый раз для поддержки мокирования в тестах
    notes_dir = get_notes_dir()
    exists_fn = getattr(notes_dir, "exists", None)
    try:
        is_available = exists_fn() if callable(exists_fn) else False
    except Exception:
        is_available = False

    try:
        resolved_dir = notes_dir.resolve()
    except Exception:
        resolved_dir = notes_dir

    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Render NOTES_DIR with readable Unicode where the console supports it,
    #       falling back to escaped text only for non-Unicode log sinks.
    display_resolved_dir = _format_path_for_log(resolved_dir)
    if is_available:
        print("NOTES_DIR =", display_resolved_dir)
        return True

    print(f"[WARNING] Notes directory not found: {display_resolved_dir}")
    # Выбрасываем RuntimeError, если директория не существует
    raise RuntimeError(f"Notes directory not found: {resolved_dir}")

# Итератор по файлам заметок с поддержкой поддиректорий и моков
def _iter_note_files(notes_dir):
    """
    Возвращает все .md файлы (включая поддиректории).
    Для моков, у которых glob настроен в тестах, сначала вызываем glob('*.md'),
    затем пытаемся glob('**/*.md') и отфильтровываем дубликаты.
    """
    seen = set()
    for pattern in ("*.md", "**/*.md"):
        if not hasattr(notes_dir, "glob"):
            continue
        try:
            for note_file in notes_dir.glob(pattern):
                # Пропускаем скрытые служебные каталоги (.obsidian и т.п.)
                parts = getattr(note_file, "parts", ())
                if any(str(part).startswith(".") for part in parts):
                    continue
                key = str(getattr(note_file, "resolve", lambda: note_file)())
                if key in seen:
                    continue
                seen.add(key)
                yield note_file
        except Exception as glob_err:
            print(f"Предупреждение: glob('{pattern}') завершился ошибкой: {glob_err}")
            continue

# Проверяем существование директории после создания клиента
# Если директория не существует - выбрасываем исключение
# Тесты должны мокировать Path.exists() чтобы обойти эту проверку
def _pathlib_path_is_mocked():
    """Return True when pathlib.Path was patched to a mock."""
    try:
        from unittest.mock import Mock
    except ImportError:
        return False
    return isinstance(pathlib.Path, Mock)


try:
    validate_notes_dir()
except RuntimeError as err:
    # Who: Tim Buglaev
    # When: 2026-03-26
    # What: Relaxed notes directory hard-fail in test mode to avoid brittle fixture path-mocking edge cases
    #       while keeping strict validation in real runtime environments.
    if _pathlib_path_is_mocked() or _is_test_env():
        print(f"WARNING: {err}")
    else:
        raise

# Who: Tim Buglaev
# When: 2026-03-25
# What: Removed cloud-client mock initialization because local-only mode must not expose remote client
#       semantics even in tests; this avoids false-positive test paths that rely on cloud mocks.


def extract_tags(markdown_text: str):
    try:
        from backend.note_generation_contract import extract_note_tags
    except ImportError:
        from note_generation_contract import extract_note_tags
    return extract_note_tags(markdown_text)


def _generate_snippet(content, query):
    text = (content or "").strip()
    if not text:
        return ""
    length = RAG_SNIPPET_LENGTH if RAG_SNIPPET_LENGTH > 0 else 100
    query_lower = (query or "").lower()
    lower_text = text.lower()
    index = lower_text.find(query_lower) if query_lower else -1
    start = max(0, index - 50) if index >= 0 else 0
    snippet = text[start:start + length]
    if len(snippet) < len(text):
        snippet = snippet.rstrip()
        if snippet and not snippet.endswith("..."):
            snippet += "..."
    return _normalize_snippet_text(snippet)


def _normalize_snippet_text(snippet):
    text = (snippet or "").strip()
    if not text:
        return ""
    length = RAG_SNIPPET_LENGTH if RAG_SNIPPET_LENGTH > 0 else 400
    if len(text) > length:
        text = text[:length].rstrip()
        if not text.endswith("..."):
            text += "..."
    return text


def _extract_links_from_content(content):
    try:
        from backend.note_generation_contract import extract_note_links
    except ImportError:
        from note_generation_contract import extract_note_links
    return extract_note_links(content)


# Who: Tim Buglaev
# When: 2026-06-13
# What: Added Markdown/Obsidian cleanup for RAG indexing so Qdrant and retrieval use plain
#       text without image assets, service comments, code blocks, or tag/link syntax noise.
_RAG_IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".avif",
    ".ico",
    ".tif",
    ".tiff",
}


def _strip_markdown_frontmatter(text):
    return re.sub(r"\A\s*---\s*[\s\S]*?\n---\s*", " ", text or "", count=1)


def _is_image_reference(target):
    clean_target = (target or "").strip().split("|", 1)[0].split("#", 1)[0].split("?", 1)[0]
    suffix = pathlib.Path(clean_target).suffix.lower()
    return suffix in _RAG_IMAGE_EXTENSIONS


def _wikilink_to_plain_text(match):
    target = (match.group(1) or "").strip()
    if not target or _is_image_reference(target):
        return " "
    if "|" in target:
        target = target.rsplit("|", 1)[1]
    else:
        target = target.split("#", 1)[0]
    return re.sub(r"\s+", " ", target).strip() or " "


def _strip_markdown_binary_assets(text):
    cleaned = text or ""
    cleaned = re.sub(r"!\[\[[^\[\]]+\]\]", " ", cleaned)
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", cleaned)
    cleaned = re.sub(r"(?is)<img\b[^>]*>", " ", cleaned)
    cleaned = re.sub(r"(?is)data:image/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+", " ", cleaned)
    return cleaned


# Who: Tim Buglaev
# When: 2026-06-14
# What: Strip standalone hashtag metadata lines before heading cleanup so lines like
#       "#parser #tg" do not become the plain token "parser" in Qdrant embeddings.
def _strip_standalone_hashtag_metadata_lines(text):
    return re.sub(
        r"(?im)^\s*(?:#[\w\-/\u0400-\u04FF]+\s*)+$",
        " ",
        text or "",
    )


# Who: Tim Buglaev
# When: 2026-06-14
# What: Bound index text size after Markdown cleanup to keep embeddings predictable for
#       very large notes while preserving full raw Markdown on disk and in the editor.
def _limit_rag_index_text(text):
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    max_chars = max(0, int(RAG_MAX_INDEX_TEXT_CHARS or 0))
    if max_chars <= 0 or len(value) <= max_chars:
        return value
    truncated = value[:max_chars].rsplit(" ", 1)[0].strip()
    return truncated or value[:max_chars].strip()


def _clean_note_text_for_rag(content):
    try:
        from backend.markdown_retrieval import clean_retrieval_text
    except ImportError:
        from markdown_retrieval import clean_retrieval_text
    return clean_retrieval_text(content, max_chars=max(0, int(RAG_MAX_INDEX_TEXT_CHARS or 0)))


def _clean_generated_note_output(content):
    text = str(content or "")
    repairer = globals().get("_repair_mojibake_text")
    if callable(repairer):
        text = repairer(text)
    text = _strip_markdown_binary_assets(text)
    text = re.sub(r"(?s)<!--.*?-->", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _rag_note_noise_report(title, content, tags=None, clean_text=None):
    """Report repetition as a diagnostic; content patterns never exclude user notes."""
    raw_tags = list(tags if tags is not None else extract_tags(content or ""))
    normalized_tags = [str(tag or "").strip().lower() for tag in raw_tags if str(tag or "").strip()]
    clean_value = clean_text if clean_text is not None else _clean_note_text_for_rag(content)
    tokens = re.findall(r"[^\W_]+", (clean_value or "").casefold())
    unique_tokens = set(tokens)
    duplicate_ratio = 0.0
    if tokens:
        duplicate_ratio = 1.0 - (len(unique_tokens) / max(1, len(tokens)))
    repeated_tag_count = 0
    if normalized_tags:
        try:
            repeated_tag_count = max(normalized_tags.count(tag) for tag in set(normalized_tags))
        except ValueError:
            repeated_tag_count = 0
    reasons = []
    if len(raw_tags) > max(0, int(RAG_NOISE_MAX_TAGS_PER_NOTE or 0)):
        reasons.append(f"too_many_tags:{len(raw_tags)}")
    if repeated_tag_count > max(0, int(RAG_NOISE_REPEATED_TAG_THRESHOLD or 0)):
        reasons.append(f"repeated_tag:{repeated_tag_count}")
    if len(tokens) >= max(1, int(RAG_NOISE_MIN_TOKENS or 1)) and duplicate_ratio >= float(RAG_NOISE_DUPLICATE_TOKEN_RATIO or 1.0):
        reasons.append(f"duplicate_tokens:{duplicate_ratio:.2f}")
    return {
        "title": str(title or ""),
        "excluded": False,
        "reasons": reasons,
        "tag_count": len(raw_tags),
        "repeated_tag_count": repeated_tag_count,
        "token_count": len(tokens),
        "unique_token_count": len(unique_tokens),
        "duplicate_token_ratio": duplicate_ratio,
    }


def _is_rag_noise_note(title, content, tags=None, clean_text=None):
    return bool(_rag_note_noise_report(title, content, tags=tags, clean_text=clean_text).get("excluded"))


def _extract_explicit_note_mentions(prompt):
    """Возвращает названия заметок, которые явно упомянуты в тексте запроса.
    Использует сопоставление по целым словам для избежания ложных совпадений."""
    normalized_prompt = re.sub(r"\s+", " ", (prompt or "")).strip().lower()
    if not normalized_prompt:
        return []
    mentions = []
    seen = set()
    with _notes_cache_lock:
        titles = list(notes_data.keys())
    for raw_title in titles:
        title = str(raw_title or "").strip()
        if not title:
            continue
        normalized_title = re.sub(r"\s+", " ", title).lower()
        if normalized_title in seen:
            continue
        # Who: Tim Buglaev
        # When: 2026-03-09
        # What: Allowed short all-caps note titles (e.g., CRM, API) in explicit mention detection while keeping
        #       previous short-title guard for regular words to avoid false positives on tiny tokens.
        allow_short_acronym = bool(re.fullmatch(r"[A-ZА-ЯЁ0-9]{2,6}", title))
        if len(normalized_title) < 4 and not allow_short_acronym:
            continue
        # Проверяем совпадение по целым словам (word boundary)
        try:
            pattern = r"(?:^|\b|\s)" + re.escape(normalized_title) + r"(?:\b|\s|$)"
            if re.search(pattern, normalized_prompt):
                mentions.append(title)
                seen.add(normalized_title)
        except re.error:
            # Fallback: точное совпадение фразы
            if normalized_title in normalized_prompt:
                mentions.append(title)
                seen.add(normalized_title)
    return mentions


