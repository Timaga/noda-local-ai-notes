# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

def initialize_local_model(model_id: Optional[str] = None, force_download: bool = False):
    bnb_reason = None
    gptq_reason = None
    quant_cfg = None
    quant_enabled = False
    cache_dir = None
    cached_snapshot = False
    backend = get_quantization_backend()
    quant_backend = backend if backend != "auto" else "full"
    gguf_info = check_gguf_availability()
    try:
        bnb_info = check_bitsandbytes_availability()
        bnb_reason = bnb_info.get("error")
        gptq_available, gptq_reason = _gptq_status()
        gguf_available = gguf_info.get("available", False)
        if model_manager and getattr(model_manager, "model_cache_dir", None):
            cache_dir = str(model_manager.model_cache_dir)
            os.environ.setdefault("TRANSFORMERS_CACHE", cache_dir)

        original_model_id = model_id or os.environ.get("RAG_LOCAL_MODEL_ID")
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Report loopback vLLM as an external runtime instead of a fallback so startup
        #       logs do not imply that generation quality was silently downgraded.
        runtime_provider = os.environ.get("RAG_RUNTIME_PROVIDER", "local").strip().lower()
        if runtime_provider in ("vllm", "vllm_local", "vllm_openai", "openai_compatible"):
            vllm_model_id = (os.environ.get("RAG_VLLM_MODEL_ID") or original_model_id or "").strip()
            turboquant_enabled = os.environ.get("TURBOQUANT_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")

            def _safe_turboquant_bits(name, default):
                try:
                    return int(os.environ.get(name, str(default)) or default)
                except (TypeError, ValueError):
                    return default

            return {
                "status": "external_runtime",
                "reason": "vllm_local_external_runtime",
                "model_id": vllm_model_id,
                "backend": "vllm_local",
                "downloaded": False,
                "cache_dir": cache_dir,
                "external_runtime": True,
                "quantization_enabled": turboquant_enabled,
                "quantization_backend": "turboquant_kv_cache" if turboquant_enabled else "none",
                "turboquant": {
                    "enabled": turboquant_enabled,
                    "kv_cache_dtype": os.environ.get("TURBOQUANT_KV_CACHE_DTYPE") or None,
                    "k_bits": _safe_turboquant_bits("TURBOQUANT_K_BITS", 4),
                    "v_bits": _safe_turboquant_bits("TURBOQUANT_V_BITS", 4),
                },
            }
        gguf_model_path_env = os.getenv("GGUF_MODEL_PATH")
        gguf_model_path_raw = gguf_model_path_env or DEFAULT_GGUF_MODEL_PATH
        gguf_model_path = str(_resolve_gguf_path(gguf_model_path_raw))
        os.environ["GGUF_MODEL_PATH"] = gguf_model_path
        gguf_repo_id = os.getenv("GGUF_REPO_ID", "Qwen/Qwen2.5-7B-Instruct-GGUF")
        gguf_filename = os.getenv("GGUF_FILENAME", Path(gguf_model_path).name)
        use_gguf_env = os.getenv("USE_GGUF", "false").strip().lower() in ("1", "true", "yes", "on")
        prefer_transformers = bool(original_model_id) and not str(original_model_id).lower().endswith(".gguf")
        gguf_explicitly_configured = bool(gguf_model_path_env or use_gguf_env)
        use_gguf = (backend == "gguf" or use_gguf_env) and not prefer_transformers and gguf_explicitly_configured
        if prefer_transformers and backend == "gguf" and not use_gguf_env:
            backend = "full"
            quant_backend = "full"
        if not use_gguf:
            if backend == "gguf":
                backend = "full"
            if quant_backend == "gguf":
                quant_backend = "full"

        if use_gguf and not gguf_available:
            fallback_reason = gguf_info.get("message") or gguf_info.get("error") or "llama-cpp-python not installed"
            logger.warning("GGUF requested but unavailable (%s); falling back to transformers backend.", fallback_reason)
            backend = "full"
            quant_backend = "full"
            use_gguf = False

        result: Dict[str, Any] = {
            "status": "unknown",
            "model_id": original_model_id or gguf_model_path,
            "backend": backend,
            "downloaded": False,
            "cache_dir": cache_dir,
            "bitsandbytes_available": bnb_info.get("available", False),
            "bitsandbytes_error": bnb_reason,
            "gptq_available": gptq_available,
            "gptq_error": gptq_reason,
            "gguf_available": gguf_available,
            "quantization_enabled": False,
            "quantization_backend": quant_backend,
        }

        if use_gguf and gguf_available:
            gguf_validation = validate_local_model(
                gguf_model_path,
                is_gguf=True,
                auto_download=True,
                repo_id=gguf_repo_id,
                filename_hint=gguf_filename,
            )
            downloaded_now = gguf_validation.get("downloaded", False)
            if gguf_validation.get("available"):
                result.update(
                    {
                        "status": "ready",
                        "info": gguf_validation,
                        "model_id": gguf_validation.get("model_id"),
                        "downloaded": downloaded_now or gguf_validation.get("available"),
                        "quantization_enabled": True,
                        "quantization_backend": "gguf",
                    }
                )
                logger.info(
                    "Quantization backend: gguf (auto-selected for Windows)" if is_windows() else "Quantization backend: gguf"
                )
                logger.info(f"Using GGUF model: {gguf_validation.get('model_id')}")
                return result

            if gguf_validation.get("error"):
                result.update(
                    {
                        "status": "error",
                        "reason": gguf_validation.get("error"),
                        "model_id": gguf_model_path,
                        "quantization_enabled": False,
                        "quantization_backend": "gguf",
                        "downloaded": downloaded_now,
                        "info": gguf_validation,
                    }
                )
                return result

            logger.warning(
                "GGUF model validation failed (%s); attempting final download before fallback",
                gguf_validation.get("reason") or gguf_validation.get("error") or "unknown_reason",
            )

            if _download_gguf_model(gguf_model_path, gguf_repo_id, gguf_filename):
                gguf_validation = validate_local_model(
                    gguf_model_path,
                    is_gguf=True,
                    auto_download=True,
                    repo_id=gguf_repo_id,
                    filename_hint=gguf_filename,
                )
                downloaded_now = downloaded_now or gguf_validation.get("downloaded", False)
                if gguf_validation.get("available"):
                    result.update(
                        {
                            "status": "ready",
                            "info": gguf_validation,
                            "model_id": gguf_validation.get("model_id"),
                            "quantization_enabled": True,
                            "quantization_backend": "gguf",
                            "downloaded": downloaded_now or gguf_validation.get("available"),
                        }
                    )
                    logger.info(f"GGUF model downloaded and ready: {gguf_validation.get('model_id')}")
                    return result

            logger.warning("GGUF model download failed, falling back to full precision")
            result["gguf_validation"] = gguf_validation
            backend = "full"
            quant_backend = "full"

        quant_cfg, bnb_available, bnb_reason = _build_quantization_config()
        target_model_id = original_model_id
        gptq_model_id = os.environ.get("RAG_GPTQ_MODEL_ID", "TheBloke/Qwen2-7B-Instruct-GPTQ")

        if bnb_available and quant_cfg is not None:
            logger.info("bitsandbytes is available, enabling 4-bit quantization for model warmup")
            quant_enabled = True
            quant_backend = "bitsandbytes"
        elif gptq_available:
            quant_enabled = True
            quant_backend = "gptq"
            if gptq_model_id:
                target_model_id = gptq_model_id
            logger.info("bitsandbytes unavailable; falling back to GPTQ model for warmup: %s", target_model_id)
        else:
            reason_text = f" ({bnb_reason})" if bnb_reason else ""
            logger.info("bitsandbytes is not available%s; model warmup will use full precision.", reason_text)

        model_id_to_use = target_model_id

        if not model_id_to_use:
            logger.info("RAG_LOCAL_MODEL_ID not configured, skipping model initialization")
            result.update(
                {
                    "status": "skipped",
                    "reason": "no_model_id_configured",
                    "quantization_enabled": False,
                    "quantization_backend": "none",
                }
            )
            return result

        if not model_manager or not model_manager.is_transformers_available():
            logger.warning("Transformers library not available, local model will use fallback")
            result.update(
                {
                    "status": "fallback",
                    "reason": "transformers_not_available",
                    "model_id": model_id_to_use,
                    "quantization_enabled": quant_enabled,
                    "quantization_backend": quant_backend,
                    "cache_dir": cache_dir,
                }
            )
            return result

        cached_snapshot = _is_snapshot_cached(model_id_to_use, cache_dir)
        result["cached_locally"] = cached_snapshot
        if cached_snapshot:
            logger.info("Model %s is already present in cache (snapshot check)", model_id_to_use)

        logger.info(f"Validating local model: {model_id_to_use}")
        model_info = model_manager.get_model_info(model_id_to_use)

        if cached_snapshot and not model_info.get("available"):
            logger.info("Using cached snapshot for %s even though metadata lookup failed", model_id_to_use)
            model_info = {"available": True, "model_id": model_id_to_use, "cache_dir": cache_dir}

        if not model_info.get("available"):
            logger.info(f"Model {model_id_to_use} not cached, attempting download...")
            snapshot_downloaded = False
            if not cached_snapshot:
                snapshot_downloaded = _download_snapshot(model_id_to_use, cache_dir)
                if snapshot_downloaded:
                    logger.info("Model %s downloaded to cache via huggingface_hub", model_id_to_use)
            download_success = model_manager.ensure_model_downloaded(model_id_to_use, quantization_config=quant_cfg)
            combined_success = bool(download_success or snapshot_downloaded)
            fallback_downloaded = False

            if (
                not combined_success
                and quant_backend == "gptq"
                and original_model_id
                and model_id_to_use != original_model_id
            ):
                logger.warning("GPTQ download failed, retrying full precision model %s", original_model_id)
                model_id_to_use = original_model_id
                quant_enabled = False
                quant_backend = "full"
                download_success = model_manager.ensure_model_downloaded(model_id_to_use, quantization_config=None)
                combined_success = bool(download_success or snapshot_downloaded)

            if not combined_success:
                fallback_downloaded = _download_model_via_transformers(model_id_to_use, cache_dir, quant_cfg)
                combined_success = bool(download_success or snapshot_downloaded or fallback_downloaded)

            if fallback_downloaded:
                logger.info("Model %s downloaded via transformers fallback download", model_id_to_use)

            if combined_success:
                logger.info(f"Model {model_id_to_use} successfully downloaded and ready")
                result.update(
                    {
                        "status": "ready",
                        "model_id": model_id_to_use,
                        "downloaded": True,
                        "quantization_enabled": quant_enabled,
                        "quantization_backend": quant_backend,
                        "cache_dir": cache_dir,
                    }
                )
                return result

            logger.warning(f"Model {model_id_to_use} download failed, will use fallback")
            result.update(
                {
                    "status": "fallback",
                    "reason": "download_failed",
                    "model_id": model_id_to_use,
                    "quantization_enabled": quant_enabled,
                    "quantization_backend": quant_backend,
                    "cache_dir": cache_dir,
                }
            )
            return result

        logger.info(f"Model {model_id_to_use} already cached and ready")
        result.update(
            {
                "status": "ready",
                "model_id": model_id_to_use,
                "downloaded": False,
                "info": model_info,
                "quantization_enabled": quant_enabled,
                "quantization_backend": quant_backend,
            }
        )
        return result

    except Exception as e:
        logger.error(f"Error initializing local model: {str(e)}")
        return {
            "status": "error",
            "reason": str(e),
            "bitsandbytes_available": False,
            "bitsandbytes_error": bnb_reason or str(e),
            "gptq_available": False,
            "gptq_error": gptq_reason or str(e),
            "gguf_available": gguf_info.get("available", False),
            "quantization_enabled": False,
            "quantization_backend": "none",
        }


def get_model_status():
    bnb_reason = None
    gptq_reason = None
    gguf_info = check_gguf_availability()
    try:
        bnb_info = check_bitsandbytes_availability()
        bnb_available, bnb_reason = bnb_info.get("available", False), bnb_info.get("error")
        gptq_available, gptq_reason = _gptq_status()
        model_id = os.environ.get("RAG_LOCAL_MODEL_ID")

        if not model_id:
            return {
                "configured": False,
                "transformers_available": False,
                "bitsandbytes_available": bnb_available,
                "bitsandbytes_error": bnb_reason,
                "gptq_available": gptq_available,
                "gptq_error": gptq_reason,
                "gguf_available": gguf_info.get("available", False),
            }

        if not model_manager:
            return {
                "configured": True,
                "model_id": model_id,
                "transformers_available": False,
                "manager_available": False,
                "bitsandbytes_available": bnb_available,
                "bitsandbytes_error": bnb_reason,
                "gptq_available": gptq_available,
                "gptq_error": gptq_reason,
                "gguf_available": gguf_info.get("available", False),
            }

        transformers_available = model_manager.is_transformers_available()
        model_info = None
        cached_models = []

        if transformers_available:
            try:
                model_info = model_manager.get_model_info(model_id)
                cached_models = model_manager.list_cached_models()
            except Exception as model_err:
                logger.warning(f"Failed to get model info: {model_err}")
                model_info = {"available": False, "reason": str(model_err)}

        return {
            "configured": True,
            "model_id": model_id,
            "transformers_available": transformers_available,
            "manager_available": True,
            "model_info": model_info,
            "cached_models": cached_models,
            "bitsandbytes_available": bnb_available,
            "bitsandbytes_error": bnb_reason,
            "gptq_available": gptq_available,
            "gptq_error": gptq_reason,
            "gguf_available": gguf_info.get("available", False),
        }

    except Exception as e:
        logger.error(f"Error getting model status: {str(e)}")
        import traceback

        traceback.print_exc()
        return {
            "configured": False,
            "error": str(e),
            "bitsandbytes_available": False,
            "bitsandbytes_error": bnb_reason or str(e),
            "gptq_available": False,
            "gptq_error": gptq_reason or str(e),
            "gguf_available": gguf_info.get("available", False),
        }
