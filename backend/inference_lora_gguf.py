"""Bounded regular Qwen2 LoRA-GGUF validation without neural libraries."""

import math
from pathlib import Path
import struct


HEADER_LIMIT = 1024 * 1024
FILE_LIMIT = 128 * 1024 * 1024
SCALARS = {
    0: "B",
    1: "b",
    2: "H",
    3: "h",
    4: "I",
    5: "i",
    6: "f",
    7: "?",
    10: "Q",
    11: "q",
    12: "d",
}
F16_NONFINITE = bytes(1 if value & 0x7C == 0x7C else 0 for value in range(256))
TARGETS = {
    "attn_q": (3584, 3584),
    "attn_k": (3584, 512),
    "attn_v": (3584, 512),
    "attn_output": (3584, 3584),
    "ffn_gate": (3584, 18944),
    "ffn_up": (3584, 18944),
    "ffn_down": (18944, 3584),
}


class _Reader:
    def __init__(self, stream):
        self.stream = stream

    def read(self, size):
        if size < 0 or self.stream.tell() + size > HEADER_LIMIT:
            raise ValueError("LoRA header exceeds bounded budget")
        data = self.stream.read(size)
        if len(data) != size:
            raise ValueError("Truncated LoRA header")
        return data

    def number(self, fmt):
        return struct.unpack("<" + fmt, self.read(struct.calcsize("<" + fmt)))[0]

    def string(self):
        size = self.number("Q")
        if size > 16384:
            raise ValueError("Oversized LoRA header string")
        return self.read(size).decode("utf-8", errors="strict")

    def value(self, kind):
        if kind in SCALARS:
            value = self.number(SCALARS[kind])
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Nonfinite LoRA metadata")
            return value
        if kind == 8:
            return self.string()
        if kind == 9:
            element, count = self.number("I"), self.number("Q")
            if element == 9 or count > 1024:
                raise ValueError("Invalid LoRA metadata array")
            return [self.value(element) for _ in range(count)]
        raise ValueError("Unsupported LoRA metadata type")


def expected_tensors(rank):
    result = {}
    for layer in range(28):
        for target, (inputs, outputs) in TARGETS.items():
            name = f"blk.{layer}.{target}.weight"
            result[name + ".lora_a"] = (inputs, rank)
            result[name + ".lora_b"] = (rank, outputs)
    return result


def read_adapter(path, *, rank=16, alpha=32):
    """Validate descriptors, dense ranges and every F16 payload value."""
    if (
        type(rank) is not int
        or rank != 16
        or type(alpha) not in (int, float)
        or alpha != 32
    ):
        raise ValueError("Only the approved rank16 alpha32 adapter class allowed")
    path = Path(path)
    size = path.stat().st_size
    if not 24 <= size <= FILE_LIMIT:
        raise ValueError("LoRA file size exceeds approved bounds")
    expected, metadata, kinds, tensors = expected_tensors(rank), {}, {}, {}
    with path.open("rb") as stream:
        reader = _Reader(stream)
        if reader.read(4) != b"GGUF" or reader.number("I") != 3:
            raise ValueError("GGUF v3 little-endian adapter required")
        count, kv_count = reader.number("Q"), reader.number("Q")
        if count != 392 or kv_count > 256:
            raise ValueError("Exact regular LoRA tensor roster required")
        for _ in range(kv_count):
            key = reader.string()
            if (
                key in metadata
                or key.startswith("tokenizer.")
                or "alora" in key.lower()
            ):
                raise ValueError("Duplicate or unsupported LoRA metadata")
            kinds[key] = reader.number("I")
            metadata[key] = reader.value(kinds[key])
        if (
            any(
                metadata.get(key) != value
                for key, value in {
                    "general.architecture": "qwen2",
                    "general.type": "adapter",
                    "adapter.type": "lora",
                    "adapter.lora.alpha": alpha,
                }.items()
            )
            or metadata.get("general.alignment", 32) != 32
            or kinds.get("adapter.lora.alpha") != 6
            or metadata.get("general.file_type", 1) != 1
            or ("general.alignment" in metadata and kinds["general.alignment"] != 4)
            or ("general.file_type" in metadata and kinds["general.file_type"] != 4)
        ):
            raise ValueError("Regular Qwen2 LoRA metadata mismatch")
        for _ in range(count):
            name, dimensions = reader.string(), reader.number("I")
            if name in tensors or name not in expected or dimensions != 2:
                raise ValueError("Unexpected or duplicate LoRA tensor")
            shape = tuple(reader.number("Q") for _ in range(dimensions))
            kind, offset = reader.number("I"), reader.number("Q")
            if shape != expected[name] or kind != 1 or offset % 32:
                raise ValueError("LoRA F16 tensor shape/type/alignment mismatch")
            tensors[name] = (offset, math.prod(shape) * 2)
        data_start = (stream.tell() + 31) // 32 * 32
        cursor = 0
        for offset, length in sorted(tensors.values()):
            if offset != cursor or data_start + offset + length > size:
                raise ValueError("LoRA payload ranges overlap or are incomplete")
            stream.seek(data_start + offset)
            remaining = length
            while remaining:
                chunk = stream.read(min(remaining, 1024 * 1024))
                if (
                    not chunk
                    or len(chunk) % 2
                    or 1 in chunk[1::2].translate(F16_NONFINITE)
                ):
                    raise ValueError("Truncated or nonfinite LoRA F16 payload")
                remaining -= len(chunk)
            cursor += length
        if data_start + cursor != size:
            raise ValueError("Unexpected trailing LoRA payload")
    parameters = sum(length // 2 for _, length in tensors.values())
    if parameters != 40_370_176:
        raise ValueError("LoRA parameter count mismatch")
    return {
        "tensor_count": count,
        "parameters": parameters,
        "rank": rank,
        "alpha": float(alpha),
        "outtype": "f16",
        "architecture": "qwen2",
    }


def read_source_adapter(path, decode):
    """Validate only the bounded source safetensors header, never load a model."""
    path = Path(path)
    if (
        path.name != "adapter_model.safetensors"
        or not 8 <= path.stat().st_size <= 256 * 1024 * 1024
    ):
        raise ValueError("Bounded PEFT safetensors adapter required")
    with path.open("rb") as stream:
        prefix = stream.read(8)
        length = struct.unpack("<Q", prefix)[0]
        if not 1 <= length <= HEADER_LIMIT:
            raise ValueError("Bounded PEFT safetensors header required")
        header = decode(stream.read(length), limit=HEADER_LIMIT)
    if type(header) is not dict:
        raise ValueError("PEFT safetensors header object required")
    names, ranges, parameters = {}, [], 0
    modules = {
        "attn_q": ("self_attn", "q_proj"),
        "attn_k": ("self_attn", "k_proj"),
        "attn_v": ("self_attn", "v_proj"),
        "attn_output": ("self_attn", "o_proj"),
        "ffn_gate": ("mlp", "gate_proj"),
        "ffn_up": ("mlp", "up_proj"),
        "ffn_down": ("mlp", "down_proj"),
    }
    for layer in range(28):
        for target, (inputs, outputs) in TARGETS.items():
            family, module = modules[target]
            prefix = f"base_model.model.model.layers.{layer}.{family}.{module}"
            names[prefix + ".lora_A.weight"] = [16, inputs]
            names[prefix + ".lora_B.weight"] = [outputs, 16]
    metadata = header.pop("__metadata__", {})
    if metadata not in ({}, {"format": "pt"}) or set(header) != set(names):
        raise ValueError("Unexpected PEFT auxiliary/embedding tensors")
    for name, row in header.items():
        if (
            type(row) is not dict
            or set(row) != {"dtype", "shape", "data_offsets"}
            or type(row["shape"]) is not list
            or any(type(value) is not int for value in row["shape"])
            or row["shape"] != names[name]
            or type(row["dtype"]) is not str
            or row["dtype"] not in {"F16", "BF16", "F32"}
        ):
            raise ValueError("PEFT tensor dtype/shape/semantics mismatch")
        offsets = row["data_offsets"]
        count = math.prod(names[name])
        width = 4 if row["dtype"] == "F32" else 2
        if (
            type(offsets) is not list
            or len(offsets) != 2
            or any(type(value) is not int for value in offsets)
            or offsets[0] < 0
            or offsets[1] - offsets[0] != count * width
        ):
            raise ValueError("PEFT tensor payload bounds mismatch")
        ranges.append(tuple(offsets))
        parameters += count
    cursor = 0
    for start, end in sorted(ranges):
        if start != cursor:
            raise ValueError("PEFT overlapping/incomplete payload")
        cursor = end
    if 8 + length + cursor != path.stat().st_size or parameters != 40_370_176:
        raise ValueError("PEFT adapter count/file bounds mismatch")
    return {"tensor_count": len(header), "parameters": parameters}
