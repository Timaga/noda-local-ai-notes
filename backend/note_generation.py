"""Validated model-driven note creation with atomic, non-overwriting persistence."""

from pathlib import Path
import logging
import time

try:
    from backend.generated_text_language import GeneratedLanguageError
    from backend.note_faithful_generation import create_faithful_note
    from backend.note_generation_persistence import (
        persist_note,
        safe_title,
        save_new_note,
    )
except ImportError:
    from generated_text_language import GeneratedLanguageError
    from note_faithful_generation import create_faithful_note
    from note_generation_persistence import persist_note, safe_title, save_new_note

try:
    from backend.note_generation_contract import (
        NoteGenerationError,
        protect_source,
        render_body,
    )
    from backend.note_generation_retrieval import (
        relation_candidates,
        retrieve_candidates,
        source_references,
    )
    from backend.note_editor import edit_note
    from backend.note_source_metadata import generate_source_metadata
    from backend.note_metadata import enrich_metadata_tags, metadata_prompt
    from backend.note_relations import select_relations
    from backend.semantic_embedding import EmbeddingUnavailable
    from backend.note_tag_completion import complete_tags
    from backend.note_tag_audit import audit_note_tags
    from backend.note_title_coverage import refine_title_coverage
    from backend.note_title_collision import (
        disambiguate_title_collision,
        title_collides,
    )
    from backend.note_title_quality import polish_title_quality
    from backend.note_title_grammar import polish_title_grammar
    from backend.note_title_state_guard import preserve_title_state
    from backend.note_processing_mode import (
        ORGANIZE_EDIT,
        PROCESSING_VERSION,
        validate_mode,
    )
    from backend.note_body_edit import edit_body
except ImportError:
    from note_generation_contract import (
        NoteGenerationError,
        protect_source,
        render_body,
    )
    from note_generation_retrieval import (
        relation_candidates,
        retrieve_candidates,
        source_references,
    )
    from note_editor import edit_note
    from note_source_metadata import generate_source_metadata
    from note_metadata import enrich_metadata_tags, metadata_prompt
    from note_relations import select_relations
    from semantic_embedding import EmbeddingUnavailable
    from note_tag_completion import complete_tags
    from note_tag_audit import audit_note_tags
    from note_title_coverage import refine_title_coverage
    from note_title_collision import disambiguate_title_collision, title_collides
    from note_title_quality import polish_title_quality
    from note_title_grammar import polish_title_grammar
    from note_title_state_guard import preserve_title_state
    from note_processing_mode import ORGANIZE_EDIT, PROCESSING_VERSION, validate_mode
    from note_body_edit import edit_body


def create_note(
    runtime,
    prompt,
    *,
    publication_context=None,
    mode="organize",
    organize_strategy="faithful",
):
    """Retry a rejected generated alphabet once before returning a typed failure."""
    for attempt in range(2):
        try:
            result = _create_note_once(
                runtime,
                prompt,
                publication_context=publication_context,
                mode=mode,
                organize_strategy=organize_strategy,
            )
        except GeneratedLanguageError:
            if attempt:
                raise
            logging.getLogger(__name__).warning(
                "Generated note alphabet rejected; retrying unchanged source once"
            )
            continue
        result.setdefault("generation", {})["language_retry_count"] = attempt
        return result
    raise AssertionError("Bounded language retry has no unhandled exit")


def _create_note_once(
    runtime,
    prompt,
    *,
    publication_context=None,
    mode="organize",
    organize_strategy="faithful",
):
    mode = validate_mode(mode)
    if organize_strategy == "faithful":
        if mode == "organize":
            from backend.ru_pipeline.orchestrator import (
                create_ru_note,
                uses_selected_pipeline,
            )

            if uses_selected_pipeline(runtime, prompt):
                return create_ru_note(
                    runtime, prompt, publication_context=publication_context
                )
            return create_faithful_note(
                runtime, prompt, publication_context=publication_context
            )
        organize_strategy = "current"
    if organize_strategy not in {"current", "simple", "source_only"}:
        raise ValueError("Unknown organize strategy")
    if organize_strategy != "current" and mode != "organize":
        raise ValueError("Experimental strategy is only available for organize")
    started = time.perf_counter()
    with runtime.NOTE_GENERATION_LOCK:
        runtime._reload_notes_cache(reason="/generate context", skip_index=True)
        authored_links = source_references(runtime, prompt)
        protected_source, assets = protect_source(prompt, authored_links)
        max_tags = max(0, min(int(runtime.MAX_TAGS), 10))
        max_links = max(0, min(int(runtime.MAX_LINKS), 15))
        # Candidate count is a resource bound, not a semantic acceptance threshold.
        limit = max(
            1, min(max(int(runtime.RAG_CONTEXT_LIMIT), len(authored_links)), 20)
        )
        try:
            candidate_pool = retrieve_candidates(runtime, prompt, limit)
        except EmbeddingUnavailable as exc:
            raise NoteGenerationError(str(exc)) from exc
        authored_titles = {item["target"] for item in authored_links}
        relation_pool = relation_candidates(prompt, candidate_pool, authored_links)
        relation_started = time.perf_counter()
        selected_links = select_relations(runtime, prompt, relation_pool, max_links)
        relation_seconds = time.perf_counter() - relation_started
        accepted_titles = authored_titles | set(selected_links)
        candidates = [
            item for item in candidate_pool if item["title"] in accepted_titles
        ]
        with runtime._notes_cache_lock:
            identity_snapshot = {
                title: dict(note) for title, note in runtime.notes_data.items()
            }
        identity_candidates = []
        for title, note in (
            identity_snapshot.items() if organize_strategy != "source_only" else []
        ):
            identity_candidates.append(
                {
                    "title": title,
                    "tags": list(note.get("tags") or [])[:10],
                    "text": runtime._clean_note_text_for_rag(note.get("content") or "")[
                        :900
                    ],
                }
            )
        model_started = time.perf_counter()
        if organize_strategy == "source_only":
            contract, model_name, editor_repairs = generate_source_metadata(
                runtime, prompt, max_tags, authored_links
            )
        else:
            model_prompt = metadata_prompt(
                prompt,
                candidates,
                max_tags,
                identity_candidates=identity_candidates,
            )
            contract, model_name, editor_repairs = edit_note(
                runtime,
                model_prompt,
                protected_source,
                candidates,
                assets,
                max_tags,
                max_links,
                authored_links,
            )
        occupied_titles = set(identity_snapshot)
        if organize_strategy == "current":
            contract["title"] = refine_title_coverage(
                runtime, prompt, contract["title"]
            )
            contract["title"] = preserve_title_state(runtime, prompt, contract["title"])
            contract["title"] = disambiguate_title_collision(
                runtime, prompt, contract["title"], occupied_titles
            )
            collision_safe_title = contract["title"]
            contract["title"] = polish_title_quality(runtime, prompt, contract["title"])
            contract["title"] = polish_title_grammar(runtime, prompt, contract["title"])
            if title_collides(
                contract["title"], occupied_titles
            ) and not title_collides(collision_safe_title, occupied_titles):
                contract["title"] = collision_safe_title
            contract["tags"] = complete_tags(
                runtime,
                prompt,
                contract["title"],
                contract["tags"],
                max_tags,
            )
        elif organize_strategy == "simple":
            contract["title"] = disambiguate_title_collision(
                runtime, prompt, contract["title"], occupied_titles
            )
        if organize_strategy != "source_only":
            contract["tags"] = enrich_metadata_tags(
                prompt,
                contract["title"],
                contract["tags"],
                identity_candidates,
                max_tags,
            )
        if organize_strategy == "current":
            contract["tags"], _, _ = audit_note_tags(
                runtime,
                prompt,
                contract["title"],
                contract["tags"],
                identity_candidates,
            )
        model_seconds = time.perf_counter() - model_started
        contract["links"] = list(dict.fromkeys(selected_links + contract["links"]))
        editing_applied = None
        editing_attempts = 0
        if mode == ORGANIZE_EDIT:
            contract["body"], editing_applied, editing_attempts = edit_body(
                runtime, prompt, authored_links
            )
        runtime._reload_notes_cache(reason="/generate verify links", skip_index=True)
        with runtime._notes_cache_lock:
            active = {title: dict(note) for title, note in runtime.notes_data.items()}
        root = Path(runtime.NOTES_DIR).resolve()
        related_paths = []
        for target in contract["links"]:
            entry = active.get(target)
            target_path = Path(
                (entry or {}).get("filepath") or root / f"{target}.md"
            ).resolve()
            if (
                entry is None
                or root not in target_path.parents
                or not target_path.is_file()
            ):
                raise NoteGenerationError(
                    "Связанная заметка изменилась или удалена во время генерации. Повторите запрос."
                )
            related_paths.append(target_path.relative_to(root).as_posix())
        body = render_body(contract)
        draft = {
            "title": contract["title"],
            "content": body,
            "tags": contract["tags"],
            "source": "local",
            "links": contract["links"],
            "model": model_name,
            "warnings": (
                ["Редактура не применена; сохранён исходный текст."]
                if editing_applied is False
                else []
            ),
            "mode": mode,
            "processing_version": PROCESSING_VERSION,
            "generation": {
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "model_duration_ms": round(model_seconds * 1000),
                "editor_repair_count": editor_repairs,
                "editing_applied": editing_applied,
                "editing_attempts": editing_attempts,
                "organize_strategy": organize_strategy,
                "candidate_count": len(candidate_pool),
                "relation_candidate_count": len(relation_pool),
                "relation_duration_ms": round(relation_seconds * 1000),
                "selected_related_count": len(selected_links),
                "attachment_count": sum(
                    marker.startswith("<NODA_ASSET_") for marker in assets
                ),
                "image_understanding": False,
                **(
                    {
                        "metadata_evidence": contract["metadata_evidence"],
                        "metadata_validation": contract["metadata_validation"],
                    }
                    if organize_strategy == "source_only"
                    else {}
                ),
            },
        }
        return persist_note(
            runtime,
            draft,
            publication_context=publication_context,
            related_paths=related_paths,
            started=started,
        )
