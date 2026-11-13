# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

class LocalRagModel:
    def __init__(
        self,
        name,
        model_id=None,
        max_new_tokens=128,
        temperature=0.7,
        top_p=0.95,
        pipeline_task="text-generation",
        cache_dir=None,
        device=None,
        torch_dtype=None,
        quantization=None,
        tokenizer_id=None,
        model_revision=None,
        model_format="transformers",
        gguf_path=None,
        gguf_gpu_layers=None,
        context_window=None,
        trust_remote_code=True,
        threads=None,
        runtime_provider="local",
        vllm_base_url=None,
        vllm_api_key=None,
        vllm_model_id=None,
        vllm_timeout_seconds=45.0,
        vllm_verify_tls=True,
        vllm_allow_remote_host=False,
        turboquant_enabled=False,
        turboquant_k_bits=4,
        turboquant_v_bits=4,
        turboquant_kv_cache_dtype=None,
        llama_server_base_url=None,
        llama_server_timeout_seconds=120.0,
    ):
        self.name = name
        self.model_id = model_id
        self.tokenizer_id = tokenizer_id or model_id
        self.max_new_tokens = max_new_tokens
        self.temperature = temperature
        self.top_p = top_p
        self.pipeline_task = pipeline_task
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.device = device or "auto"
        self.torch_dtype = torch_dtype
        self.quantization = quantization
        self.model_revision = model_revision
        self.model_format = (model_format or "transformers").lower()
        self.gguf_path = Path(gguf_path) if gguf_path else None
        self.gguf_gpu_layers = gguf_gpu_layers
        self.context_window = context_window
        self.trust_remote_code = trust_remote_code
        self.threads = threads
        # Who: Tim Buglaev
        # When: 2026-04-06
        # What: Normalized runtime providers to strict local-only modes (local/vllm_local) and
        #       retained compatibility aliases while explicitly ignoring remote-auth toggles.
        provider_value = str(runtime_provider or "local").strip().lower()
        if provider_value in ("vllm", "vllm_local", "vllm_openai", "openai_compatible"):
            provider_value = "vllm_local"
        elif provider_value != "llama_cpp_server":
            provider_value = "local"
        self.runtime_provider = provider_value
        if provider_value == "llama_cpp_server":
            self.model_format = "llama_cpp_server"
        self.llama_server_base_url = llama_server_base_url
        self.llama_server_timeout_seconds = llama_server_timeout_seconds
        self.vllm_base_url = str(vllm_base_url or "http://127.0.0.1:8000/v1").strip().rstrip("/")
        self.vllm_model_id = str(vllm_model_id or model_id or "").strip()
        if not self.vllm_model_id:
            self.vllm_model_id = str(model_id or "")
        try:
            timeout_value = float(vllm_timeout_seconds)
        except (TypeError, ValueError):
            timeout_value = 45.0
        self.vllm_timeout_seconds = timeout_value if timeout_value > 0 else 45.0
        self.vllm_verify_tls = bool(vllm_verify_tls)
        # Who: Tim Buglaev
        # When: 2026-05-28
        # What: Added explicit TurboQuant KV-cache dtype tracking so vLLM mode can report
        #       the exact server-side preset while still validating bounded legacy bit fields.
        self.turboquant_enabled = bool(turboquant_enabled)
        try:
            tq_k_bits = int(turboquant_k_bits)
        except (TypeError, ValueError):
            tq_k_bits = 4
        try:
            tq_v_bits = int(turboquant_v_bits)
        except (TypeError, ValueError):
            tq_v_bits = 4
        self.turboquant_k_bits = max(1, min(8, tq_k_bits))
        self.turboquant_v_bits = max(1, min(8, tq_v_bits))
        self.turboquant_kv_cache_dtype = str(turboquant_kv_cache_dtype or "").strip() or None
        self._pipeline = None
        self._pipeline_initialized = False
        self._llama_runner = None
        self._loading_lock = threading.Lock()
        self._loading = False
        self.is_fully_loaded = False
        self.downloaded = False
        self.last_load_error = None
        self._warmup_attempted = False
        self.last_generation = None
        self.last_generation_error = None
    def _mark_loaded(self):
        """Sets readiness flags after successful initialization or warmup."""
        self.is_fully_loaded = True
        self.downloaded = True
        self.last_load_error = None
        self._loading = False
    @staticmethod
    def _format_context_details(contexts):
        entries = []
        for entry in contexts or []:
            title = entry.get('title') or 'Безымянный фрагмент'
            snippet = entry.get('snippet') or title
            entries.append(f"{title}: {snippet}")
        if not entries:
            entries.append('Контекст отсутствует.')
        return entries
    def _build_fallback_answer(self, query, contexts):
        header = f"[{self.name}] Локальный ответ на: {query}"
        return header + "\n" + "\n".join(self._format_context_details(contexts))
    def _quantization_requested(self):
        quant = (self.quantization or "").strip().lower()
        return quant not in ("", "none", "off")
    def _resolve_torch_dtype(self):
        if not self.torch_dtype:
            return None
        try:
            import torch
        except Exception:
            return None
        value = str(self.torch_dtype).lower()
        mapping = {
            "float16": torch.float16,
            "fp16": torch.float16,
            "bfloat16": torch.bfloat16,
            "bf16": torch.bfloat16,
            "float32": torch.float32,
            "fp32": torch.float32,
        }
        return mapping.get(value)
    def _accelerate_available(self):
        try:
            import importlib.util
            return importlib.util.find_spec("accelerate") is not None
        except Exception:
            return False
    def _select_fallback_device(self):
        """
        Returns a safe single-device index when accelerate is unavailable.
        Prefers CUDA:0 when available, otherwise CPU (-1).
        """
        try:
            import torch
            if getattr(torch, "cuda", None) and torch.cuda.is_available():
                return 0
        except Exception:
            pass
        return -1
    def _normalize_device_id(self, value):
        """
        Attempts to convert common device strings into pipeline-friendly ints.
        """
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
        if isinstance(value, str):
            lowered = value.lower()
            if lowered == "cpu":
                return -1
            if lowered.startswith("cuda") or lowered.startswith("gpu"):
                return 0
        return None
    def _build_quantization_config(self):
        quant = (self.quantization or "").strip().lower()
        if not self._quantization_requested():
            return None
        available, bnb_error = _bitsandbytes_status()
        if not available:
            reason_text = f" ({bnb_error})" if bnb_error else ""
            print(f"Quantization requested but bitsandbytes is unavailable{reason_text}; falling back to CPU without quantization.")
            self.quantization = None
            return None
        try:
            from transformers import BitsAndBytesConfig
        except Exception as exc:
            print(f"Quantization requested but BitsAndBytesConfig unavailable: {exc}")
            self.quantization = None
            return None
        dtype = self._resolve_torch_dtype()
        if dtype is None:
            try:
                import torch
                dtype = torch.float16
            except Exception:
                dtype = None
        if quant in ("bnb-4bit", "4bit", "int4", "q4"):
            return BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=dtype,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4",
            )
        if quant in ("bnb-8bit", "8bit", "int8"):
            return BitsAndBytesConfig(load_in_8bit=True)
        return None
    def _prepare_model_files(self):
        if self._is_vllm_mode() or self.runtime_provider == "llama_cpp_server":
            return
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Skip transformers cache validation for local llama.cpp/GGUF runs
        #       because the GGUF loader owns shard checks and auto-downloads; this
        #       keeps startup status from reporting the unrelated base model id.
        if self.model_format == "llama_cpp":
            return
        if not _model_downloads_allowed():
            return
        try:
            if self.cache_dir:
                try:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                except Exception as cache_err:
                    print(f'Не удалось создать директорию кэша моделей {self.cache_dir}: {cache_err}')
                else:
                    os.environ.setdefault("TRANSFORMERS_CACHE", str(self.cache_dir))
            from model_init import initialize_local_model
            print(f'Проверяем доступность модели {self.model_id}...')
            init_result = initialize_local_model(model_id=self.model_id)
            print(f'Результат инициализации: {init_result}')
            if isinstance(init_result, dict):
                if init_result.get("status") == "ready":
                    self.downloaded = self.downloaded or bool(init_result.get("downloaded") or init_result.get("info"))
                    self.last_load_error = None
        except Exception as init_exc:
            print(f'Предупреждение при инициализации модели: {init_exc}')
    # Who: Tim Buglaev
    # When: 2026-04-06
    # What: Switched runtime path to local vLLM execution with loopback-only endpoint validation,
    #       strict timeout bounds, and robust response parsing without cloud API semantics.
    def _is_vllm_mode(self):
        return self.runtime_provider == "vllm_local" or self.model_format in ("vllm_local", "vllm_openai", "openai_compatible")
    def _validate_vllm_endpoint(self):
        import ipaddress
        from urllib.parse import urlparse
        base_url = (self.vllm_base_url or "").strip()
        if not base_url:
            return "vLLM base URL is empty"
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https"):
            return f"Unsupported vLLM URL scheme: {parsed.scheme or 'empty'}"
        hostname = (parsed.hostname or "").strip()
        if not hostname:
            return "vLLM URL hostname is empty"
        if hostname in ("localhost", "127.0.0.1", "::1"):
            return None
        try:
            if ipaddress.ip_address(hostname).is_loopback:
                return None
        except ValueError:
            pass
        return f"Only loopback vLLM hosts are allowed in local mode: {hostname}"
    def _extract_vllm_generated_text(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("vLLM response is not a JSON object")
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("vLLM response does not contain choices")
        first_choice = choices[0] if isinstance(choices[0], dict) else {}
        message = first_choice.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content
        text = first_choice.get("text")
        if isinstance(text, str):
            return text
        raise ValueError("vLLM response does not contain generated text")
    def _build_vllm_local_runner(self):
        endpoint_error = self._validate_vllm_endpoint()
        if endpoint_error:
            self.last_load_error = endpoint_error
            print(f"vLLM endpoint validation failed: {endpoint_error}")
            return None
        base_url = (self.vllm_base_url or "").rstrip("/")
        target_model_id = (self.vllm_model_id or self.model_id or "").strip()
        if not target_model_id:
            self.last_load_error = "vLLM model id is not configured"
            print("vLLM runner initialization failed: model id is missing")
            return None
        models_url = f"{base_url}/models"
        try:
            health_response = requests.get(
                models_url,
                timeout=min(self.vllm_timeout_seconds, 5.0),
                verify=self.vllm_verify_tls,
            )
            health_response.raise_for_status()
            try:
                health_payload = health_response.json()
            except ValueError:
                health_payload = {}
            model_entries = health_payload.get("data", []) if isinstance(health_payload, dict) else []
            available_model_ids = {
                str(entry.get("id"))
                for entry in model_entries
                if isinstance(entry, dict) and entry.get("id")
            }
            if available_model_ids and target_model_id not in available_model_ids:
                logger.warning(
                    "Configured vLLM model '%s' is not listed in /models response: %s",
                    target_model_id,
                    sorted(available_model_ids),
                )
        except Exception as exc:
            self.last_load_error = str(exc)
            # Who: Tim Buglaev
            # When: 2026-06-14
            # What: Avoid printing localized Windows socket errors directly because they become
            #       mojibake in Electron logs; report managed vLLM startup as pending instead
            #       of a failure because Electron starts the runtime after backend readiness.
            print(f"vLLM health check pending: endpoint not ready ({type(exc).__name__})")
            return None
        chat_completions_url = f"{base_url}/chat/completions"
        # Who: Tim Buglaev
        # When: 2026-05-28
        # What: Logged the expected TurboQuant server preset in vLLM mode without adding
        #       unsafe per-request fields; TurboQuant is selected when the local vLLM server starts.
        if self.turboquant_enabled and self.turboquant_kv_cache_dtype:
            logger.info(
                "Using local vLLM runtime; expected TurboQuant KV-cache dtype=%s",
                self.turboquant_kv_cache_dtype,
            )
        def runner(prompt, **kwargs):
            from backend.inference_messages import chat_messages
            max_tokens_raw = kwargs.get("max_new_tokens", kwargs.get("max_tokens", self.max_new_tokens))
            try:
                max_tokens = int(max_tokens_raw)
            except (TypeError, ValueError):
                max_tokens = int(self.max_new_tokens)
            max_tokens = max(1, min(8192, max_tokens))
            try:
                temperature = float(kwargs.get("temperature", self.temperature))
            except (TypeError, ValueError):
                temperature = float(self.temperature)
            try:
                top_p = float(kwargs.get("top_p", self.top_p))
            except (TypeError, ValueError):
                top_p = float(self.top_p)
            request_payload = {
                "model": target_model_id,
                "messages": chat_messages(prompt),
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": top_p,
                "stream": False,
            }
            if kwargs.get("response_format") is not None:
                request_payload["response_format"] = kwargs["response_format"]
            started = time.perf_counter()
            response = requests.post(
                chat_completions_url,
                json=request_payload,
                timeout=self.vllm_timeout_seconds,
                headers={"Content-Type": "application/json"},
                verify=self.vllm_verify_tls,
            )
            response.raise_for_status()
            response_payload = response.json()
            from backend.inference_runner import completion_result
            return completion_result(response_payload, time.perf_counter() - started,
                                     allow_truncated=kwargs.get("_warmup") is True)
        return runner
    def _build_llama_cpp_runner(self):
        if not self.gguf_path:
            return None
        try:
            from model_init import _build_expected_split_parts, _parse_split_gguf_filename, load_gguf_model
        except Exception as exc:
            print(f"Failed to import GGUF loader: {exc}")
            return None
        path_obj = Path(self.gguf_path).expanduser()
        def _sanitize_param(raw_value, default_value, name, minimum=1, maximum=None):
            try:
                parsed = int(raw_value)
            except (TypeError, ValueError):
                logger.warning("Invalid %s value %r, using default %s", name, raw_value, default_value)
                return default_value
            if parsed < minimum:
                fallback = max(default_value, minimum)
                logger.warning("%s=%s below minimum %s, using %s", name, parsed, minimum, fallback)
                return fallback
            if maximum is not None and parsed > maximum:
                fallback = min(default_value, maximum)
                logger.warning("%s=%s above maximum %s, using %s", name, parsed, maximum, fallback)
                return fallback
            return parsed
        ctx_default = self.context_window or 8192
        ctx = _sanitize_param(ctx_default, ctx_default or 8192, "n_ctx", minimum=128, maximum=None)
        max_ctx = GGUF_N_CTX if GGUF_N_CTX else ctx
        if max_ctx:
            ctx = min(ctx, max_ctx)
        if LLAMA_CPP_CTX_MAX:
            ctx = min(ctx, LLAMA_CPP_CTX_MAX)
        ctx = max(128, ctx)
        thread_default = self.threads or (os.cpu_count() or 4)
        thread_count = _sanitize_param(thread_default, thread_default or 1, "n_threads", minimum=1, maximum=256)
        gpu_layers_default = self.gguf_gpu_layers if self.gguf_gpu_layers is not None else 0
        gpu_layers = _sanitize_param(gpu_layers_default, gpu_layers_default or 0, "n_gpu_layers", minimum=0, maximum=1024)
        split_hint = _parse_split_gguf_filename(self.gguf_path.name)
        portable = bool(os.environ.get("NODA_RUNTIME_HOME"))
        if portable and not path_obj.is_file():
            self.last_load_error = "Chat model is unavailable. Download a model in Settings."
            return None
        if not path_obj.exists():
            print(f"GGUF file not found locally: {path_obj}. Auto-download will be attempted.")
        elif split_hint:
            expected_parts = _build_expected_split_parts(split_hint)
            missing_parts = [part for part in expected_parts if not (path_obj.parent / part).exists()]
            if missing_parts:
                print(f"GGUF shards missing, will auto-download: {', '.join(missing_parts)}")
        print(f"GGUF params: n_ctx={ctx}, n_threads={thread_count}, n_gpu_layers={gpu_layers}")
        logger.info(
            "Initializing GGUF runner: path=%s, n_ctx=%s, n_threads=%s, n_gpu_layers=%s, backend=%s",
            path_obj,
            ctx,
            thread_count,
            gpu_layers,
            SELECTED_QUANTIZATION_BACKEND or "gguf",
        )
        print("Ensuring GGUF shards are complete; missing parts will be downloaded automatically if needed.")
        try:
            gguf_runner = load_gguf_model(
                model_path=str(path_obj),
                n_ctx=ctx,
                n_gpu_layers=gpu_layers,
                n_threads=thread_count,
                auto_download=not portable and _model_downloads_allowed(),
            )
        except FileNotFoundError as exc:
            self.last_load_error = str(exc)
            print(f"GGUF model is incomplete or missing: {exc}")
            return None
        except Exception as exc:
            self.last_load_error = str(exc)
            logger.exception(
                "Failed to initialize GGUF model (path=%s, n_ctx=%s, n_threads=%s, n_gpu_layers=%s)",
                path_obj,
                ctx,
                thread_count,
                gpu_layers,
            )
            print(f"Failed to initialize GGUF model: {exc}")
            return None
        if not gguf_runner:
            return None
        self._llama_runner = gguf_runner
        self._mark_loaded()
        from backend.inference_runner import build_chat_runner
        return build_chat_runner(gguf_runner, self)
    def _build_gptq_pipeline(self, model_id, pipeline_kwargs):
        if transformers is None:
            return None
        accelerate_available = self._accelerate_available()
        try:
            from auto_gptq import AutoGPTQForCausalLM
            from transformers import AutoTokenizer
        except Exception as exc:
            print(f"AutoGPTQ is not available: {exc}")
            return None
        try:
            tokenizer_kwargs = {}
            if self.cache_dir:
                tokenizer_kwargs["cache_dir"] = str(self.cache_dir)
            if self.trust_remote_code:
                tokenizer_kwargs["trust_remote_code"] = True
            tokenizer = AutoTokenizer.from_pretrained(model_id, **tokenizer_kwargs)
            model_load_kwargs = {
                "trust_remote_code": self.trust_remote_code,
                "use_safetensors": True,
            }
            if accelerate_available:
                model_load_kwargs["device_map"] = "auto"
            elif self.device and self.device != "auto":
                model_load_kwargs["device"] = self.device
            else:
                print("accelerate not installed; loading GPTQ model on a single device.")
            model = AutoGPTQForCausalLM.from_quantized(
                model_id,
                **model_load_kwargs,
            )
            kwargs = dict(pipeline_kwargs)
            kwargs.pop("model_kwargs", None)
            return transformers.pipeline(
                self.pipeline_task or "text-generation",
                model=model,
                tokenizer=tokenizer,
                **kwargs,
            )
        except Exception as exc:
            print(f"GPTQ fallback failed: {exc}")
            return None
    def _build_transformers_pipeline(self):
        if transformers is None or AutoModelForCausalLM is None:
            return None
        pipeline_kwargs = {}
        tokenizer_kwargs = {}
        accelerate_available = self._accelerate_available()
        if self.cache_dir:
            cache_path = str(self.cache_dir)
            pipeline_kwargs["cache_dir"] = cache_path
            tokenizer_kwargs["cache_dir"] = cache_path
        dtype = self._resolve_torch_dtype()
        if dtype is not None:
            pipeline_kwargs["torch_dtype"] = dtype
        if self.trust_remote_code:
            pipeline_kwargs["trust_remote_code"] = True
            tokenizer_kwargs["trust_remote_code"] = True
        model_kwargs = {"trust_remote_code": self.trust_remote_code}
        if self.cache_dir:
            model_kwargs["cache_dir"] = str(self.cache_dir)
        if dtype:
            model_kwargs["torch_dtype"] = dtype
        quant_cfg = self._build_quantization_config()
        if quant_cfg:
            model_kwargs["quantization_config"] = quant_cfg
        if self.device:
            if self.device == "auto":
                if accelerate_available:
                    model_kwargs["device_map"] = "auto"
                else:
                    fallback_device = self._select_fallback_device()
                    pipeline_kwargs["device"] = fallback_device
            else:
                if accelerate_available:
                    model_kwargs["device_map"] = self.device
                else:
                    pipeline_kwargs["device"] = self._normalize_device_id(self.device)
        def _pipeline_kwargs_lightweight():
            lite_kwargs = {}
            if dtype is not None:
                lite_kwargs["dtype"] = dtype
            if "device" in pipeline_kwargs:
                lite_kwargs["device"] = pipeline_kwargs["device"]
            if accelerate_available and model_kwargs.get("device_map"):
                lite_kwargs["model_kwargs"] = {"device_map": model_kwargs["device_map"]}
            return {k: v for k, v in lite_kwargs.items() if v is not None}
        downloads_allowed = _model_downloads_allowed()
        if IS_TEST_ENV and not downloads_allowed:
            return transformers.pipeline(
                self.pipeline_task or "text-generation",
                model=self.model_id,
                tokenizer=self.tokenizer_id or self.model_id,
                **_pipeline_kwargs_lightweight(),
            )
        print(f'????????? ??????? ?????? {self.model_id}...')
        try:
            base_model = AutoModelForCausalLM.from_pretrained(self.model_id, **model_kwargs)
        except Exception as load_exc:
            self.last_load_error = str(load_exc)
            if IS_TEST_ENV or not downloads_allowed:
                print(f"??????? ? offline pipeline ??-?? ?????? ????????: {load_exc}")
                return transformers.pipeline(
                    self.pipeline_task or "text-generation",
                    model=self.model_id,
                    tokenizer=self.tokenizer_id or self.model_id,
                    **_pipeline_kwargs_lightweight(),
                )
            raise
        adapter_path = BASE_DIR / "models" / "lora_adapters"
        if PeftModel is not None and adapter_path.exists() and adapter_path.is_dir():
            try:
                print(f"[START] ??????? LoRA ???????? ? {adapter_path}. ????????...")
                peft_model = PeftModel.from_pretrained(base_model, str(adapter_path))
                print("[SUCCESS] LoRA ???????? ??????? ?????????.")
                model_to_use = peft_model
            except Exception as e:
                print(f"[WARNING] ?? ??????? ????????? LoRA ????????: {e}. ???????????? ??????? ??????.")
                model_to_use = base_model
        else:
            print("?? LoRA ???????? ?? ???????. ???????????? ??????? ??????.")
            model_to_use = base_model
        tokenizer = transformers.AutoTokenizer.from_pretrained(self.tokenizer_id or self.model_id, **tokenizer_kwargs)
        final_pipeline_kwargs = {}
        if "device" in pipeline_kwargs:
            final_pipeline_kwargs["device"] = pipeline_kwargs["device"]
        if dtype is not None:
            final_pipeline_kwargs["torch_dtype"] = dtype
        print(f'???????? pipeline ??? ?????? {self.model_id}...')
        return transformers.pipeline(
            self.pipeline_task or "text-generation",
            model=model_to_use,
            tokenizer=tokenizer,
            **final_pipeline_kwargs,
        )
    def _create_pipeline(self):
        if self.runtime_provider == "llama_cpp_server":
            from backend.inference_llama_server import LlamaCppServerRunner

            runner = LlamaCppServerRunner(
                self.llama_server_base_url, self.gguf_path or self.model_id,
                self.context_window, self, self.llama_server_timeout_seconds,
            ).verify()
            return runner
        if self._is_vllm_mode():
            runner = self._build_vllm_local_runner()
            if runner:
                return runner
            # Who: Tim Buglaev
            # When: 2026-05-28
            # What: Prevented vLLM-local mode from silently falling back to transformers after
            #       a failed loopback health check, avoiding accidental downloads and wrong-model execution.
            return None
        if self.model_format == "llama_cpp":
            runner = self._build_llama_cpp_runner()
            if runner:
                return runner
        return self._build_transformers_pipeline()
    def _warmup_pipeline(self):
        if not self._pipeline:
            return False
        if self.is_fully_loaded:
            return True
        if self.runtime_provider == "llama_cpp_server":
            self._pipeline.verify()
            self._mark_loaded()
            return True
        self._warmup_attempted = True
        try:
            if self.model_format == "llama_cpp":
                print(f'Выполняем первый вызов для GGUF/llama.cpp модели {self.model_id}...')
                try:
                    self._pipeline("Прогрев модели", max_new_tokens=1, temperature=self.temperature, top_p=self.top_p)
                except TypeError:
                    self._pipeline("Прогрев модели")
                self._mark_loaded()
                print("[OK] Model fully loaded and ready")
                return True
            print(f'Выполняем прогрев локальной модели {self.model_id}...')
            warmup_params = {
                "max_new_tokens": 1,
                "do_sample": False,
            }
            if self._is_vllm_mode():
                warmup_params["_warmup"] = True
            generate_call = getattr(self._pipeline, "generate", None)
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message=".*model_kwargs.*")
                warnings.filterwarnings("ignore", message=".*generation flags.*")
                if callable(generate_call):
                    generate_call("Прогрев модели", **warmup_params)
                else:
                    self._pipeline("Прогрев модели", **warmup_params)
            self._mark_loaded()
            print("[OK] Model fully loaded and ready")
            return True
        except Exception as exc:
            self.last_load_error = str(exc)
            print(f"Не удалось прогреть модель: {exc}")
            self.downloaded = False
            self.is_fully_loaded = False
            self._loading = False
            return False
    def _ensure_pipeline(self, force_rebuild=False):
        if self._pipeline_initialized and self._pipeline and not force_rebuild:
            return
        if force_rebuild:
            self._pipeline = None
        if self._pipeline_initialized and not self._pipeline:
            print("Повторная попытка инициализации локального pipeline...")
        self._pipeline_initialized = True
        if not self.model_id:
            return
        try:
            self._prepare_model_files()
            self._pipeline = self._create_pipeline()
            if self._pipeline:
                print(f'[OK] Pipeline успешно инициализирован для {self.model_id}')
                self._warmup_pipeline()
        except Exception as exc:
            error_text = str(exc)
            if "bitsandbytes" in error_text.lower() and self._quantization_requested():
                print(f"bitsandbytes error detected ({error_text}), retrying without quantization...")
                self.quantization = None
                self._pipeline = None
                self.last_load_error = error_text
                self.is_fully_loaded = False
                return self._ensure_pipeline(force_rebuild=True)
            print('Ошибка инициализации локальной модели RAG:', exc)
            self._pipeline = None
            self.is_fully_loaded = False
            self.last_load_error = str(exc)
    def _wait_for_loading(self, timeout):
        start = time.time()
        while getattr(self, "_loading", False) and (time.time() - start) < timeout:
            time.sleep(0.1)
        return not getattr(self, "_loading", False)
    def load_model(self, block=True, wait_timeout=None, force_rebuild=False):
        """
        Создаёт pipeline и прогревает модель, чтобы загрузить веса в память.
        Если block=False, запускает прогрев в фоновом потоке и возвращает False,
        пока модель не будет полностью загружена.
        """
        timeout = wait_timeout or globals().get("MODEL_READY_TIMEOUT", 60)
        if self.is_fully_loaded:
            return True
        if not block:
            if not self._loading:
                threading.Thread(
                    target=self.load_model, kwargs={"block": True}, daemon=True
                ).start()
            return False
        if self._loading:
            self._wait_for_loading(timeout)
            if self.is_fully_loaded:
                return True
            if self._loading:
                return False
        with self._loading_lock:
            if self.is_fully_loaded:
                return True
            self._loading = True
            self.last_load_error = None
            try:
                self._ensure_pipeline(force_rebuild=force_rebuild or not self._pipeline)
                # Who: Tim Buglaev
                # When: 2026-06-14
                # What: Keep model diagnostics ASCII-only and distinguish managed vLLM startup
                #       from a missing embedded local pipeline in Windows/Electron logs.
                if not self._pipeline:
                    if self._is_vllm_mode():
                        print("Managed vLLM runtime is still starting; embedded pipeline was not created.")
                    else:
                        print("Local model is not ready: pipeline was not created.")
                    return False
                ready = self._warmup_pipeline()
                if not ready:
                    self.is_fully_loaded = False
                    self.downloaded = False
                    return False
                return True
            finally:
                self._loading = False
    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Allow bounded deterministic generation parameters for auxiliary model tasks
    #       such as conversational query rewriting while preserving answer-generation defaults.
    def _invoke_pipeline(
        self, prompt, max_new_tokens=None, temperature=None, top_p=None,
        do_sample=None, response_format=None, raise_on_truncation=False,
        require_context_budget=False,
    ):
        try:
            from backend.model_invocation import invoke_pipeline
        except ImportError:
            from model_invocation import invoke_pipeline
        return invoke_pipeline(
            self, prompt, max_new_tokens=max_new_tokens, temperature=temperature,
            top_p=top_p, do_sample=do_sample, response_format=response_format,
            raise_on_truncation=raise_on_truncation,
            require_context_budget=require_context_budget,
            model_ready_timeout=globals().get("MODEL_READY_TIMEOUT", 60),
        )

    def reasoning_plan_text(self, messages, **parameters):
        from backend.inference_llama_runtime import invoke_reasoning_plan

        return invoke_reasoning_plan(
            self, messages,
            model_ready_timeout=globals().get("MODEL_READY_TIMEOUT", 60),
            **parameters,
        )

    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Added a deterministic short inference path that rewrites a conversational
    #       question without answering it; callers validate the strict JSON result.
    def rewrite_search_query(self, prompt):
        return self._invoke_pipeline(
            prompt,
            max_new_tokens=96,
            temperature=0.0,
            top_p=1.0,
            do_sample=False,
            response_format={"type": "json_object"},
        )
    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Added deterministic grounded-answer generation with a bounded JSON contract;
    #       source validation is performed outside the model before API data is exposed.
    def grounded_generation_limits(self):
        if self._is_vllm_mode():
            context_tokens = int(globals().get("RAG_VLLM_MAX_MODEL_LEN", 2048) or 2048)
        else:
            context_tokens = int(self.context_window or 8192)
        context_tokens = max(1024, min(context_tokens, 131072))
        output_tokens = max(192, min(2048, context_tokens // 5))
        # Conservative Cyrillic budget includes JSON instructions and leaves room for output.
        evidence_chars = max(1000, (context_tokens - output_tokens - 650) * 2)
        # Prompt evaluation on a CPU-only GGUF can outlast the desktop request
        # even when the full prompt fits the model's context window.
        default_chars = 6000 if self.model_format == "llama_cpp" and not self.gguf_gpu_layers else 12000
        try:
            configured_chars = int(os.environ.get("RAG_CHAT_CONTEXT_MAX_CHARS") or default_chars)
        except (TypeError, ValueError):
            configured_chars = default_chars
        return output_tokens, max(1000, min(evidence_chars, configured_chars, 24000))

    def generate_grounded_answer(self, query, contexts):
        prompt = build_grounded_answer_prompt(query, contexts)
        print(f"Local grounded answer prompt: contexts={len(contexts or [])}, length={len(prompt)}")
        output_tokens, _ = self.grounded_generation_limits()
        return self._invoke_pipeline(
            prompt,
            max_new_tokens=output_tokens,
            temperature=0.0,
            top_p=1.0,
            do_sample=False,
            response_format={"type": "json_object"},
            raise_on_truncation=True,
        )
    def generate_answer(self, query, contexts):
        prompt = _build_rag_prompt(query, contexts)
        try:
            ctx_count = len(contexts or [])
        except Exception:
            ctx_count = 0
        print(f"Local model answer prompt: contexts={ctx_count}, length={len(prompt)}")
        generated = self._invoke_pipeline(prompt)
        if generated:
            return generated
        return self._build_fallback_answer(query, contexts)
    def select_note_relations(self, prompt_text, response_format, candidate_count=3):
        return self._invoke_pipeline(
            prompt_text,
            max_new_tokens=max(384, min(4096, int(candidate_count) * 320)),
            temperature=0.0,
            top_p=1.0,
            do_sample=False,
            response_format=response_format,
        )

    def audit_note_tags(self, prompt_text, response_format, candidate_count=1):
        return self._invoke_pipeline(
            prompt_text,
            max_new_tokens=max(160, min(720, int(candidate_count) * 180)),
            temperature=0.0,
            top_p=1.0,
            do_sample=False,
            response_format=response_format,
        )

    def generate_note(self, prompt_text, query, contexts):
        try:
            from backend.note_model_inference import generate_note_response
        except ImportError:
            from note_model_inference import generate_note_response
        return generate_note_response(
            self, prompt_text, contexts,
            max_tags=max(0, min(int(MAX_TAGS), 10)),
            max_links=max(0, min(int(MAX_LINKS), 15)),
        )
