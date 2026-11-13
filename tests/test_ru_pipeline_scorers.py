"""Source-only subprocess scorer contracts; no neural frameworks or real models."""

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from backend.note_processing_failures import NoteSystemError
from backend.ru_pipeline import scorer_contract as contract
from backend.ru_pipeline import scorers
from backend.ru_pipeline.scorer_worker import evaluate, safe_failure


PAIR = {"source": "\ufeff  Проверить\r\nхвост.  ", "target": "Точная справка\r\n "}


def config(tmp_path):
    python = tmp_path / "python.exe"
    assets = tmp_path / "assets.json"
    python.write_bytes(b"synthetic executable marker")
    assets.write_text("{}", encoding="utf-8")
    return SimpleNamespace(
        project_root=tmp_path,
        mmarco_python=python,
        tev_python=python,
        mmarco_assets=assets,
        tev_assets=assets,
        qwen_assets=assets,
        scorer_timeout=3,
    )


class FakeProcess:
    def __init__(self, command, options, payload, code=0, timeout=False, broken=False):
        self.command, self.options, self.payload = command, options, payload
        self.returncode = None
        self.code, self.timeout, self.broken = code, timeout, broken
        self.killed, self.waits, self.raw = 0, [], None

    def communicate(self, *, input, timeout):
        self.raw = input
        if self.timeout:
            raise subprocess.TimeoutExpired(self.command, timeout)
        if self.broken:
            raise BrokenPipeError("PRIVATE_SOURCE")
        self.options["stdout"].write(self.payload)
        self.returncode = self.code

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed += 1
        self.returncode = -9

    def wait(self, timeout):
        self.waits.append(timeout)
        return self.returncode


def fake_process(monkeypatch, payload, **flags):
    processes = []

    def create(command, **options):
        process = FakeProcess(command, options, payload, **flags)
        processes.append(process)
        return process

    monkeypatch.setattr(scorers.subprocess, "Popen", create)
    return processes


@pytest.mark.parametrize(
    "engine", ["mmarco", "tev", "qwen_title", "qwen_tags", "qwen_links"]
)
def test_exact_sources_are_stdin_data_and_worker_is_offline_owned(
    engine, tmp_path, monkeypatch
):
    processes = fake_process(monkeypatch, b'{"ok":true,"scores":[2.75]}')
    assert scorers.score_pairs(engine, [PAIR], config(tmp_path)) == [2.75]
    process = processes[0]
    assert json.loads(process.raw)["pairs"] == [PAIR]
    assert "Проверить" not in str(process.command)
    assert process.command[4:6] == ["-m", "backend.ru_pipeline.scorer_worker"]
    assert process.options["shell"] is False
    assert process.options["stderr"] == subprocess.DEVNULL
    assert process.options["env"]["HF_HUB_OFFLINE"] == "1"
    assert process.options["env"]["TRANSFORMERS_OFFLINE"] == "1"
    assert process.command[process.command.index("--engine") + 1] == engine
    assert process.killed == 0


def test_empty_input_needs_no_worker_but_engine_is_still_checked(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No process for empty selection")

    monkeypatch.setattr(scorers.subprocess, "Popen", forbidden)
    assert scorers.score_pairs("mmarco", [], SimpleNamespace()) == []
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("wrong", [], SimpleNamespace())
    assert error.value.failure_code == "invalid_reranker_input"


@pytest.mark.parametrize(
    "pairs",
    [
        None,
        {},
        [None],
        [{"source": "", "target": "x"}],
        [{"source": "x", "target": "x", "id": "private"}],
        [{"source": "x\x00", "target": "y"}],
        [{"source": "\ud800", "target": "y"}],
    ],
)
def test_invalid_input_rejected_before_subprocess(pairs):
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("mmarco", pairs, SimpleNamespace())
    assert error.value.failure_code == "invalid_reranker_input"


@pytest.mark.parametrize(
    "raw",
    [
        b'{"pairs":[],"pairs":[]}',
        b'{"pairs":[],"id":"x"}',
        b'{"pairs":NaN}',
        b"bad",
        b"\xff",
    ],
)
def test_worker_request_is_strict_reference_free_json(raw):
    with pytest.raises(contract.ScorerInputError):
        contract.decode_request("mmarco", raw)


def test_request_limits_are_explicit_without_truncation(monkeypatch):
    with pytest.raises(contract.ScorerInputError):
        contract.validate_pairs("tev", [PAIR] * (contract.MAX_PAIRS + 1))
    monkeypatch.setattr(contract, "MAX_BYTES", 20)
    with pytest.raises(contract.ScorerInputError):
        contract.encode_request("tev", [PAIR])
    with pytest.raises(contract.ScorerInputError):
        contract.decode_request("tev", b" " * 21)
    with pytest.raises(contract.ScorerInputError):
        contract.validate_pairs("tev", [{"source": "x" * 21, "target": "y"}])
    assert PAIR["source"].endswith("хвост.  ")


@pytest.mark.parametrize(
    "payload,code",
    [
        (b'{"ok":true,"scores":[]}', 0),
        (b'{"ok":true,"scores":[NaN]}', 0),
        (b'{"ok":true,"scores":[1e309]}', 0),
        (b'{"ok":true,"scores":[true]}', 0),
        (b'{"ok":true,"scores":[2],"extra":3}', 0),
        (b'{"ok":true,"scores":[2]}', 2),
        (b'{"ok":false,"error":{"code":"reranker_failed"}}', 0),
        (b'{"ok":false,"error":{"code":"untrusted_code"}}', 2),
        (b'{"ok":true,"ok":true,"scores":[1]}', 0),
        (b"PRIVATE_SOURCE invalid stdout", 0),
    ],
)
def test_invalid_or_partial_success_never_becomes_empty(
    payload, code, tmp_path, monkeypatch
):
    fake_process(monkeypatch, payload, code=code)
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("mmarco", [PAIR], config(tmp_path))
    assert error.value.failure_code == "reranker_protocol_failed"
    assert "PRIVATE_SOURCE" not in str(error.value)


def test_output_byte_budget_is_enforced(tmp_path, monkeypatch):
    fake_process(monkeypatch, b" " * (contract.MAX_OUTPUT_BYTES + 1))
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("mmarco", [PAIR], config(tmp_path))
    assert error.value.failure_code == "reranker_protocol_failed"


def test_timeout_kills_and_waits_only_on_owned_child(tmp_path, monkeypatch):
    processes = fake_process(monkeypatch, b"", timeout=True)
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("tev", [PAIR], config(tmp_path))
    assert error.value.failure_code == "reranker_timeout"
    assert processes[0].killed == 1 and processes[0].waits == [10]


def test_broken_stdin_is_safe_and_retires_child(tmp_path, monkeypatch):
    processes = fake_process(monkeypatch, b"", broken=True)
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("tev", [PAIR], config(tmp_path))
    assert error.value.failure_code == "reranker_unavailable"
    assert processes[0].killed == 1
    assert "PRIVATE_SOURCE" not in str(error.value)


@pytest.mark.parametrize(
    "failure_code",
    ["context_budget_exceeded", "reranker_assets_invalid", "reranker_failed"],
)
def test_worker_error_retains_safe_system_attribution(
    failure_code, tmp_path, monkeypatch
):
    fake_process(
        monkeypatch,
        json.dumps(
            {"ok": False, "error": {"code": failure_code, "type": "RuntimeError"}}
        ).encode(),
        code=2,
    )
    with pytest.raises(NoteSystemError) as error:
        scorers.score_pairs("mmarco", [PAIR], config(tmp_path))
    assert (
        error.value.failure_kind == "system"
        and error.value.failure_code == failure_code
    )


def test_worker_all_or_error_closes_scorer_without_partial_vector():
    class FakeScorer:
        closed = False

        def score(self, pair):
            raise RuntimeError("PRIVATE_SOURCE")

        def close(self):
            self.closed = True

    scorer = FakeScorer()
    with pytest.raises(RuntimeError) as error:
        evaluate(
            "mmarco",
            contract.encode_request("mmarco", [PAIR]),
            Path("unused"),
            Path("unused"),
            factory=lambda *args: scorer,
        )
    assert scorer.closed
    assert safe_failure(error.value) == {
        "ok": False,
        "error": {"code": "reranker_failed", "type": "RuntimeError"},
    }


def test_worker_no_mapping_or_source_mutation():
    seen = []

    class FakeScorer:
        def score(self, pair):
            seen.append(pair.copy())
            return -4.25

        def close(self):
            seen.append("closed")

    result = evaluate(
        "mmarco",
        contract.encode_request("mmarco", [PAIR]),
        Path("unused"),
        Path("unused"),
        factory=lambda *args: FakeScorer(),
    )
    assert result == {"ok": True, "scores": [-4.25]}
    assert seen == [PAIR, "closed"]
    with pytest.raises(contract.ScorerInputError):
        evaluate("wrong", b'{"pairs":[]}', Path("unused"), Path("unused"))


@pytest.mark.parametrize("value", [True, float("inf"), float("nan"), 10**1000])
def test_scores_reject_numeric_edge_values(value):
    with pytest.raises(contract.ScorerFailure):
        contract.validate_scores([value], 1)


@pytest.mark.parametrize(
    "raw,code",
    [(b'{"pairs":[]}', 0), (b'{"pairs":[{"source":"PRIVATE_SOURCE","target":3}]}', 2)],
)
def test_actual_worker_cli_has_json_only_output_without_neural_forward(raw, code):
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            sys.executable,
            "-X",
            "utf8",
            "-B",
            "-m",
            "backend.ru_pipeline.scorer_worker",
            "--engine",
            "mmarco",
            "--assets",
            "not-loaded-for-empty-or-invalid-request",
            "--root",
            str(root),
        ],
        input=raw,
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == code
    payload = json.loads(result.stdout)
    assert payload["ok"] is (code == 0)
    assert "PRIVATE_SOURCE" not in result.stdout.decode("utf-8")
    assert result.stderr == b""
    if code == 0:
        assert payload["scores"] == []
    else:
        assert payload["error"]["code"] == "invalid_reranker_input"
