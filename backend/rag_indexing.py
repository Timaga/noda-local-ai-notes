"""Chunk-based Qdrant indexing orchestration for the local notes runtime."""

import os
import time

try:
    from backend.rag_chunks import build_note_chunks, note_chunk_point_id
    from backend.rag_lexical import LEXICAL_VECTOR_VERSION, lexical_sparse_vector
except Exception:
    from rag_chunks import build_note_chunks, note_chunk_point_id  # type: ignore
    from rag_lexical import LEXICAL_VECTOR_VERSION, lexical_sparse_vector  # type: ignore


def _timestamp(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


# Who: Tim Buglaev
# When: 2026-06-22
# What: Convert one note into clean section records while keeping exact answer evidence
#       separate from embedding metadata and preserving parent-note deletion identity.
def prepare_note_records(runtime, title, data, vector_size):
    item = dict(data or {})
    content = item.get("content") or ""
    cleaner = runtime.get("_clean_note_text_for_rag")
    clean_content = cleaner(content) if callable(cleaner) else content
    filename = item.get("filename") or f"{title}.md"
    filepath = item.get("filepath") or item.get("path")
    note_id = item.get("id") or runtime["_note_identifier"](title, filename, filepath)
    reporter = runtime.get("_rag_note_noise_report")
    if callable(reporter):
        report = reporter(title, content, tags=item.get("tags"), clean_text=clean_content)
        if report.get("excluded"):
            return str(note_id), [], report

    card_reader = runtime.get("_extract_note_service_card")
    service_text = item.get("service_card_content") or content
    card = card_reader(title, service_text, tags=item.get("tags")) if callable(card_reader) else {}
    chunks = build_note_chunks(
        title,
        content,
        tags=item.get("tags"),
        aliases=(card or {}).get("aliases"),
        summary=(card or {}).get("summary") or "",
        concepts=(card or {}).get("concepts"),
        cleaner=cleaner,
    )
    records = []
    for chunk in chunks:
        point_id = note_chunk_point_id(note_id, chunk["chunk_index"])
        vector = runtime["generate_embedding"](chunk["embedding_text"], vector_size)
        snippet = runtime["_normalize_snippet_text"](chunk["text"])
        metadata = {
            "record_type": "note_chunk",
            "title": title,
            "text": chunk["text"],
            "tags": list(item.get("tags") or []),
            "filename": filename,
            "filepath": filepath,
            "note_id": str(note_id),
            "chunk_id": point_id,
            "chunk_index": chunk["chunk_index"],
            "chunk_count": len(chunks),
            "chunk_digest": chunk["digest"],
            "heading": chunk["heading"],
            "timestamp": _timestamp(item.get("timestamp")),
            "snippet": snippet,
            "links": runtime["_extract_links_from_content"](content),
        }
        digest = runtime["_note_payload_digest"](
            f"{LEXICAL_VECTOR_VERSION}\n{chunk['embedding_text']}",
            item.get("tags"),
            filename,
            filepath,
            metadata["timestamp"],
            vector,
            snippet=snippet,
        )
        records.append((point_id, vector, metadata, digest))
    return str(note_id), records, None


def _flush(service, pending, index_state):
    if not pending:
        return 0
    service.upsert_notes(
        [
            (
                point_id,
                vector,
                metadata,
                lexical_sparse_vector(
                    "\n".join(
                        str(value or "")
                        for value in (
                            metadata.get("title"),
                            metadata.get("heading"),
                            metadata.get("text"),
                            " ".join(metadata.get("tags") or []),
                        )
                    )
                ),
            )
            for point_id, vector, metadata, _ in pending
        ]
    )
    committed_at = time.time()
    for point_id, _, _, digest in pending:
        index_state[point_id] = {"digest": digest, "ts": committed_at}
    count = len(pending)
    pending.clear()
    return count


# Who: Tim Buglaev
# When: 2026-06-22
# What: Batch chunk upserts with post-commit idempotency state and remove stale tail
#       fragments only after replacement records are committed, avoiding partial-index loss.
def index_note_chunks(runtime, notes_dict):
    logger = runtime["logger"]
    if not runtime["_qdrant_enabled"]():
        return False
    batch_size = runtime["_safe_int"](os.environ.get("QDRANT_UPSERT_BATCH_SIZE"), 128) or 128
    batch_size = max(1, min(batch_size, 2048))
    pending = []
    active_by_note = {}
    excluded = []
    indexed_count = 0
    try:
        vector_size = runtime["_get_vector_size"]()
        for title, data in (notes_dict or {}).items():
            note_id, records, noise_report = prepare_note_records(runtime, title, data, vector_size)
            active_by_note[note_id] = {record[0] for record in records}
            if noise_report:
                excluded.append(note_id)
                logger.warning(
                    "Skipping noisy note title=%s reasons=%s",
                    title,
                    ",".join(noise_report.get("reasons") or []),
                )
                continue
            for record in records:
                point_id, _, _, digest = record
                if (runtime["_qdrant_index_state"].get(point_id) or {}).get("digest") == digest:
                    continue
                pending.append(record)
                if len(pending) >= batch_size:
                    indexed_count += _flush(runtime["qdrant_service"], pending, runtime["_qdrant_index_state"])
        indexed_count += _flush(runtime["qdrant_service"], pending, runtime["_qdrant_index_state"])

        stale_ids = []
        chunk_state = runtime["_qdrant_note_chunk_ids"]
        for note_id, active_ids in active_by_note.items():
            stale_ids.extend(set(chunk_state.get(note_id) or set()) - active_ids)
        if stale_ids:
            runtime["qdrant_service"].delete_notes(stale_ids)
            for point_id in stale_ids:
                runtime["_qdrant_index_state"].pop(str(point_id), None)
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Publish active chunk state only after stale deletion succeeds so a transient
        #       delete failure remains retryable instead of silently orphaning old fragments.
        for note_id, active_ids in active_by_note.items():
            chunk_state[note_id] = set(active_ids)
        if excluded:
            runtime["_delete_notes_in_qdrant"](excluded)
        logger.info("Notes chunks indexed in Qdrant: %d records", indexed_count)
        return True
    except Exception as exc:
        logger.warning("Qdrant chunk indexing failed: %s", exc)
        return False
