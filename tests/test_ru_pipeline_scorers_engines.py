"""Pinned assets and real score preparation with fake external inference engines."""

from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from backend.ru_pipeline import scorer_assets as assets
from backend.ru_pipeline import scorer_mmarco as mmarco
from backend.ru_pipeline import scorer_tev as tev
from backend.ru_pipeline.scorer_contract import (
    ScorerAssetError,
    ScorerContextError,
    ScorerFailure,
)


PAIR = {
    "source": "\ufeff  Русский исходник\r\nхвост  ",
    "target": "метка: точное описание",
}


def synthetic_assets(tmp_path, monkeypatch, *, path_mutation=None):
    folder = tmp_path / "models/ru-note-mmarco-v1"
    folder.mkdir(parents=True)
    entries = []
    for index in range(6):
        name = f"file{index}.json"
        raw = str(index).encode()
        (folder / name).write_bytes(raw)
        entries.append(
            {"path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        )
    if path_mutation is not None:
        entries[0]["path"] = path_mutation
    manifest = {
        "engine": "mmarco",
        "repository": assets.IDENTITIES["mmarco"][0],
        "revision": assets.IDENTITIES["mmarco"][1],
        "model_root": "models/ru-note-mmarco-v1",
        "files": entries,
    }
    path = tmp_path / "descriptor.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setitem(
        assets.DESCRIPTOR_SHA256,
        "mmarco",
        hashlib.sha256(path.read_bytes()).hexdigest(),
    )
    return path, folder


def test_asset_admission_matches_all_exact_files(tmp_path, monkeypatch):
    descriptor, folder = synthetic_assets(tmp_path, monkeypatch)
    assert assets.verify_assets("mmarco", descriptor, tmp_path) == folder
    (folder / "file2.json").write_text("x", encoding="utf-8")
    with pytest.raises(ScorerAssetError, match="changed"):
        assets.verify_assets("mmarco", descriptor, tmp_path)


@pytest.mark.parametrize("relative", ["../outside", "/outside", "file1.json"])
def test_asset_paths_cannot_escape_or_duplicate(tmp_path, monkeypatch, relative):
    descriptor, _ = synthetic_assets(tmp_path, monkeypatch, path_mutation=relative)
    with pytest.raises(ScorerAssetError):
        assets.verify_assets("mmarco", descriptor, tmp_path)


def test_asset_symlink_and_descriptor_changes_are_rejected(tmp_path, monkeypatch):
    descriptor, folder = synthetic_assets(tmp_path, monkeypatch)
    original = Path.is_symlink
    monkeypatch.setattr(
        Path, "is_symlink", lambda self: self == folder / "file0.json" or original(self)
    )
    with pytest.raises(ScorerAssetError):
        assets.verify_assets("mmarco", descriptor, tmp_path)
    monkeypatch.setattr(Path, "is_symlink", original)
    descriptor.write_text("{}", encoding="utf-8")
    with pytest.raises(ScorerAssetError, match="descriptor changed"):
        assets.verify_assets("mmarco", descriptor, tmp_path)


class FakeTokenizer:
    tokens = 9
    truncated = None
    seen = []

    def no_truncation(self):
        self.truncated = False

    def encode(self, source, target):
        self.seen.append((source, target))
        return SimpleNamespace(ids=[4] * self.tokens, attention_mask=[1] * self.tokens)


class FakeSession:
    providers = ["CPUExecutionProvider"]
    output = [[2.75]]

    def __init__(self):
        self.calls = []

    def get_providers(self):
        return self.providers

    def get_inputs(self):
        return [SimpleNamespace(name=name) for name in ("input_ids", "attention_mask")]

    def get_outputs(self):
        return [SimpleNamespace(name="logits")]

    def run(self, names, inputs):
        self.calls.append((names, inputs))
        return [self.output]


def mmarco_fixture(monkeypatch, *, providers=None):
    tokenizer, session = FakeTokenizer(), FakeSession()
    tokenizer.seen = []
    if providers is not None:
        session.providers = providers
    options = SimpleNamespace()
    monkeypatch.setattr(
        mmarco, "verify_assets", lambda *args: Path("synthetic-local-model")
    )
    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        SimpleNamespace(
            SessionOptions=lambda: options,
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
            InferenceSession=lambda *args, **kwargs: session,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "tokenizers",
        SimpleNamespace(Tokenizer=SimpleNamespace(from_file=lambda *args: tokenizer)),
    )
    return tokenizer, session, options


def test_mmarco_prepares_exact_full_pair_and_raw_logit(monkeypatch):
    tokenizer, session, options = mmarco_fixture(monkeypatch)
    scorer = mmarco.MMarcoScorer(Path("unused"), Path("unused"))
    assert tokenizer.truncated is False
    assert scorer.score(PAIR) == 2.75
    assert tokenizer.seen == [(PAIR["source"], PAIR["target"])]
    assert session.calls[0][0] == ["logits"]
    assert session.calls[0][1]["input_ids"].dtype == np.int64
    assert options.intra_op_num_threads == 2 and options.inter_op_num_threads == 1
    tokenizer.tokens = 513
    with pytest.raises(ScorerContextError):
        scorer.score(PAIR)
    assert len(session.calls) == 1
    scorer.close()
    with pytest.raises(ScorerFailure, match="closed"):
        scorer.score(PAIR)


@pytest.mark.parametrize("value", [[[float("nan")]], [[1, 2]], []])
def test_mmarco_rejects_bad_native_output(monkeypatch, value):
    _, session, _ = mmarco_fixture(monkeypatch)
    session.output = value
    scorer = mmarco.MMarcoScorer(Path("unused"), Path("unused"))
    with pytest.raises(ScorerFailure):
        scorer.score(PAIR)


def test_mmarco_never_silently_changes_execution_provider(monkeypatch):
    mmarco_fixture(
        monkeypatch, providers=["AzureExecutionProvider", "CPUExecutionProvider"]
    )
    with pytest.raises(ScorerFailure, match="CPU-only"):
        mmarco.MMarcoScorer(Path("unused"), Path("unused"))


@pytest.mark.parametrize(
    "yes,no,expected", [(0, 0, 0.5), (1000, 0, 1.0), (-1000, 0, 0.0)]
)
def test_tev_binary_score_is_stable_and_correctly_oriented(yes, no, expected):
    assert tev.binary_score(yes, no, 10) == expected


@pytest.mark.parametrize(
    "yes,no,tokens",
    [
        (float("nan"), 0, 3),
        (1e308, -1e308, 3),
        (True, 0, 3),
        (0, 0, 2047),
        (0, 0, True),
    ],
)
def test_tev_nonfinite_or_oversize_input_is_not_a_low_score(yes, no, tokens):
    with pytest.raises(ScorerFailure):
        tev.binary_score(yes, no, tokens)


def test_tev_uses_exact_selected_tag_task_and_no_mapping_ids():
    prompt = tev.messages(PAIR)
    data = json.loads(prompt[1]["content"])
    assert data["state"] == {"note": PAIR["source"], "tag": PAIR["target"]}
    assert prompt[0] == {"role": "system", "content": tev.SYSTEM}
    assert data["question"] == tev.QUESTION
    assert data["question"].startswith(
        "Does this tag describe a central or substantial topic"
    )
    assert [row["label"] for row in data["options"]] == ["A", "B"]
    assert [row["key"] for row in data["options"]] == ["relevant", "not_relevant"]
    assert set(data["state"]) == {"note", "tag"}


class FakeTensor:
    def __init__(self, tokens):
        self.shape = (1, tokens)

    def to(self, device):
        return self


def tev_fixture(monkeypatch):
    calls = {"model": [], "template": [], "closed": 0, "load": []}
    tokenizer = SimpleNamespace(tokens=10, option_ids={"A": [32], "B": [33]})
    tokenizer.encode = lambda letter, **kwargs: tokenizer.option_ids[letter]

    def template(prompt, **kwargs):
        calls["template"].append((prompt, kwargs))
        return {
            "input_ids": FakeTensor(tokenizer.tokens),
            "attention_mask": FakeTensor(tokenizer.tokens),
        }

    tokenizer.apply_chat_template = template
    values = SimpleNamespace()
    values.float = values.cpu = lambda: values
    values.tolist = lambda: [2.0, 0.0]

    class Logits:
        def __getitem__(self, index):
            assert index == (0, -1, [32, 33])
            return values

    class Model:
        def to(self, device):
            return self

        def eval(self):
            pass

        def __call__(self, **kwargs):
            calls["model"].append(kwargs)
            return SimpleNamespace(logits=Logits())

    def load_model(*args, **kwargs):
        calls["load"].append(kwargs)
        return Model()

    def clear():
        calls["closed"] += 1

    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: True, empty_cache=clear),
        device=lambda name: SimpleNamespace(type="cuda"),
        bfloat16="bf16",
        inference_mode=nullcontext,
    )
    transformers = SimpleNamespace(
        AutoTokenizer=SimpleNamespace(
            from_pretrained=lambda *args, **kwargs: tokenizer
        ),
        AutoModelForImageTextToText=SimpleNamespace(from_pretrained=load_model),
    )
    monkeypatch.setattr(
        tev, "verify_assets", lambda *args: Path("synthetic-local-model")
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "transformers", transformers)
    return tokenizer, torch, calls


def test_tev_prepares_full_selected_prompt_before_native_forward(monkeypatch):
    tokenizer, _, calls = tev_fixture(monkeypatch)
    scorer = tev.TevScorer(Path("unused"), Path("unused"))
    assert scorer.score(PAIR) == pytest.approx(0.8807970779778823)
    assert calls["template"][0][0] == tev.messages(PAIR)
    assert calls["template"][0][1]["enable_thinking"] is False
    assert (
        calls["model"][0]["use_cache"] is False
        and calls["model"][0]["logits_to_keep"] == 1
    )
    assert calls["load"][0]["local_files_only"] is True
    assert (
        calls["load"][0]["trust_remote_code"] is False
        and calls["load"][0]["use_safetensors"] is True
    )
    tokenizer.tokens = 2047
    with pytest.raises(ScorerContextError):
        scorer.score(PAIR)
    assert len(calls["model"]) == 1
    scorer.close()
    assert calls["closed"] == 1
    with pytest.raises(ScorerFailure, match="closed"):
        scorer.score(PAIR)


def test_tev_unavailable_cuda_and_changed_option_ids_fail_closed(monkeypatch):
    tokenizer, torch, calls = tev_fixture(monkeypatch)
    torch.cuda.is_available = lambda: False
    with pytest.raises(ScorerFailure, match="CUDA"):
        tev.TevScorer(Path("unused"), Path("unused"))
    assert calls["load"] == []
    torch.cuda.is_available = lambda: True
    tokenizer.option_ids["A"] = [999]
    with pytest.raises(ScorerFailure, match="A/B"):
        tev.TevScorer(Path("unused"), Path("unused"))
    assert calls["load"] == []
