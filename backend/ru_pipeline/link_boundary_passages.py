"""Literal context packets supplement complete sliding coverage for long notes."""

import re
import unicodedata


BOUNDARY = re.compile(r"(?<=[.!?])[ \t]+|\r?\n+")
PREFIX_TOKENS = 64


def boundary_passages(tokenizer, source, target, *, context=512):
    """Yield fitting sentence/line packets, never summaries or generated context.

    Oversized units remain covered by the caller's complete sliding windows.
    These supplemental packets keep the document's literal opening and preceding
    unit near a later fact without making every nearby filler sentence dominant.
    """
    ends = [match.end() for match in BOUNDARY.finditer(target)] + [len(target)]
    spans, start = [], 0
    for end in ends:
        if end > start and target[start:end].strip():
            spans.append((start, end))
        start = end
    if not spans:
        return
    prefix = target[: spans[0][1]]
    offsets = tokenizer.encode(prefix, add_special_tokens=False).offsets
    if len(offsets) > PREFIX_TOKENS:
        end = offsets[PREFIX_TOKENS - 1][1]
        while 0 < end < len(prefix) and unicodedata.combining(prefix[end]):
            end -= 1
        prefix = prefix[:end]
    seen = set()
    for index, (start, end) in enumerate(spans):
        begin = spans[index - 1][0] if index else start
        packet = target[begin:end]
        if start >= len(prefix):
            packet = prefix + "\n\n" + packet
        if len(tokenizer.encode(source, packet).ids) > context:
            packet = prefix + "\n\n" + target[start:end]
        if (
            packet.strip()
            and packet not in seen
            and len(tokenizer.encode(source, packet).ids) <= context
        ):
            seen.add(packet)
            yield packet
