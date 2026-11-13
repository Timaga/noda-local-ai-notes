"""One bounded model decision per candidate, independent of note editing and tags."""

import json
import re

try:
    from backend.note_generation_contract import (
        NoteGenerationError,
        TemporaryModelError,
        _outside_code,
    )
    from backend.note_identity_context import matched_identity_candidates
    from backend.note_relation_prompt import (
        relation_request,
        KINDS,
    )
except ImportError:
    from note_generation_contract import (
        NoteGenerationError,
        TemporaryModelError,
        _outside_code,
    )
    from note_identity_context import matched_identity_candidates
    from note_relation_prompt import (
        relation_request,
        KINDS,
    )


_CODE_TOKEN = re.compile(r"(?u)[\w.-]+")


def _identity_codes(text):
    return {
        token.strip(".-_").casefold()
        for token in _CODE_TOKEN.findall(text)
        if any(char.isalpha() for char in token)
        and any(char.isdigit() for char in token)
    }


def _contradicts_named_identity(source, candidate):
    """Reject a claimed relation between different coded objects without alias evidence."""
    source_codes = _identity_codes(source)
    title_codes = _identity_codes(candidate["title"])
    return bool(
        source_codes
        and title_codes
        and source_codes.isdisjoint(title_codes)
        and not matched_identity_candidates(source, [candidate])
    )


def _normalized(value):
    return re.sub(r"\s+", " ", value).strip().casefold()


def _contains_span(text, span):
    value = _normalized(span)
    return (
        bool(value)
        and re.search(r"(?<!\w)" + re.escape(value) + r"(?!\w)", _normalized(text))
        is not None
    )


def _specific_span(value):
    tokens = _CODE_TOKEN.findall(value)
    return bool(
        len(tokens) >= 2
        or any(
            any(char.isalpha() for char in token)
            and any(char.isdigit() for char in token)
            for token in tokens
        )
        or (len(tokens) == 1 and len(tokens[0]) >= 8)
    )


def _grounded_relation(source, candidate, source_subjects, candidate_subjects):
    """Accept only an identity visible in the source and candidate's own text."""
    prose = _outside_code(source)
    candidate_prose = _outside_code(candidate["text"])
    if _normalized(prose) and _normalized(prose) == _normalized(candidate_prose):
        return True
    if _contains_span(prose, candidate["title"]):
        return True
    if _identity_codes(prose) & _identity_codes(candidate["title"]):
        return True
    candidate_text = candidate["title"] + "\n" + candidate["text"]
    for source_span in source_subjects:
        if not _specific_span(source_span) or not _contains_span(prose, source_span):
            continue
        for candidate_span in candidate_subjects:
            if not _contains_span(candidate_text, candidate_span):
                continue
            if _contains_span(source_span, candidate_span) or _contains_span(
                candidate_span, source_span
            ):
                return True
    return False


def build_relation_request(source, candidates, max_links, *, repair_code=None):
    count = len(candidates)
    per_candidate_chars = min(900, 6000 // max(1, count))
    data = {
        "source_note": source,
        "candidates": {
            f"C{index + 1}": {
                "title": candidate["title"],
                "text": candidate["text"][:per_candidate_chars],
            }
            for index, candidate in enumerate(candidates)
        },
    }
    return relation_request(data, repair=repair_code is not None)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def parse_relation_response(raw, source, candidates, max_links):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 40000:
        raise NoteGenerationError(
            "Модель не завершила выбор связанных заметок. Заметка не сохранена."
        )
    try:
        decisions = json.loads(raw, object_pairs_hook=_unique_object)
    except (ValueError, TypeError) as exc:
        raise NoteGenerationError(
            "Модель вернула некорректный выбор связанных заметок."
        ) from exc
    expected = {
        f"C{index + 1}": candidate["title"]
        for index, candidate in enumerate(candidates)
    }
    if (
        not isinstance(decisions, dict)
        or set(decisions) != {"source_subjects", "decisions"}
        or not _valid_subjects(decisions["source_subjects"])
        or not isinstance(decisions["decisions"], dict)
        or set(decisions["decisions"]) != set(expected)
    ):
        raise NoteGenerationError(
            "Модель не проверила все предложенные связи. Заметка не сохранена."
        )
    selected = []
    for index, (key, title) in enumerate(expected.items()):
        decision = decisions["decisions"][key]
        if (
            not isinstance(decision, dict)
            or set(decision) != {"candidate_subjects", "relationship"}
            or not _valid_subjects(decision["candidate_subjects"])
            or not isinstance(decision["relationship"], str)
            or decision["relationship"] not in KINDS
        ):
            raise NoteGenerationError(
                "Модель вернула неверную структуру решения о связи."
            )
        if (
            decision["relationship"] in ("same_subject", "dependency")
            and title not in selected
            and _grounded_relation(
                source,
                candidates[index],
                decisions["source_subjects"],
                decision["candidate_subjects"],
            )
        ):
            selected.append(title)
    # The model classifies every pair independently. The configured edge quota
    # limits publication in retrieval order, without changing any classification.
    return selected[: max(0, max_links)]


def _valid_subjects(value):
    return (
        isinstance(value, list)
        and len(value) <= 10
        and all(isinstance(item, str) and 0 < len(item) <= 300 for item in value)
    )


def select_relations(runtime, source, candidates, max_links):
    if not candidates or max_links <= 0:
        return []
    selected = None
    for attempt in range(2):
        prompt, response_format = build_relation_request(
            source,
            candidates,
            max_links,
            repair_code="invalid_json" if attempt else None,
        )
        try:
            raw = runtime.local_rag_model.select_note_relations(
                prompt,
                response_format=response_format,
                candidate_count=len(candidates),
            )
        except (TimeoutError, ConnectionError, OSError) as exc:
            raise TemporaryModelError(
                "Локальная модель временно недоступна при выборе связей. Заметка не сохранена."
            ) from exc
        except Exception as exc:
            raise NoteGenerationError(
                "Локальная модель не завершила выбор связей. Заметка не сохранена."
            ) from exc
        try:
            selected = parse_relation_response(raw, source, candidates, max_links)
            break
        except NoteGenerationError:
            if attempt or not isinstance(raw, str) or not raw.strip():
                raise
    if selected is None:
        raise AssertionError("Bounded selection loop has no unhandled exit")
    return selected
