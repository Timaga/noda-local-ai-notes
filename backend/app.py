"""
Thin compatibility entrypoint for the backend application.

This module delegates runtime behavior to app_runtime.py so app.py stays a compact
composition layer while preserving legacy import paths (`import app`).
"""

# Who: Tim Buglaev
# When: 2026-03-26
# What: Converted app.py into a thin compatibility facade that delegates to app_runtime.py,
#       preserving runtime behavior and import compatibility while enforcing a small entrypoint file.

import importlib
import runpy
import sys

_RUNTIME_MODULE_CANDIDATES = (
    "backend.app_runtime",
    "app_runtime",
)


def _is_missing_module_error(exc, candidate):
    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Unwrap runpy ImportError causes so direct script execution can fall back from
    #       backend.app_runtime to app_runtime when the package root is not on sys.path.
    if isinstance(exc, ImportError) and isinstance(getattr(exc, "__cause__", None), ModuleNotFoundError):
        exc = exc.__cause__
    if not isinstance(exc, ModuleNotFoundError):
        return False
    missing_name = getattr(exc, "name", None)
    if candidate == "backend.app_runtime":
        return missing_name in ("backend", "backend.app_runtime")
    return missing_name == "app_runtime"


def _import_runtime_module():
    last_error = None
    for candidate in _RUNTIME_MODULE_CANDIDATES:
        try:
            return importlib.import_module(candidate)
        except Exception as exc:
            if _is_missing_module_error(exc, candidate):
                last_error = exc
                continue
            raise
    raise RuntimeError("Unable to import runtime backend module") from last_error


def _run_runtime_module_as_main():
    last_error = None
    for candidate in _RUNTIME_MODULE_CANDIDATES:
        try:
            # Who: Tim Buglaev
            # When: 2026-06-13
            # What: Run the runtime module with alter_sys=True so sys.modules["__main__"]
            #       points at app_runtime while Flask routes are registered and served.
            runpy.run_module(candidate, run_name="__main__", alter_sys=True)
            return
        except Exception as exc:
            if _is_missing_module_error(exc, candidate):
                last_error = exc
                continue
            raise
    raise RuntimeError("Unable to run runtime backend module") from last_error


if __name__ == "__main__":
    _run_runtime_module_as_main()
else:
    _runtime_module = _import_runtime_module()
    sys.modules[__name__] = _runtime_module
