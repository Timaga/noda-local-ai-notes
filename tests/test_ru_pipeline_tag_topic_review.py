"""New-tag relevance must not turn a covered topic into a task-shaped duplicate."""

from copy import deepcopy
import json

import pytest

from backend.inference_runner import ContextBudgetError
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.new_tag_stage import create_new_tags
from backend.ru_pipeline.pair_settings import NEW_TAG_PAIRS
from test_ru_pipeline_methods import Services


CATALOG = [
    {"id": "T1", "label": "резервное_копирование", "description": ""},
    {"id": "T2", "label": "crm", "description": "Управление отношениями с клиентами"},
]
SOURCE = "\ufeff  Перенести ежедневное резервное копирование на другое время.\r\n  "
CANDIDATE = {
    "label": "перенос резервного копирования",
    "description": "Изменение расписания резервных копий",
}


def services_for(new, selection, *, scores=None, on_review=None):
    def respond(messages, sampling):
        payload = json.loads(messages[-1]["content"])
        if payload.get("tag_topic_review"):
            if on_review:
                on_review(payload)
            value = selection(payload) if callable(selection) else selection
            return json.dumps({"selection": value})
        return json.dumps({"new": new})

    return Services(respond, scorer=lambda engine, pairs: scores or [1.0] * len(pairs))


def test_relevant_task_shaped_new_tag_reuses_the_existing_topic_instead():
    catalog = deepcopy(CATALOG)
    observed = []

    def inspect(payload):
        assert payload["source_note"] == SOURCE
        assert payload["catalog"] == CATALOG
        assert payload["proposed_new_tags"][0]["label"] == CANDIDATE["label"]
        observed.append(payload)

    service = services_for(
        [CANDIDATE], {"existing": ["T1"], "new": []}, on_review=inspect
    )
    result = create_new_tags(service, SOURCE, catalog, [], pair=NEW_TAG_PAIRS[0])
    assert result["tags"] == []
    assert result["reused_tags"] == ["резервное_копирование"]
    assert result["reused_tag_count"] == 1
    assert catalog == CATALOG and len(observed) == 1
    assert service.score_calls[0][1] == [
        {"source": SOURCE, "target": "резервное_копирование: "}
    ]
    assert not service.active


def test_a_distinct_substantial_new_topic_is_still_scored_and_kept():
    candidate = {
        "label": "двухфакторная аутентификация",
        "description": "Вход с дополнительным фактором",
    }
    service = services_for(
        [candidate],
        lambda payload: {
            "existing": [],
            "new": [payload["proposed_new_tags"][0]["id"]],
        },
    )
    result = create_new_tags(
        service,
        "Пароль не менять, включить второй фактор входа.",
        CATALOG,
        [],
        pair=NEW_TAG_PAIRS[0],
    )
    assert result["tags"] == ["двухфакторная_аутентификация"]
    assert result["reused_tags"] == []
    assert len(service.score_calls[0][1]) == 1


def test_a_generic_candidate_cannot_survive_relevance_alone():
    candidate = {"label": "задача", "description": "Разовое действие"}
    service = services_for([candidate], {"existing": [], "new": []})
    result = create_new_tags(
        service, "Ок, принято. Спасибо!", [], [], pair=NEW_TAG_PAIRS[0]
    )
    assert result["tags"] == result["reused_tags"] == []
    assert service.score_calls == []


def test_rejected_background_does_not_force_an_existing_tag():
    service = services_for([], {"existing": [], "new": []})
    result = create_new_tags(
        service,
        "CRM менять не нужно. Забрать посылку.",
        CATALOG,
        [],
        pair=NEW_TAG_PAIRS[0],
    )
    assert result["tags"] == result["reused_tags"] == []
    assert service.score_calls == []


def test_reuse_can_rescue_a_catalog_topic_even_when_no_new_candidate_remains():
    service = services_for([], {"existing": ["T1"], "new": []})
    result = create_new_tags(service, SOURCE, CATALOG, [], pair=NEW_TAG_PAIRS[0])
    assert result["tags"] == [] and result["reused_tags"] == ["резервное_копирование"]


def test_reused_topic_must_pass_the_selected_new_stage_scorer():
    service = services_for([CANDIDATE], {"existing": ["T1"], "new": []}, scores=[-10.0])
    result = create_new_tags(service, SOURCE, CATALOG, [], pair=NEW_TAG_PAIRS[0])
    assert result["tags"] == result["reused_tags"] == []


@pytest.mark.parametrize(
    "scores, expected_new, expected_reuse",
    [
        ([0.99, 0.1], ["двухфакторная_аутентификация"], []),
        ([0.1, 0.99], [], ["резервное_копирование"]),
        ([0.99, 0.99], ["двухфакторная_аутентификация"], ["резервное_копирование"]),
    ],
)
def test_mixed_novel_and_reused_topics_keep_their_own_score_decisions(
    scores, expected_new, expected_reuse
):
    candidate = {
        "label": "двухфакторная аутентификация",
        "description": "Дополнительный фактор входа",
    }
    service = services_for(
        [candidate],
        lambda payload: {
            "existing": ["T1"],
            "new": [payload["proposed_new_tags"][0]["id"]],
        },
        scores=scores,
    )
    source = "Настроить резервные копии базы и включить двухфакторный вход."
    result = create_new_tags(service, source, CATALOG, [], pair=NEW_TAG_PAIRS[0])
    assert result["tags"] == expected_new and result["reused_tags"] == expected_reuse
    assert [row["target"] for row in service.score_calls[0][1]] == [
        "двухфакторная аутентификация: Дополнительный фактор входа",
        "резервное_копирование: ",
    ]


def test_an_already_applied_topic_is_not_repeated_or_rescored():
    service = services_for([], {"existing": ["T1"], "new": []})
    applied = ["резервное_копирование"]
    result = create_new_tags(service, SOURCE, CATALOG, applied, pair=NEW_TAG_PAIRS[0])
    assert result["tags"] == result["reused_tags"] == []
    assert applied == ["резервное_копирование"] and service.score_calls == []


def test_applied_aliases_are_normalized_without_mutating_or_duplicating_them():
    service = services_for([], {"existing": ["T1"], "new": []})
    applied = ["РЕЗЕРВНОЕ_КОПИРОВАНИЕ", "резервное_копирование"]
    before = list(applied)
    result = create_new_tags(service, SOURCE, CATALOG, applied, pair=NEW_TAG_PAIRS[0])
    assert result["tags"] == result["reused_tags"] == [] and applied == before
    assert service.score_calls == []
    first = json.loads(service.calls[0][0][-1]["content"])
    assert first["applied_tags"] == [CATALOG[0]]


def test_catalog_case_aliases_do_not_create_duplicate_reused_topics():
    catalog = [CATALOG[1], {"id": "T3", "label": "CRM", "description": "CRM"}]
    service = services_for([], {"existing": ["T2", "T3"], "new": []})
    result = create_new_tags(
        service, "Настроить в CRM группы клиентов.", catalog, [], pair=NEW_TAG_PAIRS[0]
    )
    assert result["reused_tags"] == ["crm"] and len(service.score_calls[0][1]) == 1


def test_an_ambiguous_applied_case_alias_is_not_resolved_arbitrarily():
    catalog = [CATALOG[1], {"id": "T3", "label": "CRM", "description": "CRM"}]
    service = services_for([], {"existing": [], "new": []})
    with pytest.raises(NoteSystemError):
        create_new_tags(service, SOURCE, catalog, ["CrM"], pair=NEW_TAG_PAIRS[0])
    assert service.calls == []


@pytest.mark.parametrize("applied", [["missing"], [7], "crm"])
def test_invalid_applied_tags_fail_before_any_model_call(applied):
    service = services_for([], {"existing": [], "new": []})
    with pytest.raises(NoteSystemError) as caught:
        create_new_tags(service, SOURCE, CATALOG, applied, pair=NEW_TAG_PAIRS[0])
    assert caught.value.failure_code == "invalid_ru_pipeline_input"
    assert service.calls == service.score_calls == []


def test_empty_note_topics_and_empty_catalog_do_not_need_a_second_call():
    service = services_for([], {"existing": [], "new": []})
    result = create_new_tags(
        service, "Принято, спасибо!", [], [], pair=NEW_TAG_PAIRS[0]
    )
    assert result["tags"] == result["reused_tags"] == []
    assert len(service.calls) == 1 and not service.score_calls


def test_english_existing_topics_can_be_reused_without_a_synonym():
    catalog = [
        {"id": "E1", "label": "backups", "description": "Database copies for recovery"}
    ]
    service = services_for(
        [
            {
                "label": "rescheduling backups",
                "description": "Moving an existing backup schedule",
            }
        ],
        {"existing": ["E1"], "new": []},
    )
    result = create_new_tags(
        service,
        "Move nightly database backups to another hour.",
        catalog,
        [],
        pair=NEW_TAG_PAIRS[0],
    )
    assert result["tags"] == [] and result["reused_tags"] == ["backups"]


@pytest.mark.parametrize(
    "selection",
    [
        {"existing": ["unknown"], "new": []},
        {"existing": ["T1", "T1"], "new": []},
        {"existing": [], "new": ["unknown"]},
        {"existing": [], "new": [], "extra": True},
    ],
)
def test_novelty_review_cannot_invent_ids_or_hide_malformed_output(selection):
    service = services_for([CANDIDATE], selection)
    with pytest.raises(NoteModelResponseError):
        create_new_tags(service, SOURCE, CATALOG, [], pair=NEW_TAG_PAIRS[0])
    assert service.score_calls == [] and not service.active


def test_full_catalog_review_overflow_is_typed_and_never_truncates_input():
    def overflow(payload):
        assert payload["source_note"] == SOURCE and payload["catalog"] == CATALOG
        raise ContextBudgetError("Synthetic complete catalog limit")

    service = services_for([CANDIDATE], {}, on_review=overflow)
    with pytest.raises(NoteSystemError) as caught:
        create_new_tags(service, SOURCE, CATALOG, [], pair=NEW_TAG_PAIRS[0])
    assert caught.value.failure_code == "context_budget_exceeded"
    assert service.score_calls == [] and not service.active
