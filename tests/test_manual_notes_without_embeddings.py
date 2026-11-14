"""Manual Markdown persistence must work independently of semantic indexing."""

from types import SimpleNamespace
import sys

import pytest


def test_semantic_loader_uses_local_data_without_model_supplied_code(app_client, monkeypatch):
    import app as runtime

    calls = []
    model = SimpleNamespace(get_sentence_embedding_dimension=lambda: 3)

    def constructor(model_id, **options):
        calls.append((model_id, options))
        return model

    monkeypatch.delenv("NODA_SEMANTIC_SEARCH_ENABLED", raising=False)
    monkeypatch.setitem(sys.modules, "sentence_transformers", SimpleNamespace(SentenceTransformer=constructor))
    monkeypatch.setattr(runtime, "_embedding_model", None)
    monkeypatch.setattr(runtime, "_embedding_model_id", lambda: "synthetic-search-model")
    monkeypatch.setattr(runtime, "_record_embedding_dim", lambda _value: None)
    assert runtime._load_embedding_model() is model
    assert calls == [("synthetic-search-model", {"local_files_only": True, "trust_remote_code": False})]


@pytest.mark.parametrize(
    ("semantic_enabled", "qdrant_available", "expected_status"),
    [("0", False, "disabled"), ("0", True, "disabled"), ("1", True, "unavailable")],
)
def test_manual_note_create_edit_search_and_restore_without_embedding_model(
    app_client,
    monkeypatch,
    temp_notes_dir,
    semantic_enabled,
    qdrant_available,
    expected_status,
):
    import app as runtime

    upserts = []
    monkeypatch.setenv("NODA_SEMANTIC_SEARCH_ENABLED", semantic_enabled)
    monkeypatch.setattr(runtime, "_embedding_model", None)
    monkeypatch.setattr(runtime, "_load_embedding_model", lambda: None)
    monkeypatch.setattr(runtime, "_get_vector_size", lambda: 3)
    monkeypatch.setattr(runtime, "_qdrant_enabled", lambda: qdrant_available)
    monkeypatch.setattr(
        runtime,
        "qdrant_service",
        SimpleNamespace(
            collection_name="synthetic-offline-library",
            upsert_notes=lambda records: upserts.extend(records),
            delete_notes=lambda ids: None,
        ),
    )
    source = "# Manual note\n\nIndented  \n    code\n"
    path = temp_notes_dir / "Offline manual.md"

    created = app_client.post(
        "/notes",
        json={
            "title": "Offline manual",
            "content": source,
            "tags": [],
        },
    )
    assert created.status_code == 201
    assert created.get_json()["note"]["indexed"] is False
    assert path.read_bytes() == source.encode()
    assert runtime.notes_data["Offline manual"]["content"] == source

    listed = app_client.get("/notes?live=1").get_json()
    assert listed["qdrant"]["embedding_status"] == expected_status
    assert [note["title"] for note in listed["notes"]] == ["Offline manual"]
    assert listed["notes"][0]["indexed"] is False
    assert app_client.get("/notes?q=Indented").get_json()["titles"] == [
        "Offline manual"
    ]

    detail = app_client.get("/note-detail/Offline manual").get_json()
    assert detail["editable_body"] == source
    revised = source + "\nRevised text\n"
    saved = app_client.patch(
        "/note-detail/Offline manual",
        json={
            "content": revised,
            "revision": detail["edit_revision"],
        },
    )
    assert saved.status_code == 200
    assert saved.get_json()["cache_updated"] is True
    assert path.read_bytes() == revised.encode()
    assert (
        app_client.get("/note-detail/Offline manual").get_json()["editable_body"]
        == revised
    )

    removed = app_client.delete("/note-detail/Offline manual")
    assert removed.status_code == 200 and not path.exists()
    trash_id = removed.get_json()["deleted"]["trash_id"]
    restored = app_client.post("/notes?restore=" + trash_id)
    assert restored.status_code == 200
    assert restored.get_json()["cache_updated"] is True
    assert path.read_bytes() == revised.encode()
    assert app_client.get("/notes?q=Revised").get_json()["titles"] == ["Offline manual"]
    assert upserts == []  # No fabricated vector is submitted to the real index adapter.


def test_manual_note_still_indexes_real_chunk_vectors_when_model_is_ready(
    app_client,
    monkeypatch,
    temp_notes_dir,
):
    import app as runtime

    encoded, records = [], []

    def encode(text, **kwargs):
        encoded.append(text)
        return [0.1, 0.2, 0.3]

    model = SimpleNamespace(encode=encode)
    monkeypatch.setenv("NODA_SEMANTIC_SEARCH_ENABLED", "1")
    monkeypatch.setattr(runtime, "_embedding_model", model)
    monkeypatch.setattr(runtime, "_load_embedding_model", lambda: model)
    monkeypatch.setattr(runtime, "_get_vector_size", lambda: 3)
    monkeypatch.setattr(runtime, "_qdrant_enabled", lambda: True)
    monkeypatch.setattr(
        runtime,
        "qdrant_service",
        SimpleNamespace(
            collection_name="synthetic-ready-library",
            upsert_notes=lambda items: records.extend(items),
            delete_notes=lambda ids: None,
        ),
    )
    source = (
        "Настроить ежедневные резервные копии PostgreSQL и проверить восстановление."
    )

    created = app_client.post(
        "/notes",
        json={
            "title": "PostgreSQL backup",
            "content": source,
            "tags": ["postgresql"],
        },
    )

    assert created.status_code == 201 and created.get_json()["note"]["indexed"] is True
    assert len(records) == 1 and records[0][1] == [0.1, 0.2, 0.3]
    assert records[0][2]["record_type"] == "note_chunk"
    assert source in records[0][2]["text"]
    assert len(encoded) == 1  # Embedding is computed for the actual stored fragment.
    assert source in (temp_notes_dir / "PostgreSQL backup.md").read_text(
        encoding="utf-8"
    )


def test_refresh_indexes_all_wrapped_source_fragments_without_metadata_leak(
    app_client,
    monkeypatch,
    temp_notes_dir,
):
    import app as runtime
    from backend.note_faithful_archive import wrapper_metadata
    from backend.ru_pipeline.orchestrator import render_source

    encoded, records = [], []

    def encode(text, **kwargs):
        encoded.append(text)
        return [0.1, 0.2, 0.3]

    model = SimpleNamespace(encode=encode)
    monkeypatch.setenv("NODA_SEMANTIC_SEARCH_ENABLED", "1")
    monkeypatch.setattr(runtime, "_embedding_model", model)
    monkeypatch.setattr(runtime, "_load_embedding_model", lambda: model)
    monkeypatch.setattr(runtime, "_get_vector_size", lambda: 3)
    monkeypatch.setattr(runtime, "_qdrant_enabled", lambda: True)
    monkeypatch.setattr(
        runtime,
        "qdrant_service",
        SimpleNamespace(
            collection_name="synthetic-ready-library",
            upsert_notes=lambda items: records.extend(items),
            delete_notes=lambda ids: None,
        ),
    )
    markers = [f"source_fragment_{index}" for index in range(8)]
    source = (
        "\ufeff  "
        + "\r\n\r\n".join(
            f"{marker}: "
            + "Проверить резервные копии PostgreSQL и восстановление базы. " * 4
            for marker in markers
        )
        + "  \r\n"
    )
    tags = [f"выбранный_{index}" for index in range(25)]
    content = render_source(source, "Полный архив", tags, ["folder/Другая заметка"])
    path = temp_notes_dir / "wrapped.md"
    path.write_bytes(content.encode("utf-8"))

    runtime._refresh_note_entry_in_cache("wrapped", content, path)

    assert path.read_bytes() == content.encode("utf-8")
    assert wrapper_metadata(path.read_bytes().decode("utf-8"))[1] == source
    entry = runtime.notes_data["wrapped"]
    assert entry["content"] == content and entry["tags"] == tags
    assert len(records) > 1 and len(encoded) == len(records)
    assert all(record[1] == [0.1, 0.2, 0.3] for record in records)
    assert all(record[2]["tags"] == tags for record in records)
    indexed_text = "\n".join(record[2]["text"] for record in records)
    embedding_text = "\n".join(encoded)
    for marker in markers:
        assert marker in indexed_text and marker in embedding_text
    assert "noda_source_sha256" not in embedding_text
    assert "noda_source_version" not in embedding_text
