"""Native Windows same-file retries with durable crash and conflict controls."""

from concurrent.futures import ThreadPoolExecutor
import logging
import os
from pathlib import Path
import sqlite3
import uuid

import pytest

from backend.note_faithful_archive import unwrap_source
from backend.note_processing_failures import NoteSystemError
from backend.ru_pipeline.orchestrator import render_source
from backend.services.note_generation_queue import NoteGenerationQueue
from backend.services.note_job_store import JobError
from backend.services.source_note_recovery import SourceRecoveryContext


pytestmark = pytest.mark.skipif(
    os.name != "nt", reason="Strict Windows file sharing protocol"
)
RAW = "  Синтетический исходник\r\nСохранить точный текст.  "


def failed_generation(source, *, publication_context, **kwargs):
    publication_context.report_stage("title", "running")
    publication_context.report_stage("title", "completed")
    publication_context.report_stage("tags", "running")
    publication_context.report_stage("tags", "completed")
    publication_context.report_stage("links", "running")
    raise NoteSystemError(
        "Synthetic stage failure", failure_code="context_budget_exceeded"
    )


def queue_for(vault, generate=failed_generation, **kwargs):
    return NoteGenerationQueue(
        10,
        30,
        generate,
        logging.getLogger("source-recovery"),
        notes_dir=vault,
        **kwargs
    )


def saved_source(vault):
    queue = queue_for(vault)
    job = queue.enqueue(
        RAW.strip(), "local", False, raw_source=RAW, client_request_id=str(uuid.uuid4())
    )[0]["job"]
    queue.process_one()
    state = queue.store.get(job["job_id"])
    assert state["result"]["generation"]["metadata_pending"] is True
    target = vault / state["target"]
    assert target.read_bytes() == RAW.encode("utf-8")
    return queue, state, target


def generated(source):
    return {
        "title": "Новый смысловой заголовок",
        "generated_title": "Новый смысловой заголовок",
        "display_title": "Новый смысловой заголовок",
        "content": render_source(source, "Новый смысловой заголовок", [], []),
        "tags": [],
        "links": [],
        "generation": {"profile": "ru-three-stage-v1"},
    }


def successful(vault, calls=None):
    def generate(source, *, publication_context, **kwargs):
        if calls is not None:
            calls.append(source)
        assert isinstance(publication_context, SourceRecoveryContext)
        assert publication_context.excluded_note_identity.startswith(
            "Необработанная заметка "
        )
        for stage in ("title", "tags", "links"):
            publication_context.report_stage(stage, "running")
            publication_context.report_stage(stage, "completed")
        draft = generated(source)
        target = publication_context.publish(vault, draft)
        return dict(draft, title=target.stem)

    return generate


def retry(queue, job_id, key=None):
    return queue.retry(
        job_id,
        client_request_id=key or str(uuid.uuid4()),
        expected_vault_id=queue.store.vault_id,
    )


def version(queue):
    return queue.store._connection.execute("PRAGMA user_version").fetchone()[0]


def test_retry_same_identity_and_receipt_with_exact_source_and_no_duplicate(tmp_path):
    queue, old, target = saved_source(tmp_path)
    calls = []
    queue._generate_note_payload = successful(tmp_path, calls)
    key = str(uuid.uuid4())
    before = target.stat()
    try:
        assert version(queue) == 1
        assert queue.get_job(old["job_id"])["retry_available"] is True
        accepted = retry(queue, old["job_id"], key)["job"]
        assert accepted["job_id"] == old["job_id"] and accepted["status"] == "queued"
        assert (
            accepted["processing_outcome"] == "pending"
            and accepted["processing_error"] is None
        )
        assert "result" not in accepted and accepted["progress"]["attempt"] == 0
        assert version(queue) == 2
        assert retry(queue, old["job_id"], key)["job"]["job_id"] == old["job_id"]
        assert queue.process_one() is True
        done = queue.get_job(old["job_id"])
        assert (
            done["processing_outcome"] == "completed"
            and done["retry_available"] is False
        )
        assert done["result"]["title"] + ".md" == target.name
        assert done["result"]["display_title"] == "Новый смысловой заголовок"
        assert done["client_request_id"] == old["client_request_id"]
        assert done["created_at"] == old["created_at"] and done["prompt_text"] == RAW
        assert unwrap_source(target.read_bytes().decode("utf-8")) == RAW
        assert (
            target.stat().st_ino == before.st_ino
            and target.stat().st_dev == before.st_dev
        )
        assert len(list(tmp_path.glob("*.md"))) == 1 and calls == [RAW]
        assert len(queue.store.listing(50)[0]) == 1
        assert version(queue) == 1
        assert all(item["status"] == "completed" for item in done["progress"]["stages"])
        assert (
            retry(queue, old["job_id"], key)["job"]["processing_outcome"] == "completed"
        )
        with pytest.raises(JobError, match="Повтор доступен"):
            retry(queue, old["job_id"])
    finally:
        queue.close()


def test_cleanup_of_successful_retry_preserves_edited_file_and_idempotency(tmp_path):
    queue, job, target = saved_source(tmp_path)
    key = str(uuid.uuid4())
    try:
        queue._generate_note_payload = successful(tmp_path)
        retry(queue, job["job_id"], key)
        assert queue.process_one() is True
        queue.store.update(job["job_id"], index_pending=False)
        published = target.read_bytes()
        backup = queue.store.prepared / (job["job_id"] + ".source-backup")
        assert backup.read_bytes() == RAW.encode("utf-8")
        target.write_bytes(b"An external edit")
        assert queue.store.cleanup_history() == 0
        assert target.read_bytes() == b"An external edit"
        assert backup.exists()
        target.write_bytes(published)
        assert queue.store.cleanup_history() == 1
        assert not backup.exists()
        assert target.read_bytes() == published
        assert version(queue) == 3
        archived = retry(queue, job["job_id"], key)["job"]
        assert archived["archived"] is True
        assert archived["recovery_summary"]["request_id"] == uuid.UUID(key).hex
        assert "result" not in archived
    finally:
        queue.close()


class SyntheticCrash(BaseException):
    pass


@pytest.mark.parametrize(
    "checkpoint",
    [
        "before_prepare",
        "before_intent",
        "after_intent",
        "after_write",
        "after_published",
        "after_completed",
    ],
)
def test_crash_checkpoint_recovery_reuses_prepared_result_without_new_model_call(
    tmp_path, monkeypatch, checkpoint
):
    from backend.services import windows_note_file as adapter

    queue, old, target = saved_source(tmp_path)
    calls = []
    queue._generate_note_payload = successful(tmp_path, calls)
    retry(queue, old["job_id"])
    original_update = queue.store.update
    original_write = adapter._LockedNote.write_all

    def interrupted_prepare(self, job):
        raise SyntheticCrash()

    def interrupted_write(self, data):
        if checkpoint == "after_write":
            original_write(self, data)
        raise SyntheticCrash()

    def interrupted_update(job_id, **changes):
        phase = changes.get("phase")
        if checkpoint == "before_intent" and phase == "publish_intent":
            raise SyntheticCrash()
        if checkpoint == "after_write" and phase == "published":
            raise SyntheticCrash()
        result = original_update(job_id, **changes)
        if checkpoint == "after_published" and phase == "published":
            raise SyntheticCrash()
        if checkpoint == "after_completed" and phase == "completed":
            raise SyntheticCrash()
        return result

    with monkeypatch.context() as fault:
        fault.setattr(queue.store, "update", interrupted_update)
        if checkpoint == "before_prepare":
            fault.setattr(SourceRecoveryContext, "_prepare", interrupted_prepare)
        if checkpoint == "after_intent":
            fault.setattr(adapter._LockedNote, "write_all", interrupted_write)
        with pytest.raises(SyntheticCrash):
            queue.process_one()
    assert len(calls) == 1
    if checkpoint in ("before_prepare", "before_intent", "after_intent"):
        assert target.read_bytes() == RAW.encode("utf-8")
    else:
        assert unwrap_source(target.read_bytes().decode("utf-8")) == RAW
    queue.close()
    queue = queue_for(
        tmp_path,
        lambda *a, **k: pytest.fail("A prepared result must not run the model again"),
    )
    try:
        assert queue.process_one() is (checkpoint != "after_completed")
        done = queue.get_job(old["job_id"])
        assert (
            done["processing_outcome"] == "completed"
            and done["recovery_summary"]["status"] == "completed"
        )
        assert unwrap_source(target.read_bytes().decode("utf-8")) == RAW
        assert len(list(tmp_path.glob("*.md"))) == 1 and version(queue) == 1
    finally:
        queue.close()


def test_partial_write_crash_preserves_durable_source_and_stops_on_unknown_bytes(
    tmp_path, monkeypatch
):
    from backend.services import windows_note_file as adapter

    queue, old, target = saved_source(tmp_path)
    queue._generate_note_payload = successful(tmp_path)
    retry(queue, old["job_id"])

    def partial(self, data):
        os.lseek(self._descriptor, 0, os.SEEK_SET)
        os.write(self._descriptor, data[:17])
        os.fsync(self._descriptor)
        raise SyntheticCrash()

    with monkeypatch.context() as fault:
        fault.setattr(adapter._LockedNote, "write_all", partial)
        with pytest.raises(SyntheticCrash):
            queue.process_one()
    unknown = target.read_bytes()
    queue.close()
    queue = queue_for(
        tmp_path,
        lambda *a, **k: pytest.fail("Unknown partial file cannot rerun a model"),
    )
    try:
        queue.process_one()
        done = queue.get_job(old["job_id"])
        assert done["status"] == "failed" and done["phase"] == "publication_unknown"
        assert (
            done["recovery_summary"]["status"] == "conflict"
            and done["retry_available"] is False
        )
        assert done["prompt_text"] == RAW and target.read_bytes() == unknown
        assert queue.store.prepared.joinpath(
            old["job_id"] + ".source-backup"
        ).read_bytes() == RAW.encode("utf-8")
        assert version(queue) == 2 and len(list(tmp_path.glob("*.md"))) == 1
        assert queue.process_one() is False
    finally:
        queue.close()


def test_retry_obeys_queue_capacity_without_changing_receipt_or_version(tmp_path):
    queue, old, target = saved_source(tmp_path)
    queue.store.max_size = 1
    queue.enqueue("Другой ожидающий исходник", "local", False)
    before = queue.store.get(old["job_id"])
    try:
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "queue_full"
        assert queue.store.get(old["job_id"]) == before
        assert target.read_bytes() == RAW.encode("utf-8") and version(queue) == 1
        assert not queue.store.prepared.joinpath(
            old["job_id"] + ".source-backup"
        ).exists()
    finally:
        queue.close()


@pytest.mark.parametrize(
    "change", ["modified", "deleted", "moved", "replaced", "hardlink"]
)
def test_admission_rejects_external_file_changes_without_overwriting(tmp_path, change):
    queue, old, target = saved_source(tmp_path)
    if change == "modified":
        target.write_bytes(b"A synthetic external edit")
    elif change == "deleted":
        target.unlink()
    elif change == "moved":
        target.rename(tmp_path / "moved-source.txt")
    elif change == "replaced":
        replacement = tmp_path / "replacement.txt"
        replacement.write_bytes(RAW.encode("utf-8"))
        replacement.replace(target)
    else:
        os.link(target, tmp_path / "external-alias.txt")
    before = queue.store.get(old["job_id"])
    disk = {
        path.name: path.read_bytes() for path in tmp_path.iterdir() if path.is_file()
    }
    try:
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "retry_target_changed"
        assert queue.store.get(old["job_id"]) == before and version(queue) == 1
        assert {
            path.name: path.read_bytes()
            for path in tmp_path.iterdir()
            if path.is_file()
        } == disk
    finally:
        queue.close()


def test_busy_editor_before_admission_and_commit_never_changes_its_bytes(tmp_path):
    queue, old, target = saved_source(tmp_path)
    try:
        with target.open("rb"):
            with pytest.raises(JobError) as error:
                retry(queue, old["job_id"])
            assert error.value.code == "retry_target_busy"
        assert version(queue) == 1
        retry(queue, old["job_id"])

        def busy(source, *, publication_context, **kwargs):
            with target.open("rb"):
                return publication_context.publish(tmp_path, generated(source))

        queue._generate_note_payload = busy
        queue.process_one()
        result = queue.get_job(old["job_id"])
        assert result["processing_outcome"] == "source_saved"
        assert result["processing_error"]["code"] == "retry_target_busy"
        assert result["retry_available"] is True and version(queue) == 1
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_two_concurrent_clicks_share_one_retry_and_other_key_conflicts(tmp_path):
    queue, old, target = saved_source(tmp_path)
    key = str(uuid.uuid4())
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(
                pool.map(lambda _: retry(queue, old["job_id"], key), range(2))
            )
        assert {item["job"]["job_id"] for item in replies} == {old["job_id"]}
        assert replies[0]["job"]["recovery_summary"]["retry_count"] == 1
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "retry_pending"
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_changed_file_during_generation_fails_closed_and_keeps_user_edit(tmp_path):
    queue, old, target = saved_source(tmp_path)

    def changed(source, *, publication_context, **kwargs):
        target.write_bytes(b"Synthetic user edit during generation")
        draft = generated(source)
        return publication_context.publish(tmp_path, draft)

    queue._generate_note_payload = changed
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        job = queue.get_job(old["job_id"])
        assert job["recovery_summary"]["status"] == "conflict"
        assert job["status"] == "failed" and job["retry_available"] is False
        assert target.read_bytes() == b"Synthetic user edit during generation"
        assert queue.store.get(old["job_id"])["raw_source"] == RAW
        assert len(list(tmp_path.glob("*.md"))) == 1
    finally:
        queue.close()


def test_model_fails_again_preserves_existing_source_and_supports_new_explicit_cycle(
    tmp_path,
):
    queue, old, target = saved_source(tmp_path)
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        result = queue.get_job(old["job_id"])
        assert (
            result["processing_outcome"] == "source_saved"
            and result["retry_available"] is True
        )
        assert result["recovery_summary"]["status"] == "failed"
        assert result["progress"]["stages"][2]["status"] == "failed"
        assert target.read_bytes() == RAW.encode("utf-8") and version(queue) == 1
        queue._generate_note_payload = successful(tmp_path)
        accepted = retry(queue, old["job_id"])
        assert accepted["job"]["recovery_summary"]["retry_count"] == 2
        queue.process_one()
        assert queue.get_job(old["job_id"])["processing_outcome"] == "completed"
        assert len(list(tmp_path.glob("*.md"))) == 1
    finally:
        queue.close()
