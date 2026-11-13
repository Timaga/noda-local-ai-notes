"""Planning delegation through the loaded local runtime, without fallback."""

import ipaddress
import math
from urllib.parse import urlsplit

from backend.inference_llama_server import LlamaCppServerRunner
from backend.inference_runner import (
    ModelInvocationError,
    ModelUnavailableError,
)


def server_status_url(value):
    """Expose a numeric loopback URL without credentials or query."""
    if type(value) is not str or value != value.strip():
        return None
    try:
        parsed = urlsplit(value)
        local = ipaddress.ip_address(parsed.hostname or "").is_loopback
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or not local
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        return None
    return value.rstrip("/")


def invoke_reasoning_plan(
    model, messages, *, model_ready_timeout=60, **parameters
):
    if (
        type(model_ready_timeout) not in (int, float)
        or not math.isfinite(model_ready_timeout)
        or not 0 < model_ready_timeout <= 300
    ):
        raise ModelInvocationError("Invalid bounded model readiness timeout")
    try:
        if model.runtime_provider != "llama_cpp_server":
            raise ModelInvocationError("Reasoning requires the local server")
        if not model.is_fully_loaded:
            ready = model.load_model(
                wait_timeout=model_ready_timeout,
                force_rebuild=not model._pipeline,
            )
            if not ready or not model.is_fully_loaded:
                raise ModelUnavailableError("Local model did not become ready")
        if model._loading and not model._wait_for_loading(model_ready_timeout):
            raise ModelUnavailableError("Local model is still loading")
        if not isinstance(model._pipeline, LlamaCppServerRunner):
            raise ModelInvocationError(
                "Reasoning requires the verified adapter"
            )
        result = model._pipeline.reasoning_plan_text(messages, **parameters)
        model.last_generation = {
            key: result.get(key)
            for key in ("usage", "finish_reason", "elapsed_seconds")
        }
        model.last_generation_error = None
        return result
    except Exception as error:
        model.last_generation_error = type(error).__name__
        raise
