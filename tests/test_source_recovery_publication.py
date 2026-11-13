"""Prepared-artifact and immutable-source checks at the recovery write boundary."""

import os
import uuid

import pytest

from backend.services.note_job_store import JobError
from backend.services.source_note_recovery import SourceRecoveryContext
from backend.ru_pipeline.orchestrator import render_source
from test_source_note_recovery import (
    RAW,
    generated,
    retry,
    saved_source,
    successful,
    version,
)


pytestmark = pytest.mark.skipif(
    os.name != "nt", reason="Strict Windows recovery protocol"
)


@pytest.mark.parametrize("tamper", ["identity", "content", "new_hash"])
def test_prepared_artifact_tampering_cannot_replace_the_saved_source(
    tmp_path, monkeypatch, tamper
):
    queue, old, target = saved_source(tmp_path)
    queue._generate_note_payload = successful(tmp_path)
    original_prepare = SourceRecoveryContext._prepare

    def changed(context, job):
        prepared = original_prepare(context, job)
        if tamper == "identity":
            replacement = context.store.prepared / "synthetic-replacement.tmp"
            replacement.write_bytes(context.prepared.read_bytes())
            replacement.replace(context.prepared)
        elif tamper == "content":
            context.prepared.write_bytes(b"Synthetic corrupt prepared content")
        else:
            context.store.update(
                context.job_id, recovery=dict(prepared["recovery"], new_sha256="0" * 64)
            )
            prepared = context.store.get(context.job_id)
        return prepared

    try:
        retry(queue, old["job_id"])
        monkeypatch.setattr(SourceRecoveryContext, "_prepare", changed)
        queue.process_one()
        result = queue.get_job(old["job_id"])
        assert result["processing_outcome"] != "completed"
        assert target.read_bytes() == RAW.encode("utf-8")
        assert queue.store.get(old["job_id"])["raw_source"] == RAW
        assert len(list(tmp_path.glob("*.md"))) == 1
    finally:
        queue.close()


@pytest.mark.parametrize(
    "change", ["source", "plain_body", "metadata_pending", "missing_generation"]
)
def test_model_result_must_contain_the_exact_original_source_in_a_valid_wrapper(
    tmp_path, change
):
    queue, old, target = saved_source(tmp_path)

    def wrong(source, *, publication_context, **kwargs):
        draft = generated(source + "Changed source" if change == "source" else source)
        if change == "plain_body":
            draft["content"] = source
        elif change == "metadata_pending":
            draft["generation"]["metadata_pending"] = True
        elif change == "missing_generation":
            draft.pop("generation")
        return publication_context.publish(tmp_path, draft)

    queue._generate_note_payload = wrong
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        result = queue.get_job(old["job_id"])
        assert result["processing_outcome"] == "source_saved"
        assert result["processing_error"]["code"] == "publication_failed"
        assert target.read_bytes() == RAW.encode("utf-8") and version(queue) == 1
    finally:
        queue.close()


def test_file_identity_change_during_generation_is_not_overwritten_even_with_same_bytes(
    tmp_path,
):
    queue, old, target = saved_source(tmp_path)
    replacement_identity = []

    def replaced(source, *, publication_context, **kwargs):
        temporary = tmp_path / "synthetic-user-replacement.txt"
        temporary.write_bytes(source.encode("utf-8"))
        temporary.replace(target)
        replacement_identity.append(target.stat().st_ino)
        return publication_context.publish(tmp_path, generated(source))

    queue._generate_note_payload = replaced
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        result = queue.get_job(old["job_id"])
        assert result["recovery_summary"]["status"] == "conflict"
        assert (
            result["retry_available"] is False
            and target.stat().st_ino == replacement_identity[0]
        )
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()


def test_bad_related_path_fails_then_a_new_manual_cycle_can_use_the_same_receipt(
    tmp_path,
):
    queue, old, target = saved_source(tmp_path)
    (tmp_path / "Known.md").write_text(
        "Синтетическая существующая заметка", encoding="utf-8"
    )

    def related(source, *, publication_context, **kwargs):
        draft = generated(source)
        draft["links"] = ["Known"]
        draft["content"] = render_source(source, draft["display_title"], [], ["Known"])
        path = publication_context.publish(
            tmp_path, draft, related_paths=["../missing.md"]
        )
        return dict(draft, title=path.stem)

    queue._generate_note_payload = related
    try:
        retry(queue, old["job_id"])
        queue.process_one()
        assert queue.get_job(old["job_id"])["processing_outcome"] == "source_saved"
        assert target.read_bytes() == RAW.encode("utf-8")
        queue._generate_note_payload = successful(tmp_path)
        retry(queue, old["job_id"])
        queue.process_one()
        assert queue.get_job(old["job_id"])["processing_outcome"] == "completed"
        assert len(list(tmp_path.glob("*.md"))) == 2
    finally:
        queue.close()


def test_unstarted_context_recovery_and_missing_retry_request_are_rejected(tmp_path):
    queue, old, target = saved_source(tmp_path)
    try:
        with pytest.raises(JobError) as error:
            queue.retry(
                old["job_id"],
                client_request_id=None,
                expected_vault_id=queue.store.vault_id,
            )
        assert error.value.code == "invalid_request_id"
        retry(queue, old["job_id"])
        with pytest.raises(JobError) as error:
            SourceRecoveryContext(queue.store, old["job_id"]).recover()
        assert error.value.code == "publication_failed"
        assert target.read_bytes() == RAW.encode("utf-8")
    finally:
        queue.close()
