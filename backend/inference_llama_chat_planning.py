"""Opt-in bounded thinking with chat-session prefill and exact full-input checks."""

import time

from backend.inference_messages import chat_messages
from backend.inference_llama_planning import OPEN_THINK_PREFIX, _limit_error, _sampling, _text
from backend.inference_runner import CompletionResponseError, ContextBudgetError, ModelInvocationError, generation_parameters


_VERBOSE_FIELDS = [
    "content", "prompt", "stop", "model", "truncated", "stop_type",
    "tokens_evaluated", "tokens_predicted",
]


def _response(payload, alias, prompt, prompt_tokens, reserve, elapsed):
    choices = payload.get("choices")
    usage = payload.get("usage")
    verbose = payload.get("__verbose")
    if (payload.get("model") != alias or not isinstance(choices, list)
            or len(choices) != 1 or not isinstance(choices[0], dict)
            or type(choices[0].get("index")) is not int or choices[0]["index"] != 0
            or not isinstance(usage, dict) or not isinstance(verbose, dict)):
        raise CompletionResponseError("Unverified bounded chat response identity")
    if (type(usage.get("prompt_tokens")) is not int
            or usage["prompt_tokens"] != prompt_tokens
            or type(usage.get("completion_tokens")) is not int
            or not 1 <= usage["completion_tokens"] <= reserve
            or type(usage.get("total_tokens")) is not int
            or usage["total_tokens"] != prompt_tokens + usage["completion_tokens"]
            or verbose.get("prompt") != prompt or verbose.get("model") != alias
            or verbose.get("stop") is not True or verbose.get("truncated") is not False
            or type(verbose.get("tokens_evaluated")) is not int
            or verbose["tokens_evaluated"] != usage["prompt_tokens"]
            or type(verbose.get("tokens_predicted")) is not int
            or verbose["tokens_predicted"] != usage["completion_tokens"]):
        raise CompletionResponseError("Chat full prompt or token accounting differs")
    choice = choices[0]
    reason = choice.get("finish_reason")
    if reason == "length" and verbose.get("stop_type") == "limit":
        raise _limit_error(verbose, reserve, elapsed)
    if reason != "stop" or verbose.get("stop_type") not in ("eos", "word"):
        raise CompletionResponseError("Bounded chat did not finish normally")
    message = choice.get("message")
    if (not isinstance(message, dict) or message.get("role") != "assistant"
            or set(message) != {"role", "content", "reasoning_content"}):
        raise CompletionResponseError("Chat reasoning and final content were not separated")
    reasoning, _ = _text({"content": message["reasoning_content"]})
    content, _ = _text({"content": message["content"]})
    _text(verbose)
    return {
        "text": reasoning + "\n</think>\n" + content,
        "usage": {key: usage[key] for key in ("prompt_tokens", "completion_tokens", "total_tokens")},
        "finish_reason": "stop", "elapsed_seconds": elapsed,
    }


def reasoning_plan_text(adapter, messages, max_new_tokens, temperature, top_p, *,
                        thinking_budget_tokens, top_k=None, min_p=None,
                        presence_penalty=None, repeat_penalty=None, seed=None):
    """Use actual chat-session state; never accept a partial thinking or final plan."""
    if not isinstance(messages, list):
        raise ModelInvocationError("Bounded thinking requires native role messages")
    messages = chat_messages(messages, max_chars=None)
    try:
        params = generation_parameters(adapter.defaults, {
            "max_new_tokens": max_new_tokens, "temperature": temperature, "top_p": top_p,
        })
    except (ValueError, TypeError, OverflowError) as exc:
        raise ModelInvocationError("Invalid bounded chat parameters") from exc
    reserve = params.pop("max_tokens")
    budget = thinking_budget_tokens
    if type(budget) is not int or not 1 <= budget <= 1024 or budget + 128 > reserve:
        raise ModelInvocationError("Thinking budget must retain final output allowance")
    params.update(_sampling(top_k, min_p, presence_penalty, repeat_penalty, seed))
    with adapter._lock:
        started = time.perf_counter()
        adapter.verify()
        request = {
            **params, "model": adapter.model_alias, "messages": messages,
            "chat_template_kwargs": {"enable_thinking": True},
            "reasoning_format": "deepseek", "reasoning_budget_tokens": budget,
            "reasoning_budget_message": "", "max_tokens": reserve,
            "stream": False, "cache_prompt": False, "verbose": True,
            "response_fields": _VERBOSE_FIELDS,
        }
        rendered = adapter._request("POST", "/apply-template", request).get("prompt")
        if not isinstance(rendered, str) or not rendered.endswith(OPEN_THINK_PREFIX):
            raise ModelInvocationError("Chat template did not enable open reasoning")
        tokens = adapter._request("POST", "/tokenize", {
            "content": rendered, "add_special": True, "parse_special": True, "with_pieces": False,
        }).get("tokens")
        if (not isinstance(tokens, list) or not tokens
                or any(type(token) is not int or token < 0 for token in tokens)):
            raise CompletionResponseError("Invalid bounded chat preflight tokens")
        if len(tokens) + reserve + 2 > adapter.context_size:
            raise ContextBudgetError("Full chat prompt and output reserve exceed context")
        canonical = adapter._request("POST", "/detokenize", {"tokens": tokens}).get("content")
        if not isinstance(canonical, str) or not canonical:
            raise CompletionResponseError("Invalid canonical chat prompt")
        counted = adapter._request("POST", "/v1/chat/completions/input_tokens", request).get("input_tokens")
        if type(counted) is not int or counted != len(tokens):
            raise ContextBudgetError("Chat native token admission differs")
        payload = adapter._request("POST", "/v1/chat/completions", request)
        return _response(payload, adapter.model_alias, canonical, len(tokens), reserve,
                         time.perf_counter() - started)
