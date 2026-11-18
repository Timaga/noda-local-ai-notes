"""Durable single-worker scheduling with bounded retries and publication recovery."""

import threading
import time

from .note_job_store import JobError, NoteJobStore
from .note_job_progress import new_progress, public_outcome, record_failure
from .source_recovery_record import public_recovery

try:
    from backend.note_processing_mode import ORGANIZE
except ImportError:
    from note_processing_mode import ORGANIZE

try:
    from backend.note_publication import PublicationContext, verify_publication_storage
    from backend.note_generation_contract import (
        NoteGenerationError,
        TemporaryModelError,
    )
    from backend.note_processing_failures import NoteSystemError
except ImportError:
    from note_publication import PublicationContext, verify_publication_storage
    from note_generation_contract import (
        NoteGenerationError,
        TemporaryModelError,
    )
    from note_processing_failures import NoteSystemError


class NoteGenerationQueue:
    def __init__(
        self,
        max_size,
        job_ttl_seconds,
        generate_note_payload,
        logger,
        *,
        notes_dir,
        max_attempts=3,
        retry_delays=(2.0, 10.0),
        reconcile_publication=None,
        generation_ready=None,
    ):
        if not callable(generate_note_payload) or logger is None:
            raise ValueError("Generation callback and logger are required")
        self.store = NoteJobStore(notes_dir, max_size=max_size)
        try:
            verify_publication_storage(self.store)
        except OSError as exc:
            self.store.close()
            raise JobError("store_unavailable") from exc
        except BaseException:
            self.store.close()
            raise
        self._generate_note_payload = generate_note_payload
        self._reconcile_publication = reconcile_publication
        self._generation_ready = generation_ready or (lambda: True)
        self._logger = logger
        self._condition = threading.Condition()
        self._worker_thread = None
        self._stopping = False
        self._active_job_id = None
        self._unavailable = False
        self.max_attempts = max(1, min(int(max_attempts), 5))
        self.retry_delays = tuple(
            max(0.0, min(float(value), 60.0)) for value in retry_delays
        ) or (2.0,)
        # The historical TTL is retained in the constructor for callers, not applied
        # to durable input, failed jobs, or idempotency receipts.
        self.job_ttl_seconds = job_ttl_seconds

    def start(self):
        with self._condition:
            if self._worker_thread and self._worker_thread.is_alive():
                return
            if self._stopping:
                raise RuntimeError("Closed queue cannot restart")
            self._worker_thread = threading.Thread(
                target=self._worker_loop, name="note-generation-queue", daemon=True
            )
            self._worker_thread.start()

    def close(self, timeout=5):
        with self._condition:
            self._stopping = True
            self._condition.notify_all()
        if self._worker_thread:
            self._worker_thread.join(timeout=timeout)
            if self._worker_thread.is_alive():
                return False
        self.store.close()
        return True

    def _public_job(self, job, *, detail=False, positions=None, removed=False):
        if not job:
            return None
        if removed:
            return {key: job.get(key) for key in ("job_id", "client_request_id", "status", "phase")} | {
                "removed": True, "vault_id": self.store.vault_id,
            }
        result = {
            key: job.get(key)
            for key in (
                "job_id",
                "client_request_id",
                "status",
                "phase",
                "created_at",
                "started_at",
                "finished_at",
                "duration_ms",
                "error",
                "error_code",
                "attempts",
                "retryable",
                "next_attempt_at",
                "mode",
                "processing_version",
            )
        }
        positions = self.store.queue_positions() if positions is None else positions
        if job.get("archived"):
            return {
                **result,
                "archived": True,
                "vault_id": self.store.vault_id,
                "processing_outcome": "completed",
                "retry_available": False,
                "recovery_summary": job.get("recovery_summary"),
                "mode": job.get("mode") or ORGANIZE,
            }
        result.update(
            {
                "vault_id": self.store.vault_id,
                "source_requested": job.get("requested_source"),
                "source_provided": job.get("source_provided", False),
                "queue_position": positions.get(job["job_id"]),
                "prompt_preview": job["raw_source"][:140],
                "prompt_length": len(job["raw_source"]),
                "index_pending": job.get("index_pending", False),
                "mode": job.get("mode", ORGANIZE),
            }
        )
        if detail:
            result["prompt_text"] = job["raw_source"]
        if job["status"] == "completed":
            result["result"] = job["result"]
        result.update(public_outcome(job))
        result.update(public_recovery(job))
        return result

    def enqueue(
        self,
        prompt_text,
        requested_source,
        source_provided,
        *,
        raw_source=None,
        client_request_id=None,
        expected_vault_id=None,
        mode=ORGANIZE,
    ):
        if self._unavailable or self._stopping:
            raise JobError("store_unavailable")
        if expected_vault_id is not None and expected_vault_id != self.store.vault_id:
            raise JobError("vault_changed")
        job = self.store.enqueue(
            prompt_text,
            prompt_text if raw_source is None else raw_source,
            requested_source,
            source_provided,
            client_request_id,
            mode=mode,
        )
        snapshot = self._public_job(job, removed=self.store.is_removed(job["job_id"]))
        stats = self.stats()
        with self._condition:
            self._condition.notify_all()
        self._logger.info("Generation accepted job_id=%s", job["job_id"])
        return {"job": snapshot, "queue": stats, "vault_id": self.store.vault_id}, None

    def get_job(self, job_id):
        if self.store.is_removed(job_id):
            return None
        return self._public_job(self.store.get(job_id), detail=True)

    def remove(self, job_id, *, expected_vault_id):
        from .note_queue_removal import remove_job
        with self._condition:
            if expected_vault_id != self.store.vault_id:
                raise JobError("vault_changed")
            if self._unavailable or self._stopping:
                raise JobError("store_unavailable")
            if self._active_job_id == job_id:
                raise JobError("job_busy")
            changed = remove_job(self.store, job_id)
            stats = self.stats()
            self._condition.notify_all()
        if changed:
            self._logger.info("Generation removed job_id=%s", job_id)
        return {"success": True, "removed": True, "already_removed": not changed,
                "job_id": job_id, "vault_id": self.store.vault_id,
                "history_revision": stats["history_revision"], "queue": stats}

    def retry(self, job_id, *, client_request_id, expected_vault_id):
        from .source_recovery_admission import admit_retry
        with self._condition:
            if self._unavailable or self._stopping:
                raise JobError("store_unavailable")
            if expected_vault_id != self.store.vault_id:
                raise JobError("vault_changed")
            if self.store.is_removed(job_id):
                raise JobError("job_not_found")
            job = admit_retry(self.store, job_id, client_request_id, expected_vault_id)
            self._condition.notify_all()
        return {"job": self._public_job(job), "queue": self.stats(), "vault_id": self.store.vault_id}

    def list_jobs(self, limit=50, cursor=None):
        jobs, next_cursor, revision = self.store.listing(limit, cursor, include_history_revision=True)
        positions = self.store.queue_positions()
        return {
            "jobs": [self._public_job(job, positions=positions) for job in jobs],
            "next_cursor": next_cursor,
            "vault_id": self.store.vault_id,
            "history_revision": revision,
        }

    def cleanup_history(self, *, expected_vault_id):
        if expected_vault_id != self.store.vault_id:
            raise JobError("vault_changed")
        if self._unavailable or self._stopping:
            raise JobError("store_unavailable")
        count = self.store.cleanup_history()
        return {"archived_count": count, "vault_id": self.store.vault_id, "queue": self.stats()}

    def stats(self):
        stats = self.store.stats()
        stats["vault_id"] = self.store.vault_id
        stats["worker_available"] = not self._unavailable and not self._stopping
        return stats

    def _fail(self, job, code, failure=None):
        if job.get("recovery"):
            from .source_note_recovery import fail_recovery
            fail_recovery(self.store, job, code, failure)
            return
        record_failure(self.store, job["job_id"], code, failure)
        if (
            job.get("mode", ORGANIZE) == ORGANIZE
            and code in ("generation_failed", "retry_exhausted")
            and job["phase"] in ("queued", "generating")
        ):
            context = PublicationContext(self.store, job["job_id"])
            draft = {
                "title": "Необработанная заметка " + job["job_id"][:8],
                "content": job["raw_source"],
                "tags": [],
                "links": [],
                "source": "local",
                "model": "none",
                "mode": ORGANIZE,
                "processing_version": job["processing_version"],
                "warnings": [
                    "Исходник сохранён; заголовок и связи ожидают обработки."
                ],
                "generation": {
                    "metadata_pending": True,
                    "failure_code": code,
                    "failure_kind": getattr(failure, "failure_kind", "unclassified"),
                    "failure_detail_code": getattr(failure, "failure_code", code),
                },
            }
            try:
                context.publish(self.store.vault, draft)
                context.complete()
            except Exception as exc:
                if isinstance(exc, JobError) and exc.code == "store_unavailable":
                    raise
                current = self.store.get(job["job_id"])
                if current["phase"] in (
                    "preparing",
                    "prepared",
                    "publish_intent",
                    "published",
                ):
                    try:
                        context.recover()
                        context.complete()
                        return
                    except Exception as recovery_error:
                        if (
                            isinstance(recovery_error, JobError)
                            and recovery_error.code == "store_unavailable"
                        ):
                            raise
                        code = (
                            "publication_unknown"
                            if current["phase"] == "publish_intent"
                            else "publication_failed"
                        )
                else:
                    code = "publication_failed"
            else:
                if job.get("started_at") is not None:
                    self.store.update(
                        job["job_id"],
                        duration_ms=max(
                            0, int((time.time() - job["started_at"]) * 1000)
                        ),
                    )
                self._logger.warning(
                    "Generation metadata pending job_id=%s code=%s", job["job_id"], code
                )
                return
        error = JobError(code)
        self.store.update(
            job["job_id"],
            status="failed",
            phase=code,
            finished_at=time.time(),
            error=str(error),
            error_code=code,
            retryable=False,
        )
        self._logger.warning("Generation failed job_id=%s code=%s", job["job_id"], code)

    def process_one(self):
        """Process one due job; also a deterministic scheduling seam for tests."""
        with self._condition:
            if self._active_job_id is not None:
                return False
            job = self.store.next_due()
            if job is None:
                return False
            job_id = job["job_id"]
            self._active_job_id = job_id
        from .source_note_recovery import publication_context
        context = publication_context(self.store, job)
        started = time.monotonic()
        try:
            if job["phase"] in (
                "preparing",
                "prepared",
                "publish_intent",
                "published",
                "completed",
            ):
                context.recover()
                context.complete()
                return True
            if job["attempts"] >= self.max_attempts:
                self._fail(job, "retry_exhausted")
                return True
            if not self._generation_ready():
                return False
            job = self.store.update(
                job_id,
                status="processing",
                phase="generating",
                started_at=time.time(),
                attempts=job["attempts"] + 1,
                retryable=False,
                error=None,
                error_code=None,
                progress=new_progress(job["attempts"] + 1),
                processing_error=None,
                **({"recovery": dict(job["recovery"], state="processing")} if job.get("recovery") else {}),
            )
            kwargs = dict(
                requested_source=job["requested_source"],
                source_provided=job["source_provided"],
                publication_context=context,
            )
            if job.get("mode", ORGANIZE) != ORGANIZE:
                kwargs["mode"] = job["mode"]
            result = self._generate_note_payload(
                job["raw_source"],
                **kwargs,
            )
            context.complete(result)
            self.store.update(
                job_id, duration_ms=int((time.monotonic() - started) * 1000)
            )
        except Exception as exc:
            current = self.store.get(job_id)
            if current["phase"] in ("published", "completed"):
                # A post-publication callback failure cannot schedule a new model call.
                context.complete()
            elif current["phase"] == "publish_intent":
                try:
                    context.recover()
                    context.complete()
                except JobError as recovery_error:
                    self._fail(current, "publication_unknown", failure=recovery_error)
            elif isinstance(exc, JobError):
                if exc.code == "store_unavailable":
                    raise
                self._fail(current, exc.code, failure=exc)
            elif current["phase"] in ("preparing", "prepared"):
                self._fail(current, "publication_failed")
            elif (
                current["attempts"] < self.max_attempts
                and not isinstance(exc, (ValueError, TypeError))
                and (
                    not isinstance(exc, NoteGenerationError)
                    or isinstance(exc, TemporaryModelError)
                    or (
                        isinstance(exc, NoteSystemError)
                        and exc.failure_code == "archive_unavailable_or_changed"
                    )
                )
            ):
                record_failure(self.store, job_id, "generation_failed", exc)
                delay = self.retry_delays[
                    min(current["attempts"] - 1, len(self.retry_delays) - 1)
                ]
                self.store.update(
                    job_id,
                    status="queued",
                    phase="queued",
                    next_attempt_at=time.time() + delay,
                    retryable=True,
                    error=str(JobError("generation_failed")),
                    error_code="generation_failed",
                    **({"recovery": dict(current["recovery"], state="queued")} if current.get("recovery") else {}),
                )
            else:
                self._fail(
                    current,
                    (
                        "retry_exhausted"
                        if current["attempts"] >= self.max_attempts
                        else "generation_failed"
                    ),
                    failure=exc,
                )
        finally:
            self._active_job_id = None
        return True

    def reconcile_indexes(self):
        if self._reconcile_publication is None:
            return
        for job in self.store.pending_indexes():
            attempts = job.get("index_attempts", 0) + 1
            self.store.update(
                job["job_id"], index_attempts=attempts, index_next_at=time.time() + 10
            )
            try:
                reconciled = self._reconcile_publication(
                    PublicationContext(self.store, job["job_id"])
                )
            except Exception:
                self._logger.warning(
                    "Published note index recovery failed job_id=%s", job["job_id"]
                )
                continue
            if reconciled:
                self.store.update(job["job_id"], index_pending=False)

    def _worker_loop(self):
        next_cleanup = 0.0
        while not self._stopping:
            try:
                if time.monotonic() >= next_cleanup:
                    self.store.cleanup_history(expired_only=True)
                    next_cleanup = time.monotonic() + 1800
                if self.process_one():
                    continue
                self.reconcile_indexes()
            except Exception:
                self._unavailable = True
                self._logger.error(
                    "Generation queue storage unavailable; worker stopped"
                )
                return
            with self._condition:
                if not self._stopping:
                    self._condition.wait(timeout=0.5)
