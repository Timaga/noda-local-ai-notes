"""Owned native lifecycle behavior, with only external OS/network boundaries fake."""

import json
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.error import URLError

import pytest

from backend.ru_pipeline import native_server as server


class FakeProcess:
    pid = 4242

    def __init__(self):
        self.returncode = None
        self.calls, self.waits = [], []
        self.terminate_exits = True

    def poll(self):
        return self.returncode

    def wait(self, timeout):
        self.calls.append(("wait", timeout))
        value = self.waits.pop(0) if self.waits else 0
        if value == "timeout":
            raise subprocess.TimeoutExpired("synthetic-native", timeout)
        self.returncode = value
        return value

    def terminate(self):
        self.calls.append(("terminate",))
        if self.terminate_exits:
            self.returncode = -15

    def kill(self):
        self.calls.append(("kill",))
        self.returncode = -9


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    item = SimpleNamespace(
        key="qwen35_4b",
        model=tmp_path / "selected.gguf",
        model_sha256="a" * 64,
        parameters=4659865088,
        alias="ru-notes-selected",
        executable=tmp_path / "llama-server.exe",
        context=8192,
    )
    config = SimpleNamespace(
        repo_root=tmp_path, runtime_dir=tmp_path / "runtime", port=19189
    )
    args = [str(item.executable), "--model", str(item.model), "--port", "19189"]
    identity = {
        "pid": 4242,
        "create_time": 100.5,
        "executable": str(item.executable),
        "command_sha256": server.console.digest(args),
    }
    context = SimpleNamespace(
        config=config,
        item=item,
        args=args,
        process=FakeProcess(),
        identity=identity,
        popens=[],
        helpers=[],
        bind_error=None,
    )

    class Probe:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def bind(self, address):
            assert address == ("127.0.0.1", 19189)
            if context.bind_error:
                raise context.bind_error

    def popen(argv, **kwargs):
        context.popens.append((argv, kwargs))
        return context.process

    def helper(argv, **kwargs):
        context.helpers.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout=b'{"ctrl_c_sent":true}', stderr=b"")

    def get_json(base, endpoint):
        assert base == "http://127.0.0.1:19189"
        return (
            {"status": "ok"}
            if endpoint == "/health"
            else {
                "model_alias": item.alias,
                "model_path": str(item.model),
                "default_generation_settings": {"n_ctx": 8192},
                "total_slots": 1,
            }
        )

    monkeypatch.setattr(server, "profile", lambda config, key: item)
    monkeypatch.setattr(server, "command", lambda config, profile: list(args))
    monkeypatch.setattr(server, "verify_assets", lambda config, profile: profile)
    monkeypatch.setattr(server.console, "identity", lambda pid: dict(context.identity))
    monkeypatch.setattr(server.console, "alive", lambda process: process.poll() is None)
    monkeypatch.setattr(server, "owns_listener", lambda pid, port: True)
    monkeypatch.setattr(server, "get_json", get_json)
    monkeypatch.setattr(server.socket, "socket", Probe)
    monkeypatch.setattr(server.subprocess, "Popen", popen)
    monkeypatch.setattr(server.subprocess, "run", helper)
    monkeypatch.setattr(
        server,
        "time",
        SimpleNamespace(monotonic=time.monotonic, sleep=lambda value: None),
    )
    return context


def test_normal_owned_start_and_close_keeps_private_text_out_of_files(isolated):
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    with owner as url:
        assert url == "http://127.0.0.1:19189"
        options = isolated.popens[0][1]
        assert options["creationflags"] == subprocess.CREATE_NO_WINDOW
        assert options["startupinfo"].wShowWindow == 0
        assert options["stdout"] == options["stderr"] == subprocess.DEVNULL
    assert server.normal(owner.cleanup)
    assert isolated.process.calls == [("wait", 30)]
    assert isolated.helpers[0][0][5:7] == [
        "backend.ru_pipeline.native_console",
        "--signal-console",
    ]
    assert isolated.helpers[0][1]["creationflags"] == subprocess.CREATE_NO_WINDOW
    assert {p.name for p in owner.run_dir.iterdir()} == {
        "launch.json",
        "claim.json",
        "ready.json",
        "cleanup.json",
    }


def test_port_conflict_never_starts_or_kills_another_process(isolated):
    isolated.bind_error = OSError("Synthetic occupied port")
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    with pytest.raises(OSError):
        owner.__enter__()
    assert not isolated.popens and not isolated.process.calls
    assert owner.run_dir is None


def test_asset_drift_prevents_launch(isolated, monkeypatch):
    def refuse(*args):
        raise ValueError("Synthetic changed bytes")

    monkeypatch.setattr(server, "verify_assets", refuse)
    with pytest.raises(ValueError):
        server.OwnedServer("qwen35_4b", isolated.config).__enter__()
    assert not isolated.popens


@pytest.mark.parametrize("mismatch", ["alias", "path", "context", "slots", "listener"])
def test_readiness_identity_mismatch_retires_only_owned_child(
    isolated, monkeypatch, mismatch
):
    original = server.get_json

    def changed(base, endpoint):
        value = original(base, endpoint)
        if endpoint == "/props":
            if mismatch == "alias":
                value["model_alias"] = "wrong"
            if mismatch == "path":
                value["model_path"] = str(
                    Path(isolated.config.repo_root) / "other.gguf"
                )
            if mismatch == "context":
                value["default_generation_settings"]["n_ctx"] = 2048
            if mismatch == "slots":
                value["total_slots"] = 2
        return value

    monkeypatch.setattr(server, "get_json", changed)
    monkeypatch.setattr(
        server, "owns_listener", lambda pid, port: mismatch != "listener"
    )
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    with pytest.raises(ValueError):
        owner.__enter__()
    assert server.normal(owner.cleanup)
    assert ("terminate",) not in isolated.process.calls


def test_transient_health_retries_without_second_process(isolated, monkeypatch):
    original = server.get_json
    count = 0

    def response(base, endpoint):
        nonlocal count
        count += 1
        if count == 1:
            raise URLError("Synthetic not yet ready")
        return original(base, endpoint)

    monkeypatch.setattr(server, "get_json", response)
    with server.OwnedServer("qwen35_4b", isolated.config):
        pass
    assert len(isolated.popens) == 1


def test_timeout_retires_child(isolated, monkeypatch):
    ambient_monotonic = time.monotonic
    values = iter((0, 1000))
    monkeypatch.setattr(server.time, "monotonic", lambda: next(values))
    # Unrelated callers must not consume the server's fake clock.
    time.monotonic()
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    with pytest.raises(TimeoutError):
        owner.__enter__()
    assert time.monotonic is ambient_monotonic
    assert server.normal(owner.cleanup)


def test_helper_refusal_forces_only_popen_owned_handle_and_is_not_success(
    isolated, monkeypatch
):
    monkeypatch.setattr(
        server.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(
            returncode=2, stdout=b'{"ctrl_c_sent":false}', stderr=b""
        ),
    )
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    owner.__enter__()
    with pytest.raises(RuntimeError, match="did not close normally"):
        owner.__exit__(None, None, None)
    assert owner.cleanup["forced"] is True
    assert ("terminate",) in isolated.process.calls
    assert not server.normal(owner.cleanup)


def test_control_identity_change_refuses_helper_and_still_uses_owned_handle(isolated):
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    owner.__enter__()
    isolated.identity = {**isolated.identity, "create_time": 200}
    owner.close()
    assert not isolated.helpers
    assert owner.cleanup["forced"] is True


@pytest.mark.parametrize("code", [0, 2])
def test_unexpected_early_exit_is_not_normal_shutdown(isolated, code):
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    owner.__enter__()
    isolated.process.returncode = code
    with pytest.raises(RuntimeError):
        owner.__exit__(None, None, None)
    assert not owner.cleanup["ctrl_c_sent"]


def test_terminate_timeout_uses_only_original_handle_kill(isolated, monkeypatch):
    monkeypatch.setattr(
        server.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(TimeoutError("Synthetic helper timeout")),
    )
    isolated.process.terminate_exits = False
    isolated.process.waits = ["timeout", -9]
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    owner.__enter__()
    owner.close()
    assert isolated.process.calls == [
        ("terminate",),
        ("wait", 5),
        ("kill",),
        ("wait", 5),
    ]
    assert owner.cleanup["owned_process_retired"] and not server.normal(owner.cleanup)


def test_close_is_idempotent(isolated):
    owner = server.OwnedServer("qwen35_4b", isolated.config)
    owner.__enter__()
    first = owner.close()
    assert owner.close() is first
    assert len(isolated.helpers) == 1


@pytest.mark.parametrize("value", [float("nan"), 0, True, 181])
def test_invalid_start_timeout_refused_before_launch(isolated, value):
    isolated.config.native_startup_timeout = value
    with pytest.raises(ValueError):
        server.OwnedServer("qwen35_4b", isolated.config)
    assert not isolated.popens
