"""Selected application path with actual stages/publication and synthetic NN only."""

from contextlib import contextmanager
import json
import logging
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import threading
from unittest.mock import Mock
import uuid

from flask import Flask
import pytest

from backend.note_faithful_archive import unwrap_source
from backend.note_generation import create_note
from backend.note_generation_contract import (
    NoteGenerationError,
    extract_note_links,
    extract_note_tags,
)
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.config import PipelineConfig
from backend.ru_pipeline.orchestrator import uses_selected_pipeline
from backend.ru_pipeline.pair_settings import (
    DEFAULT_PAIRS,
    NEW_TAG_PAIRS,
    NewTags,
    save_selection,
    selection_ids,
)
from backend.routes.generation_routes import register_generation_routes
from backend.routes.model_routes import register_model_routes
from backend.services.note_generation_queue import NoteGenerationQueue


class SyntheticServices:
    def __init__(
        self, *, choose_tags=True, choose_links=True, bad_stage=None, fail_score=None
    ):
        self.choose_tags, self.choose_links = choose_tags, choose_links
        self.bad_stage, self.fail_score = bad_stage, fail_score
        self.calls, self.scores, self.events = [], [], []
        self.entered = self.closed = False
        self.title_count = 0
        self.on_link_score = None

    def __enter__(self):
        self.entered = True
        self.events.append("job-enter")
        return self

    def __exit__(self, *args):
        self.closed = True
        self.events.append("job-exit")

    @contextmanager
    def generator(self, key):
        self.events.append(("generator-enter", key))
        try:
            yield self
        finally:
            self.events.append(("generator-exit", key))

    def invoke(self, messages, **parameters):
        payload = json.loads(messages[-1]["content"])
        self.calls.append((payload, parameters))
        if payload.get("relation_review"):
            if "candidate_note" in payload:
                return json.dumps({
                    "relation": "same_subject" if self.choose_links else "none",
                    "source_quote": payload["allowed_source_quotes"][0] if self.choose_links else "",
                    "target_quote": payload["allowed_target_quotes"][0] if self.choose_links else "",
                })
            return json.dumps({row["id"]: {
                "relation": "same_subject" if self.choose_links else "none",
                "source_quote": payload["allowed_source_quotes"][0] if self.choose_links else "",
                "target_quote": row["allowed_target_quotes"][0] if self.choose_links else "",
            } for row in payload["candidate_notes"]})
        if "catalog" in payload:
            values = (
                [row["id"] for row in payload["catalog"]] if self.choose_tags else []
            )
            return json.dumps(
                {"tag_ids": ["not-present"] if self.bad_stage == "tags" else values}
            )
        if "candidates" in payload:
            values = (
                [row["id"] for row in payload["candidates"]]
                if self.choose_links
                else []
            )
            return json.dumps(
                {"linked_ids": ["not-present"] if self.bad_stage == "links" else values}
            )
        self.title_count += 1
        return json.dumps(
            {
                "title": "Синтетический заголовок "
                + ("один", "два", "три", "четыре")[self.title_count - 1]
            },
            ensure_ascii=False,
        )

    def score(self, engine, pairs):
        self.scores.append((engine, pairs))
        self.events.append(("score", engine))
        if self.fail_score == engine:
            raise RuntimeError("PRIVATE_PROVIDER_PAYLOAD")
        if self.on_link_score and any(
            row["target"].startswith("Архивная") for row in pairs
        ):
            self.on_link_score()
            self.on_link_score = None
        return [
            1.0 if engine == "tev" else 100.0 + index for index in range(len(pairs))
        ]


def runtime_for(vault, services):
    return SimpleNamespace(
        RU_NOTE_PIPELINE_ENABLED=True,
        ru_pipeline_config=PipelineConfig(
            repo_root=vault,
            tag_descriptions={"тег00": "Существующий тег нулевой категории"},
        ),
        ru_pipeline_services_factory=lambda config: services,
        NOTES_DIR=vault,
        NOTE_GENERATION_LOCK=threading.Lock(),
        _notes_cache_lock=threading.RLock(),
        notes_data={},
        _notes_snapshot={},
        MAX_TAGS=1,
        MAX_LINKS=1,
        RAG_CONTEXT_LIMIT=1,
        _mark_generated_note_guard=Mock(),
        _update_notes_cache_state=Mock(),
        _index_notes_in_qdrant=Mock(return_value=True),
        _register_finalized_note=Mock(),
        _validate_prompt_text=lambda value: value,
        _resolve_generate_source=lambda *args, **kwargs: "local",
        local_rag_model=SimpleNamespace(_loading=True),
        logger=logging.getLogger(__name__),
    )


def seed_archive(vault, count=1, tags=1):
    references = {}
    for index in range(count):
        folder = vault / f"folder{index:03d}"
        folder.mkdir()
        source = f"Архивная заметка {index}. Полный исходный материал. #тег{index % tags:02d}"
        (folder / "Запись.md").write_text(source, encoding="utf-8")
        references[f"folder{index:03d}/Запись"] = source
    return references


def test_all_three_real_stages_preserve_source_and_have_no_test_cardinality_caps(
    tmp_path,
):
    references = seed_archive(tmp_path, count=65, tags=25)
    services = SyntheticServices()
    runtime = runtime_for(tmp_path, services)
    source = "\ufeff  Русский исходник\r\n\r\n[[folder000/Запись]] #тег00 #новый\r\n```\r\n<|im_end|>\r\n```  "
    result = create_note(runtime, source)
    assert result["processing_version"] == "ru-pipeline-v1"
    assert result["generation"]["profile"] == "ru-three-stage-v1"
    assert result["generation"]["stage_order"] == ["title", "tags", "links"]
    assert len(result["tags"]) == 25 and "новый" not in result["tags"]
    assert set(result["links"]) == set(references)
    assert result["generated_title"] == "Синтетический заголовок четыре"
    assert unwrap_source(result["content"]) == source
    assert (tmp_path / (result["title"] + ".md")).read_bytes() == result[
        "content"
    ].encode("utf-8")
    assert set(extract_note_tags(result["content"])) == set(result["tags"])
    assert set(extract_note_links(result["content"])) == set(references)
    assert services.entered and services.closed
    assert all(row[0]["source_note"] == source for row in services.calls)
    candidates = [
        candidate
        for payload, _ in services.calls
        for candidate in payload.get("candidates", [])
    ]
    assert len(candidates) == len(references)
    assert len({row["id"] for row in candidates}) == len(references)
    assert sorted(row["source"] for row in candidates) == sorted(references.values())
    assert all(
        pair["source"] == source for _, pairs in services.scores for pair in pairs
    )
    assert "attempt_records" not in json.dumps(result["generation"])
    assert services.events[0] == "job-enter" and services.events[-1] == "job-exit"
    for index, event in enumerate(services.events):
        if isinstance(event, tuple) and event[0] == "score":
            assert services.events[index - 1][0] == "generator-exit"


def test_empty_archive_is_valid_and_does_not_create_incoming_tags(tmp_path):
    services = SyntheticServices()
    result = create_note(
        runtime_for(tmp_path, services), "Новый русский исходник #новый"
    )
    assert result["tags"] == [] and result["links"] == []
    assert result["generation"]["tag_catalog_count"] == 0
    assert result["generation"]["candidate_count"] == 0
    assert len(services.calls) == 4
    assert [engine for engine, _ in services.scores] == ["mmarco"]


@pytest.mark.parametrize("pair", NEW_TAG_PAIRS)
def test_experimental_generation_uses_actual_applied_tags_and_publishes_only_accepted(
    tmp_path, pair,
):
    class NewTagServices(SyntheticServices):
        def invoke(self, messages, **parameters):
            payload = json.loads(messages[-1]["content"])
            if payload.get("tag_topic_review"):
                assert payload["source_note"] == source
                return json.dumps({"selection": {"existing": [], "new": [
                    row["id"] for row in payload["proposed_new_tags"]
                ]}})
            if "applied_tags" not in payload:
                return super().invoke(messages, **parameters)
            self.calls.append((payload, parameters))
            assert payload["source_note"] == source
            assert [row["label"] for row in payload["applied_tags"]] == ["тег00"]
            assert [row["label"] for row in payload["catalog"]] == ["тег00", "тег01"]
            if len([call for call, _ in self.calls if "applied_tags" in call]) == 1:
                return '{"new":[{"label":"坏","description":"Ошибочный алфавит"}]}'
            return json.dumps({"new": [
                {"label": "ТЕГ00", "description": "Повтор выставленного"},
                {"label": "тег01", "description": "Повтор невставленного"},
                {"label": "Сбор дождевой воды", "description": "Сбор осадков в бак"},
                {"label": "Сбор-дождевой-воды", "description": "Повтор кандидата"},
                {"label": "Случайная деталь", "description": "Не проходит порог"},
            ]}, ensure_ascii=False)

        def score(self, engine, pairs):
            if engine == pair.scorer_engine("new_tags") and pairs[0]["target"].startswith("Сбор"):
                self.scores.append((engine, pairs))
                assert self.events[-1] == ("generator-exit", pair.generator)
                return [1.0, -10.0]
            return super().score(engine, pairs)

    seed_archive(tmp_path, count=2, tags=2)
    services = NewTagServices(choose_tags=False)
    runtime = runtime_for(tmp_path, services)
    save_selection(runtime.ru_pipeline_config.runtime_dir, DEFAULT_PAIRS, NewTags(True, pair))
    source = "Проект сбора дождевой воды. #тег00"
    result = create_note(runtime, source)
    assert result["tags"] == ["тег00", "сбор_дождевой_воды"]
    assert extract_note_tags(result["content"]) == result["tags"]
    assert unwrap_source(result["content"]) == source
    assert result["generation"]["stage_order"] == ["title", "tags", "new_tags", "links"]
    assert result["generation"]["stage_pairs"]["new_tags"] == pair.id
    assert result["generation"]["stages"]["new_tags"]["retry_count"] == 1
    assert result["generation"]["stages"]["new_tags"]["candidate_count"] == 2


def test_existing_authored_metadata_is_kept_without_creating_a_tag(tmp_path):
    seed_archive(tmp_path)
    services = SyntheticServices(choose_tags=False, choose_links=False)
    source = "Русский текст [[folder000/Запись.md]] [[Нет такой заметки]] #тег00 #новый"
    result = create_note(runtime_for(tmp_path, services), source)
    assert result["tags"] == ["тег00"]
    assert result["links"] == ["folder000/Запись"]
    assert unwrap_source(result["content"]) == source


def test_closed_catalog_keeps_exact_existing_label_spelling(tmp_path):
    from backend.ru_pipeline.orchestrator import render_source

    (tmp_path / "Known.md").write_text(
        render_source("Архивный исходник", "Известная заметка", ["API"], []),
        encoding="utf-8",
    )
    services = SyntheticServices(choose_tags=False, choose_links=False)
    result = create_note(
        runtime_for(tmp_path, services), "Русский исходник #api #новый"
    )
    assert result["tags"] == ["API"]
    catalog = next(
        payload["catalog"] for payload, _ in services.calls if "catalog" in payload
    )
    assert [row["label"] for row in catalog] == ["API"]


@pytest.mark.parametrize("stage", ["tags", "links"])
def test_failed_stage_cannot_publish_partial_metadata(tmp_path, stage):
    seed_archive(tmp_path)
    before = set(tmp_path.rglob("*.md"))
    services = SyntheticServices(bad_stage=stage)
    with pytest.raises(NoteModelResponseError):
        create_note(runtime_for(tmp_path, services), "Русский исходник")
    assert set(tmp_path.rglob("*.md")) == before
    assert services.closed


def test_archive_mutation_rejects_publication(tmp_path):
    seed_archive(tmp_path)
    services = SyntheticServices()
    target = tmp_path / "folder000/Запись.md"
    services.on_link_score = lambda: target.write_text(
        "Архив изменён другим пользователем", encoding="utf-8"
    )
    with pytest.raises(NoteSystemError, match="Архив|Исходник"):
        create_note(runtime_for(tmp_path, services), "Русский исходник")
    assert len(list(tmp_path.rglob("*.md"))) == 1
    assert services.closed


def test_http_routes_real_pipeline_and_keeps_origin_guard(tmp_path):
    seed_archive(tmp_path)
    services = SyntheticServices()
    runtime = runtime_for(tmp_path, services)
    runtime._generate_note_payload = lambda prompt, **kwargs: create_note(
        runtime, prompt, mode=kwargs.get("mode", "organize")
    )
    app = Flask(__name__)
    register_generation_routes(app, SimpleNamespace(module=runtime))
    client = app.test_client()
    blocked = client.post(
        "/generate",
        json={"prompt": "Русский исходник"},
        headers={"Origin": "https://foreign.example"},
    )
    assert blocked.status_code == 403 and not services.calls
    source = "  Русский исходник\r\n#новый  "
    response = client.post("/generate", json={"prompt": source})
    assert response.status_code == 201
    assert response.json["generation"]["profile"] == "ru-three-stage-v1"
    assert unwrap_source(response.json["content"]) == source


@pytest.mark.parametrize("reranker", ["mmarco", "qwen"])
def test_saved_pairs_drive_next_note_through_every_real_stage(tmp_path, reranker):
    seed_archive(tmp_path, count=2, tags=2)

    class CalibrationScores(SyntheticServices):
        def score(self, engine, pairs):
            scores = super().score(engine, pairs)
            if pairs[0]["target"].startswith("Синтетический заголовок"):
                save_selection(runtime.ru_pipeline_config.runtime_dir, DEFAULT_PAIRS)
            if engine == "qwen_title":
                return [0.1, 0.2, 0.3, 0.9]
            if engine == "qwen_tags":
                return [0.43806201333608696, 0.4380620133360869]
            if engine == "qwen_links":
                return [0.9840936082881853, 0.9840936082881852]
            if pairs[0]["target"].startswith("тег"):
                return [-4.003677845001221, -4.003677845001222]
            return scores

    services = CalibrationScores()
    runtime = runtime_for(tmp_path, services)
    runtime._make_json_safe = lambda payload: payload
    runtime._generate_note_payload = lambda prompt, **kwargs: create_note(
        runtime, prompt
    )
    app = Flask(__name__)
    deps = SimpleNamespace(module=runtime)
    register_model_routes(app, deps)
    register_generation_routes(app, deps)
    client = app.test_client()
    selection = {
        "title": f"qwen35_4b_{reranker}",
        "tags": f"qwen25_3b_{reranker}",
        "links": f"qwen25_3b_{reranker}",
    }
    assert client.post("/runtime/note-pipeline", json=selection).status_code == 200
    source = "  Русский исходник\r\n#новый  "
    response = client.post("/generate", json={"prompt": source})
    assert response.status_code == 201
    assert response.json["generation"]["stage_pairs"] == selection
    assert (
        response.json["generation"]["title_generation_strategy"]
        == f"qwen35-4b-{reranker}-v1"
    )
    assert response.json["tags"] == ["тег00"]
    assert len(response.json["links"]) == (1 if reranker == "qwen" else 2)
    assert unwrap_source(response.json["content"]) == source
    assert [
        key for event, key in services.events[1:-1] if event == "generator-enter"
    ] == [
        "qwen35_4b",
        "qwen25_3b",
        "qwen25_3b",
    ]
    expected_engines = (
        ["qwen_title", "qwen_tags", "qwen_links"]
        if reranker == "qwen"
        else ["mmarco"] * 3
    )
    assert [engine for engine, _ in services.scores] == expected_engines
    assert client.get("/runtime/config").json["note_pipeline"][
        "selection"
    ] == selection_ids(DEFAULT_PAIRS)


def test_unreadable_pair_selection_stops_before_publication(tmp_path):
    services = SyntheticServices()
    runtime = runtime_for(tmp_path, services)
    folder = runtime.ru_pipeline_config.runtime_dir
    folder.mkdir(parents=True)
    (folder / "stage-pairs.json").write_text("{}", encoding="utf-8")
    with pytest.raises(NoteSystemError) as exc:
        create_note(runtime, "Русский исходник")
    assert exc.value.failure_code == "ru_configuration_invalid"
    assert not services.entered and not list(tmp_path.rglob("*.md"))


def test_http_provider_failure_is_classified_without_private_payload(tmp_path):
    seed_archive(tmp_path)
    services = SyntheticServices(fail_score="tev")
    runtime = runtime_for(tmp_path, services)
    runtime._generate_note_payload = lambda prompt, **kwargs: create_note(
        runtime, prompt
    )
    app = Flask(__name__)
    register_generation_routes(app, SimpleNamespace(module=runtime))
    response = app.test_client().post("/generate", json={"prompt": "Русский исходник"})
    assert response.status_code == 503
    assert response.json["failure_kind"] == "system"
    assert "PRIVATE_PROVIDER_PAYLOAD" not in response.get_data(as_text=True)
    assert len(list(tmp_path.rglob("*.md"))) == 1


def test_durable_queue_publication_and_idempotent_replay_use_selected_stages(tmp_path):
    seed_archive(tmp_path)
    services = SyntheticServices()
    runtime = runtime_for(tmp_path, services)
    queue = NoteGenerationQueue(
        10,
        30,
        lambda source, **kwargs: create_note(
            runtime,
            source,
            publication_context=kwargs["publication_context"],
            mode=kwargs.get("mode", "organize"),
        ),
        runtime.logger,
        notes_dir=tmp_path,
    )
    request_id = str(uuid.uuid4())
    source = "  Русский исходник\r\n#тег00  "
    try:
        item = queue.enqueue(
            source.strip(),
            "local",
            False,
            raw_source=source,
            client_request_id=request_id,
        )[0]
        identifier = item["job"]["job_id"]
        assert queue.process_one() is True
        job = queue.get_job(identifier)
        assert job["status"] == "completed"
        assert job["result"]["generation"]["profile"] == "ru-three-stage-v1"
        assert unwrap_source(job["result"]["content"]) == source
        calls = len(services.calls)
        replay = queue.enqueue(
            source.strip(),
            "local",
            False,
            raw_source=source,
            client_request_id=request_id,
        )[0]
        assert replay["job"]["job_id"] == identifier
        assert queue.process_one() is False and len(services.calls) == calls
        assert len(list(tmp_path.rglob("*.md"))) == 2
    finally:
        queue.close()


def test_queue_failure_saves_only_original_source_as_pending(tmp_path):
    seed_archive(tmp_path)
    services = SyntheticServices(bad_stage="links")
    runtime = runtime_for(tmp_path, services)
    queue = NoteGenerationQueue(
        10,
        30,
        lambda source, **kwargs: create_note(
            runtime, source, publication_context=kwargs["publication_context"]
        ),
        runtime.logger,
        notes_dir=tmp_path,
    )
    source = "  Русский исходник\r\n#тег00  "
    try:
        identifier = queue.enqueue(source.strip(), "local", False, raw_source=source)[
            0
        ]["job"]["job_id"]
        queue.process_one()
        result = queue.get_job(identifier)["result"]
        assert result["generation"]["metadata_pending"] is True
        assert result["generation"]["failure_kind"] == "model_response"
        assert result["tags"] == [] and result["links"] == []
        assert result["content"] == source
        assert (tmp_path / (result["title"] + ".md")).read_bytes() == source.encode(
            "utf-8"
        )
    finally:
        queue.close()


def test_explicitly_disabled_or_absent_selected_pipeline_preserves_legacy(
    tmp_path, monkeypatch
):
    import backend.note_generation as generation

    runtime = runtime_for(tmp_path, SyntheticServices())
    marker = {"legacy": True}
    legacy = Mock(return_value=marker)
    monkeypatch.setattr(generation, "create_faithful_note", legacy)
    runtime.RU_NOTE_PIPELINE_ENABLED = False
    assert create_note(runtime, "English source note") is marker
    assert create_note(runtime, "Русский исходник") is marker
    del runtime.RU_NOTE_PIPELINE_ENABLED
    assert create_note(runtime, "Русский исходник") is marker
    assert legacy.call_count == 3
    runtime.RU_NOTE_PIPELINE_ENABLED = "false"
    with pytest.raises(NoteSystemError):
        uses_selected_pipeline(runtime, "Русский исходник")


def test_invalid_trusted_configuration_or_services_cannot_publish(tmp_path):
    runtime = runtime_for(tmp_path, SyntheticServices())
    runtime.ru_pipeline_config = {}
    with pytest.raises(NoteSystemError, match="настройки"):
        create_note(runtime, "Русский исходник")
    runtime.ru_pipeline_config = PipelineConfig(repo_root=tmp_path)
    runtime.ru_pipeline_services_factory = None
    with pytest.raises(NoteSystemError, match="недоступен"):
        create_note(runtime, "Русский исходник")
    assert not list(tmp_path.glob("*.md"))


def test_adapter_cannot_return_unknown_selected_tags(tmp_path, monkeypatch):
    import backend.ru_pipeline.methods as methods

    seed_archive(tmp_path)
    monkeypatch.setattr(
        methods,
        "select_tags",
        lambda *args, **kwargs: {"tags": ["неизвестный"], "attempts": 0},
    )
    with pytest.raises(NoteModelResponseError, match="закрытый набор"):
        create_note(runtime_for(tmp_path, SyntheticServices()), "Русский исходник")
    assert len(list(tmp_path.rglob("*.md"))) == 1


def test_invalid_stage_accounting_cannot_claim_success(tmp_path, monkeypatch):
    import backend.ru_pipeline.methods as methods

    monkeypatch.setattr(
        methods, "select_tags", lambda *args, **kwargs: {"tags": [], "attempts": -1}
    )
    with pytest.raises(NoteSystemError, match="сведения о выполнении"):
        create_note(runtime_for(tmp_path, SyntheticServices()), "Русский исходник")
    assert not list(tmp_path.glob("*.md"))


@pytest.mark.parametrize("source", [None, 42, "", " \r\n "])
def test_direct_pipeline_rejects_empty_or_nontext_source(tmp_path, source):
    from backend.ru_pipeline.orchestrator import create_ru_note

    services = SyntheticServices()
    with pytest.raises(NoteGenerationError, match="непустой исходный"):
        create_ru_note(runtime_for(tmp_path, services), source)
    assert not services.entered and not list(tmp_path.glob("*.md"))


@pytest.mark.parametrize("enabled", [True, False])
def test_actual_bootstrap_readiness_and_legacy_warmup(tmp_path, monkeypatch, enabled):
    class BootstrapQueue(NoteGenerationQueue):
        def start(self):
            return None

    monkeypatch.setenv("NODA_RU_PIPELINE_ENABLED", "1" if enabled else "0")
    initialized = Mock(return_value={"status": "synthetic"})
    monkeypatch.setitem(
        sys.modules, "model_init", SimpleNamespace(initialize_local_model=initialized)
    )
    model = SimpleNamespace(_loading=True, load_model=Mock(return_value=True))
    module = ModuleType("synthetic_ru_bootstrap")
    module.__dict__.update(
        GENERATE_QUEUE_MAX_SIZE=10,
        GENERATE_QUEUE_JOB_TTL_SECONDS=30,
        NoteGenerationQueue=BootstrapQueue,
        logger=logging.getLogger(__name__),
        NOTES_DIR=tmp_path,
        _PROJECT_CONFIGURATION=None,
        local_rag_model=model,
        _routes_registered=True,
        IS_TEST_ENV=False,
        sys=sys,
    )
    monkeypatch.setitem(sys.modules, module.__name__, module)
    path = Path("backend/runtime_layers/11_generate_note_payload.py")
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), module.__dict__)
    try:
        assert module.RU_NOTE_PIPELINE_ENABLED is enabled
        assert module.note_generation_queue._generation_ready() is enabled
        assert initialized.call_count == (0 if enabled else 1)
        assert model.load_model.call_count == (0 if enabled else 1)
    finally:
        module.note_generation_queue.close()
