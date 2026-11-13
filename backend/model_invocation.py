"""Model invocation and explicit completion failures, independent of app bootstrap."""

try:
    from backend.inference_runner import (
        CompletionLimitError,
        CompletionResponseError,
        ContextBudgetError,
        ModelInvocationError,
        ModelUnavailableError,
    )
    from backend.inference_messages import chat_messages, transformer_prompt
except ImportError:
    from inference_runner import (
        CompletionLimitError,
        CompletionResponseError,
        ContextBudgetError,
        ModelInvocationError,
        ModelUnavailableError,
    )
    from inference_messages import chat_messages, transformer_prompt


def invoke_pipeline(
    self,
    prompt,
    max_new_tokens=None,
    temperature=None,
    top_p=None,
    do_sample=None,
    response_format=None,
    raise_on_truncation=False,
    model_ready_timeout=60,
    require_context_budget=False,
):
    timeout = model_ready_timeout
    if not self.is_fully_loaded:
        ready = self.load_model(wait_timeout=timeout, force_rebuild=not self._pipeline)
        if not ready or not self.is_fully_loaded:
            self._wait_for_loading(timeout)
            if not self.is_fully_loaded:
                state = "loading" if self._loading else "not loaded"
                if require_context_budget:
                    self.last_generation_error = "ModelUnavailableError"
                    raise ModelUnavailableError("Local model did not become ready")
                print(f"Local model is {state}; generation is unavailable.")
                return None
    if self._loading:
        if not self._wait_for_loading(timeout):
            if require_context_budget:
                self.last_generation_error = "ModelUnavailableError"
                raise ModelUnavailableError("Local model is still loading")
            print(
                "Local model is still loading; generation is temporarily unavailable."
            )
            return None
    if not self._pipeline:
        print("Local model is not initialized.")
        self.is_fully_loaded = False
        if require_context_budget:
            self.last_generation_error = "ModelUnavailableError"
            raise ModelUnavailableError("Local model has no initialized pipeline")
        return None
    try:
        generation_max_tokens = (
            self.max_new_tokens if max_new_tokens is None else max_new_tokens
        )
        generation_temperature = (
            self.temperature if temperature is None else temperature
        )
        generation_top_p = self.top_p if top_p is None else top_p
        generation_do_sample = True if do_sample is None else bool(do_sample)
        generation_params = {
            "max_new_tokens": generation_max_tokens,
            "temperature": generation_temperature,
            "top_p": generation_top_p,
            "do_sample": generation_do_sample,
        }
        server_mode = self.model_format == "llama_cpp_server"
        if response_format is not None and (
            self.model_format == "llama_cpp" or server_mode or self._is_vllm_mode()
        ):
            generation_params["response_format"] = response_format
        native_chat = self.model_format == "llama_cpp" or server_mode or self._is_vllm_mode()
        if require_context_budget:
            from backend.inference_llama_server import LlamaCppServerRunner

            verified_server = server_mode and isinstance(
                self._pipeline, LlamaCppServerRunner
            )
            if self.model_format != "llama_cpp" and not verified_server:
                raise ContextBudgetError(
                    "Exact token admission requires the local GGUF runtime"
                )
            generation_params["_require_context_budget"] = True
        pipeline_prompt = prompt
        if not isinstance(prompt, str):
            pipeline_prompt = (
                chat_messages(
                    prompt, max_chars=None if require_context_budget else 32000
                )
                if native_chat
                else transformer_prompt(self._pipeline, prompt)
            )
        outputs = self._pipeline(pipeline_prompt, **generation_params)
        if require_context_budget:
            if (
                not isinstance(outputs, list)
                or len(outputs) != 1
                or not isinstance(outputs[0], dict)
                or not isinstance(outputs[0].get("generated_text"), str)
                or not outputs[0]["generated_text"].strip()
            ):
                raise CompletionResponseError(
                    "Strict generation returned no completed text result"
                )
            reason = outputs[0].get("finish_reason")
            if reason == "length":
                raise CompletionLimitError(
                    "Model output was truncated by the token limit"
                )
            if reason != "stop":
                raise CompletionResponseError(
                    "Strict generation did not finish normally"
                )
        generated_text = ""
        if isinstance(outputs, list) and outputs:
            first = outputs[0]
            if isinstance(first, dict):
                generated_text = first.get("generated_text", "")
                self.last_generation = {
                    key: first.get(key)
                    for key in ("usage", "finish_reason", "elapsed_seconds")
                }
            else:
                generated_text = str(first)
        else:
            generated_text = str(outputs)
        if (
            generated_text
            and isinstance(pipeline_prompt, str)
            and pipeline_prompt
            and generated_text.startswith(pipeline_prompt)
        ):
            prompt_length = len(pipeline_prompt)
            generated_text = generated_text[prompt_length:]
        cleaned = generated_text.strip()
        if not cleaned:
            self.last_generation_error = "empty_completion"
        else:
            self.last_load_error = None
            self.last_generation_error = None
        return cleaned
    except Exception as exc:
        self.last_generation_error = type(exc).__name__
        if (
            isinstance(
                exc,
                (
                    TimeoutError,
                    ConnectionError,
                    OSError,
                    ContextBudgetError,
                    ModelInvocationError,
                ),
            )
            or (
                (raise_on_truncation or require_context_budget)
                and isinstance(exc, CompletionLimitError)
            )
            or (require_context_budget and isinstance(exc, CompletionResponseError))
        ):
            raise
        if require_context_budget:
            self.last_generation_error = "ModelInvocationError"
            raise ModelInvocationError(
                "Local inference failed before a completed response"
            ) from exc
        print("Local answer generation failed:", type(exc).__name__)
        return None
