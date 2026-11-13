"""Keep project work paused until the desktop commits and activates its runtime."""

from functools import wraps
import threading


class ProjectWorkGate:
    def __init__(self):
        self.lock = threading.RLock()
        self.activated = self.blocked = self.closing = False
        self.active = 0

    def wrap(self, callback):
        @wraps(callback)
        def guarded(*args, **kwargs):
            with self.lock:
                if not self.activated or self.blocked or self.closing:
                    return False
                self.active += 1
            try:
                return callback(*args, **kwargs)
            finally:
                with self.lock:
                    self.active -= 1

        return guarded


def prepare_project_queue(queue, configuration):
    """Install before queue.start, including publication recovery and index retries."""
    if configuration is None:
        return None
    gate = getattr(queue, "_project_work_gate", None)
    if gate is None:
        gate = ProjectWorkGate()
        queue._project_work_gate = gate
        for name in ("process_one", "reconcile_indexes"):
            callback = getattr(queue, name, None)
            if callable(callback):
                setattr(queue, name, gate.wrap(callback))
    return gate
