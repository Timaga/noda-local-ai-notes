"""Verify that a packaged Qdrant endpoint belongs to the launched child."""

import os
from pathlib import Path
from urllib.parse import urlsplit

import psutil


def executable():
    value = os.environ.get("NODA_MANAGED_QDRANT_EXE")
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute() or path.name.casefold() != "qdrant.exe" or not path.is_file():
        raise ValueError("Managed Qdrant executable is unavailable")
    return str(path)


def owns_endpoint(process, url):
    parsed = urlsplit(url)
    if (
        process is None or process.poll() is not None
        or parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
        or not parsed.port or parsed.username or parsed.password
        or parsed.path not in ("", "/") or parsed.query or parsed.fragment
    ):
        return False
    try:
        return any(
            connection.status == psutil.CONN_LISTEN
            and connection.laddr
            and (connection.laddr.ip, connection.laddr.port) == ("127.0.0.1", parsed.port)
            for connection in psutil.Process(process.pid).net_connections(kind="tcp")
        )
    except psutil.Error:
        return False
