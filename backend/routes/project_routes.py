"""Desktop-owned project handshake and reversible admission barrier."""

import hmac
import os

from flask import jsonify, request

try:
    from backend.local_request_guard import local_browser_request_allowed
    from backend.project_context import install_project_context
except ImportError:
    from local_request_guard import local_browser_request_allowed
    from project_context import (
        install_project_context as _standalone_install_project_context,
    )

    install_project_context = _standalone_install_project_context


def register_project_routes(app, deps):
    module = getattr(deps, "module", deps)
    coordinator = install_project_context(app, module)

    @app.get("/projects/context")
    def project_runtime_context():
        if not local_browser_request_allowed():
            return jsonify(error="Forbidden origin"), 403
        if coordinator is None:
            return jsonify(
                project_id=None, context_token=None, vault_id=None, ready=False
            )
        response = jsonify(coordinator.runtime_payload())
        response.headers["Cache-Control"] = "no-store"
        return response

    def authorize_control():
        expected = os.environ.get("TEST_GUI_SHUTDOWN_TOKEN", "")
        supplied = request.headers.get("X-Test-Gui-Shutdown-Token", "")
        if (
            not local_browser_request_allowed()
            or not expected
            or not hmac.compare_digest(
                supplied.encode("utf-8"), expected.encode("utf-8")
            )
        ):
            return jsonify(error="Forbidden", code="project_control_forbidden"), 403
        if coordinator is None or not coordinator.context_matches():
            return jsonify(error="Project changed", code="project_changed"), 409
        if request.args or request.stream.read(1):
            return (
                jsonify(
                    error="Unexpected project control payload",
                    code="invalid_project_control",
                ),
                400,
            )
        return None

    @app.post("/projects/activate")
    def activate_project_runtime():
        denied = authorize_control()
        if denied is not None:
            return denied
        try:
            activated = coordinator.activate()
        except Exception:
            app.logger.warning("Project background activation failed")
            activated = False
        if not activated:
            return (
                jsonify(
                    error="Project activation failed", code="project_activation_failed"
                ),
                503,
            )
        return jsonify(
            ok=True,
            project_id=coordinator.configuration.project_id,
            context_token=coordinator.configuration.context_token,
            activated=True,
        )

    @app.post("/projects/prepare-switch")
    def prepare_project_switch():
        denied = authorize_control()
        if denied is not None:
            return denied
        status = coordinator.prepare()
        if status != "ready":
            code, http = (
                ("project_busy", 409)
                if status == "busy"
                else ("project_unavailable", 503)
            )
            return jsonify(error="Project cannot switch yet", code=code), http
        return jsonify(
            ok=True,
            project_id=coordinator.configuration.project_id,
            context_token=coordinator.configuration.context_token,
            frozen=True,
        )

    @app.post("/projects/cancel-switch")
    def cancel_project_switch():
        denied = authorize_control()
        if denied is not None:
            return denied
        if not coordinator.cancel():
            return (
                jsonify(error="Project runtime is closing", code="project_switching"),
                503,
            )
        return jsonify(
            ok=True,
            project_id=coordinator.configuration.project_id,
            context_token=coordinator.configuration.context_token,
            frozen=False,
        )
