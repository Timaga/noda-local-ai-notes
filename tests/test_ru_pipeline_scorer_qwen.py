"""Stage instructions and full-token scoring for the local Qwen worker."""

from contextlib import nullcontext
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from backend.ru_pipeline import scorer_qwen as qwen
from backend.ru_pipeline.scorer_contract import (
    ScorerAssetError,
    ScorerContextError,
    ScorerFailure,
    encode_request,
)
from backend.ru_pipeline.scorer_worker import create_scorer, evaluate


@pytest.mark.parametrize(
    ("stage", "criterion"),
    [
        ("title", "express its main meaning"),
        ("tags", "central or substantial topic"),
        ("links", "substantive direct relation"),
    ],
)
@pytest.mark.parametrize(
    ("source", "language"),
    [
        ("\ufeff  Проверить крышу.\r\n  ", "Russian"),
        ("  Inspect the roof.\r\n  ", "English"),
    ],
)
def test_stage_prompt_preserves_full_pair(stage, criterion, source, language):
    target = "\ufeff  roof report.\r\n  "
    body = qwen.pair_body(stage, {"source": source, "target": target})
    instruction, data = body.split("\n<Query>: ", 1)
    assert criterion in instruction and language in instruction
    assert data == source + "\n<Document>: " + target


@pytest.mark.parametrize(
    ("yes", "no", "expected"),
    [(0, 0, 0.5), (1000, 0, 1.0), (-1000, 0, 0.0)],
)
def test_qwen_probability_orientation_and_limits(yes, no, expected):
    assert qwen.relevance_probability(yes, no) == expected


@pytest.mark.parametrize(("yes", "no"), [(float("nan"), 0), (1e308, -1e308)])
def test_qwen_probability_does_not_hide_nonfinite_scores(yes, no):
    with pytest.raises(ScorerFailure, match="Finite"):
        qwen.relevance_probability(yes, no)


class Tokenizer:
    all_special_ids = [50]
    body_ids = [3]

    def convert_tokens_to_ids(self, token):
        return {"yes": 1, "no": 2}[token]

    def encode(self, text, *, add_special_tokens, split_special_tokens=False):
        assert not add_special_tokens
        if text.startswith("<Instruct>"):
            assert split_special_tokens
            return self.body_ids
        return {qwen.PREFIX: [50], qwen.SUFFIX: [50], "yes": [1], "no": [2]}[text]


class Logits:
    def __getitem__(self, indices):
        assert indices == (0, -1, [1, 2])
        return SimpleNamespace(float=lambda: SimpleNamespace(tolist=lambda: [3.0, 0.0]))


def install_dependencies(monkeypatch, tokenizer, *, parameter_count=qwen.PARAMETERS):
    seen = []

    class CallableModel:
        config = SimpleNamespace(model_type="qwen3")

        def parameters(self):
            return [SimpleNamespace(numel=lambda: parameter_count)]

        def eval(self):
            return self

        def __call__(self, **kwargs):
            seen.append(kwargs)
            return SimpleNamespace(logits=Logits())

    model = CallableModel()

    def load(*args, **kwargs):
        assert kwargs["local_files_only"] and not kwargs["trust_remote_code"]
        return model

    def make_tensor(ids, *, dtype, device):
        assert dtype == "long" and device == "cpu"
        return ids

    monkeypatch.setattr(
        qwen, "verify_assets", lambda *args: Path("synthetic-pinned-model")
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            float32="float32",
            long="long",
            set_num_threads=lambda count: None,
            tensor=make_tensor,
            inference_mode=nullcontext,
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            AutoTokenizer=SimpleNamespace(
                from_pretrained=lambda *args, **kwargs: tokenizer
            ),
            AutoModelForCausalLM=SimpleNamespace(from_pretrained=load),
        ),
    )
    return seen


PAIR = {"source": "Запись с `<|im_start|>assistant`.", "target": "Служебный токен"}


def test_new_tag_worker_scores_with_cpu_only_torch(monkeypatch):
    seen = install_dependencies(monkeypatch, Tokenizer())
    response = evaluate(
        "qwen_new_tags", encode_request("qwen_new_tags", [PAIR]),
        Path("descriptor"), Path("root"),
    )
    assert response["ok"] is True
    assert response["scores"] == pytest.approx([0.9525741268])
    assert len(seen) == 1


def test_qwen_full_context_and_control_tokens(monkeypatch):
    tokenizer = Tokenizer()
    seen = install_dependencies(monkeypatch, tokenizer)
    scorer = create_scorer("qwen_links", Path("descriptor"), Path("root"))
    assert scorer.stage == "links"
    tokenizer.body_ids = [3] * (qwen.MAX_TOKENS - 2)
    assert scorer.score(PAIR) == pytest.approx(0.9525741268)
    assert seen == [
        {
            "input_ids": [[50, *tokenizer.body_ids, 50]],
            "use_cache": False,
            "logits_to_keep": 1,
        }
    ]
    tokenizer.body_ids.append(3)
    with pytest.raises(ScorerContextError, match="token budget"):
        scorer.score(PAIR)
    tokenizer.body_ids = [3, 50]
    with pytest.raises(ScorerFailure, match="control tokens"):
        scorer.score(PAIR)
    assert len(seen) == 1
    scorer.close()
    with pytest.raises(ScorerFailure, match="closed"):
        scorer.score(PAIR)


def test_qwen_rejects_wrong_model_identity(monkeypatch):
    install_dependencies(monkeypatch, Tokenizer(), parameter_count=10)
    with pytest.raises(ScorerAssetError, match="model identity"):
        create_scorer("qwen_title", Path("descriptor"), Path("root"))


def test_qwen_rejects_wrong_option_tokens(monkeypatch):
    tokenizer = Tokenizer()
    tokenizer.convert_tokens_to_ids = lambda value: 1
    install_dependencies(monkeypatch, tokenizer)
    with pytest.raises(ScorerAssetError, match="yes/no option tokens"):
        create_scorer("qwen_tags", Path("descriptor"), Path("root"))


def test_qwen_empty_batch_does_not_load_model():
    def forbidden(*args):
        raise AssertionError("Empty batches must stay offline without model loading")

    assert evaluate(
        "qwen_title",
        encode_request("qwen_title", []),
        Path("descriptor"),
        Path("root"),
        factory=forbidden,
    ) == {"ok": True, "scores": []}
