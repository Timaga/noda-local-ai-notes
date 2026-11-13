"""Ownership and console boundaries without native APIs, servers or model assets."""

import hashlib
import json
import sys
from copy import deepcopy
from types import SimpleNamespace

import pytest

from backend.ru_pipeline import native_console as console


@pytest.fixture
def claim_case(tmp_path, monkeypatch):
    nonce = "a" * 32
    folder = tmp_path / ("run-" + nonce)
    folder.mkdir()
    item = SimpleNamespace(
        executable=tmp_path / "llama-server.exe",
        model_sha256="b" * 64,
        parameters=4_659_865_088,
    )
    argv = [str(item.executable), "--model", str(tmp_path / "selected.gguf")]
    owner = {
        "pid": 999,
        "create_time": 100.25,
        "executable": str(tmp_path / "python.exe"),
        "command_sha256": console.digest(["python", "app.py"]),
    }
    owned = {
        "pid": 4242,
        "create_time": 110.5,
        "executable": str(item.executable),
        "command_sha256": console.digest(argv),
    }
    claim = {
        "nonce": nonce,
        "owner_pid": owner["pid"],
        "owner_identity": owner,
        "repo_root": str(tmp_path),
        "port": 19189,
        "profile": "qwen35_4b",
        "identity": owned,
        "model_sha256": item.model_sha256,
        "parameters": item.parameters,
        "argv_sha256": console.digest(argv),
    }
    state = SimpleNamespace(
        path=folder / "claim.json",
        claim=claim,
        owner=owner,
        owned=owned,
        current_owner=deepcopy(owner),
        current_owned=deepcopy(owned),
        profile_calls=[],
        command_calls=[],
        identity_calls=[],
    )

    def identity(pid):
        state.identity_calls.append(pid)
        if pid == owner["pid"]:
            return deepcopy(state.current_owner)
        if pid == owned["pid"]:
            return deepcopy(state.current_owned)
        return {**state.current_owner, "pid": pid}

    def profile(config, key):
        state.profile_calls.append((config.repo_root, config.port, key))
        return item

    def command(config, value):
        assert value is item
        state.command_calls.append(config.port)
        return list(argv)

    def publish(value=None, raw=None):
        data = json.dumps(value or state.claim).encode("utf-8") if raw is None else raw
        state.path.write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    state.publish = publish
    helper = SimpleNamespace(parent=lambda: SimpleNamespace(pid=owner["pid"]))
    monkeypatch.setitem(
        sys.modules, "psutil", SimpleNamespace(Process=lambda pid: helper)
    )
    monkeypatch.setattr(console.os, "getppid", lambda: owner["pid"])
    monkeypatch.setattr(console, "identity", identity)
    monkeypatch.setattr(console, "profile", profile)
    monkeypatch.setattr(console, "command", command)
    monkeypatch.setattr(console, "kernel", lambda: pytest.fail("Unexpected native API"))
    return state


def test_complete_claim_binds_parent_child_profile_and_command(claim_case):
    expected = deepcopy(claim_case.claim)
    assert console.read_claim(claim_case.path, claim_case.publish()) == expected
    assert claim_case.identity_calls == [999, 999, 4242]
    assert claim_case.profile_calls == [
        (claim_case.path.parent.parent, 19189, "qwen35_4b")
    ]
    assert claim_case.command_calls == [19189]


@pytest.mark.parametrize("field", ["nonce", "owner_pid", "owner_identity"])
def test_wrong_helper_parent_or_nonce_is_rejected_before_profile(claim_case, field):
    claim = deepcopy(claim_case.claim)
    claim[field] = (
        {**claim[field], "create_time": 900} if field == "owner_identity" else "wrong"
    )
    with pytest.raises(ValueError, match="parent lifetime"):
        console.read_claim(claim_case.path, claim_case.publish(claim))
    assert claim_case.profile_calls == []


def test_reused_parent_pid_does_not_authorize_claim(claim_case):
    claim_case.current_owner["create_time"] = 900
    with pytest.raises(ValueError, match="parent lifetime"):
        console.read_claim(claim_case.path, claim_case.publish())
    assert claim_case.profile_calls == []


@pytest.mark.parametrize("field", ["create_time", "executable", "command_sha256"])
def test_reused_or_different_child_lifetime_is_rejected(claim_case, field):
    claim_case.current_owned[field] = 900 if field == "create_time" else "wrong"
    with pytest.raises(ValueError, match="server lifetime"):
        console.read_claim(claim_case.path, claim_case.publish())


@pytest.mark.parametrize(
    "field,value",
    [
        ("pid", True),
        ("pid", 0),
        ("create_time", True),
        ("create_time", 0),
        ("create_time", float("nan")),
        ("command_sha256", "wrong"),
        ("executable", "different.exe"),
    ],
)
def test_malformed_child_identity_is_rejected(claim_case, field, value):
    claim = deepcopy(claim_case.claim)
    claim["identity"][field] = value
    with pytest.raises(ValueError, match="server lifetime"):
        console.read_claim(claim_case.path, claim_case.publish(claim))


@pytest.mark.parametrize("field", ["model_sha256", "parameters", "argv_sha256"])
def test_changed_profile_evidence_is_rejected(claim_case, field):
    claim = deepcopy(claim_case.claim)
    claim[field] = "wrong"
    with pytest.raises(ValueError, match="server lifetime"):
        console.read_claim(claim_case.path, claim_case.publish(claim))


def test_claim_hash_mismatch_rejects_before_identity(claim_case):
    claim_case.publish()
    with pytest.raises(ValueError, match="hash or bound"):
        console.read_claim(claim_case.path, "0" * 64)
    assert claim_case.identity_calls == []


def test_oversized_claim_rejects_before_json_or_identity(claim_case):
    digest = claim_case.publish(raw=b" " * 65537)
    with pytest.raises(ValueError, match="hash or bound"):
        console.read_claim(claim_case.path, digest)
    assert claim_case.identity_calls == []


@pytest.mark.parametrize("name", ["other.json", "../claim.json"])
def test_claim_location_is_constrained(claim_case, name):
    with pytest.raises(ValueError):
        console.read_claim(claim_case.path.parent / name, "0" * 64)
    assert claim_case.identity_calls == []


@pytest.fixture
def signal_case(monkeypatch):
    owned = {"pid": 4242, "create_time": 110.5, "command_sha256": "b" * 64}
    state = SimpleNamespace(
        trace=[],
        states=[True, True],
        owned=owned,
        current=deepcopy(owned),
        handle=123,
        handle_pid=4242,
        fail=set(),
    )

    class API:
        def __getattr__(self, name):
            def invoke(*args):
                state.trace.append((name, *args))
                if name in state.fail:
                    return False
                if name == "OpenProcess":
                    return state.handle
                if name == "GetProcessId":
                    return state.handle_pid
                return True

            invoke.__name__ = name
            return invoke

    def active(api, handle):
        assert handle == state.handle
        state.trace.append(("active", handle))
        return state.states.pop(0)

    monkeypatch.setattr(console, "read_claim", lambda path, digest: {"identity": owned})
    monkeypatch.setattr(console, "identity", lambda pid: deepcopy(state.current))
    monkeypatch.setattr(console, "kernel", API)
    monkeypatch.setattr(console, "handle_active", active)
    monkeypatch.setattr(console.ctypes, "get_last_error", lambda: 5)
    return state


def test_ctrl_c_targets_only_isolated_owned_console(signal_case):
    assert console.signal_console("unused", "unused")["ctrl_c_sent"] is True
    assert signal_case.trace == [
        ("OpenProcess", 0x101000, False, 4242),
        ("GetProcessId", 123),
        ("active", 123),
        ("FreeConsole",),
        ("AttachConsole", 4242),
        ("SetConsoleCtrlHandler", None, True),
        ("active", 123),
        ("GenerateConsoleCtrlEvent", 0, 0),
        ("FreeConsole",),
        ("SetConsoleCtrlHandler", None, True),
        ("CloseHandle", 123),
    ]


@pytest.mark.parametrize("states,attached", [([False], False), ([True, False], True)])
def test_retired_handle_never_gets_event(signal_case, states, attached):
    signal_case.states = list(states)
    with pytest.raises(ValueError):
        console.signal_console("unused", "unused")
    names = [call[0] for call in signal_case.trace]
    assert ("AttachConsole" in names) is attached
    assert "GenerateConsoleCtrlEvent" not in names
    assert signal_case.trace[-1] == ("CloseHandle", 123)


def test_wrong_held_handle_pid_refuses_console_attach(signal_case):
    signal_case.handle_pid = 5000
    with pytest.raises(ValueError, match="no longer active"):
        console.signal_console("unused", "unused")
    assert [row[0] for row in signal_case.trace] == [
        "OpenProcess",
        "GetProcessId",
        "CloseHandle",
    ]


def test_second_identity_check_refuses_reused_pid(signal_case):
    signal_case.current["create_time"] = 900
    with pytest.raises(ValueError, match="no longer active"):
        console.signal_console("unused", "unused")
    assert "AttachConsole" not in [row[0] for row in signal_case.trace]
    assert signal_case.trace[-1] == ("CloseHandle", 123)


def test_unavailable_handle_does_not_change_console(signal_case):
    signal_case.handle = 0
    with pytest.raises(OSError, match="handle unavailable"):
        console.signal_console("unused", "unused")
    assert signal_case.trace == [("OpenProcess", 0x101000, False, 4242)]


@pytest.mark.parametrize(
    "phase",
    [
        "FreeConsole",
        "AttachConsole",
        "SetConsoleCtrlHandler",
        "GenerateConsoleCtrlEvent",
    ],
)
def test_console_api_failure_closes_held_handle(signal_case, phase):
    signal_case.fail = {phase}
    with pytest.raises(OSError):
        console.signal_console("unused", "unused")
    assert signal_case.trace[-1] == ("CloseHandle", 123)
    if phase != "GenerateConsoleCtrlEvent":
        assert "GenerateConsoleCtrlEvent" not in [row[0] for row in signal_case.trace]


def test_helper_returns_only_safe_error_metadata(monkeypatch, capsys):
    def fail(*args):
        raise RuntimeError("PRIVATE_SYNTHETIC_SOURCE_MUST_NOT_BE_PRINTED")

    monkeypatch.setattr(console, "signal_console", fail)
    monkeypatch.setattr(console, "os", SimpleNamespace(name="nt"))
    assert console.main(["--signal-console", "claim.json", "a" * 64]) == 2
    output = capsys.readouterr().out
    assert "PRIVATE_SYNTHETIC" not in output
    assert json.loads(output) == {"ctrl_c_sent": False, "error_type": "RuntimeError"}


@pytest.mark.parametrize(
    "arguments", [[], ["--other", "claim", "sha"], ["--signal-console", "claim"]]
)
def test_helper_rejects_other_commands_without_control(monkeypatch, capsys, arguments):
    monkeypatch.setattr(
        console, "signal_console", lambda *args: pytest.fail("No control expected")
    )
    assert console.main(arguments) == 2
    assert json.loads(capsys.readouterr().out)["ctrl_c_sent"] is False


@pytest.mark.parametrize(
    "distance,expected", [(1, True), (2, True), (8, True), (9, False)]
)
def test_helper_parent_accepts_only_bounded_owned_ancestry(
    monkeypatch, distance, expected
):
    owner = {"pid": 999, "create_time": 100.25}
    trace = []

    class Node:
        def __init__(self, depth):
            self.depth = depth
            self.pid = 999 if depth == distance else 700 + depth

        def parent(self):
            trace.append(self.depth)
            return Node(self.depth + 1)

    monkeypatch.setitem(
        sys.modules, "psutil", SimpleNamespace(Process=lambda pid: Node(0))
    )
    identities = []
    monkeypatch.setattr(
        console, "identity", lambda pid: identities.append(pid) or dict(owner)
    )
    assert console.owned_parent(999, owner) is expected
    assert len(trace) == min(distance, 8)
    assert identities == ([999, 999] if expected else [999])


def test_helper_ancestry_end_refuses_signal_authority(monkeypatch):
    expected = {"pid": 999, "create_time": 100.25}
    monkeypatch.setitem(
        sys.modules,
        "psutil",
        SimpleNamespace(Process=lambda pid: SimpleNamespace(parent=lambda: None)),
    )
    monkeypatch.setattr(console, "identity", lambda pid: dict(expected))
    assert console.owned_parent(999, expected) is False


def test_parent_pid_reuse_during_ancestry_walk_is_rejected(monkeypatch):
    expected = {"pid": 999, "create_time": 100.25}
    identities = iter([expected, {**expected, "create_time": 900}])
    monkeypatch.setitem(
        sys.modules,
        "psutil",
        SimpleNamespace(
            Process=lambda pid: SimpleNamespace(parent=lambda: SimpleNamespace(pid=999))
        ),
    )
    monkeypatch.setattr(console, "identity", lambda pid: next(identities))
    assert console.owned_parent(999, expected) is False


def test_wrong_initial_parent_identity_never_walks_process_tree(monkeypatch):
    expected = {"pid": 999, "create_time": 100.25}
    monkeypatch.setitem(
        sys.modules,
        "psutil",
        SimpleNamespace(Process=lambda pid: pytest.fail("No tree access expected")),
    )
    monkeypatch.setattr(
        console, "identity", lambda pid: {**expected, "create_time": 900}
    )
    assert console.owned_parent(999, expected) is False


def test_successful_helper_prints_only_control_receipt(monkeypatch, capsys):
    calls = []
    response = {"ctrl_c_sent": True, "scope": "isolated_owned_server_console"}
    monkeypatch.setattr(console, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        console,
        "signal_console",
        lambda path, sha: calls.append((path.name, sha)) or response,
    )
    assert console.main(["--signal-console", "claim.json", "a" * 64]) == 0
    assert calls == [("claim.json", "a" * 64)]
    assert json.loads(capsys.readouterr().out) == response
