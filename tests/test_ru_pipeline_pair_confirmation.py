"""A batch's positive relation cannot publish without a fresh pair-only decision."""

from copy import deepcopy
import json

import pytest

from backend.inference_runner import ContextBudgetError
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.methods import select_links
from test_ru_pipeline_methods import Services


SOURCE = "\ufeff  CRM менять не нужно. Забрать посылку после работы.\r\n  "
ROWS = [
    {
        "id": "Резервные копии",
        "source": "Настроить ежедневные резервные копии PostgreSQL.",
    },
    {
        "id": "Восстановление",
        "source": "Проверить восстановление базы PostgreSQL из копии.",
    },
]


def no_relation():
    return {"relation": "none", "source_quote": "", "target_quote": ""}


def batch_positives(payload):
    return {
        row["id"]: {
            "relation": "same_subject",
            "source_quote": payload["allowed_source_quotes"][0],
            "target_quote": row["allowed_target_quotes"][0],
        }
        for row in payload["candidate_notes"]
    }


def test_valid_quotes_in_a_batch_do_not_prove_the_notes_share_an_active_subject():
    original = deepcopy(ROWS)
    checked = []

    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        assert payload["source_note"] == SOURCE
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        if "candidate_notes" in payload:
            # Deliberately reproduce a semantically wrong, schema-valid batch answer.
            return json.dumps(batch_positives(payload))
        assert payload["independent_pair_review"] is True
        assert set(payload) == {
            "relation_review",
            "independent_pair_review",
            "source_note",
            "candidate_note",
            "allowed_source_quotes",
            "allowed_target_quotes",
        }
        checked.append(payload["candidate_note"])
        return json.dumps(no_relation())

    service = Services(respond)
    result = select_links(service, SOURCE, ROWS)
    assert result["links"] == []
    assert result["candidate_count"] == result["score_count"] == 0
    assert result["review_candidate_count"] == 2
    assert result["review_accepted_count"] == 0
    assert checked == [row["source"] for row in ROWS]
    assert ROWS == original and not service.active


def test_a_batch_relation_is_kept_only_after_the_full_pair_confirms_it():
    source = "\ufeff  Добавить категории товаров.\r\nПолный текст  "
    rows = [
        {"id": "Категории", "source": "Каталог товаров должен поддерживать категории."},
        {"id": "Почта", "source": "Настроить почту для того же исполнителя."},
    ]
    checks = []

    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        assert payload["source_note"] == source
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        if "candidate_notes" in payload:
            decisions = batch_positives(payload)
            decisions[payload["candidate_notes"][1]["id"]] = no_relation()
            return json.dumps(decisions)
        assert payload["candidate_note"] == rows[0]["source"]
        checks.append(payload)
        return json.dumps(
            {
                "relation": "same_subject",
                "source_quote": payload["allowed_source_quotes"][0],
                "target_quote": payload["allowed_target_quotes"][0],
            }
        )

    result = select_links(Services(respond), source, rows)
    assert result["links"] == ["Категории"]
    assert len(checks) == 1
    assert result["review_accepted_count"] == 1


@pytest.mark.parametrize("fault", ["invalid_quote", "context", "timeout"])
def test_pair_confirmation_failure_never_becomes_a_positive_batch_result(fault):
    checked = []

    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        assert payload["source_note"] == SOURCE
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        if "candidate_notes" in payload:
            return json.dumps(batch_positives(payload))
        assert payload["candidate_note"] == ROWS[0]["source"]
        checked.append(payload)
        if fault == "context":
            raise ContextBudgetError("Synthetic complete pair overflow")
        if fault == "timeout":
            raise TimeoutError("Synthetic model timeout")
        return json.dumps(
            {
                "relation": "same_subject",
                "source_quote": "fabricated evidence",
                "target_quote": payload["allowed_target_quotes"][0],
            }
        )

    expected = NoteModelResponseError if fault == "invalid_quote" else NoteSystemError
    with pytest.raises(expected) as caught:
        select_links(Services(respond), SOURCE, ROWS)
    assert checked and all(item["source_note"] == SOURCE for item in checked)
    if fault == "context":
        assert caught.value.failure_code == "context_budget_exceeded"
    elif fault == "timeout":
        assert caught.value.failure_code == "ru_generator_failed"


def test_a_negative_batch_does_not_add_unnecessary_pair_requests():
    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        if "candidates" in payload:
            return '{"linked_ids":[]}'
        assert "candidate_notes" in payload
        return json.dumps(
            {row["id"]: no_relation() for row in payload["candidate_notes"]}
        )

    service = Services(respond)
    assert select_links(service, SOURCE, ROWS)["links"] == []
    assert len(service.calls) == 2
