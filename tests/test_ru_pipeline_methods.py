"""Selected method behavior with fakes only at the local neural boundary."""

from contextlib import contextmanager
from copy import deepcopy
import json

import pytest

from backend.inference_runner import ContextBudgetError
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.methods import generate_title, select_links, select_tags
from backend.ru_pipeline.tag_stage import TAG_THRESHOLD
from backend.ru_pipeline.link_stage import LINK_THRESHOLD


class Services:
    def __init__(self, responder=None, scorer=None):
        self.responder = responder or self.all_candidates
        self.scorer = scorer or (lambda _engine, pairs: [1.0] * len(pairs))
        self.calls, self.score_calls, self.models = [], [], []
        self.active = False

    @staticmethod
    def all_candidates(messages, _sampling):
        payload = json.loads(messages[1]["content"])
        field, rows = (
            ("tag_ids", payload["catalog"])
            if "catalog" in payload
            else ("linked_ids", payload["candidates"])
        )
        return json.dumps({field: [row["id"] for row in rows]})

    @contextmanager
    def generator(self, model):
        assert not self.active
        self.active = True
        self.models.append(model)
        try:
            yield self
        finally:
            self.active = False

    def invoke(self, messages, **sampling):
        self.calls.append((deepcopy(messages), deepcopy(sampling)))
        return self.responder(messages, sampling)

    def score(self, *, engine, pairs):
        assert not self.active, "Generator must close before loading the scorer"
        self.score_calls.append((engine, deepcopy(pairs)))
        return self.scorer(engine, pairs)


def tags(count):
    return [
        {
            "id": f"T{index:04d}",
            "label": f"тема-{index}",
            "description": f"Описание темы {index}",
        }
        for index in range(count)
    ]


def archive(count):
    return [
        {
            "id": f"Папка/Исходное имя {index:03d}",
            "source": f"Полный текст архивной записи {index}.",
        }
        for index in range(count)
    ]


def test_four_title_styles_rank_all_valid_pairs_and_preserve_full_source():
    titles = [
        "Начало настройки",
        "Обсуждение настройки",
        "Условия настройки",
        "План настройки",
    ]
    responses = iter(
        json.dumps({"title": value}, ensure_ascii=False) for value in titles
    )
    services = Services(
        lambda *_args: next(responses), lambda _engine, _pairs: [0.4, 0.9, 0.9, 0.1]
    )
    source = "Первый абзац.\r\n\nПоследний абзац с вопросом?"
    result = generate_title(services, source)
    assert (
        result["title"] == titles[1]
    ), "Original candidate order resolves tied maximum scores"
    assert result["attempts"] == 4 and result["candidate_count"] == 4
    assert services.models == ["qwen25_3b"]
    assert services.score_calls == [
        ("mmarco", [{"source": source, "target": title} for title in titles])
    ]
    for messages, sampling in services.calls:
        assert json.loads(messages[1]["content"])["source_note"] == source
        assert sampling["seed"] == 1337 and sampling["max_new_tokens"] == 256
        assert (
            sampling["temperature"] == 0 and sampling["require_context_budget"] is True
        )


def test_title_format_retry_does_not_polish_or_replace_valid_semantics():
    responses = iter(
        [
            "not JSON",
            '{"title":"Точный заголовок"}',
            '{"title":"Второй заголовок"}',
            '{"title":"Третий заголовок"}',
            '{"title":"Четвёртый заголовок"}',
        ]
    )
    services = Services(
        lambda *_args: next(responses), lambda _engine, _pairs: [4.0, 3.0, 2.0, 1.0]
    )
    result = generate_title(services, "Исходник без изменений.")
    assert result["title"] == "Точный заголовок"
    assert result["attempts"] == 5 and result["retry_count"] == 1
    assert [row["status"] for row in result["attempt_records"]][:2] == [
        "FORMAT_ERROR",
        "COMPLETE",
    ]


def test_invalid_title_style_is_retained_but_other_valid_candidates_can_win():
    responses = iter(
        [
            '{"title":"Only Latin"}',
            '{"title":"Only Latin"}',
            '{"title":"Второй заголовок"}',
            '{"title":"Третий заголовок"}',
            '{"title":"Четвёртый заголовок"}',
        ]
    )
    services = Services(lambda *_args: next(responses))
    result = generate_title(services, "Полный исходный текст.")
    assert result["candidate_count"] == 3 and result["title"] == "Второй заголовок"
    assert result["candidate_records"][0]["status"] == "ERROR"
    assert len(services.score_calls[0][1]) == 3


@pytest.mark.parametrize(
    "raw",
    [
        '{"title":"Only Latin"}',
        '{"title":""}',
        '{"title":"Строка\\nразрыв"}',
        '{"title":"' + "слово " * 13 + '"}',
        '{"title":"Заголовок","extra":1}',
        '{"title":"Один","title":"Два"}',
    ],
)
def test_no_valid_title_never_becomes_a_fake_success(raw):
    services = Services(lambda *_args: raw)
    with pytest.raises(NoteModelResponseError):
        generate_title(services, "Исходный текст.")
    assert len(services.calls) == 8 and services.score_calls == []
    assert not services.active


def test_tag_empty_catalog_needs_no_neural_calls():
    services = Services()
    result = select_tags(services, "Заметка.", [])
    assert result["tags"] == [] and result["attempts"] == 0
    assert services.calls == services.score_calls == services.models == []


def test_existing_tags_page_beyond_twenty_without_changing_labels_or_source():
    catalog = tags(65)
    original = deepcopy(catalog)
    source = "Полный исходник\nс последней строкой."
    services = Services(scorer=lambda _engine, pairs: [TAG_THRESHOLD] * len(pairs))
    result = select_tags(services, source, catalog)
    assert result["tags"] == [row["label"] for row in original]
    assert result["batch_count"] == 3 and result["score_count"] == 65
    assert catalog == original and services.models == ["qwen35_4b"]
    assert [
        len(json.loads(messages[1]["content"])["catalog"])
        for messages, _ in services.calls
    ] == [25, 25, 15]
    assert all(pair["source"] == source for pair in services.score_calls[0][1])


def test_tag_descriptor_and_empty_descriptor_transport_are_explicit():
    services = Services(
        scorer=lambda _engine, pairs: [TAG_THRESHOLD, TAG_THRESHOLD - 1e-10]
    )
    result = select_tags(
        services,
        "Полная заметка.",
        [
            {"id": "x", "label": "сад", "description": ""},
            {"id": "y", "label": "почва", "description": "Уход за почвой"},
        ],
    )
    assert result["tags"] == ["сад"]
    assert result["label_only_catalog_count"] == 1
    assert services.score_calls == [
        (
            "tev",
            [
                {"source": "Полная заметка.", "target": "сад: "},
                {"source": "Полная заметка.", "target": "почва: Уход за почвой"},
            ],
        )
    ]


@pytest.mark.parametrize(
    "raw",
    [
        '{"tag_ids":["missing"]}',
        '{"tag_ids":["T0000","T0000"]}',
        '{"tag_ids":[] , "extra":true}',
        '{"tag_ids":null}',
        '{"tag_ids":[],"tag_ids":[]}',
        "not JSON",
        '{"tag_ids":[1e309]}',
    ],
)
def test_tag_unknown_duplicate_or_wrong_json_gets_only_one_format_retry(raw):
    services = Services(lambda *_args: raw)
    with pytest.raises(NoteModelResponseError):
        select_tags(services, "Полный исходник.", tags(1))
    assert len(services.calls) == 2 and services.score_calls == []


def test_links_inspect_all_sixty_five_including_zero_lexical_match_last_page():
    records = archive(65)
    services = Services(scorer=lambda _engine, pairs: [LINK_THRESHOLD] * len(pairs))
    result = select_links(
        services, "Уникальная независимая формулировка запроса.", records
    )
    assert set(result["links"]) == {row["id"] for row in records}
    assert len(result["links"]) == 65 and result["retrieval_count"] == 65
    assert result["batch_count"] == 7 and result["score_count"] == 65
    seen_sources = []
    for messages, sampling in services.calls:
        payload = json.loads(messages[1]["content"])
        assert (
            "title" not in messages[1]["content"]
            and "Папка/" not in messages[1]["content"]
        )
        assert all(row["id"].startswith("N") for row in payload["candidates"])
        assert sampling["seed"] == 1337
        seen_sources.extend(row["source"] for row in payload["candidates"])
    assert sorted(seen_sources) == sorted(row["source"] for row in records)
    assert all(
        pair["source"] == "Уникальная независимая формулировка запроса."
        for pair in services.score_calls[0][1]
    )


def test_empty_archive_is_a_correct_empty_link_set_without_models():
    services = Services()
    result = select_links(services, "Исходник.", [])
    assert (
        result["links"] == [] and result["attempts"] == result["retrieval_count"] == 0
    )
    assert services.models == services.score_calls == []


def test_model_cannot_select_original_filename_instead_of_an_opaque_alias():
    records = archive(1)
    services = Services(lambda *_args: json.dumps({"linked_ids": [records[0]["id"]]}))
    with pytest.raises(NoteModelResponseError):
        select_links(services, "Полный исходник.", records)
    assert len(services.calls) == 2 and services.score_calls == []


def test_context_preflight_splits_only_batches_and_preserves_the_complete_source():
    def limited(messages, sampling):
        payload = json.loads(messages[1]["content"])
        if len(payload["catalog"]) > 2:
            raise ContextBudgetError("Synthetic preflight refusal before completion")
        assert payload["source_note"] == "Весь исходник\nбез обрезки."
        return Services.all_candidates(messages, sampling)

    services = Services(limited)
    result = select_tags(services, "Весь исходник\nбез обрезки.", tags(5))
    assert len(result["tags"]) == 5 and result["batch_count"] == 3
    assert result["preflight_rejections"] == 2 and result["attempts"] == 3
    assert result["request_attempts"] == 5 and result["retry_count"] == 0


@pytest.mark.parametrize("kind", ["title", "tags", "links"])
def test_one_oversized_full_source_is_system_error_and_never_silently_truncated(kind):
    def overflow(*_args):
        raise ContextBudgetError("Synthetic preflight refusal")

    services = Services(overflow)
    call = {
        "title": lambda: generate_title(services, "Полный источник."),
        "tags": lambda: select_tags(services, "Полный источник.", tags(1)),
        "links": lambda: select_links(services, "Полный источник.", archive(1)),
    }[kind]
    with pytest.raises(NoteSystemError) as error:
        call()
    assert error.value.failure_code == "context_budget_exceeded"
    assert len(services.calls) == 1 and services.score_calls == []


def test_generator_transport_failure_is_not_a_format_retry():
    def failed(*_args):
        raise OSError("Synthetic local native failure")

    services = Services(failed)
    with pytest.raises(NoteSystemError):
        select_tags(services, "Полный источник.", tags(1))
    assert len(services.calls) == 1 and services.score_calls == []


def test_mutated_generator_packet_is_rejected_without_mutating_the_source_catalog():
    def mutate(messages, sampling):
        raw = Services.all_candidates(messages, sampling)
        messages[1]["content"] = "changed by provider"
        return raw

    catalog = tags(1)
    original = deepcopy(catalog)
    services = Services(mutate)
    with pytest.raises(NoteSystemError) as error:
        select_tags(services, "Полный источник.", catalog)
    assert error.value.failure_code == "ru_pipeline_input_changed"
    assert catalog == original and len(services.calls) == 1


@pytest.mark.parametrize(
    "scores", [[], [True], ["1"], [float("nan")], [float("inf")], [10**10000]]
)
def test_bad_reranker_result_is_system_failure_not_empty_tag_selection(scores):
    services = Services(scorer=lambda *_args: scores)
    with pytest.raises(NoteSystemError) as error:
        select_tags(services, "Исходник.", tags(1))
    assert error.value.failure_kind == "system"


def test_reranker_full_pair_overflow_cannot_fall_back_to_unranked_title():
    def failed_score(*_args):
        raise ValueError("Full pair exceeds512; no truncation")

    services = Services(lambda *_args: '{"title":"Корректный заголовок"}', failed_score)
    with pytest.raises(NoteSystemError) as error:
        generate_title(services, "Полный исходник без изменения.")
    assert error.value.failure_code == "ru_reranker_failed"


def test_external_catalog_change_aborts_instead_of_overwriting_the_new_value():
    catalog = tags(1)

    def mutate(messages, sampling):
        catalog[0]["label"] = "Внешнее изменение"
        return Services.all_candidates(messages, sampling)

    with pytest.raises(NoteSystemError):
        select_tags(Services(mutate), "Полный исходник.", catalog)
    assert catalog[0]["label"] == "Внешнее изменение"


@pytest.mark.parametrize(
    "catalog",
    [
        [{"id": "x", "label": "", "description": ""}],
        [{"id": "x", "label": "тег", "description": "", "gold": True}],
        [
            {"id": "x", "label": "тег", "description": ""},
            {"id": "x", "label": "другой", "description": ""},
        ],
    ],
)
def test_invalid_catalog_fails_before_any_model_is_loaded(catalog):
    services = Services()
    with pytest.raises(NoteSystemError):
        select_tags(services, "Полный исходник.", catalog)
    assert services.models == []


@pytest.mark.parametrize("value", [None, 3, "", " \n ", "NUL\x00text", "bad\ud800text"])
def test_invalid_full_source_has_typed_system_error_before_loading(value):
    services = Services()
    with pytest.raises(NoteSystemError) as error:
        select_tags(services, value, [])
    assert error.value.failure_code == "invalid_ru_pipeline_input"
    assert services.models == services.score_calls == []


@pytest.mark.parametrize(
    "value",
    [
        {"not", "a-list"},
        [{"id": "x", "label": b"bytes", "description": ""}],
        [
            {"id": "x", "label": "same", "description": ""},
            {"id": "y", "label": "same", "description": ""},
        ],
    ],
)
def test_nonserializable_or_duplicate_label_catalog_is_typed_system_failure(value):
    services = Services()
    with pytest.raises(NoteSystemError) as error:
        select_tags(services, "Полный исходник.", value)
    assert error.value.failure_code == "invalid_ru_pipeline_input"
    assert services.models == services.score_calls == []


def test_reranker_cannot_mutate_pair_text_then_publish_a_score():
    def mutate(_engine, pairs):
        pairs[0]["source"] = "Provider replaced original source"
        return [1.0]

    services = Services(scorer=mutate)
    with pytest.raises(NoteSystemError) as error:
        select_tags(services, "Неизменяемый исходник.", tags(1))
    assert error.value.failure_code == "ru_pipeline_input_changed"
