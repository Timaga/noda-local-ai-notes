"""Keep owned model consoles able to receive their graceful shutdown event."""

import ctypes
from ctypes import wintypes
import os


def prepare_owned_console_children():
    """Clear Windows' inheritable ignore flag before backend workers are started.

    Electron's detached Windows launch disables CTRL+C in its child process group.
    The flag survives creation of a separate console, so llama-server would ignore the
    owned console helper's event. This leaves the backend's detached console/group
    isolation in place and does not replace any registered signal handler.
    """
    if os.name != "nt":
        return False
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    handler = api.SetConsoleCtrlHandler
    handler.argtypes = [ctypes.c_void_p, wintypes.BOOL]
    handler.restype = wintypes.BOOL
    if not handler(None, False):
        raise OSError(
            ctypes.get_last_error(),
            "Cannot enable graceful shutdown for owned local model consoles",
        )
    return True
