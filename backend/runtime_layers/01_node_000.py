# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

"""
Flask RAG Application with Local Model Training

CRITICAL WARNINGS FOR AI AGENTS AND DEVELOPERS:
================================================

1. WINDOWS CONSOLE ENCODING FIX (lines ~96-175)
   - DO NOT modify _install_windows_stdio_guard() function
   - DO NOT remove colorama patches
   - Any changes will cause "OSError: Windows error 6" crash
   - See AGENT_RULES.md for details

2. NO EMOJI IN PRINT/LOG STATEMENTS
   - Windows console (cp1251) cannot handle Unicode emoji
   - Use [WARNING], [SUCCESS], [ERROR] instead of ⚠️, ✅, ❌
   - Causes UnicodeEncodeError and crashes

3. DO NOT REMOVE sys.stdout.reconfigure(encoding="utf-8")
   - Required for UTF-8 support on Windows
   - Located around line ~1094

For full rules see: AGENT_RULES.md
"""

import os
import re
import sys
import json
import pathlib
import threading
import time
import subprocess
import atexit
import logging
import uuid
import warnings
import hashlib
import difflib
from types import SimpleNamespace

# Who: Tim Buglaev
# When: 2026-06-22
# What: Import deterministic Markdown chunking and strict source-grounding helpers into
#       the shared runtime namespace used by the ordered architecture layers.
try:
    from backend.rag_chunks import build_note_chunks, note_chunk_point_id
    from backend.rag_indexing import index_note_chunks
    from backend.rag_grounding import (
        NO_INFORMATION_RESPONSE,
        build_grounded_answer_prompt,
        parse_grounded_answer,
        prepare_grounded_candidates,
    )
    from backend.rag_lexical import lexical_sparse_vector
except Exception:
    from rag_chunks import build_note_chunks, note_chunk_point_id  # type: ignore
    from rag_indexing import index_note_chunks  # type: ignore
    from rag_grounding import (  # type: ignore
        NO_INFORMATION_RESPONSE,
        build_grounded_answer_prompt,
        parse_grounded_answer,
        prepare_grounded_candidates,
    )
    from rag_lexical import lexical_sparse_vector  # type: ignore

from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv
import requests

try:
    from backend.routes import register_app_routes
    from backend.services.note_generation_queue import NoteGenerationQueue
except Exception:
    from routes import register_app_routes  # type: ignore
    from services.note_generation_queue import NoteGenerationQueue  # type: ignore
# Who: Tim Buglaev
# When: 2026-03-09
# What: Split optional dependency imports so missing peft no longer disables transformers pipeline initialization;
#       this keeps local generation available while gracefully turning off only LoRA adapter loading.
try:
    import transformers
    from transformers import AutoModelForCausalLM
except Exception as exc:
    print(f"WARNING: transformers import failed: {exc}")
    transformers = None
    AutoModelForCausalLM = None

try:
    from peft import PeftModel
except Exception as exc:
    print(f"WARNING: peft import failed (LoRA adapters disabled): {exc}")
    PeftModel = None

try:
    from model_init import (
        check_bitsandbytes_availability as _check_bnb,
        check_gguf_availability as _check_gguf,
        get_quantization_backend as _get_quant_backend,
        is_windows as _is_windows_os_helper,
    )
except Exception:
    _check_bnb = None
    _check_gguf = None
    _get_quant_backend = None

    def _is_windows_os_helper():
        import sys as _sys  # local import to avoid shadowing module-level sys

        return _sys.platform.startswith("win")

# Импортируем model_manager на уровне модуля (не в HTTP-обработчиках!)
try:
    from model_manager import model_manager
except ImportError:
    model_manager = None
    print("WARNING: model_manager не удалось импортировать")

try:
    from training_pipeline import PipelineConfig, PipelineResult, TrainingPipeline
except Exception:
    PipelineConfig = None
    PipelineResult = None
    TrainingPipeline = None

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler, PatternMatchingEventHandler
except ImportError:
    Observer = None
    FileSystemEventHandler = None
    PatternMatchingEventHandler = None

try:
    from backend import config as backend_config
    from backend.config import (
        MAX_LINKS,
        MAX_TAGS,
        TOP_K_SEARCH,
        SIM_THRESHOLD,
        UPDATE_ON_SAVE,
    )
except Exception:
    try:
        import config as backend_config  # type: ignore
        from config import (
            MAX_LINKS,
            MAX_TAGS,
            TOP_K_SEARCH,
            SIM_THRESHOLD,
            UPDATE_ON_SAVE,
        )
    except Exception:
        backend_config = None
        MAX_LINKS, MAX_TAGS, TOP_K_SEARCH, SIM_THRESHOLD, UPDATE_ON_SAVE = 5, 5, 10, 0.5, False

try:
    from backend.qdrant_service import QdrantService
except Exception:
    try:
        from qdrant_service import QdrantService  # type: ignore
    except Exception:
        QdrantService = None

# Гарантируем вывод в UTF-8 (актуально для Windows-консолей)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# Path - устанавливаем по умолчанию, но НЕ перезаписываем если уже установлен (патч в тестах)
# При reload модуля патч сохраняется
if 'Path' not in dir():
    Path = pathlib.Path

try:
    from colored_logger import get_logger
    logger = get_logger(__name__)
except ImportError:
    logger = logging.getLogger(__name__)

_WINDOWS_STDIO_PATCHED = False


def _is_winerror_6(exc):
    try:
        return isinstance(exc, OSError) and getattr(exc, "winerror", None) == 6
    except Exception:
        return False


def _install_windows_stdio_guard():
    """
    Protects Flask banner output on Windows when stdout/stderr handles are invalid (winerror 6).
    Wraps click/colorama writers to suppress the specific OSError while keeping startup running.

    [WARNING][WARNING][WARNING] CRITICAL - DO NOT MODIFY THIS FUNCTION [WARNING][WARNING][WARNING]
    This fixes persistent "OSError: Windows error 6" crashes on Flask startup.
    Any modifications will break Windows console compatibility.
    If you see encoding errors during startup, the fix MUST be applied HERE.
    DO NOT remove or refactor this code without testing on Windows first.
    """
    global _WINDOWS_STDIO_PATCHED
    if _WINDOWS_STDIO_PATCHED or not _is_windows_os_helper():
        return

    # Step 1: Disable colorama to prevent double-encoding issues
    try:
        import colorama
        colorama.deinit()
    except Exception:
        pass

    try:
        import click
        import flask.cli as flask_cli
    except Exception:
        return

    def _wrap(func):
        if func is None or getattr(func, "_winerror6_safe", False):
            return func

        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except (OSError, UnicodeEncodeError, UnicodeDecodeError) as exc:
                # Catch Windows error 6 AND any encoding errors
                if isinstance(exc, OSError) and _is_winerror_6(exc):
                    return None
                if isinstance(exc, (UnicodeEncodeError, UnicodeDecodeError)):
                    # Silently suppress encoding errors on Windows
                    return None
                raise
            except Exception:
                # Last resort: catch any unexpected errors during banner display
                return None

        wrapper._winerror6_safe = True  # type: ignore[attr-defined]
        return wrapper

    try:
        flask_cli.show_server_banner = _wrap(getattr(flask_cli, "show_server_banner", None))
    except Exception:
        pass
    try:
        click.echo = _wrap(getattr(click, "echo", None))
    except Exception:
        pass

    # Step 2: Patch colorama if it's being used
    try:
        import colorama.ansitowin32
        original_write = colorama.ansitowin32.AnsiToWin32.write
        def safe_write(self, text):
            try:
                return original_write(self, text)
            except (OSError, UnicodeEncodeError):
                # Silently ignore - prevents crash
                pass
        colorama.ansitowin32.AnsiToWin32.write = safe_write
    except Exception:
        pass

    # Step 3: Patch click._winconsole to handle flush() errors
    try:
        import click._winconsole
        if hasattr(click._winconsole, '_WindowsConsoleWriter'):
            original_flush = click._winconsole._WindowsConsoleWriter.flush
            def safe_flush(self):
                try:
                    return original_flush(self)
                except OSError as exc:
                    if _is_winerror_6(exc):
                        return None
                    raise
            click._winconsole._WindowsConsoleWriter.flush = safe_flush
    except Exception:
        pass

    # Step 4: Patch click utils to prevent flush errors
    try:
        import click.utils
        original_echo = click.utils.echo
        def safe_echo_wrapper(message=None, file=None, nl=True, err=False, color=None):
            try:
                return original_echo(message, file, nl, err, color)
            except (OSError, UnicodeEncodeError) as exc:
                if isinstance(exc, OSError) and _is_winerror_6(exc):
                    return None
                if isinstance(exc, UnicodeEncodeError):
                    return None
                raise
            except Exception:
                return None
        click.utils.echo = safe_echo_wrapper
    except Exception:
        pass

    _WINDOWS_STDIO_PATCHED = True

_install_windows_stdio_guard()

# Who: Tim Buglaev
# When: 2026-03-25
# What: Removed cloud SDK bootstrap from module initialization to enforce local-only runtime behavior.
#       _get_genai now intentionally returns None so downstream code cannot initialize remote providers.
genai = None

def _get_genai():
    return None



def _parse_int_env(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


def _parse_float_env(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _parse_bool_env(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in ("1", "true", "yes", "y", "on"):
        return True
    if normalized in ("0", "false", "no", "n", "off"):
        return False
    return default


def _is_test_env():
    try:
        return "PYTEST_CURRENT_TEST" in os.environ or any("pytest" in str(arg).lower() for arg in sys.argv)
    except Exception:
        return False


IS_TEST_ENV = _is_test_env()


def _model_downloads_allowed():
    """Returns True when downloading/initializing transformer weights is permitted."""
    return _parse_bool_env("ALLOW_MODEL_DOWNLOADS", default=not IS_TEST_ENV)


def _bitsandbytes_status():
    """Returns (available, error_text) for bitsandbytes package discovery."""
    if _check_bnb:
        try:
            info = _check_bnb()
            return info.get("available", False), info.get("error", "")
        except Exception as exc:
            return False, str(exc)
    try:
        import importlib.util
        import importlib.metadata

        spec = importlib.util.find_spec("bitsandbytes")
        if spec is None:
            return False, "module_not_found"
        try:
            importlib.metadata.version("bitsandbytes")
        except importlib.metadata.PackageNotFoundError:
            return False, "metadata_not_found"
        return True, ""
    except Exception as exc:
        return False, str(exc)


def _is_bitsandbytes_available():
    """Returns True when bitsandbytes package is installed and discoverable."""
    available, _ = _bitsandbytes_status()
    return available


def _gptq_status():
    """Returns (available, error_text) for auto-gptq discovery."""
    try:
        import importlib.util

        spec = importlib.util.find_spec("auto_gptq")
        if spec is None:
            return False, "module_not_found"
        return True, ""
    except Exception as exc:
        return False, str(exc)


qdrant_process = None
qdrant_service = None
use_qdrant = False
_qdrant_health_cache = {"status": None, "ts": 0.0, "error": None, "service_id": None}
_QDRANT_HEALTH_TTL = 8.0
_QDRANT_MAX_HTTP_TIMEOUT = 60.0
_QDRANT_MIN_HTTP_TIMEOUT = 1.0
_embedding_model = None
_embedding_dim = None
_embedding_lock = threading.Lock()
# Who: Tim Buglaev
# When: 2026-06-22
# What: Track committed chunk digests and active point IDs separately so repeated indexing
#       is idempotent and shortened/removed notes cannot leave stale fragments searchable.
_qdrant_index_state = {}
_qdrant_note_chunk_ids = {}


def _safe_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            # Support float-like strings such as "180.0"
            return int(float(value))
        except (TypeError, ValueError):
            return default


def _safe_float(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _sanitize_http_timeout(raw_value):
    base_default = _safe_float(getattr(backend_config, "QDRANT_HTTP_TIMEOUT", 15.0), 15.0)
    timeout_value = _safe_float(raw_value, base_default)
    if timeout_value is None:
        timeout_value = base_default
    return max(_QDRANT_MIN_HTTP_TIMEOUT, min(timeout_value, _QDRANT_MAX_HTTP_TIMEOUT))


def _clear_qdrant_health_cache():
    _qdrant_health_cache.update({"status": None, "ts": 0.0, "error": None, "service_id": None})


def _update_qdrant_health_cache(status, error=None, service=None):
    _qdrant_health_cache.update({
        "status": bool(status),
        "ts": time.monotonic(),
        "error": error,
        "service_id": id(service) if service is not None else id(qdrant_service) if qdrant_service else None,
    })


def _parse_limit_value(raw_limit, default, min_value=1, max_value=TOP_K_SEARCH, label="limit"):
    """
    Safely parses limit values that may be provided as strings/floats, clamps them,
    and falls back to a default without raising exceptions.
    """
    safe_default = default if isinstance(default, int) and default > 0 else min_value
    try:
        if isinstance(raw_limit, str):
            raw_limit = raw_limit.strip()
        parsed = int(float(raw_limit))
    except (TypeError, ValueError):
        logger.warning("%s value %r is invalid, using default %s", label, raw_limit, safe_default)
        parsed = safe_default
    else:
        if parsed <= 0:
            logger.warning("%s value %r is not positive, using default %s", label, raw_limit, safe_default)
            parsed = safe_default
    return max(min_value, min(parsed, max_value))


def _embedding_model_id():
    return (
        os.environ.get("RAG_EMBEDDING_MODEL")
        or getattr(backend_config, "EMBEDDING_MODEL", None)
        or "sentence-transformers/all-mpnet-base-v2"
    )


def _record_embedding_dim(dims):
    global _embedding_dim
    try:
        dim_value = int(dims)
    except Exception:
        dim_value = None
    if dim_value and dim_value > 0:
        _embedding_dim = dim_value
        try:
            backend_config.VECTOR_SIZE = dim_value
        except Exception:
            pass
    return _embedding_dim


def _get_vector_size():
    env_dim = _safe_int(os.environ.get("QDRANT_VECTOR_SIZE"), None)
    if env_dim:
        return env_dim
    cfg_dim = _safe_int(getattr(backend_config, "VECTOR_SIZE", None), None)
    if cfg_dim:
        return cfg_dim
    if _embedding_dim:
        return _embedding_dim
    return _safe_int(os.environ.get("QDRANT_VECTOR_SIZE"), getattr(backend_config, "VECTOR_SIZE", 768)) or 768


def _qdrant_settings():
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Prefer explicit IPv4 loopback for Qdrant to avoid localhost resolving to
    #       a different Docker/IPv6 listener than the managed local service.
    url = os.environ.get("QDRANT_URL") or (getattr(backend_config, "QDRANT_URL", None) or "http://127.0.0.1:6333")
    collection = os.environ.get("QDRANT_COLLECTION_NAME") or getattr(backend_config, "COLLECTION_NAME", "notes")
    vector_size = _get_vector_size()
    autostart_env = os.environ.get("QDRANT_AUTOSTART")
    autostart_default = getattr(backend_config, "QDRANT_AUTOSTART", "1") if backend_config else "1"
    autostart = autostart_env if autostart_env is not None else autostart_default
    autostart_normalized = str(autostart).strip().lower()
    autostart_enabled = autostart_normalized not in ("0", "false", "no", "off")
    http_timeout = _sanitize_http_timeout(os.environ.get("QDRANT_HTTP_TIMEOUT"))
    ready_retries = _safe_int(os.environ.get("QDRANT_READY_RETRIES"), getattr(backend_config, "QDRANT_READY_RETRIES", 5))
    ready_delay = _safe_float(os.environ.get("QDRANT_READY_DELAY"), getattr(backend_config, "QDRANT_READY_DELAY", 1.0))
    return {
        "url": url,
        "collection": collection,
        "vector_size": vector_size,
        "autostart": autostart_enabled,
        "http_timeout": http_timeout,
        "ready_retries": ready_retries,
        "ready_delay": ready_delay,
    }


# Who: Tim Buglaev
# When: 2026-06-30
# What: Launch managed Qdrant without unread output pipes or a Windows console;
#       CREATE_NO_WINDOW is reinforced with STARTUPINFO/SW_HIDE for launcher variants.
def _start_qdrant_process():
    from backend.managed_qdrant import executable

    global qdrant_process
    if qdrant_process is not None:
        return True
    process_options = {}
    if sys.platform == "win32":
        process_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        startupinfo_factory = getattr(subprocess, "STARTUPINFO", None)
        if startupinfo_factory is not None:
            startupinfo = startupinfo_factory()
            startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
            startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
            process_options["startupinfo"] = startupinfo
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Keep startup logs ASCII-only so Windows terminals and redirected Electron logs
    #       remain readable even when console code pages are not UTF-8.
    try:
        qdrant_process = subprocess.Popen(
            [executable() or "qdrant"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **process_options,
        )
        logger.info("Qdrant process started")
        return True
    except Exception as exc:
        logger.warning("Failed to start Qdrant: %s", exc)
        qdrant_process = None
        return False


def _wait_for_qdrant_ready(url, attempts=10, delay=1.0, timeout=5.0):
    health_url = f"{url.rstrip('/')}/healthz"
    for attempt in range(1, attempts + 1):
        try:
            resp = requests.get(health_url, timeout=timeout)
            if resp.ok:
                logger.info("Qdrant is ready")
                return True
        except Exception:
            pass
        if attempt < attempts:
            time.sleep(delay)
    logger.warning("Qdrant healthz did not respond after %d attempts (timeout %ss). "
                   "Switching to fallback search. Tune QDRANT_HTTP_TIMEOUT/QDRANT_READY_RETRIES/QDRANT_READY_DELAY.",
                   attempts, timeout)
    return False


# Who: Tim Buglaev
# When: 2026-06-22
# What: Stop the owned Qdrant process with a bounded terminate-then-kill sequence and
#       report success to Electron; unread child pipes can no longer block the service.
def _cleanup_qdrant_process():
    global qdrant_process
    process = qdrant_process
    if not process:
        return True
    stopped = False
    try:
        process.terminate()
        process.wait(timeout=5)
        stopped = process.poll() is not None
    except Exception as terminate_exc:
        try:
            process.kill()
            process.wait(timeout=5)
            stopped = process.poll() is not None
        except Exception as kill_exc:
            logger.warning(
                "Failed to stop managed Qdrant terminate=%s kill=%s",
                type(terminate_exc).__name__,
                type(kill_exc).__name__,
            )
    qdrant_process = None
    return stopped


# Who: Tim Buglaev
# When: 2026-06-22
# What: Schedule backend self-termination after the authenticated HTTP response is flushed;
#       this avoids Windows launcher/child PID races during Electron shutdown.
def _schedule_backend_exit(delay_seconds=0.35):
    delay = max(0.1, min(float(delay_seconds), 2.0))
    timer = threading.Timer(delay, lambda: os._exit(0))
    timer.daemon = True
    timer.start()
    return True


