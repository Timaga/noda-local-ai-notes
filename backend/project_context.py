"""Per-runtime project fencing and an atomic, fail-closed switch barrier."""

from functools import wraps
import hashlib
import hmac
import os
import re
import threading
import time

from flask import g, jsonify, request

try:
    from backend.local_request_guard import local_browser_request_allowed
    from backend.project_storage import project_configuration
    from backend.project_activation import prepare_project_queue
except ImportError:
    from local_request_guard import local_browser_request_allowed
    from project_storage import project_configuration
    from project_activation import (
        prepare_project_queue as _standalone_prepare_project_queue,
    )

    prepare_project_queue = _standalone_prepare_project_queue


_ID = re.compile(r"[a-f0-9]{32}\Z")
_DATA_PREFIXES = (
    "/notes",
    "/notes-graph",
    "/note-detail",
    "/note-assets",
    "/tags",
    "/rag",
    "/generate",
    "/model-status",
    "/model-initialize",
    "/model",
    "/models",
    "/training",
    "/runtime/config",
    "/runtime/note-pipeline",
)


def _data_request(path):
    return any(
        path == prefix or path.startswith(prefix + "/") for prefix in _DATA_PREFIXES
    )


def _root(value):
    if not isinstance(value, (str, os.PathLike)):
        return None
    raw = os.fspath(value)
    if not isinstance(raw, str) or not os.path.isabs(raw):
        return None
    return os.path.normcase(os.path.normpath(raw))


class ProjectCoordinator:
    def __init__(self, configuration, module):
        self.configuration, self.module = configuration, module
        self.work_gate = prepare_project_queue(
            module.note_generation_queue, configuration
        )
        self.condition = threading.Condition(self.work_gate.lock)
        self.active = self.producers = 0
        self.frozen = self.closing = self.closed = False

    def context_matches(self):
        expected = self.configuration
        project = request.headers.get("X-Noda-Project-Id")
        context = request.headers.get("X-Noda-Project-Context")
        if request.method == "GET" and request.endpoint == "get_note_asset":
            query = request.args
            if "project_id" in query or "project_context" in query:
                if (
                    len(query.getlist("project_id")) != 1
                    or len(query.getlist("project_context")) != 1
                ):
                    return False
                query_project, query_context = (
                    query["project_id"],
                    query["project_context"],
                )
                if (project is not None and project != query_project) or (
                    context is not None and context != query_context
                ):
                    return False
                project, context = query_project, query_context
        return (
            isinstance(project, str)
            and _ID.fullmatch(project) is not None
            and isinstance(context, str)
            and _ID.fullmatch(context) is not None
            and hmac.compare_digest(project, expected.project_id)
            and hmac.compare_digest(context, expected.context_token)
        )

    def runtime_payload(self):
        config, module = self.configuration, self.module
        store = getattr(getattr(module, "note_generation_queue", None), "store", None)
        vault_id = getattr(store, "vault_id", None)
        actual_root = _root(getattr(module, "NOTES_DIR", None))
        actual_collection = getattr(
            getattr(module, "backend_config", None),
            "COLLECTION_NAME",
            config.collection_name,
        )
        service = getattr(module, "qdrant_service", None)
        service_collection = getattr(service, "collection_name", config.collection_name)
        ready = bool(
            actual_root == _root(config.notes_directory)
            and _root(getattr(store, "vault", None)) == actual_root
            and isinstance(vault_id, str)
            and _ID.fullmatch(vault_id)
            and actual_collection == config.collection_name
            and service_collection == config.collection_name
            and not self.frozen
            and not self.closed
        )
        return {
            "project_id": config.project_id,
            "context_token": config.context_token,
            "vault_id": vault_id if ready else None,
            "ready": ready,
            "activated": self.work_gate.activated,
            "collection_name": config.collection_name,
            "root_sha256": (
                hashlib.sha256(actual_root.encode("utf-8")).hexdigest()
                if actual_root
                else None
            ),
        }

    def _busy(self):
        queue = getattr(self.module, "note_generation_queue", None)
        if queue is None:
            return None
        try:
            stats = queue.stats()
            if (
                type(stats.get("queued_count")) is not int
                or type(stats.get("processing")) is not bool
            ):
                return None
            runner = getattr(self.module, "_training_runner", None)
            training = (
                runner.current_status().get("status") if runner is not None else "idle"
            )
            return bool(
                self.active
                or self.producers
                or self.work_gate.active
                or (
                    self.work_gate.activated
                    and (stats["queued_count"] or stats["processing"])
                )
                or getattr(queue, "_active_job_id", None) is not None
                or training not in ("idle", "completed", "failed", "skipped", "success")
            )
        except Exception:
            return None

    def prepare(self):
        with self.condition:
            if self.frozen:
                return "ready" if not self.closed else "unavailable"
            busy = self._busy()
            if busy is None or not self.runtime_payload()["ready"]:
                return "unavailable"
            if busy:
                return "busy"
            self.frozen = True
            self.work_gate.blocked = True
            return "ready"

    def activate(self):
        with self.condition:
            if self.frozen or self.closing or not self.runtime_payload()["ready"]:
                return False
            if self.work_gate.activated:
                return True
            background = getattr(self.module, "_activate_project_background", None)
            if callable(background):
                background()
            self.work_gate.activated = True
            queue = self.module.note_generation_queue
            condition = getattr(queue, "_condition", None)
            if condition is not None:
                with condition:
                    condition.notify_all()
            return True

    def cancel(self):
        with self.condition:
            if self.closing or self.closed:
                return False
            self.frozen = False
            self.work_gate.blocked = False
            return True

    def producer(self, callback):
        @wraps(callback)
        def guarded(*args, **kwargs):
            with self.condition:
                if self.frozen or self.closing or not self.work_gate.activated:
                    return False
                self.producers += 1
            try:
                return callback(*args, **kwargs)
            finally:
                with self.condition:
                    self.producers -= 1
                    self.condition.notify_all()

        return guarded

    def shutdown(self, timeout=5):
        with self.condition:
            if self.closed:
                return True
            if self.prepare() != "ready" or self._busy() is not False:
                return False
            self.closing = True
            self.work_gate.closing = True
        observer = getattr(self.module, "_notes_observer", None)
        try:
            if observer is not None:
                observer.stop()
                observer.join(timeout=timeout)
                if observer.is_alive():
                    return False
            lock = getattr(self.module, "_note_autolink_lock", None)
            state = getattr(self.module, "_note_autolink_state", {})
            timers = []
            if lock is not None:
                with lock:
                    timers = [
                        item.get("timer")
                        for item in state.values()
                        if item.get("timer") is not None
                    ]
                    state.clear()
            deadline = time.monotonic() + timeout
            for timer in timers:
                timer.cancel()
            for timer in timers:
                timer.join(timeout=max(0, deadline - time.monotonic()))
                if timer.is_alive():
                    return False
            if self.module.note_generation_queue.close(timeout=timeout) is not True:
                return False
        except Exception:
            return False
        with self.condition:
            self.closed = True
        return True


def install_project_context(app, module):
    if "noda_project_context" in app.extensions:
        return app.extensions["noda_project_context"]
    configuration = project_configuration()
    if configuration is None:
        return None
    coordinator = ProjectCoordinator(configuration, module)
    app.extensions["noda_project_context"] = coordinator
    for name in ("_handle_note_update", "_handle_note_delete"):
        callback = getattr(module, name, None)
        if callable(callback):
            setattr(module, name, coordinator.producer(callback))
    queue = getattr(module, "note_generation_queue", None)
    callback = getattr(queue, "_reconcile_publication", None)
    if callable(callback):
        queue._reconcile_publication = coordinator.producer(callback)
    getter = getattr(module, "_get_training_runner", None)
    if callable(getter):

        def fence_training(runner):
            if not getattr(runner, "_noda_project_fenced", False):
                start = runner.start_run

                @wraps(start)
                def guarded_training(*args, **kwargs):
                    with coordinator.condition:
                        if coordinator.frozen or not coordinator.work_gate.activated:
                            return {"status": "busy", "code": "project_switching"}
                        coordinator.producers += 1
                    try:
                        return start(*args, **kwargs)
                    finally:
                        with coordinator.condition:
                            coordinator.producers -= 1
                            coordinator.condition.notify_all()

                runner.start_run = guarded_training
                runner._noda_project_fenced = True
            return runner

        @wraps(getter)
        def guarded_getter(*args, **kwargs):
            return fence_training(getter(*args, **kwargs))

        module._get_training_runner = guarded_getter
        runner = getattr(module, "_training_runner", None)
        if runner is not None:
            fence_training(runner)

    @app.before_request
    def fence_project_data():
        if not _data_request(request.path):
            return None
        if not local_browser_request_allowed():
            return jsonify(error="Forbidden origin"), 403
        if not coordinator.context_matches():
            return jsonify(error="Project changed", code="project_changed"), 409
        with coordinator.condition:
            if coordinator.frozen:
                return (
                    jsonify(error="Project is switching", code="project_switching"),
                    503,
                )
            if not coordinator.runtime_payload()["ready"]:
                return (
                    jsonify(error="Project is unavailable", code="project_unavailable"),
                    503,
                )
            if not coordinator.work_gate.activated:
                return (
                    jsonify(error="Project is starting", code="project_starting"),
                    503,
                )
            coordinator.active += 1
            g.noda_project_active = True
        return None

    def release_request():
        if getattr(g, "noda_project_active", False):
            g.noda_project_active = False
            with coordinator.condition:
                coordinator.active -= 1
                coordinator.condition.notify_all()

    @app.after_request
    def release_project_data(response):
        release_request()
        if _data_request(request.path):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.teardown_request
    def release_project_exception(_error):
        release_request()

    return coordinator
