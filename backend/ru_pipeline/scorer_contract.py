"""Strict source-only scorer protocol, independent of neural dependencies."""

import json
import math
import re


MAX_BYTES = 16 * 1024 * 1024
MAX_PAIRS = 10000
MAX_OUTPUT_BYTES = 1024 * 1024
QWEN_STAGES = {
    "qwen_title": "title",
    "qwen_tags": "tags",
    "qwen_links": "links",
    "qwen_new_tags": "tags",
}
ENGINES = frozenset({"mmarco", "tev", *QWEN_STAGES})


def engine_parts(engine):
    if type(engine) is not str:
        return None, None
    base, separator, model = engine.partition(":")
    if not separator and base in ENGINES:
        return base, None
    if separator and base in QWEN_STAGES and re.fullmatch(r"hfr_[a-f0-9]{16}", model):
        return base, model
    return None, None


class ScorerFailure(Exception):
    code = "reranker_failed"


class ScorerInputError(ScorerFailure):
    code = "invalid_reranker_input"


class ScorerAssetError(ScorerFailure):
    code = "reranker_assets_invalid"


class ScorerContextError(ScorerFailure):
    code = "context_budget_exceeded"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ScorerInputError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ScorerInputError("Nonfinite JSON constant")


def loads(raw):
    try:
        return json.loads(
            raw, object_pairs_hook=unique_object, parse_constant=reject_constant
        )
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise ScorerInputError("Invalid scorer JSON") from error


def validate_pairs(engine, pairs):
    if type(engine) is not str or engine not in ENGINES:
        raise ScorerInputError("Unsupported scorer")
    if type(pairs) is not list or len(pairs) > MAX_PAIRS:
        raise ScorerInputError("Bounded pair list required")
    minimum_bytes = len(b'{"pairs":[]}')
    for pair in pairs:
        if type(pair) is not dict or set(pair) != {"source", "target"}:
            raise ScorerInputError("Exact source/target schema required")
        for text in pair.values():
            if (
                type(text) is not str
                or len(text) > MAX_BYTES
                or not text.strip()
                or "\x00" in text
            ):
                raise ScorerInputError("Nonblank UTF8 source text required")
            minimum_bytes += len(text)
            if minimum_bytes > MAX_BYTES:
                raise ScorerInputError("Scorer request exceeds byte budget")
            try:
                text.encode("utf-8", errors="strict")
            except UnicodeError as error:
                raise ScorerInputError("Invalid UTF8 source") from error
    return pairs


def encode_request(engine, pairs):
    validate_pairs(engine, pairs)
    raw = json.dumps(
        {"pairs": pairs}, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ScorerInputError("Scorer request exceeds byte budget")
    return raw


def decode_request(engine, raw):
    if len(raw) > MAX_BYTES:
        raise ScorerInputError("Scorer request exceeds byte budget")
    value = loads(raw)
    if type(value) is not dict or set(value) != {"pairs"}:
        raise ScorerInputError("Exact pairs request required")
    return validate_pairs(engine, value["pairs"])


def validate_scores(scores, count):
    if type(scores) is not list or len(scores) != count:
        raise ScorerFailure("Complete score vector required")
    try:
        finite = all(
            type(value) in (int, float) and math.isfinite(value) for value in scores
        )
    except OverflowError:
        finite = False
    if not finite:
        raise ScorerFailure("Finite numeric scores required")
    return [float(value) for value in scores]
