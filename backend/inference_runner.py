"""Adapters for model-native chat formatting and bounded local inference."""

import json
import math
import threading
import time

try:
    from backend.inference_messages import chat_messages
except ImportError:
    from inference_messages import chat_messages


class CompletionLimitError(ValueError):
    """The inference provider explicitly reported an output token limit."""


class ContextBudgetError(ValueError):
    """The rendered request cannot preserve its requested output reserve."""


class CompletionResponseError(ValueError):
    """The provider did not return one explicit, completed text answer."""


class ModelUnavailableError(TimeoutError):
    """The loaded local model is temporarily unavailable for strict generation."""


class ModelInvocationError(RuntimeError):
    """Configuration or provider execution failed before a completed response."""


def generation_parameters(defaults, overrides):
    tokens = overrides.get(
        "max_new_tokens", overrides.get("max_tokens", defaults.max_new_tokens)
    )
    temperature = overrides.get("temperature", defaults.temperature)
    top_p = overrides.get("top_p", defaults.top_p)
    if (
        isinstance(tokens, bool)
        or not isinstance(tokens, int)
        or not 1 <= tokens <= 8192
    ):
        raise ValueError("max_tokens must be an integer between 1 and 8192")
    if not math.isfinite(float(temperature)) or not 0 <= float(temperature) <= 2:
        raise ValueError("temperature must be between 0 and 2")
    if not math.isfinite(float(top_p)) or not 0 < float(top_p) <= 1:
        raise ValueError("top_p must be between 0 (exclusive) and 1")
    params = {
        "max_tokens": tokens,
        "temperature": float(temperature),
        "top_p": float(top_p),
    }
    if overrides.get("do_sample") is False:
        params["temperature"] = 0.0
    if overrides.get("response_format") is not None:
        params["response_format"] = overrides["response_format"]
    return params


def completion_result(payload, elapsed_seconds, *, allow_truncated=False):
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if (
        not isinstance(choices, list)
        or len(choices) != 1
        or not isinstance(choices[0], dict)
    ):
        raise CompletionResponseError("Model returned no completion choices")
    choice = choices[0]
    message = choice.get("message")
    if "message" in choice and not isinstance(message, dict):
        raise CompletionResponseError("Model returned an invalid completion message")
    content = (
        message.get("content") if isinstance(message, dict) else choice.get("text")
    )
    if not isinstance(content, str) or not content.strip():
        raise CompletionResponseError("Model returned empty completion text")
    reason = choice.get("finish_reason")
    if reason == "length":
        if not allow_truncated:
            raise CompletionLimitError("Model output was truncated by the token limit")
    elif reason != "stop":
        raise CompletionResponseError("Model completion did not finish normally")
    usage = payload.get("usage")
    return [
        {
            "generated_text": content,
            "usage": usage if isinstance(usage, dict) else {},
            "finish_reason": choice.get("finish_reason"),
            "elapsed_seconds": elapsed_seconds,
        }
    ]


_JSON_CHAR_RULE = (
    r'char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" '
    r"[0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])"
)
_JSON_SAFE_CHAR_RULE = _JSON_CHAR_RULE.replace(r'[^"\\]', r'[^"\\\x00-\x1F]', 1)


def _strict_schema_grammar(schema):
    from llama_cpp import LlamaGrammar
    from llama_cpp.llama_grammar import json_schema_to_gbnf

    grammar = json_schema_to_gbnf(json.dumps(schema, allow_nan=False))
    if not isinstance(grammar, str) or not grammar:
        raise ModelInvocationError("Invalid strict JSON grammar conversion")
    lines = grammar.splitlines()
    indices = [index for index, line in enumerate(lines) if line.startswith("char ::=")]
    if indices:
        if len(indices) != 1 or lines[indices[0]] not in (
            _JSON_CHAR_RULE,
            _JSON_SAFE_CHAR_RULE,
        ):
            raise ModelInvocationError("Unsupported strict JSON character rule")
        # The installed converter's string rule admits raw JSON control characters.
        # Change only that primitive; retain every schema rule and escaped character.
        lines[indices[0]] = _JSON_SAFE_CHAR_RULE
    if r'[^"\\]' in "\n".join(lines):
        raise ModelInvocationError("Unsupported strict JSON character rule")
    return LlamaGrammar.from_string("\n".join(lines), verbose=False)


def _budgeted_chat_completion(model, messages, params, *, required=False):
    """Check the selected handler's actual token list before native generation.

    llama-cpp-python 0.3.20 formats/tokenizes chat before create_completion and
    adds no BOS/EOS to list prompts without suffix. Guard that boundary under
    the runner lock, avoiding a second render or a guessed token count.
    """
    original = getattr(model, "create_completion", None)
    context_size = getattr(model, "n_ctx", None)
    if not callable(original) or not callable(context_size):
        if required:
            raise ContextBudgetError("Exact native token admission is unavailable")
        # Other adapters lack this native boundary; no token admission is claimed.
        return model.create_chat_completion(messages=messages, stream=False, **params)
    response_format = params.get("response_format")
    if required and response_format is not None:
        if (
            not isinstance(response_format, dict)
            or response_format.get("type") != "json_object"
        ):
            raise ModelInvocationError("Unsupported strict JSON response format")
        if "schema" in response_format:
            # Compile directly: the installed chat helper can silently downgrade
            # schema errors to plain JSON. Correct the known string syntax primitive.
            grammar = _strict_schema_grammar(response_format["schema"])
            params = {
                key: value for key, value in params.items() if key != "response_format"
            }
            params["grammar"] = grammar
    had_override = "create_completion" in vars(model)
    checked = False

    def completion(*args, **kwargs):
        nonlocal checked
        tokens = kwargs.get("prompt", args[0] if args else None)
        context = context_size()
        reserve = kwargs.get("max_tokens")
        if (
            not isinstance(tokens, list)
            or not tokens
            or any(type(token) is not int or token < 0 for token in tokens)
            or kwargs.get("suffix") is not None
            or type(context) is not int
            or context < 1
            or type(reserve) is not int
            or reserve != params["max_tokens"]
            or len(tokens) + reserve > context
        ):
            raise ContextBudgetError(
                "Native prompt plus output reserve exceeds context or is unsupported"
            )
        checked = True
        return original(*args, **kwargs)

    model.create_completion = completion
    try:
        result = model.create_chat_completion(messages=messages, stream=False, **params)
        if not checked:
            raise ContextBudgetError("Native chat handler bypassed token admission")
        return result
    finally:
        if had_override:
            model.create_completion = original
        else:
            del model.create_completion


def build_chat_runner(model, defaults):
    """Let the GGUF metadata select its template; serialize its mutable KV cache."""
    lock = threading.Lock()

    def runner(prompt, **kwargs):
        params = generation_parameters(defaults, kwargs)
        response_format = params.get("response_format")
        if (
            isinstance(response_format, dict)
            and response_format.get("type") == "json_schema"
        ):
            # llama-cpp-python accepts its own json_object + schema shape,
            # while the local vLLM endpoint uses the OpenAI json_schema shape.
            params["response_format"] = {
                "type": "json_object",
                "schema": response_format["json_schema"]["schema"],
            }
        with lock:
            started = time.perf_counter()
            payload = _budgeted_chat_completion(
                model,
                chat_messages(
                    prompt,
                    max_chars=(
                        None if kwargs.get("_require_context_budget") is True else 32000
                    ),
                ),
                params,
                required=kwargs.get("_require_context_budget") is True,
            )
            return completion_result(
                payload,
                time.perf_counter() - started,
                allow_truncated=kwargs.get("_warmup") is True,
            )

    return runner
