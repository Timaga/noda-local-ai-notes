"""Immutable, file-verified regular LoRA admission and native HTTP contracts."""

from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import stat

import requests

from backend.inference_lora_gguf import FILE_LIMIT, read_adapter, read_source_adapter
from backend.inference_lora_origin import (
    DATA_ORIGINS,
    FROZEN_LIMIT,
    FROZEN_NAME,
    verify_frozen_inputs,
    verify_training_receipt,
)
from backend.inference_runner import (
    CompletionResponseError,
    ModelInvocationError,
    ModelUnavailableError,
)


ROOT = Path(__file__).resolve().parents[1]
BASE_SHA = "6ba966fbc586a243577a962afa2ba0f7223f62e1a55a6c00311e0787c50b285e"
BASE_PARAMETERS = 7_612_756_480
BASE_REVISION = "fbabc76f32140416dc5b0ceef392c7778eec1312"
EXPORTER_COMMIT = "08ffba21e5c2f1728b6b405c05ff3913f65706d4"


def _hex(value):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


@dataclass(frozen=True)
class AdapterPin:
    path: Path
    sha256: str
    rank: int
    alpha: float
    parameters: int
    config_path: Path
    config_sha256: str
    origin_path: Path
    origin_sha256: str

    def __post_init__(self):
        for path in (self.path, self.config_path, self.origin_path):
            if (
                not isinstance(path, Path)
                or not path.is_absolute()
                or any(char in str(path) for char in (",", "\0", "\r", "\n"))
            ):
                raise ValueError("Single absolute LoRA asset path required")
        if not all(
            _hex(value)
            for value in (self.sha256, self.config_sha256, self.origin_sha256)
        ):
            raise ValueError("Explicit lowercase LoRA SHA256 pins required")
        if (
            type(self.rank) is not int
            or self.rank != 16
            or type(self.parameters) is not int
            or self.parameters != 40_370_176
        ):
            raise ValueError("Only approved rank16/count LoRA class allowed")
        if (
            type(self.alpha) not in (int, float)
            or self.alpha != 32
            or not math.isfinite(self.alpha)
        ):
            raise ValueError("Approved finite LoRA alpha32 required")

    def public(self):
        return {
            key: str(value) if isinstance(value, Path) else value
            for key, value in asdict(self).items()
        }


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate LoRA metadata JSON key")
        result[key] = value
    return result


def _constant(_):
    raise ValueError("Nonfinite LoRA JSON value")


def _finite_float(raw):
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("Nonfinite LoRA JSON number")
    return value


def decode_metadata(raw, *, limit=65536):
    if type(raw) is not bytes or len(raw) > limit:
        raise ValueError("Bounded LoRA metadata required")
    try:
        return json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_object,
            parse_constant=_constant,
            parse_float=_finite_float,
        )
    except RecursionError as exc:
        raise ValueError("Excessively nested LoRA metadata") from exc


def _asset(path, root):
    path = Path(path).absolute()
    if ".." in path.parts or not path.is_relative_to(root):
        raise ValueError("LoRA asset outside owned workspace")
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except OSError as exc:
            raise ValueError("Regular LoRA assets required") from exc
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("LoRA reparse path refused")
    if not path.is_file() or path.resolve() != path:
        raise ValueError("Canonical regular LoRA asset required")
    return path


def _file_hash(path, expected, root, limit):
    path = _asset(path, root)
    if path.stat().st_size > limit:
        raise ValueError("LoRA asset size exceeds bounded budget")
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
            raise ValueError("Pinned LoRA asset drift")


def load_pinned_json(path, expected, *, root=None, limit=65536):
    if (
        type(limit) is not int
        or limit not in (65536, FROZEN_LIMIT)
        or (limit == FROZEN_LIMIT and Path(path).name != FROZEN_NAME)
    ):
        raise ValueError("Explicit metadata-class bounds required")
    root = ROOT if root is None else Path(root).absolute()
    with _asset(path, root).open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Pinned LoRA JSON hash/bound mismatch")
    return decode_metadata(raw, limit=limit)


def verify_pin_hashes(pin, *, root=None):
    if type(pin) is not AdapterPin:
        raise ValueError("Immutable LoRA pin required")
    root = ROOT if root is None else Path(root).absolute()
    for path, expected, limit in (
        (pin.path, pin.sha256, FILE_LIMIT),
        (pin.config_path, pin.config_sha256, 65536),
        (pin.origin_path, pin.origin_sha256, 65536),
    ):
        _file_hash(path, expected, root, limit)


def verify_base_file(path, *, root=None):
    scope = ROOT if root is None else Path(root).absolute()
    approved = scope / "models/ru-title-tlite-7b-q8-v1/t-lite-it-1.0-q8_0.gguf"
    if Path(path) != approved:
        raise ValueError("Only the approved T-Lite base may load LoRA")
    _file_hash(approved, BASE_SHA, scope, 10 * 1024 * 1024 * 1024)


def verify_adapter_files(pin, *, root=None):
    verify_pin_hashes(pin, root=root)
    config = load_pinned_json(pin.config_path, pin.config_sha256, root=root)
    origin = load_pinned_json(pin.origin_path, pin.origin_sha256, root=root)
    if type(config) is not dict or type(origin) is not dict:
        raise ValueError("Pinned LoRA config/origin objects required")
    targets = {
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "gate_proj",
        "up_proj",
        "down_proj",
    }
    modules = config.get("target_modules")
    base = config.get("base_model_name_or_path")
    approved_local = str((ROOT / "models/ru-title-tlite-7b-ft-base-v1").resolve())
    if (
        config.get("peft_type") != "LORA"
        or config.get("task_type") != "CAUSAL_LM"
        or type(config.get("r")) is not int
        or config["r"] != pin.rank
        or type(config.get("lora_alpha")) not in (int, float)
        or config["lora_alpha"] != pin.alpha
        or config.get("bias") != "none"
        or type(modules) is not list
        or len(modules) != 7
        or any(type(item) is not str for item in modules)
        or set(modules) != targets
        or base not in ("t-tech/T-lite-it-1.0", approved_local)
        or config.get("revision") not in (None, BASE_REVISION)
    ):
        raise ValueError("Regular pinned T-Lite LoRA config mismatch")
    for key in (
        "use_rslora",
        "use_dora",
        "lora_bias",
        "fan_in_fan_out",
        "use_qalora",
        "ensure_weight_tying",
    ):
        if config.get(key, False) is not False:
            raise ValueError("Unsupported LoRA scaling or tensor semantics")
    for key in (
        "modules_to_save",
        "target_parameters",
        "trainable_token_indices",
        "layer_replication",
        "layers_to_transform",
        "layers_pattern",
        "alora_invocation_tokens",
        "exclude_modules",
        "megatron_config",
        "eva_config",
        "corda_config",
        "lora_ga_config",
        "velora_config",
        "monteclora_config",
        "use_bdlora",
        "arrow_config",
        "kasa_config",
    ):
        if config.get(key) is not None:
            raise ValueError("Unsupported auxiliary LoRA tensors")
    for key in ("rank_pattern", "alpha_pattern", "loftq_config"):
        if config.get(key, {}) != {}:
            raise ValueError("Unsupported LoRA pattern/base modification")
    if config.get("init_lora_weights", True) is not True:
        raise ValueError("Base-modifying LoRA initialization refused")
    required = {
        "schema_version": 1,
        "base_model_id": "t-tech/T-lite-it-1.0",
        "base_revision": BASE_REVISION,
        "base_gguf_sha256": BASE_SHA,
        "base_parameters": BASE_PARAMETERS,
        "adapter_sha256": pin.sha256,
        "adapter_config_sha256": pin.config_sha256,
        "exporter_commit": EXPORTER_COMMIT,
        "adapter_class": "regular_lora",
        "rank": pin.rank,
        "alpha": pin.alpha,
        "parameters": pin.parameters,
        "tensor_count": 392,
        "outtype": "f16",
        "trained": True,
        "adapter_weights_origin": "LOCAL_TRAINED_ADAPTER",
        "synthetic_adapter_for_converter_test": False,
        "model_weights_merged": False,
    }
    if any(
        type(origin.get(key)) is not type(value)
        and not (key == "alpha" and type(origin.get(key)) in (int, float))
        or origin.get(key) != value
        for key, value in required.items()
    ) or not all(
        _hex(origin.get(key))
        for key in (
            "source_adapter_sha256",
            "training_complete_sha256",
            "frozen_inputs_sha256",
            "training_input_rows_sha256",
        )
    ):
        raise ValueError("Pinned trained-adapter origin mismatch")
    if (
        type(origin.get("training_data_origin")) is not str
        or origin["training_data_origin"] not in DATA_ORIGINS
    ):
        raise ValueError("Explicit approved local grammar origin required")
    scope = ROOT if root is None else Path(root).absolute()
    for key, limit in (
        ("source_adapter", 256 * 1024 * 1024),
        ("training_complete", 65536),
        ("frozen_inputs", FROZEN_LIMIT),
    ):
        if (
            type(origin.get(key + "_path")) is not str
            or not Path(origin[key + "_path"]).is_absolute()
        ):
            raise ValueError("Explicit pinned training-origin files required")
        _file_hash(Path(origin[key + "_path"]), origin[key + "_sha256"], scope, limit)
    complete = load_pinned_json(
        Path(origin["training_complete_path"]),
        origin["training_complete_sha256"],
        root=scope,
    )
    verify_training_receipt(
        Path(origin["training_complete_path"]),
        complete,
        origin["source_adapter_sha256"],
    )
    frozen = load_pinned_json(
        Path(origin["frozen_inputs_path"]),
        origin["frozen_inputs_sha256"],
        root=scope,
        limit=FROZEN_LIMIT,
    )
    verify_frozen_inputs(
        Path(origin["frozen_inputs_path"]),
        frozen,
        origin["training_input_rows_sha256"],
        Path(origin["training_complete_path"]),
    )
    read_source_adapter(Path(origin["source_adapter_path"]), decode_metadata)
    return read_adapter(pin.path, rank=pin.rank, alpha=pin.alpha)


def verify_native_adapters(payload, pin):
    if type(pin) is not AdapterPin:
        raise ValueError("Immutable LoRA expectation required")
    if type(payload) is not list or len(payload) != 1 or type(payload[0]) is not dict:
        raise ValueError("Exactly one native LoRA adapter required")
    row = payload[0]
    if (
        set(row) != {"id", "path", "scale", "task_name", "prompt_prefix"}
        or type(row["id"]) is not int
        or row["id"] != 0
        or type(row["path"]) is not str
        or row["path"] != str(pin.path)
        or type(row["scale"]) not in (int, float)
        or row["scale"] != 1
        or not math.isfinite(row["scale"])
        or row["task_name"] != ""
        or row["prompt_prefix"] != ""
    ):
        raise ValueError("Native LoRA identity/scale/schema mismatch")
    return {"id": 0, "path": row["path"], "scale": 1.0}


def bind_completion(payload, pin):
    if type(payload) is not dict or any(
        key in payload
        for key in ("lora", "lora_scale", "adapter_scale", "adapter_path")
    ):
        raise ModelInvocationError("Caller LoRA override refused")
    if type(pin) is not AdapterPin:
        raise ModelInvocationError("Immutable LoRA expectation required")
    return {**payload, "lora": [{"id": 0, "scale": 1.0}]}


def request_adapter_list(session, base_url, timeout):
    response = None
    try:
        response = session.request(
            "GET",
            base_url + "/lora-adapters",
            data=None,
            timeout=timeout,
            allow_redirects=False,
            stream=True,
        )
        if response.status_code == 503:
            raise ModelUnavailableError("Native LoRA server is not ready")
        if response.status_code != 200:
            raise ModelInvocationError("Native LoRA metadata request rejected")
        raw = bytearray()
        for chunk in response.iter_content(chunk_size=65536):
            if type(chunk) is not bytes or len(raw) + len(chunk) > 65536:
                raise ValueError("Oversized native LoRA metadata")
            raw.extend(chunk)
        value = decode_metadata(bytes(raw))
        if type(value) is not list:
            raise ValueError("Native LoRA response must be an array")
        return value
    except requests.Timeout as exc:
        raise TimeoutError("Native LoRA metadata timed out") from exc
    except requests.ConnectionError as exc:
        raise ConnectionError("Native LoRA metadata unavailable") from exc
    except requests.RequestException as exc:
        raise ModelInvocationError("Native LoRA metadata transport failed") from exc
    except (ValueError, UnicodeError, AttributeError) as exc:
        raise CompletionResponseError("Invalid native LoRA metadata") from exc
    finally:
        if response is not None:
            response.close()


def parameter_metadata(pin):
    return {
        "base_parameters": BASE_PARAMETERS,
        "adapter_parameters": pin.parameters,
        "total_stored_parameters": BASE_PARAMETERS + pin.parameters,
        "artifacts_merged": False,
    }
