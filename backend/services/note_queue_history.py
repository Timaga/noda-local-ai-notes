"""Keep publication receipts after removing copies of successfully saved notes."""

import json
import math
import time

from .source_recovery_record import public_recovery

HISTORY_DAYS = 30
HISTORY_VERSION = 3
_RECEIPT_FIELDS = (
    "job_id", "client_request_id", "status", "phase", "created_at", "finished_at", "mode",
    "processing_version",
)


def _release_publication_files(prepared, job):
    try:
        job_id = job["job_id"]
        for suffix in (".prepared", ".writing"):
            path = prepared / (job_id + suffix)
            if path.exists() or path.is_symlink():
                return False
        backup = prepared / (job_id + ".source-backup")
        if not job.get("recovery"):
            return not backup.exists() and not backup.is_symlink()
        target = prepared.parent.parent / job["target"]
        expected = job["result"]["content"].encode("utf-8")
        if target.is_symlink() or not target.is_file() or backup.is_symlink():
            return False
        with target.open("rb") as stream:
            if stream.read(len(expected) + 1) != expected:
                return False
        # A rolled-back transaction still contains the full source.
        backup.unlink(missing_ok=True)
    except OSError:
        return False
    return True


def compact_history(connection, prepared, decode, *, cutoff=None, reclaim_bytes=None):
    if cutoff is None:
        cutoff = time.time()
    count, recovered, sequence = 0, 0, 0
    while True:
        rows = connection.execute(
            """SELECT sequence,payload FROM jobs
               WHERE sequence>? AND status='completed'
               AND json_extract(payload,'$.archived') IS NULL
               AND json_extract(payload,'$.finished_at')<=?
               AND (json_extract(payload,'$.duration_ms') IS NOT NULL
                    OR json_extract(payload,'$.finished_at')<=?)
               AND COALESCE(json_extract(payload,'$.result.generation.metadata_pending'),0)=0
               AND COALESCE(json_extract(payload,'$.index_pending'),0)=0
               AND (json_extract(payload,'$.recovery') IS NULL
                    OR json_extract(payload,'$.recovery.state')='completed')
               ORDER BY sequence LIMIT 50""",
            (sequence, cutoff, time.time() - 60),
        ).fetchall()
        if not rows:
            break
        for row in rows:
            sequence, payload = row
            job = decode(row)
            if not _release_publication_files(prepared, job):
                continue
            receipt = {field: job.get(field) for field in _RECEIPT_FIELDS}
            receipt["archived"] = True
            receipt["legacy_digest"] = "mode" not in job
            receipt["recovery_summary"] = public_recovery(job)["recovery_summary"]
            encoded = json.dumps(receipt, ensure_ascii=False)
            connection.execute("UPDATE jobs SET payload=? WHERE sequence=?", (encoded, sequence))
            count += 1
            recovered += len(payload.encode()) - len(encoded.encode())
            recovered += (job.get("recovery") or {}).get("backup_size", 0)
            if reclaim_bytes is not None and recovered >= reclaim_bytes:
                break
        if reclaim_bytes is not None and recovered >= reclaim_bytes:
            break
    if count:
        connection.execute(f"PRAGMA user_version={HISTORY_VERSION}")
        connection.execute(
            """INSERT INTO metadata(key,value) VALUES('history_revision','1')
               ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1"""
        )
    return count, recovered


def validate_receipt(receipt, modes, processing_version, valid_id):
    recovery = receipt.get("recovery_summary")
    if (
        set(receipt) != {*_RECEIPT_FIELDS, "sequence", "archived", "legacy_digest", "recovery_summary"}
        or receipt["archived"] is not True
        or type(receipt["legacy_digest"]) is not bool
        or not valid_id(receipt["job_id"])
        or (receipt["client_request_id"] is not None and not valid_id(receipt["client_request_id"]))
        or receipt["status"] != "completed"
        or receipt["phase"] != "completed"
        or (receipt["mode"] is None and not receipt["legacy_digest"])
        or (receipt["mode"] is not None and (not isinstance(receipt["mode"], str) or receipt["mode"] not in modes))
        or receipt["processing_version"] != (None if receipt["legacy_digest"] else processing_version)
        or any(
            type(receipt[field]) not in (int, float)
            or not math.isfinite(receipt[field])
            or receipt[field] < 0
            for field in ("created_at", "finished_at")
        )
        or (
            recovery is not None
            and (
                type(recovery) is not dict
                or set(recovery) != {"request_id", "requested_at", "retry_count", "status"}
                or not valid_id(recovery["request_id"])
                or recovery["status"] != "completed"
                or type(recovery["requested_at"]) not in (int, float)
                or not math.isfinite(recovery["requested_at"])
                or recovery["requested_at"] < 0
                or type(recovery["retry_count"]) is not int
                or not 1 <= recovery["retry_count"] <= 1000000
            )
        )
    ):
        raise ValueError("Invalid archived job receipt")


def history_revision(connection):
    row = connection.execute("SELECT value FROM metadata WHERE key='history_revision'").fetchone()
    return int(row[0]) if row else 0
