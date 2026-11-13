"""Validated DELETE adapter for one project-bound queue job."""

import re
from flask import jsonify, request


def remove_generation_job(queue, job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id or ""):
        return jsonify(error="Invalid job id", code="invalid_delete_request"), 400
    values = request.args.getlist("expected_vault_id")
    if (
        set(request.args) != {"expected_vault_id"}
        or len(values) != 1
        or not re.fullmatch(r"[a-f0-9]{32}", values[0])
        or request.stream.read(1)
    ):
        return (
            jsonify(error="Invalid removal request", code="invalid_delete_request"),
            400,
        )
    return jsonify(queue.remove(job_id, expected_vault_id=values[0]))
