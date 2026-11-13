"""Select eligible existing RU/EN labels using the selected relevance scorer."""

from backend.generated_text_language import allowed_generated_text
from backend.note_identity_context import source_language

from .contracts import (
    attempt_summary,
    choose_rows,
    generator_session,
    records_input,
    score_pairs,
    text,
    unchanged_input,
)
from .pair_settings import DEFAULT_PAIRS
from .prompts_tags import RETRY, RETRY_EN, SYSTEM, SYSTEM_EN


TAG_THRESHOLD = 0.8594942808852406
TAG_THRESHOLDS = {
    "tev": TAG_THRESHOLD,
    "mmarco": -4.003677845001221,
    "qwen": 0.43806201333608696,
}
CATALOG_PAGE_SIZE = 25


def tag_text(row):
    """Retain the selected scorer's exact separator, including an empty description."""
    return row["label"] + ": " + row["description"]


def select_tags(services, source, catalog, *, pair=DEFAULT_PAIRS["tags"]):
    text(source)
    with unchanged_input(catalog):
        all_rows = records_input(catalog, catalog=True)
        rows = [row for row in all_rows if allowed_generated_text(row["label"])]
        system, retry = (
            (SYSTEM_EN, RETRY_EN)
            if source_language(source) == "English"
            else (SYSTEM, RETRY)
        )
        attempts, proposed, batches = [], [], 0
        if rows:
            with generator_session(services, pair.generator) as generator:
                for start in range(0, len(rows), CATALOG_PAGE_SIZE):
                    chosen, count = choose_rows(
                        generator,
                        source,
                        rows[start : start + CATALOG_PAGE_SIZE],
                        "tag_ids",
                        system,
                        retry,
                        attempts,
                        catalog=True,
                    )
                    proposed.extend(chosen)
                    batches += count
        known = {row["id"]: row for row in rows}
        scores = score_pairs(
            services,
            pair.scorer_engine("tags"),
            [{"source": source, "target": tag_text(known[key])} for key in proposed],
        )
        tags = [
            known[key]["label"]
            for key, score in zip(proposed, scores, strict=True)
            if score >= pair.threshold("tags", TAG_THRESHOLDS)
        ]
        return {
            "tags": tags,
            "catalog_count": len(all_rows),
            "eligible_catalog_count": len(rows),
            "excluded_language_candidate_count": len(all_rows) - len(rows),
            "candidate_count": len(proposed),
            "score_count": len(scores),
            "batch_count": batches,
            "label_only_catalog_count": sum(
                not row["description"].strip() for row in all_rows
            ),
            **attempt_summary(attempts),
        }
