"""Note-stage preferences use an isolated file and a local-only HTTP route."""

import ast
import json
from pathlib import Path
from types import SimpleNamespace

from flask import Flask
import pytest

from backend.routes.model_routes import register_model_routes
from backend.ru_pipeline import config
from backend.ru_pipeline.config import PipelineConfig
from backend.ru_pipeline.pair_settings import MAX_SELECTION_BYTES


URL = "/runtime/note-pipeline"
DEFAULT = {
    "title": "qwen25_3b_mmarco",
    "tags": "qwen35_4b_tev",
    "links": "qwen35_4b_mmarco",
}
CUSTOM = {
    "title": "qwen35_4b_mmarco",
    "tags": "qwen25_3b_mmarco",
    "links": "qwen25_3b_mmarco",
}


def client_for(folder, *, enabled=True, **overrides):
    runtime = SimpleNamespace(
        RU_NOTE_PIPELINE_ENABLED=enabled,
        RAG_RUNTIME_PROVIDER="local",
        RAG_LOCAL_MODEL_ID="local-chat-notes-separate",
        RAG_LOCAL_MODEL_CACHE=str(folder),
        ru_pipeline_config=PipelineConfig(repo_root=folder, runtime_dir=folder),
        _make_json_safe=lambda payload: payload,
    )
    vars(runtime).update(overrides)
    app = Flask(__name__)
    register_model_routes(app, SimpleNamespace(module=runtime))
    return app.test_client()


def status(client):
    response = client.get("/runtime/config")
    assert response.status_code == 200
    return response.get_json()["note_pipeline"]


def test_defaults_recommend_actual_pairs_and_write_only_on_confirmation(tmp_path):
    folder = tmp_path / "unused"
    profile = status(client_for(folder))
    assert profile["selection"] == DEFAULT
    assert profile["stageEnabled"] == dict.fromkeys(DEFAULT, True)
    assert profile["configured"] is False
    assert {item["id"]: item["recommendedId"] for item in profile["catalog"]} == DEFAULT
    for item in profile["catalog"]:
        assert len(item["options"]) == (6 if item["id"] == "tags" else 4)
        assert item["options"][0]["id"] == item["recommendedId"]
        assert item["options"][0]["experimental"] is False
        assert all(option["languages"] == ["ru", "en"] for option in item["options"])
        assert {
            option["id"] for option in item["options"] if option["experimental"]
        } == {
            "qwen25_3b_qwen",
            "qwen35_4b_qwen",
        }
    assert not folder.exists()


def test_preferences_persist_across_runtime_instances_without_legacy_update(tmp_path):
    client = client_for(tmp_path)
    result = client.post(URL, json=CUSTOM)
    assert result.status_code == 200
    payload = result.get_json()
    assert payload["ok"] is True
    assert payload["runtime"]["runtime_model_id"] == "local-chat-notes-separate"
    profile = status(client_for(tmp_path))
    assert profile["selection"] == CUSTOM
    assert profile["configured"] is True
    assert [stage["generator"] for stage in profile["stages"]] == [
        "Qwen3.5-4B",
        "Qwen2.5-3B",
        "Qwen2.5-3B",
    ]
    assert [stage["reranker"] for stage in profile["stages"]] == [
        "mMARCO MiniLM CrossEncoder",
    ] * 3
    assert client.post(URL, json=DEFAULT).status_code == 200
    assert status(client_for(tmp_path))["selection"] == DEFAULT


def test_experimental_new_tags_are_opt_in_and_survive_startup_writes(tmp_path):
    client = client_for(tmp_path)
    defaults = status(client)["newTags"]
    assert defaults["enabled"] is False
    assert defaults["pairId"] == defaults["recommendedId"] == "qwen3_4b_instruct_qwen"
    assert [pair["id"] for pair in defaults["options"]] == [
        "qwen3_4b_instruct_qwen", "qwen3_4b_instruct_mmarco",
    ]
    selection = {"enabled": True, "pairId": "qwen3_4b_instruct_mmarco"}
    assert client.post(URL, json={**CUSTOM, "newTags": selection}).status_code == 200
    assert client.post(URL, json=DEFAULT).status_code == 200
    saved = status(client_for(tmp_path))
    assert saved["tag_policy"] == "existing_then_create"
    assert saved["newTags"] == {**defaults, **selection}
    assert client.post(URL, json={**DEFAULT, "newTags": {**selection, "enabled": False}}).status_code == 200
    assert status(client)["newTags"] == {**defaults, **selection, "enabled": False}


def test_stage_switches_persist_and_compose_with_pair_only_saves(tmp_path):
    client = client_for(tmp_path)
    flags = {"title": False, "tags": False, "links": True}
    experimental = {"enabled": True, "pairId": "qwen3_4b_instruct_qwen"}
    assert client.post(URL, json={**CUSTOM, "stageEnabled": flags, "newTags": experimental}).status_code == 200
    assert client.post(URL, json=DEFAULT).status_code == 200
    saved = status(client_for(tmp_path))
    assert saved["selection"] == DEFAULT and saved["stageEnabled"] == flags
    assert saved["tag_policy"] == "disabled" and saved["newTags"]["enabled"] is True
    assert client.post(URL, json={**DEFAULT, "stageEnabled": {**flags, "tags": True}}).status_code == 200
    assert status(client)["tag_policy"] == "existing_then_create"


@pytest.mark.parametrize("flags", [
    None, {"title": False, "tags": False},
    {"title": "false", "tags": True, "links": True},
    {"title": True, "tags": True, "links": True, "save": False},
])
def test_invalid_stage_switches_leave_existing_preferences_intact(tmp_path, flags):
    client = client_for(tmp_path)
    saved = dict.fromkeys(DEFAULT, False)
    assert client.post(URL, json={**DEFAULT, "stageEnabled": saved}).status_code == 200
    assert client.post(URL, json={**CUSTOM, "stageEnabled": flags}).status_code == 400
    assert status(client)["stageEnabled"] == saved


@pytest.mark.parametrize("new_tags", [
    {"enabled": "false", "pairId": "qwen3_4b_instruct_qwen"},
    {"enabled": True, "pairId": "qwen35_4b_qwen"},
    {"enabled": True},
    None,
])
def test_invalid_experiment_options_cannot_enable_it(tmp_path, new_tags):
    client = client_for(tmp_path)
    assert client.post(URL, json={**DEFAULT, "newTags": new_tags}).status_code == 400
    assert status(client)["newTags"]["enabled"] is False


def test_model_catalog_runtime_preserves_structured_pair_options(tmp_path):
    path = config.ROOT / "backend/runtime_layers/07_extract_summary_candidate.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    sanitizer = next(
        node for node in tree.body if getattr(node, "name", None) == "_make_json_safe"
    )
    scope = {"json": json}
    exec(
        compile(ast.Module(body=[sanitizer], type_ignores=[]), str(path), "exec"), scope
    )
    client = client_for(tmp_path, _make_json_safe=scope["_make_json_safe"])
    response = client.get("/models/catalog")
    assert response.status_code == 200
    assert (
        response.json["runtime"]["note_pipeline"]["catalog"]
        == status(client)["catalog"]
    )
    selection = {stage: "qwen25_3b_qwen" for stage in CUSTOM}
    saved = client.post(URL, json=selection)
    assert saved.status_code == 200
    catalog = saved.json["runtime"]["note_pipeline"]["catalog"]
    assert catalog == status(client)["catalog"]
    assert catalog[0]["options"][0]["languages"] == ["ru", "en"]
    assert saved.json["runtime"]["note_pipeline"]["selection"] == selection


def test_pair_preferences_do_not_depend_on_optional_tag_descriptions(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.setenv("NODA_RU_TAG_DESCRIPTIONS", str(tmp_path / "missing.json"))
    client = client_for(tmp_path, ru_pipeline_config=None)
    assert "configurationError" not in status(client)
    assert client.post(URL, json=CUSTOM).status_code == 200
    assert status(client)["selection"] == CUSTOM


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"title": CUSTOM["title"]},
        {**CUSTOM, "provider": "local"},
        {**CUSTOM, "links": "qwen35_4b_tev"},
        {**CUSTOM, "title": "../../elsewhere"},
        {**CUSTOM, "tags": [CUSTOM["tags"]]},
        {**CUSTOM, "tags": None},
    ],
)
def test_unsupported_or_partial_selection_preserves_saved_pairs(tmp_path, payload):
    client = client_for(tmp_path)
    assert client.post(URL, json=DEFAULT).status_code == 200
    response = client.post(URL, json=payload)
    assert response.status_code == 400
    assert response.json["code"] == "invalid_note_pipeline_selection"
    assert status(client)["selection"] == DEFAULT


@pytest.mark.parametrize(
    ("body", "content_type", "code"),
    [
        (b"{", "application/json", 400),
        (b'{"title":1,"title":2}', "application/json", 400),
        (b"{}", "text/plain", 400),
        (b" " * (MAX_SELECTION_BYTES + 1), "application/json", 413),
    ],
)
def test_rejects_invalid_payload_transport(tmp_path, body, content_type, code):
    response = client_for(tmp_path).post(URL, data=body, content_type=content_type)
    assert response.status_code == code
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    ("headers", "environ"),
    [
        ({"Origin": "https://example.invalid"}, {}),
        ({"Origin": "null"}, {}),
        ({"Origin": "http://localhost:8080"}, {}),
        ({"Referer": "http://localhost:8080/app"}, {}),
        ({"Sec-Fetch-Site": "same-origin"}, {}),
        ({}, {"REMOTE_ADDR": "192.0.2.2"}),
        ({"Host": "example.invalid"}, {}),
    ],
)
def test_browser_origin_and_loopback_checks_apply_to_writes(tmp_path, headers, environ):
    response = client_for(tmp_path).post(
        URL, json=CUSTOM, headers=headers, environ_overrides=environ
    )
    assert response.status_code == 403
    assert list(tmp_path.iterdir()) == []


def test_disabled_pipeline_cannot_be_changed(tmp_path):
    client = client_for(tmp_path, enabled=False)
    assert client.post(URL, json=CUSTOM).status_code == 409
    assert list(tmp_path.iterdir()) == []


def test_owned_profile_cannot_change_regular_note_preferences(tmp_path, monkeypatch):
    monkeypatch.setenv("NODA_OWNED_TITLE_PROFILE", "qwen35")
    response = client_for(tmp_path).post(URL, json=CUSTOM)
    assert response.status_code == 409
    assert response.json["code"] == "note_pipeline_selection_locked"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("contents", ["{}", " " * (MAX_SELECTION_BYTES + 1)])
def test_corrupt_config_is_visible_and_can_be_replaced(tmp_path, contents):
    path = tmp_path / "stage-pairs.json"
    path.write_text(contents, encoding="utf-8")
    client = client_for(tmp_path)
    assert status(client)["configurationError"] == "note_pipeline_selection_unreadable"
    assert path.read_text(encoding="utf-8") == contents
    assert client.post(URL, json=CUSTOM).status_code == 200
    profile = status(client)
    assert profile["selection"] == CUSTOM
    assert "configurationError" not in profile


def test_non_regular_selection_file_is_not_read_or_replaced(tmp_path):
    folder = tmp_path / "stage-pairs.json"
    folder.mkdir()
    client = client_for(tmp_path)
    assert status(client)["configurationError"] == "note_pipeline_selection_unreadable"
    assert client.post(URL, json=CUSTOM).status_code == 503
    assert folder.is_dir()


def test_failed_replace_preserves_existing_file_and_removes_temp_file(
    tmp_path, monkeypatch
):
    client = client_for(tmp_path)
    assert client.post(URL, json=DEFAULT).status_code == 200

    def fail_replace(self, target):
        raise OSError("Synthetic replace failure")

    monkeypatch.setattr(Path, "replace", fail_replace)
    response = client.post(URL, json=CUSTOM)
    assert response.status_code == 503
    assert response.json["code"] == "note_pipeline_selection_unavailable"
    assert status(client)["selection"] == DEFAULT
    assert [item.name for item in tmp_path.iterdir()] == ["stage-pairs.json"]
