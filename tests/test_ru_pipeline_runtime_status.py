"""Read-only selected-profile metadata without loading a model or the app."""

from types import SimpleNamespace

from flask import Flask
import pytest

from backend.note_runtime_status import note_runtime_status
from backend.routes.model_routes import register_model_routes
from backend.ru_pipeline.config import PipelineConfig, PROFILE_ID


@pytest.mark.parametrize("flag", [None, False, "true", 1])
def test_legacy_or_ambiguous_flags_do_not_override_runtime_status(flag):
    runtime = SimpleNamespace()
    if flag is not None:
        runtime.RU_NOTE_PIPELINE_ENABLED = flag
    result = note_runtime_status(runtime, "local")
    assert "note_pipeline" not in result
    assert result["note_title_method"]["name"] == "reviewed"


@pytest.mark.parametrize("provider", ["local", "vllm_local", "llama_cpp_server"])
def test_enabled_profile_reports_all_selected_stages_without_loaded_claim(
    tmp_path, provider
):
    result = note_runtime_status(
        SimpleNamespace(
            RU_NOTE_PIPELINE_ENABLED=True,
            ru_pipeline_config=PipelineConfig(repo_root=tmp_path),
        ),
        provider,
    )
    profile = result["note_pipeline"]
    assert profile["profile"] == PROFILE_ID
    assert profile["enabled"] is True
    assert profile["language"] == "ru"
    assert profile["supported_languages"] == ["ru", "en"]
    assert profile["generated_alphabet_policy"] == "ru-en-only-v1"
    assert profile["model_lifecycle"] == "per_stage"
    assert profile["tag_policy"] == "existing_only"
    assert profile["source_immutable"] is True
    assert [(stage["generator"], stage["reranker"]) for stage in profile["stages"]] == [
        ("Qwen2.5-3B", "mMARCO MiniLM CrossEncoder"),
        ("Qwen3.5-4B", "Tev1-0.8B"),
        ("Qwen3.5-4B", "mMARCO MiniLM CrossEncoder"),
    ]
    assert "loaded" not in profile and "ready" not in profile
    assert ("llama_cpp_server" in result) == (provider == "llama_cpp_server")


def test_runtime_config_exposes_profile_without_model_load(tmp_path):
    runtime = SimpleNamespace(
        RU_NOTE_PIPELINE_ENABLED=True,
        ru_pipeline_config=PipelineConfig(repo_root=tmp_path),
        RAG_RUNTIME_PROVIDER="local",
        RAG_LOCAL_MODEL_FORMAT="llama_cpp",
        RAG_LOCAL_MODEL_ID="synthetic-legacy-chat-model",
        _make_json_safe=lambda value: value,
    )
    app = Flask("ru_pipeline_status_only")
    register_model_routes(app, SimpleNamespace(module=runtime))
    response = app.test_client().get("/runtime/config")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["provider"] == "local"
    assert payload["runtime_model_id"] == "synthetic-legacy-chat-model"
    assert payload["note_pipeline"]["profile"] == PROFILE_ID
    assert "filepath" not in str(payload["note_pipeline"])
