"""Job-bound publication and recovery without repeating an acknowledged file write."""

import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

try:
    from backend.services.note_job_store import JobError, checked_child
except ImportError:
    from services.note_job_store import JobError, checked_child


def verify_publication_storage(store):
    descriptor, source = tempfile.mkstemp(prefix="probe-", dir=store.prepared)
    target = source + ".link"
    try:
        os.close(descriptor)
        os.link(source, target)
        if not os.path.samefile(source, target):
            raise OSError("File identity unavailable")
    except OSError as exc:
        raise JobError("store_unavailable") from exc
    finally:
        for path in (target, source):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def file_identity(path):
    stat = path.stat()
    if not stat.st_ino:
        raise JobError("publication_failed")
    return [stat.st_dev, stat.st_ino]


class PublicationContext:
    def __init__(self, store, job_id):
        self.store, self.job_id = store, job_id
        if len(job_id) != 32 or any(char not in "0123456789abcdef" for char in job_id):
            raise ValueError("Invalid internal job ID")

    @property
    def prepared(self):
        return checked_child(self.store.prepared, self.job_id + ".prepared")

    def report_stage(self, identifier, state):
        try:
            from backend.services.note_job_progress import update_stage
        except ImportError:
            from services.note_job_progress import update_stage
        update_stage(self.store, self.job_id, identifier, state)

    def _target(self, name):
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or not name.endswith(".md")
        ):
            raise JobError("publication_unknown")
        return checked_child(self.store.vault, name)

    def _prepare(self, job):
        body = job["draft"]["content"]
        temporary = checked_child(self.store.prepared, self.job_id + ".writing")
        if temporary.exists():
            if not temporary.is_file():
                raise JobError("publication_failed")
            temporary.unlink()
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.prepared)
            return self.store.update(
                self.job_id,
                phase="prepared",
                prepared_identity=file_identity(self.prepared),
            )
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def publish(self, vault, draft, *, related_paths=()):
        if Path(vault).resolve(strict=True) != self.store.vault:
            raise JobError("publication_failed")
        job = self.store.get(self.job_id)
        if job["phase"] not in ("generating", "queued"):
            raise JobError("publication_unknown")
        if not isinstance(draft.get("content"), str) or not draft["content"]:
            raise JobError("publication_failed")
        # JSON snapshot is independent of the mutable hardlinked file.
        snapshot = json.loads(json.dumps(draft, ensure_ascii=False))
        self.report_stage("save", "running")
        job = self.store.update(
            self.job_id,
            status="processing",
            phase="preparing",
            draft=snapshot,
            related_paths=list(related_paths),
        )
        job = self._prepare(job)
        return self._publish_prepared(job)

    def _publish_prepared(self, job):
        try:
            from backend.note_generation_persistence import safe_title
        except ImportError:
            from note_generation_persistence import safe_title

        if file_identity(self.prepared) != job["prepared_identity"]:
            raise JobError("publication_failed")
        original = job["draft"]["content"].encode("utf-8")
        if (
            hashlib.sha256(self.prepared.read_bytes()).digest()
            != hashlib.sha256(original).digest()
        ):
            raise JobError("publication_failed")
        for relative in job.get("related_paths", []):
            target = self.store.vault / relative
            resolved = target.resolve()
            if (
                self.store.vault not in resolved.parents
                or not resolved.is_file()
                or target.is_symlink()
            ):
                raise JobError("publication_failed")
        base = safe_title(job["draft"]["title"])
        for index in range(10000):
            name = (base if index == 0 else f"{base} {index}") + ".md"
            target = self._target(name)
            if target.exists():
                continue
            self.store.update(self.job_id, phase="publish_intent", target=name)
            try:
                os.link(self.prepared, target)
            except FileExistsError:
                self.store.update(self.job_id, phase="prepared", target=None)
                continue
            except OSError as exc:
                # An interrupted publication must be reconciled before another write.
                raise JobError("publication_unknown") from exc
            self._record_published(target, job["draft"])
            return target
        raise JobError("publication_failed")

    def _record_published(self, target, draft):
        result = dict(draft)
        result["title"] = target.stem
        result.setdefault("warnings", [])
        self.store.update(
            self.job_id, phase="published", result=result, index_pending=True
        )

    def recover(self):
        job = self.store.get(self.job_id)
        phase = job["phase"]
        if phase == "preparing":
            job = self._prepare(job)
            phase = "prepared"
        if phase == "prepared":
            self._publish_prepared(job)
        elif phase == "publish_intent":
            target = self._target(job.get("target"))
            try:
                same = (
                    target.is_file()
                    and self.prepared.is_file()
                    and os.path.samefile(target, self.prepared)
                )
                same = same and file_identity(self.prepared) == job["prepared_identity"]
            except OSError:
                same = False
            if not same:
                raise JobError("publication_unknown")
            self._record_published(target, job["draft"])
        elif phase not in ("published", "completed"):
            raise JobError("publication_failed")
        return self.store.get(self.job_id)["result"]

    def complete(self, result=None):
        job = self.store.get(self.job_id)
        if job["phase"] not in ("published", "completed") or not job.get("result"):
            raise JobError("publication_failed")
        snapshot = dict(job["result"])
        if result is not None:
            # The callback may enrich timings/warnings, never replace the published body.
            if any(
                result.get(key) != snapshot.get(key)
                for key in ("title", "content", "tags", "links")
            ):
                raise JobError("publication_unknown")
            snapshot.update(result)
        elif job.get("index_pending"):
            snapshot["warnings"] = list(snapshot.get("warnings", [])) + [
                "Заметка сохранена; состояние поискового индекса будет проверено при чтении."
            ]
        progress = job.get("progress")
        if progress is not None and job["status"] != "completed":
            save = progress["stages"][-1]
            if save["status"] == "pending":
                self.report_stage("save", "running")
            self.report_stage("save", "completed")
        self.store.update(
            self.job_id,
            status="completed",
            phase="completed",
            result=snapshot,
            finished_at=time.time(),
            error=None,
            error_code=None,
            retryable=False,
            **self._completion_fields(job),
        )
        try:
            self.prepared.unlink(missing_ok=True)
        except OSError:
            # Publication is committed. Cleanup cannot undo success or start a retry.
            return False
        return True

    def _completion_fields(self, job):
        return {}
