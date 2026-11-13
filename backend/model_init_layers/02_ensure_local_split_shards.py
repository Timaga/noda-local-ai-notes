# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

def _ensure_local_split_shards(
    target_path: Path, filename_hint: Optional[str], repo_id: str, auto_download: bool = True
) -> bool:
    """
    Ensures that all shards for a split GGUF model are present locally.
    Downloads missing shards when auto_download is enabled.
    """
    split_hint = _parse_split_gguf_filename(target_path.name)
    if not split_hint and filename_hint:
        split_hint = _parse_split_gguf_filename(Path(filename_hint).name)

    if not split_hint:
        return True

    expected_parts = _build_expected_split_parts(split_hint)
    present_parts = [str(target_path.parent / part) for part in expected_parts if (target_path.parent / part).exists()]
    missing_parts = [part for part in expected_parts if not (target_path.parent / part).exists()]

    logger.info(
        "Detected sharded GGUF layout for %s: expected %d parts, found %d locally",
        split_hint.base_name,
        split_hint.total_parts,
        len(present_parts),
    )

    if not missing_parts:
        logger.info("All GGUF shards already present for %s", split_hint.base_name)
        return True

    logger.info(
        "Missing GGUF shards for %s (%d/%d present): %s",
        split_hint.base_name,
        len(present_parts),
        split_hint.total_parts,
        ", ".join(missing_parts),
    )
    if not auto_download:
        logger.warning("Auto-download disabled; missing GGUF shards will block model load")
        return False

    logger.info("Attempting to download %d missing GGUF shards from %s", len(missing_parts), repo_id)
    for part in missing_parts:
        logger.info("Queueing shard for download: %s", part)
    success = _download_gguf_model(str(target_path), repo_id=repo_id, filename=filename_hint or target_path.name)
    if not success:
        raise FileNotFoundError(
            f"Missing GGUF shards could not be downloaded from {repo_id}: {', '.join(missing_parts)}"
        )

    remaining_missing = [part for part in expected_parts if not (target_path.parent / part).exists()]
    if remaining_missing:
        raise FileNotFoundError(
            f"Missing GGUF shards remain unavailable after download: {', '.join(remaining_missing)}"
        )

    logger.info("GGUF shard set is complete after download")
    return True


def _coerce_llama_int(
    value: Any, default: Optional[int], name: str, min_value: Optional[int] = None, max_value: Optional[int] = None
) -> Optional[int]:
    """
    Safely parses integer parameters for llama.cpp, falling back to defaults on invalid values.
    """
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        logger.warning("Invalid %s value %r; using default %s", name, value, default)
        return default

    if min_value is not None and parsed < min_value:
        fallback = default if default is not None else min_value
        logger.warning("%s=%s below minimum %s; using %s", name, parsed, min_value, fallback)
        return fallback
    if max_value is not None and parsed > max_value:
        fallback = default if default is not None else max_value
        logger.warning("%s=%s above maximum %s; using %s", name, parsed, max_value, fallback)
        return fallback
    return parsed


def load_gguf_model(
    model_path: Optional[str] = None,
    n_ctx: Optional[int] = None,
    n_gpu_layers: Optional[int] = None,
    n_threads: Optional[int] = None,
    auto_download: bool = True,
    **kwargs: Any,
):
    """Loads a GGUF model via llama-cpp-python. Auto-downloads if not found."""
    from llama_cpp import Llama

    env_vars = dict(os.environ)
    in_tests = bool(env_vars.get("PYTEST_CURRENT_TEST"))
    auto_download_enabled = bool(auto_download)
    requested_path = model_path or env_vars.get("GGUF_MODEL_PATH")
    filename_env = env_vars.get("GGUF_FILENAME")
    if not requested_path:
        if filename_env:
            requested_path = str(Path("models") / filename_env)
        else:
            requested_path = DEFAULT_GGUF_MODEL_PATH

    target = _resolve_gguf_path(requested_path)
    repo_id = os.getenv("GGUF_REPO_ID", "Qwen/Qwen2.5-7B-Instruct-GGUF")
    filename_hint = filename_env or target.name
    logger.info("Resolved GGUF model path: %s (requested=%s)", target, requested_path)

    # Если базового файла нет, но присутствуют готовые шарды, используем их.
    if not target.exists():
        shard_candidates = sorted(target.parent.glob(f"{target.stem}-*-of-*.gguf"))
        if shard_candidates:
            first_shard = shard_candidates[0]
            split_info = _parse_split_gguf_filename(first_shard.name)
            if split_info:
                expected_parts = _build_expected_split_parts(split_info)
                missing_parts = [part for part in expected_parts if not (first_shard.parent / part).exists()]
                if missing_parts and not auto_download_enabled:
                    raise FileNotFoundError(
                        f"GGUF model not found locally: {target} (missing shards: {', '.join(missing_parts)})"
                    )
                if missing_parts and auto_download_enabled:
                    _ensure_local_split_shards(first_shard, filename_hint or first_shard.name, repo_id, auto_download=True)
                target = first_shard
                filename_hint = filename_hint or first_shard.name

    if not target.exists():
        if auto_download_enabled:
            try:
                downloaded = _download_gguf_model(str(target), repo_id, filename_hint)
            except Exception as exc:
                raise FileNotFoundError(f"GGUF model not found locally: {target}") from exc
            if not downloaded and not target.exists():
                raise FileNotFoundError(f"GGUF model is missing and auto-download failed: {target}")
        else:
            raise FileNotFoundError(f"GGUF model not found locally: {target}")

    if not target.exists():
        raise FileNotFoundError(f"GGUF model not found locally: {target}")

    try:
        shards_ready = _ensure_local_split_shards(target, filename_hint, repo_id, auto_download=auto_download_enabled)
        if not shards_ready and not auto_download_enabled:
            logger.warning("Shard verification skipped download because auto_download is disabled")

        default_ctx = _coerce_llama_int(env_vars.get("GGUF_N_CTX", 8192), 8192, "GGUF_N_CTX", min_value=128)
        ctx = default_ctx if n_ctx is None else _coerce_llama_int(n_ctx, default_ctx, "n_ctx", min_value=128)
        ctx_limit = _coerce_llama_int(env_vars.get("LLAMA_CPP_CTX_MAX", 0), 0, "LLAMA_CPP_CTX_MAX", min_value=0)
        if ctx_limit:
            ctx = min(ctx, ctx_limit)
        hard_cap = _coerce_llama_int(env_vars.get("LLAMA_CPP_CTX_HARD_MAX", 131072), 131072, "LLAMA_CPP_CTX_HARD_MAX", min_value=0)
        if hard_cap:
            ctx = min(ctx, hard_cap)
        ctx = max(128, ctx)

        gpu_layers_default = _coerce_llama_int(env_vars.get("GGUF_N_GPU_LAYERS", 0), 0, "GGUF_N_GPU_LAYERS", min_value=0)
        gpu_layers = gpu_layers_default if n_gpu_layers is None else _coerce_llama_int(
            n_gpu_layers, gpu_layers_default, "n_gpu_layers", min_value=0, max_value=1024
        )

        default_threads = max(os.cpu_count() or 4, 1)
        threads_env = env_vars.get("GGUF_N_THREADS", default_threads)
        threads = _coerce_llama_int(
            n_threads if n_threads is not None else threads_env,
            default_threads,
            "n_threads",
            min_value=1,
            max_value=256,
        )

        n_batch_value = kwargs.pop("n_batch", None)
        if n_batch_value is None and env_vars.get("GGUF_N_BATCH") is not None:
            n_batch_value = env_vars.get("GGUF_N_BATCH")
        n_batch_parsed = None
        if n_batch_value is not None:
            n_batch_parsed = _coerce_llama_int(n_batch_value, None if n_batch_value else None, "n_batch", min_value=1, max_value=8192)

        logger.info(
            "Loading GGUF model from %s with params: n_ctx=%s, n_gpu_layers=%s, n_threads=%s%s",
            target,
            ctx,
            gpu_layers,
            threads,
            f", n_batch={n_batch_parsed}" if n_batch_parsed else "",
        )

        llama_kwargs: Dict[str, Any] = {
            "model_path": str(target),
            "n_ctx": ctx,
            "n_gpu_layers": gpu_layers,
            "n_threads": threads,
            "verbose": False,
        }
        if n_batch_parsed:
            llama_kwargs["n_batch"] = n_batch_parsed
        kv_cache_type = kwargs.pop("kv_cache_type", None)
        if kv_cache_type is None:
            kv_cache_type = env_vars.get("GGUF_KV_CACHE_TYPE")
        if kv_cache_type:
            llama_kwargs["kv_cache_type"] = str(kv_cache_type)

        def _resolve_with_internals(internals, path: Path, env: Dict[str, Any]):
            try:
                return internals.resolve_model_and_shards(str(path), env=env)
            except TypeError:
                return internals.resolve_model_and_shards(env=env)

        try:
            from llama_cpp import _internals

            env_payload = {"GGUF_MODEL_PATH": str(target)}
            resolved_path = None
            shards = None
            try:
                resolved_path, shards = _resolve_with_internals(_internals, target, env_payload)
            except (ValueError, FileNotFoundError) as exc:
                logger.warning("llama.cpp shard resolution failed (%s); retrying after download", exc)
                if auto_download_enabled:
                    try:
                        _download_gguf_model(str(target), repo_id, filename_hint)
                    except Exception as download_exc:
                        logger.warning("GGUF re-download after resolution failure failed: %s", download_exc)
                    try:
                        _ensure_local_split_shards(target, filename_hint, repo_id, auto_download=True)
                    except Exception as ensure_exc:
                        logger.warning("Shard verification after resolution failure failed: %s", ensure_exc)
                try:
                    resolved_path, shards = _resolve_with_internals(_internals, target, env_payload)
                except Exception as exc2:
                    logger.error("Repeated shard resolution failed: %s", exc2)
                    resolved_path, shards = None, None
            except Exception:
                resolved_path, shards = None, None

            if resolved_path:
                llama_kwargs["model_path"] = resolved_path
                if resolved_path != str(target):
                    logger.info("llama.cpp resolved GGUF model path: %s", resolved_path)
            if shards:
                llama_kwargs["shards"] = shards
                logger.info("llama.cpp resolved GGUF shards: %s", shards)
        except Exception:
            # _internals is optional; fall back to provided path when unavailable
            pass

        logger.info(
            "llama.cpp load args: model_path=%s, shards=%s, n_ctx=%s, n_threads=%s, n_gpu_layers=%s, n_batch=%s",
            llama_kwargs.get("model_path"),
            llama_kwargs.get("shards"),
            ctx,
            threads,
            gpu_layers,
            n_batch_parsed if n_batch_parsed else "auto",
        )

        llm = Llama(**llama_kwargs)
        logger.info("GGUF model loaded successfully")
        return llm
    except FileNotFoundError as e:
        if auto_download_enabled:
            logger.warning("GGUF load failed due to missing file/shard; retrying after download")
            try:
                _download_gguf_model(str(target), repo_id, filename_hint)
                _ensure_local_split_shards(target, filename_hint, repo_id, auto_download=True)
            except Exception as download_exc:
                logger.warning("Retry download after FileNotFoundError failed: %s", download_exc)
            llm = Llama(**llama_kwargs)
            logger.info("GGUF model loaded successfully after retry")
            return llm
        raise
    except Exception as e:
        if "llama_model_load: failed to load model" in str(e) and auto_download_enabled:
            logger.warning("Failed to load GGUF model, attempting to re-download.")
            _download_gguf_model(str(target), repo_id, filename_hint)
            return load_gguf_model(
                model_path, n_ctx, n_gpu_layers, n_threads, auto_download=False, **kwargs
            )
        if isinstance(e, OSError) and getattr(e, "errno", None) == 22:
            path_for_error = Path(llama_kwargs.get("model_path") or target)
            shards_for_error = llama_kwargs.get("shards") or []
            missing_shards = [str(shard) for shard in shards_for_error if not Path(shard).exists()]
            logger.error(
                "llama.cpp errno 22 for GGUF load: path=%s (exists=%s), shards=%s, n_ctx=%s, n_threads=%s, n_gpu_layers=%s",
                path_for_error,
                path_for_error.exists(),
                shards_for_error if shards_for_error else None,
                locals().get("ctx"),
                locals().get("threads"),
                locals().get("gpu_layers"),
            )
            if not path_for_error.exists() or missing_shards:
                missing_desc = f"missing shards: {', '.join(missing_shards)}" if missing_shards else "path not found"
                raise FileNotFoundError(f"GGUF model load failed ({missing_desc}): {path_for_error}") from e
            raise ValueError(f"Invalid llama.cpp parameter: {e}") from e
        raise e


def validate_local_model(
    model_identifier: Optional[str],
    is_gguf: bool = False,
    auto_download: bool = False,
    repo_id: Optional[str] = None,
    filename_hint: Optional[str] = None,
) -> Dict[str, Any]:
    """Validates local model availability for both GGUF files and HF ids."""
    if not model_identifier:
        return {"available": False, "reason": "no_model_id_provided"}

    if is_gguf or str(model_identifier).lower().endswith(".gguf"):
        path = _resolve_gguf_path(str(model_identifier))

        def _gguf_info() -> Dict[str, Any]:
            if not path.exists():
                return {"available": False, "model_id": str(path), "reason": "file_not_found"}

            split_info = _parse_split_gguf_filename(path.name)
            expected_parts: List[str] = []
            missing_shards: List[str] = []
            if split_info:
                expected_parts = _build_expected_split_parts(split_info)
                missing_shards = [str(path.parent / part) for part in expected_parts if not (path.parent / part).exists()]

            size = path.stat().st_size
            info: Dict[str, Any] = {
                "available": True,
                "model_id": str(path),
                "model_type": "gguf",
                "size": size,
            }
            if expected_parts:
                info.update(
                    {
                        "shards_expected": len(expected_parts),
                        "shards_present": len(expected_parts) - len(missing_shards),
                    }
                )
            if missing_shards:
                info.update({"available": False, "reason": "missing_shards", "missing_shards": missing_shards})
            return info

        info = _gguf_info()

        if auto_download and not info.get("available"):
            repo = os.getenv("GGUF_REPO_ID", "Qwen/Qwen2.5-7B-Instruct-GGUF") if repo_id is None else repo_id
            filename = filename_hint or path.name
            missing_before = info.get("missing_shards", [])
            if info.get("reason") == "file_not_found":
                downloaded = _download_gguf_model(str(path), repo_id=repo, filename=filename)
                if not downloaded:
                    info["downloaded"] = False
                    return info
            else:
                try:
                    _ensure_local_split_shards(path, filename, repo, auto_download=True)
                except FileNotFoundError as exc:
                    info["error"] = str(exc)
                    info["downloaded"] = False
                    return info

            refreshed = _gguf_info()
            refreshed["downloaded"] = bool(
                refreshed.get("available")
                and (
                    not info.get("available")
                    or refreshed.get("shards_present", 0) > info.get("shards_present", 0)
                    or (missing_before and not refreshed.get("missing_shards"))
                )
            )
            return refreshed

        return info

    if not model_manager or not model_manager.is_transformers_available():
        return {"available": False, "reason": "transformers_not_available", "model_id": model_identifier}
    return model_manager.get_model_info(model_identifier)


