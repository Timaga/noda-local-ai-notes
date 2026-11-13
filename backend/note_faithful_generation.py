"""Lossless organization with exhaustive, independent archive decisions."""

import hashlib
import json
from pathlib import Path
import time

try:
    from backend.note_faithful_archive import snapshot_archive, assert_unchanged
    from backend.note_faithful_model import decide_pair
    from backend.note_title_review import generate_title
    from backend.note_title_method import generate_selected_title
    from backend.note_generation_contract import NoteGenerationError
    from backend.note_generation_persistence import persist_note, safe_title
except ImportError:
    from note_faithful_archive import snapshot_archive, assert_unchanged
    from note_faithful_model import decide_pair
    from note_title_review import generate_title
    from note_title_method import generate_selected_title
    from note_generation_contract import NoteGenerationError
    from note_generation_persistence import persist_note, safe_title


VERSION = "faithful-v1"


def render_source(source, title, links):
    """Keep the exact source after a metadata-only, verifiable prefix."""
    metadata = [
        "---",
        "title: " + json.dumps(title, ensure_ascii=False),
        "tags: []",
        "related: " + json.dumps(links, ensure_ascii=False),
        'noda_source_version: "' + VERSION + '"',
        "noda_source_sha256: "
        + json.dumps(hashlib.sha256(source.encode("utf-8")).hexdigest()),
        "noda_source_length: " + str(len(source)),
        "---",
        "",
    ]
    return "\n".join(metadata) + source


def create_faithful_note(runtime, source, *, publication_context=None):
    if not isinstance(source, str) or not source.strip():
        raise NoteGenerationError("Нужен непустой исходный текст заметки.")
    started = time.perf_counter()
    with runtime.NOTE_GENERATION_LOCK:
        snapshot = snapshot_archive(runtime.NOTES_DIR)
        modified_sources = sum(record.source_modified for record in snapshot)
        method, title_result = generate_selected_title(
            runtime, source, reviewed=generate_title
        )
        headline = title_result["title"]
        title = safe_title(headline)
        relation_started = time.perf_counter()
        decisions = []
        links = []
        related_paths = []
        for candidate in snapshot:
            result = decide_pair(runtime, source, candidate)
            decisions.append({"id": candidate.id, **result})
            if result["useful"]:
                links.append(candidate.id)
                related_paths.append(
                    Path(candidate.filepath)
                    .relative_to(Path(runtime.NOTES_DIR).resolve())
                    .as_posix()
                )
        relation_seconds = time.perf_counter() - relation_started
        assert_unchanged(snapshot, runtime.NOTES_DIR)
        model = runtime.local_rag_model
        draft = {
            "title": title,
            "generated_title": headline,
            "display_title": headline,
            "content": render_source(source, headline, links),
            "tags": [],
            "source": "local",
            "links": links,
            "model": str(getattr(model, "name", None) or "local"),
            "warnings": (
                ["В архиве есть изменённые заметки; учтён их текущий полный текст."]
                if modified_sources
                else []
            ),
            "mode": "organize",
            "processing_version": VERSION,
            "generation": {
                "organize_strategy": "faithful",
                "title_generation_strategy": method.strategy,
                "title_generation_stages": method.stages,
                "title_model_call_count": title_result["attempts"],
                "candidate_count": len(snapshot),
                "archive_modified_source_count": modified_sources,
                "relation_candidate_count": len(decisions),
                "selected_related_count": len(links),
                "relation_duration_ms": round(relation_seconds * 1000),
                "model_duration_ms": round((time.perf_counter() - started) * 1000),
                "editor_repair_count": title_result["attempts"]
                - method.stages
                + sum(item["attempts"] - 1 for item in decisions),
                "editing_applied": None,
                "editing_attempts": 0,
                "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                "source_length": len(source),
                "context_budget_checked": True,
                "image_understanding": False,
            },
        }
        # Evidence is deliberately not persisted: archive quotations can be private.
        return persist_note(
            runtime,
            draft,
            publication_context=publication_context,
            related_paths=related_paths,
            started=started,
        )
