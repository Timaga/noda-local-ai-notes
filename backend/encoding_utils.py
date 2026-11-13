# Who: Tim Buglaev
# When: 2026-06-13
# What: Added bounded mojibake repair for runtime source strings and console streams,
#       covering UTF-8-as-CP1251 and CP1251-as-Latin1 Russian text while keeping valid text unchanged.

import os
import re
import sys


_UTF8_AS_CP1251_PATTERN = re.compile(
    r"(?:[\u0420\u0421][\u0080-\u00ff\u0400-\u040f\u0450-\u045f]|"
    r"[\u00d0\u00d1][\u0080-\u00ff]|\u0432\u0402.|\u0412[\u00ab\u00bb])"
)
_CP1251_AS_LATIN1_RUN = re.compile(r"[\u00c0-\u00ff]{2,}")
_CYRILLIC_WORD = re.compile(r"[\u0410-\u044f\u0401\u0451]{2,}")
_CYRILLIC_CHAR = re.compile(r"[\u0400-\u04ff]")


def _mojibake_score(text):
    if not isinstance(text, str) or not text:
        return 0
    return (
        len(_UTF8_AS_CP1251_PATTERN.findall(text)) * 3
        + len(_CP1251_AS_LATIN1_RUN.findall(text)) * 2
        + text.count("\ufffd") * 8
    )


def _russian_text_score(text):
    if not isinstance(text, str) or not text:
        return 0
    cyrillic_chars = len(_CYRILLIC_CHAR.findall(text))
    cyrillic_words = len(_CYRILLIC_WORD.findall(text))
    return cyrillic_chars + (cyrillic_words * 4) - (_mojibake_score(text) * 5)


def _decode_candidate(text, source_encoding, target_encoding):
    try:
        return text.encode(source_encoding).decode(target_encoding)
    except UnicodeError:
        return None


def _candidate_repairs(text):
    seen = {text}
    frontier = [text]
    candidates = []
    for _ in range(2):
        next_frontier = []
        for candidate in frontier:
            for source_encoding, target_encoding in (
                ("cp1251", "utf-8"),
                ("latin1", "cp1251"),
            ):
                repaired = _decode_candidate(candidate, source_encoding, target_encoding)
                if repaired and repaired not in seen:
                    seen.add(repaired)
                    candidates.append(repaired)
                    next_frontier.append(repaired)
        frontier = next_frontier
    return candidates


def _split_line_ending(line):
    for ending in ("\r\n", "\n", "\r"):
        if line.endswith(ending):
            return line[: -len(ending)], ending
    return line, ""


def _repair_mojibake_line(line):
    core, ending = _split_line_ending(line)
    original_mojibake_score = _mojibake_score(core)
    if original_mojibake_score <= 0:
        return line
    original_text_score = _russian_text_score(core)
    best = core
    best_score = original_text_score
    for candidate in _candidate_repairs(core):
        if _mojibake_score(candidate) >= original_mojibake_score:
            continue
        candidate_score = _russian_text_score(candidate)
        if candidate_score > best_score and _CYRILLIC_WORD.search(candidate):
            best = candidate
            best_score = candidate_score
    if best == core:
        return line
    return best + ending


def repair_mojibake_text(value):
    if not isinstance(value, str) or not value:
        return value
    return "".join(_repair_mojibake_line(line) for line in value.splitlines(True))


class MojibakeRepairStream:
    _mojibake_repair_stream = True

    def __init__(self, wrapped):
        self._wrapped = wrapped

    def write(self, text):
        if isinstance(text, str):
            text = repair_mojibake_text(text)
        return self._wrapped.write(text)

    def flush(self):
        return self._wrapped.flush()

    def __getattr__(self, name):
        return getattr(self._wrapped, name)


def install_stdio_mojibake_repair():
    if os.environ.get("RAG_DISABLE_MOJIBAKE_REPAIR", "").strip().lower() in {"1", "true", "yes"}:
        return
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None or getattr(stream, "_mojibake_repair_stream", False):
            continue
        setattr(sys, stream_name, MojibakeRepairStream(stream))
