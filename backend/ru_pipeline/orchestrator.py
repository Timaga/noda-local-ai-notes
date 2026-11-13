"""Publish the selected local RU/EN metadata stages around an immutable source."""

from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import time
import unicodedata

from backend.note_faithful_archive import assert_unchanged, snapshot_archive
from backend.generated_text_language import allowed_generated_text
from backend.note_generation_contract import (
    NoteGenerationError,
    extract_note_links,
    extract_note_tags,
    normalize_tag,
    resolve_note_title,
)
from backend.note_generation_persistence import persist_note, safe_title
from backend.note_identity_context import source_language
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError
from backend.ru_pipeline.config import PROFILE_ID, SOURCE_VERSION
from backend.ru_pipeline.pair_settings import load_settings


_COUNTS = (
    "attempts",
    "attempt_count",
    "candidate_count",
    "score_count",
    "batch_count",
    "retrieval_count",
    "retry_count",
    "label_only_catalog_count",
    "eligible_catalog_count",
    "eligible_retrieval_count",
    "excluded_language_candidate_count",
    "language_rejection_count",
    "request_attempts",
    "preflight_rejections",
    "excluded_empty_candidate_count",
    "reranker_passage_count",
    "reranker_windowed_pair_count",
    "reranker_boundary_passage_count",
    "review_candidate_count",
    "review_accepted_count",
    "reused_candidate_count",
    "reused_tag_count",
    "novel_candidate_count",
)


def uses_selected_pipeline(runtime, source):
    """Application bootstrap opts in; existing callers without the flag stay legacy."""
    flag = getattr(runtime, "RU_NOTE_PIPELINE_ENABLED", False)
    if type(flag) is not bool:
        raise NoteSystemError(
            "Некорректная настройка русского конвейера.",
            failure_code="ru_configuration_invalid",
        )
    return (
        flag
        and isinstance(source, str)
        and source_language(source) in {"Russian", "English"}
    )


def render_source(source, title, tags, links):
    header = [
        "---",
        "title: " + json.dumps(title, ensure_ascii=False),
        "tags: " + json.dumps(tags, ensure_ascii=False),
        "related: " + json.dumps(links, ensure_ascii=False),
        "noda_source_version: " + json.dumps(SOURCE_VERSION),
        "noda_source_sha256: "
        + json.dumps(hashlib.sha256(source.encode("utf-8")).hexdigest()),
        "noda_source_length: " + str(len(source)),
        "---",
        "",
    ]
    return "\n".join(header) + source


def _catalog(snapshot, descriptions):
    labels = set()
    for record in snapshot:
        for raw in record.tags:
            if normalize_tag(raw) is None:
                raise NoteSystemError(
                    "В архиве найден недопустимый существующий тег.",
                    failure_code="ru_tag_catalog_invalid",
                )
            labels.add(raw)
    return [
        {
            "id": f"T{index:06d}",
            "label": label,
            "description": descriptions.get(label, ""),
        }
        for index, label in enumerate(sorted(labels), start=1)
    ]


def _selection(result, key, allowed):
    values = result.get(key) if type(result) is dict else None
    if (
        type(values) is not list
        or any(type(value) is not str or value not in allowed for value in values)
        or len(set(values)) != len(values)
    ):
        raise NoteModelResponseError(
            "Модель вернула неверный закрытый набор метаданных."
        )
    return list(values)


def _diagnostics(result):
    if (
        type(result) is not dict
        or "attempts" not in result
        or any(
            key in result and (type(result[key]) is not int or result[key] < 0)
            for key in _COUNTS
        )
    ):
        raise NoteSystemError(
            "Этап вернул неверные сведения о выполнении.",
            failure_code="ru_stage_protocol_failed",
        )
    return {
        key: result[key]
        for key in _COUNTS
        if type(result.get(key)) is int and result[key] >= 0
    }


def _authored_links(source, identities):
    result = []
    for raw in extract_note_links(source):
        raw = raw[:-3] if raw.casefold().endswith(".md") else raw
        target = resolve_note_title(raw, identities)
        if target is not None and target not in result:
            result.append(target)
    return result


def _authored_tags(source, labels):
    result = []
    for authored in extract_note_tags(source):
        matches = sorted(label for label in labels if normalize_tag(label) == authored)
        selected = (
            authored
            if authored in labels
            else matches[0] if len(matches) == 1 else None
        )
        if selected is not None and selected not in result:
            result.append(selected)
    return result


def _report_stage(context, stage, state):
    reporter = getattr(context, "report_stage", None)
    if callable(reporter):
        reporter(stage, state)


def _source_title(source, language):
    normalized = unicodedata.normalize("NFC", source)
    first = " ".join(normalized.split())[:28]
    prefix = "".join(char for char in first if allowed_generated_text(char))
    if not any(char.isalnum() for char in prefix):
        return "Заметка" if language == "Russian" else "Note"
    return " ".join(prefix.split()).strip(" .")


def create_ru_note(runtime, source, *, publication_context=None):
    if type(source) is not str or not source.strip():
        raise NoteGenerationError("Нужен непустой исходный текст заметки.")
    from backend.ru_pipeline.config import get_config
    from backend.ru_pipeline.methods import generate_title, select_links, select_tags
    from backend.ru_pipeline.new_tag_stage import create_new_tags
    from backend.ru_pipeline.services import LocalServices

    try:
        config = get_config(runtime)
        pairs, new_tags, enabled, _ = load_settings(config.runtime_dir)
    except (ValueError, TypeError, OSError, RecursionError) as exc:
        raise NoteSystemError(
            "Не удалось прочитать настройки русского конвейера.",
            failure_code="ru_configuration_invalid",
        ) from exc
    started = time.perf_counter()
    with runtime.NOTE_GENERATION_LOCK:
        full_snapshot = snapshot_archive(runtime.NOTES_DIR)
        excluded = getattr(publication_context, "excluded_note_identity", None)
        if excluded is not None and (
            type(excluded) is not str
            or excluded not in {record.id for record in full_snapshot}
        ):
            raise NoteSystemError(
                "Неверная исходная заметка повторной обработки.",
                failure_code="publication_failed",
            )
        snapshot = tuple(record for record in full_snapshot if record.id != excluded)
        factory = getattr(runtime, "ru_pipeline_services_factory", LocalServices)
        uses_models = any(enabled.values())
        skipped_stages = [stage for stage, active in enabled.items() if not active]
        if uses_models and not callable(factory):
            raise NoteSystemError(
                "Русский конвейер недоступен.", failure_code="ru_configuration_invalid"
            )
        diagnostics, tags, links, catalog = {}, [], [], []
        language = source_language(source)
        title_language = language
        title_strategy = "source-prefix-v1"
        link_transport = None
        relation_seconds = 0
        with (factory(config) if uses_models else nullcontext()) as services:
            if enabled["title"]:
                _report_stage(publication_context, "title", "running")
                title_result = generate_title(services, source, pair=pairs["title"])
                headline = title_result.get("title") if type(title_result) is dict else None
                if type(headline) is not str or not headline.strip():
                    raise NoteModelResponseError("Модель не вернула корректный заголовок.")
                diagnostics["title"] = _diagnostics(title_result)
                title_language = title_result.get("language", language)
                title_strategy = pairs["title"].id.replace("_", "-") + "-v1"
                _report_stage(publication_context, "title", "completed")
            else:
                headline = _source_title(source, language)
                _report_stage(publication_context, "title", "skipped")
            if enabled["tags"]:
                _report_stage(publication_context, "tags", "running")
                catalog = _catalog(full_snapshot, config.tag_descriptions)
                eligible_labels = {row["label"] for row in catalog if allowed_generated_text(row["label"])}
                tag_result = select_tags(services, source, catalog, pair=pairs["tags"])
                tags = _selection(tag_result, "tags", eligible_labels)
                tags = list(dict.fromkeys(tags + _authored_tags(source, eligible_labels)))
                diagnostics["tags"] = _diagnostics(tag_result)
                if new_tags.enabled:
                    created = create_new_tags(services, source, catalog, tags, pair=new_tags.pair)
                    tags = list(dict.fromkeys(tags + created.get("reused_tags", []) + created["tags"]))
                    diagnostics["new_tags"] = _diagnostics(created)
                _report_stage(publication_context, "tags", "completed")
            else:
                _report_stage(publication_context, "tags", "skipped")
            if enabled["links"]:
                _report_stage(publication_context, "links", "running")
                relation_started = time.perf_counter()
                eligible_identities = {record.id for record in snapshot if allowed_generated_text(record.id)}
                link_result = select_links(
                    services, source,
                    [{"id": record.id, "source": record.source} for record in snapshot],
                    pair=pairs["links"],
                )
                links = _selection(link_result, "links", eligible_identities)
                links = list(dict.fromkeys(links + _authored_links(source, eligible_identities)))
                relation_seconds = time.perf_counter() - relation_started
                diagnostics["links"] = _diagnostics(link_result)
                link_transport = link_result.get("scoring_transport_version", "full-pairs-v1")
            else:
                _report_stage(publication_context, "links", "skipped")
        assert_unchanged(full_snapshot, runtime.NOTES_DIR)
        if enabled["links"]:
            _report_stage(publication_context, "links", "completed")
        used_pairs = {
            stage: new_tags.pair if stage == "new_tags" else pairs[stage]
            for stage in diagnostics
        }
        root = Path(runtime.NOTES_DIR).resolve()
        paths = {
            record.id: Path(record.filepath).relative_to(root).as_posix()
            for record in snapshot
        }
        modified = sum(record.source_modified for record in snapshot)
        draft = {
            "title": safe_title(headline),
            "generated_title": headline,
            "display_title": headline,
            "content": render_source(source, headline, tags, links),
            "tags": tags,
            "links": links,
            "source": "local",
            "model": "; ".join(pair.label for pair in used_pairs.values()),
            "warnings": (
                ["В архиве есть изменённые заметки; учтён их текущий полный текст."]
                if modified
                else []
            ),
            "mode": "organize",
            "processing_version": SOURCE_VERSION,
            "generation": {
                "profile": PROFILE_ID,
                "metadata_policy_version": "task-metadata-v2",
                "organize_strategy": "ru-three-stage",
                "stage_order": list(diagnostics),
                "stage_pairs": {stage: pair.id for stage, pair in used_pairs.items()},
                **({"skipped_stages": skipped_stages} if skipped_stages else {}),
                "link_scoring_transport": link_transport,
                "output_language": language,
                "title_language": title_language,
                "generated_alphabet_policy": "ru-en-only-v1",
                "stages": diagnostics,
                "title_generation_strategy": title_strategy,
                "title_generation_stages": 4 if enabled["title"] else 0,
                "title_model_call_count": diagnostics.get("title", {}).get("attempts", 0),
                "candidate_count": len(snapshot),
                "tag_catalog_count": len(catalog),
                "archive_modified_source_count": modified,
                "relation_candidate_count": len(snapshot) if enabled["links"] else 0,
                "selected_related_count": len(links),
                "relation_duration_ms": round(relation_seconds * 1000),
                "model_duration_ms": round((time.perf_counter() - started) * 1000),
                "editor_repair_count": sum(
                    stage.get("retry_count", 0) for stage in diagnostics.values()
                ),
                "editing_applied": None,
                "editing_attempts": 0,
                "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                "source_length": len(source),
                "context_budget_checked": True,
                "image_understanding": False,
            },
        }
        return persist_note(
            runtime,
            draft,
            publication_context=publication_context,
            related_paths=[paths[target] for target in links],
            started=started,
        )
