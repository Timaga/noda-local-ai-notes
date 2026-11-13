"""Run selected scorer dependencies in owned, bounded local subprocesses."""

import math
import os
from pathlib import Path
import subprocess
import tempfile

from backend.note_processing_failures import NoteSystemError
from .scorer_contract import (
    MAX_OUTPUT_BYTES,
    QWEN_STAGES,
    ScorerFailure,
    ScorerInputError,
    engine_parts,
    encode_request,
    loads,
    validate_scores,
)


def _failure(code):
    return NoteSystemError(
        "Локальный оценщик не завершил проверку. Исходный текст не изменён.",
        failure_code=code,
    )


def _stop_owned(process):
    try:
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                if process.poll() is None:
                    raise
        process.wait(timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise _failure("reranker_shutdown_failed") from error


def _score_pairs(engine, pairs, config):
    engine, custom = engine_parts(engine)
    try:
        raw = encode_request(engine, pairs)
    except ScorerInputError as error:
        raise _failure(error.code) from error
    if not pairs:
        return []
    python = Path(config.mmarco_python if engine == "mmarco" else config.tev_python)
    asset_engine = "qwen" if engine in QWEN_STAGES else engine
    if custom:
        from .imported_models import descriptor_path, runtime_model

        _, trial = runtime_model(config.runtime_dir, custom)
        assets = descriptor_path(config.runtime_dir, custom, trial=trial)
    else:
        assets = Path(getattr(config, f"{asset_engine}_assets"))
    root = Path(config.project_root).resolve()
    timeout = config.scorer_timeout
    if (
        type(timeout) not in (int, float)
        or not math.isfinite(timeout)
        or not 0 < timeout <= 3600
    ):
        raise _failure("reranker_configuration_invalid")
    if not python.is_file() or not assets.is_file():
        raise _failure("reranker_unavailable")
    environment = os.environ.copy()
    for key in ("PYTHONPATH", "PYTHONHOME"):
        environment.pop(key, None)
    environment.update(
        {
            "PYTHONNOUSERSITE": "1",
            "PYTHONUTF8": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
            "TRANSFORMERS_VERBOSITY": "error",
            "HF_HUB_VERBOSITY": "error",
        }
    )
    command = [
        str(python),
        "-X",
        "utf8",
        "-B",
        "-m",
        "backend.ru_pipeline.scorer_worker",
        "--engine",
        engine,
        "--assets",
        str(assets),
        "--root",
        str(root),
    ]
    if custom:
        command.extend(("--imported", custom))
    process = None
    try:
        with tempfile.TemporaryFile() as output:
            try:
                process = subprocess.Popen(
                    command,
                    cwd=getattr(config, "source_root", root),
                    env=environment,
                    stdin=subprocess.PIPE,
                    stdout=output,
                    stderr=subprocess.DEVNULL,
                    shell=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                process.communicate(input=raw, timeout=timeout)
            except subprocess.TimeoutExpired as error:
                if process is not None:
                    _stop_owned(process)
                raise _failure("reranker_timeout") from error
            except OSError as error:
                raise _failure("reranker_unavailable") from error
            output.seek(0)
            response_raw = output.read(MAX_OUTPUT_BYTES + 1)
        if len(response_raw) > MAX_OUTPUT_BYTES:
            raise _failure("reranker_protocol_failed")
        try:
            response = loads(response_raw)
            if type(response) is not dict or type(response.get("ok")) is not bool:
                raise ScorerFailure("Invalid worker response")
            if response["ok"]:
                if process.returncode != 0 or set(response) != {"ok", "scores"}:
                    raise ScorerFailure("Worker success status mismatch")
                return validate_scores(response["scores"], len(pairs))
            if process.returncode == 0 or set(response) != {"ok", "error"}:
                raise ScorerFailure("Worker failure status mismatch")
            code = (
                response["error"].get("code")
                if type(response["error"]) is dict
                else None
            )
            if code not in {
                "invalid_reranker_input",
                "reranker_assets_invalid",
                "context_budget_exceeded",
                "reranker_memory",
                "reranker_failed",
            }:
                raise ScorerFailure("Unknown worker failure")
            raise _failure(code)
        except ScorerFailure as error:
            raise _failure("reranker_protocol_failed") from error
    finally:
        if process is not None and process.poll() is None:
            _stop_owned(process)


def score_pairs(engine, pairs, config):
    try:
        return _score_pairs(engine, pairs, config)
    except NoteSystemError:
        raise
    except (OSError, ValueError, TypeError, AttributeError, OverflowError) as error:
        raise _failure("reranker_configuration_invalid") from error
