"""Isolated Windows console signalling for one cryptographically claimed child."""

import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace

from backend.ru_pipeline.config import ROOT, portable_runtime_root
from backend.ru_pipeline.native_assets import command, guarded, profile


def digest(value):
    raw = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


def identity(pid):
    import psutil

    if type(pid) is not int or pid <= 0:
        raise ValueError("Positive owned PID required")
    process = psutil.Process(pid)
    return {
        "pid": pid,
        "create_time": process.create_time(),
        "executable": str(Path(process.exe()).resolve()),
        "command_sha256": digest(process.cmdline()),
    }


def owned_parent(owner_pid, expected):
    """Windows venv launchers may add a redirector between caller and helper."""
    import psutil

    if identity(owner_pid) != expected:
        return False
    current = psutil.Process(os.getpid())
    for _ in range(8):
        current = current.parent()
        if current is None:
            return False
        if current.pid == owner_pid:
            return identity(owner_pid) == expected
    return False


def kernel():
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "FreeConsole": [],
        "AttachConsole": [wintypes.DWORD],
        "SetConsoleCtrlHandler": [ctypes.c_void_p, wintypes.BOOL],
        "GenerateConsoleCtrlEvent": [wintypes.DWORD, wintypes.DWORD],
        "GetExitCodeProcess": [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)],
        "CloseHandle": [wintypes.HANDLE],
    }
    for name, args in signatures.items():
        getattr(dll, name).argtypes, getattr(dll, name).restype = args, wintypes.BOOL
    dll.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    dll.OpenProcess.restype = wintypes.HANDLE
    dll.GetProcessId.argtypes, dll.GetProcessId.restype = [
        wintypes.HANDLE
    ], wintypes.DWORD
    return dll


def call(function, *args):
    if not function(*args):
        error = OSError(ctypes.get_last_error(), "Owned console API failed")
        error.console_phase = getattr(function, "__name__", "console_api")
        raise error


def handle_active(api, handle):
    code = wintypes.DWORD()
    call(api.GetExitCodeProcess, handle, ctypes.byref(code))
    return code.value == 259


def alive(process):
    api = kernel()
    return (
        process.poll() is None
        and api.GetProcessId(process._handle) == process.pid
        and handle_active(api, process._handle)
    )


def read_claim(path, expected_sha):
    path = Path(path).absolute()
    if path.name != "claim.json" or not re.fullmatch(
        r"run-[0-9a-f]{32}", path.parent.name
    ):
        raise ValueError("Owned claim location required")
    path = guarded(path, path.parent.parent)
    with path.open("rb") as handle:
        raw = handle.read(65537)
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError("Owned claim hash or bound mismatch")
    claim = json.loads(raw)
    if claim["nonce"] != path.parent.name[4:] or not owned_parent(
        claim["owner_pid"], claim["owner_identity"]
    ):
        raise ValueError("Owned helper parent lifetime mismatch")
    repo_root = Path(claim["repo_root"])
    portable = portable_runtime_root()
    if portable is not None and portable.resolve() != repo_root:
        raise ValueError("Owned CPU runtime root changed")
    config = SimpleNamespace(
        repo_root=repo_root, source_root=ROOT if portable is not None else repo_root,
        port=claim["port"], runtime_dir=path.parent.parent,
    )
    item = profile(config, claim["profile"])
    args = command(config, item)
    owned = claim["identity"]
    if (
        type(owned["pid"]) is not int
        or owned["pid"] <= 0
        or type(owned["create_time"]) not in (int, float)
        or not math.isfinite(owned["create_time"])
        or owned["create_time"] <= 0
        or claim["model_sha256"] != item.model_sha256
        or claim["parameters"] != item.parameters
        or claim["argv_sha256"] != digest(args)
        or owned["command_sha256"] != digest(args)
        or owned["executable"] != str(item.executable)
        or identity(owned["pid"]) != owned
    ):
        raise ValueError("Owned server lifetime mismatch")
    return claim


def signal_console(path, expected_sha):
    """CTRL_C_EVENT broadcasts only within the child's separate hidden console."""
    claim = read_claim(path, expected_sha)
    owned = claim["identity"]
    api = kernel()
    handle = api.OpenProcess(0x1000 | 0x100000, False, owned["pid"])
    if not handle:
        raise OSError(ctypes.get_last_error(), "Owned process handle unavailable")
    attached = False
    try:
        if (
            api.GetProcessId(handle) != owned["pid"]
            or not handle_active(api, handle)
            or identity(owned["pid"]) != owned
        ):
            raise ValueError("Owned server no longer active")
        call(api.FreeConsole)
        call(api.AttachConsole, owned["pid"])
        attached = True
        call(api.SetConsoleCtrlHandler, None, True)
        if not handle_active(api, handle):
            raise ValueError("Owned server exited during console attach")
        call(api.GenerateConsoleCtrlEvent, 0, 0)
    finally:
        try:
            if attached:
                call(api.FreeConsole)
                call(api.SetConsoleCtrlHandler, None, True)
        finally:
            call(api.CloseHandle, handle)
    return {"ctrl_c_sent": True, "scope": "isolated_owned_server_console"}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if len(argv) != 3 or argv[0] != "--signal-console" or os.name != "nt":
            raise ValueError("Only the Windows owned console helper is allowed")
        result = signal_console(Path(argv[1]), argv[2])
        print(json.dumps(result))
        return 0
    except Exception as exc:
        print(json.dumps({"ctrl_c_sent": False, "error_type": type(exc).__name__}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
