"""Bounded ownership and retirement of one hidden Windows llama-server."""

import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener
import uuid

from backend.ru_pipeline import native_console as console
from backend.ru_pipeline.native_assets import (
    HOST,
    command,
    guarded,
    profile,
    sha_file,
    verify_assets,
)


def publish(path, value, runtime_root):
    with guarded(path, runtime_root).open("xb") as stream:
        stream.write(
            json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2).encode(
                "ascii"
            )
            + b"\n"
        )
        stream.flush()
        os.fsync(stream.fileno())


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Native metadata redirect refused")


def get_json(base_url, endpoint):
    parsed = urlsplit(base_url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != HOST
        or parsed.port is None
        or not 1024 <= parsed.port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Explicit owned numeric loopback URL required")
    if endpoint not in ("/health", "/props"):
        raise ValueError("Only owned metadata endpoints are allowed")
    with build_opener(ProxyHandler({}), NoRedirect()).open(
        base_url + endpoint, timeout=2
    ) as response:
        raw = response.read(262145)
    if len(raw) > 262144:
        raise ValueError("Native metadata exceeds its bound")
    return json.loads(raw)


def owns_listener(pid, port):
    import psutil

    return any(
        item.status == psutil.CONN_LISTEN
        and item.laddr
        and item.laddr.ip == HOST
        and item.laddr.port == port
        for item in psutil.Process(pid).net_connections(kind="tcp")
    )


def normal(cleanup):
    return (
        type(cleanup) is dict
        and type(cleanup.get("exit_code")) is int
        and cleanup.get("exit_code") == 0
        and cleanup.get("ctrl_c_sent") is True
        and cleanup.get("forced") is False
        and cleanup.get("errors") == []
        and cleanup.get("owned_process_retired") is True
    )


class OwnedServer:
    def __init__(self, model_key, config):
        self.config = config
        self.profile = profile(config, model_key)
        self.port = getattr(config, "port", 19189)
        self.args = command(config, self.profile)
        self.runtime_root = guarded(config.runtime_dir, config.runtime_dir)
        self.startup_timeout = getattr(config, "native_startup_timeout", 180)
        self.stop_timeout = getattr(config, "native_stop_timeout", 30)
        for value, lower, upper in (
            (self.startup_timeout, 1, 180),
            (self.stop_timeout, 6, 30),
        ):
            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or not lower <= value <= upper
            ):
                raise ValueError("Invalid bounded native timeout")
        self.base_url = f"http://{HOST}:{self.port}"
        self.process = self.run_dir = self.claim = self.cleanup = None

    def assert_active(self):
        if (
            self.process is None
            or self.claim is None
            or not console.alive(self.process)
            or console.identity(self.process.pid) != self.claim["identity"]
            or not owns_listener(self.process.pid, self.port)
        ):
            raise RuntimeError("Owned native lifetime/listener changed")

    def __enter__(self):
        if os.name != "nt" or self.run_dir is not None:
            raise RuntimeError("One Windows native context is required")
        verify_assets(self.config, self.profile)
        with socket.socket() as probe:
            probe.bind((HOST, self.port))
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        nonce = uuid.uuid4().hex
        self.run_dir = guarded(self.runtime_root / ("run-" + nonce), self.runtime_root)
        self.run_dir.mkdir(exist_ok=False)
        publish(
            self.run_dir / "launch.json",
            {
                "profile": self.profile.key,
                "argv_sha256": console.digest(self.args),
                "model_sha256": self.profile.model_sha256,
                "parameters": self.profile.parameters,
                "host": HOST,
                "port": self.port,
                "context": self.profile.context,
                "parallel": 1,
                "console": "CREATE_NO_WINDOW",
                "private_prompt_logging": False,
            },
            self.runtime_root,
        )
        try:
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            child_env = os.environ.copy()
            child_env["LLAMA_SERVER_SLOTS_DEBUG"] = "0"
            self.process = subprocess.Popen(
                self.args,
                cwd=self.profile.executable.parent,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                # The shutdown helper can still attach to the windowless console.
                creationflags=subprocess.CREATE_NO_WINDOW,
                startupinfo=startup,
                env=child_env,
            )
            self.claim = {
                "nonce": nonce,
                "identity": console.identity(self.process.pid),
                "owner_pid": os.getpid(),
                "owner_identity": console.identity(os.getpid()),
                "repo_root": str(Path(self.config.repo_root).resolve()),
                "port": self.port,
                "argv_sha256": console.digest(self.args),
                "profile": self.profile.key,
                "model_sha256": self.profile.model_sha256,
                "parameters": self.profile.parameters,
            }
            if (
                self.claim["identity"]["executable"] != str(self.profile.executable)
                or self.claim["identity"]["command_sha256"] != console.digest(self.args)
                or not console.alive(self.process)
            ):
                raise RuntimeError("Native startup identity mismatch")
            publish(self.run_dir / "claim.json", self.claim, self.runtime_root)
            deadline = time.monotonic() + self.startup_timeout
            while time.monotonic() < deadline:
                if not console.alive(self.process):
                    raise RuntimeError("Native process exited before readiness")
                try:
                    health = get_json(self.base_url, "/health")
                    props = get_json(self.base_url, "/props")
                    if (
                        health.get("status") != "ok"
                        or props.get("model_alias") != self.profile.alias
                        or Path(props.get("model_path", "")).resolve()
                        != self.profile.model
                        or props.get("default_generation_settings", {}).get("n_ctx")
                        != self.profile.context
                        or props.get("total_slots") != 1
                        or not owns_listener(self.process.pid, self.port)
                    ):
                        raise ValueError(
                            "Native props/listener do not match the owned process"
                        )
                    publish(
                        self.run_dir / "ready.json",
                        {
                            "ready": True,
                            "profile": self.profile.key,
                            "context": self.profile.context,
                            "parallel": 1,
                            "owned_listener_checked": True,
                            "gpu_offload_verified": False,
                        },
                        self.runtime_root,
                    )
                    return self.base_url
                except (URLError, TimeoutError, ConnectionError):
                    time.sleep(min(0.2, max(0, deadline - time.monotonic())))
            raise TimeoutError("Native readiness deadline")
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.cleanup is not None or self.run_dir is None:
            return self.cleanup
        errors, sent, forced, interrupted = [], False, False, None
        process = self.process
        try:
            if process is not None and process.poll() is None:
                try:
                    if (
                        self.claim is None
                        or self.claim["identity"]["pid"] != process.pid
                        or not console.alive(process)
                        or console.identity(process.pid) != self.claim["identity"]
                    ):
                        raise ValueError("Owned native control identity mismatch")
                    path = self.run_dir / "claim.json"
                    python = str(
                        getattr(self.config, "native_python", None) or sys.executable
                    )
                    helper = subprocess.run(
                        [
                            python,
                            "-X",
                            "utf8",
                            "-B",
                            "-m",
                            "backend.ru_pipeline.native_console",
                            "--signal-console",
                            str(path),
                            sha_file(path),
                        ],
                        cwd=getattr(self.config, "source_root", self.config.repo_root),
                        stdin=subprocess.DEVNULL,
                        capture_output=True,
                        timeout=5,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                        check=False,
                    )
                    if len(helper.stdout) > 8192 or len(helper.stderr) > 8192:
                        raise ValueError("Native control helper output exceeds bound")
                    result = json.loads(helper.stdout)
                    if helper.returncode != 0 or result.get("ctrl_c_sent") is not True:
                        raise RuntimeError("Native console helper refused")
                    sent = True
                    process.wait(timeout=self.stop_timeout)
                except BaseException as exc:
                    errors.append(type(exc).__name__)
                    if not isinstance(exc, Exception):
                        interrupted = exc
                if process.poll() is None:
                    forced = True
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
        finally:
            code = process.poll() if process is not None else None
            self.cleanup = {
                "exit_code": code,
                "ctrl_c_sent": sent,
                "forced": forced,
                "errors": errors,
                "owned_process_retired": process is None or code is not None,
                "native_close": (
                    "CONSISTENT_WITH_PROCESS_RETIREMENT_NO_C_API_INSTRUMENTATION"
                    if sent and not forced and code == 0
                    else "UNKNOWN"
                ),
            }
            publish(self.run_dir / "cleanup.json", self.cleanup, self.runtime_root)
        if not self.cleanup["owned_process_retired"]:
            raise RuntimeError("Native process retirement not confirmed")
        if interrupted is not None:
            raise interrupted
        return self.cleanup

    def __exit__(self, exc_type, exc_value, traceback):
        if not normal(self.close()):
            raise RuntimeError("Native process did not close normally")
        return False
