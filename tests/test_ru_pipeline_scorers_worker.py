"""JSON framing and native/Python log containment at the worker boundary."""

import io
import json
import os
from pathlib import Path
import sys

import pytest

from backend.ru_pipeline import scorer_worker as worker
from backend.ru_pipeline.scorer_contract import encode_request
from backend.ru_pipeline.worker_logging import muted_dependencies


def test_dependency_and_native_output_are_suppressed_without_losing_json_channel(capfd):
    print("before")
    with muted_dependencies():
        print("PRIVATE_SOURCE")
        print("PRIVATE_SOURCE", file=sys.stderr)
        os.write(1, b"PRIVATE_SOURCE")
        os.write(2, b"PRIVATE_SOURCE")
    print("after")
    out, err = capfd.readouterr()
    assert "before" in out and "after" in out
    assert "PRIVATE_SOURCE" not in out + err


@pytest.mark.parametrize("failure", [False, True])
def test_worker_main_returns_only_complete_scores_or_safe_error(
    monkeypatch, capfd, tmp_path, failure
):
    pair = {
        "source": "\ufeff  PRIVATE_SOURCE\r\nХвост  ",
        "target": "Точный тег: описание",
    }
    stdin = io.TextIOWrapper(
        io.BytesIO(encode_request("tev", [pair])), encoding="utf-8"
    )
    monkeypatch.setattr(sys, "stdin", stdin)
    monkeypatch.setattr(
        sys,
        "argv",
        ["worker", "--engine", "tev", "--assets", "unused", "--root", str(tmp_path)],
    )
    seen = []

    class FakeScorer:
        def score(self, item):
            seen.append(item)
            print("PRIVATE_SOURCE", file=sys.stderr)
            os.write(1, b"PRIVATE_SOURCE")
            if failure:
                raise RuntimeError("PRIVATE_SOURCE")
            return 0.75

        def close(self):
            seen.append("closed")

    original = worker.evaluate
    monkeypatch.setattr(
        worker,
        "evaluate",
        lambda *args: original(*args, factory=lambda *unused: FakeScorer()),
    )
    assert worker.main() == (2 if failure else 0)
    out, err = capfd.readouterr()
    assert "PRIVATE_SOURCE" not in out + err
    assert seen == [pair, "closed"]
    response = json.loads(out)
    if failure:
        assert response == {
            "ok": False,
            "error": {"code": "reranker_failed", "type": "RuntimeError"},
        }
    else:
        assert response == {"ok": True, "scores": [0.75]}


def test_cleanup_failure_is_never_published_as_success():
    class FakeScorer:
        def score(self, _pair):
            return 0.9

        def close(self):
            raise RuntimeError("Synthetic close failure")

    with pytest.raises(RuntimeError, match="close failure"):
        worker.evaluate(
            "tev",
            encode_request("tev", [{"source": "Исходник", "target": "метка"}]),
            Path("unused"),
            Path("unused"),
            factory=lambda *args: FakeScorer(),
        )
