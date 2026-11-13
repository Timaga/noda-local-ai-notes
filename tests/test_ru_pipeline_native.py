"""Native client wiring through the real invocation boundary; no model loads."""

from types import SimpleNamespace

import pytest

from backend.inference_runner import ContextBudgetError, ModelInvocationError
from backend.note_processing_failures import NoteSystemError
from backend.ru_pipeline import native


@pytest.fixture
def boundary(tmp_path):
    state = SimpleNamespace(events=[], error=None, force=False, verify_error=None)

    class Server:
        def __init__(self, key, config):
            state.key = key
            self.profile = SimpleNamespace(model=tmp_path / "selected.gguf", context=8192)
            self.process = object()
            self.cleanup = None

        def __enter__(self):
            state.events.append("server_start")
            return "http://127.0.0.1:19189"

        def assert_active(self):
            state.events.append("active_check")

        def close(self):
            state.events.append("server_close")
            self.cleanup = {
                "exit_code": 0,
                "ctrl_c_sent": True,
                "forced": state.force,
                "errors": [],
                "owned_process_retired": True,
            }
            return self.cleanup

    class Runner(native.SeededRunner):
        def __init__(self, url, path, context, defaults, **kwargs):
            assert context == 8192 and kwargs["timeout_seconds"] == 120
            state.defaults = defaults

        def verify(self):
            if state.verify_error:
                raise state.verify_error

        def __call__(self, prompt, **kwargs):
            state.prompt, state.parameters = prompt, kwargs
            if state.error:
                raise state.error
            return [
                {
                    "generated_text": '{"title":"Проверка датчика"}',
                    "finish_reason": "stop",
                    "usage": {"prompt_tokens": 12, "completion_tokens": 6},
                }
            ]

        def close(self):
            state.events.append("client_close")

    state.make = lambda: native.NativeSession(
        "qwen25_3b",
        SimpleNamespace(native_request_timeout=120),
        server_factory=Server,
        runner_factory=Runner,
    )
    return state


def test_full_unicode_source_and_seed_flow_with_normal_close(boundary):
    source = "\ufeff  Полный русский исходник\r\n```x```\r\nХвост  "
    messages = [{"role": "user", "content": source}]
    provider = boundary.make()
    with provider:
        result = provider.invoke(
            messages,
            seed=1337,
            max_new_tokens=256,
            do_sample=False,
            require_context_budget=True,
        )
        assert result == '{"title":"Проверка датчика"}'
        assert boundary.prompt == messages
        assert boundary.prompt[0]["content"] == source
        assert boundary.parameters["_require_context_budget"] is True
        assert boundary.parameters["max_new_tokens"] == 256
        assert provider.calls[0]["input_sha256"]
        assert source not in str(provider.calls)
    assert boundary.events[-2:] == ["client_close", "server_close"]


def test_context_overflow_preserved_for_precompletion_batch_split(boundary):
    boundary.error = ContextBudgetError("Synthetic full prompt over budget")
    with boundary.make() as provider:
        with pytest.raises(ContextBudgetError):
            provider.invoke(
                [{"role": "user", "content": "Исходник"}], require_context_budget=True
            )


def test_transport_failure_is_system_error_not_empty_response(boundary):
    boundary.error = ModelInvocationError("Synthetic unavailable provider")
    with boundary.make() as provider:
        with pytest.raises(NoteSystemError) as caught:
            provider.invoke(
                [{"role": "user", "content": "Исходник"}], require_context_budget=True
            )
    assert caught.value.failure_code == "ru_native_inference_failed"


def test_forced_shutdown_blocks_success(boundary):
    boundary.force = True
    with pytest.raises(NoteSystemError) as caught:
        with boundary.make() as provider:
            provider.invoke([{"role": "user", "content": "Текст"}])
    assert caught.value.failure_code == "ru_native_shutdown_failed"


def test_startup_verify_failure_closes_owned_child(boundary):
    boundary.verify_error = ValueError("Synthetic wrong native model identity")
    with pytest.raises(NoteSystemError) as caught:
        boundary.make().__enter__()
    assert caught.value.failure_code == "ru_native_startup_failed"
    assert boundary.events[-2:] == ["client_close", "server_close"]


def test_interrupt_during_verify_still_closes_owned_child(boundary):
    boundary.verify_error = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        boundary.make().__enter__()
    assert boundary.events[-2:] == ["client_close", "server_close"]


def test_invalid_model_metadata_is_typed_before_launch():
    def refuse(*args):
        raise ValueError("Synthetic invalid model key")

    provider = native.NativeSession("foreign", SimpleNamespace(), server_factory=refuse)
    with pytest.raises(NoteSystemError) as caught:
        provider.__enter__()
    assert caught.value.failure_code == "ru_native_startup_failed"


@pytest.mark.parametrize("seed", [True, 1, "1337"])
def test_unselected_seed_refused(boundary, seed):
    with boundary.make() as provider:
        with pytest.raises(NoteSystemError):
            provider.invoke([{"role": "user", "content": "Текст"}], seed=seed)


def test_closed_and_reused_context_refused(boundary):
    provider = boundary.make()
    with provider:
        pass
    with pytest.raises(NoteSystemError):
        provider.invoke([{"role": "user", "content": "Текст"}])
    with pytest.raises(NoteSystemError):
        provider.__enter__()


def test_source_mutation_detected(boundary, monkeypatch):
    def mutate(owner, messages, **kwargs):
        messages[0]["content"] = "Подменённый текст"
        return '{"title":"Подмена"}'

    monkeypatch.setattr(native, "invoke_pipeline", mutate)
    with boundary.make() as provider:
        with pytest.raises(NoteSystemError):
            provider.invoke([{"role": "user", "content": "Исходный текст"}])


def test_fixed_native_seed_is_injected_without_mutating_request(monkeypatch):
    monkeypatch.setattr(
        native.LlamaCppServerRunner,
        "_request",
        lambda self, method, endpoint, payload=None: payload,
    )
    runner = object.__new__(native.SeededRunner)
    payload = {"prompt": [1, 2], "seed": 4}
    result = runner._request("POST", "/completion", payload)
    assert result["seed"] == 1337 and payload["seed"] == 4
    assert runner._request("GET", "/props") is None
