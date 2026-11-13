"""Browser-origin isolation for local note data and inference endpoints.

This is not authentication: local processes can forge these headers, and other
loopback web applications remain trusted. Never use it to expose the API remotely.
"""

import ipaddress
import re
from urllib.parse import urlparse

from flask import jsonify, request


_PROTECTED_ENDPOINTS = frozenset(
    {
        "get_notes",
        "get_tags",
        "get_note",
        "get_note_asset",
        "generate_note",
        "enqueue_note_generation",
        "generate_job_status",
        "list_generation_jobs",
        "generate_queue_status",
        "cleanup_generation_history",
        "retry_note_generation",
        "rag_query",
    }
)
_FETCH_SITES = frozenset({"", "none", "same-origin", "same-site", "cross-site"})


def _loopback_host(host):
    if not host:
        return False
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _local_url(value, allow_file=True):
    try:
        parsed = urlparse(value)
        if parsed.username is not None or parsed.password is not None:
            return False
        if allow_file and parsed.scheme == "file":
            return parsed.netloc in ("", "localhost")
        # Accessing port also validates malformed authority/port syntax.
        return (
            parsed.scheme in ("http", "https")
            and (parsed.port is None or 0 < parsed.port <= 65535)
            and _loopback_host(parsed.hostname)
        )
    except (ValueError, TypeError):
        return False


def local_browser_request_allowed():
    if not _loopback_host(request.remote_addr) or not _local_url(
        "http://" + request.host, allow_file=False
    ):
        return False
    fetch_site = (request.headers.get("Sec-Fetch-Site") or "").strip().casefold()
    if fetch_site not in _FETCH_SITES:
        return False
    origin = (request.headers.get("Origin") or "").strip()
    referer = (request.headers.get("Referer") or "").strip()
    if referer and not _local_url(referer):
        return False
    electron = bool(
        re.search(
            r"(?:^|\s)Electron/[0-9]",
            request.headers.get("User-Agent", ""),
            re.IGNORECASE,
        )
    )
    if "Origin" in request.headers:
        if origin == "null":
            return electron
        if origin.startswith("file:"):
            return electron and _local_url(origin)
        return bool(origin) and _local_url(origin, allow_file=False)
    if fetch_site == "cross-site":
        # Electron file:// fetch may omit both Origin and Referer. A browser
        # document with an opaque Origin:null never reaches this exception.
        return electron or bool(referer)
    return True


def register_local_request_guard(app):
    if app.extensions.get("noda_local_request_guard"):
        return

    @app.before_request
    def guard_note_and_inference_requests():
        if request.endpoint not in _PROTECTED_ENDPOINTS:
            return None
        if local_browser_request_allowed():
            return None
        if request.endpoint == "rag_query" and not _loopback_host(request.remote_addr):
            return (
                jsonify(
                    {"error": "Local access only", "code": "local_access_required"}
                ),
                403,
            )
        return jsonify({"error": "Forbidden origin"}), 403

    app.extensions["noda_local_request_guard"] = True
