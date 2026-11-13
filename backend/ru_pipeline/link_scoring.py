"""Full-query mMARCO scoring of every lossless passage in a long link target."""

import math
from bisect import bisect_right
import unicodedata

from backend.note_processing_failures import NoteSystemError
from .link_boundary_passages import boundary_passages
from .scorer_assets import verify_assets
from .scorer_contract import MAX_PAIRS, ScorerInputError, encode_request, validate_pairs


CONTEXT = 512
OVERLAP_TOKENS = 32
MAX_PASSAGES = 4096
MAX_TOTAL_PASSAGES = 16384
MAX_TRANSPORT_BYTES = 128 * 1024 * 1024
TRANSPORT = "mmarco-full-query-prefix-boundaries-v2"


def _error(code):
    return NoteSystemError(
        "Оценщик связей не смог проверить все полные данные; частичный результат не принят.",
        failure_code=code,
    )


def load_tokenizer(config):
    from tokenizers import Tokenizer

    folder = verify_assets("mmarco", config.mmarco_assets, config.project_root)
    tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
    tokenizer.no_truncation()
    return tokenizer


def target_windows(tokenizer, source, target, *, maximum=MAX_PASSAGES):
    """Yield original-text spans; overlapping spans cover every target character."""
    if len(tokenizer.encode(source, target).ids) <= CONTEXT:
        yield 0, len(target)
        return
    start, count = 0, 0
    content_end = len(target.rstrip())
    ends = sorted(
        {
            right
            for left, right in tokenizer.encode(
                target, add_special_tokens=False
            ).offsets
            if 0 <= left < right <= len(target)
        }
    )
    while start < len(target):
        if count >= maximum:
            raise _error("links_reranker_window_budget_exceeded")
        nonblank = start
        while nonblank < len(target) and target[nonblank].isspace():
            nonblank += 1
        if nonblank == len(target):
            raise _error("links_reranker_source_too_long")
        end_index = bisect_right(ends, start) + CONTEXT
        high = ends[end_index] if end_index < len(ends) else len(target)
        low, end = nonblank + 1, None
        while low <= high:
            middle = (low + high) // 2
            if len(tokenizer.encode(source, target[start:middle]).ids) <= CONTEXT:
                end, low = middle, middle + 1
            else:
                high = middle - 1
        if end is None:
            raise _error("links_reranker_source_too_long")
        if (
            end >= content_end
            and len(tokenizer.encode(source, target[start:]).ids) <= CONTEXT
        ):
            end = len(target)
        # Do not put a combining mark at the beginning of a new non-overlap span.
        while end < len(target) and end > start and unicodedata.combining(target[end]):
            end -= 1
        if (
            end <= start
            or len(tokenizer.encode(source, target[start:end]).ids) > CONTEXT
        ):
            raise _error("links_reranker_source_too_long")
        yield start, end
        count += 1
        if end == len(target):
            return
        offsets = sorted(
            {
                left
                for left, right in tokenizer.encode(
                    target[start:end], add_special_tokens=False
                ).offsets
                if 0 <= left < right <= end - start
            }
        )
        if len(offsets) < 2:
            raise _error("links_reranker_source_too_long")
        overlap_count = min(OVERLAP_TOKENS, max(1, len(offsets) // 4))
        overlap = offsets[-overlap_count]
        while (
            overlap > 0
            and overlap < end - start
            and unicodedata.combining(target[start + overlap])
        ):
            overlap -= 1
        if not 0 < overlap < end - start:
            raise _error("links_reranker_source_too_long")
        start += overlap


def score_links(
    score,
    pairs,
    config,
    *,
    tokenizer=None,
    maximum=MAX_PASSAGES,
    maximum_total=MAX_TOTAL_PASSAGES,
    maximum_bytes=MAX_TRANSPORT_BYTES
):
    """Return one max logit per original pair; short pairs are submitted unchanged."""
    if type(pairs) is not list or len(pairs) > MAX_PAIRS:
        raise _error("links_reranker_protocol_failed")
    for pair in pairs:
        try:
            validate_pairs("mmarco", [pair])
        except ScorerInputError as exc:
            raise _error("links_reranker_protocol_failed") from exc
    if not pairs:
        return [], {
            "reranker_passage_count": 0,
            "reranker_windowed_pair_count": 0,
            "reranker_boundary_passage_count": 0,
        }
    tokenizer = load_tokenizer(config) if tokenizer is None else tokenizer
    scores, batch, owners = [None] * len(pairs), [], []
    passage_count, windowed_count, boundary_count, transport_bytes = 0, 0, 0, 0

    def packets(pair):
        count = 0
        for start, end in target_windows(
            tokenizer, pair["source"], pair["target"], maximum=maximum
        ):
            count += 1
            yield (
                pair
                if start == 0 and end == len(pair["target"])
                else {"source": pair["source"], "target": pair["target"][start:end]}
            ), False
        if count > 1:
            for target in boundary_passages(tokenizer, pair["source"], pair["target"]):
                yield {"source": pair["source"], "target": target}, True

    def flush():
        if not batch:
            return
        values = score("mmarco", batch)
        try:
            valid = (
                type(values) is list
                and len(values) == len(batch)
                and all(
                    type(value) in (int, float) and math.isfinite(value)
                    for value in values
                )
            )
        except (ValueError, TypeError, OverflowError):
            valid = False
        if not valid:
            raise _error("links_reranker_protocol_failed")
        for owner, value in zip(owners, values, strict=True):
            scores[owner] = (
                value if scores[owner] is None else max(scores[owner], value)
            )
        batch.clear()
        owners.clear()

    for owner, pair in enumerate(pairs):
        count = 0
        for item, boundary in packets(pair):
            if passage_count + count >= maximum_total or count >= maximum:
                raise _error("links_reranker_window_budget_exceeded")
            try:
                transport_bytes += len(encode_request("mmarco", [item]))
            except ScorerInputError as exc:
                raise _error("links_reranker_protocol_failed") from exc
            if transport_bytes > maximum_bytes:
                raise _error("links_reranker_window_budget_exceeded")
            try:
                encode_request("mmarco", batch + [item])
            except ScorerInputError:
                flush()
                try:
                    encode_request("mmarco", [item])
                except ScorerInputError as exc:
                    raise _error("links_reranker_protocol_failed") from exc
            batch.append(item)
            owners.append(owner)
            count += 1
            boundary_count += boundary
            if len(batch) == 128:
                flush()
        passage_count += count
        windowed_count += count > 1
    flush()
    if any(value is None for value in scores):
        raise _error("links_reranker_protocol_failed")
    return scores, {
        "reranker_passage_count": passage_count,
        "reranker_windowed_pair_count": windowed_count,
        "reranker_boundary_passage_count": boundary_count,
    }
