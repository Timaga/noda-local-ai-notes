"""Exhaustive ranked archive paging, opaque IDs and mMARCO relation filtering."""

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
from .prompts_links import RETRY, RETRY_EN, SYSTEM, SYSTEM_EN
from .retrieval import BATCH_SIZE, Index
from .link_verification import verify_links


LINK_THRESHOLD = 4.500922203063965
LINK_THRESHOLDS = {"mmarco": LINK_THRESHOLD, "qwen": 0.9840936082881853}


def select_links(services, source, records, *, pair=DEFAULT_PAIRS["links"]):
    text(source)
    with unchanged_input(records):
        all_rows = records_input(records, allow_empty_source=True)
        nonempty = [row for row in all_rows if row["source"].strip()]
        rows = [row for row in nonempty if allowed_generated_text(row["id"])]
        system, retry = (
            (SYSTEM_EN, RETRY_EN)
            if source_language(source) == "English"
            else (SYSTEM, RETRY)
        )
        attempts, proposed, batches = [], [], 0
        aliases = {
            row["id"]: f"N{index:06d}"
            for index, row in enumerate(sorted(rows, key=lambda row: row["id"]), 1)
        }
        originals = {aliases[row["id"]]: row for row in rows}
        if rows:
            index = Index(rows)
            ranked = index.rank(source)
            ordered = [
                {
                    "id": aliases[row["id"]],
                    "source": originals[aliases[row["id"]]]["source"],
                }
                for row in ranked
            ]
            with generator_session(services, pair.generator) as generator:
                for start in range(0, len(ordered), BATCH_SIZE):
                    chosen, count = choose_rows(
                        generator,
                        source,
                        ordered[start : start + BATCH_SIZE],
                        "linked_ids",
                        system,
                        retry,
                        attempts,
                    )
                    proposed.extend(chosen)
                    batches += count
        scores = score_pairs(
            services,
            pair.scorer_engine("links"),
            [
                {"source": source, "target": originals[key]["source"]}
                for key in proposed
            ],
            purpose="links",
        )
        accepted = {
            key
            for key, score in zip(proposed, scores, strict=True)
            if score >= pair.threshold("links", LINK_THRESHOLDS)
        }
        rejected = [key for key in originals if key not in accepted]
        reviewed = verify_links(
            services, source,
            [{"id": key, "source": originals[key]["source"]} for key in rejected],
            pair, attempts,
        ) if pair.reranker == "mmarco" else []
        verified = accepted | set(reviewed)
        links = [originals[key]["id"] for key in originals if key in verified]
        return {
            "links": links,
            "retrieval_count": len(all_rows),
            "eligible_retrieval_count": len(rows),
            "excluded_language_candidate_count": len(nonempty) - len(rows),
            "excluded_empty_candidate_count": len(all_rows) - len(nonempty),
            "candidate_count": len(proposed),
            "score_count": len(scores),
            "batch_count": batches,
            "review_candidate_count": len(rejected) if pair.reranker == "mmarco" else 0,
            "review_accepted_count": len(reviewed),
            **getattr(services, "link_score_diagnostics", {}),
            **attempt_summary(attempts),
        }
