"""Canonical read-only runtime choice using the actual note routing predicate."""

from types import SimpleNamespace
from unittest.mock import Mock

from flask import Flask
import pytest

from backend.routes.generation_routes import register_generation_routes
from backend.ru_pipeline.config import PROFILE_ID
from backend.ru_pipeline.routing import register_runtime_route


def runtime(enabled=True):
    def validate(source):
        if type(source) is not str or not source.strip() or len(source) > 4000:
            raise ValueError("Нужен непустой исходник не длиннее 4000 символов.")
        return source.strip()

    return SimpleNamespace(
        RU_NOTE_PIPELINE_ENABLED=enabled,
        _validate_prompt_text=Mock(side_effect=validate),
    )


def client_for(module, full_registration=False):
    app = Flask("runtime_policy_synthetic")
    deps = SimpleNamespace(module=module)
    if full_registration:
        register_generation_routes(app, deps)
    else:
        register_runtime_route(app, deps)
    return app.test_client()


@pytest.mark.parametrize(
    "source,mode,enabled,legacy",
    [
        ("Русская заметка", "organize", True, False),
        ("Русская заметка", "organize_edit", True, True),
        ("An English note", "organize", True, False),
        ("An English note", "organize_edit", True, True),
        ("Русская заметка", "organize", False, True),
        ("Русская заметка с `English code only`", "organize", True, False),
    ],
)
def test_policy_matches_source_and_mode_without_loading_or_saving(
    source, mode, enabled, legacy
):
    module = runtime(enabled)
    response = client_for(module).post(
        "/generate/runtime", json={"prompt": source, "mode": mode}
    )
    assert response.status_code == 200
    assert response.get_json() == {
        "requires_legacy_runtime": legacy,
        "profile": None if legacy else PROFILE_ID,
    }
    module._validate_prompt_text.assert_called_once_with(source)
    assert source not in response.get_data(as_text=True)


def test_real_generation_registration_adds_read_only_policy_without_other_dependencies():
    module = runtime()
    source = "\ufeff  Точный исходник\r\n\t  "
    response = client_for(module, full_registration=True).post(
        "/generate/runtime", json={"prompt": source}
    )
    assert response.status_code == 200
    assert response.get_json()["requires_legacy_runtime"] is False
    module._validate_prompt_text.assert_called_once_with(source)
    assert not hasattr(module, "local_rag_model") and not hasattr(
        module, "note_generation_queue"
    )


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"prompt": 5},
        {"prompt": ""},
        {"prompt": "   "},
        {"prompt": "x" * 4001},
        {"prompt": "Текст", "mode": "wrong"},
        {"prompt": "Текст", "mode": True},
        {"prompt": "Текст", "command": "ignored"},
    ],
)
def test_invalid_prompt_mode_or_shape_has_no_success_policy(payload):
    response = client_for(runtime()).post("/generate/runtime", json=payload)
    assert response.status_code == 400
    assert "requires_legacy_runtime" not in response.get_json()


@pytest.mark.parametrize(
    "body,mimetype,status",
    [
        ("invalid", "application/json", 400),
        ("{}", "text/plain", 400),
        (" " * 65537, "application/json", 413),
    ],
    ids=["malformed-json", "wrong-content-type", "oversized-body"],
)
def test_invalid_or_oversized_transport_is_rejected_before_source_validation(
    body, mimetype, status
):
    module = runtime()
    response = client_for(module).post(
        "/generate/runtime", data=body, content_type=mimetype
    )
    assert response.status_code == status
    module._validate_prompt_text.assert_not_called()


@pytest.mark.parametrize(
    "headers,environ",
    [
        ({"Origin": "https://example.invalid"}, {}),
        ({"Origin": "null"}, {}),
        ({"Sec-Fetch-Site": "cross-site"}, {}),
        ({}, {"REMOTE_ADDR": "192.0.2.4"}),
    ],
)
def test_foreign_origin_denied_before_parsing_or_private_note_access(headers, environ):
    module = runtime()
    response = client_for(module).post(
        "/generate/runtime",
        data="not JSON",
        content_type="application/json",
        headers=headers,
        environ_overrides=environ,
    )
    assert response.status_code == 403
    assert response.get_json() == {"error": "Forbidden origin"}
    module._validate_prompt_text.assert_not_called()


def test_invalid_trusted_runtime_flag_fails_closed_instead_of_picking_legacy():
    response = client_for(runtime("true")).post(
        "/generate/runtime", json={"prompt": "Точный исходник"}
    )
    assert response.status_code == 503
    assert "requires_legacy_runtime" not in response.get_json()
    assert "Точный исходник" not in response.get_data(as_text=True)


def test_registration_is_idempotent_and_other_methods_never_execute_policy():
    module = runtime()
    app = Flask("runtime_policy_repeat")
    deps = SimpleNamespace(module=module)
    register_runtime_route(app, deps)
    register_runtime_route(app, deps)
    assert app.test_client().get("/generate/runtime").status_code == 405
    module._validate_prompt_text.assert_not_called()
