"""Low lexical similarity requires an independent full-text, quote-backed review."""

from copy import deepcopy
import json

import pytest

from backend.inference_runner import ContextBudgetError
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.link_stage import LINK_THRESHOLD, select_links
from backend.ru_pipeline.link_verification import decode_evidence, quote_choices
from test_ru_pipeline_methods import Services

SOURCE = "\ufeff  Исправить поиск.\r\nЭкспорт PDF не добавлять.  "
TARGET = "Поиск пропускает слова с дефисом.\r\n  "
ROWS = [{"id": "Ошибка поиска", "source": TARGET}]


def test_schema_quote_choices_are_literal_even_for_long_multiline_unicode_source():
    source = "\ufeff  Первая строка.\r\n" + "длинная строка " * 80 + "Хвост!"
    choices = quote_choices(source)
    assert choices and all(
        quote in source and 3 <= len(quote) <= 240 for quote in choices
    )
    assert any("Хвост" in quote for quote in choices)


def test_quote_choices_bound_an_unbroken_word_without_altering_the_source():
    source = "ж" * 500
    assert all(quote in source and len(quote) <= 240 for quote in quote_choices(source))
    assert len(source) == 500


def evidence(related=True):
    return {
        "relation": "same_subject" if related else "none",
        "source_quote": "Исправить поиск" if related else "",
        "target_quote": "Поиск пропускает слова с дефисом" if related else "",
    }


@pytest.mark.parametrize("related", [False, True])
def test_low_score_needs_literal_evidence_without_lowering_threshold(related):
    original = deepcopy(ROWS)

    def respond(messages, sampling):
        payload = json.loads(messages[1]["content"])
        assert payload["source_note"] == SOURCE
        if "candidates" in payload:
            return json.dumps({"linked_ids": [payload["candidates"][0]["id"]]})
        assert payload["candidate_note"] == TARGET
        return json.dumps(evidence(related))

    services = Services(respond, scorer=lambda *unused: [-8.0])
    result = select_links(services, SOURCE, ROWS)
    assert LINK_THRESHOLD == 4.500922203063965
    assert result["links"] == (["Ошибка поиска"] if related else [])
    assert result["review_candidate_count"] == 1
    assert result["review_accepted_count"] == int(related)
    assert result["attempts"] == 2 and result["score_count"] == 1
    assert ROWS == original
    assert not services.active


@pytest.mark.parametrize(
    "fault", ["source", "target", "extra", "relation", "duplicate", "empty"]
)
def test_invented_or_malformed_relation_evidence_is_rejected(fault):
    value = evidence()
    if fault in ("source", "target"):
        value[fault + "_quote"] = "Цитата, которой нет в исходнике"
    elif fault == "extra":
        value["other"] = True
    elif fault == "relation":
        value["relation"] = "same_person"
    elif fault == "empty":
        value["source_quote"] = ""
    raw = json.dumps(value)
    if fault == "duplicate":
        raw = raw[:-1] + ',"relation":"none"}'
    with pytest.raises(ValueError):
        decode_evidence(raw, SOURCE, TARGET)


def test_invalid_evidence_never_silently_accepts_a_link():
    def respond(messages, sampling):
        payload = json.loads(messages[1]["content"])
        if "candidates" in payload:
            return json.dumps({"linked_ids": [payload["candidates"][0]["id"]]})
        return json.dumps(dict(evidence(), source_quote="fabricated evidence"))

    services = Services(respond, scorer=lambda *unused: [-8.0])
    with pytest.raises(NoteModelResponseError):
        select_links(services, SOURCE, ROWS)
    assert len(services.calls) == 3 and not services.active


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        '{"relation":"none"}',
        '{"relation":"same_subject","source_quote":17,"target_quote":"Поиск"}',
        '{"relation":"none","source_quote":"поиск","target_quote":""}',
    ],
)
def test_invalid_evidence_shape_or_rejected_quotes_fail_closed(raw):
    with pytest.raises(ValueError):
        decode_evidence(raw, SOURCE, TARGET)


def test_full_pair_overflow_is_a_typed_error_without_truncation():
    def respond(messages, sampling):
        payload = json.loads(messages[1]["content"])
        assert payload["source_note"] == SOURCE
        if "candidates" in payload:
            return json.dumps({"linked_ids": [payload["candidates"][0]["id"]]})
        assert payload["candidate_note"] == TARGET
        raise ContextBudgetError("Synthetic full-pair overflow")

    services = Services(respond, scorer=lambda *unused: [-8.0])
    with pytest.raises(NoteSystemError) as caught:
        select_links(services, SOURCE, ROWS)
    assert caught.value.failure_code == "context_budget_exceeded"
