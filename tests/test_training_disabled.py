"""Retired fine-tuning cannot create jobs, load models or publish fake artifacts."""

from types import SimpleNamespace

from flask import Flask
import pytest

from backend.routes.model_routes import register_model_routes
from backend.training_pipeline import TrainingDisabledError, TrainingPipeline


@pytest.fixture
def training_client(tmp_path):
    status = tmp_path / "status.json"
    status.write_text('{"status":"synthetic-old-success"}', encoding="utf-8")
    calls = []

    def forbidden_runner():
        calls.append("runner")
        raise AssertionError("Retired training must never be instantiated")

    app = Flask(__name__)
    runtime = SimpleNamespace(_get_training_runner=forbidden_runner, TRAINING_STATUS_PATH=status)
    register_model_routes(app, SimpleNamespace(module=runtime))
    return app.test_client(), calls, status


@pytest.mark.parametrize("payload", [{}, {"blocking": True}, {"dry_run": True}, {"reason": "scheduled"}])
def test_training_run_is_disabled_without_runner_or_file_writes(training_client, payload):
    client, calls, status = training_client
    before = status.read_bytes()
    response = client.post("/training/run", json=payload)
    assert response.status_code == 410
    assert response.get_json()["error"] == "training_disabled"
    assert response.get_json()["success"] is False
    assert calls == []
    assert status.read_bytes() == before


def test_malformed_training_input_cannot_reach_the_retired_pipeline(training_client):
    client, calls, _ = training_client
    response = client.post("/training/run", data="{malformed", content_type="application/json")
    assert response.status_code == 410
    assert response.get_json()["status"] == "disabled"
    assert calls == []


def test_training_status_does_not_report_old_success_or_read_artifact_files(training_client):
    client, calls, _ = training_client
    response = client.get("/training/status")
    assert response.status_code == 200
    assert response.get_json()["runtime"]["status"] == "disabled"
    assert response.get_json()["file"] == {}
    assert "synthetic-old-success" not in response.get_data(as_text=True)
    assert calls == []


def test_legacy_python_callers_cannot_train_or_export_a_placeholder(tmp_path):
    with pytest.raises(TrainingDisabledError, match="disabled"):
        TrainingPipeline(SimpleNamespace(artifacts_dir=tmp_path))
    with pytest.raises(TrainingDisabledError, match="disabled"):
        TrainingPipeline.run(object())
    assert list(tmp_path.iterdir()) == []


def test_project_activation_keeps_note_watching_without_scheduling_training(app_client, monkeypatch):
    import app as runtime

    calls = []

    def forbidden_runner():
        raise AssertionError("No training worker may start, including configured schedules")

    monkeypatch.setattr(runtime, "TRAINING_SCHEDULE_MINUTES", 1)
    monkeypatch.setattr(runtime, "TrainingPipeline", object(), raising=False)
    monkeypatch.setattr(runtime, "PipelineConfig", object(), raising=False)
    monkeypatch.setattr(runtime, "_get_training_runner", forbidden_runner, raising=False)
    monkeypatch.setattr(runtime, "_notes_observer", None)
    observer = object()
    monkeypatch.setattr(runtime, "start_file_watcher", lambda: calls.append("watch") or observer)
    runtime._activate_project_background()
    assert calls == ["watch"]
    assert runtime._notes_observer is observer
