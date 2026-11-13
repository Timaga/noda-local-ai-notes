"""Local scorer subprocess: source-only JSON in, complete score vector out."""

import argparse
import json
import os
from pathlib import Path
import sys

from .scorer_contract import (
    ENGINES,
    MAX_BYTES,
    QWEN_STAGES,
    ScorerFailure,
    decode_request,
    validate_scores,
)
from .worker_logging import muted_dependencies


def create_scorer(engine, assets, root):
    if engine == "mmarco":
        from .scorer_mmarco import MMarcoScorer

        return MMarcoScorer(assets, root)
    if engine in QWEN_STAGES:
        from .scorer_qwen import QwenScorer

        return QwenScorer(assets, root, QWEN_STAGES[engine])
    from .scorer_tev import TevScorer

    return TevScorer(assets, root)


def evaluate(engine, raw, assets, root, *, factory=create_scorer):
    pairs = decode_request(engine, raw)
    if not pairs:
        return {"ok": True, "scores": []}
    scorer = None
    try:
        scorer = factory(engine, assets, root)
        scores = [scorer.score(pair) for pair in pairs]
        return {"ok": True, "scores": validate_scores(scores, len(pairs))}
    finally:
        if scorer is not None:
            scorer.close()


def safe_failure(error):
    if isinstance(error, MemoryError) or type(error).__name__ == "OutOfMemoryError":
        code = "reranker_memory"
    else:
        code = error.code if isinstance(error, ScorerFailure) else "reranker_failed"
    return {"ok": False, "error": {"code": code, "type": type(error).__name__}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=sorted(ENGINES), required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--imported")
    args = parser.parse_args()
    for key in (
        "HF_HUB_OFFLINE",
        "TRANSFORMERS_OFFLINE",
        "HF_DATASETS_OFFLINE",
        "HF_HUB_DISABLE_TELEMETRY",
    ):
        os.environ[key] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["TRANSFORMERS_VERBOSITY"] = "error"
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    try:
        with muted_dependencies():
            if args.imported:
                from .imported_models import read_descriptor
                from .imported_scorer import create_imported_scorer

                item = read_descriptor(args.assets, args.imported, trial=args.assets.suffix == ".trial")
                response = evaluate(
                    args.engine, raw, args.assets, args.root,
                    factory=lambda engine, assets, root: create_imported_scorer(
                        item, root, QWEN_STAGES[engine],
                    ),
                )
            else:
                response = evaluate(args.engine, raw, args.assets, args.root)
    except Exception as error:
        response = safe_failure(error)
    sys.stdout.write(
        json.dumps(response, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n"
    )
    sys.stdout.flush()
    return 0 if response["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
