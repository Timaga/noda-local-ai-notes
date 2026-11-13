"""Public completion receipt contract for pinned local regular LoRA exports."""

import math
from pathlib import Path
import re


COMPLETE_NAME = "TRAINING_COMPLETE_PUBLIC_V1.json"
COMPLETE_STATUS = "TRAINED_RELOADED_PARITY_VERIFIED"
FROZEN_NAME = "FROZEN_INPUTS_PUBLIC_V1.json"
FROZEN_LIMIT = 2 * 1024 * 1024
DATA_ORIGINS = frozenset({"local_grammar_v1", "local_grammar_v2"})


def verify_frozen_inputs(path, manifest, expected_data_sha, complete_path):
    if (
        Path(path).name != FROZEN_NAME
        or Path(path).parent != Path(complete_path).parent
        or type(manifest) is not dict
        or type(expected_data_sha) is not str
        or re.fullmatch(r"[0-9a-f]{64}", expected_data_sha) is None
        or manifest.get("input_rows_sha256") != expected_data_sha
        or manifest.get("checkpoint_verified") is not False
    ):
        raise ValueError("Pinned training-run input data receipt mismatch")
    return manifest


def verify_training_receipt(path, marker, source_sha):
    if Path(path).name != COMPLETE_NAME or type(marker) is not dict:
        raise ValueError("Explicit public training completion receipt required")
    if (
        marker.get("status") != COMPLETE_STATUS
        or type(marker.get("trainable_parameters")) is not int
        or marker["trainable_parameters"] != 40_370_176
        or type(marker.get("steps")) is not int
        or marker["steps"] < 1
        or type(marker.get("gradient_checked_steps")) is not int
        or marker["gradient_checked_steps"] != marker["steps"]
        or marker.get("adapter_sha256") != source_sha
        or marker.get("base_storage_unchanged") is not True
        or marker.get("semantic_or_Russian_quality_verified") is not False
        or type(marker.get("base_storage_sha256")) is not str
        or re.fullmatch(r"[0-9a-f]{64}", marker["base_storage_sha256"]) is None
    ):
        raise ValueError("Unverified training completion/source/base guard")
    for key in ("training_loss", "parity_atol", "parity_rtol", "seconds"):
        value = marker.get(key)
        if (
            not isinstance(value, (int, float))
            or type(value) not in (int, float)
            or value < 0
        ):
            raise ValueError("Finite training loss/parity/timing evidence required")
        try:
            finite = math.isfinite(value)
        except OverflowError as exc:
            raise ValueError("Training number exceeds finite numeric bounds") from exc
        if not finite:
            raise ValueError("Finite training loss/parity/timing evidence required")
    if marker["parity_atol"] != 1e-4 or marker["parity_rtol"] != 1e-4:
        raise ValueError("Approved reloaded-parity tolerances required")
    checkpoint = marker.get("resumable_checkpoint")
    if type(checkpoint) is not str or checkpoint != f"checkpoint-{marker['steps']}":
        raise ValueError("Bound resumable checkpoint basename required")
    return marker
