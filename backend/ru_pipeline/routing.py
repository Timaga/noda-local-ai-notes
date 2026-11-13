"""Read-only canonical runtime choice before the desktop submits a note."""

import json

from flask import jsonify, request

from backend.local_request_guard import local_browser_request_allowed
from backend.note_generation_contract import NoteGenerationError
from backend.note_processing_mode import ORGANIZE, validate_mode
from backend.ru_pipeline.config import PROFILE_ID
from backend.ru_pipeline.orchestrator import uses_selected_pipeline


MAX_POLICY_BYTES = 65536


def register_runtime_route(app, deps):
    if app.extensions.get("noda_generation_runtime_policy"):
        return
    module = getattr(deps, "module", deps)

    @app.route("/generate/runtime", methods=["POST"])
    def generation_runtime_policy():
        # This endpoint uses the same origin policy before reading note data.
        if not local_browser_request_allowed():
            return jsonify({"error": "Forbidden origin"}), 403
        if not request.is_json:
            return (
                jsonify({"error": "JSON object is required", "code": "invalid_json"}),
                400,
            )
        raw = request.stream.read(MAX_POLICY_BYTES + 1)
        if len(raw) > MAX_POLICY_BYTES:
            return (
                jsonify({"error": "Request is too large", "code": "request_too_large"}),
                413,
            )
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            return (
                jsonify({"error": "JSON object is required", "code": "invalid_json"}),
                400,
            )
        if type(data) is not dict or set(data) - {"prompt", "mode"}:
            return (
                jsonify(
                    {
                        "error": "Only prompt and mode are accepted",
                        "code": "invalid_json",
                    }
                ),
                400,
            )
        if type(data.get("prompt")) is not str:
            return (
                jsonify({"error": "Prompt must be a string", "code": "invalid_prompt"}),
                400,
            )
        try:
            source = data["prompt"]
            module._validate_prompt_text(source)
            mode = validate_mode(data.get("mode", ORGANIZE))
            selected = mode == ORGANIZE and uses_selected_pipeline(module, source)
        except ValueError as exc:
            return jsonify({"error": str(exc), "code": "invalid_prompt_or_mode"}), 400
        except NoteGenerationError as exc:
            return jsonify({"error": str(exc), "code": "note_generation_failed"}), 503
        return jsonify(
            {
                "requires_legacy_runtime": not selected,
                "profile": PROFILE_ID if selected else None,
            }
        )

    app.extensions["noda_generation_runtime_policy"] = True
