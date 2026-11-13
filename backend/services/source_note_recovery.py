"""Same-canonical recovery publication under an exclusive Windows file handle."""

import hashlib
from contextlib import ExitStack
from pathlib import Path
import time
from types import SimpleNamespace

from backend.note_faithful_archive import wrapper_metadata
from backend.note_publication import PublicationContext, file_identity
from .note_job_progress import record_failure
from .note_job_store import JobError, checked_child
from .source_recovery_admission import file_error
from .windows_note_file import LocalNoteFileError, locked_note


class SourceRecoveryContext(PublicationContext):
    @property
    def excluded_note_identity(self):
        return Path(self.store.get(self.job_id)["recovery"]["target"]).stem

    def publish(self, vault, draft, *, related_paths=()):
        job = self.store.get(self.job_id)
        body = draft.get("content")
        metadata, source = wrapper_metadata(body) if type(body) is str else (None, None)
        generation = draft.get("generation")
        if (
            type(body) is not str
            or metadata is None
            or source != job["raw_source"]
            or type(generation) is not dict
            or generation.get("metadata_pending") is True
        ):
            raise JobError("publication_failed")
        return super().publish(vault, draft, related_paths=related_paths)

    def _prepared_bytes(self, job):
        if file_identity(self.prepared) != job["prepared_identity"]:
            raise JobError("publication_failed")
        body = self.prepared.read_bytes()
        if body != job["draft"]["content"].encode("utf-8"):
            raise JobError("publication_failed")
        for relative in job.get("related_paths", []):
            target = self.store.vault / relative
            if (
                target.is_symlink()
                or not target.is_file()
                or self.store.vault not in target.resolve().parents
            ):
                raise JobError("publication_failed")
        return body

    def _publish_prepared(self, job):
        body = self._prepared_bytes(job)
        recovery = dict(job["recovery"])
        target = self._target(recovery["target"])
        new_hash = hashlib.sha256(body).hexdigest()
        if recovery["new_sha256"] not in (None, new_hash):
            raise JobError("publication_unknown")
        try:
            with ExitStack() as locks:
                backup_path = checked_child(
                    self.store.prepared, self.job_id + ".source-backup"
                )
                backup = locks.enter_context(
                    locked_note(backup_path, max_bytes=self.store.MAX_RECORD_BYTES)
                )
                if backup.read_all() != job["raw_source"].encode("utf-8"):
                    raise JobError("publication_unknown")
                note = locks.enter_context(
                    locked_note(target, max_bytes=self.store.MAX_RECORD_BYTES)
                )
                actual = note.read_all()
                proof = note.snapshot()
                if proof["identity"] != recovery["expected"]["identity"]:
                    raise JobError("retry_target_changed")
                if job["phase"] == "publish_intent" and actual == body:
                    self._record_published(target, job["draft"])
                    return target
                expected = recovery["expected"]
                if actual != job["raw_source"].encode("utf-8") or any(
                    proof[key] != expected[key]
                    for key in ("identity", "size", "mtime_ns")
                ):
                    raise JobError("retry_target_changed")
                recovery.update(new_sha256=new_hash, state="processing")
                self.store.update(
                    self.job_id,
                    phase="publish_intent",
                    target=target.name,
                    recovery=recovery,
                )
                note.write_all(body)
                self._record_published(target, job["draft"])
                return target
        except LocalNoteFileError as exc:
            raise file_error(exc) from exc

    def recover(self):
        job = self.store.get(self.job_id)
        if job["phase"] == "preparing":
            job = self._prepare(job)
        if job["phase"] in ("prepared", "publish_intent"):
            return self._publish_prepared(job)
        if job["phase"] not in ("published", "completed"):
            raise JobError("publication_failed")
        return job["result"]

    def _completion_fields(self, job):
        recovery = dict(job["recovery"], state="completed")
        return {"recovery": recovery, "processing_error": None}


def publication_context(store, job):
    kind = SourceRecoveryContext if job.get("recovery") else PublicationContext
    return kind(store, job["job_id"])


def fail_recovery(store, job, code, failure=None):
    if isinstance(failure, JobError):
        failure = SimpleNamespace(failure_kind="system", failure_code=failure.code)
    record_failure(store, job["job_id"], code, failure)
    job = store.get(job["job_id"])
    recovery = dict(job["recovery"])
    uncertain = job["phase"] == "publish_intent" or code in (
        "publication_unknown",
        "retry_target_changed",
    )
    recovery["state"] = "conflict" if uncertain else "failed"
    previous = dict(recovery["original_result"])
    error = job["processing_error"]
    previous["generation"] = dict(
        previous["generation"],
        metadata_pending=True,
        failure_code=error["code"],
        failure_kind=error["kind"],
        failure_detail_code=error["detail_code"],
    )
    store.update(
        job["job_id"],
        recovery=recovery,
        status="failed" if uncertain else "completed",
        phase="publication_unknown" if uncertain else "completed",
        draft=previous,
        result=previous,
        target=recovery["target"],
        prepared_identity=recovery["expected"]["identity"],
        index_pending=recovery["original_index_pending"],
        error=str(JobError("publication_unknown")) if uncertain else None,
        error_code="publication_unknown" if uncertain else None,
        retryable=False,
        finished_at=time.time(),
        duration_ms=(
            max(0, int((time.time() - job["started_at"]) * 1000))
            if job.get("started_at") is not None
            else None
        ),
    )
