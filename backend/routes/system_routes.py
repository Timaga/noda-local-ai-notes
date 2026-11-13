import hmac
import ipaddress
import os

from flask import jsonify, request


# Who: Tim Buglaev
# When: 2026-03-26
# What: Split operational health endpoints into a dedicated module to keep app entrypoint focused on
#       composition and preserve backward-compatible aliases for existing clients.
def register_system_routes(app, deps):
    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Resolve the shared runtime module from the route dependency wrapper so
    #       lifecycle operations use the same owned process state as backend startup.
    module = getattr(deps, "module", deps)

    @app.route("/ping", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def ping():
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
        # Who: Tim Buglaev
        # When: 2026-06-24
        # What: Return the non-secret managed-instance identity so Electron can
        #       distinguish its child from stale local processes on the same port.
        instance_id = str(os.environ.get("TEST_GUI_INSTANCE_ID") or "")[:128]
        return jsonify({"status": "ok", "version": "local-only", "instance_id": instance_id})

    # Who: Tim Buglaev
    # When: 2026-03-26
    # What: Kept backward-compatible health aliases while removing cloud-centric naming from payload fields
    #       so diagnostics explicitly describe local-only backend status without implying cloud model support.
    @app.route("/test", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    @app.route("/local-test", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    @app.route("/gemini-test", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def local_test():
        if request.method != "GET":
            return jsonify({"error": "Method not allowed"}), 405
        return jsonify(
            {
                "ok": True,
                "mode": "local-only",
                "backend": "local",
                "cloud_enabled": False,
                "local_models_only": True,
                "reply": "OK",
            }
        )

    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Add an authenticated loopback-only lifecycle hook that stops owned Qdrant and
    #       optionally schedules backend self-exit, avoiding Windows child-PID races.
    @app.route("/runtime/shutdown-managed", methods=["POST"])
    def shutdown_managed_runtime():
        try:
            remote_address = ipaddress.ip_address(str(request.remote_addr or ""))
        except ValueError:
            remote_address = None
        expected_token = str(os.environ.get("TEST_GUI_SHUTDOWN_TOKEN") or "")
        provided_token = str(request.headers.get("X-Test-Gui-Shutdown-Token") or "")
        if (
            remote_address is None
            or not remote_address.is_loopback
            or not expected_token
            or not hmac.compare_digest(provided_token.encode("utf-8"), expected_token.encode("utf-8"))
        ):
            app.logger.warning("Managed shutdown request rejected remote=%s", request.remote_addr)
            return jsonify({"error": "Forbidden", "code": "managed_shutdown_forbidden"}), 403

        project = app.extensions.get("noda_project_context")
        if project is not None:
            if not project.context_matches():
                return jsonify(error="Project changed", code="project_changed"), 409
            if not project.shutdown():
                return jsonify(error="Project is busy", code="project_busy"), 409
        process = getattr(module, "qdrant_process", None)
        managed_pid = int(getattr(process, "pid", 0) or 0)
        cleanup = getattr(module, "_cleanup_qdrant_process", None)
        cleanup_ok = bool(cleanup()) if callable(cleanup) else not managed_pid
        stop_backend = request.headers.get("X-Test-Gui-Stop-Backend") == "1"
        exit_scheduler = getattr(module, "_schedule_backend_exit", None)
        exit_scheduled = bool(exit_scheduler()) if cleanup_ok and stop_backend and callable(exit_scheduler) else False
        app.logger.info(
            "Managed shutdown completed qdrant_pid=%s stopped=%s backend_exit=%s",
            managed_pid or "none",
            cleanup_ok,
            exit_scheduled,
        )
        return jsonify(
            {
                "ok": cleanup_ok,
                "qdrant_stopped": cleanup_ok,
                "backend_exit_scheduled": exit_scheduled,
            }
        ), (200 if cleanup_ok else 503)
