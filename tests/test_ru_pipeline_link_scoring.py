"""Lossless long-link transport, full-query gate and explicit resource failures."""

from contextlib import contextmanager
from copy import deepcopy
import json
import re
from types import SimpleNamespace

import pytest

from backend.note_processing_failures import NoteSystemError
from backend.ru_pipeline.link_scoring import score_links, target_windows
from backend.ru_pipeline.link_stage import select_links
from backend.ru_pipeline.link_boundary_passages import boundary_passages
from backend.ru_pipeline import scorer_contract
from backend.ru_pipeline import link_scoring
from backend.ru_pipeline.config import PipelineConfig
from backend.ru_pipeline.services import LocalServices


class Tokenizer:
    def encode(self, source, target=None, *, add_special_tokens=True):
        count = (
            len(source)
            + (len(target) if target is not None else 0)
            + (3 if add_special_tokens else 0)
        )
        return SimpleNamespace(
            ids=list(range(count)),
            offsets=[(index, index + 1) for index in range(len(source))],
        )


class WordTokenizer:
    def encode(self, source, target=None, *, add_special_tokens=True):
        offsets = [
            (match.start(), match.end()) for match in re.finditer(r"\S+", source)
        ]
        count = (
            len(offsets)
            + (len(re.findall(r"\S+", target)) if target is not None else 0)
            + (3 if add_special_tokens else 0)
        )
        return SimpleNamespace(ids=list(range(count)), offsets=offsets)


def test_short_pairs_are_submitted_byte_for_byte_and_in_original_order():
    pairs = [
        {"source": "Полный запрос\r\n", "target": "  Короткий кандидат\t"},
        {"source": "query", "target": "target"},
    ]
    frozen, calls = deepcopy(pairs), []

    def score(engine, batch):
        calls.append((engine, deepcopy(batch)))
        return [1.25, -2.5]

    scores, diagnostics = score_links(score, pairs, None, tokenizer=Tokenizer())
    assert scores == [1.25, -2.5]
    assert calls == [("mmarco", frozen)] and pairs == frozen
    assert diagnostics == {
        "reranker_passage_count": 2,
        "reranker_windowed_pair_count": 0,
        "reranker_boundary_passage_count": 0,
    }


def test_all_overlapping_unicode_crlf_whitespace_spans_cover_the_exact_target():
    tokenizer, source = Tokenizer(), "Полный неизменённый запрос"
    target = (
        "  е\u0301ж\r\n\t🚲 Алфа  " * 90 + "Последний факт: готов вывод средств.   "
    )
    spans = list(target_windows(tokenizer, source, target))
    assert len(spans) > 2 and spans[0][0] == 0 and spans[-1][1] == len(target)
    end, reconstructed = 0, ""
    for start, stop in spans:
        assert start <= end < stop
        assert len(tokenizer.encode(source, target[start:stop]).ids) <= 512
        reconstructed += target[end:stop]
        end = stop
    assert reconstructed == target
    assert any(
        start < previous_stop
        for (_, previous_stop), (start, _) in zip(spans, spans[1:])
    )


def test_late_fact_is_scored_and_maximum_belongs_to_its_original_note():
    pairs = [
        {
            "source": "Вывод средств проекта",
            "target": "Архивная часть. " * 80 + "Факт: вывод средств готов.",
        },
        {"source": "Вывод средств проекта", "target": "Другой проект"},
    ]
    seen = []

    def score(engine, batch):
        seen.extend(deepcopy(batch))
        return [
            9.0 if "вывод средств готов" in row["target"] else -3.0 for row in batch
        ]

    scores, info = score_links(score, pairs, None, tokenizer=Tokenizer())
    assert scores == [9.0, -3.0]
    assert (
        info["reranker_passage_count"] == len(seen)
        and info["reranker_windowed_pair_count"] == 1
    )
    assert all(row["source"] == pairs[0]["source"] for row in seen)


@pytest.mark.parametrize("result", [[], [True], [float("nan")], [10**10000], "private"])
def test_incomplete_or_nonfinite_scores_are_typed_failures(result):
    with pytest.raises(NoteSystemError) as caught:
        score_links(
            lambda *_: result,
            [{"source": "query", "target": "target"}],
            None,
            tokenizer=Tokenizer(),
        )
    assert caught.value.failure_code == "links_reranker_protocol_failed"


def test_source_overflow_is_not_silently_split_or_truncated():
    calls = []
    with pytest.raises(NoteSystemError) as caught:
        score_links(
            lambda *args: calls.append(args),
            [{"source": "x" * 512, "target": "target"}],
            None,
            tokenizer=Tokenizer(),
        )
    assert caught.value.failure_code == "links_reranker_source_too_long" and calls == []


def test_passage_limit_refuses_partial_success_instead_of_dropping_the_tail():
    with pytest.raises(NoteSystemError) as caught:
        score_links(
            lambda *_: pytest.fail("partial batch should not escape"),
            [{"source": "query", "target": "x" * 1300}],
            None,
            tokenizer=Tokenizer(),
            maximum=1,
        )
    assert caught.value.failure_code == "links_reranker_window_budget_exceeded"


def test_tokenless_prefix_and_large_internal_whitespace_never_become_blank_requests():
    tokenizer = WordTokenizer()
    target = (
        " " * 20000 + "слово" + " " * 20000 + "архивная информация " * 700 + " " * 20000
    )
    spans = list(target_windows(tokenizer, "query", target))
    end, rebuilt = 0, ""
    for start, stop in spans:
        assert start <= end < stop and target[start:stop].strip()
        assert len(tokenizer.encode("query", target[start:stop]).ids) <= 512
        rebuilt += target[end:stop]
        end = stop
    assert rebuilt == target


def test_small_positive_target_budget_still_has_real_overlap_and_progress():
    tokenizer, target = WordTokenizer(), "target " * 120
    spans = list(target_windows(tokenizer, "query " * 494, target))
    assert len(spans) > 2
    assert all(
        previous_start < start < previous_stop < stop
        for (previous_start, previous_stop), (start, stop) in zip(spans, spans[1:])
    )
    assert spans[0][0] == 0 and spans[-1][1] == len(target)


def test_one_target_token_capacity_is_explicitly_unsupported_for_long_targets():
    with pytest.raises(NoteSystemError) as caught:
        list(target_windows(WordTokenizer(), "query " * 508, "target " * 10))
    assert caught.value.failure_code == "links_reranker_source_too_long"


def test_global_passage_budget_refuses_the_whole_batch_without_partial_result():
    with pytest.raises(NoteSystemError) as caught:
        score_links(
            lambda *_: pytest.fail("unfinished batch escaped"),
            [{"source": "q", "target": "x"}, {"source": "q", "target": "y"}],
            None,
            tokenizer=Tokenizer(),
            maximum_total=1,
        )
    assert caught.value.failure_code == "links_reranker_window_budget_exceeded"


def test_literal_prefix_and_preceding_sentence_stay_with_a_late_fact():
    tokenizer = WordTokenizer()
    target = "Проект Север.\r\n" + "Архивная часть. " * 60 + "Вывод средств готов."
    packets = list(boundary_passages(tokenizer, "Проект Север, вывод", target))
    late = next(packet for packet in packets if "Вывод средств готов." in packet)
    assert late.startswith("Проект Север.\r\n")
    assert "Архивная часть. Вывод средств готов." in late
    assert all(
        len(tokenizer.encode("Проект Север, вывод", packet).ids) <= 512
        for packet in packets
    )


def test_total_transport_byte_budget_is_checked_before_scoring():
    with pytest.raises(NoteSystemError) as caught:
        score_links(
            lambda *_: pytest.fail("budget refused before scoring"),
            [{"source": "query", "target": "target"}],
            None,
            tokenizer=Tokenizer(),
            maximum_bytes=1,
        )
    assert caught.value.failure_code == "links_reranker_window_budget_exceeded"


def test_empty_and_invalid_pair_envelopes_fail_or_skip_without_loading_models():
    assert score_links(lambda *_: pytest.fail("empty input"), [], None) == (
        [],
        {
            "reranker_passage_count": 0,
            "reranker_windowed_pair_count": 0,
            "reranker_boundary_passage_count": 0,
        },
    )
    for pairs in (
        None,
        [{"source": "q", "target": None}],
        [{"source": "q", "target": "x", "extra": True}],
    ):
        with pytest.raises(NoteSystemError) as caught:
            score_links(lambda *_: pytest.fail("invalid input"), pairs, None)
        assert caught.value.failure_code == "links_reranker_protocol_failed"


def test_byte_bounded_batches_preserve_large_tokenless_sources_in_full(monkeypatch):
    monkeypatch.setattr(scorer_contract, "MAX_BYTES", 1000)
    pairs = [
        {"source": " " * 530 + "query", "target": str(index)} for index in range(2)
    ]
    batches = []

    def score(_engine, batch):
        batches.append(deepcopy(batch))
        return [1.0] * len(batch)

    scores, info = score_links(score, pairs, None, tokenizer=WordTokenizer())
    assert scores == [1.0, 1.0] and [len(batch) for batch in batches] == [1, 1]
    assert [row for batch in batches for row in batch] == pairs


def test_oversized_utf8_packet_is_rejected_before_any_worker_request(monkeypatch):
    monkeypatch.setattr(scorer_contract, "MAX_BYTES", 1000)
    with pytest.raises(NoteSystemError) as caught:
        score_links(
            lambda *_: pytest.fail("oversized payload"),
            [{"source": "界" * 350, "target": "target"}],
            None,
            tokenizer=WordTokenizer(),
        )
    assert caught.value.failure_code == "links_reranker_protocol_failed"


def test_native_worker_page_size_is_bounded_without_a_pair_count_cutoff():
    pairs = [{"source": "query", "target": str(index)} for index in range(129)]
    batches = []

    def score(_engine, batch):
        batches.append(deepcopy(batch))
        return [float(row["target"]) for row in batch]

    scores, _ = score_links(score, pairs, None, tokenizer=Tokenizer())
    assert scores == list(map(float, range(129)))
    assert list(map(len, batches)) == [128, 1]


def test_boundary_prefix_is_literal_bounded_and_does_not_split_a_combining_mark():
    target = "x" * 63 + "e\u0301" + "z" * 600 + ". Последний факт."
    packets = list(boundary_passages(Tokenizer(), "query", target))
    assert packets and packets[-1].startswith(target[:63] + "\n\n")
    assert "Последний факт." in packets[-1]
    assert list(boundary_passages(Tokenizer(), "query", " \r\n\t")) == []


@pytest.mark.parametrize("engine", ["mmarco", "qwen_links"])
def test_owned_service_routes_only_mmarco_links_through_passage_transport(
    tmp_path, monkeypatch, engine
):
    monkeypatch.setattr(link_scoring, "load_tokenizer", lambda _: Tokenizer())
    pairs = [{"source": "query", "target": "target"}]
    with LocalServices(PipelineConfig(repo_root=tmp_path)) as service:
        calls = []

        def score(selected_engine, rows):
            calls.append((selected_engine, deepcopy(rows)))
            return [3.0] * len(rows)

        monkeypatch.setattr(service, "score", score)
        assert service.score_links(engine, pairs) == [3.0]
        assert calls == [(engine, pairs)]
        expected = link_scoring.TRANSPORT if engine == "mmarco" else "full-pairs-v1"
        assert service.link_score_diagnostics["scoring_transport_version"] == expected


def test_new_link_scoring_capability_keeps_the_owned_model_lease_required(tmp_path):
    service = LocalServices(PipelineConfig(repo_root=tmp_path))
    with pytest.raises(NoteSystemError) as caught:
        service.score_links("mmarco", [{"source": "query", "target": "target"}])
    assert caught.value.failure_code == "ru_runtime_lease_missing"


class GateServices:
    def __init__(self, selected):
        self.selected, self.calls, self.scored = selected, [], []
        self.link_score_diagnostics = {}

    @contextmanager
    def generator(self, _key):
        yield self

    def invoke(self, messages, **_sampling):
        packet = json.loads(messages[-1]["content"])
        self.calls.append(packet)
        if packet.get("relation_review"):
            return json.dumps({"relation": "none", "source_quote": "", "target_quote": ""})
        return json.dumps(
            {
                "linked_ids": (
                    [row["id"] for row in packet["candidates"]] if self.selected else []
                )
            }
        )

    def score_links(self, engine, pairs):
        scores, self.link_score_diagnostics = score_links(
            self.score, pairs, None, tokenizer=Tokenizer()
        )
        return scores

    def score(self, engine, pairs):
        self.scored.extend(deepcopy(pairs))
        return [10.0] * len(pairs)


@pytest.mark.parametrize(
    "meaning",
    ["Связи с проектом Север нет.", "Корабль Север и проект Север — разные объекты."],
)
def test_passage_scores_cannot_create_a_link_rejected_from_the_full_candidate(meaning):
    service = GateServices(selected=False)
    candidate = "Архивные подробности. " * 55 + meaning
    result = select_links(
        service, "Проект Север", [{"id": "Архив", "source": candidate}]
    )
    assert service.calls[0]["candidates"][0]["source"] == candidate
    assert service.calls[1]["candidate_note"] == candidate
    assert result["links"] == [] and service.scored == []


def test_empty_bodies_are_explicitly_ineligible_without_hiding_valid_schema_errors():
    service = GateServices(selected=True)
    rows = [
        {"id": "Пустая", "source": "\r\n \t"},
        {"id": "Полная", "source": "Полный текст"},
    ]
    frozen = deepcopy(rows)
    result = select_links(service, "Исходник", rows)
    assert result["links"] == ["Полная"] and rows == frozen
    assert result["retrieval_count"] == 2 and result["eligible_retrieval_count"] == 1
    assert result["excluded_empty_candidate_count"] == 1
    assert len(service.calls[0]["candidates"]) == 1
    with pytest.raises(NoteSystemError):
        select_links(service, "Исходник", [{"id": "Пустая", "source": None}])
    with pytest.raises(NoteSystemError):
        select_links(
            service,
            "Исходник",
            [{"id": "Повтор", "source": ""}, {"id": "Повтор", "source": "full"}],
        )
