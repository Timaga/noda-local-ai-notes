import json
import ipaddress
from pathlib import Path
from urllib.parse import urlparse

from flask import jsonify, request

# Who: Tim Buglaev
# When: 2026-06-15
# What: Import startup model-catalog helpers through both legacy and package paths
#       so Flask routes work in tests, direct scripts, and python -m launches.
try:
    from model_catalog import build_model_catalog, download_catalog_model, find_catalog_model, primary_cache_dir
except ImportError:  # pragma: no cover - package import fallback
    from backend.model_catalog import build_model_catalog, download_catalog_model, find_catalog_model, primary_cache_dir


# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted model, training, and model-management endpoints into a dedicated module to separate HTTP
#       orchestration from core application bootstrapping while preserving endpoint contracts and status codes.
def register_model_routes(app, deps):
    module = deps.module
    # Who: Tim Buglaev
    # When: 2026-04-06
    # What: Reworked runtime helpers for strict local-only operation by exposing only local/vllm_local
    #       providers, loopback endpoint validation, and bounded TurboQuant bit settings.
    def _normalize_runtime_provider(value):
        normalized = str(value or "local").strip().lower()
        if normalized in ("vllm", "vllm_local", "vllm_openai", "openai_compatible"):
            return "vllm_local"
        if normalized in ("", "local"):
            return "local"
        raise ValueError(f"Unsupported provider: {value}")

    def _validate_vllm_base_url(raw_url):
        normalized = str(raw_url or "").strip()
        if not normalized:
            raise ValueError("vllm_base_url is required for vllm_local provider")
        parsed = urlparse(normalized)
        if parsed.scheme not in ("http", "https"):
            raise ValueError("vllm_base_url must use http or https scheme")
        hostname = (parsed.hostname or "").strip()
        if not hostname:
            raise ValueError("vllm_base_url must include hostname")
        if hostname in ("localhost", "127.0.0.1", "::1"):
            return normalized
        try:
            if ipaddress.ip_address(hostname).is_loopback:
                return normalized
        except ValueError:
            pass
        raise ValueError("vllm_base_url must point to localhost or loopback address")

    def _parse_bool(value, default):
        if value is None:
            return bool(default)
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in ("1", "true", "yes", "y", "on"):
            return True
        if normalized in ("0", "false", "no", "n", "off"):
            return False
        raise ValueError(f"Invalid boolean value: {value}")

    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Added bounded vLLM resource parsers so model-selection profiles can tune
    #       context size and GPU memory without persisting malformed startup settings.
    def _parse_int_range(value, default, min_value, max_value, name):
        try:
            parsed = int(value if value is not None else default)
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be an integer")
        if parsed < min_value or parsed > max_value:
            raise ValueError(f"{name} must be between {min_value} and {max_value}")
        return parsed

    def _parse_float_range(value, default, min_value, max_value, name):
        try:
            parsed = float(value if value is not None else default)
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be a number")
        if parsed < min_value or parsed > max_value:
            raise ValueError(f"{name} must be between {min_value} and {max_value}")
        return parsed

    def _clamp_bits(value, default):
        try:
            if value is None:
                parsed = int(default)
            else:
                parsed = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid TurboQuant bit value: {value}")
        return max(1, min(8, parsed))

    # Who: Tim Buglaev
    # When: 2026-05-28
    # What: Added strict TurboQuant request parsing around vLLM KV-cache dtype presets,
    #       preserving old k/v inputs while rejecting unsupported combinations before
    #       persisting runtime configuration.
    def _resolve_turboquant_config(payload):
        turboquant_enabled = _parse_bool(
            payload.get("turboquant_enabled"), getattr(module, "TURBOQUANT_ENABLED", False)
        )
        turboquant_k_bits = _clamp_bits(payload.get("turboquant_k_bits"), getattr(module, "TURBOQUANT_K_BITS", 4))
        turboquant_v_bits = _clamp_bits(payload.get("turboquant_v_bits"), getattr(module, "TURBOQUANT_V_BITS", 4))
        bit_keys_present = "turboquant_k_bits" in payload or "turboquant_v_bits" in payload
        if "turboquant_kv_cache_dtype" in payload:
            raw_dtype = payload.get("turboquant_kv_cache_dtype")
        elif bit_keys_present:
            raw_dtype = "auto"
        else:
            raw_dtype = getattr(module, "TURBOQUANT_KV_CACHE_DTYPE", None)
        normalizer = getattr(module, "_normalize_turboquant_kv_cache_dtype", None)
        if callable(normalizer):
            turboquant_kv_cache_dtype = normalizer(
                raw_dtype,
                enabled=turboquant_enabled,
                k_bits=turboquant_k_bits,
                v_bits=turboquant_v_bits,
                strict=True,
            )
        else:
            turboquant_kv_cache_dtype = raw_dtype if turboquant_enabled else None
        bits_resolver = getattr(module, "_turboquant_bits_for_dtype", None)
        if turboquant_kv_cache_dtype and callable(bits_resolver):
            turboquant_k_bits, turboquant_v_bits = bits_resolver(
                turboquant_kv_cache_dtype,
                turboquant_k_bits,
                turboquant_v_bits,
            )
        return turboquant_enabled, turboquant_k_bits, turboquant_v_bits, turboquant_kv_cache_dtype

    def _resolve_local_model_format(provider):
        if provider == "vllm_local":
            return "vllm_local"
        return "llama_cpp" if bool(getattr(module, "USE_GGUF", False)) else "transformers"

    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Resolve the preferred Hugging Face cache path for catalog status/downloads
    #       while falling back safely when model_manager is unavailable in tests.
    def _model_cache_dir():
        manager = getattr(module, "model_manager", None)
        cache_dir = getattr(manager, "model_cache_dir", None) if manager is not None else None
        if cache_dir:
            return str(cache_dir)
        return primary_cache_dir(getattr(module, "RAG_LOCAL_MODEL_CACHE", None))

    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Centralized active catalog id resolution so GGUF local paths and vLLM
    #       source ids are reported consistently across catalog and download endpoints.
    def _active_catalog_model_id():
        runtime_provider = getattr(module, "RAG_RUNTIME_PROVIDER", "local")
        local_format = getattr(module, "RAG_LOCAL_MODEL_FORMAT", "transformers")
        if runtime_provider == "local" and local_format == "llama_cpp":
            return (
                getattr(module, "RAG_LOCAL_MODEL_GGUF_PATH", None)
                or getattr(module, "GGUF_MODEL_PATH", None)
                or getattr(module, "RAG_LOCAL_MODEL_ID", None)
                or ""
            )
        return (
            getattr(module, "RAG_VLLM_SOURCE_MODEL_ID", None)
            or getattr(module, "RAG_LOCAL_MODEL_ID", None)
            or ""
        )

    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Build vLLM startup with a real source model plus --served-model-name so the
    #       app can keep using local-model while vLLM loads a valid Hugging Face model id.
    def _build_vllm_serve_command(provider):
        if provider != "vllm_local":
            return None
        base_url = getattr(module, "RAG_VLLM_BASE_URL", "http://127.0.0.1:8000/v1")
        parsed = urlparse(base_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "https" else 8000)
        served_model_id = getattr(module, "RAG_VLLM_MODEL_ID", None) or getattr(module, "RAG_LOCAL_MODEL_ID", "")
        source_model_id = (
            getattr(module, "RAG_VLLM_SOURCE_MODEL_ID", None)
            or getattr(module, "RAG_LOCAL_MODEL_ID", "")
            or served_model_id
        )
        command = [
            "vllm",
            "serve",
            str(source_model_id),
            "--served-model-name",
            str(served_model_id),
            "--host",
            host,
            "--port",
            str(port),
        ]
        max_model_len = int(getattr(module, "RAG_VLLM_MAX_MODEL_LEN", 2048) or 2048)
        gpu_memory_utilization = float(getattr(module, "RAG_VLLM_GPU_MEMORY_UTILIZATION", 0.75) or 0.75)
        if max_model_len > 0:
            command.extend(["--max-model-len", str(max_model_len)])
        if 0 < gpu_memory_utilization <= 1:
            command.extend(["--gpu-memory-utilization", str(gpu_memory_utilization)])
        if bool(getattr(module, "RAG_VLLM_ENFORCE_EAGER", True)):
            command.append("--enforce-eager")
        kv_dtype = getattr(module, "TURBOQUANT_KV_CACHE_DTYPE", None)
        if bool(getattr(module, "TURBOQUANT_ENABLED", False)) and kv_dtype:
            command.extend(["--kv-cache-dtype", str(kv_dtype)])
        return command

    def _runtime_payload():
        configured_provider = getattr(module, "RAG_RUNTIME_PROVIDER", "local")
        if configured_provider == "llama_cpp_server":
            provider = configured_provider
        else:
            try:
                provider = _normalize_runtime_provider(configured_provider)
            except ValueError:
                provider = "local"
        turboquant_dtype = getattr(module, "TURBOQUANT_KV_CACHE_DTYPE", None)
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Recompute the runtime id for status responses so local llama.cpp
        #       reports the active GGUF path even if older env values are stale.
        runtime_id_resolver = getattr(module, "_current_runtime_model_id", None)
        runtime_model_id = (
            runtime_id_resolver()
            if callable(runtime_id_resolver)
            else getattr(module, "RAG_RUNTIME_MODEL_ID", getattr(module, "RAG_LOCAL_MODEL_ID", None))
        )
        try:
            module.RAG_RUNTIME_MODEL_ID = runtime_model_id
        except Exception:
            pass
        payload = {
            "provider": provider,
            "model_format": getattr(module, "RAG_LOCAL_MODEL_FORMAT", "transformers"),
            "runtime_model_id": runtime_model_id,
            # Who: Tim Buglaev
            # When: 2026-06-22
            # What: Expose only the PID of a Qdrant process owned by this backend so the
            #       desktop launcher can remove an orphan after an abnormal backend exit.
            "managed_processes": {
                "qdrant_pid": int(getattr(getattr(module, "qdrant_process", None), "pid", 0) or 0),
            },
            "turboquant": {
                "enabled": bool(getattr(module, "TURBOQUANT_ENABLED", False)),
                "k_bits": int(getattr(module, "TURBOQUANT_K_BITS", 4)),
                "v_bits": int(getattr(module, "TURBOQUANT_V_BITS", 4)),
                "kv_cache_dtype": turboquant_dtype,
                "supported_kv_cache_dtypes": list(getattr(module, "TURBOQUANT_SUPPORTED_KV_CACHE_DTYPES", ())),
            },
        }
        if provider == "vllm_local":
            payload["vllm"] = {
                "base_url": getattr(module, "RAG_VLLM_BASE_URL", "http://127.0.0.1:8000/v1"),
                "model_id": getattr(module, "RAG_VLLM_MODEL_ID", None),
                "source_model_id": getattr(module, "RAG_VLLM_SOURCE_MODEL_ID", None),
                "timeout_seconds": float(getattr(module, "RAG_VLLM_TIMEOUT_SECONDS", 45.0)),
                "verify_tls": bool(getattr(module, "RAG_VLLM_VERIFY_TLS", True)),
                "max_model_len": int(getattr(module, "RAG_VLLM_MAX_MODEL_LEN", 2048)),
                "gpu_memory_utilization": float(getattr(module, "RAG_VLLM_GPU_MEMORY_UTILIZATION", 0.75)),
                "enforce_eager": bool(getattr(module, "RAG_VLLM_ENFORCE_EAGER", True)),
                "host_policy": "loopback_only",
                "kv_cache_dtype": turboquant_dtype,
                "serve_command": _build_vllm_serve_command(provider),
            }
        from backend.note_runtime_status import note_runtime_status

        payload.update(note_runtime_status(module, provider))
        return payload

    def _runtime_json():
        payload = _runtime_payload()
        note_pipeline = payload.pop("note_pipeline", None)
        result = module._make_json_safe(payload)
        if note_pipeline is not None:
            result["note_pipeline"] = note_pipeline
        return result

    def _with_runtime(payload):
        result = module._make_json_safe(payload)
        result["runtime"] = _runtime_json()
        return result

    @app.route("/model-status", methods=["GET"])
    def model_status():
        try:
            from model_init import get_model_status

            status = get_model_status()
            try:
                module._validate_notes_cache(reason="model-status")
                status["notes_cache"] = module._get_notes_cache_state()
            except Exception as cache_err:
                status["notes_cache_error"] = str(cache_err)
            status["bitsandbytes_runtime"] = {
                "available": module.BITSANDBYTES_AVAILABLE,
                "error": module.BITSANDBYTES_ERROR,
            }
            status["gptq_runtime"] = {
                "available": module.GPTQ_AVAILABLE,
                "error": module.GPTQ_ERROR,
            }
            return jsonify(module._make_json_safe(status))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/model/status", methods=["GET"])
    def model_status_v2():
        try:
            module._validate_notes_cache(reason="model status")
        except Exception as cache_err:
            print(f"[WARNING] Не удалось проверить кэш заметок в /model/status: {cache_err}")
        init_info = module._get_model_init_result() or {}
        loaded = bool(getattr(module.local_rag_model, "is_fully_loaded", False))
        downloaded = bool(getattr(module.local_rag_model, "downloaded", False))
        loading = bool(getattr(module.local_rag_model, "_loading", False))
        runner_ready = bool(getattr(module.local_rag_model, "_llama_runner", None))
        init_status = str(init_info.get("status", "")) if isinstance(init_info, dict) else ""
        init_ready = False
        if isinstance(init_info, dict):
            init_ready = init_status.lower() == "ready" or bool((init_info.get("model_load", {}) or {}).get("ready"))
        init_downloaded = False
        if isinstance(init_info, dict):
            init_downloaded = bool(
                init_info.get("downloaded")
                or init_ready
                or init_info.get("info")
                or (init_info.get("model_load", {}) or {}).get("ready")
            )
        downloaded = bool(downloaded or runner_ready or init_downloaded)
        error = getattr(module.local_rag_model, "last_load_error", None)
        if not error and isinstance(init_info, dict) and init_info.get("status") == "error":
            error = init_info.get("reason") or init_info.get("error")
        ready = loaded or (runner_ready and downloaded and not loading and not error) or (init_ready and downloaded)
        if ready and not loaded:
            module.local_rag_model.is_fully_loaded = True
            loaded = True
        status = "ready" if ready else ("error" if error else ("loading" if loading else "not-ready"))
        model_id_value = getattr(module.local_rag_model, "model_id", "")
        try:
            from unittest.mock import Mock

            if isinstance(model_id_value, Mock):
                model_id_value = str(model_id_value)
                try:
                    module.local_rag_model.model_id = model_id_value
                except Exception:
                    pass
        except Exception:
            model_id_value = str(model_id_value)
        response = {
            "loaded": loaded,
            "downloaded": downloaded,
            "loading": loading,
            "model_id": model_id_value,
            "status": status,
        }
        response["ready_timeout_seconds"] = module.MODEL_READY_TIMEOUT
        response["notes_cache"] = module._get_notes_cache_state()
        response["bitsandbytes"] = {
            "available": module.BITSANDBYTES_AVAILABLE,
            "error": module.BITSANDBYTES_ERROR,
        }
        response["gptq"] = {
            "available": module.GPTQ_AVAILABLE,
            "error": module.GPTQ_ERROR,
        }
        if module._get_model_init_result() is not None:
            response["init"] = module._get_model_init_result()
        if error:
            response["error"] = str(error)
        return jsonify(_with_runtime(response))

    # Who: Tim Buglaev
    # When: 2026-04-06
    # What: Added runtime config endpoints for switching between local and vLLM execution modes with
    #       env persistence, validated parameters, and safe in-process model reload behavior.
    @app.route("/runtime/config", methods=["GET"])
    def runtime_config_get():
        return jsonify(_runtime_json())

    from .note_pipeline_routes import register_note_pipeline_route
    from .chat_model_import_routes import chat_models, register_chat_model_import

    register_note_pipeline_route(app, module, _runtime_json)
    register_chat_model_import(app, module)

    @app.route("/runtime/config", methods=["POST"])
    def runtime_config_update():
        payload = request.get_json(silent=True) or {}
        try:
            provider = _normalize_runtime_provider(payload.get("provider", module.RAG_RUNTIME_PROVIDER))
            current_base_url = getattr(module, "RAG_VLLM_BASE_URL", "http://127.0.0.1:8000/v1")
            requested_base_url = payload.get("vllm_base_url", current_base_url)
            if provider == "vllm_local":
                vllm_base_url = _validate_vllm_base_url(requested_base_url)
            else:
                vllm_base_url = str(current_base_url or "http://127.0.0.1:8000/v1").strip()
            vllm_model_id = str(
                payload.get(
                    "vllm_model_id",
                    getattr(module, "RAG_VLLM_MODEL_ID", None) or getattr(module, "RAG_LOCAL_MODEL_ID", None) or "",
                )
            ).strip()
            if provider == "vllm_local" and not vllm_model_id:
                raise ValueError("vllm_model_id is required for vllm_local provider")
            # Who: Tim Buglaev
            # When: 2026-06-14
            # What: Validate the vLLM source model separately from the served model alias so
            #       runtime updates cannot persist a startup command that serves local-model as HF id.
            vllm_source_model_id = str(
                payload.get(
                    "vllm_source_model_id",
                    getattr(module, "RAG_VLLM_SOURCE_MODEL_ID", None)
                    or getattr(module, "RAG_LOCAL_MODEL_ID", None)
                    or vllm_model_id,
                )
            ).strip()
            if provider == "vllm_local" and not vllm_source_model_id:
                raise ValueError("vllm_source_model_id is required for vllm_local provider")
            try:
                timeout_seconds = float(payload.get("vllm_timeout_seconds", getattr(module, "RAG_VLLM_TIMEOUT_SECONDS", 45.0)))
            except (TypeError, ValueError):
                raise ValueError("vllm_timeout_seconds must be a number")
            if timeout_seconds <= 0 or timeout_seconds > 300:
                raise ValueError("vllm_timeout_seconds must be between 0 and 300")
            verify_tls = _parse_bool(payload.get("vllm_verify_tls"), getattr(module, "RAG_VLLM_VERIFY_TLS", True))
            max_model_len = _parse_int_range(
                payload.get("vllm_max_model_len"),
                getattr(module, "RAG_VLLM_MAX_MODEL_LEN", 2048),
                512,
                32768,
                "vllm_max_model_len",
            )
            gpu_memory_utilization = _parse_float_range(
                payload.get("vllm_gpu_memory_utilization"),
                getattr(module, "RAG_VLLM_GPU_MEMORY_UTILIZATION", 0.75),
                0.1,
                0.95,
                "vllm_gpu_memory_utilization",
            )
            enforce_eager = _parse_bool(
                payload.get("vllm_enforce_eager"),
                getattr(module, "RAG_VLLM_ENFORCE_EAGER", True),
            )
            turboquant_enabled, turboquant_k_bits, turboquant_v_bits, turboquant_kv_cache_dtype = _resolve_turboquant_config(payload)
            reload_model = _parse_bool(payload.get("reload_model"), True)
        except (TypeError, ValueError) as exc:
            return jsonify({"success": False, "error": str(exc)}), 400

        # Who: Tim Buglaev
        # When: 2026-05-28
        # What: Persisted the validated TurboQuant KV-cache dtype alongside normalized bits so
        #       runtime state, local_rag_model state, and .env files cannot diverge.
        module.RAG_RUNTIME_PROVIDER = provider
        module.RAG_VLLM_BASE_URL = vllm_base_url or getattr(module, "RAG_VLLM_BASE_URL", "http://127.0.0.1:8000/v1")
        module.RAG_VLLM_MODEL_ID = vllm_model_id or getattr(module, "RAG_LOCAL_MODEL_ID", "")
        module.RAG_VLLM_SOURCE_MODEL_ID = vllm_source_model_id or getattr(module, "RAG_LOCAL_MODEL_ID", module.RAG_VLLM_MODEL_ID)
        module.RAG_VLLM_TIMEOUT_SECONDS = timeout_seconds
        module.RAG_VLLM_VERIFY_TLS = verify_tls
        module.RAG_VLLM_MAX_MODEL_LEN = max_model_len
        module.RAG_VLLM_GPU_MEMORY_UTILIZATION = gpu_memory_utilization
        module.RAG_VLLM_ENFORCE_EAGER = enforce_eager
        module.TURBOQUANT_ENABLED = turboquant_enabled
        module.TURBOQUANT_K_BITS = turboquant_k_bits
        module.TURBOQUANT_V_BITS = turboquant_v_bits
        module.TURBOQUANT_KV_CACHE_DTYPE = turboquant_kv_cache_dtype
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Resolve local runtime ids after provider/model-format updates so
        #       local GGUF mode persists the active file path instead of falling
        #       back to the transformers base model id.
        module.RAG_LOCAL_MODEL_FORMAT = _resolve_local_model_format(provider)
        runtime_id_resolver = getattr(module, "_current_runtime_model_id", None)
        module.RAG_RUNTIME_MODEL_ID = (
            runtime_id_resolver()
            if callable(runtime_id_resolver)
            else (module.RAG_VLLM_MODEL_ID if provider == "vllm_local" else getattr(module, "RAG_LOCAL_MODEL_ID", module.RAG_VLLM_MODEL_ID))
        )
        if provider == "vllm_local":
            module.RAG_LOCAL_MODEL_QUANTIZATION = None

        env_updates = {
            "RAG_RUNTIME_PROVIDER": module.RAG_RUNTIME_PROVIDER,
            "RAG_LOCAL_MODEL_FORMAT": module.RAG_LOCAL_MODEL_FORMAT,
            "RAG_VLLM_BASE_URL": module.RAG_VLLM_BASE_URL,
            "RAG_VLLM_MODEL_ID": module.RAG_VLLM_MODEL_ID,
            "RAG_VLLM_SOURCE_MODEL_ID": module.RAG_VLLM_SOURCE_MODEL_ID,
            "RAG_VLLM_TIMEOUT_SECONDS": module.RAG_VLLM_TIMEOUT_SECONDS,
            "RAG_VLLM_VERIFY_TLS": str(module.RAG_VLLM_VERIFY_TLS).lower(),
            "RAG_VLLM_MAX_MODEL_LEN": module.RAG_VLLM_MAX_MODEL_LEN,
            "RAG_VLLM_GPU_MEMORY_UTILIZATION": module.RAG_VLLM_GPU_MEMORY_UTILIZATION,
            "RAG_VLLM_ENFORCE_EAGER": str(module.RAG_VLLM_ENFORCE_EAGER).lower(),
            "RAG_VLLM_API_KEY": "",
            "RAG_VLLM_ALLOW_REMOTE_HOST": "false",
            "TURBOQUANT_ENABLED": str(module.TURBOQUANT_ENABLED).lower(),
            "TURBOQUANT_K_BITS": module.TURBOQUANT_K_BITS,
            "TURBOQUANT_V_BITS": module.TURBOQUANT_V_BITS,
            "TURBOQUANT_KV_CACHE_DTYPE": module.TURBOQUANT_KV_CACHE_DTYPE or "",
            "RAG_RUNTIME_MODEL_ID": module.RAG_RUNTIME_MODEL_ID or "",
        }
        module._update_env_files(env_updates)

        module.local_rag_model.runtime_provider = module.RAG_RUNTIME_PROVIDER
        module.local_rag_model.model_format = module.RAG_LOCAL_MODEL_FORMAT
        module.local_rag_model.model_id = module.RAG_RUNTIME_MODEL_ID
        module.local_rag_model.vllm_base_url = module.RAG_VLLM_BASE_URL
        module.local_rag_model.vllm_model_id = module.RAG_VLLM_MODEL_ID
        module.local_rag_model.vllm_timeout_seconds = module.RAG_VLLM_TIMEOUT_SECONDS
        module.local_rag_model.vllm_verify_tls = module.RAG_VLLM_VERIFY_TLS
        module.local_rag_model.turboquant_enabled = module.TURBOQUANT_ENABLED
        module.local_rag_model.turboquant_k_bits = module.TURBOQUANT_K_BITS
        module.local_rag_model.turboquant_v_bits = module.TURBOQUANT_V_BITS
        module.local_rag_model.turboquant_kv_cache_dtype = module.TURBOQUANT_KV_CACHE_DTYPE
        module.local_rag_model._pipeline = None
        module.local_rag_model._pipeline_initialized = False
        module.local_rag_model._llama_runner = None
        module.local_rag_model.is_fully_loaded = False
        module.local_rag_model.downloaded = False
        module.local_rag_model.last_load_error = None

        load_state = {"requested": reload_model, "ready": None, "error": None}
        if reload_model:
            try:
                ready = module.local_rag_model.load_model(
                    block=True,
                    wait_timeout=module.MODEL_READY_TIMEOUT,
                    force_rebuild=True,
                )
                load_state["ready"] = bool(ready and module.local_rag_model.is_fully_loaded)
                load_state["error"] = None if load_state["ready"] else getattr(module.local_rag_model, "last_load_error", None)
            except Exception as load_exc:
                load_state["ready"] = False
                load_state["error"] = str(load_exc)

        response_payload = {
            "success": True,
            "model_load": load_state,
        }
        status_code = 200
        if load_state.get("requested") and load_state.get("ready") is False:
            status_code = 400
            response_payload["success"] = False
        return jsonify(_with_runtime(response_payload)), status_code

    @app.route("/model-initialize", methods=["POST"])
    def model_initialize():
        try:
            data = request.get_json(force=True) or {}
            load_context = data.get("load_context", True)

            module.logger.info(
                "POST /model-initialize load_context=%s (gguf_path=%s, n_ctx=%s, n_threads=%s, n_gpu_layers=%s, backend=%s)",
                load_context,
                module.RAG_LOCAL_MODEL_GGUF_PATH or getattr(module.local_rag_model, "gguf_path", None),
                module.GGUF_N_CTX or module.RAG_LOCAL_MODEL_CONTEXT_SIZE,
                module.RAG_LOCAL_MODEL_THREADS,
                module.GGUF_N_GPU_LAYERS,
                module.SELECTED_QUANTIZATION_BACKEND,
            )

            from model_init import initialize_local_model

            init_result = initialize_local_model()
            module._set_model_init_result(init_result)

            if init_result.get("status") not in ["ready", "fallback"]:
                return (
                    jsonify(
                        {
                            "success": False,
                            "error": "Model initialization failed",
                            "details": module._make_json_safe(init_result),
                        }
                    ),
                    500,
                )

            warmup_error = None
            warmup_ready = False
            try:
                warmup_ready = module.local_rag_model.load_model(
                    block=True,
                    wait_timeout=module.MODEL_READY_TIMEOUT,
                    force_rebuild=True,
                )
            except Exception as warmup_exc:
                warmup_error = str(warmup_exc)
                warmup_ready = False

            load_ready, load_status, load_error = module._wait_for_local_model_ready(force_rebuild=True)
            if warmup_error and not load_error and not load_ready:
                load_error = warmup_error
                load_status = "error"
            model_load_info = {
                "ready": load_ready,
                "status": load_status,
                "error": load_error,
                "model_id": module.local_rag_model.model_id,
                "warmup_ready": warmup_ready,
                "ready_timeout_seconds": module.MODEL_READY_TIMEOUT,
            }
            if warmup_error:
                model_load_info["warmup_error"] = warmup_error

            context_loaded = False
            notes_count = 0
            context_entries = []
            warmup_context_state = {}
            if load_context and load_ready:
                context_entries, notes_count = module._build_warmup_context(search_state=warmup_context_state)
                if context_entries:
                    try:
                        query = f"Инициализация контекста: {len(context_entries)} из {notes_count} заметок"
                        module._generate_local_rag_response(query, context_entries)
                        context_loaded = True
                    except Exception as ctx_err:
                        print(f"Предупреждение: не удалось загрузить контекст: {ctx_err}")
                if warmup_context_state.get("qdrant_failed"):
                    module.logger.info(
                        "Warmup context fallback to cache because Qdrant is unavailable (%s)",
                        warmup_context_state.get("qdrant_reason"),
                    )

            context_source = warmup_context_state.get("context_source") or (
                "qdrant" if warmup_context_state.get("qdrant_used") else "cache"
            )
            response_payload = {
                "success": True,
                "model_status": init_result,
                "model_load": model_load_info,
                "context_loaded": context_loaded,
                "notes_count": notes_count,
                "notes_cache": module._get_notes_cache_state(),
                "ready_timeout_seconds": module.MODEL_READY_TIMEOUT,
                "context_source": context_source,
            }
            response_payload["qdrant"] = {
                "enabled": bool(module.use_qdrant and module.qdrant_service),
                "fallback": bool(warmup_context_state.get("qdrant_failed")),
                "reason": warmup_context_state.get("qdrant_reason"),
            }

            status_code = 200
            if load_status == "error":
                response_payload["success"] = False
                response_payload["error"] = load_error or "Model failed to load"
                status_code = 400
            elif not load_ready:
                status_code = 202
                response_payload["message"] = load_error or "Model is still loading"
            return jsonify(module._make_json_safe(response_payload)), status_code

        except Exception as e:
            import traceback

            traceback.print_exc()
            module.logger.exception("Unhandled error during /model-initialize")
            status_code = 400 if isinstance(e, (ValueError, FileNotFoundError, OSError)) else 500
            return (
                jsonify(
                    {
                        "success": False,
                        "error": str(e),
                        "error_type": e.__class__.__name__,
                    }
                ),
                status_code,
            )

    @app.route("/training/run", methods=["POST"])
    def training_run():
        payload = request.get_json(silent=True) or {}
        blocking = bool(payload.get("blocking"))
        dry_run = bool(payload.get("dry_run"))
        reason = payload.get("reason") or "manual"
        runner = module._get_training_runner()
        status = runner.start_run(blocking=blocking, reason=reason, dry_run=dry_run)
        http_code = 200
        if status.get("status") == "busy":
            http_code = 409
        elif status.get("status") == "failed":
            http_code = 500
        return jsonify(status), http_code

    @app.route("/training/status", methods=["GET"])
    def training_status():
        runner = module._get_training_runner()
        runtime_status = runner.current_status()
        file_status = {}
        try:
            status_path = Path(module.TRAINING_STATUS_PATH)
            if status_path.exists():
                file_status = json.loads(status_path.read_text(encoding="utf-8"))
        except Exception as exc:
            file_status = {"error": str(exc)}
        return jsonify({"runtime": runtime_status, "file": file_status})

    @app.route("/model/swap", methods=["POST"])
    def model_swap():
        data = request.get_json(force=True) or {}
        gguf_path = data.get("gguf_path") or data.get("path")
        if not gguf_path:
            return jsonify({"success": False, "error": "gguf_path is required"}), 400
        swap_result = module._apply_new_model_path(gguf_path, run_id=data.get("run_id"), metrics=data.get("metrics"))
        status_code = 200 if swap_result.get("success") else 500
        return jsonify(swap_result), status_code

    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Exposed a bounded startup model catalog so the GUI can show available
    #       Hugging Face choices and downloaded state before vLLM warmup begins.
    @app.route("/models/catalog", methods=["GET"])
    def models_catalog():
        active_source_model = _active_catalog_model_id()
        cache_dir = _model_cache_dir()
        models = build_model_catalog(active_model_id=active_source_model, cache_dir=cache_dir)
        models.extend(chat_models(module, active_source_model))
        if any("configured" in model for model in models):
            loaded = bool(getattr(getattr(module, "local_rag_model", None), "is_fully_loaded", False))
            for model in models:
                model["ready"] = model["active"] and model["downloaded"] and loaded
        return jsonify(
            _with_runtime(
                {
                    "models": models,
                    "active_model_id": active_source_model,
                }
            )
        )

    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Added a guarded Hugging Face snapshot download endpoint for startup selection,
    #       accepting only catalog model ids to avoid arbitrary remote repository fetches.
    @app.route("/models/download", methods=["POST"])
    def models_download():
        data = request.get_json(silent=True) or {}
        requested_model = str(data.get("model_id") or data.get("hf_model_id") or "").strip()
        if not requested_model:
            return jsonify({"success": False, "error": "model_id is required"}), 400
        catalog_model = find_catalog_model(requested_model)
        if catalog_model is None:
            return jsonify({"success": False, "error": "Unknown model id"}), 400

        result = download_catalog_model(catalog_model["id"], cache_dir=_model_cache_dir())
        status_code = 200 if result.get("success") else 502
        refreshed_catalog = build_model_catalog(
            active_model_id=_active_catalog_model_id(),
            cache_dir=_model_cache_dir(),
        )
        result["models"] = refreshed_catalog
        return jsonify(module._make_json_safe(result)), status_code

    @app.route("/models/list", methods=["GET"])
    def list_models():
        models = []
        try:
            transformers_available = module.model_manager.is_transformers_available() if module.model_manager else False
            local_model_available = False
            is_cached = False

            if transformers_available and module.RAG_LOCAL_MODEL_ID:
                try:
                    model_info = module.model_manager.get_model_info(module.RAG_LOCAL_MODEL_ID)
                    local_model_available = model_info.get("available", False)
                    is_cached = local_model_available
                except Exception as me:
                    print(f"Не удалось получить информацию о модели {module.RAG_LOCAL_MODEL_ID}: {me}")
                    local_model_available = False

            models.append(
                {
                    "id": "local",
                    "name": f"Локальная модель ({module.RAG_LOCAL_MODEL_NAME})",
                    "type": "local",
                    "model_id": module.RAG_LOCAL_MODEL_ID or "не указан",
                    "available": local_model_available,
                    "cached": is_cached,
                    "transformers_available": transformers_available,
                    "runtime_provider": getattr(module, "RAG_RUNTIME_PROVIDER", "local"),
                    "runtime_model_id": getattr(module, "RAG_RUNTIME_MODEL_ID", module.RAG_LOCAL_MODEL_ID),
                }
            )
        except Exception as e:
            print(f"Ошибка получения статуса локальной модели: {e}")
            import traceback

            traceback.print_exc()
            models.append(
                {
                    "id": "local",
                    "name": f"Локальная модель ({module.RAG_LOCAL_MODEL_NAME})",
                    "type": "local",
                    "model_id": module.RAG_LOCAL_MODEL_ID or "не указан",
                    "available": False,
                    "cached": False,
                    "transformers_available": False,
                    "runtime_provider": getattr(module, "RAG_RUNTIME_PROVIDER", "local"),
                    "runtime_model_id": getattr(module, "RAG_RUNTIME_MODEL_ID", module.RAG_LOCAL_MODEL_ID),
                    "error": str(e),
                }
            )

        return jsonify(
            {
                "models": models,
                "default_source": module.RAG_MODEL_SOURCE,
            }
        )

