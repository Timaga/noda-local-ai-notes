"""Durable local job records; input and publication receipts share a transaction store."""

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
import uuid

from .note_queue_lock import QueueProcessLock
from .note_job_record import validate_job_record
from .note_job_progress import new_progress
from .note_queue_removal import VISIBLE_JOB, ensure_removal_schema, is_removed
from .note_queue_history import (
    HISTORY_DAYS,
    HISTORY_VERSION,
    compact_history,
    history_revision,
    validate_receipt,
)

try:
    from backend.note_processing_mode import MODES, ORGANIZE, PROCESSING_VERSION, validate_mode
except ImportError:
    from note_processing_mode import MODES, ORGANIZE, PROCESSING_VERSION, validate_mode


ERRORS = {
    "queue_full": (429, "Очередь заполнена. Исходный текст не принят."),
    "invalid_request_id": (400, "Некорректный идентификатор отправки."),
    "invalid_source": (400, "Некорректный или слишком длинный исходный текст."),
    "invalid_mode": (400, "Некорректный режим обработки заметки."),
    "vault_changed": (
        409,
        "Папка заметок изменилась. Предыдущая отправка в неё не повторялась.",
    ),
    "request_conflict": (409, "Этот идентификатор уже использован для другого текста или режима."),
    "store_unavailable": (
        503,
        "Хранилище очереди недоступно. Исходник сохранён только при подтверждённом приёме.",
    ),
    "storage_quota": (
        503,
        "Хранилище очереди заполнено. Сохранённые исходники не удалены.",
    ),
    "publication_unknown": (
        503,
        "Исходник сохранён; результат публикации не определён. Автоматический повтор остановлен.",
    ),
    "publication_failed": (503, "Исходник сохранён; заметку не удалось опубликовать."),
    "generation_failed": (503, "Исходник сохранён; генерация завершилась ошибкой."),
    "retry_exhausted": (503, "Исходник сохранён; исчерпан предел попыток генерации."),
    "retry_not_allowed": (409, "Повтор доступен только для сохранённого необработанного исходника."),
    "retry_target_changed": (409, "Файл заметки изменился. Повтор не перезаписал ваши изменения."),
    "retry_target_busy": (409, "Файл открыт другим приложением. Закройте его и повторите обработку."),
    "retry_pending": (409, "Повторная обработка этого задания уже выполняется."),
    "retry_request_conflict": (409, "Идентификатор повтора уже использован для другого задания."),
    "retry_unsupported": (503, "Безопасный повтор на этой платформе недоступен."),
    "job_not_found": (404, "Задание не найдено."),
    "job_busy": (409, "Задание уже выполняется. Дождитесь завершения обработки."),
}


class JobError(RuntimeError):
    def __init__(self, code):
        self.code = code
        self.http_status, message = ERRORS[code]
        super().__init__(message)


def checked_child(root, name):
    path = root / name
    if path.is_symlink() or (path.exists() and path.resolve().parent != root):
        raise JobError("store_unavailable")
    return path


def request_key(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str) or len(value) not in (32, 36):
            raise ValueError
        parsed = uuid.UUID(value)
        if value.lower() not in (str(parsed), parsed.hex):
            raise ValueError
        return parsed.hex
    except (ValueError, AttributeError) as exc:
        raise JobError("invalid_request_id") from exc


class NoteJobStore:
    MAX_SOURCE_CHARS = 65536
    MAX_RECORD_BYTES = 524288
    MUTABLE = frozenset(
        {
            "status",
            "phase",
            "attempts",
            "next_attempt_at",
            "started_at",
            "finished_at",
            "duration_ms",
            "error",
            "error_code",
            "retryable",
            "result",
            "draft",
            "target",
            "prepared_identity",
            "warnings",
            "index_pending",
            "related_paths",
            "index_attempts",
            "index_next_at",
            "progress",
            "processing_error",
            "recovery",
        }
    )

    def __init__(self, vault, max_size=200, max_bytes=128 * 1024 * 1024):
        self._lock = threading.RLock()
        self._connection = None
        self._owner = None
        try:
            self.vault = Path(vault).resolve(strict=True)
            self.directory = checked_child(self.vault, ".noda-queue")
            self.directory.mkdir(exist_ok=True)
            self.prepared = checked_child(self.directory, "prepared")
            self.prepared.mkdir(exist_ok=True)
            self.max_size, self.max_bytes = max(1, int(max_size)), max(
                1, int(max_bytes)
            )
            self._owner = QueueProcessLock(checked_child(self.directory, "owner.lock"))
            path = checked_child(self.directory, "jobs.sqlite3")
            self._connection = sqlite3.connect(
                path, timeout=2, isolation_level=None, check_same_thread=False
            )
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute("PRAGMA journal_mode=DELETE")
            self._connection.execute("PRAGMA secure_delete=ON")
            version = self._connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, HISTORY_VERSION):
                raise JobError("store_unavailable")
            with self.transaction() as connection:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS jobs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, request_id TEXT UNIQUE, digest TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)"
                )
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)"
                )
                ensure_removal_schema(connection)
                connection.execute(
                    "INSERT OR IGNORE INTO metadata(key,value) VALUES('vault_id',?)",
                    (uuid.uuid4().hex,),
                )
                self.vault_id = connection.execute(
                    "SELECT value FROM metadata WHERE key='vault_id'"
                ).fetchone()[0]
                if request_key(self.vault_id) != self.vault_id:
                    raise JobError("store_unavailable")
                if version == 0:
                    connection.execute("PRAGMA user_version=1")
                for row in connection.execute(
                    "SELECT sequence,payload,id,status FROM jobs"
                ):
                    if len(row[1].encode()) > self.MAX_RECORD_BYTES:
                        raise JobError("store_unavailable")
                    record = self._decode(row)
                    if record["job_id"] != row[2] or record["status"] != row[3]:
                        raise JobError("store_unavailable")
        except (OSError, ValueError, sqlite3.Error, JobError) as exc:
            self.close()
            raise JobError("store_unavailable") from exc

    @contextmanager
    def transaction(self):
        with self._lock:
            try:
                if self._connection is None:
                    raise JobError("store_unavailable")
                self._connection.execute("BEGIN IMMEDIATE")
                yield self._connection
                self._connection.execute("COMMIT")
            except BaseException as exc:
                try:
                    if self._connection is not None and self._connection.in_transaction:
                        self._connection.rollback()
                except sqlite3.Error:
                    raise JobError("store_unavailable") from exc
                if isinstance(exc, (sqlite3.Error, OSError)):
                    raise JobError("store_unavailable") from exc
                raise

    @staticmethod
    def _decode(row):
        if row is None:
            return None
        try:
            payload = json.loads(row[1])
            payload["sequence"] = row[0]
            if payload.get("archived"):
                validate_receipt(
                    payload, MODES, PROCESSING_VERSION,
                    lambda value: value is not None and request_key(value) == value,
                )
            else:
                validate_job_record(payload)
            return payload
        except (ValueError, TypeError, JobError) as exc:
            raise JobError("store_unavailable") from exc

    def enqueue(
        self, prompt, raw_source, source, source_provided, client_request_id=None, *, mode=ORGANIZE
    ):
        if (
            not isinstance(raw_source, str)
            or not raw_source.strip()
            or len(raw_source) > self.MAX_SOURCE_CHARS
        ):
            raise JobError("invalid_source")
        if not isinstance(prompt, str) or prompt != raw_source.strip():
            raise JobError("invalid_source")
        try:
            mode = validate_mode(mode)
        except ValueError as exc:
            raise JobError("invalid_mode") from exc
        key = request_key(client_request_id)
        digest = hashlib.sha256(
            json.dumps(
                [raw_source, source, bool(source_provided), mode, PROCESSING_VERSION], ensure_ascii=False
            ).encode()
        ).hexdigest()
        with self.transaction() as connection:
            if key:
                old = connection.execute(
                    "SELECT sequence,payload,digest FROM jobs WHERE request_id=?",
                    (key,),
                ).fetchone()
                if old:
                    prior = self._decode(old)
                    legacy_digest = hashlib.sha256(json.dumps(
                        [raw_source, source, bool(source_provided)], ensure_ascii=False
                    ).encode()).hexdigest()
                    if old[2] != digest and not (
                        ("mode" not in prior or prior.get("legacy_digest") is True)
                        and mode == ORGANIZE and old[2] == legacy_digest
                    ):
                        raise JobError("request_conflict")
                    return prior
                retry_table = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_retry_requests'"
                ).fetchone()
                if retry_table and connection.execute(
                    "SELECT 1 FROM source_retry_requests WHERE request_id=?", (key,)
                ).fetchone():
                    raise JobError("request_conflict")
            count = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','processing')"
            ).fetchone()[0]
            if count >= self.max_size:
                raise JobError("queue_full")
            job = {
                "job_id": uuid.uuid4().hex,
                "client_request_id": key,
                "prompt": prompt,
                "raw_source": raw_source,
                "requested_source": source,
                "source_provided": bool(source_provided),
                "mode": mode,
                "processing_version": PROCESSING_VERSION,
                "status": "queued",
                "phase": "queued",
                "created_at": time.time(),
                "started_at": None,
                "finished_at": None,
                "duration_ms": None,
                "attempts": 0,
                "next_attempt_at": 0,
                "error": None,
                "error_code": None,
                "retryable": False,
                "result": None,
                "progress": new_progress(),
                "processing_error": None,
            }
            encoded = json.dumps(job, ensure_ascii=False)
            used = self._used_bytes(connection)
            shortage = used + (count + 1) * self.MAX_RECORD_BYTES - self.max_bytes
            if shortage > 0 and len(encoded.encode()) <= self.MAX_RECORD_BYTES:
                _, reclaimed = compact_history(
                    connection, self.prepared, self._decode, reclaim_bytes=shortage
                )
                used -= reclaimed
            if (
                len(encoded.encode()) > self.MAX_RECORD_BYTES
                or used + (count + 1) * self.MAX_RECORD_BYTES > self.max_bytes
            ):
                raise JobError("storage_quota")
            cursor = connection.execute(
                "INSERT INTO jobs(id,request_id,digest,status,payload) VALUES(?,?,?,?,?)",
                (job["job_id"], key, digest, "queued", encoded),
            )
            job["sequence"] = cursor.lastrowid
            return job

    def get(self, job_id):
        with self.transaction() as connection:
            return self._decode(
                connection.execute(
                    "SELECT sequence,payload FROM jobs WHERE id=?", (job_id,)
                ).fetchone()
            )

    def is_removed(self, job_id):
        with self.transaction() as connection:
            return is_removed(connection, job_id)

    def update(self, job_id, **changes):
        if not set(changes).issubset(self.MUTABLE):
            raise ValueError("Immutable job fields cannot be changed")
        with self.transaction() as connection:
            job = self._decode(
                connection.execute(
                    "SELECT sequence,payload FROM jobs WHERE id=?", (job_id,)
                ).fetchone()
            )
            if job is None:
                raise JobError("store_unavailable")
            if job.get("archived"):
                raise JobError("store_unavailable")
            job.update(changes)
            self._write_record(connection, job)
            if "recovery" in changes and changes["recovery"] is not None:
                self._finish_recovery_version(connection)
            return job

    def _write_record(self, connection, job):
        if job["status"] in ("queued", "processing") and is_removed(connection, job["job_id"]):
            raise JobError("job_not_found")
        try:
            validate_job_record(job)
        except (ValueError, TypeError) as exc:
            raise JobError("store_unavailable") from exc
        encoded = json.dumps(job, ensure_ascii=False)
        if len(encoded.encode()) > self.MAX_RECORD_BYTES:
            raise JobError("storage_quota")
        connection.execute(
            "UPDATE jobs SET status=?,payload=? WHERE id=?",
            (job["status"], encoded, job["job_id"]),
        )

    @staticmethod
    def _used_bytes(connection, exclude_job=None):
        used = connection.execute(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) + COALESCE(json_extract(payload,'$.recovery.backup_size'),0)),0) FROM jobs WHERE (? IS NULL OR id!=?)",
            (exclude_job, exclude_job),
        ).fetchone()[0]
        exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_retry_requests'"
        ).fetchone()
        if exists:
            used += connection.execute("SELECT COUNT(*) FROM source_retry_requests").fetchone()[0] * 1024
        return used

    @staticmethod
    def _finish_recovery_version(connection):
        active = connection.execute(
            "SELECT COUNT(*) FROM jobs WHERE json_extract(payload,'$.recovery.state') IN ('queued','processing','conflict')"
        ).fetchone()[0]
        if not active and connection.execute("PRAGMA user_version").fetchone()[0] == 2:
            connection.execute("PRAGMA user_version=1")

    def queue_positions(self):
        with self.transaction() as connection:
            return {
                row[0]: index + 1
                for index, row in enumerate(
                    connection.execute(
                        "SELECT id FROM jobs WHERE status='queued' ORDER BY sequence"
                    )
                )
            }

    def cleanup_history(self, *, expired_only=False):
        cutoff = time.time() - HISTORY_DAYS * 86400 if expired_only else None
        with self.transaction() as connection:
            count, _ = compact_history(connection, self.prepared, self._decode, cutoff=cutoff)
            return count

    def next_due(self):
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT sequence,payload FROM jobs WHERE status IN ('queued','processing') AND COALESCE(json_extract(payload,'$.next_attempt_at'),0)<=? ORDER BY sequence LIMIT 1",
                (time.time(),),
            ).fetchone()
            return self._decode(row)

    def pending(self):
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT sequence,payload FROM jobs WHERE status IN ('queued','processing') ORDER BY sequence LIMIT ?",
                (self.max_size,),
            ).fetchall()
            return [self._decode(row) for row in rows]

    def listing(self, limit=50, cursor=None, *, include_history_revision=False):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Invalid page size")
        if cursor is not None and (
            not isinstance(cursor, str)
            or not cursor.isascii()
            or not cursor.isdecimal()
            or len(cursor) > 18
        ):
            raise ValueError("Invalid cursor")
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT sequence,payload FROM jobs WHERE sequence < ? AND json_extract(payload,'$.archived') IS NULL AND " + VISIBLE_JOB + " ORDER BY sequence DESC LIMIT ?",
                (int(cursor) if cursor else 9223372036854775807, limit + 1),
            ).fetchall()
            result = [self._decode(row) for row in rows[:limit]], (
                str(rows[limit - 1][0]) if len(rows) > limit else None
            )
            return (*result, history_revision(connection)) if include_history_revision else result

    def pending_indexes(self):
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT sequence,payload FROM jobs WHERE status='completed' AND json_extract(payload,'$.index_pending')=1 AND COALESCE(json_extract(payload,'$.index_attempts'),0)<3 AND COALESCE(json_extract(payload,'$.index_next_at'),0)<=? ORDER BY sequence LIMIT 5",
                (time.time(),),
            ).fetchall()
            return [self._decode(row) for row in rows]

    def stats(self):
        with self.transaction() as connection:
            counts = dict(
                connection.execute(
                    "SELECT status,COUNT(*) FROM jobs WHERE " + VISIBLE_JOB + " GROUP BY status"
                ).fetchall()
            )
            active = connection.execute(
                "SELECT id FROM jobs WHERE status='processing' ORDER BY sequence LIMIT 1"
            ).fetchone()
            return {
                "queued_count": counts.get("queued", 0),
                "processing": bool(active),
                "active_job_id": active[0] if active else None,
                "completed_total": counts.get("completed", 0),
                "failed_total": counts.get("failed", 0),
                "max_size": self.max_size,
                "history_revision": history_revision(connection),
                "history_retention_days": HISTORY_DAYS,
            }

    def close(self):
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            if self._owner is not None:
                self._owner.close()
                self._owner = None
