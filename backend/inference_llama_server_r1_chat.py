"""Finite native CHAT planning for one pinned, separately owned R1 profile.

Profile fields authenticate the declared contract. Loaded model bytes and the
server process lifetime remain the responsibility of OwnedServer verification.
This module neither opens model files nor discovers or starts a server.
"""

from dataclasses import is_dataclass
import hashlib
import json
import math
from pathlib import Path
import time

from backend.inference_llama_chat_planning import _response
from backend.inference_llama_planning import _sampling
from backend.inference_messages import chat_messages
from backend.inference_runner import (
    CompletionLimitError,
    CompletionResponseError,
    ContextBudgetError,
    ModelInvocationError,
    generation_parameters,
)


ROOT = Path(__file__).resolve().parents[1]
PROFILE_ID = "deepseek_r1"
MODEL = (
    ROOT / "models/ru-title-deepseek-r1-7b-q8-v1/DeepSeek-R1-Distill-Qwen-7B-Q8_0.gguf"
)
MODEL_SHA256 = "7307bfbb539fd2e8ed636315440781fed23140dc7f911f64b33418f5b978281b"
ALIAS = "ru-title-deepseek-r1-7b-q8-v1"
PARAMETERS = 7_615_616_512
TEMPLATE_SHA256 = "b6835114b7303ddd78919a82e4d9f7d8c26ed0d7dfc36beeb12d524f6144eab1"
STARTUP = ROOT / "output/ru-title-20261012/r1-cpu-plan-v1/startup-r1-proposed.json"
STARTUP_SHA256 = "bf8f176ca4f40f62db542106420fc5fc65edaa5dab7b6c4fc8fa170cd72841d7"
BOS, EOS = "<｜begin▁of▁sentence｜>", "<｜end▁of▁sentence｜>"
BOS_ID, VOCAB_SIZE = 151646, 152064
OPEN_THINK_PREFIX = "<｜Assistant｜><think>\n"
MAX_REQUEST_BYTES = 8 * 1024 * 1024
_VERBOSE_FIELDS = [
    "content",
    "prompt",
    "stop",
    "model",
    "truncated",
    "stop_type",
    "tokens_evaluated",
    "tokens_predicted",
]


def verify_profile(profile):
    """Bind the existing immutable descriptor without importing script modules."""
    kind = type(profile)
    if (
        not is_dataclass(profile)
        or isinstance(profile, type)
        or kind.__module__ != "scripts.ru_title_gpu_profiles"
        or kind.__name__ != "ServerProfile"
        or not kind.__dataclass_params__.frozen
    ):
        raise ModelInvocationError("Immutable approved R1 profile required")
    integer_fields = ("parameters", "nominal_size_billion", "context", "parallel")
    if any(type(getattr(profile, field, None)) is not int for field in integer_fields):
        raise ModelInvocationError("Exact integer R1 profile fields required")
    model, startup = getattr(profile, "model", None), getattr(
        profile, "args_path", None
    )
    if (
        not isinstance(model, Path)
        or not isinstance(startup, Path)
        or getattr(profile, "id", None) != PROFILE_ID
        or model.resolve() != MODEL.resolve()
        or getattr(profile, "model_sha256", None) != MODEL_SHA256
        or getattr(profile, "alias", None) != ALIAS
        or getattr(profile, "parameters", None) != PARAMETERS
        or getattr(profile, "nominal_size_billion", None) != 7
        or startup.resolve() != STARTUP.resolve()
        or getattr(profile, "args_sha256", None) != STARTUP_SHA256
        or getattr(profile, "context", None) != 8192
        or getattr(profile, "parallel", None) != 1
        or getattr(profile, "license", None) != "MIT AND Apache-2.0"
        or getattr(profile, "model_shards", None) != ()
    ):
        raise ModelInvocationError("Pinned nominal-7B R1 profile differs")


def _configured_adapter(adapter, profile):
    if (
        getattr(adapter, "expected_adapter", None) is not None
        or getattr(adapter, "expected_model_path", None) != MODEL.resolve()
        or type(getattr(adapter, "context_size", None)) is not int
        or adapter.context_size != profile.context
    ):
        raise ModelInvocationError("Pinned R1 base without an adapter required")


def _verified_native(adapter, profile):
    _configured_adapter(adapter, profile)
    props = adapter.metadata
    if not isinstance(props, dict):
        raise CompletionResponseError("R1 server properties are unverified")
    settings = props.get("default_generation_settings")
    template = props.get("chat_template")
    if (
        not isinstance(settings, dict)
        or type(settings.get("n_ctx")) is not int
        or settings["n_ctx"] != profile.context
        or type(props.get("total_slots")) is not int
        or props["total_slots"] != 1
        or props.get("is_sleeping") is not False
        or adapter.model_alias != ALIAS
        or props.get("model_alias") != ALIAS
        or props.get("model_path") != str(MODEL.resolve())
        or props.get("bos_token") != BOS
        or props.get("eos_token") != EOS
        or type(template) is not str
    ):
        raise ModelInvocationError("R1 server model, template or BOS/EOS differs")
    try:
        digest = hashlib.sha256(template.encode("utf-8", errors="strict")).hexdigest()
    except UnicodeError as exc:
        raise ModelInvocationError("Invalid UTF-8 R1 native template") from exc
    if digest != TEMPLATE_SHA256:
        raise ModelInvocationError("Unapproved R1 native template pin")


def _source_messages(messages):
    try:
        if not isinstance(messages, list):
            raise ValueError("Native text messages required")
        result = chat_messages(messages, max_chars=None)
        if len(result) > 19 or any(
            message["role"] != "user" or not message["content"].strip()
            for message in result
        ):
            raise ValueError("User-only source messages and one continuation required")
        for message in result:
            message["content"].encode("utf-8", errors="strict")
        return result
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ModelInvocationError("Invalid R1 source messages") from exc


def _fold_roles(messages):
    try:
        if not isinstance(messages, list) or len(messages) != 2:
            raise ValueError("Exactly one system and one user message required")
        result = chat_messages(messages, max_chars=None)
        if [item["role"] for item in result] != ["system", "user"]:
            raise ValueError("Explicit system then user folding required")
        for item in result:
            if not item["content"].strip():
                raise ValueError("Nonblank complete role content required")
            item["content"].encode("utf-8", errors="strict")
        return [
            {
                "role": "user",
                "content": result[0]["content"] + "\n\n" + result[1]["content"],
            }
        ]
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ModelInvocationError("Invalid explicit R1 system/user folding") from exc


def _field(adapter, endpoint, request, key):
    payload = adapter._request("POST", endpoint, request)
    if not isinstance(payload, dict):
        raise CompletionResponseError("Invalid R1 provider response object")
    return payload.get(key)


def _parameters(defaults, max_new_tokens, temperature, top_p):
    try:
        if any(
            type(value) not in (int, float) or not math.isfinite(value)
            for value in (temperature, top_p)
        ):
            raise ValueError("Finite numeric sampling required")
        return generation_parameters(
            defaults,
            {
                "max_new_tokens": max_new_tokens,
                "temperature": temperature,
                "top_p": top_p,
            },
        )
    except (ValueError, TypeError, OverflowError) as exc:
        raise ModelInvocationError("Invalid finite R1 generation parameters") from exc


def _invoke(
    adapter,
    messages,
    max_new_tokens,
    temperature,
    top_p,
    *,
    profile,
    thinking_budget_tokens,
    top_k=None,
    min_p=None,
    presence_penalty=None,
    repeat_penalty=None,
    seed=None,
    schema=None,
):
    verify_profile(profile)
    _configured_adapter(adapter, profile)
    source = _source_messages(messages)
    params = _parameters(adapter.defaults, max_new_tokens, temperature, top_p)
    reserve, budget = params.pop("max_tokens"), thinking_budget_tokens
    if type(budget) is not int or not 1 <= budget <= 1024 or budget + 128 > reserve:
        raise ModelInvocationError(
            "Finite R1 thinking budget and final allowance required"
        )
    params.update(_sampling(top_k, min_p, presence_penalty, repeat_penalty, seed))
    request = {
        **params,
        "model": ALIAS,
        "messages": source
        + [{"role": "assistant", "content": "", "reasoning_content": "\n"}],
        "add_generation_prompt": False,
        "continue_final_message": "reasoning_content",
        "chat_template_kwargs": {"enable_thinking": True},
        "reasoning_format": "deepseek",
        "reasoning_budget_tokens": budget,
        "reasoning_budget_message": "",
        "max_tokens": reserve,
        "stream": False,
        "cache_prompt": False,
        "verbose": True,
        "response_fields": list(_VERBOSE_FIELDS),
    }
    if schema is not None:
        # Native CHAT applies its schema grammar to final content after reasoning.
        request["json_schema"] = schema
    request_bytes = json.dumps(request, ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )
    if len(request_bytes) > MAX_REQUEST_BYTES:
        raise ContextBudgetError("Complete R1 request exceeds the transport budget")
    admission = {
        "profile": PROFILE_ID,
        "model_sha256": MODEL_SHA256,
        "template_sha256": TEMPLATE_SHA256,
        "startup_sha256": STARTUP_SHA256,
        "source_messages": [
            {
                "utf8_bytes": len(item["content"].encode("utf-8")),
                "sha256": hashlib.sha256(item["content"].encode("utf-8")).hexdigest(),
            }
            for item in source
        ],
        "request_utf8_bytes": len(request_bytes),
        "request_sha256": hashlib.sha256(request_bytes).hexdigest(),
        "thinking_budget_tokens": budget,
        "max_tokens": reserve,
    }
    with adapter._lock:
        started = time.perf_counter()
        adapter.verify()
        _verified_native(adapter, profile)
        rendered = _field(adapter, "/apply-template", request, "prompt")
        expected = (
            "".join("<｜User｜>" + item["content"] for item in source)
            + OPEN_THINK_PREFIX
        )
        if type(rendered) is not str or rendered != expected:
            raise ModelInvocationError(
                "Pinned R1 complete native source and continuation required"
            )
        tokens = _field(
            adapter,
            "/tokenize",
            {
                "content": rendered,
                "add_special": True,
                "parse_special": True,
                "with_pieces": False,
            },
            "tokens",
        )
        if (
            not isinstance(tokens, list)
            or not tokens
            or any(
                type(token) is not int or not 0 <= token < VOCAB_SIZE
                for token in tokens
            )
            or tokens[0] != BOS_ID
            or tokens.count(BOS_ID) != 1
        ):
            raise CompletionResponseError(
                "R1 preflight requires valid tokens and exactly one BOS"
            )
        if len(tokens) + reserve + 2 > adapter.context_size:
            raise ContextBudgetError("Full R1 prompt and output reserve exceed context")
        canonical = _field(adapter, "/detokenize", {"tokens": tokens}, "content")
        if type(canonical) is not str or canonical != BOS + rendered:
            raise CompletionResponseError("R1 canonical full prompt differs")
        counted = _field(
            adapter, "/v1/chat/completions/input_tokens", request, "input_tokens"
        )
        if type(counted) is not int or counted != len(tokens):
            raise ContextBudgetError("R1 CHAT native token admission differs")
        admission.update(
            prompt_tokens=counted,
            canonical_utf8_bytes=len(canonical.encode("utf-8")),
            canonical_sha256=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        )
        payload = adapter._request("POST", "/v1/chat/completions", request)
        if not isinstance(payload, dict):
            raise CompletionResponseError("Invalid R1 CHAT completion object")
        try:
            result = _response(
                payload,
                ALIAS,
                canonical,
                len(tokens),
                reserve,
                time.perf_counter() - started,
            )
        except CompletionLimitError as error:
            # Retain the failure and quantitative evidence without exposing CoT.
            error.diagnostic = {
                key: value
                for key, value in error.diagnostic.items()
                if key != "content"
            }
            error.diagnostic["admission"] = admission
            raise
        # Preserve the validated final channel verbatim; never parse reasoning tags.
        result["text"] = payload["choices"][0]["message"]["content"]
        result["admission"] = admission
        return result


def reasoning_plan_text(
    adapter,
    messages,
    max_new_tokens=768,
    temperature=0.6,
    top_p=0.95,
    *,
    profile,
    thinking_budget_tokens,
    top_k=None,
    min_p=None,
    presence_penalty=None,
    repeat_penalty=None,
    seed=None,
):
    """Return only completed final planning content; reasoning remains private."""
    return _invoke(
        adapter,
        messages,
        max_new_tokens,
        temperature,
        top_p,
        profile=profile,
        thinking_budget_tokens=thinking_budget_tokens,
        top_k=top_k,
        min_p=min_p,
        presence_penalty=presence_penalty,
        repeat_penalty=repeat_penalty,
        seed=seed,
    )


class R1SourcePlan:
    """Callable source-plan API with a fixed finite 512-token reasoning budget."""

    def __init__(self, adapter, profile, *, fold_system_to_user=False):
        verify_profile(profile)
        if type(fold_system_to_user) is not bool:
            raise ModelInvocationError("Explicit boolean role-folding opt-in required")
        self.adapter, self.profile = adapter, profile
        self.fold_system_to_user = fold_system_to_user

    def __call__(
        self,
        messages,
        *,
        response_format,
        max_new_tokens=1024,
        temperature=0.0,
        top_p=1.0,
        do_sample=False,
        require_context_budget=True,
        raise_on_truncation=True,
    ):
        if (
            require_context_budget is not True
            or raise_on_truncation is not True
            or type(do_sample) is not bool
        ):
            raise ModelInvocationError(
                "Strict source-plan admission and completion required"
            )
        if self.fold_system_to_user:
            messages = _fold_roles(messages)
        _parameters(self.adapter.defaults, max_new_tokens, temperature, top_p)
        if max_new_tokens > 1024:
            raise ModelInvocationError("Source-plan total output limit is 1024 tokens")
        schema_method = getattr(self.adapter, "_schema", None)
        if not callable(schema_method):
            raise ModelInvocationError(
                "Native strict JSON schema admission unavailable"
            )
        schema = schema_method(response_format, True)
        if (
            not isinstance(schema, dict)
            or schema.get("type") != "object"
            or schema.get("additionalProperties") is not False
            or not isinstance(schema.get("properties"), dict)
            or not schema["properties"]
            or not isinstance(schema.get("required"), list)
            or any(type(key) is not str for key in schema["required"])
            or set(schema["required"]) != set(schema["properties"])
            or len(schema["required"]) != len(schema["properties"])
        ):
            raise ModelInvocationError("Closed source-plan JSON schema required")
        return _invoke(
            self.adapter,
            messages,
            max_new_tokens,
            temperature if do_sample else 0.0,
            top_p,
            profile=self.profile,
            thinking_budget_tokens=512,
            schema=schema,
        )
