"""Require an evidence decision for every candidate in bounded complete batches."""

import json

from backend.inference_runner import ContextBudgetError
from .contracts import SAMPLING, complete_json, generator_session, system_error
from .link_verification import _format, decode_evidence, quote_choices, verify_pair


def decode_batch(raw, source, rows):
    def unique(pairs):
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ValueError("Duplicate candidate decision")
        return result

    values = json.loads(raw, object_pairs_hook=unique)
    if type(values) is not dict or set(values) != {row["id"] for row in rows}:
        raise ValueError("Every candidate requires exactly one decision")
    return [
        row["id"]
        for row in rows
        if decode_evidence(
            json.dumps(values[row["id"]], ensure_ascii=False), source, row["source"]
        )
    ]


def verify_batches(services, source, rows, pair, attempts, system):
    accepted = []
    with generator_session(services, pair.generator) as generator:

        def review(batch):
            payload = {
                "relation_review": True,
                "source_note": source,
                "allowed_source_quotes": quote_choices(source),
                "candidate_notes": [
                    {**row, "allowed_target_quotes": quote_choices(row["source"])}
                    for row in batch
                ],
            }
            schema = {
                "type": "object",
                "additionalProperties": False,
                "required": [row["id"] for row in batch],
                "properties": {
                    row["id"]: _format(source, row["source"])["json_schema"]["schema"]
                    for row in batch
                },
            }
            instruction = (
                system
                + " Review EVERY candidate independently. Return one JSON object keyed by every candidate ID, each containing relation, source_quote, target_quote. Do not omit rejected candidates: use none and empty quotes for them. Select quotes verbatim from the allowed lists."
            )
            try:
                return complete_json(
                    generator,
                    lambda retry: [
                        {
                            "role": "system",
                            "content": instruction
                            + (
                                " Correct the exact JSON keys and literal quotes."
                                if retry
                                else ""
                            ),
                        },
                        {
                            "role": "user",
                            "content": json.dumps(payload, ensure_ascii=False),
                        },
                    ],
                    lambda raw: decode_batch(raw, source, batch),
                    {
                        **SAMPLING,
                        "max_new_tokens": 2048,
                        "response_format": {
                            "type": "json_schema",
                            "json_schema": {
                                "name": "candidate_evidence",
                                "strict": True,
                                "schema": schema,
                            },
                        },
                    },
                    attempts,
                    stage="links:evidence",
                )
            except ContextBudgetError as error:
                if len(batch) == 1:
                    raise system_error(
                        "Полная пара не помещается в контекст проверки связей.",
                        "context_budget_exceeded",
                    ) from error
                middle = len(batch) // 2
                return review(batch[:middle]) + review(batch[middle:])

        for offset in range(0, len(rows), 4):
            batch = rows[offset : offset + 4]
            by_id = {row["id"]: row for row in batch}
            for identifier in review(batch):
                if verify_pair(
                    generator,
                    source,
                    by_id[identifier]["source"],
                    attempts,
                    system,
                    confirmation=True,
                ):
                    accepted.append(identifier)
    return accepted
