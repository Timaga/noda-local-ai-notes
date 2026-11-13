import hashlib
from io import BytesIO
import json
import struct

import pytest

from backend.ru_pipeline import model_downloads, model_import
from backend.ru_pipeline.imported_models import (
    Asset, ImportedModel, list_models, load_model, model_id, save_descriptor,
)
from backend.ru_pipeline.pair_settings import load_settings
from test_ru_pipeline_pair_settings import DEFAULT, client_for, status


URL = "/runtime/note-pipeline/import"
REPO = "Example/Chat-GGUF"
REV = "a" * 40
WEIGHTS = "chat-Q4_K_M.gguf"


def tiny_gguf(context=8192, dimensions=(10, 12)):
    def string(value):
        return struct.pack("<Q", len(value)) + value

    def metadata(key, kind, value):
        return string(key) + struct.pack("<I", kind) + value

    return b"".join((
        struct.pack("<4sIQQ", b"GGUF", 3, 1, 3),
        metadata(b"general.architecture", 8, string(b"qwen2")),
        metadata(b"qwen2.context_length", 4, struct.pack("<I", context)),
        metadata(b"tokenizer.chat_template", 8, string(b"{{ messages }}")),
        string(b"embedding"), struct.pack("<IQQIQ", 2, *dimensions, 0, 0), b"fixture",
    ))


def weight_entry(name, data):
    return {"rfilename": name, "size": len(data),
            "lfs": {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}}


def hf_generator(weights):
    return {"id": REPO, "sha": REV, "gguf": {"total": 120},
            "siblings": [weight_entry(WEIGHTS, weights)]}


def events(client, payload):
    response = client.post(URL, json=payload, buffered=True)
    assert response.status_code == 200
    assert response.mimetype == "application/x-ndjson"
    return [json.loads(line) for line in response.data.splitlines()]


@pytest.mark.parametrize("url", [
    "http://huggingface.co/Org/Repo", "https://huggingface.co.bad/Org/Repo",
    "https://localhost/Org/Repo", "https://guest@huggingface.co/Org/Repo",
    "https://huggingface.co:443/Org/Repo", "https://huggingface.co/Org/Repo/blob/main/%2e%2e/file",
    "https://huggingface.co/Org/Repo/blob/main/folder%2Ffile", "https://huggingface.co/datasets/Org/Repo",
])
def test_rejects_untrusted_link_before_any_download(tmp_path, monkeypatch, url):
    monkeypatch.setattr(model_import, "_metadata", lambda *args: pytest.fail("Unexpected network request"))
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    assert client.post(URL, json={"role": "generator", "url": url}).status_code == 400
    assert client.post("/runtime/note-pipeline/preview", json={"role": "generator", "url": url}).status_code == 400


def test_preview_reports_pending_size_without_downloading_and_pins_import(tmp_path, monkeypatch):
    payload = {"role": "generator", "url": f"https://huggingface.co/{REPO}"}
    weights = tiny_gguf()
    monkeypatch.setattr(model_import, "_metadata", lambda *args: hf_generator(weights))
    monkeypatch.setattr(model_downloads, "_open_source", lambda url: pytest.fail("Unexpected model download"))
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    endpoint = "/runtime/note-pipeline/preview"
    assert client.post(endpoint, json=payload, headers={"Origin": "null"}).status_code == 403
    preview = client.post(endpoint, json=payload)
    assert preview.status_code == 200
    result = preview.json
    assert result["download_bytes"] == len(weights)
    assert isinstance(result["disk_free_bytes"], int) and result["disk_free_bytes"] >= 0
    assert result["url"] == f"https://huggingface.co/{REPO}/resolve/{REV}/{WEIGHTS}?download=true"
    assert not list_models(tmp_path)

    expected_id = result["model"]["id"]
    assert client.post(URL, json={**payload, "id": expected_id}).status_code == 400
    pinned = {**payload, "url": result["url"], "id": expected_id}
    assert events(client, {**pinned, "id": "hfg_" + "0" * 16})[-1]["code"] == "import_changed"
    monkeypatch.setattr(model_downloads, "_open_source", lambda url: BytesIO(weights))
    monkeypatch.setattr(model_import, "_test_locally", lambda config, item: item)
    assert events(client, pinned)[-1]["model"]["id"] == expected_id
    assert client.post(endpoint, json=payload).json["download_bytes"] == 0


def test_import_progress_integrity_atomic_publication_and_persistent_selection(tmp_path, monkeypatch):
    payload = {"role": "generator", "url": f"https://huggingface.co/{REPO}"}
    weights = tiny_gguf()
    monkeypatch.setattr(model_import, "_metadata", lambda *args: hf_generator(weights))
    monkeypatch.setattr(model_downloads, "_open_source", lambda url: BytesIO(weights[:-1] + b"!"))
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    assert client.post(URL, json=payload, headers={"Origin": "null"}).status_code == 403
    assert client.post(URL, json={**payload, "role": "embedding"}).status_code == 400
    failed = events(client, payload)
    assert failed[-1] == {"state": "error", "code": "integrity"}
    assert list_models(tmp_path) == {}
    assert status(client)["selection"] == DEFAULT

    requests = []
    monkeypatch.setattr(model_downloads, "_open_source", lambda url: requests.append(url) or BytesIO(weights))
    def smoke(config, item):
        assert item.parameters == 120
        assert not list_models(config.runtime_dir)
        assert item.files[0].name == WEIGHTS
        return item
    monkeypatch.setattr(model_import, "_test_locally", smoke)
    imported = events(client, payload)
    assert [event["state"] for event in imported] == ["checking", "downloading", "downloading", "testing", "done"]
    assert imported[2]["bytes"] == imported[2]["total"] == len(weights)
    assert requests == [f"https://huggingface.co/{REPO}/resolve/{REV}/{WEIGHTS}?download=true"]
    item = imported[-1]["model"]
    assert item["imported"] is True
    again = events(client, payload)
    assert again == [{"state": "checking"}, {"state": "done", "model": item}]
    assert len(requests) == 1
    reopened = client_for(tmp_path)
    for stage in [*status(reopened)["catalog"], status(reopened)["newTags"]]:
        assert {**item, "downloaded": True} in stage["components"]["generator"]
        assert item not in stage["components"]["reranker"]
    assert status(reopened)["selection"] == DEFAULT
    assert reopened.post("/runtime/note-pipeline", json={
        **DEFAULT, "links": item["id"] + "_mmarco",
    }).status_code == 200
    assert load_settings(tmp_path)[0]["links"].generator == item["id"]


def test_unverified_or_wrong_role_models_cannot_be_selected(tmp_path, monkeypatch):
    weights = b"ABCD" + tiny_gguf()[4:]
    monkeypatch.setattr(model_import, "_metadata", lambda *args: hf_generator(weights))
    monkeypatch.setattr(model_downloads, "_open_source", lambda _url: BytesIO(weights))
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    payload = {"role": "generator", "url": f"https://huggingface.co/{REPO}"}
    assert events(client, payload)[-1] == {"state": "error", "code": "import_unsupported"}
    assert list_models(tmp_path) == {}
    fake_id = model_id("generator", REPO, REV, WEIGHTS)
    for pair in (fake_id + "_qwen", "qwen25_3b_" + fake_id):
        assert client.post("/runtime/note-pipeline", json={**DEFAULT, "title": pair}).status_code == 400


def test_custom_reranker_is_bound_to_its_stage_thresholds(tmp_path):
    names = ("config.json", "tokenizer.json", "tokenizer_config.json", "model.safetensors")
    repo = "Example/Qwen-Reranker"
    key = model_id("reranker", repo, REV, names[0])
    item = ImportedModel(key, "reranker", repo, REV, 595_776_512,
                         tuple(Asset(name, name, 1, "0" * 64) for name in names),
                         {"tags": 0.4, "new_tags": 0.6, "links": 0.7})
    save_descriptor(tmp_path, item)
    client = client_for(tmp_path)
    response = client.post("/runtime/note-pipeline", json={
        **DEFAULT, "tags": "qwen35_4b_" + key, "links": "qwen35_4b_" + key,
        "newTags": {"enabled": True, "pairId": "qwen3_4b_instruct_" + key},
    })
    assert response.status_code == 200
    stages, new_tags, _, _ = load_settings(tmp_path)
    assert stages["tags"].scorer_engine("tags") == "qwen_tags:" + key
    assert stages["tags"].threshold("tags", {}) == 0.4
    assert stages["links"].threshold("links", {}) == 0.7
    assert new_tags.pair.threshold("new_tags", {}) == 0.6


def test_large_generator_with_split_weights_and_shorter_context_can_be_selected(tmp_path, monkeypatch):
    weights = {f"large-Q4_K_M-0000{n}-of-00002.gguf": tiny_gguf(4096, (50_000, 100_000))
               for n in (1, 2)}
    metadata = {"id": REPO, "sha": REV, "siblings": [
        weight_entry(name, data) for name, data in weights.items()
    ]}
    monkeypatch.setattr(model_import, "_metadata", lambda *args: metadata)
    monkeypatch.setattr(model_downloads, "_open_source", lambda url: BytesIO(weights[url.split("/")[-1].split("?")[0]]))
    monkeypatch.setattr(model_import, "_test_locally", lambda config, item: item)
    client = client_for(tmp_path, _model_downloads_allowed=lambda: True)
    second = tuple(weights)[1]
    response = events(client, {"role": "generator", "url": f"https://huggingface.co/{REPO}/blob/main/{second}"})
    item = load_model(tmp_path, response[-1]["model"]["id"])
    assert (item.parameters, item.context) == (10_000_000_000, 4096)
    assert tuple(asset.name for asset in item.files) == tuple(weights)
    metadata["siblings"].pop(1)
    response = events(client, {"role": "generator", "url": f"https://huggingface.co/{REPO}"})
    assert response[-1] == {"state": "error", "code": "import_incomplete"}


def test_reranker_safetensors_shards_have_no_size_limit_and_index_cannot_read_other_files(tmp_path, monkeypatch):
    from backend.ru_pipeline.imported_scorer import validate_checkpoint
    from backend.ru_pipeline.scorer_contract import ScorerAssetError

    repo = "Example/Ranker-8B"
    index_name = "model.safetensors.index.json"
    shards = tuple(f"model-0000{n}-of-00002.safetensors" for n in (1, 2))
    data = {name: b"fixture" for name in ("config.json", "tokenizer.json", "tokenizer_config.json", *shards)}
    data[index_name] = json.dumps({"weight_map": {"a": "../outside.safetensors", "b": shards[1]}}).encode()
    rows = {name: weight_entry(name, contents) for name, contents in data.items()}
    for name in shards:
        rows[name]["size"] = rows[name]["lfs"]["size"] = 9_000_000_000
    metadata = {"id": repo, "sha": REV, "safetensors": {"total": 8_000_000_000},
                "siblings": list(rows.values())}
    monkeypatch.setattr(model_import, "_metadata", lambda *args: metadata)
    item = model_import.resolve_model(f"https://huggingface.co/{repo}", "reranker")
    assert item.parameters == 8_000_000_000
    assert [asset.size for asset in item.files[-2:]] == [9_000_000_000, 9_000_000_000]
    for name in shards:
        rows[name]["size"] = rows[name]["lfs"]["size"] = len(data[name])
    item = model_import.resolve_model(f"https://huggingface.co/{repo}", "reranker")
    item.folder(tmp_path).mkdir(parents=True)
    for name, contents in data.items():
        (item.folder(tmp_path) / name).write_bytes(contents)
    with pytest.raises(ScorerAssetError, match="does not match"):
        validate_checkpoint(item, tmp_path)
