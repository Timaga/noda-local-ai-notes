"""Budget, legacy artifact, corrupted journal and worker admission boundaries."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
import sqlite3
import threading
from types import SimpleNamespace

import pytest

from backend.services.note_job_store import JobError, NoteJobStore
from backend.services.source_recovery_record import validate_recovery
from test_source_note_recovery import (
    RAW,
    queue_for,
    retry,
    saved_source,
    successful,
    version,
)


pytestmark = pytest.mark.skipif(
    os.name != "nt", reason="Strict Windows recovery protocol"
)


def test_normal_enqueue_counts_durable_retry_receipts_in_shared_byte_budget(tmp_path):
    queue, old, target = saved_source(tmp_path)
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        with queue.store.transaction() as connection:
            used = queue.store._used_bytes(connection)
            receipts = connection.execute(
                "SELECT COUNT(*) FROM source_retry_requests"
            ).fetchone()[0]
        assert receipts == 1
        queue.store.max_bytes = used + queue.store.MAX_RECORD_BYTES - 1
        with pytest.raises(JobError) as error:
            queue.enqueue("New synthetic input", "local", False)
        assert error.value.code == "storage_quota"
        assert len(
            queue.store.listing(50)[0]
        ) == 1 and target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_retry_quota_failure_makes_no_source_backup_or_journal_transition(tmp_path):
    queue, old, target = saved_source(tmp_path)
    try:
        with queue.store.transaction() as connection:
            queue.store.max_bytes = queue.store._used_bytes(connection) + 1
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "storage_quota"
        assert version(queue) == 1 and queue.store.get(old["job_id"]) == old
        assert not queue.store.prepared.joinpath(
            old["job_id"] + ".source-backup"
        ).exists()
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_acknowledged_prepared_alias_is_detached_but_backup_has_distinct_identity(
    tmp_path,
):
    queue, old, target = saved_source(tmp_path)
    alias = queue.store.prepared / (old["job_id"] + ".prepared")
    os.link(target, alias)
    queue._generate_note_payload = successful(tmp_path)
    try:
        assert target.stat().st_nlink == 2
        retry(queue, old["job_id"])
        assert not alias.exists() and target.stat().st_nlink == 1
        backup = queue.store.prepared / (old["job_id"] + ".source-backup")
        assert backup.stat().st_ino != target.stat().st_ino
        queue.process_one()
        assert backup.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_corrupted_or_aliased_backup_never_changes_the_source(tmp_path):
    queue, old, target = saved_source(tmp_path)
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        backup = queue.store.prepared / (old["job_id"] + ".source-backup")
        backup.unlink()
        os.link(target, backup)
        before = queue.store.get(old["job_id"])
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "retry_target_changed"
        assert queue.store.get(old["job_id"]) == before and version(queue) == 1
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_modified_backup_refuses_without_replacing_either_file(tmp_path):
    queue, old, target = saved_source(tmp_path)
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        backup = queue.store.prepared / (old["job_id"] + ".source-backup")
        backup.write_bytes(b"Synthetic backup corruption")
        before = queue.store.get(old["job_id"])
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "publication_unknown"
        assert queue.store.get(old["job_id"]) == before and version(queue) == 1
        assert target.read_bytes() == RAW.encode("utf-8")
        assert backup.read_bytes() == b"Synthetic backup corruption"
    finally:
        queue.close()


@pytest.mark.parametrize(
    "mutation",
    [
        {"version": True},
        {"target": "../outside.md"},
        {"retry_count": True},
        {"request_id": "invalid"},
        {"state": "completed"},
        {"requested_at": float("nan")},
        {"expected": {}},
        {"original_result": {}},
        {"backup_size": -1},
        {"new_sha256": "unsafe"},
    ],
)
def test_recovery_record_rejects_untrusted_identity_state_and_receipt(
    tmp_path, mutation
):
    queue, old, target = saved_source(tmp_path)
    try:
        retry(queue, old["job_id"])
        record = queue.store.get(old["job_id"])
        corrupt = deepcopy(record["recovery"])
        corrupt.update(mutation)
        with pytest.raises(ValueError):
            validate_recovery(corrupt, record)
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_restart_rejects_corrupt_recovery_without_mutating_target_or_journal(tmp_path):
    queue, old, target = saved_source(tmp_path)
    retry(queue, old["job_id"])
    database = queue.store.directory / "jobs.sqlite3"
    queue.close()
    with sqlite3.connect(database) as connection:
        record = json.loads(
            connection.execute("SELECT payload FROM jobs").fetchone()[0]
        )
        record["recovery"]["expected"]["sha256"] = "0" * 64
        connection.execute("UPDATE jobs SET payload=?", (json.dumps(record),))
    before = database.read_bytes()
    with pytest.raises(JobError):
        NoteJobStore(tmp_path)
    assert database.read_bytes() == before and target.read_bytes() == RAW.encode(
        "utf-8"
    )


def test_other_source_retry_admits_while_one_worker_is_waiting_on_model(tmp_path):
    queue, first, target = saved_source(tmp_path)
    second_id = queue.enqueue(RAW.strip(), "local", False, raw_source=RAW)[0]["job"][
        "job_id"
    ]
    queue.process_one()
    entered, proceed, completed = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )
    generated = successful(tmp_path)
    calls = []

    def blocked(source, *, publication_context, **kwargs):
        calls.append(publication_context.job_id)
        if publication_context.job_id == first["job_id"]:
            entered.set()
            assert proceed.wait(10)
        return generated(source, publication_context=publication_context, **kwargs)

    original_update = queue.store.update

    def observed(job_id, **changes):
        result = original_update(job_id, **changes)
        if job_id == second_id and changes.get("phase") == "completed":
            completed.set()
        return result

    queue._generate_note_payload = blocked
    queue.store.update = observed
    try:
        retry(queue, first["job_id"])
        queue.start()
        assert entered.wait(10)
        with ThreadPoolExecutor(max_workers=1) as pool:
            accepted = pool.submit(retry, queue, second_id).result(timeout=5)
        assert accepted["job"]["status"] == "queued"
        assert queue._active_job_id == first["job_id"] and calls == [first["job_id"]]
        proceed.set()
        assert completed.wait(10)
        assert calls == [first["job_id"], second_id]
        assert all(
            queue.get_job(identifier)["processing_outcome"] == "completed"
            for identifier in calls
        )
        assert len(list(tmp_path.glob("*.md"))) == 2
    finally:
        proceed.set()
        assert queue.close(timeout=10)


def test_unsupported_platform_refuses_before_any_artifact_write(tmp_path, monkeypatch):
    from backend.services import source_recovery_admission as admission

    queue, old, target = saved_source(tmp_path)
    try:
        monkeypatch.setattr(admission, "os", SimpleNamespace(name="posix"))
        with pytest.raises(JobError) as error:
            retry(queue, old["job_id"])
        assert error.value.code == "retry_unsupported"
        assert queue.store.get(old["job_id"]) == old and version(queue) == 1
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


@pytest.mark.parametrize("mutation", ["target", "title", "tags", "links"])
def test_completed_recovery_binds_publication_and_metadata_to_canonical_receipt(
    tmp_path, mutation
):
    from backend.services.note_job_record import validate_job_record

    queue, old, target = saved_source(tmp_path)
    queue._generate_note_payload = successful(tmp_path)
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        bad = queue.store.get(old["job_id"])
        if mutation == "target":
            bad["target"] = "Different synthetic target.md"
        elif mutation == "title":
            bad["result"]["title"] = "Different synthetic target"
        else:
            bad["result"][mutation] = ["Different synthetic metadata"]
        with pytest.raises(ValueError):
            validate_job_record(bad)
        assert target.exists() and len(list(tmp_path.glob("*.md"))) == 1
    finally:
        queue.close()
