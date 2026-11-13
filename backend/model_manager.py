import logging
import os
# Who: Tim Buglaev
# When: 2026-05-28
# What: Exposed optional dependency helpers at module scope so tests and callers can
#       patch transformers/GGUF discovery without triggering real downloads.
import importlib.util
from pathlib import Path
from typing import Any, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
except Exception:  # pragma: no cover - optional dependency guard
    AutoConfig = None
    AutoModelForCausalLM = None
    AutoTokenizer = None

load_gguf_model = None
get_quantization_backend = None


class ModelManager:
    def __init__(self):
        self.transformers = None
        self.model_cache_dir = self._get_cache_directory()
        self.gguf_model = None
        self.gguf_config = None
        self._import_transformers()

    def _get_cache_directory(self):
        cache_dir = os.environ.get('TRANSFORMERS_CACHE') or os.environ.get('RAG_LOCAL_MODEL_CACHE')
        if cache_dir:
            # Делаем путь общим для всех вызовов transformers, чтобы не размазывать скачанные веса
            os.environ.setdefault('TRANSFORMERS_CACHE', cache_dir)
            return Path(cache_dir)

        home = Path.home()
        if os.name == 'nt':
            return home / '.cache' / 'huggingface' / 'transformers'
        return home / '.cache' / 'huggingface' / 'hub'

    def _import_transformers(self):
        try:
            import transformers
            self.transformers = transformers
            logger.info(f"Transformers library loaded: version {transformers.__version__}")
        except Exception as exc:
            logger.warning("Transformers library not available. Local RAG model will use fallback mode (%s).", exc)
            self.transformers = None

    @staticmethod
    def _accelerate_available():
        try:
            return importlib.util.find_spec("accelerate") is not None
        except Exception:
            return False

    def is_transformers_available(self):
        return self.transformers is not None

    # Who: Tim Buglaev
    # When: 2026-05-28
    # What: Resolve transformers classes from the injected transformers module first so unit
    #       tests and lightweight callers can patch dependencies without real Hub access.
    def _transformers_attr(self, name: str, fallback: Any):
        try:
            from unittest.mock import Mock

            if isinstance(fallback, Mock):
                return fallback
        except Exception:
            pass
        if self.transformers is not None:
            candidate = getattr(self.transformers, name, None)
            if candidate is not None:
                return candidate
        try:
            import sys

            patched_transformers = sys.modules.get("transformers")
            candidate = getattr(patched_transformers, name, None) if patched_transformers is not None else None
            if candidate is not None:
                return candidate
        except Exception:
            pass
        return fallback

    def validate_model(self, model_id):
        if not self.is_transformers_available():
            logger.warning(f"Cannot validate model {model_id}: transformers not available")
            return False

        try:
            tokenizer_class = self._transformers_attr("AutoTokenizer", AutoTokenizer)
            if tokenizer_class is None:
                raise ImportError("AutoTokenizer is unavailable")

            logger.info(f"Validating model: {model_id}")
            tokenizer = tokenizer_class.from_pretrained(
                model_id,
                cache_dir=str(self.model_cache_dir),
                local_files_only=False
            )
            logger.info(f"Model {model_id} validated successfully")
            return True
        except Exception as e:
            logger.error(f"Model validation failed for {model_id}: {str(e)}")
            return False

    def ensure_model_downloaded(self, model_id, force_download=False, quantization_config=None):
        if not self.is_transformers_available():
            logger.warning(f"Cannot download model {model_id}: transformers not available")
            return False

        try:
            tokenizer_class = self._transformers_attr("AutoTokenizer", AutoTokenizer)
            model_class = self._transformers_attr("AutoModelForCausalLM", AutoModelForCausalLM)
            if tokenizer_class is None or model_class is None:
                raise ImportError("transformers model classes are unavailable")

            logger.info(f"Ensuring model is downloaded: {model_id}")

            tokenizer = tokenizer_class.from_pretrained(
                model_id,
                cache_dir=str(self.model_cache_dir),
                force_download=force_download,
            )

            model_kwargs = {
                "cache_dir": str(self.model_cache_dir),
                "force_download": force_download,
            }
            if quantization_config is not None:
                # When quantization is available, ask transformers to load directly in 4/8-bit
                # so we don't spike RAM usage during the warmup download.
                model_kwargs["quantization_config"] = quantization_config
                if self._accelerate_available():
                    model_kwargs["device_map"] = "auto"
                else:
                    logger.warning("accelerate not available; loading quantized model on a single device")

            model = model_class.from_pretrained(
                model_id,
                **model_kwargs
            )

            logger.info(f"Model {model_id} successfully downloaded and cached")
            return True

        except Exception as e:
            logger.error(f"Failed to download model {model_id}: {str(e)}")
            return False

    def get_model_info(self, model_id):
        if not self.is_transformers_available():
            return {
                'available': False,
                'reason': 'transformers_not_installed',
                'model_id': model_id
            }

        try:
            config_class = self._transformers_attr("AutoConfig", AutoConfig)
            if config_class is None:
                raise ImportError("AutoConfig is unavailable")

            config = config_class.from_pretrained(
                model_id,
                cache_dir=str(self.model_cache_dir),
                local_files_only=False
            )

            return {
                'available': True,
                'model_id': model_id,
                'model_type': config.model_type if hasattr(config, 'model_type') else 'unknown',
                'vocab_size': config.vocab_size if hasattr(config, 'vocab_size') else None,
                'cache_dir': str(self.model_cache_dir)
            }
        except Exception as e:
            return {
                'available': False,
                'reason': str(e),
                'model_id': model_id
            }

    def list_cached_models(self):
        if not self.model_cache_dir.exists():
            return []

        cached_models = []
        try:
            for item in self.model_cache_dir.iterdir():
                if item.is_dir():
                    cached_models.append(str(item.name))
        except Exception as e:
            logger.error(f"Failed to list cached models: {str(e)}")

        return cached_models

    def load_gguf_model(self, model_path: Optional[str] = None, **kwargs: Any):
        """
        Loads a GGUF model using llama-cpp-python and stores the handle for reuse.
        """
        # Who: Tim Buglaev
        # When: 2026-05-28
        # What: Reused a module-level GGUF loader hook so tests can patch the loader without
        #       importing model_init repeatedly or loading real model files.
        global load_gguf_model
        if load_gguf_model is None:
            try:
                from model_init import load_gguf_model as imported_loader
                load_gguf_model = imported_loader
            except Exception as exc:
                logger.error(f"Cannot import GGUF loader: {exc}")
                return None

        self.gguf_config = {"model_path": model_path, **kwargs}
        self.gguf_model = load_gguf_model(model_path=model_path, **kwargs)
        return self.gguf_model

    def load_pipeline(self, model_id: Optional[str] = None, backend: Optional[str] = None, **kwargs: Any):
        """
        Creates a pipeline depending on backend selection. Supports GGUF and transformers.
        """
        # Who: Tim Buglaev
        # When: 2026-05-28
        # What: Kept auto GGUF routing explicit to avoid accidental default 7B GGUF loads when
        #       callers only wanted a transformers pipeline and transformers is unavailable.
        backend_choice = backend
        global get_quantization_backend
        if get_quantization_backend is None:
            try:
                from model_init import get_quantization_backend as imported_backend_detector
                get_quantization_backend = imported_backend_detector
            except Exception:
                get_quantization_backend = None  # type: ignore

        if backend_choice in (None, "", "auto") and get_quantization_backend:
            backend_choice = get_quantization_backend()

        has_explicit_model_path = "model_path" in kwargs and kwargs.get("model_path")
        if backend_choice == "gguf" and (backend == "gguf" or has_explicit_model_path):
            return self.load_gguf_model(model_path=kwargs.pop("model_path", None), **kwargs)

        if not self.is_transformers_available():
            logger.warning("Transformers library not available; cannot create pipeline")
            return None

        try:
            pipeline_task = kwargs.pop("pipeline_task", "text-generation")
            tokenizer_id = kwargs.pop("tokenizer", None) or model_id
            return self.transformers.pipeline(
                pipeline_task,
                model=model_id,
                tokenizer=tokenizer_id,
                **kwargs,
            )
        except Exception as exc:
            logger.error(f"Failed to build transformers pipeline: {exc}")
            return None

    def generate_with_gguf(
        self,
        prompt: str,
        max_tokens: int = 512,
        temperature: float = 0.7,
        top_p: float = 0.9,
        **kwargs: Any,
    ) -> str:
        """Generates text using a loaded GGUF model."""
        if self.gguf_model is None:
            raise RuntimeError("GGUF model not loaded")

        stop_tokens = kwargs.get("stop") or ["</s>", "\n\n"]
        output = self.gguf_model(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            echo=False,
            stop=stop_tokens,
        )
        try:
            return output.get("choices", [{}])[0].get("text", "")
        except Exception:
            return str(output)


model_manager = ModelManager()
