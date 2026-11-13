"""An initial empty selection cannot silently hide a directly related note."""

import json
import pytest
from backend.inference_runner import ContextBudgetError
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.link_candidate_review import decode_batch
from backend.ru_pipeline.methods import select_links
from test_ru_pipeline_methods import Services

SOURCE = "\ufeff  Добавить категории товаров.\r\nПолный текст  "
ROWS = [
    {"id": "Категории", "source": "Каталог товаров должен поддерживать категории."},
    {"id": "Другая тема", "source": "Расписание встречи с поставщиком."},
]


def decisions(payload):
    return {
        row["id"]: {
            "relation": "same_subject" if "категории" in row["source"] else "none",
            "source_quote": (
                payload["allowed_source_quotes"][0]
                if "категории" in row["source"]
                else ""
            ),
            "target_quote": (
                row["allowed_target_quotes"][0] if "категории" in row["source"] else ""
            ),
        }
        for row in payload["candidate_notes"]
    }


def pair_decision(payload):
    assert payload["independent_pair_review"] is True
    assert payload["source_note"] == SOURCE
    assert payload["candidate_note"] == ROWS[0]["source"]
    return {
        "relation": "same_subject",
        "source_quote": payload["allowed_source_quotes"][0],
        "target_quote": payload["allowed_target_quotes"][0],
    }


def test_independent_decisions_rescue_a_missed_candidate_and_reject_shared_background():
    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        assert payload["source_note"] == SOURCE
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        if "candidate_note" in payload:
            return json.dumps(pair_decision(payload))
        assert {r["source"] for r in payload["candidate_notes"]} == {
            r["source"] for r in ROWS
        }
        return json.dumps(decisions(payload))

    result = select_links(Services(respond), SOURCE, ROWS)
    assert result["candidate_count"] == 0
    assert result["links"] == ["Категории"]
    assert (
        result["review_candidate_count"] == 2 and result["review_accepted_count"] == 1
    )


def test_batch_overflow_splits_candidates_without_truncating_either_source():
    seen = []

    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        assert payload["source_note"] == SOURCE
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        if "candidate_note" in payload:
            return json.dumps(pair_decision(payload))
        if len(payload["candidate_notes"]) > 1:
            raise ContextBudgetError("Synthetic full-batch limit")
        seen.extend(r["source"] for r in payload["candidate_notes"])
        return json.dumps(decisions(payload))

    result = select_links(Services(respond), SOURCE, ROWS)
    assert result["links"] == ["Категории"]
    assert set(seen) == {r["source"] for r in ROWS}


def test_missing_decision_is_a_failure_instead_of_implicitly_rejecting_a_candidate():
    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        return '{"linked_ids":[]}' if "candidates" in payload else "{}"

    with pytest.raises(NoteModelResponseError):
        select_links(Services(respond), SOURCE, ROWS)


def test_duplicate_decision_is_rejected_before_any_candidate_can_be_accepted():
    with pytest.raises(ValueError, match="Duplicate"):
        decode_batch('{"x":{},"x":{}}', SOURCE, [{"id": "x", "source": "Текст"}])


def test_single_complete_pair_still_too_large_is_a_typed_failure():
    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        raise ContextBudgetError("Synthetic complete-pair overflow")

    with pytest.raises(NoteSystemError) as caught:
        select_links(Services(respond), SOURCE, ROWS)
    assert caught.value.failure_code == "context_budget_exceeded"
