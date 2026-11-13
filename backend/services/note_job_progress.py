"""Bounded durable stage observations, independent of model output or UI timing."""

import math
import time


STAGES = ("title", "tags", "links", "save")
STATES = frozenset(("pending", "running", "completed", "failed", "skipped"))
ERROR_CODES = frozenset(
    "generation_failed retry_exhausted publication_failed publication_unknown "
    "store_unavailable storage_quota model_transport_unavailable "
    "archive_unavailable_or_changed context_budget_exceeded output_budget_exceeded "
    "provider_protocol_failed runtime_failed invalid_model_response "
    "generated_language_not_allowed title_call_budget_exceeded "
    "ru_native_shutdown_failed ru_native_startup_failed ru_native_inference_failed "
    "ru_native_client_close_failed ru_configuration_invalid ru_tag_catalog_invalid "
    "ru_stage_protocol_failed ru_runtime_path_invalid ru_runtime_overlap "
    "ru_runtime_busy ru_runtime_path_unavailable ru_runtime_lease_missing "
    "ru_scorer_engine_invalid ru_scorer_input_invalid ru_scorer_incomplete "
    "links_reranker_source_too_long links_reranker_window_budget_exceeded "
    "links_reranker_protocol_failed invalid_ru_pipeline_input "
    "retry_target_changed retry_target_busy retry_unsupported "
    "ru_generator_failed ru_reranker_failed ru_reranker_protocol_failed".split()
)
ERROR_KINDS = frozenset(("system", "model_response", "unclassified"))


def new_progress(attempt=0):
    return {
        "version": 1,
        "attempt": attempt,
        "current_stage": None,
        "stages": [
            {"id": stage, "status": "pending", "started_at": None, "finished_at": None}
            for stage in STAGES
        ],
    }


def _timestamp(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_progress(value):
    if (
        type(value) is not dict
        or set(value) != {"version", "attempt", "current_stage", "stages"}
        or type(value["version"]) is not int
        or value["version"] != 1
        or type(value["attempt"]) is not int
        or not 0 <= value["attempt"] <= 5
        or type(value["stages"]) is not list
        or len(value["stages"]) != len(STAGES)
    ):
        raise ValueError("Invalid stage progress")
    running = []
    for stage, identifier in zip(value["stages"], STAGES):
        if (
            type(stage) is not dict
            or set(stage) != {"id", "status", "started_at", "finished_at"}
            or stage["id"] != identifier
            or type(stage["status"]) is not str
            or stage["status"] not in STATES
        ):
            raise ValueError("Invalid stage observation")
        state, started, finished = (
            stage["status"],
            stage["started_at"],
            stage["finished_at"],
        )
        if state in ("pending", "skipped"):
            valid = started is None and finished is None
        elif state == "running":
            valid = _timestamp(started) and finished is None
            running.append(identifier)
        else:
            valid = _timestamp(started) and _timestamp(finished) and finished >= started
        if not valid:
            raise ValueError("Invalid stage timestamps")
    if running != ([] if value["current_stage"] is None else [value["current_stage"]]):
        raise ValueError("Inconsistent current stage")


def _allowed(value, choices):
    return type(value) is str and value in choices


def safe_error(code, *, kind=None, detail_code=None):
    return {
        "code": code if _allowed(code, ERROR_CODES) else "generation_failed",
        "kind": kind if _allowed(kind, ERROR_KINDS) else "unclassified",
        "detail_code": (
            detail_code if _allowed(detail_code, ERROR_CODES) else "generation_failed"
        ),
    }


def validate_error(value):
    if value is None:
        return
    if (
        type(value) is not dict
        or set(value) != {"code", "kind", "detail_code"}
        or not _allowed(value["code"], ERROR_CODES)
        or not _allowed(value["kind"], ERROR_KINDS)
        or not _allowed(value["detail_code"], ERROR_CODES)
    ):
        raise ValueError("Invalid processing error")


def update_stage(store, job_id, identifier, state):
    if identifier not in STAGES or state not in ("running", "completed", "skipped") or (
        identifier == "save" and state == "skipped"
    ):
        raise ValueError("Unknown generation stage transition")
    job = store.get(job_id)
    progress = job.get("progress")
    if progress is None:
        # Old records have no stage observations; do not reconstruct model history.
        return
    validate_progress(progress)
    if job["status"] not in ("queued", "processing"):
        return
    index = STAGES.index(identifier)
    stage = progress["stages"][index]
    now = time.time()
    if state == "running":
        if progress["current_stage"] not in (None, identifier):
            raise ValueError("Previous generation stage is still running")
        if stage["status"] == "running":
            return
        # A bounded alphabet retry can restart an already observed stage.
        for later in progress["stages"][index:]:
            later.update(status="pending", started_at=None, finished_at=None)
        stage.update(status="running", started_at=now)
        progress["current_stage"] = identifier
    elif state == "skipped":
        if progress["current_stage"] is not None:
            raise ValueError("Previous generation stage is still running")
        if stage["status"] == "skipped":
            return
        if stage["status"] != "pending":
            raise ValueError("Generation stage has already started")
        stage.update(status="skipped")
    else:
        if stage["status"] == "completed":
            return
        if stage["status"] != "running":
            raise ValueError("Generation stage has not started")
        stage.update(status="completed", finished_at=max(now, stage["started_at"]))
        progress["current_stage"] = None
    store.update(job_id, progress=progress)


def record_failure(store, job_id, code, failure=None):
    job = store.get(job_id)
    progress = job.get("progress")
    if progress is not None:
        validate_progress(progress)
        for stage in progress["stages"]:
            if stage["status"] == "running":
                stage.update(
                    status="failed", finished_at=max(time.time(), stage["started_at"])
                )
        progress["current_stage"] = None
    store.update(
        job_id,
        progress=progress,
        processing_error=safe_error(
            code,
            kind=getattr(failure, "failure_kind", None),
            detail_code=getattr(failure, "failure_code", code),
        ),
    )


def public_outcome(job):
    result = job.get("result")
    generation = result.get("generation") if type(result) is dict else None
    pending = type(generation) is dict and generation.get("metadata_pending") is True
    error = job.get("processing_error")
    if pending and error is None:
        error = safe_error(
            generation.get("failure_code"),
            kind=generation.get("failure_kind"),
            detail_code=generation.get("failure_detail_code"),
        )
    return {
        "progress": job.get("progress"),
        "processing_outcome": (
            "source_saved"
            if pending and job["status"] == "completed"
            else {
                "queued": "pending",
                "processing": "processing",
                "completed": "completed",
            }.get(job["status"], "failed")
        ),
        "processing_error": error,
    }
