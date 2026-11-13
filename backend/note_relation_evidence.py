"""Request-local text units and strict relation/verifier response contracts."""

import json

try:
    from backend.note_generation_contract import NoteGenerationError
except ImportError:
    from note_generation_contract import NoteGenerationError


UNIT_CHARS = 300
POSITIVE_BASES = ("same_entity", "explicit_dependency")
SELECTION_BASES = POSITIVE_BASES + (
    "different_entities",
    "topic_only",
    "unestablished",
)
VERIFICATION_BASES = POSITIVE_BASES + ("unsupported", "uncertain")


class RelationContractError(NoteGenerationError):
    """A safe structural/ID failure, eligible for a shared bounded repair."""

    def __init__(self, code):
        super().__init__(
            "Модель вернула неподтверждённый выбор связей. Заметка не сохранена."
        )
        self.code = code


def text_units(text, prefix):
    """Number fixed-size Unicode slices; their concatenation is exactly the input."""
    return {
        f"{prefix}{index + 1}": text[offset : offset + UNIT_CHARS]
        for index, offset in enumerate(range(0, len(text), UNIT_CHARS))
    }


def evidence_payload(source, candidates):
    per_candidate_chars = min(900, 6000 // max(1, len(candidates)))
    return {
        "stage": "selection",
        "source_units": text_units(source, "S"),
        "candidates": {
            f"C{index + 1}": {
                "title": candidate["title"],
                "units": {
                    **text_units(candidate["title"], f"C{index + 1}T"),
                    **text_units(
                        candidate["text"][:per_candidate_chars], f"C{index + 1}U"
                    ),
                },
            }
            for index, candidate in enumerate(candidates)
        },
    }


def _id_array(ids):
    return {
        "type": "array",
        "items": {"type": "string", "enum": list(ids)} if ids else {"type": "string"},
        "maxItems": 2 if ids else 0,
    }


def selection_format(payload):
    decisions = {}
    for key, candidate in payload["candidates"].items():
        decisions[key] = {
            "type": "object",
            "additionalProperties": False,
            "required": ["comparison", "source_units", "candidate_units", "basis"],
            "properties": {
                "comparison": {"type": "string"},
                "source_units": _id_array(payload["source_units"]),
                "candidate_units": _id_array(candidate["units"]),
                "basis": {"type": "string", "enum": list(SELECTION_BASES)},
            },
        }
    return _response_format(decisions)


def verification_payload(payload, selected_ids):
    """Provide all available text again; never expose the first decision or basis."""
    return {
        "stage": "verification",
        "source_units": dict(payload["source_units"]),
        "candidates": {
            key: {"title": value["title"], "units": dict(value["units"])}
            for key, value in payload["candidates"].items()
            if key in selected_ids
        },
    }


def verification_format(payload):
    return _response_format(
        {
            key: {
                "type": "object",
                "additionalProperties": False,
                "required": ["comparison", "basis"],
                "properties": {
                    "comparison": {"type": "string"},
                    "basis": {"type": "string", "enum": list(VERIFICATION_BASES)},
                },
            }
            for key in payload["candidates"]
        }
    )


def _response_format(properties):
    return {
        "type": "json_object",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": list(properties),
            "properties": properties,
        },
    }


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _load_response(raw, payload):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 40000:
        raise NoteGenerationError(
            "Модель не завершила выбор связанных заметок. Заметка не сохранена."
        )
    try:
        result = json.loads(raw, object_pairs_hook=_unique_object)
    except (TypeError, ValueError, RecursionError) as exc:
        raise RelationContractError("invalid_json") from exc
    if not isinstance(result, dict) or set(result) != set(payload["candidates"]):
        raise RelationContractError("candidate_ids")
    return result


def _validate_ids(ids, available):
    if (
        not isinstance(ids, list)
        or len(ids) > 2
        or any(not isinstance(item, str) for item in ids)
    ):
        raise RelationContractError("evidence_id_shape")
    if any(item not in available for item in ids):
        raise RelationContractError("evidence_id_membership")


def parse_selection(raw, payload, max_links):
    result = _load_response(raw, payload)
    selected = []
    for key, candidate in payload["candidates"].items():
        decision = result[key]
        if not isinstance(decision, dict) or set(decision) - {"comparison"} != {
            "source_units",
            "candidate_units",
            "basis",
        }:
            raise RelationContractError("decision_fields")
        _validate_comparison(decision)
        basis = decision["basis"]
        if not isinstance(basis, str) or basis not in SELECTION_BASES:
            raise RelationContractError("selection_basis")
        _validate_ids(decision["source_units"], payload["source_units"])
        _validate_ids(decision["candidate_units"], candidate["units"])
        if basis in POSITIVE_BASES:
            if not decision["source_units"] or not decision["candidate_units"]:
                raise RelationContractError("missing_positive_evidence")
            selected.append(key)
    if len({payload["candidates"][key]["title"] for key in selected}) > max_links:
        raise RelationContractError("selection_limit")
    return selected


def _validate_comparison(decision):
    if "comparison" in decision and (
        not isinstance(decision["comparison"], str)
        or len(decision["comparison"]) > 2000
    ):
        raise RelationContractError("comparison_shape")


def parse_verification(raw, payload):
    result = _load_response(raw, payload)
    for key, value in result.items():
        if isinstance(value, dict):
            if set(value) != {"comparison", "basis"}:
                raise RelationContractError("verification_fields")
            _validate_comparison(value)
            result[key] = value["basis"]
    if any(
        not isinstance(value, str) or value not in VERIFICATION_BASES
        for value in result.values()
    ):
        raise RelationContractError("verification_basis")
    return result
