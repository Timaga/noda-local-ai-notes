"""Durable observations surround the actual selected-stage validation boundary."""

from copy import deepcopy

import pytest

from backend.note_faithful_archive import unwrap_source
from backend.note_generation import create_note
from backend.note_generation_contract import extract_note_links, extract_note_tags
from backend.note_publication import PublicationContext
from backend.ru_pipeline import methods
from backend.ru_pipeline.pair_settings import DEFAULT_PAIRS, NewTags, save_selection
from backend.note_processing_failures import NoteSystemError
from backend.services.note_generation_queue import NoteGenerationQueue
from test_ru_pipeline_integration import SyntheticServices, runtime_for, seed_archive


def run_observed(tmp_path, monkeypatch, *, bad_stage=None, enabled=None):
    seed_archive(tmp_path)
    services = SyntheticServices(bad_stage=bad_stage)
    runtime = runtime_for(tmp_path, services)
    source = "Синтетический исходник. Проверить тормоза велосипеда."
    if enabled is not None:
        save_selection(runtime.ru_pipeline_config.runtime_dir, DEFAULT_PAIRS,
                       NewTags(enabled=True), stage_enabled=enabled)
        source += "\r\n#тег00 [[folder000/Запись]]\r\n"
        if not any(enabled.values()):
            def unexpected_factory(config):
                pytest.fail("No model services should open with all stages disabled")
            runtime.ru_pipeline_services_factory = unexpected_factory
    observations = []
    original = PublicationContext.report_stage

    def report(context, identifier, state):
        original(context, identifier, state)
        observations.append(
            (identifier, state, deepcopy(context.store.get(context.job_id)["progress"]))
        )

    monkeypatch.setattr(PublicationContext, "report_stage", report)
    queue = NoteGenerationQueue(
        10,
        30,
        lambda text, **kwargs: create_note(
            runtime, text, publication_context=kwargs["publication_context"]
        ),
        runtime.logger,
        notes_dir=tmp_path,
    )
    try:
        identifier = queue.enqueue(source.strip(), "local", False, raw_source=source)[0]["job"]["job_id"]
        assert queue.process_one() is True
        job = queue.get_job(identifier)
        return job, observations, source
    finally:
        assert queue.close()


def test_selected_real_stages_and_atomic_publication_report_in_order(
    tmp_path, monkeypatch
):
    job, observations, source = run_observed(tmp_path, monkeypatch)
    assert [(stage, state) for stage, state, _ in observations] == [
        (stage, state)
        for stage in ("title", "tags", "links", "save")
        for state in ("running", "completed")
    ]
    assert job["processing_outcome"] == "completed"
    assert all(stage["status"] == "completed" for stage in job["progress"]["stages"])
    assert unwrap_source(job["result"]["content"]) == source
    assert job["result"]["generation"]["stage_pairs"] == {
        "title": "qwen25_3b_mmarco",
        "tags": "qwen35_4b_tev",
        "links": "qwen35_4b_mmarco",
    }
    for identifier, state, progress in observations:
        stage = next(row for row in progress["stages"] if row["id"] == identifier)
        assert stage["status"] == state
        assert progress["current_stage"] == (identifier if state == "running" else None)


@pytest.mark.parametrize("off", [("title",), ("tags",), ("links",), ("title", "tags", "links")])
def test_disabled_stages_publish_without_their_model_or_metadata(tmp_path, monkeypatch, off):
    from backend.ru_pipeline import new_tag_stage

    def no_call(*args, **kwargs):
        pytest.fail("A disabled stage was called")

    def no_new_tags(*args, **kwargs):
        return {"tags": [], "attempts": 0}

    for stage, method in (("title", "generate_title"), ("tags", "select_tags"), ("links", "select_links")):
        if stage in off:
            monkeypatch.setattr(methods, method, no_call)
    monkeypatch.setattr(new_tag_stage, "create_new_tags", no_call if "tags" in off else no_new_tags)
    job, observations, source = run_observed(
        tmp_path, monkeypatch, enabled={stage: stage not in off for stage in DEFAULT_PAIRS},
    )
    assert job["processing_outcome"] == "completed"
    assert {row["id"]: row["status"] for row in job["progress"]["stages"]} == {
        stage: ("skipped" if stage in off else "completed")
        for stage in (*DEFAULT_PAIRS, "save")
    }
    assert [(stage, state) for stage, state, _ in observations if state == "skipped"] == [
        (stage, "skipped") for stage in off
    ]
    result = job["result"]
    assert result["generation"]["skipped_stages"] == list(off)
    assert result["generation"]["title_model_call_count"] == (0 if "title" in off else 4)
    if "title" in off:
        assert result["display_title"] == source[:28].rstrip()
    assert extract_note_tags(result["content"]) == ([] if "tags" in off else ["тег00"])
    assert extract_note_links(result["content"]) == ([] if "links" in off else ["folder000/Запись"])
    assert unwrap_source(result["content"]) == source


@pytest.mark.parametrize("bad_stage", ["title", "title_diagnostics", "tags", "links"])
def test_rejected_stage_does_not_report_success_or_later_model_work(
    tmp_path, monkeypatch, bad_stage
):
    if bad_stage.startswith("title"):
        monkeypatch.setattr(
            methods,
            "generate_title",
            lambda *args, **kwargs: {
                "title": "" if bad_stage == "title" else "Заголовок",
                "attempts": True,
            },
        )
    failed = "title" if bad_stage.startswith("title") else bad_stage
    job, observations, source = run_observed(tmp_path, monkeypatch, bad_stage=bad_stage)
    assert job["processing_outcome"] == "source_saved"
    stages = {row["id"]: row["status"] for row in job["progress"]["stages"]}
    assert stages[failed] == "failed"
    assert stages["save"] == "completed"
    assert job["result"]["generation"]["metadata_pending"] is True
    assert job["result"]["content"] == source
    assert (failed, "completed") not in [
        (stage, state) for stage, state, _ in observations
    ]
    stage_order = ("title", "tags", "links")
    assert all(
        stages[stage] == "pending"
        for stage in stage_order[stage_order.index(failed) + 1 :]
    )


class CapturedDraft(RuntimeError):
    def __init__(self, draft):
        self.draft = draft


class RetryContext:
    excluded_note_identity = "folder000/Запись"

    def publish(self, vault, draft, **kwargs):
        raise CapturedDraft(draft)


def test_retry_excludes_only_its_own_identity_and_preserves_source(tmp_path):
    seed_archive(tmp_path, count=2, tags=2)
    services = SyntheticServices()
    runtime = runtime_for(tmp_path, services)
    source = "Исходник [[folder000/Запись]] и [[folder001/Запись]]."
    with pytest.raises(CapturedDraft) as caught:
        create_note(runtime, source, publication_context=RetryContext())
    draft = caught.value.draft
    assert draft["links"] == ["folder001/Запись"]
    assert set(draft["tags"]) == {"тег00", "тег01"}
    assert unwrap_source(draft["content"]) == source
    assert draft["generation"]["candidate_count"] == 1


def test_retry_still_rejects_a_change_to_the_excluded_source_file(tmp_path):
    seed_archive(tmp_path, count=2, tags=2)
    services = SyntheticServices()
    services.on_link_score = lambda: (tmp_path / "folder000/Запись.md").write_text(
        "Изменено пользователем", encoding="utf-8"
    )
    with pytest.raises(NoteSystemError) as caught:
        create_note(
            runtime_for(tmp_path, services),
            "Исходник",
            publication_context=RetryContext(),
        )
    assert caught.value.failure_code == "archive_unavailable_or_changed"


@pytest.mark.parametrize("identifier", ["нет такой заметки", 123])
def test_invalid_internal_retry_identity_fails_before_models(tmp_path, identifier):
    seed_archive(tmp_path)
    services, context = SyntheticServices(), RetryContext()
    context.excluded_note_identity = identifier
    with pytest.raises(NoteSystemError) as caught:
        create_note(
            runtime_for(tmp_path, services), "Исходник", publication_context=context
        )
    assert caught.value.failure_code == "publication_failed" and services.calls == []
