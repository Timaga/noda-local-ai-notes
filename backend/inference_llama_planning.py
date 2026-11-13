"""Internal Qwen reasoning continuation with exact admission and no JSON grammar."""

import hashlib
import math
import struct
import time

from backend.inference_messages import chat_messages
from backend.inference_runner import (
    CompletionLimitError,
    CompletionResponseError,
    ContextBudgetError,
    ModelInvocationError,
    generation_parameters,
)


OPEN_THINK_PREFIX = "<|im_start|>assistant\n<think>\n"
MAX_LIMIT_DIAGNOSTIC_BYTES = 65536


def _sampling(top_k, min_p, presence_penalty, repeat_penalty, seed):
    values = {}
    for name, value, lower, upper in (
        ("top_k", top_k, 0, 1000), ("seed", seed, 0, 4294967294),
    ):
        if value is None:
            continue
        if type(value) is not int or not lower <= value <= upper:
            raise ModelInvocationError("Invalid bounded reasoning " + name)
        values[name] = value
    for name, value, lower, upper in (
        ("min_p", min_p, 0.0, 1.0),
        ("presence_penalty", presence_penalty, -2.0, 2.0),
        ("repeat_penalty", repeat_penalty, 0.0, 2.0),
    ):
        if value is None:
            continue
        if (type(value) not in (int, float) or not lower <= value <= upper
                or not math.isfinite(value)):
            raise ModelInvocationError("Invalid bounded reasoning " + name)
        if name == "repeat_penalty":
            try:
                native = struct.unpack("f", struct.pack("f", float(value)))[0]
                struct.pack("f", 1.0 / native)
            except (OverflowError, ZeroDivisionError) as exc:
                raise ModelInvocationError("Unsafe native repeat penalty") from exc
        values[name] = float(value)
    return values


def _text(payload):
    text = payload.get("content")
    if not isinstance(text, str) or not text.strip():
        raise CompletionResponseError("Server returned no internal reasoning text")
    try:
        encoded = text.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise CompletionResponseError("Invalid UTF-8 internal reasoning text") from exc
    return text, encoded


def _limit_error(payload, reserve, elapsed):
    text, encoded = _text(payload)
    complete = len(encoded) <= MAX_LIMIT_DIAGNOSTIC_BYTES
    error = CompletionLimitError("Reasoning output exhausted its generation reserve")
    error.diagnostic = {
        "kind": "native_output_limit", "content": text if complete else None,
        "content_complete": complete, "content_utf8_bytes": len(encoded),
        "content_sha256": hashlib.sha256(encoded).hexdigest(),
        "usage": {
            "prompt_tokens": payload["tokens_evaluated"],
            "completion_tokens": payload["tokens_predicted"],
            "total_tokens": payload["tokens_evaluated"] + payload["tokens_predicted"],
        },
        "n_predict": reserve, "finish_reason": "length", "stop_type": "limit",
        "elapsed_seconds": elapsed,
    }
    return error


def reasoning_plan_text(adapter, messages, max_new_tokens=2048,
                        temperature=0.0, top_p=1.0, *, top_k=None, min_p=None,
                        presence_penalty=None, repeat_penalty=None, seed=None,
                        thinking_budget_tokens=None):
    """Return untrusted internal text; the caller owns parsing and final output."""
    if thinking_budget_tokens is not None:
        from backend.inference_llama_chat_planning import reasoning_plan_text as bounded_chat

        return bounded_chat(
            adapter, messages, max_new_tokens, temperature, top_p,
            thinking_budget_tokens=thinking_budget_tokens, top_k=top_k, min_p=min_p,
            presence_penalty=presence_penalty, repeat_penalty=repeat_penalty, seed=seed,
        )
    if not isinstance(messages, list):
        raise ModelInvocationError("Reasoning planning requires native role messages")
    messages = chat_messages(messages, max_chars=None)
    try:
        params = generation_parameters(adapter.defaults, {
            "max_new_tokens": max_new_tokens,
            "temperature": temperature, "top_p": top_p,
        })
    except (ValueError, TypeError, OverflowError) as exc:
        raise ModelInvocationError("Invalid bounded reasoning parameters") from exc
    params.update(_sampling(top_k, min_p, presence_penalty, repeat_penalty, seed))
    reserve = params.pop("max_tokens")
    with adapter._lock:
        started = time.perf_counter()
        adapter.verify()
        rendered = adapter._request("POST", "/apply-template", {
            "messages": messages,
            "chat_template_kwargs": {"enable_thinking": True},
        }).get("prompt")
        if not isinstance(rendered, str) or not rendered.endswith(OPEN_THINK_PREFIX):
            raise ModelInvocationError("Native template did not enable open reasoning")
        tokens = adapter._request("POST", "/tokenize", {
            "content": rendered, "add_special": True,
            "parse_special": True, "with_pieces": False,
        }).get("tokens")
        if (not isinstance(tokens, list) or not tokens
                or any(type(token) is not int or token < 0 for token in tokens)):
            raise CompletionResponseError("Server returned invalid reasoning prompt tokens")
        if len(tokens) + reserve + 2 > adapter.context_size:
            raise ContextBudgetError("Complete reasoning prompt and output reserve exceed context")
        payload = adapter._request("POST", "/completion", {
            **params, "prompt": tokens, "n_predict": reserve,
            "stream": False, "cache_prompt": False, "reasoning_budget_tokens": -1,
        })
        if (payload.get("stop") is not True
                or payload.get("truncated") is not False
                or payload.get("model") != adapter.model_alias
                or type(payload.get("tokens_evaluated")) is not int
                or payload["tokens_evaluated"] != len(tokens)
                or type(payload.get("tokens_predicted")) is not int
                or not 1 <= payload["tokens_predicted"] <= reserve):
            raise CompletionResponseError("Unverified reasoning completion or token accounting")
        if payload.get("stop_type") == "limit":
            raise _limit_error(payload, reserve, time.perf_counter() - started)
        if payload.get("stop_type") not in ("eos", "word"):
            raise CompletionResponseError("Reasoning completion did not finish normally")
        text, _ = _text(payload)
        return {
            "text": text,
            "usage": {
                "prompt_tokens": payload["tokens_evaluated"],
                "completion_tokens": payload["tokens_predicted"],
                "total_tokens": payload["tokens_evaluated"] + payload["tokens_predicted"],
            },
            "finish_reason": "stop",
            "elapsed_seconds": time.perf_counter() - started,
        }
