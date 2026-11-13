"""Exact, full-text chat admission for a separately owned loopback llama-server."""

import ipaddress
import json
import math
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

import requests

from backend.inference_messages import chat_messages
from backend.inference_runner import (
    CompletionLimitError,
    CompletionResponseError,
    ContextBudgetError,
    ModelInvocationError,
    ModelUnavailableError,
    completion_result,
    generation_parameters,
)


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate provider JSON key")
        result[key] = value
    return result


def _constant(_):
    raise ValueError("Nonfinite provider JSON value")


class LlamaCppServerRunner:
    """Use one verified model/slot and submit the admitted token IDs unchanged."""

    def __init__(self, base_url, expected_model_path, context_size, defaults,
                 timeout_seconds=120.0, *, expected_adapter=None):
        try:
            parsed = urlsplit(str(base_url or ""))
            local = ipaddress.ip_address(parsed.hostname or "").is_loopback
            port = parsed.port
        except ValueError as exc:
            raise ModelInvocationError("Invalid loopback server URL") from exc
        if (parsed.scheme != "http" or not local or port is None
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ModelInvocationError("Explicit numeric loopback server URL required")
        path = Path(str(expected_model_path or ""))
        if not path.is_absolute() or type(context_size) is not int or context_size < 128:
            raise ModelInvocationError("Explicit absolute model path and context required")
        try:
            timeout = float(timeout_seconds)
        except (TypeError, ValueError) as exc:
            raise ModelInvocationError("Invalid server timeout") from exc
        if (isinstance(timeout_seconds, bool) or not math.isfinite(timeout)
                or not 1 <= timeout <= 300):
            raise ModelInvocationError("Server timeout must be between 1 and 300 seconds")
        self.base_url = str(base_url).rstrip("/")
        self.expected_model_path = path.resolve()
        self.expected_adapter = expected_adapter
        self.lora_metadata = None
        if expected_adapter is not None:
            from backend import inference_llama_lora as lora

            if self.expected_model_path != (lora.ROOT / "models/ru-title-tlite-7b-q8-v1/t-lite-it-1.0-q8_0.gguf").resolve():
                raise ModelInvocationError("LoRA requires the exact approved T-Lite base")
            try:
                lora.verify_base_file(path)
                lora.verify_adapter_files(expected_adapter)
            except (ValueError, OSError) as exc:
                raise ModelInvocationError("Pinned LoRA assets are unverified") from exc
        self.context_size = context_size
        self.defaults = defaults
        self.timeout = (3.0, timeout)
        self._lock = threading.Lock()
        self._session = requests.Session()
        self._session.trust_env = False
        self._session.proxies.clear()
        self._session.auth = None
        self._session.cookies.clear()
        self._session.headers.clear()
        self._session.headers["Content-Type"] = "application/json"
        self.model_alias = None
        self.metadata = None

    def close(self):
        self._session.close()

    def _request(self, method, endpoint, payload=None):
        if self.expected_adapter is not None and method == "POST" and endpoint in ("/completion", "/v1/chat/completions"):
            from backend.inference_llama_lora import bind_completion

            payload = bind_completion(payload, self.expected_adapter)
            self.verify()
        try:
            body = None if payload is None else json.dumps(
                payload, ensure_ascii=False, allow_nan=False
            ).encode("utf-8", errors="strict")
        except (ValueError, TypeError, UnicodeError) as exc:
            raise ModelInvocationError("Invalid UTF-8 server request") from exc
        if body is not None and len(body) > 8 * 1024 * 1024:
            raise ContextBudgetError("Full request exceeds the bounded transport budget")
        try:
            response = self._session.request(
                method, self.base_url + endpoint, data=body,
                timeout=self.timeout, allow_redirects=False, stream=True,
            )
        except requests.Timeout as exc:
            raise TimeoutError("Local inference server timed out") from exc
        except requests.ConnectionError as exc:
            raise ConnectionError("Local inference server unavailable") from exc
        except requests.RequestException as exc:
            raise ModelInvocationError("Local inference transport failed") from exc
        if response.status_code == 503:
            response.close()
            raise ModelUnavailableError("Local inference server is not ready")
        if response.status_code != 200:
            response.close()
            raise ModelInvocationError("Local inference server rejected the request")
        try:
            body = bytearray()
            for chunk in response.iter_content(chunk_size=65536):
                if not isinstance(chunk, bytes) or len(body) + len(chunk) > 8 * 1024 * 1024:
                    raise ValueError("Invalid or oversized provider response")
                body.extend(chunk)
            result = json.loads(body.decode("utf-8", errors="strict"),
                                object_pairs_hook=_object, parse_constant=_constant)
            if not isinstance(result, dict):
                raise ValueError("Provider response must be an object")
            return result
        except requests.Timeout as exc:
            raise TimeoutError("Local inference response timed out") from exc
        except requests.ConnectionError as exc:
            raise ConnectionError("Local inference response was interrupted") from exc
        except requests.RequestException as exc:
            raise ModelInvocationError("Local inference response transport failed") from exc
        except (ValueError, UnicodeError, AttributeError) as exc:
            raise CompletionResponseError("Invalid local inference response") from exc
        finally:
            response.close()

    def verify(self):
        if self.expected_adapter is not None:
            self.lora_metadata = None
        props = self._request("GET", "/props")
        if props.get("is_sleeping") is True:
            raise ModelUnavailableError("Local inference server is sleeping")
        if props.get("is_sleeping") is not False:
            raise CompletionResponseError("Server readiness is unverified")
        settings = props.get("default_generation_settings")
        reported_path = Path(str(props.get("model_path") or ""))
        alias = props.get("model_alias")
        if (not isinstance(settings, dict)
                or type(settings.get("n_ctx")) is not int
                or settings["n_ctx"] != self.context_size
                or type(props.get("total_slots")) is not int
                or props["total_slots"] != 1
                or not reported_path.is_absolute()
                or reported_path.resolve() != self.expected_model_path
                or not isinstance(alias, str) or not alias
                or (self.model_alias is not None and alias != self.model_alias)):
            raise ModelInvocationError("Server model, single slot or context identity differs")
        self.model_alias = alias
        self.metadata = props
        if self.expected_adapter is not None:
            from backend.inference_llama_lora import parameter_metadata, verify_native_adapters, verify_pin_hashes

            try:
                verify_pin_hashes(self.expected_adapter)
            except (ValueError, OSError) as exc:
                self.lora_metadata = None
                raise ModelInvocationError("Pinned LoRA assets are unverified") from exc
            payload = self._request_array("GET", "/lora-adapters")
            try:
                state = verify_native_adapters(payload, self.expected_adapter)
            except ValueError as exc:
                self.lora_metadata = None
                raise ModelInvocationError("Native LoRA identity is unverified") from exc
            self.lora_metadata = {**parameter_metadata(self.expected_adapter), "adapter_native_handle_verified": True,
                                  "adapter_controlled_inference_verified": False, "native_adapter_state": state}
        return self

    def _request_array(self, method, endpoint):
        if method != "GET" or endpoint != "/lora-adapters" or self.expected_adapter is None:
            raise ModelInvocationError("Only opt-in native adapter array allowed")
        from backend.inference_llama_lora import request_adapter_list

        return request_adapter_list(self._session, self.base_url, self.timeout)

    @staticmethod
    def _schema(response_format, required):
        if response_format is None:
            if required:
                raise ModelInvocationError("Strict server generation requires JSON schema")
            return None
        if (not isinstance(response_format, dict)
                or set(response_format) != {"type", "json_schema"}
                or response_format["type"] != "json_schema"):
            raise ModelInvocationError("Unsupported server JSON response format")
        wrapped = response_format["json_schema"]
        if not isinstance(wrapped, dict) or wrapped.get("strict") is not True:
            raise ModelInvocationError("Strict JSON schema required")
        schema = wrapped.get("schema")
        if (not isinstance(schema, dict) or schema.get("type") != "object"
                or schema.get("additionalProperties") is not False
                or not isinstance(schema.get("properties"), dict)
                or not schema["properties"]
                or not isinstance(schema.get("required"), list)
                or any(not isinstance(key, str) for key in schema["required"])
                or set(schema["required"]) != set(schema["properties"])
                or len(schema["required"]) != len(schema["properties"])):
            raise ModelInvocationError("Closed required-field JSON schema required")
        try:
            return json.loads(json.dumps(schema, allow_nan=False))
        except (ValueError, TypeError) as exc:
            raise ModelInvocationError("Invalid server JSON schema") from exc

    def reasoning_plan_text(self, messages, max_new_tokens=2048, temperature=0.0, top_p=1.0,
                            *, top_k=None, min_p=None, presence_penalty=None,
                            repeat_penalty=None, seed=None, thinking_budget_tokens=None):
        from backend.inference_llama_planning import reasoning_plan_text

        return reasoning_plan_text(
            self, messages, max_new_tokens, temperature, top_p, top_k=top_k,
            min_p=min_p, presence_penalty=presence_penalty,
            repeat_penalty=repeat_penalty, seed=seed, thinking_budget_tokens=thinking_budget_tokens,
        )

    def __call__(self, prompt, **kwargs):
        if self.expected_adapter is not None and any(key in kwargs for key in ("lora", "lora_scale", "adapter_scale", "adapter_path")):
            raise ModelInvocationError("Caller LoRA override refused")
        params = generation_parameters(self.defaults, kwargs)
        schema = self._schema(params.pop("response_format", None),
                              kwargs.get("_require_context_budget") is True)
        messages = chat_messages(prompt, max_chars=None)
        with self._lock:
            started = time.perf_counter()
            self.verify()
            rendered = self._request("POST", "/apply-template", {
                "messages": messages,
                "chat_template_kwargs": {"enable_thinking": False},
            }).get("prompt")
            if not isinstance(rendered, str) or not rendered:
                raise CompletionResponseError("Server returned no native chat template")
            tokens = self._request("POST", "/tokenize", {
                "content": rendered, "add_special": True,
                "parse_special": True, "with_pieces": False,
            }).get("tokens")
            if (not isinstance(tokens, list) or not tokens
                    or any(type(token) is not int or token < 0 for token in tokens)):
                raise CompletionResponseError("Server returned invalid prompt tokens")
            reserve = params.pop("max_tokens")
            if len(tokens) + reserve + 2 > self.context_size:
                raise ContextBudgetError("Complete prompt and output reserve exceed context")
            request = {
                **params, "prompt": tokens, "n_predict": reserve,
                "stream": False, "cache_prompt": False,
            }
            if schema is not None:
                request["json_schema"] = schema
            payload = self._request("POST", "/completion", request)
            if (payload.get("stop") is not True
                    or payload.get("truncated") is not False
                    or payload.get("model") != self.model_alias
                    or type(payload.get("tokens_evaluated")) is not int
                    or payload["tokens_evaluated"] != len(tokens)
                    or type(payload.get("tokens_predicted")) is not int
                    or not 1 <= payload["tokens_predicted"] <= reserve):
                raise CompletionResponseError("Unverified server completion or token accounting")
            stop_type = payload.get("stop_type")
            if stop_type == "limit" and kwargs.get("_warmup") is not True:
                raise CompletionLimitError("Model output was truncated by the token limit")
            if stop_type not in ("eos", "word") and not (
                stop_type == "limit" and kwargs.get("_warmup") is True
            ):
                raise CompletionResponseError("Server completion did not finish normally")
            usage = {
                "prompt_tokens": payload["tokens_evaluated"],
                "completion_tokens": payload["tokens_predicted"],
                "total_tokens": payload["tokens_evaluated"] + payload["tokens_predicted"],
            }
            return completion_result({"choices": [{
                "message": {"content": payload.get("content")},
                "finish_reason": "length" if stop_type == "limit" else "stop",
            }], "usage": usage}, time.perf_counter() - started,
                allow_truncated=kwargs.get("_warmup") is True)
