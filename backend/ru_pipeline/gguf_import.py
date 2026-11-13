"""Read bounded GGUF metadata before handing user weights to the native runtime."""

import math
import struct


_SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_HEADER_LIMIT = 64 * 1024 * 1024


def inspect_generator(path):
    with path.open("rb") as stream:
        limit = min(path.stat().st_size, _HEADER_LIMIT)

        def read(size):
            if not 0 <= size <= limit - stream.tell():
                raise ValueError("GGUF header exceeds its limit")
            data = stream.read(size)
            if len(data) != size:
                raise ValueError("Truncated GGUF")
            return data

        def number(size=8):
            return int.from_bytes(read(size), "little")

        def skip(size):
            if not 0 <= size <= limit - stream.tell():
                raise ValueError("GGUF field exceeds its limit")
            stream.seek(size, 1)

        def skip_value(kind):
            if kind in _SIZES:
                skip(_SIZES[kind])
            elif kind == 8:
                skip(number())
            elif kind == 9:
                entry, count = number(4), number()
                if entry in _SIZES:
                    skip(count * _SIZES[entry])
                elif entry == 8 and count <= 1_000_000:
                    for _ in range(count):
                        skip(number())
                else:
                    raise ValueError("Unsupported GGUF array")
            else:
                raise ValueError("Unsupported GGUF field")

        if read(4) != b"GGUF" or number(4) not in (2, 3):
            raise ValueError("Unsupported GGUF version")
        tensors, fields = number(), number()
        if not 0 < tensors <= 50000 or not 0 < fields <= 4096:
            raise ValueError("Invalid GGUF header")
        architecture = b""
        contexts = {}
        for _ in range(fields):
            length = number()
            if not 0 < length <= 1024:
                raise ValueError("Invalid GGUF metadata key")
            key, kind = read(length), number(4)
            if key == b"general.architecture" and kind == 8:
                length = number()
                if not 0 < length <= 64:
                    raise ValueError("Invalid GGUF architecture")
                architecture = read(length)
            elif key.endswith(b".context_length") and kind == 4:
                contexts[key] = number(4)
            else:
                skip_value(kind)
        context = contexts.get(architecture + b".context_length", 8192)
        parameters = 0
        for _ in range(tensors):
            length = number()
            if not 0 < length <= 1024:
                raise ValueError("Invalid tensor name")
            skip(length)
            dims = number(4)
            if not 1 <= dims <= 4:
                raise ValueError("Invalid tensor dimensions")
            shape = struct.unpack("<" + "Q" * dims, read(8 * dims))
            if not all(0 < dim <= 10_000_000 for dim in shape):
                raise ValueError("Invalid tensor shape")
            parameters += math.prod(shape)
            skip(12)  # dtype and offset are validated by the native loader
        return parameters, min(8192, context)
