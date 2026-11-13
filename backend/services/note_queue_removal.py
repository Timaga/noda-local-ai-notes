"""Durable queue removal without deleting notes, sources, or idempotency receipts."""

import time


VISIBLE_JOB = "NOT EXISTS (SELECT 1 FROM removed_jobs WHERE job_id=jobs.id)"


def ensure_removal_schema(connection):
    # Older builds ignore this additive table. Queued jobs also become terminal,
    # so rolling back cannot accidentally start cancelled generation again.
    connection.execute(
        "CREATE TABLE IF NOT EXISTS removed_jobs "
        "(job_id TEXT PRIMARY KEY,removed_at REAL NOT NULL)"
    )


def is_removed(connection, job_id):
    return (
        connection.execute(
            "SELECT 1 FROM removed_jobs WHERE job_id=?", (job_id,)
        ).fetchone()
        is not None
    )


def _cancel_waiting(job):
    if job.get("recovery"):
        recovery = dict(job["recovery"], state="failed")
        previous = dict(recovery["original_result"])
        job.update(
            recovery=recovery,
            status="completed",
            phase="completed",
            draft=previous,
            result=previous,
            target=recovery["target"],
            prepared_identity=recovery["expected"]["identity"],
            index_pending=recovery["original_index_pending"],
            error=None,
            error_code=None,
            retryable=False,
            next_attempt_at=0,
            finished_at=time.time(),
        )
    else:
        job.update(
            status="failed",
            phase="generation_failed",
            retryable=False,
            next_attempt_at=0,
            finished_at=time.time(),
            error="Задание удалено из очереди.",
            error_code="job_removed",
        )


def remove_job(store, job_id):
    """Caller holds the queue condition, excluding worker admission and retry."""
    from .note_job_store import JobError

    with store.transaction() as connection:
        job = store._decode(
            connection.execute(
                "SELECT sequence,payload FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        )
        if job is None:
            raise JobError("job_not_found")
        if is_removed(connection, job_id):
            return False
        if job["status"] == "processing":
            raise JobError("job_busy")
        if job["status"] == "queued":
            _cancel_waiting(job)
            store._write_record(connection, job)
        connection.execute(
            "INSERT INTO removed_jobs(job_id,removed_at) VALUES(?,?)",
            (job_id, time.time()),
        )
        connection.execute(
            "INSERT INTO metadata(key,value) VALUES('history_revision','1') "
            "ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1"
        )
        store._finish_recovery_version(connection)
        return True
