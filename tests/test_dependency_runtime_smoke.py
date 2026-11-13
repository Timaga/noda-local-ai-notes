"""Exercise upgraded runtime libraries with local, synthetic data only."""

from types import SimpleNamespace

import pytest


def test_cpu_tensor_inference_and_safetensors_round_trip(tmp_path):
    import torch
    from safetensors.torch import load_file, save_file

    model = torch.nn.Linear(2, 2, bias=False).cpu().eval()
    with torch.no_grad():
        model.weight.copy_(torch.tensor([[2.0, 0.0], [0.0, 3.0]]))
    source = torch.tensor([[4.0, 5.0]], device="cpu")
    with torch.inference_mode():
        expected = model(source)
    assert expected.tolist() == [[8.0, 15.0]]
    checkpoint = tmp_path / "tiny.safetensors"
    save_file(model.state_dict(), checkpoint)
    restored = torch.nn.Linear(2, 2, bias=False).cpu().eval()
    restored.load_state_dict(load_file(checkpoint, device="cpu"))
    with torch.inference_mode():
        torch.testing.assert_close(restored(source), expected)


@pytest.mark.parametrize("remove_weight", [False, True])
def test_noda_loader_accepts_complete_local_transformer_weights(
    tmp_path, remove_weight
):
    import torch
    from safetensors.torch import load_file, save_file
    from transformers import BertConfig, BertForSequenceClassification

    from backend.ru_pipeline.imported_scorer import load_local_weights
    from backend.ru_pipeline.scorer_contract import ScorerAssetError

    config = BertConfig(
        vocab_size=16,
        hidden_size=8,
        intermediate_size=16,
        num_hidden_layers=1,
        num_attention_heads=2,
        max_position_embeddings=16,
        num_labels=2,
    )
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(123)
        model = BertForSequenceClassification(config).cpu().eval()
    model.save_pretrained(tmp_path, safe_serialization=True)
    checkpoint = tmp_path / "model.safetensors"
    if remove_weight:
        state = {name: tensor.clone() for name, tensor in load_file(checkpoint).items()}
        del state["classifier.weight"]
        save_file(state, checkpoint, metadata={"format": "pt"})
    item = SimpleNamespace(
        files=[SimpleNamespace(name=checkpoint.name, size=checkpoint.stat().st_size)]
    )
    if remove_weight:
        with pytest.raises(ScorerAssetError, match="trained weights"):
            load_local_weights(
                BertForSequenceClassification, tmp_path, item, torch, config
            )
        return
    restored = load_local_weights(
        BertForSequenceClassification, tmp_path, item, torch, config
    )
    inputs = {
        "input_ids": torch.tensor([[1, 2, 3]]),
        "attention_mask": torch.ones(1, 3),
    }
    with torch.inference_mode():
        torch.testing.assert_close(restored(**inputs).logits, model(**inputs).logits)


def test_dataset_mapping_and_arrow_storage_preserve_source(tmp_path):
    from datasets import Dataset, load_from_disk

    rows = [
        {"text": "First synthetic note"},
        {"text": "\u0417\u0430\u043c\u0435\u0442\u043a\u0430"},
    ]
    dataset = Dataset.from_list(rows)
    mapped = dataset.map(lambda row: {"length": len(row["text"])})
    destination = tmp_path / "dataset"
    mapped.save_to_disk(destination)
    restored = load_from_disk(destination)
    assert restored.to_list() == [{**row, "length": len(row["text"])} for row in rows]
    assert dataset.to_list() == rows


def test_filelock_rejects_competing_writer_and_releases(tmp_path):
    from filelock import FileLock, Timeout

    lock_path = tmp_path / "model-download.lock"
    first = FileLock(lock_path)
    second = FileLock(lock_path)
    with first:
        with pytest.raises(Timeout):
            second.acquire(timeout=0)
    with second.acquire(timeout=0):
        assert second.is_locked
    assert not second.is_locked


def test_fsspec_local_file_round_trip_and_missing_path(tmp_path):
    import fsspec

    path = tmp_path / "synthetic note.txt"
    text = "Unicode note: \u043f\u0440\u0438\u0432\u0435\u0442\n"
    with fsspec.open(str(path), "wt", encoding="utf-8") as stream:
        stream.write(text)
    with fsspec.open(str(path), "rt", encoding="utf-8") as stream:
        assert stream.read() == text
    with pytest.raises(FileNotFoundError):
        with fsspec.open(str(tmp_path / "missing.txt"), "rt"):
            pytest.fail("Missing files must not be treated as readable")


def test_fastapi_starlette_route_schema_without_network():
    from fastapi import FastAPI
    from pydantic import BaseModel, Field, ValidationError

    class Payload(BaseModel):
        count: int = Field(gt=0)

    application = FastAPI()

    @application.post("/synthetic")
    def endpoint(payload: Payload):
        return {"count": payload.count}

    schema = application.openapi()
    assert schema["paths"]["/synthetic"]["post"]["requestBody"]["required"] is True
    assert (
        schema["components"]["schemas"]["Payload"]["properties"]["count"][
            "exclusiveMinimum"
        ]
        == 0
    )
    assert endpoint(Payload(count=2)) == {"count": 2}
    with pytest.raises(ValidationError):
        Payload(count=0)
