"""Fresh-snapshot retries through real stages, queue and publication boundaries."""

import logging
import os
import uuid

import pytest

from backend.note_faithful_archive import unwrap_source
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.note_generation import create_note
from backend.services.note_generation_queue import NoteGenerationQueue
from test_ru_pipeline_integration import SyntheticServices, runtime_for, seed_archive


SOURCE = "  Синтетическая длинная заметка.\r\n" * 512 + "Точный исходник.  "


def observed_queue(vault, change, *, every_attempt=False):
    seed_archive(vault)
    runtime = runtime_for(vault, SyntheticServices())
    services = []

    def factory(config):
        current = SyntheticServices()
        if every_attempt or not services:
            current.on_link_score = lambda: change(len(services))
        services.append(current)
        return current

    runtime.ru_pipeline_services_factory = factory
    queue = NoteGenerationQueue(
        10, 30,
        lambda source, **kwargs: create_note(
            runtime, source, publication_context=kwargs["publication_context"]
        ),
        runtime.logger,
        notes_dir=vault,
        retry_delays=(0,),
    )
    request = str(uuid.uuid4())
    accepted = queue.enqueue(
        SOURCE.strip(), "local", False, raw_source=SOURCE,
        client_request_id=request,
    )[0]["job"]
    return queue, accepted, services, request


@pytest.mark.parametrize("change", ("delete", "edit", "add"))
def test_archive_change_retries_same_job_with_fresh_links_and_exact_source(
    tmp_path, change,
):
    target = tmp_path / "folder000/Запись.md"

    def mutate(attempt):
        if change == "delete":
            target.unlink()
        elif change == "edit":
            target.write_text("Архивная новая версия. #тег00", encoding="utf-8")
        else:
            (tmp_path / "Добавленная.md").write_text(
                "Архивная добавленная заметка. #тег00", encoding="utf-8"
            )

    queue, accepted, services, request = observed_queue(tmp_path, mutate)
    identifier = accepted["job_id"]
    try:
        assert queue.process_one() is True
        waiting = queue.get_job(identifier)
        assert waiting["status"] == "queued"
        assert waiting["processing_outcome"] == "pending"
        assert waiting["attempts"] == 1 and waiting["retryable"] is True
        assert waiting["processing_error"]["detail_code"] == "archive_unavailable_or_changed"
        assert waiting["prompt_text"] == SOURCE
        assert "result" not in waiting
        assert not list(tmp_path.glob("Синтетический заголовок*.md"))

        assert queue.process_one() is True
        done = queue.get_job(identifier)
        assert done["status"] == "completed" and done["attempts"] == 2
        assert done["processing_outcome"] == "completed"
        assert done["processing_error"] is None and done["retryable"] is False
        assert done["prompt_text"] == SOURCE
        assert done["client_request_id"] == accepted["client_request_id"]
        result = done["result"]
        assert unwrap_source(result["content"]) == SOURCE
        published = tmp_path / (result["title"] + ".md")
        assert published.read_bytes() == result["content"].encode("utf-8")
        expected = [] if change == "delete" else ["folder000/Запись"]
        if change == "add":
            expected.append("Добавленная")
        assert set(result["links"]) == set(expected)
        assert result["generation"]["candidate_count"] == len(expected)
        assert len(list(tmp_path.glob("Синтетический заголовок*.md"))) == 1
        assert done["progress"]["attempt"] == 2
        assert all(row["status"] == "completed" for row in done["progress"]["stages"])
        assert len(services) == 2 and all(item.closed for item in services)
        duplicate = queue.enqueue(
            SOURCE.strip(), "local", False, raw_source=SOURCE,
            client_request_id=request,
        )[0]["job"]
        assert duplicate["job_id"] == identifier
        assert queue.process_one() is False and len(services) == 2
        assert len(queue.store.listing(50)[0]) == 1
    finally:
        assert queue.close()


def test_continual_archive_changes_stop_at_attempt_limit_and_keep_source(tmp_path):
    target = tmp_path / "folder000/Запись.md"

    def mutate(attempt):
        target.write_text(f"Архивная версия {attempt}. #тег00", encoding="utf-8")

    queue, accepted, services, _ = observed_queue(
        tmp_path, mutate, every_attempt=True,
    )
    try:
        for attempt in range(1, 4):
            assert queue.process_one() is True
            state = queue.get_job(accepted["job_id"])
            assert state["attempts"] == attempt
            if attempt < 3:
                assert state["status"] == "queued"
                assert not list(tmp_path.glob("Необработанная заметка*.md"))
        assert state["status"] == "completed"
        assert state["processing_outcome"] == "source_saved"
        assert state["processing_error"]["code"] == "retry_exhausted"
        assert state["processing_error"]["detail_code"] == "archive_unavailable_or_changed"
        fallback = tmp_path / (state["result"]["title"] + ".md")
        assert fallback.read_bytes() == SOURCE.encode("utf-8")
        assert target.read_text(encoding="utf-8") == "Архивная версия 3. #тег00"
        assert state["retry_available"] is True
        assert queue.process_one() is False
        assert len(services) == 3 and all(item.closed for item in services)
        assert len(list(tmp_path.glob("Необработанная заметка*.md"))) == 1
    finally:
        assert queue.close()


@pytest.mark.skipif(os.name != "nt", reason="Strict Windows source-recovery protocol")
def test_manual_recovery_can_retry_archive_change_without_duplicate_or_source_loss(tmp_path):
    target = tmp_path / "folder000/Запись.md"
    queue, accepted, services, _ = observed_queue(tmp_path, lambda _: target.unlink())
    generate = queue._generate_note_payload

    def reject(source, **kwargs):
        raise NoteModelResponseError("Synthetic initial model rejection")

    queue._generate_note_payload = reject
    identifier = accepted["job_id"]
    try:
        assert queue.process_one() is True
        saved = queue.get_job(identifier)
        assert saved["processing_outcome"] == "source_saved"
        original = tmp_path / (saved["result"]["title"] + ".md")
        before = original.stat()
        assert original.read_bytes() == SOURCE.encode("utf-8")
        key = str(uuid.uuid4())
        queue._generate_note_payload = generate
        queue.retry(identifier, client_request_id=key, expected_vault_id=queue.store.vault_id)
        assert queue.process_one() is True
        waiting = queue.get_job(identifier)
        assert waiting["status"] == "queued" and waiting["attempts"] == 1
        assert waiting["recovery_summary"]["status"] == "queued"
        assert original.read_bytes() == SOURCE.encode("utf-8")
        assert queue.process_one() is True
        done = queue.get_job(identifier)
        assert done["processing_outcome"] == "completed" and done["attempts"] == 2
        assert done["result"]["title"] + ".md" == original.name
        assert done["result"]["display_title"] == "Синтетический заголовок четыре"
        assert done["result"]["links"] == []
        assert unwrap_source(original.read_bytes().decode("utf-8")) == SOURCE
        assert original.stat().st_ino == before.st_ino
        assert not target.exists() and len(list(tmp_path.rglob("*.md"))) == 1
        assert len(services) == 2
        replay = queue.retry(
            identifier, client_request_id=key, expected_vault_id=queue.store.vault_id,
        )["job"]
        assert replay["job_id"] == identifier
        assert queue.process_one() is False and len(services) == 2
    finally:
        assert queue.close()


@pytest.mark.parametrize("error", (
    NoteModelResponseError("Synthetic invalid model output"),
    NoteSystemError("Synthetic context limit", failure_code="context_budget_exceeded"),
    NoteSystemError("Synthetic runtime configuration", failure_code="ru_configuration_invalid"),
))
def test_other_permanent_generation_failures_do_not_gain_automatic_retries(tmp_path, error):
    def fail(source, **kwargs):
        raise error

    queue = NoteGenerationQueue(
        10, 30, fail, logging.getLogger(__name__),
        notes_dir=tmp_path, retry_delays=(0,),
    )
    try:
        identifier = queue.enqueue(
            SOURCE.strip(), "local", False, raw_source=SOURCE,
        )[0]["job"]["job_id"]
        assert queue.process_one() is True
        job = queue.get_job(identifier)
        assert job["attempts"] == 1 and job["processing_outcome"] == "source_saved"
        assert job["result"]["content"] == SOURCE
        assert queue.process_one() is False
    finally:
        assert queue.close()
