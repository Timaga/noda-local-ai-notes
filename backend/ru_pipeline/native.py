"""Full-source model invocation over the owned, pinned local native lifecycle."""

import hashlib
import json

from backend.inference_llama_server import LlamaCppServerRunner
from backend.inference_runner import ContextBudgetError
from backend.model_invocation import invoke_pipeline
from backend.note_processing_failures import NoteSystemError
from backend.ru_pipeline.native_server import OwnedServer, normal


class SeededRunner(LlamaCppServerRunner):
    def _request(self, method, endpoint, payload=None):
        if method == "POST" and endpoint == "/completion":
            payload = {**payload, "seed": 1337}
        return super()._request(method, endpoint, payload)


class NativeSession:
    def __init__(
        self,
        model_key,
        config,
        *,
        server_factory=OwnedServer,
        runner_factory=SeededRunner
    ):
        self.config, self.model_key = config, model_key
        self.server_factory, self.runner_factory = server_factory, runner_factory
        self.server = self._pipeline = None
        self.max_new_tokens, self.temperature, self.top_p = 1024, 0.0, 1.0
        self.model_format, self.is_fully_loaded, self._loading = (
            "llama_cpp_server",
            True,
            False,
        )
        self.last_generation_error = self.last_load_error = self.last_generation = None
        self.calls = []

    def __enter__(self):
        if self.server is not None:
            raise NoteSystemError("Повторное использование сеанса модели запрещено.")
        try:
            self.server = self.server_factory(self.model_key, self.config)
            base_url = self.server.__enter__()
            self._pipeline = self.runner_factory(
                base_url,
                self.server.profile.model,
                self.server.profile.context,
                self,
                timeout_seconds=getattr(self.config, "native_request_timeout", 120),
            )
            self._pipeline.verify()
            self.server.assert_active()
            return self
        except BaseException as exc:
            try:
                self.close()
            except Exception as cleanup_error:
                raise NoteSystemError(
                    "Не подтверждено завершение локального сервера.",
                    failure_code="ru_native_shutdown_failed",
                ) from cleanup_error
            if not isinstance(exc, Exception):
                raise
            raise NoteSystemError(
                "Не удалось запустить выбранную локальную модель.",
                failure_code="ru_native_startup_failed",
            ) from exc

    def _is_vllm_mode(self):
        return False

    def invoke(self, messages, **sampling):
        if self._pipeline is None:
            raise NoteSystemError("Локальный сеанс модели закрыт.")
        before = json.dumps(messages, ensure_ascii=False, allow_nan=False).encode(
            "utf-8"
        )
        try:
            seed = sampling.pop("seed", 1337)
            if type(seed) is not int or seed != 1337:
                raise ValueError("Selected Russian pipeline seed must be1337")
            self.server.assert_active()
            value = invoke_pipeline(self, messages, **sampling)
            self.server.assert_active()
            if before != json.dumps(
                messages, ensure_ascii=False, allow_nan=False
            ).encode("utf-8"):
                raise ValueError("Source messages changed during native inference")
            self.calls.append(
                {
                    "input_sha256": hashlib.sha256(before).hexdigest(),
                    "response_sha256": hashlib.sha256(
                        value.encode("utf-8")
                    ).hexdigest(),
                    "generation": self.last_generation,
                }
            )
            return value
        except ContextBudgetError:
            raise
        except Exception as exc:
            raise NoteSystemError(
                "Локальная модель не вернула проверенный полный ответ.",
                failure_code="ru_native_inference_failed",
            ) from exc

    def close(self):
        error = None
        if self._pipeline is not None:
            try:
                self._pipeline.close()
            except Exception as exc:
                error = exc
            finally:
                self._pipeline = None
        if self.server is not None:
            cleanup = self.server.close()
            no_launch = hasattr(self.server, "process") and self.server.process is None
            if not no_launch and not normal(cleanup):
                raise NoteSystemError(
                    "Локальный сервер завершился нештатно; обработка не сохранена.",
                    failure_code="ru_native_shutdown_failed",
                )
        if error is not None:
            raise NoteSystemError(
                "Не удалось закрыть соединение локальной модели.",
                failure_code="ru_native_client_close_failed",
            ) from error

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False
