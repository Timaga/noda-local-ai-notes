"""Explicit retry admission with a same-file proof and a durable source backup."""

import hashlib
import json
import os
import time

from .note_job_progress import new_progress
from .note_job_store import JobError, checked_child, request_key
from .note_queue_removal import is_removed
from .source_recovery_record import is_source_saved
from .windows_note_file import LocalNoteFileError, locked_note


def file_error(error):
    return JobError(
        {
            "target_busy": "retry_target_busy",
            "target_changed": "retry_target_changed",
            "unsupported": "retry_unsupported",
        }.get(error.code, "publication_failed")
    )


def recovery_target(store, job):
    name = job.get("target")
    if (
        type(name) is not str
        or not name.endswith(".md")
        or any(char in name for char in "/\\:\x00")
        or job.get("result", {}).get("title") + ".md" != name
    ):
        raise JobError("retry_not_allowed")
    return checked_child(store.vault, name)


def _clear_acknowledged_alias(store, job, target, source):
    prepared = checked_child(store.prepared, job["job_id"] + ".prepared")
    if not prepared.exists():
        return
    info = prepared.stat()
    if [info.st_dev, info.st_ino] != job["prepared_identity"] or not os.path.samefile(
        prepared, target
    ):
        return
    if info.st_size != len(source) or prepared.read_bytes() != source:
        raise JobError("retry_target_changed")
    prepared.unlink()


def _backup_source(store, job_id, source):
    path = checked_child(store.prepared, job_id + ".source-backup")
    try:
        descriptor = os.open(
            path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
            0o600,
        )
    except FileExistsError:
        try:
            with locked_note(path, max_bytes=store.MAX_RECORD_BYTES) as backup:
                if backup.read_all() != source:
                    raise JobError("publication_unknown")
        except LocalNoteFileError as exc:
            raise JobError("publication_unknown") from exc
        return
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(source)
        stream.flush()
        os.fsync(stream.fileno())


def admit_retry(store, job_id, request_id, expected_vault_id):
    if expected_vault_id != store.vault_id:
        raise JobError("vault_changed")
    key = request_key(request_id)
    if key is None:
        raise JobError("invalid_request_id")
    if os.name != "nt":
        raise JobError("retry_unsupported")
    with store.transaction() as connection:
        if is_removed(connection, job_id):
            raise JobError("job_not_found")
        job = store._decode(
            connection.execute(
                "SELECT sequence,payload FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        )
        if job is None:
            raise JobError("job_not_found")
        prior_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_retry_requests'"
        ).fetchone()
        if prior_table:
            previous = connection.execute(
                "SELECT job_id FROM source_retry_requests WHERE request_id=?", (key,)
            ).fetchone()
            if previous:
                if previous[0] != job_id:
                    raise JobError("retry_request_conflict")
                return job
        reused = connection.execute(
            "SELECT id FROM jobs WHERE request_id=?", (key,)
        ).fetchone()
        if reused:
            raise JobError("retry_request_conflict")
        recovery = job.get("recovery")
        if recovery and recovery["state"] in ("queued", "processing"):
            raise JobError("retry_pending")
        if not is_source_saved(job) or recovery and recovery["state"] != "failed":
            raise JobError("retry_not_allowed")
        pending = connection.execute(
            "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','processing')"
        ).fetchone()[0]
        if pending >= store.max_size:
            raise JobError("queue_full")
        target = recovery_target(store, job)
        source = job["raw_source"].encode("utf-8")
        _clear_acknowledged_alias(store, job, target, source)
        try:
            with locked_note(target, max_bytes=store.MAX_RECORD_BYTES) as note:
                proof = note.snapshot()
                if (
                    note.read_all() != source
                    or proof["identity"] != job["prepared_identity"]
                ):
                    raise JobError("retry_target_changed")
        except LocalNoteFileError as exc:
            raise file_error(exc) from exc
        proof["sha256"] = hashlib.sha256(source).hexdigest()
        now = time.time()
        count = (
            connection.execute(
                "SELECT COUNT(*) FROM source_retry_requests WHERE job_id=?", (job_id,)
            ).fetchone()[0]
            if prior_table
            else 0
        ) + 1
        original = dict(job["result"])
        receipt = {
            field: job.get(field)
            for field in (
                "status",
                "phase",
                "attempts",
                "started_at",
                "finished_at",
                "duration_ms",
                "progress",
                "processing_error",
            )
        }
        recovery = {
            "version": 1,
            "target": target.name,
            "expected": proof,
            "original_result": original,
            "original_index_pending": job.get("index_pending", False),
            "request_id": key,
            "requested_at": now,
            "retry_count": count,
            "state": "queued",
            "new_sha256": None,
            "backup_size": len(source),
        }
        job.update(
            recovery=recovery,
            status="queued",
            phase="queued",
            attempts=0,
            next_attempt_at=0,
            started_at=None,
            finished_at=None,
            duration_ms=None,
            error=None,
            error_code=None,
            retryable=False,
            progress=new_progress(),
            processing_error=None,
            result=None,
            draft=None,
            target=None,
            prepared_identity=None,
            index_pending=False,
        )
        encoded = json.dumps(job, ensure_ascii=False).encode("utf-8")
        used = store._used_bytes(connection, exclude_job=job_id)
        receipt_json = json.dumps(receipt, ensure_ascii=False)
        if (
            len(encoded) > store.MAX_RECORD_BYTES
            or len(receipt_json.encode("utf-8")) > 1024
            or used + len(encoded) + len(source) + 1024 > store.max_bytes
        ):
            raise JobError("storage_quota")
        _backup_source(store, job_id, source)
        connection.execute(
            "CREATE TABLE IF NOT EXISTS source_retry_requests(request_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,requested_at REAL NOT NULL,receipt TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO source_retry_requests(request_id,job_id,requested_at,receipt) VALUES(?,?,?,?)",
            (key, job_id, now, receipt_json),
        )
        if connection.execute("PRAGMA user_version").fetchone()[0] < 2:
            connection.execute("PRAGMA user_version=2")
        store._write_record(connection, job)
        return job
