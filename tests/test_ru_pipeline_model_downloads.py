import hashlib
from io import BytesIO
from itertools import count
import json
from types import SimpleNamespace

import pytest

from backend.routes import note_pipeline_routes
from backend.ru_pipeline import model_downloads as downloads
from backend.ru_pipeline.config import PipelineConfig
from backend.ru_pipeline.pair_settings import DEFAULT_PAIRS, DEFAULT_STAGE_ENABLED, NewTags
from test_ru_pipeline_pair_settings import client_for, DEFAULT, status


def test_download_plan_reuses_shared_models_and_respects_stage_switches():
    config = PipelineConfig()
    defaults = downloads.selected_files(config, DEFAULT_PAIRS, DEFAULT_STAGE_ENABLED, NewTags())
    assert len(defaults) == len({file.target for file in defaults}) == 19
    assert {file.model for file in defaults} == {
        "Qwen2.5-3B", "Qwen3.5-4B", "mMARCO MiniLM CrossEncoder", "Tev1-0.8B",
    }
    flags = {**DEFAULT_STAGE_ENABLED, "tags": False}
    no_tags = downloads.selected_files(config, DEFAULT_PAIRS, flags, NewTags(enabled=True))
    assert {file.model for file in no_tags} == {file.model for file in defaults} - {"Tev1-0.8B"}
    with_experiment = downloads.selected_files(config, DEFAULT_PAIRS, DEFAULT_STAGE_ENABLED, NewTags(enabled=True))
    assert {file.model for file in with_experiment} - {file.model for file in defaults} == {
        "Qwen3-4B-Instruct-2507", "Qwen3-Reranker-0.6B",
    }
    assert downloads.selected_files(config, DEFAULT_PAIRS, dict.fromkeys(flags, False), NewTags(enabled=True)) == []


def model_file(tmp_path, name, data):
    return downloads.ModelFile(name, tmp_path / "models" / name, "https://huggingface.co/model",
                               len(data), hashlib.sha256(data).hexdigest())


def test_settings_catalog_reports_downloads_for_both_roles(tmp_path, monkeypatch):
    generator = model_file(tmp_path, "generator.gguf", b"gguf")
    ranker = model_file(tmp_path, "ranker.safetensors", b"ranker")
    tokenizer = model_file(tmp_path, "tokenizer.json", b"tokenizer")
    generator.target.parent.mkdir()
    generator.target.write_bytes(b"gguf")
    ranker.target.write_bytes(b"ranker")
    monkeypatch.setattr(downloads, "model_files", lambda _config, role, *_args:
                        [generator] if role == "generator" else [ranker, tokenizer])
    client = client_for(tmp_path)

    def components():
        return status(client)["catalog"][0]["components"]

    assert components()["generator"][0]["downloaded"] is True
    assert components()["reranker"][0]["downloaded"] is False
    tokenizer.target.write_bytes(b"tokenizer")
    assert components()["reranker"][0]["downloaded"] is True
    generator.target.write_bytes(b"partial")
    assert components()["generator"][0]["downloaded"] is False


def test_real_prepare_route_publishes_only_verified_files_and_can_retry(tmp_path, monkeypatch):
    existing = model_file(tmp_path, "present", b"ready")
    existing.target.parent.mkdir()
    existing.target.write_bytes(b"ready")
    missing = model_file(tmp_path, "new", b"weights")
    monkeypatch.setattr(note_pipeline_routes, "selected_files", lambda *args: [existing, missing])
    monkeypatch.setattr(downloads, "_open_source", lambda _url: BytesIO(b"corrupt"))
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    url = "/runtime/note-pipeline/prepare"
    assert client.post(url, json=DEFAULT, headers={"Origin": "null"}).status_code == 403
    response = client.post(url, json=DEFAULT, buffered=True)
    progress = [json.loads(line) for line in response.data.splitlines()]
    assert progress[0] == {"state": "downloading", "model": "new", "bytes": 0, "total": 7}
    assert progress[-1] == {"state": "error", "code": "integrity"}
    assert not missing.target.exists()
    assert list(missing.target.parent.iterdir()) == [existing.target]
    assert status(client)["configured"] is False

    monkeypatch.setattr(downloads, "_open_source", lambda _url: BytesIO(b"weights"))
    response = client.post(url, json=DEFAULT, buffered=True)
    assert response.mimetype == "application/x-ndjson"
    assert [json.loads(line) for line in response.data.splitlines()][-1] == {"state": "done"}
    assert missing.target.read_bytes() == b"weights"
    assert existing.target.read_bytes() == b"ready"
    assert client.post(url, json=DEFAULT, buffered=True).data.strip() == b'{"state": "done"}'
    assert status(client)["configured"] is False


def test_offline_only_requires_network_when_selected_files_are_missing(tmp_path):
    config = PipelineConfig(repo_root=tmp_path)
    missing = model_file(tmp_path, "new", b"x")
    with pytest.raises(downloads.DownloadError, match="disabled"):
        list(downloads.prepare_files(config, [missing], False))
    assert not missing.target.parent.exists()
    assert list(downloads.prepare_files(config, [], False)) == []


def test_closed_prepare_response_discards_partial_weights_and_can_retry(tmp_path, monkeypatch):
    class ChunkedSource(BytesIO):
        def read1(self, size):
            return super().read1(min(size, 2))

    cached = model_file(tmp_path, "cached", b"cached")
    cached.target.parent.mkdir()
    cached.target.write_bytes(b"cached")
    missing = model_file(tmp_path, "new", b"weights")
    monkeypatch.setattr(downloads, "time", SimpleNamespace(monotonic=lambda: next(clock)))
    clock = count()
    monkeypatch.setattr(downloads, "_open_source", lambda url: ChunkedSource(b"weights"))
    monkeypatch.setattr(note_pipeline_routes, "selected_files", lambda *args: [cached, missing])
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    endpoint = "/runtime/note-pipeline/prepare"

    response = client.post(endpoint, json=DEFAULT, buffered=False)
    progress = iter(response.response)
    assert json.loads(next(progress))["bytes"] == 0
    assert json.loads(next(progress))["bytes"] == 2
    assert list(missing.target.parent.glob(".noda-download-*"))
    response.close()
    assert list(missing.target.parent.iterdir()) == [cached.target]

    result = client.post(endpoint, json=DEFAULT, buffered=True)
    assert json.loads(result.data.splitlines()[-1]) == {"state": "done"}
    assert missing.target.read_bytes() == b"weights"


@pytest.mark.parametrize("url", [
    "http://huggingface.co/file", "https://huggingface.co.attacker.invalid/file",
    "https://localhost/file", "https://cas-bridge.xethub.hf.co:444/file",
])
def test_download_does_not_follow_untrusted_destinations(url):
    with pytest.raises(downloads.DownloadError, match="network"):
        downloads._open_source(url)
