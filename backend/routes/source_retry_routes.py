"""Capability-bound retry of one existing saved source, without accepting file paths."""

import json
import re
from flask import jsonify, request


def register_source_retry_route(app, deps):
    @app.route(
        "/generate/jobs/<string:job_id>/retry",
        methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    )
    def retry_note_generation(job_id):
        if request.method != "POST":
            return jsonify({"error": "Method not allowed"}), 405
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            return (
                jsonify(
                    {"error": "Invalid job id format", "code": "invalid_retry_request"}
                ),
                400,
            )
        if not request.is_json:
            return (
                jsonify(
                    {"error": "Invalid retry request", "code": "invalid_retry_request"}
                ),
                400,
            )
        raw = request.stream.read(513)
        if len(raw) > 512:
            return (
                jsonify({"error": "Request is too large", "code": "request_too_large"}),
                413,
            )
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            return (
                jsonify(
                    {"error": "Invalid retry request", "code": "invalid_retry_request"}
                ),
                400,
            )
        if (
            type(data) is not dict
            or set(data) != {"client_request_id", "expected_vault_id"}
            or type(data["client_request_id"]) is not str
            or type(data["expected_vault_id"]) is not str
            or not re.fullmatch(r"[a-f0-9]{32}", data["expected_vault_id"])
        ):
            return (
                jsonify(
                    {"error": "Invalid retry request", "code": "invalid_retry_request"}
                ),
                400,
            )
        result = deps.module.note_generation_queue.retry(job_id, **data)
        status = 202 if result["job"]["status"] in ("queued", "processing") else 200
        return jsonify(result), status
